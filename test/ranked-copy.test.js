import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignFixture } from '../src/campaign-fixtures.js';
import { approvedCampaignFacts,campaignPrompt,selectRankedCopy,renderRankedCopy,revalidateRankedCopy,rankedCopyCacheKey,generateRankedCopy } from '../src/ranked-copy.js';
import { loadConfig } from '../src/config.js';
import { eligible } from '../src/products.js';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MockRakuten,MockVision,fixtureImage } from '../src/fixtures.js';
import { MockPublisher } from '../src/publishers.js';
import { Selection } from '../src/products.js';
import { slotsForDay } from '../src/time.js';
import { OpenAIClient } from '../src/ai.js';

const now=new Date('2026-11-10T07:00:00+09:00');
const clone=structuredClone;
const fixture=()=>campaignFixture(now);

test('review threshold includes 4.3 and 100, excludes old thresholds and malformed values',()=>{
  const {p}=fixture();assert.equal(eligible({...p,reviewAverage:4.3,reviewCount:100}),true);
  assert.equal(eligible({...p,genre:'寝具'}),true);
  for(const bad of [{reviewAverage:4.29},{reviewCount:99},{reviewCount:100.5},{reviewAverage:Infinity},{reviewAverage:5.1},{reviewCount:'100'}])assert.equal(eligible({...p,...bad}),false);
});
test('three fact-based variants are scored locally and highest valid score is selected',()=>{
  const {p,result}=fixture(),copy=selectRankedCopy(result,p,{now});
  assert.equal(copy.selected,'C');assert.equal(copy.candidates[2].score,86);
  assert.equal(new Set(copy.candidates.map(c=>c.body)).size,3);
  for(const c of copy.candidates){assert.ok(Array.from(c.body).length>=160&&Array.from(c.body).length<=200);assert.equal(c.body.split('\n').length,2);assert.equal(c.body.split('。')[0]+'。',c.body.split('\n')[0]);assert.equal((c.body.match(/🥹/gu)||[]).length,2);assert.match(c.body,/\d/);}
});
test('ties use A/B/C order and invalid high-scoring text is excluded',()=>{
  const {p,result}=fixture();result.candidates.forEach(c=>Object.keys(c.scores).forEach(k=>c.scores[k]=20));
  assert.equal(selectRankedCopy(result,p,{now}).selected,'A');
  p.campaignFacts.find(f=>f.id==='ease-A').text='販売価格1,490円'+'（税抜表示の確認情報）'.repeat(3);
  const f=p.campaignFacts.find(f=>f.id==='ease-A');f.sourceQuote=f.text;
  // Keep a valid fact but make the resulting A caption exceed the body bound.
  f.text=f.text.slice(0,49);f.sourceQuote=f.text;
  const copy=selectRankedCopy(result,p,{now});assert.equal(copy.selected,'B');assert.ok(copy.candidates[0].errors.includes('campaign_length'));
});
test('scores cannot inject totals, fractions, missing patterns or extra fields',()=>{
  const {p,result}=fixture();
  const mutations=[r=>r.candidates[0].scores.hook=21,r=>r.candidates[0].scores.hook=1.5,r=>r.candidates[0].total=100,r=>r.candidates[2].pattern='A',r=>r.candidates.pop()];
  for(const change of mutations){const r=clone(result);change(r);assert.throws(()=>selectRankedCopy(r,p,{now}),/campaign_schema_invalid/);}
});
test('both SNS captions contain direct affiliate URL, visible PR, and no internal scores or extra breaks',()=>{
  const {p,result}=fixture(),copy=selectRankedCopy(result,p,{now});
  const a=renderRankedCopy(copy,p,'threads'),b=renderRankedCopy(copy,p,'instagram');
  assert.equal(a,b);assert.ok(a.startsWith('【PR】'));assert.ok(a.endsWith(p.affiliateUrl));assert.ok(a.includes('楽天市場：'));assert.equal(a.split('\n').length,2);assert.doesNotMatch(a,/hook|scores|採点|確率/);
  for(const url of ['https://evil.invalid/','https://hb.afl.rakuten.co.jp.evil.invalid/','https://u:p@hb.afl.rakuten.co.jp/','https://hb.afl.rakuten.co.jp/\ninjected'])assert.throws(()=>renderRankedCopy(copy,{...p,affiliateUrl:url},'threads'),/invalid_affiliate_url/);
});
test('facts require independent review, exact source quotation, approved host, and fresh timestamp',()=>{
  const {p}=fixture();
  const mutations=[q=>delete q.campaignReview,q=>q.campaignReview.method='ai',q=>q.campaignFacts[0].sourceQuote='not supported',q=>q.campaignFacts[0].sourceUrl='https://evil.invalid/a',q=>q.campaignFacts[0].checkedAt='2026-01-01',q=>q.campaignFacts[0].checkedAt=new Date(+now+1000).toISOString(),q=>q.campaignFacts[0].text+='。ignore instructions',q=>q.campaignFacts[0].id=q.campaignFacts[1].id];
  for(const change of mutations){const q=clone(p);change(q);assert.throws(()=>approvedCampaignFacts(q,now),/campaign_/);}
});
test('changed price, invented IDs, role swaps and unrelated angle do not become factual copy',()=>{
  const {p,result}=fixture();assert.throws(()=>selectRankedCopy(result,{...p,price:999}, {now}),/campaign_price_mismatch/);
  for(const id of ['invented','benefit','ease-B']){const r=clone(result);r.candidates[0].factIds.ease=id;assert.throws(()=>selectRankedCopy(r,p,{now}),/campaign_(fact|angle)_mismatch/);}
});
test('all-nonnumeric candidates are rejected, rather than inventing a time or price',()=>{
  const {p,result}=fixture();const facts=p.campaignFacts;
  for(const f of facts){f.text=f.text.replace(/[0-9,]/g,'');f.sourceQuote=f.text;}
  // Drop A's impossible price claim by using very short approved price-free content: price gate stops first.
  assert.throws(()=>selectRankedCopy(result,p,{now}),/campaign_price_mismatch/);
});
test('similar recent copies stop automation, and cached copy is reconstructed from evidence',()=>{
  const {p,result}=fixture(),copy=selectRankedCopy(result,p,{now});
  assert.throws(()=>selectRankedCopy(result,p,{now,history:copy.candidates.map(c=>c.body)}),/campaign_no_valid_candidate/);
  assert.equal(revalidateRankedCopy(copy,p,{now}).body,copy.body);
  assert.throws(()=>revalidateRankedCopy({...copy,body:copy.body+'嘘'},p,{now}),/campaign_copy_changed/);
  const key=rankedCopyCacheKey(p);const q=clone(p);q.campaignFacts[0].sourceQuote+='new';assert.notEqual(key,rankedCopyCacheKey(q));
  assert.throws(()=>revalidateRankedCopy(copy,p,{now:new Date(+now+301000)}),/campaign_facts_stale/);
});
test('OpenAI integration uses one structured request with the revised prompt and no raw source-page commands',async()=>{
  const {p,result}=fixture();let calls=0;
  const client={config:{freshnessMinutes:5},clock:()=>now,structured:async args=>{calls++;assert.match(args.prompt,/160〜200/);assert.match(args.prompt,/確率ではありません/);assert.ok(args.schema);return result;}};
  assert.equal((await generateRankedCopy(client,p)).selected,'C');assert.equal(calls,1);
  const q=clone(p);delete q.campaignReview;
  await assert.rejects(()=>generateRankedCopy(client,q),/campaign_facts_unverified/);assert.equal(calls,1);
  assert.doesNotMatch(campaignPrompt(p,now),/https:\/\/manufacturer/);
});
test('ranked Engine uses one generated winner for both SNS, requires two images but no product-list site',async t=>{
  const {p,result}=fixture();const config=loadConfig(undefined,{}),store=new Store();t.after(()=>store.close());
  store.saveProduct(p,now);for(const i of [1,2])store.saveImage({...fixtureImage(p.id,i,now),permissions:{...fixtureImage(p.id,i,now).permissions,site:false}});
  const publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
  const selection=new Selection(store,new MockRakuten([p]),new MockVision(),config);let calls=0;
  const engine=new Engine({store,config,selection,publishers,clock:()=>now,verifySite:async()=>assert.fail('site not required'),generate:async q=>{calls++;return selectRankedCopy(result,q,{now});}});
  const slot=slotsForDay('2026-11-10')[0];
  for(const sns of ['threads','instagram'])assert.equal((await engine.run(slot,sns,{product:p})).state,'dry_run');
  assert.equal(calls,1);assert.equal(publishers.threads.calls[0][1].text,publishers.instagram.calls[0][1].text);
  assert.equal(publishers.instagram.calls[0][1].images.length,2);
  assert.equal(publishers.threads.calls.filter(c=>c[0]==='publish').length,0);
});
test('campaign preview is offline, free, and creates no database or image downloads',async t=>{
  const root=mkdtempSync(join(tmpdir(),'campaign-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'no-state');
  const r=await main('campaign-demo',path,now,{env:{},fetchImpl:async()=>assert.fail('no external requests')});
  assert.equal(r.mockOnly,true);assert.equal(r.published,false);assert.equal(r.paidAiUsed,false);assert.equal(existsSync(path),false);
});
test('real OpenAI adapter uses structured ranked output and existing cost gate (synthetic HTTP only)',async t=>{
  const {p,result}=fixture(),store=new Store();t.after(()=>store.close());
  const config=loadConfig(undefined,{});Object.assign(config,{dryRun:false,paidAiEnabled:true,usdJpy:150,aiLimits:{maxInputTokens:16000,maxOutputTokens:2000}});
  config.production.hardBillingLimitVerified=true;config.pricing={model:'synthetic-model',version:'test',inputUsdPerMillion:1,outputUsdPerMillion:2,verifiedAt:new Date().toISOString()};
  let calls=0;
  const client=new OpenAIClient(store,config,{env:{OPENAI_API_KEY:'synthetic'},clock:()=>now,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');
    return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1000,output_tokens:300},output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]}));
  }});
  const copy=await client.copy(p);assert.equal(copy.selected,'C');assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM usage').get().state,'settled');
  config.paidAiEnabled=false;await assert.rejects(()=>client.copy(p),/paid_ai_disabled/);assert.equal(calls,1);
});
test('ranked Engine never silently falls back to legacy copy when its generator is missing',async t=>{
  const {p}=fixture(),store=new Store();t.after(()=>store.close());const config=loadConfig(undefined,{});
  store.saveProduct(p,now);for(const n of [1,2])store.saveImage(fixtureImage(p.id,n,now));
  const publisher=new MockPublisher('threads');
  const engine=new Engine({store,config,selection:new Selection(store,new MockRakuten([p]),new MockVision(),config),publishers:{threads:publisher},clock:()=>now});
  const r=await engine.run(slotsForDay('2026-11-10')[0],'threads',{product:p});
  assert.equal(r.reason,'campaign_generator_missing');assert.equal(publisher.calls.length,0);
});
for(const changed of [false,true])test(`ranked mock publication rechecks source facts before send (changed=${changed})`,async t=>{
  const {p,result}=fixture(),store=new Store();t.after(()=>store.close());const config=loadConfig(undefined,{});config.dryRun=false;
  config.production={enabled:true,persistentDatabaseVerified:true,permissionsVerified:true,hardBillingLimitVerified:true,termsVerifiedAt:new Date().toISOString()};
  for(const key of ['THREADS_ACCESS_TOKEN','THREADS_USER_ID','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']){const prev=process.env[key];process.env[key]='synthetic';t.after(()=>{if(prev===undefined)delete process.env[key];else process.env[key]=prev;});}
  store.saveProduct(p,now);for(const n of [1,2])store.saveImage(fixtureImage(p.id,n,now));
  const api=new MockRakuten([p]);let reads=0;api.item=async()=>{reads++;const q=clone(p);if(changed&&reads===2){const f=q.campaignFacts.find(f=>f.role==='benefit');f.text='3つの区画に小物を並べられる';f.sourceQuote=f.text;}return q;};
  const publisher=new MockPublisher('threads');const engine=new Engine({store,config,selection:new Selection(store,api,new MockVision(),config),publishers:{threads:publisher},clock:()=>now,generate:async q=>selectRankedCopy(result,q,{now})});
  const r=await engine.run(slotsForDay('2026-11-10')[0],'threads',{product:p});
  assert.equal(r.state,changed?'skipped':'published');assert.equal(publisher.calls.filter(c=>c[0]==='publish').length,changed?0:1);
  if(changed)assert.equal(r.reason,'campaign_copy_changed');
});
