import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInstagramConnection } from '../src/instagram-connection.js';
import { instagramApiBase } from '../src/instagram-api.js';
import { loadConfig } from '../src/config.js';
import { main } from '../src/cli.js';

const config=()=>loadConfig(undefined,{});
const env={INSTAGRAM_ACCESS_TOKEN:'synthetic-private-token',INSTAGRAM_EXPECTED_USERNAME:'kurashi__365'};
const profile={id:'17841423374861770',username:'kurashi__365'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const run=(fetchImpl,extra={})=>checkInstagramConnection(config(),{env:{...env,...extra},fetchImpl});

test('Unified Login discovers assigned Instagram assets, verifies identity, and returns safe fields only',async()=>{
  const calls=[];
  const result=await run(async(url,options)=>{
    calls.push({url,...options});
    return response(calls.length===1?{data:[{id:'999',username:'other'},profile]}:{...profile,access_token:env.INSTAGRAM_ACCESS_TOKEN});
  });
  assert.deepEqual(calls.map(c=>c.url),[
    'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id%2Cusername',
    `https://graph.facebook.com/v27.0/${profile.id}?fields=id%2Cusername`
  ]);
  for(const c of calls){assert.equal(c.method,'GET');assert.equal(c.headers.Authorization,`Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`);assert.equal(c.redirect,'error');assert.equal(c.cache,'no-store');assert.ok(!c.url.includes(env.INSTAGRAM_ACCESS_TOKEN));}
  assert.deepEqual(result,{connected:true,platform:'instagram',loginMode:'unified',username:profile.username,userId:profile.id,dryRun:true,publishingTested:false,replyPermissionsVerified:false,tokenExpiryVerified:false});
});
test('configured account ID bypasses discovery but still verifies the expected username',async()=>{
  let calls=0;
  await run(async url=>{calls++;assert.equal(new URL(url).pathname,`/v27.0/${profile.id}`);return response(profile);},{INSTAGRAM_USER_ID:profile.id,INSTAGRAM_EXPECTED_USERNAME:'@KURASHI__365'});
  assert.equal(calls,1);
  for(const p of [{...profile,id:'555'},{...profile,username:'other'}]) await assert.rejects(()=>run(async()=>response(p),{INSTAGRAM_USER_ID:profile.id}),/instagram_account_mismatch/);
});
test('credentials, target username, API mode and stops are checked before any request',async()=>{
  const fetchImpl=async()=>assert.fail('must not request');
  for(const [extra,reason] of [[{INSTAGRAM_ACCESS_TOKEN:''},'token_missing'],[{INSTAGRAM_ACCESS_TOKEN:'a\nb'},'token_format_invalid'],[{INSTAGRAM_EXPECTED_USERNAME:''},'expected_username_required'],[{INSTAGRAM_USER_ID:'../me'},'user_id_invalid']])
    await assert.rejects(()=>run(fetchImpl,extra),new RegExp(`instagram_${reason}`));
  for(const change of [{dryRun:false},{emergencyStop:true},{termsStop:true},{platforms:{instagram:false}},{api:{instagramLoginMode:'instagram'}}])
    await assert.rejects(()=>checkInstagramConnection({...config(),...change},{env,fetchImpl}),/instagram_check_/);
});
test('another assigned account is never silently selected, and duplicate matching handles are rejected',async()=>{
  await assert.rejects(()=>run(async()=>response({data:[{id:'123',username:'other'}]})),/instagram_account_not_found/);
  await assert.rejects(()=>run(async()=>response({data:[profile,profile]})),/instagram_account_ambiguous/);
});
test('pagination uses a cursor on the fixed host and never follows a provider URL',async()=>{
  const calls=[];
  await run(async url=>{
    calls.push(url);
    if(calls.length===1)return response({data:[],paging:{next:`https://evil.invalid/?access_token=${env.INSTAGRAM_ACCESS_TOKEN}`,cursors:{after:'cursor+value'}}});
    if(calls.length===2){assert.equal(new URL(url).searchParams.get('after'),'cursor+value');return response({data:[profile]});}
    return response(profile);
  });
  assert.equal(calls.length,3);
  for(const url of calls){assert.equal(new URL(url).hostname,'graph.facebook.com');assert.ok(!url.includes(env.INSTAGRAM_ACCESS_TOKEN));}
});
test('invalid, credential-bearing or repeated cursors fail safely',async()=>{
  for(const after of [undefined,'',env.INSTAGRAM_ACCESS_TOKEN,'line\nbreak','x'.repeat(4097),'repeat'])
    await assert.rejects(()=>run(async()=>response({data:[],paging:{next:'next',cursors:{after}}})),/instagram_pagination_invalid/);
});
test('discovery has a three-page bound',async()=>{
  let calls=0;
  await assert.rejects(()=>run(async()=>response({data:[],paging:{next:'next',cursors:{after:String(++calls)}}})),/instagram_discovery_limit/);
  assert.equal(calls,3);
});
for(const [status,code] of [[401,'token_invalid_or_expired'],[403,'basic_permission_required'],[429,'rate_limited']])test(`HTTP ${status} fails without retry or disclosing provider content`,async()=>{
  let calls=0;
  await assert.rejects(()=>run(async()=>{calls++;return response({error:{message:env.INSTAGRAM_ACCESS_TOKEN}},status);}),new RegExp(`^Error: instagram_${code}$`));
  assert.equal(calls,1);
});
test('OAuth and permission error bodies are mapped to fixed safe errors',async()=>{
  for(const [code,reason] of [[190,'token_invalid_or_expired'],[10,'basic_permission_required'],[200,'basic_permission_required'],[999,'api_error']])
    await assert.rejects(()=>run(async()=>response({error:{code,message:env.INSTAGRAM_ACCESS_TOKEN}},400)),new RegExp(`^Error: instagram_${reason}$`));
});
test('network exceptions and malformed responses never disclose a token',async()=>{
  await assert.rejects(()=>run(async()=>{throw new Error(env.INSTAGRAM_ACCESS_TOKEN);}),/^Error: instagram_connection_failed$/);
  await assert.rejects(()=>run(async()=>new Response('not json')),/^Error: instagram_response_invalid$/);
  for(const value of [null,{}, {data:[{id:123,username:'test'}]},{data:[{id:'123',username:'bad\nname'}]}])
    await assert.rejects(()=>run(async()=>response(value)),/^Error: instagram_response_invalid$/);
  await assert.rejects(()=>run(async()=>response({id:'123'}),{INSTAGRAM_USER_ID:'123'}),/^Error: instagram_response_invalid$/);
});
test('API host selection preserves legacy configs and rejects invalid modes and paths',()=>{
  assert.equal(instagramApiBase(config()),'https://graph.facebook.com/v27.0');
  for(const mode of ['instagram',undefined])assert.equal(instagramApiBase({api:{instagramVersion:'v27.0',instagramLoginMode:mode}}),'https://graph.instagram.com/v27.0');
  for(const api of [{instagramVersion:'../../evil',instagramLoginMode:'unified'},{instagramVersion:'v27.0',instagramLoginMode:'evil'}])assert.throws(()=>instagramApiBase({api}),/instagram_api_config_invalid/);
});
test('read-only CLI requires no Supabase keys and creates no state directory',async t=>{
  const root=mkdtempSync(join(tmpdir(),'kurashi-instagram-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'must-not-exist');
  const result=await main('instagram-check',path,new Date(),{env:{...env,INSTAGRAM_USER_ID:profile.id,STORAGE_BACKEND:'supabase'},fetchImpl:async()=>response(profile)});
  assert.equal(result.connected,true);assert.equal(existsSync(path),false);
});
