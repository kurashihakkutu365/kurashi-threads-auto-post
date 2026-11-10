import { slotsForDay,slotState } from './time.js';
import { validateDaily } from './content.js';

export const MILESTONE_KEY='rakuten_confirmed_milestones_v1';
export const MILESTONES=[1,10,50,100,300,500,1000,10000];
export const THANKS_TEXTS={
  1:'楽天アフィリエイトで、初めての確定成果を確認できました。\n選んでくださった方、本当にありがとうございます🥹。うまく伝わるかな、と迷う気持ちもあるけど、続けていきたいと思える節目になりました。これからも、好きだと思える物を丁寧に紹介していきます。',
  10:'楽天アフィリエイトの確定成果で、累計10件の節目を迎えました。\n紹介を見て選んでくださった方へ、ありがとうございます🥹。数字を大きく見せたいというより、ちゃんと届いていたことが嬉しい。背伸びしすぎず、おしゃれで便利な物を探す楽しさを伝えていきたいです。',
  50:'楽天アフィリエイトの確定成果で、累計50件の節目を迎えました。\n選んでくださった方、本当にありがとうございます。もう少し頑張ってみようと思える理由が増えました🥹。派手なことは言えないけど、これからも見た目と使いやすさの両方を大事に、丁寧に紹介していきます。',
  100:'楽天アフィリエイトの確定成果が、累計100件に届きました。\n見てくださる方、選んでくださった方へ、ありがとうございます🥹。諦めなくてよかった、という気持ちです。この数字を実感するには少し時間がかかりそう。嬉しさを次の紹介につなげていきたいです。',
  300:'楽天アフィリエイトの確定成果で、累計300件の節目を確認しました。\n本当にありがとうございます。好きな物を紹介するだけでなく、誰かが選ぶときの参考になることも大切にしたい。嬉しい節目だからこそ、言い切りすぎず、良さを丁寧に伝える姿勢は忘れずにいたいです。',
  500:'楽天アフィリエイトの確定成果が、累計500件に届きました。\n選んでくださった方に、改めてありがとうございます🥹。すごい言葉でまとめるより、まず嬉しいです。見た目も便利さも欲張って探す、この場所らしい紹介をこれからも続けていきたいと思っています。',
  1000:'楽天アフィリエイトの確定成果で、累計1,000件の節目を迎えました。\n本当にありがとうございます🥹。ここで満足して終わり、というより、これからの紹介をもっと大事にしたくなりました。数字の向こうにお買い物があることを忘れずに、好きと便利を丁寧に届けていきます。',
  10000:'楽天アフィリエイトの確定成果が、累計10,000件に到達しました。\n選んでくださった方、見に来てくださる方、本当にありがとうございます。うまい言葉が見つからないけど、続けてよかったと感じる節目です🥹。これからも背伸びしすぎず、この場所らしく頑張ります。',
};
export function thankYou(threshold) {
  if(!MILESTONES.includes(threshold))throw new Error('milestone_invalid');
  return validateDaily({kind:'お礼',text:THANKS_TEXTS[threshold]});
}
const channel=()=>({state:'pending',slot:null});
const delivery=()=>({threads:channel(),instagram:channel()});
const fresh=()=>({version:1,revision:0,count:0,highest:0,checkedAt:null,checkedBy:null,events:[]});
const held=d=>['reserved','sending','unknown'].includes(d.state);
const done=d=>['sent','dry_run'].includes(d.state);

export class MilestoneQueue {
  constructor(store){this.store=store;}
  async read(){
    const s=await this.store.setting(MILESTONE_KEY);if(!s)return s;
    const states=['pending','suppressed','reserved','sending','unknown','sent','dry_run'];
    if(s.version!==1||!Number.isInteger(s.revision)||s.revision<1||!Number.isSafeInteger(s.count)||s.count<0||s.count>1_000_000_000||![0,...MILESTONES].includes(s.highest)||!Array.isArray(s.events)||s.events.length>8||new Set(s.events.map(e=>e.threshold)).size!==s.events.length||s.events.some(e=>!MILESTONES.includes(e.threshold)||['live','dry'].some(lane=>['threads','instagram'].some(sns=>{
      const d=e[lane]?.[sns];return !d||!states.includes(d.state)||(d.slot!==null&&(typeof d.slot!=='string'||!/^\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}$/.test(d.slot)))||(held(d)&&!d.slot);
    }))))throw new Error('milestone_state_invalid');
    return s;
  }
  async change(fn,{create=false}={}) {
    for(let attempt=0;attempt<5;attempt++) {
      const previous=await this.read();if(!previous&&!create)return null;
      const next=structuredClone(previous??fresh()),result=fn(next);
      if(result===undefined)return null;
      next.revision=(previous?.revision??0)+1;
      if(await this.store.compareMilestones(previous?.revision??0,next))return result;
    }
    throw new Error('milestone_contention');
  }
  async record(count,{confirmed=false,by='operator',now=new Date()}={}) {
    if(!confirmed)throw new Error('milestone_report_confirmation_required');
    if(!Number.isSafeInteger(count)||count<0||count>1_000_000_000||!Number.isFinite(+now))throw new Error('milestone_count_invalid');
    return this.change(s=>{
      const latest=MILESTONES.filter(n=>n<=count).at(-1)??0;
      s.count=count;s.highest=Math.max(s.highest,latest);s.checkedAt=now.toISOString();s.checkedBy=/^[a-zA-Z0-9_-]{1,80}$/.test(by)?by:'operator';
      for(const threshold of MILESTONES.filter(n=>n<=count))if(!s.events.some(e=>e.threshold===threshold))s.events.push({threshold,live:delivery(),dry:delivery()});
      for(const e of s.events)for(const lane of ['live','dry'])for(const sns of ['threads','instagram']) {
        const d=e[lane][sns];if(!held(d)&&!done(d))d.state=e.threshold===latest&&latest>=s.highest?'pending':'suppressed';
      }
      return {basis:'confirmed',scope:'all-rakuten',count,latestMilestone:latest,checkedAt:s.checkedAt,posted:false};
    },{create:true});
  }
  async claim(slot,sns,{dryRun=true,now=new Date(),graceMinutes=20}={}) {
    const expected=slotsForDay(String(slot.id).slice(0,10)).find(s=>s.id===slot.id);
    if(!expected||expected.kind!=='daily'||slot.kind!=='daily'||expected.scheduledAt!==slot.scheduledAt||slotState(slot,now,graceMinutes)!=='due'||!['threads','instagram'].includes(sns))throw new Error('milestone_slot_invalid');
    const lane=dryRun?'dry':'live';
    return this.change(s=>{
      if(s.events.some(e=>held(e[lane][sns])))return undefined;
      const e=s.events.find(e=>e.threshold<=s.count&&e[lane][sns].state==='pending');if(!e)return undefined;
      e[lane][sns]={state:'reserved',slot:slot.id};
      return {threshold:e.threshold,lane,sns,slot:slot.id,...thankYou(e.threshold)};
    });
  }
  async current(ticket) {
    const s=await this.read(),d=s?.events.find(e=>e.threshold===ticket.threshold)?.[ticket.lane]?.[ticket.sns];
    const latest=MILESTONES.filter(n=>n<=s?.count).at(-1);
    return !!d&&d.slot===ticket.slot&&d.state==='reserved'&&latest===ticket.threshold;
  }
  async finish(ticket,status) {
    if(!['sending','published','dry_run','unknown','skipped'].includes(status))throw new Error('milestone_status_invalid');
    return this.change(s=>{
      const d=s.events.find(e=>e.threshold===ticket.threshold)?.[ticket.lane]?.[ticket.sns];
      if(!d||d.slot!==ticket.slot)throw new Error('milestone_ticket_invalid');
      if(done(d))return undefined;
      if(status==='skipped'&&['sending','unknown'].includes(d.state))throw new Error('milestone_delivery_held');
      if(status==='dry_run'&&ticket.lane!=='dry'||status==='published'&&ticket.lane!=='live')throw new Error('milestone_status_invalid');
      if(status==='skipped') {
        const latest=MILESTONES.filter(n=>n<=s.count).at(-1);
        d.state=latest===ticket.threshold?'pending':'suppressed';d.slot=null;
      }else d.state={sending:'sending',published:'sent',dry_run:'dry_run',unknown:'unknown'}[status];
      return true;
    });
  }
  async ticketForPost(slot,sns,{dryRun=false}={}) {
    const lane=dryRun?'dry':'live',s=await this.read(),e=s?.events.find(e=>e[lane][sns].slot===slot&&held(e[lane][sns]));
    return e?{threshold:e.threshold,lane,sns,slot,...thankYou(e.threshold)}:null;
  }
}
