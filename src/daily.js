import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { escapeHtml } from './site.js';
import { validateDaily } from './content.js';

export function dailyBatch(day,history=[]) {
  // Free factual templates. A paid provider can replace this contract after price/quality verification.
  const pool=[
    '引き出しの中で迷子になりがちな小物。種類ごとに置き場所を決めるなら、何から始めますか？',
    '片付けの最初の一歩は、机の上の一角だけでも。今日はどの場所をすっきりさせたいですか？',
    'よく使う道具ほど手に取りやすい場所へ。キッチンで置き場所を見直したいものはありますか？',
    '玄関に小さな定位置があると便利そう。鍵や持ち物はどこに置いていますか？',
    '棚に少し余白をつくると、飾る楽しみも増えそう。お気に入りの一角はありますか？',
    '家事の合間にひと息。気分転換にしている小さな工夫を教えてください。',
    '季節の変わり目、布ものの整理を考えるタイミング。何から入れ替えたいですか？',
  ];
  const offset=Number(day.replaceAll('-',''))%pool.length;
  const result=[];
  for (let j=0;j<pool.length && result.length<2;j++) {
    try { const theme=validateDaily({text:pool[(offset+j)%pool.length]},[...history,...result.map(t=>t.text)]); result.push(theme); }
    catch { /* Exhaustion means skip, never recycle a recent theme just to fill a slot. */ }
  }
  return result;
}
export function renderDailyImage(text,{fontFiles=[]}={}) {
  validateDaily({text});
  const chars=Array.from(text);
  const lines=[];
  for(let i=0;i<chars.length;i+=16) lines.push(chars.slice(i,i+16).join(''));
  if (lines.length>8) throw new Error('image_text_overflow');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#faf8f2"/><rect x="60" y="60" width="960" height="960" rx="36" fill="#ffffff" stroke="#d8dfd0" stroke-width="4"/><text x="120" y="180" font-family="Noto Sans CJK JP,sans-serif" font-size="35" fill="#567363">暮らしの発掘室</text>${lines.map((l,i)=>`<text x="120" y="${300+i*70}" font-family="Noto Sans CJK JP,sans-serif" font-size="48" fill="#25342d">${escapeHtml(l)}</text>`).join('')}</svg>`;
  const rendered=new Resvg(svg,{font:{loadSystemFonts:true,fontFiles}}).render();
  return {svg,jpeg:jpeg.encode({data:rendered.pixels,width:1080,height:1080},85).data,width:1080,height:1080};
}
