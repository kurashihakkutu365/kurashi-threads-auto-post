import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../src/supabase-store.js';
import { SupabaseBudget } from '../src/supabase-budget.js';
import { loadConfig } from '../src/config.js';

const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const opts=fetchImpl=>({url:'https://unit.supabase.co',key:'sb_secret_synthetic_test',fetchImpl});
test('Supabase accepts server secret keys but never forwards them as invalid Bearer JWTs',async()=>{
  let headers,url;
  const s=new SupabaseStore(opts(async(u,o)=>{url=u;headers=o.headers;return response({schemaVersion:1});}));
  assert.equal((await s.health()).schemaVersion,1);
  assert.equal(headers.apikey,'sb_secret_synthetic_test'); assert.equal(headers.Authorization,undefined);
  assert.equal(url,'https://unit.supabase.co/rest/v1/rpc/kurashi_store_v1');
});
test('Supabase legacy service role JWT uses the server API authentication convention',async()=>{
  const key=`x.${Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')}.x`;
  const s=new SupabaseStore({...opts(async(u,o)=>{assert.equal(o.headers.Authorization,`Bearer ${key}`);return response(true);}),key});
  await s.health();
});
test('Supabase rejects public keys, arbitrary hosts and insecure URLs before any request',()=>{
  const fetchImpl=async()=>assert.fail('must not request');
  for(const url of ['http://unit.supabase.co','https://example.com','https://unit.supabase.co.evil.com','https://u:p@unit.supabase.co','https://unit.supabase.co/path']) assert.throws(()=>new SupabaseStore({...opts(fetchImpl),url}));
  for(const key of ['', 'sb_publishable_test','not-a-jwt',`x.${Buffer.from('{"role":"anon"}').toString('base64url')}.x`]) assert.throws(()=>new SupabaseStore({...opts(fetchImpl),key}));
});
test('ambiguous Supabase mutation is never retried',async()=>{
  let calls=0;
  const s=new SupabaseStore(opts(async()=>{calls++;throw new Error('timeout with secret');}));
  await assert.rejects(()=>s.setting('emergencyStop',true),/^Error: supabase_result_unknown$/);
  assert.equal(calls,1);
});
test('provider errors cannot leak keys, SQL or response details',async()=>{
  const s=new SupabaseStore(opts(async()=>response({message:'token=private SQL sensitive'},500)));
  await assert.rejects(()=>s.health(),/^Error: supabase_unavailable$/);
});
test('known reservation failure propagates only the fixed reason',async()=>{
  const s=new SupabaseStore(opts(async()=>response({message:'monthly_budget',details:'private'},400)));
  await assert.rejects(()=>s.health(),/^Error: monthly_budget$/);
});
test('daily quota and product deduplication are one server-side claim request',async()=>{
  const calls=[];
  const s=new SupabaseStore(opts(async(u,o)=>{calls.push(JSON.parse(o.body));return response(true);}));
  assert.equal(await s.claim({id:'2026-11-07/07:00'},'threads',null,new Date('2026-11-06T22:00:00Z'),loadConfig(undefined,{})),true);
  assert.equal(calls.length,1); assert.equal(calls[0].action,'claim');
  assert.deepEqual(calls[0].args.config,{duplicateDays:30,dailyPostLimit:7});
});
test('remote budget delegates reservation without a read-then-write race',async()=>{
  const c=loadConfig(undefined,{}),calls=[];
  const store=new SupabaseStore(opts(async(u,o)=>{calls.push(JSON.parse(o.body));return response('reservation-id');}));
  assert.equal(await new SupabaseBudget(store,c).reserve({category:'text',service:'mock',maximumYen:1}),'reservation-id');
  assert.equal(calls.length,1);assert.equal(calls[0].action,'reserve');
  assert.equal(calls[0].args.config.monthlyBudgetYen,1000);
});
