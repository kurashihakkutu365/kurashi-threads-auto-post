import { requirePair,validateImage } from './rights.js';
import { generateCopy,validateCopy,renderCopy,validateDaily } from './content.js';
import { slotState,slotsForDay } from './time.js';
import { assertProduction } from './config.js';

export class Engine {
  constructor({store,config,selection,publishers,verifySite,generate=generateCopy,clock=()=>new Date()}) {
    Object.assign(this,{store,config,selection,publishers,verifySite,generate,clock});
  }
  stopped(sns) {
    return this.config.emergencyStop || this.config.termsStop || this.store.setting('emergencyStop') ||
      !this.config.platforms[sns] || this.store.setting(`stop:${sns}`);
  }
  async run(slot,sns,{product,daily,image}={}) {
    const now=this.clock();
    if (!['threads','instagram'].includes(sns)) throw new Error('unsupported_platform');
    const expected=slotsForDay(String(slot.id).slice(0,10)).find(s=>s.id===slot.id);
    if (!expected || expected.kind!==slot.kind || expected.scheduledAt!==slot.scheduledAt) throw new Error('invalid_slot');
    if (this.stopped(sns)) return {state:'skipped',reason:'platform_stopped'};
    const timing=slotState(slot,now,this.config.slotGraceMinutes);
    if (timing==='future') return {state:'future'};
    if (timing==='expired') {
      if (this.store.claim(slot,sns,null,now,this.config)) this.store.updatePost(slot.id,sns,'skipped',{reason:'slot_expired'});
      return {state:'skipped',reason:'slot_expired'};
    }
    if (!this.config.dryRun) assertProduction(this.config);
    if (!this.store.claim(slot,sns,product,now,this.config)) return this.store.post(slot.id,sns);
    let sending=false;
    try {
      let text,images=[],p;
      if (slot.kind==='product') {
        if (!product) throw new Error('no_product');
        p=await this.selection.refresh(product,now);
        // Choose one pair for both SNS, instead of accidentally choosing a different pair per SNS.
        images=requirePair(this.store.images(p.id).filter(i=>{
          try { validateImage(i,'threads',now); validateImage(i,'instagram',now,{site:true}); return true; }
          catch { return false; }
        }),sns,now,{site:sns==='instagram'});
        const history=this.store.db.prepare("SELECT text FROM posts WHERE sns=? AND slot<>? AND started_at>=? AND text IS NOT NULL").all(sns,slot.id,new Date(+now-30*86400000).toISOString()).map(r=>r.text);
        // One generation request per product snapshot for both SNS; render their CTAs locally.
        const key=`copy:${p.id}:${JSON.stringify([p.name,p.shortFact,p.description,p.price,p.affiliateUrl])}`;
        let copy=this.store.cached(key,now);
        if (!copy) { copy=await this.generate(p); this.store.cache(key,copy,new Date(+now+86400000).toISOString()); }
        validateCopy(copy,p,history);
        text=renderCopy(copy,p,sns);
        if (sns==='instagram') await this.verifySite(p,images);
      } else {
        const history=this.store.db.prepare("SELECT text FROM posts WHERE kind='daily' AND sns=? AND started_at>=?").all(sns,new Date(+now-30*86400000).toISOString()).map(r=>r.text).filter(Boolean);
        text=validateDaily(daily,history).text;
        if (sns==='instagram') {
          validateImage(image,sns,now);
          if (!image.original) throw new Error('original_image_required');
          images=[image];
        }
      }
      this.store.updatePost(slot.id,sns,'prepared',{text});
      if (this.config.dryRun) {
        // Exercise preparation against a mock only, with no publish calls or network.
        if (this.publishers[sns]?.dryRunSafe !== true) throw new Error('unsafe_dry_run_adapter');
        const container=await this.publishers[sns].prepare({kind:slot.kind,text,images});
        this.store.updatePost(slot.id,sns,'dry_run',{container_id:container});
        return this.store.post(slot.id,sns);
      }
      // Production still cannot run through the bundled SQLite demo CLI.
      if (this.stopped(sns)) throw new Error('platform_stopped');
      const publisher=this.publishers[sns];
      const container=await publisher.prepare({kind:slot.kind,text,images});
      this.store.updatePost(slot.id,sns,'prepared',{container_id:container});
      if (await publisher.status(container)!=='FINISHED') throw new Error('container_not_ready');
      const finalNow=this.clock();
      if (slotState(slot,finalNow,this.config.slotGraceMinutes)!=='due') throw new Error('slot_expired');
      if (p) {
        const final=await this.selection.refresh(p,finalNow);
        if (final.price!==p.price || final.affiliateUrl!==p.affiliateUrl || final.name!==p.name || final.description!==p.description) throw new Error('product_changed');
      }
      for (const i of images) validateImage(i,sns,finalNow,{site:sns==='instagram' && slot.kind==='product'});
      if (this.stopped(sns)) throw new Error('platform_stopped');
      this.store.updatePost(slot.id,sns,'sending'); sending=true;
      const remote=await publisher.publish(container);
      this.store.updatePost(slot.id,sns,'published',{remote_id:remote,published_at:this.clock().toISOString()});
    } catch(e) {
      // Even a failed DB update after publication leaves a sending/unknown hold, never a fresh attempt.
      const code=/^[a-z0-9_]+$/.test(e.message)?e.message:'internal_error';
      this.store.updatePost(slot.id,sns,sending?'unknown':'skipped',{reason:code});
      this.store.log(code,now);
    }
    return this.store.post(slot.id,sns);
  }
  async reconcile(slot,sns) {
    const p=this.store.post(slot,sns);
    if (!p || !['sending','unknown'].includes(p.state)) return p;
    if (!p.container_id) return p;
    const r=await this.publishers[sns].reconcile(p.container_id);
    if (r.state==='published' && r.remoteId) this.store.updatePost(slot,sns,'published',{remote_id:r.remoteId,published_at:this.clock().toISOString()});
    return this.store.post(slot,sns);
  }
}
