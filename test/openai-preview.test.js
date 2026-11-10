import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Budget } from '../src/budget.js';
import { loadConfig } from '../src/config.js';
import { OpenAIClient } from '../src/ai.js';
import { runOpenAIPreview } from '../src/openai-preview.js';
import { previewConfig,assertPreviewPolicy,PREVIEW_POLICY } from '../src/preview-policy.js';
import { dailyBatch,DAILY_SCHEMA } from '../src/daily.js';
import { main } from '../src/cli.js';

const env={OPENAI_PREVIEW_APPROVED:'true',OPENAI_API_KEY:'synthetic-private-key'};
const base=()=>loadConfig(undefined,{});
const output=()=>({status:'completed',usage:{input_tokens:1200,output_tokens:500},output:[{content:[{type:'output_text',text:JSON.stringify({themes:dailyBatch('2026-11-10')})}]}]});
function setup(t) {
  // Synthetic provider tests stay deterministic; runtime still uses the real pricing-review date.
  t.mock.method(Date,'now',()=>Date.parse(PREVIEW_POLICY.verifiedAt)+1000);
  const db=new Store();t.after(()=>db.close());const config=base();
  const store={kind:'supabase',health:async()=>({schemaVersion:1,scheduleVersion:2}),
    reserve:async(request,limits,now)=>new Budget(db,{...config,...limits}).reserve(request,now),
    settle:async(...args)=>new Budget(db,config).settle(...args),totals:async now=>new Budget(db,config).totals(now),setting:(...args)=>db.setting(...args)};
  return {db,store,config};
}

test('preview configuration preserves production/paid switches, bounds cost, and never raises lower budgets',()=>{
  const b=base(),original=structuredClone(b),c=previewConfig(b);assert.deepEqual(b,original);
  assert.equal(c.dryRun,true);assert.equal(c.paidAiEnabled,false);assert.equal(c.production.enabled,false);assert.equal(c.production.hardBillingLimitVerified,false);
  assert.equal(c.pricing.model,PREVIEW_POLICY.model);assert.equal(c.maxAiCallsPerDay,1);
  assert.equal(previewConfig({...b,monthlyBudgetYen:100,textBudgetYen:10}).monthlyBudgetYen,100);
  assert.equal(previewConfig({...b,monthlyBudgetYen:100,textBudgetYen:10}).textBudgetYen,10);
});
test('approval, secret, stop flags and fixed policy are verified before a request',()=>{
  const c=previewConfig(base());
  assert.throws(()=>assertPreviewPolicy(c,{}),/confirmation_required/);
  assert.throws(()=>assertPreviewPolicy(c,{...env,OPENAI_API_KEY:''}),/key_missing_or_invalid/);
  assert.throws(()=>assertPreviewPolicy(c,{...env,OPENAI_API_KEY:'a\nb'}),/key_missing_or_invalid/);
  for(const patch of [{dryRun:false},{paidAiEnabled:true},{production:{enabled:true}},{emergencyStop:true},{termsStop:true}])assert.throws(()=>assertPreviewPolicy({...c,...patch},env),/preview_stopped/);
  for(const mutate of [q=>q.pricing.model='other',q=>q.aiLimits.maxOutputTokens=2000,q=>q.usdJpy=100,q=>q.maxAiCallsPerDay=20,q=>q.monthlyBudgetYen=1001]){const q=structuredClone(c);mutate(q);assert.throws(()=>assertPreviewPolicy(q,env),/policy_invalid/);}
});
test('one real-shaped request generates three validated examples, reserves first, and never includes secrets in prompt/result',async t=>{
  const {db,store,config}=setup(t);let calls=0;
  const result=await runOpenAIPreview(store,config,{env,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,`Bearer ${env.OPENAI_API_KEY}`);assert.equal(options.redirect,'error');
    assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'reserved');
    const b=JSON.parse(options.body);assert.equal(b.store,false);assert.equal(b.model,PREVIEW_POLICY.model);assert.deepEqual(b.reasoning,{effort:'none'});assert.equal(b.service_tier,'default');assert.equal(b.max_output_tokens,1200);assert.equal(b.tools,undefined);assert.ok(b.input[0].content.every(c=>c.type==='input_text'));assert.ok(!options.body.includes(env.OPENAI_API_KEY));
    return new Response(JSON.stringify(output()));
  }});
  assert.equal(calls,1);assert.equal(result.themes.length,3);assert.equal(result.published,false);assert.equal(result.creditsConsumed,true);assert.ok(Math.abs(result.reservedEstimateYen-2.28)<1e-9);assert.ok(Math.abs(result.estimatedMaximumUsd-0.0114)<1e-9);
  assert.ok(!JSON.stringify(result).includes(env.OPENAI_API_KEY));assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'settled');assert.equal(config.paidAiEnabled,false);
});
test('separate preview invocations share a persistent per-day limit and make no second OpenAI call',async t=>{
  const {store,config}=setup(t);let calls=0;const options={env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(output()));}};
  await runOpenAIPreview(store,config,options);
  await assert.rejects(()=>runOpenAIPreview(store,config,options),/daily_ai_limit/);assert.equal(calls,1);
});
test('concurrent preview requests reserve once before any billable calls',async t=>{
  const {store,config}=setup(t);let calls=0;
  const results=await Promise.allSettled([1,2,3].map(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(output()));}})));
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('network failure holds the reservation, never retries, and blocks a rerun',async t=>{
  const {db,store,config}=setup(t);let calls=0;const options={env,fetchImpl:async()=>{calls++;throw new Error(env.OPENAI_API_KEY);}};
  await assert.rejects(()=>runOpenAIPreview(store,config,options),/^Error: ambiguous_send$/);assert.equal(calls,1);assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'reserved');
  await assert.rejects(()=>runOpenAIPreview(store,config,options),/daily_ai_limit/);assert.equal(calls,1);
});
test('401 and 429 return fixed errors and do not disclose provider messages',async t=>{
  for(const [status,reason] of [[401,'token_expired'],[429,'rate_limited']]){
    const {store,config}=setup(t);let calls=0;
    await assert.rejects(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{message:env.OPENAI_API_KEY}}),{status});}}),new RegExp(`^Error: ${reason}$`));assert.equal(calls,1);
  }
});
test('rejected output is billed once and is not regenerated automatically',async t=>{
  const {db,store,config}=setup(t);let calls=0;
  await assert.rejects(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>{calls++;const o=output();o.output[0].content[0].text='{"themes":[]}';return new Response(JSON.stringify(o));}}),/ai_schema_invalid/);
  assert.equal(calls,1);assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'settled');
});
test('production client remains disabled even with preview approval env, and preview cannot call vision or arbitrary schemas',async t=>{
  const {store}=setup(t),config=previewConfig(base()),fetchImpl=async()=>assert.fail('must not request');
  await assert.rejects(()=>new OpenAIClient(store,config,{env,fetchImpl}).daily(),/paid_ai_disabled/);
  const preview=new OpenAIClient(store,config,{env,fetchImpl,oneShotPreview:true});
  await assert.rejects(()=>preview.structured({schema:DAILY_SCHEMA,prompt:'x',images:[{}]}),/preview_text_only/);
  await assert.rejects(()=>preview.structured({schema:{},prompt:'x'}),/preview_text_only/);
});
test('CLI requires explicit approval and persistent storage before network or state creation',async()=>{
  const fetchImpl=async()=>assert.fail('must not request');
  await assert.rejects(()=>main('openai-preview','/tmp/must-not-exist',new Date(),{env:{},fetchImpl}),/confirmation_required/);
  await assert.rejects(()=>main('openai-preview','/tmp/must-not-exist',new Date(),{env,fetchImpl}),/requires_supabase/);
});
test('health and emergency-stop failures block paid requests',async t=>{
  const {store,db,config}=setup(t),options={env,fetchImpl:async()=>assert.fail('must not request')};
  await assert.rejects(()=>runOpenAIPreview({...store,health:async()=>({schemaVersion:1})},config,options),/supabase_schedule_update_required/);
  await assert.rejects(()=>runOpenAIPreview({...store,kind:'sqlite'},config,options),/requires_supabase/);
  db.setting('emergencyStop',true);await assert.rejects(()=>runOpenAIPreview(store,config,options),/all_stopped/);
});
test('a preview client cannot make a second call or send an overlong prompt',async t=>{
  const {store}=setup(t),config=previewConfig(base());let calls=0;
  const client=new OpenAIClient(store,config,{env,oneShotPreview:true,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(output()));}});
  await client.daily();await assert.rejects(()=>client.daily(),/already_attempted/);assert.equal(calls,1);
  const oversized=new OpenAIClient(store,config,{env,oneShotPreview:true,fetchImpl:async()=>assert.fail('must not request')});
  await assert.rejects(()=>oversized.structured({schema:DAILY_SCHEMA,prompt:'x'.repeat(8001)}),/ai_input_bound/);
});
test('provider usage above the reserved bound is recorded and activates emergency stop',async t=>{
  const {db,store,config}=setup(t);
  await assert.rejects(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>{const o=output();o.usage.input_tokens=8001;return new Response(JSON.stringify(o));}}),/ai_usage_bound_exceeded/);
  assert.equal(db.setting('emergencyStop'),true);assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'settled');
});
test('missing provider usage retains the reservation and never claims success',async t=>{
  const {db,store,config}=setup(t);
  await assert.rejects(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>{const o=output();delete o.usage;return new Response(JSON.stringify(o));}}),/ai_usage_unknown/);
  assert.equal(db.db.prepare('SELECT state FROM usage').get().state,'reserved');
});
test('pricing review older than 31 days stops before any billable request',async t=>{
  const {store,config}=setup(t);t.mock.method(Date,'now',()=>Date.parse(PREVIEW_POLICY.verifiedAt)+32*86400000);
  await assert.rejects(()=>runOpenAIPreview(store,config,{env,fetchImpl:async()=>assert.fail('must not request')}),/pricing_unverified/);
});
