import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,sep } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('var/site-preview');
const server=createServer(async(req,res)=>{
  try {
    const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));
    if (!path.startsWith(root+sep)) {res.writeHead(403);res.end();return;}
    const data=await readFile(path);
    const type=path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'application/json';
    res.writeHead(200,{'Content-Type':type});res.end(data);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const url=`http://127.0.0.1:${server.address().port}`;
  // Deliberately offline: fixtures.invalid image URLs must never be requested externally.
  await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});
  assert.equal(await page.title(),'暮らしの発掘室｜商品一覧');
  assert.equal(await page.locator('article').count(),7);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.selectOption('#genre','収納');
  assert.equal(await page.locator('article:visible').count(),1);
  await page.selectOption('#genre','');
  assert.equal(await page.locator('article:visible').count(),7);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'var/mobile-preview.png',fullPage:true});
  console.log('PASS: 390px mobile layout, 7 products, genre filter, no JS errors');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
