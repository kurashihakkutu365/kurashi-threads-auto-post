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

export async function main(command=process.argv[2],directory=resolve('var'),now=new Date()) {
  const config=loadConfig();
  // There is no production CLI path until persistent remote DB, verified credentials and platform review are integrated.
  if (!config.dryRun) throw new Error('production_runner_unavailable');
  mkdirSync(directory,{recursive:true});
  const store=new Store(join(directory,command==='demo'?'demo.sqlite':'state.sqlite'));
  try {
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
    if (command==='report') return report(store,config,now);
    if (command==='site') return {items:buildSite(store,join(directory,'site-preview'),config,now).length};
    if (command==='backup') return await backupDatabase(store,join(directory,'backups/state.sqlite'));
    if (command==='restore-check') return verifyRestore(join(directory,'backups/state.sqlite'));
    if (command==='export') return {path:exportDatabase(store,join(directory,'private/export.json'))};
    if (command==='cleanup') { store.cleanup(now,config.retentionDays); return {cleaned:true}; }
    if (command==='product-import') {
      const p=JSON.parse(readFileSync(process.argv[3],'utf8'));
      if (!p.id || !p.name || !p.sourceEvidence) throw new Error('product_evidence_missing');
      return {number:store.saveProduct({...p,canonical:canonicalId(p)},now).number};
    }
    if (command==='rights-import') {
      const image=JSON.parse(readFileSync(process.argv[3],'utf8'));
      registerRights(store,image,now); return {registered:image.id};
    }
    if (command==='stop') { store.setting('emergencyStop',true); return {emergencyStop:true}; }
    if (command==='sns-stop') {
      const sns=process.argv[3];
      if (!['threads','instagram'].includes(sns)) throw new Error('unsupported_platform');
      store.setting(`stop:${sns}`,true); return {stopped:sns};
    }
    throw new Error('unknown_command');
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(),null,2)); }
  catch(e) { console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'command_failed'); process.exitCode=1; }
}
