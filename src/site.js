import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requirePair } from './rights.js';

export const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function siteItems(store,now) {
  return store.products().flatMap(p=>{
    try {
      const images=requirePair(store.images(p.id),null,now,{site:true});
      if (!/^https:\/\/hb\.afl\.rakuten\.co\.jp\//.test(p.affiliateUrl)) return [];
      return [{number:p.number,name:p.name,genre:p.genre,summary:p.shortFact,url:p.affiliateUrl,image:images[0].publicUrl}];
    } catch { return []; }
  });
}
export function buildSite(store,directory,config,now=new Date()) {
  const items=siteItems(store,now);
  if (!config.dryRun && (!config.site.affiliateRegistrationConfirmed || !config.site.contact)) throw new Error('site_registration_missing');
  mkdirSync(directory,{recursive:true});
  const cards=items.map(p=>`<article data-genre="${escapeHtml(p.genre)}" id="product-${p.number}"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy" referrerpolicy="no-referrer"><p>【PR】商品No.${p.number} · ${escapeHtml(p.genre)}</p><h2>${escapeHtml(p.name)}</h2><p>${escapeHtml(p.summary)}</p><a href="${escapeHtml(p.url)}" rel="sponsored noopener noreferrer" target="_blank">楽天市場でチェック</a></article>`).join('\n');
  const contact=config.site.contact ? escapeHtml(config.site.contact) : '未設定：本番公開前にお問い合わせ先を登録してください。';
  const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>暮らしの発掘室｜商品一覧</title><link rel="stylesheet" href="style.css"><script src="filter.js" defer></script></head><body><header><p>暮らしの中の、小さな発見。</p><h1>暮らしの発掘室</h1><p>【PR】楽天アフィリエイトを利用しています。リンク経由の購入により報酬を得る場合があります。</p>${config.dryRun?'<p role="status">DRY_RUN・動作確認用。運用開始前です。</p>':''}<label>ジャンル <select id="genre"><option value="">すべて</option>${[...new Set(items.map(p=>p.genre))].map(g=>`<option>${escapeHtml(g)}</option>`).join('')}</select></label></header><main><h2>新着商品</h2><div class="grid">${cards || '<p>現在、掲載条件を満たす商品はありません。</p>'}</div></main><footer><h2>プライバシーポリシー</h2><p>本ページ独自のアクセス解析・Cookie・お問い合わせ収集フォームは使用しません。画像配信先、GitHub Pagesおよびリンク先がアクセス情報を取得する場合があります。楽天市場への移動後は同社の方針をご確認ください。</p><h2>お問い合わせ</h2><p>${contact}</p><p>商品価格・在庫・条件はリンク先でご確認ください。</p></footer></body></html>`;
  writeFileSync(join(directory,'index.html'),html);
  writeFileSync(join(directory,'products.json'),JSON.stringify({generatedAt:now.toISOString(),items},null,2));
  writeFileSync(join(directory,'.nojekyll'),'');
  writeFileSync(join(directory,'style.css'),'body{font-family:system-ui,sans-serif;margin:auto;max-width:1100px;padding:24px;background:#faf8f2;color:#25342d;line-height:1.8}header,footer{padding:24px 0}h1{font-size:clamp(2rem,6vw,3.5rem)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:24px}article{background:#fff;border:1px solid #e1e4d9;border-radius:12px;overflow:hidden;padding:18px}img{width:100%;aspect-ratio:1;object-fit:contain}a{display:inline-block;background:#2f5949;color:white;padding:10px 18px;border-radius:6px}select{font:inherit;padding:8px}footer{font-size:.9rem}');
  writeFileSync(join(directory,'filter.js'),"document.querySelector('#genre').addEventListener('change',e=>{document.querySelectorAll('article[data-genre]').forEach(a=>{a.hidden=!!e.target.value&&a.dataset.genre!==e.target.value})});");
  return items;
}
export async function verifySiteProduct(p,expectedImages,config,{fetchImpl=fetch,now=new Date()}={}) {
  if (!config.site.url.startsWith('https://') || !config.site.affiliateRegistrationConfirmed) throw new Error('site_not_ready');
  const u=new URL(config.site.url);
  const res=await fetchImpl(new URL('products.json',u.href.endsWith('/')?u:new URL(u.href+'/')),{redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error('site_not_published');
  const data=await res.json();
  const item=data.items?.find(i=>i.number===p.number);
  if (!item || item.name!==p.name || item.url!==p.affiliateUrl || !expectedImages.some(i=>i.publicUrl===item.image) ||
      !Number.isFinite(Date.parse(data.generatedAt)) || +now-Date.parse(data.generatedAt)>86400000 || Date.parse(data.generatedAt)>+now) throw new Error('site_product_mismatch');
  // Verify the actual HTML too; a JSON entry alone does not prove that visitors can find the product.
  const page=await fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!page.ok) throw new Error('site_not_published');
  const html=await page.text();
  if (!html.includes(`id="product-${p.number}"`) || !html.includes(escapeHtml(p.affiliateUrl)) || !html.includes('【PR】')) throw new Error('site_product_mismatch');
  return true;
}
