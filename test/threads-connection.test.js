import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkThreadsConnection } from '../src/threads-connection.js';
import { loadConfig } from '../src/config.js';
import { main } from '../src/cli.js';

const config=()=>loadConfig(undefined,{});
const env={THREADS_ACCESS_TOKEN:'synthetic-token-private',THREADS_EXPECTED_USERNAME:'kurashi_hakkutsu365'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const profile={id:'123456789',username:'kurashi_hakkutsu365'};

test('Threads check makes one GET /me request and returns only safe account fields',async()=>{
  const calls=[];
  const result=await checkThreadsConnection(config(),{env,fetchImpl:async(url,options)=>{
    calls.push({url,...options});return response({...profile,access_token:env.THREADS_ACCESS_TOKEN,biography:'private extra field'});
  }});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].url,'https://graph.threads.com/v1.0/me?fields=id,username');
  assert.equal(calls[0].headers.Authorization,`Bearer ${env.THREADS_ACCESS_TOKEN}`);
  assert.equal(calls[0].redirect,'error');assert.equal(calls[0].cache,'no-store');
  assert.ok(!calls[0].url.includes(env.THREADS_ACCESS_TOKEN));
  assert.deepEqual(result,{connected:true,platform:'threads',username:profile.username,userId:profile.id,dryRun:true,publishingTested:false,replyPermissionsVerified:false,tokenExpiryVerified:false});
  assert.ok(!JSON.stringify(result).includes(env.THREADS_ACCESS_TOKEN));assert.ok(!JSON.stringify(result).includes('private extra field'));
});
test('missing credentials or expected username stop before network access',async()=>{
  const fetchImpl=async()=>assert.fail('must not request');
  await assert.rejects(()=>checkThreadsConnection(config(),{env:{},fetchImpl}),/threads_token_missing/);
  await assert.rejects(()=>checkThreadsConnection(config(),{env:{THREADS_ACCESS_TOKEN:env.THREADS_ACCESS_TOKEN},fetchImpl}),/threads_expected_username_required/);
});
test('diagnostic path respects emergency/terms/platform stops and requires DRY_RUN',async()=>{
  for(const change of [{emergencyStop:true},{termsStop:true},{platforms:{threads:false}},{dryRun:false}]) {
    await assert.rejects(()=>checkThreadsConnection({...config(),...change},{env,fetchImpl:async()=>assert.fail('must not request')}),/threads_check_/);
  }
});
test('malformed tokens and invalid API versions are never sent',async()=>{
  const fetchImpl=async()=>assert.fail('must not request');
  await assert.rejects(()=>checkThreadsConnection(config(),{env:{...env,THREADS_ACCESS_TOKEN:'part1\npart2'},fetchImpl}),/threads_token_format_invalid/);
  await assert.rejects(()=>checkThreadsConnection({...config(),api:{threadsVersion:'../../evil'}},{env,fetchImpl}),/threads_api_version_invalid/);
});
test('connection check rejects a token for another username without printing the other identity',async()=>{
  await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>response({id:'123',username:'other_user'})}),/^Error: threads_account_mismatch$/);
});
test('an already configured Threads user ID must also match',async()=>{
  await assert.rejects(()=>checkThreadsConnection(config(),{env:{...env,THREADS_USER_ID:'555'},fetchImpl:async()=>response(profile)}),/threads_account_mismatch/);
});
test('Meta HTTP 400 OAuth error 190 produces a fixed expired-token reason',async()=>{
  await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>response({error:{code:190,message:`secret=${env.THREADS_ACCESS_TOKEN}`}},400)}),/^Error: threads_token_invalid_or_expired$/);
});
for(const [status,code] of [[401,'threads_token_invalid_or_expired'],[403,'threads_basic_permission_required'],[429,'threads_rate_limited']]) {
  test(`HTTP ${status} stops safely without retries or token disclosure`,async()=>{
    let calls=0;
    await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>{calls++;return response({message:env.THREADS_ACCESS_TOKEN},status);}}),new RegExp(`^Error: ${code}$`));
    assert.equal(calls,1);
  });
}
test('network exceptions and provider messages are never echoed',async()=>{
  await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>{throw new Error(`fetch failed with ${env.THREADS_ACCESS_TOKEN}`);}}),/^Error: threads_connection_failed$/);
  await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>response({error:{message:env.THREADS_ACCESS_TOKEN}},500)}),/^Error: threads_api_error$/);
});
test('malformed JSON, missing identity and injected identifiers do not count as connected',async()=>{
  for(const value of [null,{}, {id:123,username:profile.username},{...profile,id:'123\nSECRET'},{...profile,username:'bad\nname'}]) {
    await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>response(value)}),/threads_response_invalid/);
  }
  await assert.rejects(()=>checkThreadsConnection(config(),{env,fetchImpl:async()=>new Response('<html>error</html>')}),/threads_response_invalid/);
});
test('read-only CLI works without Supabase secrets and never creates a DB or output directory',async t=>{
  const root=mkdtempSync(join(tmpdir(),'kurashi-threads-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'must-not-exist');
  const result=await main('threads-check',path,new Date(),{env:{...env,STORAGE_BACKEND:'supabase'},fetchImpl:async()=>response(profile)});
  assert.equal(result.connected,true);assert.equal(existsSync(path),false);
});
