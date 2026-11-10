import { createHash } from 'node:crypto';
import { requirePair } from './rights.js';

export const GENRES = ['インテリア','寝具','収納','日用品雑貨','文房具','手芸','キッチン用品','食器','調理器具'];
export const WEIGHTS = { design: 40, originality: 20, usefulness: 15, quality: 10, value: 10, social: 5 };
export function canonicalId(p) {
  if (p.gtin && /^\d{8,14}$/.test(p.gtin)) return `gtin:${p.gtin}`;
  // No guessed identity from arbitrary descriptions: candidates without a curated cross-shop identity are rejected.
  if (!p.identityEvidence || !p.identityKey) throw new Error('product_identity_unverified');
  return createHash('sha256').update(p.identityKey.normalize('NFKC').toLowerCase().replace(/\s/g,'')).digest('hex');
}
export function eligible(p) {
  return !!p && GENRES.includes(p.genre) && p.available === true && Number.isFinite(p.price) && p.price > 0 &&
    Number.isFinite(p.reviewAverage) && p.reviewAverage >= 4.3 && p.reviewAverage <= 5 && Number.isInteger(p.reviewCount) && p.reviewCount >= 100 && p.affiliateRate >= 10 && !!p.name && !!p.description;
}
export function scoreProduct(scores) {
  if (!scores || Object.keys(scores).length !== 6) throw new Error('invalid_score');
  let total = 0;
  for (const [key, max] of Object.entries(WEIGHTS)) {
    if (!Number.isFinite(scores[key]) || scores[key] < 0 || scores[key] > max) throw new Error('invalid_score');
    total += scores[key];
  }
  return total;
}
export function styleFor(p) {
  if (/かわいい|可愛い|猫|花|独特|ユニーク|キャラクター/.test(p.name+' '+p.description)) return 'B';
  if (/収納|片付け|省スペース|整理/.test(p.name+' '+p.description)) return 'A';
  return 'C';
}
export class Selection {
  constructor(store, api, vision, config) { Object.assign(this,{store,api,vision,config}); }
  async collect(day, now) {
    const cached = await this.store.cached(`collection:${day}`, now);
    if (cached) return cached;
    // One batch per day. The API adapter chooses rotating genres instead of querying every genre per slot.
    const candidates = await this.api.search({ day, genres: GENRES });
    const selected = [];
    for (const raw of candidates) {
      if (!eligible(raw)) continue;
      let p;
      try { p = { ...raw, canonical: canonicalId(raw) }; }
      catch { continue; }
      if (selected.some(x=>x.canonical===p.canonical) || await this.store.recentlyUsed(p.canonical,now,this.config.duplicateDays,'')) continue;
      await this.store.saveProduct(p,now);
      let pair;
      try { pair = requirePair(await this.store.images(p.id),'threads',now,{ai:true}); requirePair(pair,'instagram',now,{site:this.config.productCopyMode!=='ranked'}); }
      catch { continue; }
      const key = `vision:${p.id}:${pair.map(i=>i.hash).sort().join(':')}:${this.vision.version}`;
      let score = await this.store.cached(key,now);
      if (!score) {
        // Local text prefilter and API rules run before the paid image evaluator.
        if (!this.vision.prefilter(p)) continue;
        score = await this.vision.evaluate(p,pair);
        scoreProduct(score);
        await this.store.cache(key,score,new Date(+now+180*86400000).toISOString());
      }
      if (scoreProduct(score) >= 80) selected.push({...p,score:scoreProduct(score)});
    }
    selected.sort((a,b)=>b.score-a.score);
    await this.store.cache(`collection:${day}`,selected,new Date(+now+86400000).toISOString());
    return selected;
  }
  async refresh(p, now) {
    const fresh = await this.api.item(p.id);
    if (!fresh || fresh.id !== p.id || canonicalId(fresh) !== p.canonical || !eligible(fresh) ||
        !Number.isFinite(Date.parse(fresh.checkedAt)) || +now-Date.parse(fresh.checkedAt) > this.config.freshnessMinutes*60000 || Date.parse(fresh.checkedAt)>+now) throw new Error('product_not_fresh');
    if (!/^https:\/\/hb\.afl\.rakuten\.co\.jp\//.test(fresh.affiliateUrl ?? '')) throw new Error('invalid_affiliate_url');
    return this.store.saveProduct({...fresh,canonical:p.canonical},now);
  }
}
