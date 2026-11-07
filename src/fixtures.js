import { createHash } from 'node:crypto';
import { canonicalId } from './products.js';
import { jstDay } from './time.js';
import { renderDailyImage } from './daily.js';
import { writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function fixtureProduct(index=1,now=new Date()) {
  const names=['デモ収納ボックス','デモ花柄マグカップ','デモ木製ペン立て','デモ手芸ケース','デモ調理ヘラ','デモ小さな飾り棚','デモ掃除ブラシ'];
  const facts=['小物をまとめる収納用品','花を描いた食器','机に置く文房具用品','糸をしまう手芸用品','調理に使うキッチン道具','壁面を彩るインテリア用品','日用品のブラシ'];
  const genres=['収納','食器','文房具','手芸','調理器具','インテリア','日用品雑貨'];
  const j=(index-1)%7;
  const p={id:`mock-shop:item-${index}`,identityKey:`original-demo-product-${index}`,identityEvidence:'Synthetic test fixture; no real merchandise',name:names[j],shortFact:facts[j],genre:genres[j],description:facts[j]+'。デモ専用の架空の商品です。',price:1000+index,available:true,reviewAverage:4.5,reviewCount:100,affiliateRate:10,affiliateUrl:`https://hb.afl.rakuten.co.jp/hgc/mock-only-${index}/`,checkedAt:now.toISOString()};
  return {...p,canonical:canonicalId(p)};
}
export function fixtureImage(productId,index=1,now=new Date()) {
  return {id:`${productId}:image-${index}`,productId,source:'local:original-synthetic-fixture',evidence:'Original project template; mock URL never fetched',approvedBy:'fixture-generator',approvedAt:new Date(+now-86400000).toISOString(),expiresAt:new Date(+now+365*86400000).toISOString(),permissions:{download:true,ai:true,threads:true,instagram:true,site:true,publicHosting:true,transform:true},hash:createHash('sha256').update(`${productId}-${index}`).digest('hex'),storagePath:`var/private/${productId.replaceAll(':','-')}-${index}.jpg`,publicUrl:`https://fixtures.invalid/${encodeURIComponent(productId)}/${index}.jpg`,publicUrlExpiresAt:new Date(+now+86400000).toISOString(),mime:'image/jpeg',original:true};
}
export class MockRakuten {
  constructor(products) { this.products=products; this.searchCalls=0; this.itemCalls=0; }
  async search() { this.searchCalls++; return this.products; }
  async item(id) { this.itemCalls++; return this.products.find(p=>p.id===id); }
}
export class MockVision {
  constructor() { this.version='mock-only-v1'; this.calls=0; }
  prefilter(p) { return !!p.shortFact; }
  async evaluate() { this.calls++; return {design:36,originality:18,usefulness:14,quality:9,value:9,social:5}; }
}
export function seedFixtures(store,now) {
  const products=Array.from({length:7},(_,i)=>fixtureProduct(i+1,now));
  for (const p of products) {
    store.saveProduct(p,now);
    store.saveImage(fixtureImage(p.id,1,now)); store.saveImage(fixtureImage(p.id,2,now));
  }
  return products;
}
export function seedDailyImages(store,themes,directory,now) {
  mkdirSync(directory,{recursive:true});
  return themes.map((theme,index)=>{
    const rendered=renderDailyImage(theme.text);
    const id=`daily:${jstDay(now)}:${index}`;
    const path=join(directory,`daily-${index}.jpg`);
    writeFileSync(path,rendered.jpeg);
    const image={...fixtureImage(id,1,now),hash:createHash('sha256').update(rendered.jpeg).digest('hex'),storagePath:path};
    store.saveImage(image);
    return image;
  });
}
