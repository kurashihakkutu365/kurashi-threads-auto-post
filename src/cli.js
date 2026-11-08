import { resolve,join } from 'node:path';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Selection,canonicalId } from './products.js';
import { registerRights } from './rights.js';
import { MockPublisher } from './publishers.js';
import { MockRakuten,MockVision,seedFixtures,seedDailyImages } from './fixtures.js';
import { slotsForDay,jstDay } from './time.js';
import { dailyBatch } from './daily.js';
import { buildSite } from './site.js';
import { report,backupDatabase,verifyRestore,exportDatabase } from './maintenance.js';
import { SupabaseStore } from './supabase-store.js';
import { backupRemote,decryptBackup,remoteReport } from './remote-maintenance.js';
import { checkThreadsConnection } from './threads-connection.js';
import { checkInstagramConnection } from './instagram-connection.js';

export async function main(command=process.argv[2],directory=resolve('var'),now=new Date(),{env=process.env,fetchImpl=fetch}={}) {
  const config=loadConfig(undefined,env);
  // There is no production CLI path until persistent remote DB, verified credentials and platform review are integrated.
  if (!config.dryRun) throw new Error('production_runner_unavailable');
  // Read-only SNS diagnostics must not depend on a working DB or create local state.
  if(command==='threads-check') return checkThreadsConnection(config,{env,fetchImpl});
  if(command==='instagram-check') return checkInstagramConnection(config,{env,fetchImpl});
  mkdirSync(directory,{recursive:true});
  const backend=env.STORAGE_BACKEND??config.storageBackend??'sqlite';
  if(!['sqlite','supabase'].includes(backend)) throw new Error('invalid_storage_backend');
  const remote=command==='db-check'||command==='db-restore'||backend==='supabase'&&command!=='demo';
  const store=remote?new SupabaseStore({url:env.SUPABASE_URL,key:env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl}):new Store(join(directory,command==='demo'?'demo.sqlite':'state.sqlite'));
  try {
    if(command==='db-check') {
      const health=await store.health();
      if(health?.schemaVersion!==1) throw new Error('supabase_schema_mismatch');
      return {connected:true,schemaVersion:1,storageBackend:'supabase',dryRun:config.dryRun};
    }
    if(command==='db-restore') {
      if(process.argv[4]!=='--empty-target') throw new Error('restore_requires_empty_target_flag');
      const snapshot=decryptBackup(process.argv[3],env.BACKUP_ENCRYPTION_KEY);
      await store.restore(snapshot);return {restored:true,dryRun:config.dryRun};
    }
    if (command==='demo') {
      const day=jstDay(now);
      const products=seedFixtures(store,now);
      const api=new MockRakuten(products),vision=new MockVision();
      const selection=new Selection(store,api,vision,config);
      const selected=await selection.collect(day,now);
      const site=buildSite(store,join(directory,'site-preview'),config,now);
      const themes=dailyBatch(day);
      const images=seedDailyImages(store,themes,join(directory,'private-images'),now);
      let tick=now;
      const publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
      const engine=new Engine({store,config,selection,publishers,clock:()=>tick,verifySite:async(p)=>{
        if (!site.some(i=>i.number===p.number)) throw new Error('site_product_missing'); return true;
      }});
      let pi=0,di=0;
      for(const slot of slotsForDay(day)) {
        tick=new Date(slot.scheduledAt);
        // Mock API simulates fresh data without any external request.
        for(const p of products) p.checkedAt=tick.toISOString();
        const payload=slot.kind==='product'?{product:selected[pi++]}:{daily:themes[di],image:images[di++]};
        for(const sns of ['threads','instagram']) await engine.run(slot,sns,payload);
      }
      const summary=report(store,config,now);
      writeFileSync(join(directory,'demo-report.json'),JSON.stringify(summary,null,2));
      return { ...summary, mockOnly:true,searchCalls:api.searchCalls,visionCalls:vision.calls,siteItems:site.length };
    }
    if (command==='run') {
      // Scheduled dry-run intentionally has no fake production products or downloaded images.
      const publishers={threads:new MockPublisher('threads'),instagram:new MockPublisher('instagram')};
      const selection=new Selection(store,new MockRakuten([]),new MockVision(),config);
      const engine=new Engine({store,config,selection,publishers,verifySite:async()=>false,clock:()=>now});
      const results=[];
      for(const slot of slotsForDay(jstDay(now))) {
        if (Date.parse(slot.scheduledAt)>+now) continue;
        for(const sns of ['threads','instagram']) results.push(await engine.run(slot,sns));
      }
      return {dryRun:true,results};
    }
    if (command==='report') return remote?await remoteReport(store,config,now):report(store,config,now);
    if (command==='site') {
      let source=store;
      if(remote) {
        const snapshot=await store.siteData();
        source={products:()=>snapshot.products,images:id=>snapshot.images.filter(i=>i.productId===id)};
      }
      return {items:buildSite(source,join(directory,'site-preview'),config,now).length};
    }
    if (command==='backup') return remote?await backupRemote(store,join(directory,'backups/state.encrypted.json'),env.BACKUP_ENCRYPTION_KEY):await backupDatabase(store,join(directory,'backups/state.sqlite'));
    if (command==='restore-check') {
      if(remote){const snapshot=decryptBackup(join(directory,'backups/state.encrypted.json'),env.BACKUP_ENCRYPTION_KEY);return {schemaVersion:snapshot.schemaVersion,tables:Object.keys(snapshot.tables).length};}
      return verifyRestore(join(directory,'backups/state.sqlite'));
    }
    if (command==='export') {
      if(remote){const path=join(directory,'private/export.json');mkdirSync(join(directory,'private'),{recursive:true});writeFileSync(path,JSON.stringify(await store.export()),{mode:0o600});return {path};}
      return {path:exportDatabase(store,join(directory,'private/export.json'))};
    }
    if (command==='cleanup') { await store.cleanup(now,config.retentionDays); return {cleaned:true}; }
    if (command==='product-import') {
      const p=JSON.parse(readFileSync(process.argv[3],'utf8'));
      if (!p.id || !p.name || !p.sourceEvidence) throw new Error('product_evidence_missing');
      return {number:(await store.saveProduct({...p,canonical:canonicalId(p)},now)).number};
    }
    if (command==='rights-import') {
      const image=JSON.parse(readFileSync(process.argv[3],'utf8'));
      // Local file bytes must be checked before granting any remote image record.
      if(remote) {
        const validationStore={product:()=>true,saveImage:()=>{}};
        registerRights(validationStore,image,now);
        if(!await store.product(image.productId)) throw new Error('unknown_product');
        await store.saveImage(image);
      } else registerRights(store,image,now);
      return {registered:image.id};
    }
    if (command==='stop') { await store.setting('emergencyStop',true); return {emergencyStop:true}; }
    if (command==='sns-stop') {
      const sns=process.argv[3];
      if (!['threads','instagram'].includes(sns)) throw new Error('unsupported_platform');
      await store.setting(`stop:${sns}`,true); return {stopped:sns};
    }
    throw new Error('unknown_command');
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(),null,2)); }
  catch(e) { console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'command_failed'); process.exitCode=1; }
}
