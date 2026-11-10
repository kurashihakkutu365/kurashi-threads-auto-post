import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { MILESTONES,MILESTONE_KEY,THANKS_TEXTS,MilestoneQueue,thankYou } from '../src/milestones.js';
import { slotsForDay } from '../src/time.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { MockPublisher,MetaPublisher } from '../src/publishers.js';
import { fixtureImage,mockThanksImage } from '../src/fixtures.js';
import { dailyBatch } from '../src/daily.js';
import { main } from '../src/cli.js';
import { SupabaseStore } from '../src/supabase-store.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const slots=slotsForDay('2026-11-11').filter(s=>s.kind==='daily');
const options=(slot=slots[0],dryRun=true)=>({now:new Date(slot.scheduledAt),dryRun});
function setup(t){const store=new Store();t.after(()=>store.close());return {store,q:new MilestoneQueue(store)};}
const record=(q,count)=>q.record(count,{confirmed:true,now:new Date(slots[0].scheduledAt)});

test('all eight thank-you messages are distinct, grounded in confirmed counts, and have the daily layout',()=>{
  assert.deepEqual(MILESTONES,[1,10,50,100,300,500,1000,10000]);assert.equal(new Set(Object.values(THANKS_TEXTS)).size,8);
  for(const n of MILESTONES){const {text}=thankYou(n);assert.equal(text.split('\n').length,2);assert.match(text,/確定成果/);assert.match(text,/ありがとう/);assert.doesNotMatch(text,/https?:|人目|人が購入|昨日|先週|か月|ヶ月/);}
});
test('counts require explicit report confirmation and reject malformed values',async t=>{
  const {q,store}=setup(t);await assert.rejects(()=>q.record(1),/report_confirmation_required/);
  for(const n of [-1,1.5,NaN,Infinity,'10',1_000_000_001])await assert.rejects(()=>record(q,n),/count_invalid/);
  assert.equal(store.setting(MILESTONE_KEY),undefined);
});
test('first registration at 12 schedules only 10, never backfills 1',async t=>{
  const {q}=setup(t);assert.equal((await record(q,12)).latestMilestone,10);
  const ticket=await q.claim(slots[0],'threads',options());assert.equal(ticket.threshold,10);
  await q.finish(ticket,'dry_run');await record(q,12);
  assert.equal(await q.claim(slots[1],'threads',options(slots[1])),null);
  const state=await q.read();assert.equal(state.events.find(e=>e.threshold===1).dry.threads.state,'suppressed');
});
test('both SNS receive each threshold once, and rehearsal never consumes live delivery',async t=>{
  const {q}=setup(t);await record(q,1);
  for(const sns of ['threads','instagram']){const t=await q.claim(slots[0],sns,options());await q.finish(t,'dry_run');assert.equal(await q.claim(slots[1],sns,options(slots[1])),null);}
  const live=await q.claim(slots[1],'threads',options(slots[1],false));assert.equal(live.threshold,1);await q.finish(live,'sending');await q.finish(live,'published');
  await record(q,2);assert.equal(await q.claim(slots[2],'threads',options(slots[2],false)),null);
});
test('concurrent different-slot claims cannot reserve the same channel twice',async t=>{
  const {q}=setup(t);await record(q,50);
  const leases=await Promise.all(slots.map(s=>q.claim(s,'threads',options(s))));assert.equal(leases.filter(Boolean).length,1);
  assert.equal(leases.find(Boolean).threshold,50);
});
test('higher milestones supersede unsent posts; count corrections cancel an unready thank-you',async t=>{
  const {q}=setup(t);await record(q,10);const ticket=await q.claim(slots[0],'threads',options());
  await record(q,50);assert.equal(await q.current(ticket),false);await q.finish(ticket,'skipped');
  const newer=await q.claim(slots[1],'threads',options(slots[1]));assert.equal(newer.threshold,50);
  await record(q,0);assert.equal(await q.current(newer),false);await q.finish(newer,'skipped');assert.equal(await q.claim(slots[2],'threads',options(slots[2])),null);
});
test('a preparation failure releases the milestone for the next daily slot',async t=>{
  const {q}=setup(t);await record(q,100);const ticket=await q.claim(slots[0],'instagram',options());await q.finish(ticket,'skipped');
  const next=await q.claim(slots[1],'instagram',options(slots[1]));assert.equal(next.threshold,100);assert.equal(next.slot,slots[1].id);
});
test('unknown delivery permanently holds its channel until confirmed reconciliation',async t=>{
  const {q}=setup(t);await record(q,100);const ticket=await q.claim(slots[0],'threads',options(slots[0],false));
  await q.finish(ticket,'sending');await q.finish(ticket,'unknown');await record(q,500);
  await assert.rejects(()=>q.finish(ticket,'skipped'),/delivery_held/);assert.equal(await q.claim(slots[1],'threads',options(slots[1],false)),null);
  assert.equal((await q.ticketForPost(ticket.slot,'threads')).threshold,100);
  await q.finish(ticket,'published');assert.equal((await q.claim(slots[2],'threads',options(slots[2],false))).threshold,500);
});
test('future, expired, forged and product slots cannot consume milestones',async t=>{
  const {q}=setup(t);await record(q,1);
  const product=slotsForDay('2026-11-11')[0];
  for(const [s,at] of [[product,new Date(product.scheduledAt)],[slots[0],new Date(Date.parse(slots[0].scheduledAt)-1)],[slots[0],new Date(Date.parse(slots[0].scheduledAt)+21*60000)],[{...slots[0],scheduledAt:product.scheduledAt},new Date(product.scheduledAt)]])await assert.rejects(()=>q.claim(s,'threads',{now:at}),/slot_invalid/);
});
test('Engine replaces only next daily slot, renders matching Instagram text, then resumes ordinary chat',async t=>{
  const {store,q}=setup(t);await record(q,1);const config=loadConfig(undefined,{}),publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
  const dir=mkdtempSync(join(tmpdir(),'thanks-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let clock=new Date(slots[0].scheduledAt),rendered;
  const engine=new Engine({store,config,publishers,clock:()=>clock,createDailyImage:async(theme,slot,now)=>{rendered=theme.text;return mockThanksImage(theme,slot,dir,now);}});
  const ordinary=dailyBatch('2026-11-11');
  for(const sns of ['threads','instagram']){const result=await engine.run(slots[0],sns,{daily:ordinary[0],image:fixtureImage('ordinary',1,clock)});assert.equal(result.state,'dry_run');assert.equal(result.text,thankYou(1).text);}
  assert.equal(rendered,thankYou(1).text);assert.equal(publishers.instagram.calls[0][1].images[0].dryRunOnly,true);
  clock=new Date(slots[1].scheduledAt);const next=await engine.run(slots[1],'threads',{daily:ordinary[1]});assert.equal(next.state,'dry_run');assert.equal(next.text,ordinary[1].text);
  assert.equal(publishers.threads.calls.filter(c=>c[0]==='publish').length,0);
});
test('missing Instagram renderer skips safely and keeps the thank-you pending',async t=>{
  const {store,q}=setup(t);await record(q,1);const publisher=new MockPublisher('instagram');const engine=new Engine({store,config:loadConfig(undefined,{}),publishers:{instagram:publisher},clock:()=>new Date(slots[0].scheduledAt)});
  const r=await engine.run(slots[0],'instagram',{daily:dailyBatch('2026-11-11')[0],image:fixtureImage('wrong-caption')});assert.equal(r.reason,'milestone_image_renderer_missing');assert.equal(publisher.calls.length,0);
  assert.equal((await q.claim(slots[1],'instagram',options(slots[1]))).threshold,1);
});
test('milestone state persists after restart and corrupt state fails closed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'milestone-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite');
  const s=new Store(path);await record(new MilestoneQueue(s),10);s.close();const reopened=new Store(path);t.after(()=>reopened.close());assert.equal((await new MilestoneQueue(reopened).read()).count,10);
  reopened.setting(MILESTONE_KEY,{version:1,revision:1,events:[]});await assert.rejects(()=>new MilestoneQueue(reopened).read(),/state_invalid/);
});
test('Supabase CAS uses only its fixed endpoint and maps missing optional migration',async()=>{
  const store=new SupabaseStore({url:'https://test.supabase.co',key:'sb_secret_synthetic',fetchImpl:async(url,options)=>{assert.ok(url.endsWith('/rpc/kurashi_milestones_v1'));assert.equal(JSON.parse(options.body).action,'cas');return new Response('true');}});
  assert.equal(await store.compareMilestones(0,{}),true);
  store.fetchImpl=async()=>new Response('{"message":"raw provider secret"}',{status:404});await assert.rejects(()=>store.compareMilestones(0,{}),/^Error: milestone_setup_required$/);
});
test('example command never accesses accounts and registering a count requires persistent storage',async()=>{
  const result=await main('milestone-examples','/tmp/no-milestone-state',new Date(),{env:{},fetchImpl:async()=>assert.fail('no network')});assert.equal(result.examples.length,8);assert.equal(result.published,false);
  await assert.rejects(()=>main('milestone-record','/tmp/no-milestone-state',new Date(),{env:{}}),/requires_supabase/);
  await assert.rejects(()=>main('milestone-record','/tmp/no-milestone-state',new Date(),{env:{STORAGE_BACKEND:'supabase'}}),/report_confirmation_required/);
});
test('a dry-run-only generated image cannot be sent through the real Meta adapter',async()=>{
  const config=loadConfig(undefined,{});config.dryRun=false;config.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
  const publisher=new MetaPublisher('instagram',{config,env:{THREADS_ACCESS_TOKEN:'synthetic',THREADS_USER_ID:'12',INSTAGRAM_ACCESS_TOKEN:'synthetic',INSTAGRAM_USER_ID:'34'},fetchImpl:async()=>assert.fail('must not send')});
  await assert.rejects(()=>publisher.prepare({kind:'daily',text:thankYou(1).text,images:[{...fixtureImage('x'),dryRunOnly:true}]}),/dry_run_image_not_publishable/);
});
test('Engine holds an ambiguous thank-you send, then resolves it only with confirmed media ID',async t=>{
  const {store,q}=setup(t);await record(q,10);const config=loadConfig(undefined,{});config.dryRun=false;config.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
  for(const key of ['THREADS_ACCESS_TOKEN','THREADS_USER_ID','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']){const before=process.env[key];process.env[key]='synthetic';t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});}
  const publisher=new MockPublisher('threads');publisher.fail='ambiguous_send';const engine=new Engine({store,config,publishers:{threads:publisher},clock:()=>new Date(slots[0].scheduledAt)});
  const r=await engine.run(slots[0],'threads');assert.equal(r.state,'unknown');assert.equal((await q.read()).events.find(e=>e.threshold===10).live.threads.state,'unknown');
  assert.equal(await q.claim(slots[1],'threads',options(slots[1],false)),null);
  publisher.reconcile=async()=>({state:'published',remoteId:'verified-synthetic-id'});await engine.reconcile(slots[0].id,'threads');
  assert.equal((await q.read()).events.find(e=>e.threshold===10).live.threads.state,'sent');
});
test('status checks migration capability without recording fake sales',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'milestone-check-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const calls=[];
  const env={STORAGE_BACKEND:'supabase',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_synthetic'};
  const result=await main('milestone-status',dir,new Date(),{env,fetchImpl:async(url,o)=>{const body=JSON.parse(o.body);calls.push(body.action);return new Response(JSON.stringify(body.action==='health'?{milestoneVersion:1}:null));}});
  assert.deepEqual(calls,['health','setting']);assert.deepEqual(result,{milestoneVersion:1,state:null,published:false});
});
