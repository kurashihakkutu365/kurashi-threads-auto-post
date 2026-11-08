import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import jpeg from 'jpeg-js';
import { Store } from '../src/store.js';
import { loadConfig,assertProduction } from '../src/config.js';
import { Budget } from '../src/budget.js';
import { slotsForDay,jstDay,jstMonth,slotState } from '../src/time.js';
import { fixtureProduct,fixtureImage,MockRakuten,MockVision } from '../src/fixtures.js';
import { eligible,GENRES,scoreProduct,Selection,canonicalId,styleFor } from '../src/products.js';
import { requirePair,validateImage,putLicensedImage,hashImage,registerRights,publicHttps } from '../src/rights.js';
import { generateCopy,validateCopy,renderCopy,similar,validateDaily } from '../src/content.js';
import { Engine } from '../src/engine.js';
import { MockPublisher,MetaPublisher } from '../src/publishers.js';
import { buildSite,verifySiteProduct } from '../src/site.js';
import { dailyBatch,renderDailyImage } from '../src/daily.js';
import { request } from '../src/http.js';
import { ReplyQueue,verifySignature,webhookChallenge,classifyComment } from '../src/replies.js';
import { backupDatabase,verifyRestore,exportDatabase,report } from '../src/maintenance.js';
import { main } from '../src/cli.js';
import { OpenAIClient } from '../src/ai.js';

const NOW=new Date('2026-11-07T07:00:00+09:00');
const DAY='2026-11-07';
const config=()=>loadConfig(undefined,{});
function setup(t,{live=false}={}) {
  const store=new Store(); t.after(()=>store.close());
  const c=config();
  if (live) {
    c.dryRun=false;
    c.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
    // Synthetic credentials are only consumed by mock adapters. No test contacts Meta.
    for(const k of ['THREADS_ACCESS_TOKEN','THREADS_USER_ID','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
      const prev=process.env[k]; process.env[k]='123456';
      t.after(()=>{ if(prev===undefined) delete process.env[k]; else process.env[k]=prev; });
    }
  }
  const p=fixtureProduct(1,NOW); store.saveProduct(p,NOW);
  store.saveImage(fixtureImage(p.id,1,NOW)); store.saveImage(fixtureImage(p.id,2,NOW));
  const api=new MockRakuten([p]),vision=new MockVision();
  const selection=new Selection(store,api,vision,c);
  const publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
  const engine=new Engine({store,config:c,selection,publishers,verifySite:async()=>true,clock:()=>NOW});
  return {store,c,p,api,vision,selection,publishers,engine,slot:slotsForDay(DAY)[0]};
}
function temp(t) { const dir=mkdtempSync(join(tmpdir(),'kurashi-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
const jsonResponse=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});

test('configuration defaults to DRY_RUN; one override cannot enable production',()=>{
  assert.equal(config().dryRun,true);
  assert.equal(loadConfig(undefined,{DRY_RUN:'false'}).dryRun,true);
  assert.throws(()=>assertProduction(config()),/dry_run_only/);
});
test('missing production approval or authentication stops before API use',()=>{
  const c=config(); c.dryRun=false;
  assert.throws(()=>assertProduction(c,{}),/production_not_approved/);
  c.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
  assert.throws(()=>assertProduction(c,{}),/missing_credentials/);
});
test('JST schedule contains exactly five products and two daily slots',()=>{
  const s=slotsForDay(DAY);
  assert.equal(s.filter(s=>s.kind==='product').length,5);
  assert.equal(s.filter(s=>s.kind==='daily').length,2);
  assert.equal(s[0].scheduledAt,'2026-11-06T22:00:00.000Z');
  assert.equal(s[6].scheduledAt,'2026-11-07T10:00:00.000Z');
});
test('JST management month changes at midnight JST',()=>{
  assert.equal(jstMonth(new Date('2026-11-30T14:59:59Z')),'2026-11');
  assert.equal(jstMonth(new Date('2026-11-30T15:00:00Z')),'2026-12');
  assert.equal(jstDay(NOW),DAY);
});
test('delayed Actions slots expire; future slots do not run',()=>{
  const slot=slotsForDay(DAY)[0];
  assert.equal(slotState(slot,new Date(+NOW+21*60000),20),'expired');
  assert.equal(slotState(slot,new Date(+NOW-1),20),'future');
});

test('budget reservations include concurrent outstanding maximum costs',t=>{
  const {store,c}=setup(t); const b=new Budget(store,c);
  const id=b.reserve({category:'other',service:'mock',maximumYen:600},NOW);
  assert.equal(b.totals(NOW).committed,600);
  assert.throws(()=>b.reserve({category:'other',service:'mock',maximumYen:401},NOW),/monthly_budget/);
  b.settle(id,100,1000);
  assert.equal(b.totals(NOW).committed,100);
  assert.equal(b.totals(new Date('2026-12-01T00:00:00+09:00')).committed,0);
});
for(const [spent,mode] of [[500,'normal'],[700,'vision_stop'],[850,'essential_only'],[950,'paid_stop'],[1000,'stop']]) {
  test(`budget ${spent/10}%: ${mode} and appropriate paid-operation gate`,t=>{
    const {store,c}=setup(t); const b=new Budget(store,c);
    store.db.prepare('INSERT INTO usage(id,month,day,category,service,state,reserved,estimated,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('used','2026-11',DAY,'other','test','settled',spent,spent,NOW.toISOString());
    assert.equal(b.mode(NOW),mode);
    if(spent>=700) assert.throws(()=>b.reserve({category:'vision',service:'mock',maximumYen:1},NOW),/budget_throttled/);
    if(spent>=850) assert.throws(()=>b.reserve({category:'text',service:'mock',maximumYen:1},NOW),/budget_throttled/);
    if(spent===850) assert.ok(b.reserve({category:'text',service:'mock',maximumYen:1,essential:true},NOW));
    if(spent>=950) assert.throws(()=>b.reserve({category:'text',service:'mock',maximumYen:1,essential:true},NOW),/budget_throttled/);
  });
}
test('AI calls require verified pricing and enforce category/token caps',t=>{
  const {store,c}=setup(t); const b=new Budget(store,c);
  assert.throws(()=>b.estimate(100,100),/pricing_unverified/);
  assert.throws(()=>b.reserve({category:'vision',service:'mock',maximumYen:301},NOW),/category_budget/);
  assert.throws(()=>b.reserve({category:'text',service:'mock',maximumYen:1,maximumTokens:30001},NOW),/daily_ai_limit/);
  assert.throws(()=>b.reserve({category:'text',service:'mock',maximumYen:NaN},NOW),/invalid_reservation/);
});
test('actual bill reconciliation is distinct from estimates and stops new paid work',t=>{
  const {store,c}=setup(t),b=new Budget(store,c);
  const id=b.reserve({category:'other',service:'mock',maximumYen:100},NOW);
  b.settle(id,80,100); b.recordBill(id,1100);
  assert.equal(b.totals(NOW).estimated,80); assert.equal(b.totals(NOW).actualBilled,1100);
  assert.equal(b.mode(NOW),'stop');
  assert.throws(()=>b.reserve({category:'text',service:'mock',maximumYen:1},NOW),/budget_throttled/);
});
function paidFixture(t,fetchImpl) {
  const {store,c,p}=setup(t);
  Object.assign(c,{dryRun:false,paidAiEnabled:true,usdJpy:150,aiLimits:{maxInputTokens:8000,maxOutputTokens:600,maxVisionInputTokens:12000}});
  c.production.hardBillingLimitVerified=true;
  // Synthetic rates test accounting only; never used for live configuration.
  c.pricing={model:'synthetic-model',version:'test',inputUsdPerMillion:1,outputUsdPerMillion:2,verifiedAt:new Date().toISOString()};
  return {store,c,p,client:new OpenAIClient(store,c,{env:{OPENAI_API_KEY:'synthetic'},fetchImpl,clock:()=>NOW})};
}
test('paid text provider reserves first, verifies JSON Schema, settles actual usage and generates both SNS copy once',async t=>{
  let fixture,body;
  fixture=paidFixture(t,async(u,options)=>{
    body=JSON.parse(options.body);
    assert.ok(new Budget(fixture.store,fixture.c).totals(NOW).committed>0);
    return jsonResponse({status:'completed',usage:{input_tokens:100,output_tokens:60},output:[{content:[{type:'output_text',text:JSON.stringify(generateCopy(fixture.p))}]}]});
  });
  const copy=await fixture.client.copy(fixture.p);
  assert.equal(copy.style,'A'); assert.equal(body.store,false); assert.equal(body.text.format.type,'json_schema');
  assert.equal(fixture.store.db.prepare('SELECT state,tokens FROM usage').get().state,'settled');
  assert.equal(fixture.store.db.prepare('SELECT tokens FROM usage').get().tokens,160);
});
test('AI timeout leaves the maximum reservation held and does not retry',async t=>{
  let calls=0;
  const {store,c,p,client}=paidFixture(t,async()=>{calls++;throw new Error('timeout');});
  await assert.rejects(()=>client.copy(p),/ambiguous_send/);
  assert.equal(calls,1); assert.ok(new Budget(store,c).totals(NOW).committed>0);
  assert.equal(store.db.prepare('SELECT state FROM usage').get().state,'reserved');
});
test('budget 70% stops new image AI before the provider request',async t=>{
  let calls=0; const {store,c,client}=paidFixture(t,async()=>{calls++;assert.fail('must not call');});
  const b=new Budget(store,c); const id=b.reserve({category:'other',service:'mock',maximumYen:700},NOW); b.settle(id,700,0);
  await assert.rejects(()=>client.structured({schema:{type:'object',additionalProperties:false,required:[],properties:{}},prompt:'test',category:'vision'}),/budget_throttled/);
  assert.equal(calls,0);
});
test('DRY_RUN prevents every paid AI request even with a key present',async t=>{
  const {c,p,client}=paidFixture(t,async()=>assert.fail('must not call')); c.dryRun=true;
  await assert.rejects(()=>client.copy(p),/paid_ai_disabled/);
});
test('AI usage larger than its bound is recorded and activates emergency stop',async t=>{
  let f;
  f=paidFixture(t,async()=>jsonResponse({status:'completed',usage:{input_tokens:9000,output_tokens:2},output:[]}));
  await assert.rejects(()=>f.client.copy(f.p),/ai_usage_bound_exceeded/);
  assert.equal(f.store.setting('emergencyStop'),true);
  assert.equal(f.store.db.prepare('SELECT tokens FROM usage').get().tokens,9002);
});
test('daily AI generates two validated themes in one request',async t=>{
  let calls=0;
  const {client}=paidFixture(t,async()=>{
    calls++;
    return jsonResponse({status:'completed',usage:{input_tokens:200,output_tokens:100},output:[{content:[{type:'output_text',text:JSON.stringify({themes:dailyBatch(DAY)})}]}]});
  });
  assert.equal((await client.daily()).length,2); assert.equal(calls,1);
});

test('Rakuten mock search batches once per JST day and caches image analysis',async t=>{
  const {selection,api,vision,store}=setup(t);
  assert.equal((await selection.collect(DAY,NOW)).length,1);
  assert.equal((await selection.collect(DAY,NOW)).length,1);
  assert.equal(api.searchCalls,1); assert.equal(vision.calls,1);
  store.db.prepare("DELETE FROM cache WHERE key LIKE 'collection:%'").run();
  await selection.collect(DAY,NOW);
  assert.equal(vision.calls,1);
});
test('same product/image/model uses cache; changed model invalidates analysis',async t=>{
  const {selection,vision,store}=setup(t);
  await selection.collect(DAY,NOW);
  store.db.prepare("DELETE FROM cache WHERE key LIKE 'collection:%'").run();
  vision.version='mock-v2'; await selection.collect(DAY,NOW);
  assert.equal(vision.calls,2);
});
test('eight genres include ordinary products; character-only filter is absent',()=>{
  assert.equal(GENRES.length,8);
  for(const genre of GENRES) assert.equal(eligible({...fixtureProduct(1,NOW),genre}),true);
  assert.equal(eligible({...fixtureProduct(1,NOW),genre:'ゲーム'}),false);
});
test('review, stock and commission filters do not relax to fill empty slots',()=>{
  const p=fixtureProduct(1,NOW);
  for(const bad of [{reviewAverage:3.9},{reviewCount:29},{affiliateRate:9.9},{available:false},{price:0}]) assert.equal(eligible({...p,...bad}),false);
});
test('design weights total 100 with design 40, originality 20',()=>{
  assert.equal(scoreProduct({design:40,originality:20,usefulness:15,quality:10,value:10,social:5}),100);
  assert.throws(()=>scoreProduct({design:41,originality:20,usefulness:15,quality:10,value:10,social:5}),/invalid_score/);
});
test('unverified cross-shop identity is rejected; same GTIN deduplicates',()=>{
  assert.throws(()=>canonicalId({name:'商品'}),/product_identity_unverified/);
  assert.equal(canonicalId({gtin:'1234567890123'}),canonicalId({gtin:'1234567890123',name:'別店舗'}));
});
test('30-day same-product ban is shared across SNS and shop listings',t=>{
  const {store,c,p,slot}=setup(t);
  store.claim(slot,'threads',p,NOW,c); store.updatePost(slot.id,'threads','published',{published_at:NOW.toISOString()});
  const later={...slot,id:'2026-11-08/07:00',scheduledAt:'2026-11-07T22:00:00Z'};
  assert.throws(()=>store.claim(later,'instagram',{...p,id:'another-shop:same'},new Date(+NOW+86400000),c),/duplicate_product/);
  assert.equal(store.recentlyUsed(p.canonical,new Date(+NOW+31*86400000),30,''),false);
});
test('permanent product numbers survive upserts and are not reused after deletion',t=>{
  const {store,p}=setup(t); const a=store.product(p.id).number;
  assert.equal(store.saveProduct({...p,price:999},NOW).number,a);
  store.db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  assert.ok(store.saveProduct(fixtureProduct(2,NOW),NOW).number>a);
});

test('two different licensed images are required',t=>{
  const {store,p}=setup(t);
  assert.equal(requirePair(store.images(p.id),'instagram',NOW,{site:true}).length,2);
  assert.throws(()=>requirePair(store.images(p.id).slice(0,1),'threads',NOW),/two_licensed_images_required/);
});
test('different URLs with the same image hash are rejected',t=>{
  const {store,p}=setup(t); const images=store.images(p.id); images[1].hash=images[0].hash;
  assert.throws(()=>requirePair(images,'threads',NOW),/two_licensed_images_required/);
});
for(const [name,change,options] of [
  ['unconfirmed rights',i=>delete i.evidence,{}],
  ['expired rights',i=>i.expiresAt='2026-01-01T00:00:00Z',{}],
  ['missing public hosting',i=>i.permissions.publicHosting=false,{}],
  ['expired public URL',i=>i.publicUrlExpiresAt='2026-01-01T00:00:00Z',{}],
  ['site rights independent from SNS',i=>i.permissions.site=false,{site:true}],
  ['AI rights independent from SNS',i=>i.permissions.ai=false,{ai:true}],
  ['unapproved Instagram format',i=>i.mime='image/png',{}],
]) test(`image gate: ${name}`,()=>{
  const i=fixtureImage('p',1,NOW); change(i);
  assert.throws(()=>validateImage(i,'instagram',NOW,options));
});
test('licensed local image storage verifies hash, deduplicates and enforces limits',t=>{
  const directory=temp(t),bytes=Buffer.from('original image');
  const i={...fixtureImage('p',1,NOW),hash:hashImage(bytes)};
  const limits={maxBytes:100,maxFiles:1};
  const a=putLicensedImage(bytes,i,directory,limits,NOW);
  assert.equal(putLicensedImage(bytes,i,directory,limits,NOW),a);
  assert.throws(()=>putLicensedImage(Buffer.from('x'),i,directory,limits,NOW),/hash_mismatch/);
  const other=Buffer.from('other');
  assert.throws(()=>putLicensedImage(other,{...i,hash:hashImage(other)},directory,limits,NOW),/storage_limit/);
});
test('human registration verifies file bytes and rejects missing download permission before storage',t=>{
  const {store,p}=setup(t); const directory=temp(t),path=join(directory,'image');
  const bytes=Buffer.from('original'); writeFileSync(path,bytes);
  const i={...fixtureImage(p.id,3,NOW),storagePath:path,hash:hashImage(bytes)};
  registerRights(store,i,NOW);
  assert.equal(store.images(p.id).length,3);
  i.permissions.download=false;
  assert.throws(()=>putLicensedImage(bytes,i,join(directory,'blocked'),{maxBytes:100,maxFiles:10},NOW),/rights_missing_scope/);
});
test('private-network image URLs are not accepted',()=>{
  for(const url of ['http://example.com/a.jpg','https://127.0.0.1/a','https://10.0.0.1/a','https://[::1]/a','https://u:p@example.com/a']) assert.equal(publicHttps(url),false);
});

test('A/B/C style selection and JSON Schema constraints',()=>{
  const p=fixtureProduct(1,NOW); assert.equal(styleFor(p),'A');
  assert.equal(styleFor({...p,name:'かわいい猫の置物'}),'B');
  assert.equal(styleFor({...p,name:'マグカップ',description:'食器'}),'C');
  assert.throws(()=>validateCopy({...generateCopy(p),extra:'x'},p),/copy_schema/);
});
test('captions start with PR, use correct platform CTA, and stay within three body lines',()=>{
  const p={...fixtureProduct(1,NOW),number:12},copy=validateCopy(generateCopy(p),p);
  assert.equal(copy.lines.length<=3,true);
  const threads=renderCopy(copy,p,'threads'),ig=renderCopy(copy,p,'instagram');
  assert.ok(threads.startsWith('【PR】')); assert.ok(ig.startsWith('【PR】'));
  assert.ok(threads.includes(p.affiliateUrl)); assert.ok(!ig.includes(p.affiliateUrl));
  assert.ok(ig.includes('商品No.12｜プロフィールのリンクからチェック'));
  assert.equal(copy.hashtags.length,1);
});
test('unsupported functions, fake experiences and repeated captions are rejected',()=>{
  const p=fixtureProduct(1,NOW),copy=generateCopy(p);
  assert.throws(()=>validateCopy({...copy,lines:['絶対治る']},p),/unsupported_claim/);
  assert.throws(()=>validateCopy({...copy,lines:['買ってみました']},p),/unsupported_claim/);
  assert.throws(()=>validateCopy(copy,p,[copy.lines.join('\n')]),/similar_copy/);
  assert.equal(similar('【PR】収納箱\n小物をまとめる https://example.com #収納','収納箱\n小物をまとめる'),true);
});

test('DRY_RUN product pipeline handles both SNS with exactly two images and zero publication calls',async t=>{
  const {engine,p,slot,publishers}=setup(t);
  for(const sns of ['threads','instagram']) {
    const r=await engine.run(slot,sns,{product:p}); assert.equal(r.state,'dry_run');
    assert.equal(publishers[sns].calls.length,1);
    assert.equal(publishers[sns].calls[0][1].images.length,2);
  }
});
test('post copies are generated once for both platforms',async t=>{
  const {engine,p,slot}=setup(t); let calls=0;
  engine.generate=async p=>{calls++; return generateCopy(p);};
  await engine.run(slot,'threads',{product:p}); await engine.run(slot,'instagram',{product:p});
  assert.equal(calls,1);
});
test('DRY_RUN refuses an adapter not explicitly safe for offline preparation',async t=>{
  const {engine,p,slot,publishers}=setup(t); publishers.threads.dryRunSafe=false;
  assert.equal((await engine.run(slot,'threads',{product:p})).reason,'unsafe_dry_run_adapter');
  assert.equal(publishers.threads.calls.length,0);
});
test('live-shaped mock integration creates and publishes a carousel',async t=>{
  const {engine,p,slot,publishers}=setup(t,{live:true});
  for(const sns of ['threads','instagram']) {
    const r=await engine.run(slot,sns,{product:p}); assert.equal(r.state,'published');
    assert.deepEqual(publishers[sns].calls.map(c=>c[0]),['prepare','publish']);
  }
});
test('out-of-stock, stale price timestamp and invalid affiliate URL stop before prepare',async t=>{
  for(const bad of [{available:false},{checkedAt:'2026-01-01T00:00:00Z'},{affiliateUrl:'https://example.com'}]) {
    const s=setup(t); s.api.products=[{...s.p,...bad}];
    const r=await s.engine.run(s.slot,'threads',{product:s.p});
    assert.equal(r.state,'skipped'); assert.equal(s.publishers.threads.calls.length,0);
  }
});
test('Instagram publication waits for verified site registration; Threads proceeds independently',async t=>{
  const {engine,p,slot}=setup(t);
  engine.verifySite=async()=>{throw new Error('site_not_published');};
  assert.equal((await engine.run(slot,'instagram',{product:p})).reason,'site_not_published');
  assert.equal((await engine.run(slot,'threads',{product:p})).state,'dry_run');
});
test('same slot cannot publish twice',async t=>{
  const {engine,p,slot,publishers}=setup(t,{live:true});
  await engine.run(slot,'threads',{product:p}); await engine.run(slot,'threads',{product:p});
  assert.equal(publishers.threads.calls.filter(c=>c[0]==='publish').length,1);
});
test('invalid or reclassified slots cannot bypass the seven fixed slots',async t=>{
  const {engine,slot,p}=setup(t);
  await assert.rejects(()=>engine.run({...slot,kind:'daily'},'threads',{product:p}),/invalid_slot/);
  await assert.rejects(()=>engine.run({...slot,id:DAY+'/06:00'},'threads',{product:p}),/invalid_slot/);
});
test('daily product and daily-theme caps are enforced separately',t=>{
  const {store,c}=setup(t);
  for(let i=0;i<5;i++) {
    const p=fixtureProduct(i+1,NOW);
    store.claim({id:`${DAY}/test-${i}`,kind:'product',scheduledAt:NOW.toISOString()},'threads',p,NOW,c);
  }
  assert.throws(()=>store.claim({id:DAY+'/extra',kind:'product',scheduledAt:NOW.toISOString()},'threads',fixtureProduct(6,NOW),NOW,c),/daily_kind_limit/);
});
test('socket disconnect after publish enters unknown; rerun never resends',async t=>{
  const {engine,p,slot,publishers,store}=setup(t,{live:true}); publishers.threads.fail='ambiguous_send';
  const r=await engine.run(slot,'threads',{product:p});
  assert.equal(r.state,'unknown'); assert.ok(r.container_id);
  await engine.run(slot,'threads',{product:p}); await engine.reconcile(slot.id,'threads');
  assert.equal(publishers.threads.calls.filter(c=>c[0]==='publish').length,1);
  assert.equal(store.post(slot.id,'threads').state,'unknown');
});
test('known remote media ID can reconcile unknown state without resending',async t=>{
  const {engine,p,slot,publishers}=setup(t,{live:true}); publishers.threads.fail='ambiguous_send';
  await engine.run(slot,'threads',{product:p});
  publishers.threads.reconcile=async()=>({state:'published',remoteId:'verified-media-id'});
  const r=await engine.reconcile(slot.id,'threads');
  assert.equal(r.state,'published'); assert.equal(r.remote_id,'verified-media-id');
});
test('emergency and individual platform stops happen before any network or preparation',async t=>{
  const {engine,p,slot,publishers,store,c}=setup(t);
  store.setting('stop:instagram',true);
  assert.equal((await engine.run(slot,'instagram',{product:p})).reason,'platform_stopped');
  assert.equal((await engine.run(slot,'threads',{product:p})).state,'dry_run');
  store.setting('emergencyStop',true);
  assert.equal((await engine.run(slotsForDay(DAY)[1],'threads',{product:p})).reason,'platform_stopped');
  assert.equal(publishers.instagram.calls.length,0);
  c.termsStop=true; assert.equal(await engine.stopped('threads'),true);
});
test('delayed scheduler skips old slots and never prepares media',async t=>{
  const {engine,p,slot,publishers}=setup(t); engine.clock=()=>new Date(+NOW+3600000);
  assert.equal((await engine.run(slot,'threads',{product:p})).reason,'slot_expired');
  assert.equal(publishers.threads.calls.length,0);
});
test('DB outage prevents publication',async t=>{
  const {engine,p,slot,publishers,store}=setup(t);
  store.claim=()=>{throw new Error('db_unavailable');};
  await assert.rejects(()=>engine.run(slot,'threads',{product:p}),/db_unavailable/);
  assert.equal(publishers.threads.calls.length,0);
});
test('independent processes competing for one slot produce a single winner',async t=>{
  const dir=temp(t),path=join(dir,'state.sqlite'); const db=new Store(path); db.close();
  const code=`import {Store} from './src/store.js'; import {loadConfig} from './src/config.js'; const s=new Store(process.argv[1]); console.log(s.claim({id:'2026-11-07/07:00',kind:'daily',scheduledAt:'2026-11-06T22:00:00.000Z'},'threads',null,new Date('2026-11-06T22:00:00Z'),loadConfig(undefined,{}))); s.close();`;
  const run=()=>new Promise((resolve,reject)=>{
    // A worker is a normal CLI process, not a nested Node test IPC participant.
    const {NODE_TEST_CONTEXT:ignored,...workerEnv}=process.env;
    const p=spawn(process.execPath,['--input-type=module','-e',code,path],{cwd:process.cwd(),env:workerEnv}); let out='',err='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    p.on('error',reject); p.on('close',c=>c===0?resolve(out.trim()):reject(new Error(err)));
  });
  const outcomes=await Promise.all([run(),run(),run()]);
  assert.equal(outcomes.filter(x=>x==='true').length,1);
});

test('official Meta protocol sends two children, carousel parent, then publish (mock transport)',async()=>{
  for(const sns of ['threads','instagram']) {
    const c=config(); c.dryRun=false;
    c.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
    const calls=[];
    const pub=new MetaPublisher(sns,{config:c,env:{THREADS_ACCESS_TOKEN:'synthetic',THREADS_USER_ID:'12',INSTAGRAM_ACCESS_TOKEN:'synthetic',INSTAGRAM_USER_ID:'34'},fetchImpl:async(url,options)=>{
      calls.push({url,body:options.body&&Object.fromEntries(options.body)});
      return jsonResponse({id:String(100+calls.length)});
    }});
    const container=await pub.prepare({kind:'product',text:'【PR】デモ',images:[fixtureImage('p',1),fixtureImage('p',2)]});
    await pub.publish(container);
    assert.equal(calls.length,4);
    assert.ok(calls.every(c=>new URL(c.url).hostname===(sns==='threads'?'graph.threads.com':'graph.facebook.com')));
    assert.equal(calls[0].body.is_carousel_item,'true');
    assert.equal(calls[2].body.media_type,'CAROUSEL');
    assert.equal(calls[2].body.children,'101,102');
    assert.equal(calls[3].body.creation_id,'103');
  }
});
test('401 token expiry stops and POST 429 is not automatically retried',async()=>{
  await assert.rejects(()=>request('https://example.invalid',{fetchImpl:async()=>jsonResponse({},401)}),/token_expired/);
  let calls=0;
  await assert.rejects(()=>request('https://example.invalid',{method:'POST',fetchImpl:async()=>{calls++;return jsonResponse({},429);}}),/rate_limited/);
  assert.equal(calls,1);
});
test('429 GET honors Retry-After and bounded retries',async()=>{
  let calls=0; const delays=[];
  const r=await request('https://example.invalid',{fetchImpl:async()=>++calls<3?jsonResponse({},429,{'Retry-After':'2'}):jsonResponse({ok:true}),sleep:async ms=>delays.push(ms)});
  assert.equal(r.ok,true); assert.deepEqual(delays,[2000,2000]);
  await assert.rejects(()=>request('https://example.invalid',{fetchImpl:async()=>jsonResponse({},429,{'Retry-After':'120'}),sleep:async()=>assert.fail('should defer')}),/retry_deferred/);
});
test('POST network failures are ambiguous and never retried',async()=>{
  let calls=0;
  await assert.rejects(()=>request('https://example.invalid',{method:'POST',fetchImpl:async()=>{calls++;throw new Error('socket closed');}}),/ambiguous_send/);
  assert.equal(calls,1);
});

test('static product page includes PR, unique numbers, privacy and contact; no private rights evidence',t=>{
  const {store,c}=setup(t),dir=temp(t);
  const items=buildSite(store,dir,c,NOW);
  assert.equal(items.length,1);
  const html=readFileSync(join(dir,'index.html'),'utf8');
  for(const text of ['【PR】','商品No.1','プライバシーポリシー','お問い合わせ','rel="sponsored']) assert.ok(html.includes(text));
  assert.ok(!html.includes('approvedBy')); assert.ok(!html.includes('fixture-generator'));
});
test('unlicensed site images are never exported to public HTML or JSON',t=>{
  const {store,c,p}=setup(t),dir=temp(t);
  for(const i of store.images(p.id)) { i.permissions.site=false; store.saveImage(i); }
  assert.equal(buildSite(store,dir,c,NOW).length,0);
  assert.ok(!readFileSync(join(dir,'index.html'),'utf8').includes('fixtures.invalid'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'products.json'),'utf8')).items,[]);
});
test('site publication verifies JSON, rendered HTML and expected image',async t=>{
  const {store,c,p}=setup(t),dir=temp(t); c.site.url='https://example.invalid/kurashi/'; c.site.affiliateRegistrationConfirmed=true;
  const items=buildSite(store,dir,c,NOW),product=store.product(p.id);
  const fetchImpl=async u=>String(u).endsWith('products.json')?jsonResponse({generatedAt:NOW.toISOString(),items}):new Response(readFileSync(join(dir,'index.html'),'utf8'));
  assert.equal(await verifySiteProduct(product,store.images(p.id),c,{fetchImpl,now:NOW}),true);
  await assert.rejects(()=>verifySiteProduct(product,store.images(p.id),c,{fetchImpl:async()=>jsonResponse({items:[]}),now:NOW}),/site_product_mismatch/);
});
test('daily batch excludes recent themes and contains no affiliate URLs or fake experience',()=>{
  const first=dailyBatch(DAY); assert.equal(first.length,2);
  const second=dailyBatch('2026-11-08',first.map(t=>t.text)); assert.equal(second.length,2);
  for(const theme of [...first,...second]) assert.ok(validateDaily(theme));
  assert.throws(()=>validateDaily({text:'私が買ってみた https://example.com'}),/invalid_daily/);
});
test('original static Instagram template renders a readable 1080-square JPEG',()=>{
  const rendered=renderDailyImage(dailyBatch(DAY)[0].text);
  assert.equal(rendered.jpeg[0],0xff); assert.equal(rendered.jpeg[1],0xd8);
  const decoded=jpeg.decode(rendered.jpeg);
  assert.equal(decoded.width,1080); assert.equal(decoded.height,1080);
  assert.ok(rendered.svg.includes('font-size="48"'));
  assert.throws(()=>renderDailyImage('あ'.repeat(150)),/image_text_overflow/);
});
test('Threads daily post is text-only; Instagram requires an original licensed image',async t=>{
  const {engine,publishers}=setup(t); const slot=slotsForDay(DAY)[2]; engine.clock=()=>new Date(slot.scheduledAt);
  const daily=dailyBatch(DAY)[0];
  assert.equal((await engine.run(slot,'threads',{daily})).state,'dry_run');
  assert.equal(publishers.threads.calls[0][1].images.length,0);
  const r=await engine.run(slot,'instagram',{daily}); assert.equal(r.state,'skipped');
});

function ownPost(s) {
  s.store.claim(s.slot,'threads',s.p,NOW,s.c);
  s.store.updatePost(s.slot.id,'threads','published',{remote_id:'own-post',published_at:NOW.toISOString()});
}
const event=(overrides={})=>({id:'evt-1',sns:'threads',commentId:'comment-1',author:'person-1',parentPostId:'own-post',text:'ありがとうございます！',isOwnPost:true,depth:1,...overrides});
test('webhook raw body signature and subscription challenge validation',()=>{
  const raw=Buffer.from('{"event":"one"}'),secret='synthetic-test-secret';
  const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal(verifySignature(raw,sig,secret),true);
  assert.equal(verifySignature(Buffer.from('tampered'),sig,secret),false);
  assert.equal(verifySignature(raw,sig,''),false);
  assert.equal(webhookChallenge({'hub.mode':'subscribe','hub.verify_token':'test','hub.challenge':'123'},'test'),'123');
  assert.throws(()=>webhookChallenge({'hub.verify_token':'bad'},'test'));
});
test('comment detection queues only direct comments on our own posts and deduplicates events',t=>{
  const s=setup(t); ownPost(s); const q=new ReplyQueue(s.store,s.c);
  assert.equal(q.ingest(event(),NOW),true); assert.equal(q.ingest(event(),NOW),false);
  assert.equal(q.ingest(event({id:'retry',commentId:'comment-1'}),NOW),false);
  assert.equal(q.ingest(event({id:'other',commentId:'other',parentPostId:'not-ours'}),NOW),false);
  assert.equal(q.ingest(event({id:'nested',depth:2}),NOW),false);
  const row=s.store.db.prepare('SELECT * FROM events').get();
  const delay=Date.parse(row.due_at)-+NOW; assert.ok(delay>=180000 && delay<=420000);
});
test('automatic replies never send during dry-run and do not reply twice',async t=>{
  const s=setup(t); ownPost(s); s.c.repliesEnabled=true; const q=new ReplyQueue(s.store,s.c);
  q.ingest(event(),NOW); let calls=0;
  const adapter={context:async()=>({isOwnPost:true,depth:1,text:event().text}),reply:async()=>{calls++;}};
  const results=await q.process(adapter,new Date(+NOW+7*60000));
  assert.equal(results[0].state,'dry_run'); assert.equal(calls,0);
  assert.equal((await q.process(adapter,new Date(+NOW+8*60000))).length,0);
});
test('authorized reply adapter sends once, enforces limits, and never starts an endless conversation',async t=>{
  const s=setup(t,{live:true}); ownPost(s); s.c.repliesEnabled=true; s.c.dailyReplyLimit=1;
  const q=new ReplyQueue(s.store,s.c); q.ingest(event(),NOW);
  q.ingest(event({id:'event-2',commentId:'comment-2',author:'person-2'}),NOW);
  q.ingest(event({id:'nested',commentId:'nested',depth:2}),NOW);
  let calls=0;
  const adapter={authorizedOfficialReplies:true,context:async()=>({isOwnPost:true,depth:1,text:event().text}),reply:async()=>{calls++;}};
  const results=await q.process(adapter,new Date(+NOW+8*60000));
  assert.equal(results.filter(r=>r.state==='sent').length,1); assert.equal(calls,1);
  await q.process(adapter,new Date(+NOW+10*60000)); assert.equal(calls,1);
});
test('bad webhook signature is rejected before normalization or persistence',t=>{
  const s=setup(t),q=new ReplyQueue(s.store,s.c);
  assert.throws(()=>q.receive(Buffer.from('{}'),'sha256='+'0'.repeat(64),'secret',()=>assert.fail('must not normalize'),NOW),/invalid_webhook_signature/);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM events').get().n,0);
});
test('spam, abuse, PII, trouble and financial/medical/legal comments are excluded before AI',()=>{
  for(const text of ['https://spam.example','バカ','user@example.com','電話09012345678','返金してください','医療の相談','法律の相談','投資の相談']) assert.equal(classifyComment(text),'excluded');
  assert.equal(classifyComment('返信不要です'),'opt_out');
  assert.equal(classifyComment('複雑な質問があります'),'review');
});
test('reply opt-out persists for future comments from the same person',t=>{
  const s=setup(t); ownPost(s); const q=new ReplyQueue(s.store,s.c);
  q.ingest(event({text:'返信停止してください'}),NOW);
  q.ingest(event({id:'e2',commentId:'c2'}),NOW);
  assert.equal(s.store.db.prepare("SELECT state FROM events WHERE id='e2'").get().state,'excluded');
});
test('reply processing failure is isolated from regular posting',async t=>{
  const s=setup(t); s.c.repliesEnabled=false;
  const q=new ReplyQueue(s.store,s.c); assert.deepEqual(await q.process({},NOW),[]);
  assert.equal((await s.engine.run(s.slot,'threads',{product:s.p})).state,'dry_run');
});

test('backup restores data including rights and dedupe state, with checksum verification',async t=>{
  const {store,p}=setup(t); const path=join(temp(t),'backup.sqlite');
  await backupDatabase(store,path); const rows=verifyRestore(path);
  assert.equal(rows.products,1); assert.equal(rows.images,2);
  const restored=new Store(path); t.after(()=>restored.close()); assert.equal(restored.product(p.id).number,1);
  writeFileSync(path+'.manifest.json',JSON.stringify({sha256:'wrong'}));
  assert.throws(()=>verifyRestore(path),/backup_hash_mismatch/);
});
test('export is portable; long-term cleanup preserves rights and dedupe tombstones',t=>{
  const s=setup(t); ownPost(s); const q=new ReplyQueue(s.store,s.c); q.ingest(event({text:'返信不要'}),NOW);
  s.store.log('token_expired',NOW); s.store.cache('expired',{x:1},NOW.toISOString());
  s.store.cleanup(new Date(+NOW+100*86400000),90);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM logs').get().n,0);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM cache').get().n,0);
  assert.equal(s.store.images(s.p.id).length,2);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM events').get().n,1);
  assert.equal(s.store.db.prepare('SELECT data FROM events').get().data,'{}');
  const path=join(temp(t),'export.json'); exportDatabase(s.store,path);
  const data=JSON.parse(readFileSync(path,'utf8')); assert.equal(data.schemaVersion,1); assert.equal(data.tables.products.length,1);
});
test('monthly report separates committed estimates from actual bills and contains no credentials',t=>{
  const {store,c}=setup(t); const r=report(store,c,NOW);
  assert.equal(r.month,'2026-11'); assert.equal(r.budgetTargetYen,1000); assert.equal(r.budget.actualBilled,null);
  assert.ok(!JSON.stringify(r).includes('ACCESS_TOKEN'));
});
test('full offline day targets 14 posts, five products and two daily themes',async t=>{
  const result=await main('demo',temp(t),NOW);
  assert.equal(result.mockOnly,true);
  assert.equal(result.posts.filter(p=>p.state==='dry_run').reduce((n,p)=>n+p.count,0),14);
  assert.equal(result.searchCalls,1); assert.equal(result.visionCalls,7);
  assert.equal(result.budget.committed,0);
});
