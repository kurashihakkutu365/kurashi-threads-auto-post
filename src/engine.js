import { requirePair,validateImage } from './rights.js';
import { generateCopy,validateCopy,renderCopy,validateDaily } from './content.js';
import { slotState,slotsForDay } from './time.js';
import { assertProduction } from './config.js';
import { rankedCopyCacheKey,revalidateRankedCopy,renderRankedCopy } from './ranked-copy.js';
import { MilestoneQueue } from './milestones.js';

export class Engine {
  constructor({store,config,selection,publishers,verifySite,generate,createDailyImage,clock=()=>new Date()}) {
    generate??=config.productCopyMode==='ranked'?async()=>{throw new Error('campaign_generator_missing');}:generateCopy;
    Object.assign(this,{store,config,selection,publishers,verifySite,generate,createDailyImage,clock});
    this.milestones=new MilestoneQueue(store);
  }
  async stopped(sns) {
    return this.config.emergencyStop || this.config.termsStop || await this.store.setting('emergencyStop') ||
      !this.config.platforms[sns] || await this.store.setting(`stop:${sns}`);
  }
  async run(slot,sns,{product,daily,image}={}) {
    const now=this.clock();
    if (!['threads','instagram'].includes(sns)) throw new Error('unsupported_platform');
    const expected=slotsForDay(String(slot.id).slice(0,10)).find(s=>s.id===slot.id);
    if (!expected || expected.kind!==slot.kind || expected.scheduledAt!==slot.scheduledAt) throw new Error('invalid_slot');
    if (await this.stopped(sns)) return {state:'skipped',reason:'platform_stopped'};
    const timing=slotState(slot,now,this.config.slotGraceMinutes);
    if (timing==='future') return {state:'future'};
    if (timing==='expired') {
      if (await this.store.claim(slot,sns,null,now,this.config)) await this.store.updatePost(slot.id,sns,'skipped',{reason:'slot_expired'});
      return {state:'skipped',reason:'slot_expired'};
    }
    if (!this.config.dryRun) assertProduction(this.config);
    if (!await this.store.claim(slot,sns,product,now,this.config)) return this.store.post(slot.id,sns);
    let sending=false,milestone=null;
    try {
      let text,images=[],p;
      if (slot.kind==='product') {
        if (!product) throw new Error('no_product');
        p=await this.selection.refresh(product,now);
        const ranked=this.config.productCopyMode==='ranked';
        // Choose one pair for both SNS, instead of accidentally choosing a different pair per SNS.
        images=requirePair((await this.store.images(p.id)).filter(i=>{
          try { validateImage(i,'threads',now); validateImage(i,'instagram',now,{site:!ranked}); return true; }
          catch { return false; }
        }),sns,now,{site:sns==='instagram'&&!ranked});
        const history=await this.store.history(sns,{exceptSlot:slot.id,since:new Date(+now-30*86400000).toISOString()});
        // One generation request per product snapshot for both SNS; render their CTAs locally.
        const key=ranked?rankedCopyCacheKey(p):`copy:${p.id}:${JSON.stringify([p.name,p.shortFact,p.description,p.price,p.affiliateUrl])}`;
        let copy=await this.store.cached(key,now);
        if (!copy) { copy=await this.generate(p); await this.store.cache(key,copy,new Date(+now+86400000).toISOString()); }
        if(ranked) {
          revalidateRankedCopy(copy,p,{now,freshnessMinutes:this.config.freshnessMinutes,history});
          text=renderRankedCopy(copy,p,sns);
        } else {
          validateCopy(copy,p,history);
          text=renderCopy(copy,p,sns);
          if (sns==='instagram') await this.verifySite(p,images);
        }
      } else {
        const history=await this.store.history(sns,{kind:'daily',since:new Date(+now-30*86400000).toISOString()});
        milestone=await this.milestones.claim(slot,sns,{dryRun:this.config.dryRun,now,graceMinutes:this.config.slotGraceMinutes});
        // Milestone dedupe is permanent per channel, separate from rehearsal history and normal chat similarity.
        text=validateDaily(milestone??daily,milestone?[]:history).text;
        if (sns==='instagram') {
          if(milestone) {
            if(!this.createDailyImage)throw new Error('milestone_image_renderer_missing');
            image=await this.createDailyImage({text,kind:'お礼',threshold:milestone.threshold},slot,now);
          }
          validateImage(image,sns,now);
          if (!image.original) throw new Error('original_image_required');
          images=[image];
        }
      }
      if(milestone&&!await this.milestones.current(milestone))throw new Error('milestone_changed');
      await this.store.updatePost(slot.id,sns,'prepared',{text,...(milestone?{reason:`thanks_milestone_${milestone.threshold}`}:{})});
      if (this.config.dryRun) {
        // Exercise preparation against a mock only, with no publish calls or network.
        if (this.publishers[sns]?.dryRunSafe !== true) throw new Error('unsafe_dry_run_adapter');
        const container=await this.publishers[sns].prepare({kind:slot.kind,text,images});
        await this.store.updatePost(slot.id,sns,'dry_run',{container_id:container});
        if(milestone)await this.milestones.finish(milestone,'dry_run');
        return this.store.post(slot.id,sns);
      }
      // Production still cannot run through the bundled SQLite demo CLI.
      if (await this.stopped(sns)) throw new Error('platform_stopped');
      const publisher=this.publishers[sns];
      const container=await publisher.prepare({kind:slot.kind,text,images});
      await this.store.updatePost(slot.id,sns,'prepared',{container_id:container});
      if (await publisher.status(container)!=='FINISHED') throw new Error('container_not_ready');
      const finalNow=this.clock();
      if (slotState(slot,finalNow,this.config.slotGraceMinutes)!=='due') throw new Error('slot_expired');
      if (p) {
        const final=await this.selection.refresh(p,finalNow);
        if (final.price!==p.price || final.affiliateUrl!==p.affiliateUrl || final.name!==p.name || final.description!==p.description) throw new Error('product_changed');
        if(this.config.productCopyMode==='ranked') {
          const saved=await this.store.cached(rankedCopyCacheKey(p),finalNow);
          if(!saved)throw new Error('campaign_cache_missing');
          revalidateRankedCopy(saved,final,{now:finalNow,freshnessMinutes:this.config.freshnessMinutes});
          if(renderRankedCopy(saved,final,sns)!==text)throw new Error('product_changed');
        }
      }
      for (const i of images) validateImage(i,sns,finalNow,{site:sns==='instagram' && slot.kind==='product'&&this.config.productCopyMode!=='ranked'});
      if (await this.stopped(sns)) throw new Error('platform_stopped');
      if(milestone&&!await this.milestones.current(milestone))throw new Error('milestone_changed');
      await this.store.updatePost(slot.id,sns,'sending'); sending=true;
      if(milestone)await this.milestones.finish(milestone,'sending');
      const remote=await publisher.publish(container);
      await this.store.updatePost(slot.id,sns,'published',{remote_id:remote,published_at:this.clock().toISOString()});
      if(milestone)await this.milestones.finish(milestone,'published');
    } catch(e) {
      // Even a failed DB update after publication leaves a sending/unknown hold, never a fresh attempt.
      const code=/^[a-z0-9_]+$/.test(e.message)?e.message:'internal_error';
      await this.store.updatePost(slot.id,sns,sending?'unknown':'skipped',{reason:code});
      await this.store.log(code,now);
      if(milestone) {
        try{await this.milestones.finish(milestone,sending?'unknown':'skipped');}catch{/* Ambiguous DB state holds the lease; never blindly release for another send. */}
      }
    }
    return this.store.post(slot.id,sns);
  }
  async reconcile(slot,sns) {
    const p=await this.store.post(slot,sns);
    if (!p || !['sending','unknown'].includes(p.state)) return p;
    if (!p.container_id) return p;
    const r=await this.publishers[sns].reconcile(p.container_id);
    if (r.state==='published' && r.remoteId) {
      await this.store.updatePost(slot,sns,'published',{remote_id:r.remoteId,published_at:this.clock().toISOString()});
      const ticket=await this.milestones.ticketForPost(slot,sns);if(ticket)await this.milestones.finish(ticket,'published');
    }
    return this.store.post(slot,sns);
  }
}
