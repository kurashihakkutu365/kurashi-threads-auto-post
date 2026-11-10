import { randomUUID } from 'node:crypto';
import { jstMonth } from './time.js';

const CODES=new Set(['duplicate_product','daily_post_limit','daily_kind_limit','invalid_slot','invalid_post_update','unknown_post','budget_throttled','monthly_budget','category_budget','daily_ai_limit','all_stopped','invalid_reservation','invalid_settlement','unknown_reservation','invalid_bill','invalid_product','unknown_product','invalid_image_hash','unsupported_store_action','invalid_restore','restore_target_not_empty']);
CODES.add('invalid_store_config');
CODES.add('milestone_state_invalid');

export class SupabaseStore {
  constructor({url,key,fetchImpl=fetch,timeoutMs=15000}) {
    let parsed;
    try { parsed=new URL(url); } catch { throw new Error('supabase_config_missing'); }
    if (parsed.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.port || !['','/'].includes(parsed.pathname) || parsed.search || parsed.hash || !key) throw new Error('supabase_config_invalid');
    // Legacy service_role JWT and new server-only secret keys are supported. Reject browser keys.
    if(key.startsWith('sb_publishable_')) throw new Error('supabase_server_key_required');
    if(!key.startsWith('sb_secret_')) {
      try { if(JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role') throw Error(); }
      catch { throw new Error('supabase_server_key_required'); }
    }
    Object.assign(this,{url:parsed.origin,key,fetchImpl,timeoutMs,kind:'supabase'});
  }
  async rpc(action,args={},endpoint='kurashi_store_v1') {
    if(!['kurashi_store_v1','kurashi_milestones_v1'].includes(endpoint))throw new Error('invalid_store_endpoint');
    const headers={'Content-Type':'application/json',apikey:this.key};
    // New sb_secret keys go only in apikey, never as an invalid Bearer JWT.
    if(!this.key.startsWith('sb_secret_')) headers.Authorization=`Bearer ${this.key}`;
    let response;
    try { response=await this.fetchImpl(`${this.url}/rest/v1/rpc/${endpoint}`,{method:'POST',headers,body:JSON.stringify({action,args}),redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)}); }
    catch { throw new Error('supabase_result_unknown'); }
    let value;
    try { value=await response.json(); } catch { throw new Error('supabase_response_invalid'); }
    if (!response.ok) {
      if(endpoint==='kurashi_milestones_v1'&&response.status===404)throw new Error('milestone_setup_required');
      // Never surface provider response bodies; they can contain keys, SQL or personal data.
      if(CODES.has(value?.message)) throw new Error(value.message);
      throw new Error(response.status===401||response.status===403?'supabase_access_denied':response.status===429?'supabase_rate_limited':'supabase_unavailable');
    }
    return value;
  }
  close() {}
  health() { return this.rpc('health'); }
  saveProduct(product,now=new Date()) { return this.rpc('saveProduct',{product,now:now.toISOString()}); }
  product(id) { return this.rpc('product',{id}); }
  products() { return this.rpc('products'); }
  saveImage(image) { return this.rpc('saveImage',{image}); }
  images(id) { return this.rpc('images',{id}); }
  cached(key,now=new Date()) { return this.rpc('cached',{key,now:now.toISOString()}); }
  cache(key,value,expiresAt) { return this.rpc('cache',{key,value,expiresAt}); }
  setting(key,value) { return this.rpc('setting',{key,...(value===undefined?{}:{value})}); }
  compareMilestones(expectedRevision,state){return this.rpc('cas',{expectedRevision,state},'kurashi_milestones_v1');}
  milestoneHealth(){return this.rpc('health',{},'kurashi_milestones_v1');}
  post(slot,sns) { return this.rpc('post',{slot,sns}); }
  updatePost(slot,sns,state,fields={}) { return this.rpc('updatePost',{slot,sns,state,fields}); }
  recentlyUsed(canonical,now,days,exceptSlot) { return this.rpc('recentlyUsed',{canonical,now:now.toISOString(),days,exceptSlot}); }
  claim(slot,sns,product,now,config) { return this.rpc('claim',{slot,sns,product:product??null,now:now.toISOString(),config:{duplicateDays:config.duplicateDays,dailyPostLimit:config.dailyPostLimit}}); }
  history(sns,{since,kind,exceptSlot}={}) { return this.rpc('history',{sns,since,kind,exceptSlot}); }
  log(code,now=new Date()) { return this.rpc('log',{code:/^[a-z0-9_]{1,80}$/.test(code)?code:'internal_error',now:now.toISOString()}); }
  cleanup(now,days) { return this.rpc('cleanup',{now:now.toISOString(),days}); }
  totals(now=new Date()) { return this.rpc('totals',{month:jstMonth(now)}); }
  reserve(request,config,now=new Date()) {
    if(!Number.isFinite(request.maximumYen)||request.maximumYen<=0||!Number.isInteger(request.maximumTokens??0)||(request.maximumTokens??0)<0) throw new Error('invalid_reservation');
    return this.rpc('reserve',{id:randomUUID(),request,config,now:now.toISOString()});
  }
  settle(id,estimatedYen,tokens) {
    if(!Number.isFinite(estimatedYen)||estimatedYen<0||!Number.isInteger(tokens)||tokens<0) throw new Error('invalid_settlement');
    return this.rpc('settle',{id,estimatedYen,tokens});
  }
  recordBill(id,actualYen) {
    if(!Number.isFinite(actualYen)||actualYen<0) throw new Error('invalid_bill');
    return this.rpc('recordBill',{id,actualYen});
  }
  export() { return this.rpc('export'); }
  restore(snapshot) { return this.rpc('restore',{snapshot,confirmEmptyDatabase:true}); }
  report(now=new Date()) { return this.rpc('report',{now:now.toISOString()}); }
  siteData() { return this.rpc('siteData'); }
}
