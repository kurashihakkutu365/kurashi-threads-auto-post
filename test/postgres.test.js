import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SupabaseStore } from '../src/supabase-store.js';
import { SupabaseBudget } from '../src/supabase-budget.js';
import { fixtureProduct,fixtureImage,MockRakuten,MockVision } from '../src/fixtures.js';
import { slotsForDay } from '../src/time.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Selection } from '../src/products.js';
import { MockPublisher } from '../src/publishers.js';

test('real PostgreSQL Supabase transaction contract',{skip:process.env.KURASHI_PG_TEST!=='1'},async t=>{
  const container=process.env.KURASHI_PG_CONTAINER??'kurashi-pg-test';
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(container)) throw new Error('invalid_test_container');
  const {DOCKER_HOST:a,DOCKER_CONTEXT:b,DOCKER_TLS:c,DOCKER_TLS_VERIFY:d,DOCKER_CERT_PATH:e,NODE_TEST_CONTEXT:f,...env}=process.env;
  const sql=source=>new Promise((resolve,reject)=>{
    const child=spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',container,'psql','-U','postgres','-d','kurashi_test','-qAt','-v','ON_ERROR_STOP=1'],{env});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
    child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));
    child.stdin.end(source);
  });
  // These tests only mutate the explicitly named disposable test DB, never a Supabase URL.
  assert.equal(await sql('SELECT current_database();'),'kurashi_test');
  await sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;");
  const migration=readFileSync(new URL('../supabase/migrations/001_store.sql',import.meta.url),'utf8');
  await sql(migration); await sql(migration);
  const noonMigration=readFileSync(new URL('../supabase/migrations/002_noon_daily.sql',import.meta.url),'utf8');
  await sql(noonMigration);await sql(noonMigration);
  const reset=()=>sql('TRUNCATE public.kurashi_products,public.kurashi_images,public.kurashi_cache,public.kurashi_settings,public.kurashi_posts,public.kurashi_usage,public.kurashi_events,public.kurashi_opt_outs,public.kurashi_logs RESTART IDENTITY;');
  const fetchImpl=async(url,options)=>{
    const {action,args}=JSON.parse(options.body);
    const encoded=Buffer.from(JSON.stringify(args)).toString('base64');
    if(!/^[a-zA-Z]+$/.test(action)) throw new Error('invalid_test_action');
    try {
      const raw=await sql(`SET ROLE service_role; SELECT public.kurashi_store_v1('${action}',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);`);
      return new Response(raw||'null',{status:200});
    } catch(error) {
      const message=error.message.match(/ERROR:\s+([a-z_]+)\s/)[1];
      return new Response(JSON.stringify({message}),{status:400});
    }
  };
  const store=new SupabaseStore({url:'https://test.supabase.co',key:'sb_secret_synthetic',fetchImpl});
  const now=new Date('2026-11-07T07:00:00+09:00'),config=loadConfig(undefined,{}),slot=slotsForDay('2026-11-07')[0];
  await t.test('migration is idempotent; anon and authenticated cannot execute RPC or read tables',async()=>{
    assert.equal((await store.health()).schemaVersion,1);
    for(const role of ['anon','authenticated']) {
      await assert.rejects(()=>sql(`SET ROLE ${role}; SELECT public.kurashi_store_v1('health');`),/permission denied/);
      await assert.rejects(()=>sql(`SET ROLE ${role}; SELECT * FROM public.kurashi_products;`),/permission denied/);
    }
  });
  await t.test('product numbers and rights persist across client instances',async()=>{
    await reset(); const p=fixtureProduct(1,now);
    assert.equal((await store.saveProduct(p,now)).number,1);
    await store.saveImage(fixtureImage(p.id,1,now));
    const another=new SupabaseStore({url:'https://test.supabase.co',key:'sb_secret_synthetic',fetchImpl});
    assert.equal((await another.product(p.id)).number,1);assert.equal((await another.images(p.id)).length,1);
  });
  await t.test('five competing clients obtain a slot only once',async()=>{
    await reset(); const p=fixtureProduct(1,now);
    const results=await Promise.all(Array.from({length:5},()=>store.claim(slot,'threads',p,now,config)));
    assert.equal(results.filter(Boolean).length,1);
  });
  await t.test('cross-slot canonical duplicates are serialized across platforms',async()=>{
    await reset(); const p=fixtureProduct(1,now);
    const second=slotsForDay('2026-11-07')[1];
    const outcomes=await Promise.allSettled([store.claim(slot,'threads',p,now,config),store.claim(second,'instagram',{...p,id:'other:shop'},now,config)]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal(outcomes.find(o=>o.status==='rejected').reason.message,'duplicate_product');
  });
  await t.test('invalid slots and unsafe client-supplied limits are refused by the DB itself',async()=>{
    await reset();
    await assert.rejects(()=>store.claim({...slot,kind:'daily'},'threads',null,now,config),/invalid_slot/);
    await assert.rejects(()=>store.claim(slot,'threads',null,now,{...config,dailyPostLimit:9}),/invalid_store_config/);
    await assert.rejects(()=>store.claim(slot,'threads',null,now,{...config,duplicateDays:1}),/invalid_store_config/);
  });
  await t.test('concurrent cost reservations cannot exceed monthly budget',async()=>{
    await reset(); const budget=new SupabaseBudget(store,config);
    const results=await Promise.allSettled(Array.from({length:4},()=>budget.reserve({category:'other',service:'mock',maximumYen:400},now)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
    assert.equal((await budget.totals(now)).committed,800);
  });
  await t.test('category budgets and 70/85/95/100 percent stages run inside PostgreSQL',async()=>{
    const budget=new SupabaseBudget(store,config);
    for(const [spent,mode] of [[700,'vision_stop'],[850,'essential_only'],[950,'paid_stop'],[1000,'stop']]) {
      await reset();const id=await budget.reserve({category:'other',service:'test',maximumYen:spent},now);
      await budget.settle(id,spent,0);assert.equal(await budget.mode(now),mode);
      await assert.rejects(()=>budget.reserve({category:'vision',service:'test',maximumYen:1},now),/budget_throttled/);
    }
  });
  await t.test('JST midnight opens a new budget month and actual bills affect stop decisions',async()=>{
    await reset();const budget=new SupabaseBudget(store,config);
    const at=new Date('2026-11-30T14:59:59Z');
    const id=await budget.reserve({category:'other',service:'mock',maximumYen:100},at);await budget.settle(id,50,2);await budget.recordBill(id,1001);
    assert.equal(await budget.mode(at),'stop');
    assert.equal((await budget.totals(new Date('2026-11-30T15:00:00Z'))).committed,0);
  });
  await t.test('noon upgrade preserves data, grants, and permits 5 product plus 3 daily claims',async()=>{
    await reset();await store.setting('upgrade-proof','kept');await sql(noonMigration);
    assert.equal(await store.setting('upgrade-proof'),'kept');
    assert.equal((await store.health()).scheduleVersion,2);assert.equal((await store.health()).maxDailyPosts,8);
    const slots=slotsForDay('2026-11-07');
    for(const s of slots)assert.equal(await store.claim(s,'threads',null,new Date(s.scheduledAt),config),true);
    assert.equal(await sql("SELECT count(*) FROM public.kurashi_posts WHERE sns='threads';"),'8');
    const noon=slots.find(s=>s.id.endsWith('/12:00'));
    assert.equal(await store.claim(noon,'threads',null,new Date(noon.scheduledAt),config),false);
    await assert.rejects(()=>store.claim({...slots[1],kind:'daily'},'instagram',null,now,config),/invalid_slot/);
    await reset();for(const s of slots.slice(0,7))await store.claim(s,'threads',null,new Date(s.scheduledAt),config);
    await assert.rejects(()=>store.claim(slots[7],'threads',null,new Date(slots[7].scheduledAt),{...config,dailyPostLimit:7}),/daily_post_limit/);
  });
  await t.test('remote Engine persists dry-run state; a restarted runner never re-prepares the same slot',async()=>{
    await reset();const p=fixtureProduct(1,now);await store.saveProduct(p,now);
    await store.saveImage(fixtureImage(p.id,1,now));await store.saveImage(fixtureImage(p.id,2,now));
    const publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
    const selection=new Selection(store,new MockRakuten([p]),new MockVision(),config);
    const engine=new Engine({store,config:{...config,productCopyMode:'legacy'},selection,publishers,verifySite:async()=>true,clock:()=>now});
    assert.equal((await engine.run(slot,'threads',{product:p})).state,'dry_run');
    assert.equal((await engine.run(slot,'threads',{product:p})).state,'dry_run');assert.equal(publishers.threads.calls.length,1);
    assert.equal((await store.history('threads',{since:new Date(+now-86400000).toISOString()})).length,1);
  });
  await t.test('unknown publication state, cache and emergency stop survive client restart',async()=>{
    await reset();await store.claim(slot,'threads',fixtureProduct(1,now),now,config);
    await store.updatePost(slot.id,'threads','unknown',{container_id:'held'});
    await store.cache('evaluation',{score:90},new Date(+now+86400000).toISOString());await store.setting('emergencyStop',true);
    assert.equal(await store.claim(slot,'threads',fixtureProduct(1,now),now,config),false);
    assert.equal((await store.post(slot.id,'threads')).state,'unknown');assert.equal((await store.cached('evaluation',now)).score,90);
    assert.equal(await store.setting('emergencyStop'),true);
  });
  await t.test('private export can restore only into an empty DB, including numbers and unknown holds',async()=>{
    await reset();const p=fixtureProduct(1,now);await store.saveProduct(p,now);await store.saveImage(fixtureImage(p.id,1,now));
    await store.claim(slot,'threads',p,now,config);await store.updatePost(slot.id,'threads','unknown',{container_id:'uncertain'});
    const snapshot=await store.export();
    await assert.rejects(()=>store.restore(snapshot),/restore_target_not_empty/);
    await reset();await store.restore(snapshot);
    assert.equal((await store.product(p.id)).number,1);assert.equal((await store.images(p.id)).length,1);
    assert.equal((await store.post(slot.id,'threads')).state,'unknown');
    assert.equal((await store.saveProduct(fixtureProduct(2,now),now)).number,2);
    const deleted=await store.saveProduct(fixtureProduct(3,now),now);
    await sql("DELETE FROM public.kurashi_products WHERE id='mock-shop:item-3';");
    const newer=await store.export();await reset();await store.restore(newer);
    assert.ok((await store.saveProduct(fixtureProduct(4,now),now)).number>deleted.number);
  });
});
