import { createHmac,timingSafeEqual } from 'node:crypto';
import { jstDay } from './time.js';
import { assertProduction } from './config.js';

export function verifySignature(raw,signature,secret) {
  if (!secret || typeof signature!=='string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected=createHmac('sha256',secret).update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
export function webhookChallenge(query,verifyToken) {
  if (!verifyToken || query['hub.mode']!=='subscribe' || query['hub.verify_token']!==verifyToken || typeof query['hub.challenge']!=='string') throw new Error('webhook_verification_failed');
  return query['hub.challenge'];
}
export function classifyComment(text) {
  if (/返信.*(不要|しない|停止)|reply\s*stop|stop\s*reply/i.test(text)) return 'opt_out';
  if (/https?:|無料.*稼|副業|死ね|馬鹿|バカ|詐欺|[\w.+-]+@[\w.-]+\.[a-z]+|\d[\d\-\s]{8,}\d|住所|電話|本名|返金|届かない|不良|苦情|医療|病気|薬|治療|法律|弁護士|投資|借金|支払|裁判/i.test(text)) return 'excluded';
  if (/^(ありがとう(ございます)?|素敵(です)?|かわいい(ですね)?|いいですね)[！!。😊\s]*$/.test(text)) return 'simple';
  return 'review';
}
export class ReplyQueue {
  constructor(store,config) { this.store=store; this.config=config; }
  ingest(event,now=new Date()) {
    if (!event || !['threads','instagram'].includes(event.sns) || !['id','commentId','author','parentPostId','text'].every(k=>typeof event[k]==='string' && event[k].length>0) || event.text.length>3000) throw new Error('invalid_event');
    // Adapter must have verified that this is a direct comment on our own post.
    if (event.isOwnPost!==true || event.depth!==1) return false;
    const post=this.store.db.prepare("SELECT 1 FROM posts WHERE sns=? AND remote_id=? AND state='published'").get(event.sns,event.parentPostId);
    if (!post) return false;
    return this.store.transaction(()=>{
      if (this.store.db.prepare('SELECT 1 FROM events WHERE id=? OR (sns=? AND comment_id=?)').get(event.id,event.sns,event.commentId)) return false;
      const category=classifyComment(event.text);
      if (category==='opt_out') this.store.db.prepare('INSERT OR IGNORE INTO opt_outs VALUES(?,?)').run(event.sns,event.author);
      const optedOut=this.store.db.prepare('SELECT 1 FROM opt_outs WHERE sns=? AND author=?').get(event.sns,event.author);
      // Unknown/sensitive content is excluded without AI until a verified contextual classifier exists.
      const excluded=category!=='simple' || !!optedOut;
      const delay=180000+(parseInt(createHmac('sha256','reply-jitter').update(event.id).digest('hex').slice(0,8),16)%240001);
      const safe=excluded?{}:{text:event.text,parentPostId:event.parentPostId};
      this.store.db.prepare('INSERT INTO events(id,sns,comment_id,author,data,state,due_at,detected_at,reason) VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,event.sns,event.commentId,event.author,JSON.stringify(safe),excluded?'excluded':'queued',new Date(+now+delay).toISOString(),now.toISOString(),excluded?category:null);
      return true;
    });
  }
  receive(raw,signature,secret,normalize,now=new Date()) {
    if (Buffer.byteLength(raw)>65536 || !verifySignature(raw,signature,secret)) throw new Error('invalid_webhook_signature');
    const payload=JSON.parse(raw);
    // Explicit adapter required: do not invent the Threads/Instagram webhook payload shape.
    const events=normalize(payload);
    if (!Array.isArray(events) || events.length>100) throw new Error('invalid_event_batch');
    return events.map(e=>this.ingest(e,now));
  }
  async process(adapter,now=new Date()) {
    if (!this.config.repliesEnabled || this.config.emergencyStop || this.config.termsStop || this.store.setting('emergencyStop')) return [];
    if (!this.config.dryRun) assertProduction(this.config);
    const pending=this.store.db.prepare("SELECT * FROM events WHERE state='queued' AND due_at<=? ORDER BY due_at LIMIT 20").all(now.toISOString());
    const results=[];
    for (const event of pending) {
      if (!this.config.platforms[event.sns] || this.store.setting(`stop:${event.sns}`)) continue;
      const claimed=this.store.transaction(()=>{
        const opted=this.store.db.prepare('SELECT 1 FROM opt_outs WHERE sns=? AND author=?').get(event.sns,event.author);
        const age=+now-Date.parse(event.detected_at);
        if (opted || age>86400000) {
          this.store.db.prepare("UPDATE events SET state='excluded',reason=? WHERE id=? AND state='queued'").run(opted?'opt_out':'reply_expired',event.id); return false;
        }
        const count=this.store.db.prepare("SELECT COUNT(*) n FROM events WHERE sns=? AND detected_at>=? AND state IN ('sending','sent','unknown','dry_run')").get(event.sns,new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString()).n;
        if (count>=this.config.dailyReplyLimit) return false;
        // One conversation per author per day, and at least one minute between any two sends.
        const active=this.store.db.prepare("SELECT 1 FROM events WHERE sns=? AND state IN ('sending','sent','unknown','dry_run') AND (author=? OR sent_at>?) AND detected_at>=?").get(event.sns,event.author,new Date(+now-60000).toISOString(),new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString());
        if (active) return false;
        return this.store.db.prepare("UPDATE events SET state='sending' WHERE id=? AND state='queued'").run(event.id).changes===1;
      });
      if (!claimed) continue;
      try {
        if (!this.config.dryRun && adapter.authorizedOfficialReplies!==true) throw new Error('reply_api_not_approved');
        const context=await adapter.context(event.sns,event.comment_id);
        if (context.isOwnPost!==true || context.depth!==1 || context.deleted || classifyComment(context.text)!=='simple') throw new Error('reply_context_changed');
        const text='コメントありがとうございます！';
        if (this.config.emergencyStop || this.config.termsStop || this.store.setting('emergencyStop') || this.store.setting(`stop:${event.sns}`) || !this.config.platforms[event.sns]) throw new Error('platform_stopped');
        if (!this.config.dryRun) await adapter.reply(event.sns,event.comment_id,text);
        this.store.db.prepare('UPDATE events SET state=?,sent_at=?,reason=? WHERE id=?').run(this.config.dryRun?'dry_run':'sent',now.toISOString(),+now-Date.parse(event.due_at)>60000?'reply_delayed':null,event.id);
      } catch {
        this.store.db.prepare("UPDATE events SET state='unknown',reason='reply_not_confirmed' WHERE id=?").run(event.id);
      }
      results.push(this.store.db.prepare('SELECT id,state,reason FROM events WHERE id=?').get(event.id));
    }
    return results;
  }
}
