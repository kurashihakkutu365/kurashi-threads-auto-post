import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRemote,decryptBackup } from '../src/remote-maintenance.js';
import { main } from '../src/cli.js';

const key=Buffer.alloc(32,7).toString('base64');
const setup=t=>{const path=join(mkdtempSync(join(tmpdir(),'kurashi-backup-')),'backup.json');t.after(()=>rmSync(join(path,'..'),{force:true,recursive:true}));return path;};
test('remote backup requires encryption key before reading any private records',async t=>{
  const path=setup(t);
  await assert.rejects(()=>backupRemote({export:async()=>assert.fail('must not export')},path,''),/backup_key_missing/);
});
test('AES-256-GCM backup round-trips without publishing rights or PII in plaintext',async t=>{
  const path=setup(t),snapshot={schemaVersion:1,tables:{products:[],images:[{evidence:'private-evidence'}],events:[{text:'private-comment'}]}};
  const result=await backupRemote({export:async()=>snapshot},path,key);
  assert.equal(result.schemaVersion,1);assert.equal(result.sha256.length,64);
  const stored=readFileSync(path,'utf8');assert.ok(!stored.includes('private-comment'));assert.ok(!stored.includes('private-evidence'));
  assert.deepEqual(decryptBackup(path,key),snapshot);
});
test('wrong key or tampered ciphertext cannot be restored',async t=>{
  const path=setup(t);await backupRemote({export:async()=>({schemaVersion:1,tables:{}})},path,key);
  assert.throws(()=>decryptBackup(path,Buffer.alloc(32,8).toString('base64')),/backup_integrity_failed/);
  const e=JSON.parse(readFileSync(path,'utf8'));e.data='AQ==';writeFileSync(path,JSON.stringify(e));
  assert.throws(()=>decryptBackup(path,key),/backup_integrity_failed/);
});
test('connection check uses only health RPC and outputs no credential or data',async t=>{
  const dir=join(setup(t),'..'),calls=[];
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_synthetic'};
  const result=await main('db-check',dir,new Date(),{env,fetchImpl:async(url,o)=>{
    calls.push(JSON.parse(o.body));return new Response(JSON.stringify({schemaVersion:1}));
  }});
  assert.deepEqual(result,{connected:true,schemaVersion:1,storageBackend:'supabase',dryRun:true});
  assert.deepEqual(calls,[{action:'health',args:{}}]);assert.ok(!JSON.stringify(result).includes('sb_secret'));
});
test('missing project settings fail closed without attempting HTTP',async t=>{
  await assert.rejects(()=>main('db-check',join(setup(t),'..'),new Date(),{env:{},fetchImpl:async()=>assert.fail('must not request')}),/supabase_config_missing/);
});
test('blank modern key can fall back to the configured legacy service role JWT',async t=>{
  const roleKey=`x.${Buffer.from('{"role":"service_role"}').toString('base64url')}.x`;
  const result=await main('db-check',join(setup(t),'..'),new Date(),{env:{SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:roleKey},fetchImpl:async(u,o)=>{
    assert.equal(o.headers.Authorization,`Bearer ${roleKey}`);return new Response('{"schemaVersion":1}');
  }});
  assert.equal(result.connected,true);
});
