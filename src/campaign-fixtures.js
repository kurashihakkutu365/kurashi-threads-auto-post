// Synthetic offline example, never import this fixture into a production product source.
import { fixtureProduct } from './fixtures.js';
import { ROLES } from './ranked-copy.js';

export function campaignFixture(now=new Date()) {
  const p={...fixtureProduct(1,now),name:'デモ木製収納ボックス',price:1490};
  const texts={problem:'机に散らばる細かな文房具',benefit:'3つの仕切りで種類別に整理できる',alternative:'ふた付きの収納ケース',feature:'木目を生かした見せる収納',current:'引き出しに小物をまとめる方法',future:'仕切りごとに小物を並べる収納'};
  const ease={A:['price','販売価格1,490円'],B:['effort','組み立て不要'],C:['contrast','ふたの開閉が不要']};
  const facts=Object.entries(texts).map(([role,text])=>({id:role,role,text}));
  for(const [pattern,[angle,text]] of Object.entries(ease))facts.push({id:`ease-${pattern}`,role:'ease',angle,text});
  p.campaignFacts=facts.map(f=>({...f,sourceUrl:'https://manufacturer.invalid/demo',sourceQuote:`架空のテスト情報：${f.text}`,checkedAt:now.toISOString()}));
  p.campaignReview={method:'human',approvedBy:'synthetic-fixture-only',approvedAt:now.toISOString(),officialHosts:['manufacturer.invalid']};
  const result={candidates:['A','B','C'].map((pattern,index)=>({pattern,factIds:Object.fromEntries(ROLES.map(role=>[role,role==='ease'?`ease-${pattern}`:role])),scores:{hook:16+index,specificity:17,contrast:16,empathy:18,comments:17}}))};
  return {p,result};
}
