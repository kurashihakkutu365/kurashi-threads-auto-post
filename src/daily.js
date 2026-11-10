import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { escapeHtml } from './site.js';
import { validateDaily } from './content.js';

export const DAILY_VOICE_RULES='人間味は、短い本音、少しの迷い、好きな物へのこだわり、自分への小さなツッコミで出す。毎回きれいな結論や教訓にまとめず、文の長短と締め方を変える。「丁寧に」「大切にしたい」ばかりで締めない。広告コピーのように整えすぎない。未確認の本人の購入・使用体験、昨日や先週の出来事、家族構成、長年の苦労や実績は作らない。';
export const DAILY_KINDS=['あるある','本音','共感','小さな発見','こだわり','問いかけ'];
export const DAILY_SCHEMA={type:'object',additionalProperties:false,required:['themes'],properties:{themes:{type:'array',minItems:3,maxItems:3,items:{type:'object',additionalProperties:false,required:['kind','text'],properties:{kind:{enum:DAILY_KINDS},text:{type:'string',minLength:60,maxLength:150}}}}}};

export const DAILY_POOL=[
  ['あるある','収納グッズを選んでる間に、脳内の部屋だけ完成する。\n色をそろえて、棚に並べて、ちょっと余白も残して。想像の中ではもう片付いてるのに、現実の収納サイズを測るところが地味に大事。かわいいだけで決めたい気持ちとの戦い🥹。'],
  ['本音','生活感は消したいけど、好きなマグまで隠すのは惜しい。\n全部しまえばすっきりするのはわかる。わかるけど、目に入るたびにかわいい物は出しておきたい。このちょっと矛盾した欲、収納の正解を難しくしてる気がする🥹。'],
  ['小さな発見','文房具の色がそろってる机って、それだけで眺めたくなる。\n道具の数を増やさなくても、並べ方を考える時間には小さな楽しさがある。使うための場所に好きな景色も置けるの、机まわりの良いところ。'],
  ['共感','片付ける気力がない日まで、収納の才能を疑わなくていい。\n暮らしていれば物は動くし、机がずっと空っぽとも限らない。きれいを保つことより、戻せる場所があるくらいの気楽さを大事にしたい🥹。'],
  ['こだわり','便利なのはわかるけど、その色だけちょっと惜しい。\nキッチン道具を選ぶとき、最後に引っかかるのがそこだったりする。機能の話をしてるのに、頭の中では棚との色合わせ。毎日目に入る物だし、見た目にも一票入れたい。'],
  ['問いかけ','食器をそろえるか、違う柄を楽しむかで迷う。\n統一感のある棚も、好きな物が少しずつ並ぶ棚もかわいい。どちらにも良さがあって決め切れない、この感じ。みんなは同じシリーズ派、それとも一枚ずつ集める派？🥹'],
  ['あるある','かわいい小皿、置き場所より先に使い道を考え始めがち。\nお菓子にもアクセサリーにも合いそう、って想像だけはどんどん広がる。使い道が多いから気になるのか、好きだから使い道を探すのか、境目があやしい🥹。'],
  ['本音','収納ラベルまでおしゃれに統一したい気持ちは、ある。\nでも全部の文字とサイズをそろえるところで、急に大仕事になる。ざっくりでも物を戻せたら、それはそれで十分かもしれない。きれいにしたい欲と、面倒は減らしたい本音が同居してる🥹。'],
  ['小さな発見','ベッドまわりって、布の色を考えるだけでも楽しい。\n家具を動かす大きな模様替えとは違って、枕元にどんな色を置くか想像する時間がある。部屋全部じゃなく、好きな一角から考えるのも良さそう。'],
  ['共感','趣味の材料、使うためだけの物とも言い切れない。\n糸の色や紙の柄を並べて眺める時間にも、ちゃんと楽しさがある。完成品を増やす日だけじゃなく、何を作ろうか考える日も趣味のうちでいい🥹。'],
  ['こだわり','棚の余白は、何かを買い足すためだけの場所じゃない。\nお気に入りの形が見えるように、あえて置かない選び方にも惹かれる。物を減らす競争じゃなく、好きな物をどう眺めたいかで考える収納が好み。'],
  ['問いかけ','寝具の色って、部屋の雰囲気まで想像したくなる。\n明るい色の軽やかさも、落ち着いた色のまとまりも捨てがたい。毎日目に入る場所だから、好きな色を選ぶ時間も楽しい。ベッドまわりは明るめ派、それとも落ち着いた色派？'],
  ['あるある','ノートの最初のページだけ、妙にきれいに書きたくなる。\n中身をまとめる前から、ペンの色や余白まで気になり始める。使い込んだページにも味はあるのに、まっさらな紙の前だと急に丁寧な暮らしモード🥹。'],
  ['本音','おしゃれな部屋にしたいけど、リモコンは近くにいてほしい。\nひざ掛けも、本も、使う物まで遠くにしまうとちょっと困る。写真みたいなすっきり感に憧れつつ、くつろぐための物も残したい。都合のいい願いだけど、どっちも本音。'],
  ['小さな発見','白でそろえようとすると、今度は白の違いが気になってくる。\nまっ白、少し黄みのある白、つやのある白。色を一つに決めたはずなのに、選択肢が減らない。素材まで見始めるともう終わらない、インテリアの沼ってこういうところ。'],
  ['共感','調理道具を選ぶとき、洗うところまで想像したくなる。\n使う瞬間の便利さだけじゃなく、片付ける手間も気になるもの。料理を頑張るためというより、料理のあとの自分にも優しい選び方をしたい🥹。'],
  ['こだわり','飾る物を選ぶときは、流行より何度も眺めたいかが気になる。\n誰かの正解をそのまま置くより、好きな色や形が少しずつ重なる部屋がいい。統一感は欲しいけど、自分の好みまで消さなくていいと思う。'],
  ['問いかけ','布ものの柄を選ぶときだけ、候補が急に増えがち。\n無地の合わせやすさも、小さな柄のかわいさも、それぞれ良さがある。部屋の雰囲気を想像している間がすでに楽しい。クッションは無地と柄、どちらに惹かれる？'],
  ['あるある','コードを隠したいだけなのに、箱の色まで気になり始める。\n目立たなくなれば十分なはずが、棚に合う形も探したくなる。生活感を減らす作戦の途中で、また別のおしゃれ欲が顔を出すのが部屋づくり🥹。'],
  ['本音','これ便利そう、の次に置き場所どこだろう、が来る。\n使ってる場面の想像は楽しいのに、しまってる場面はつい後回し。見えるところに置いても好きな形かどうかって、地味だけど気になる。便利な物を増やすのにも、収納会議が必要🥹。'],
  ['小さな発見','食卓の雰囲気を考えるとき、箸置きにも出番がある。\n大きな家具とは違う小さな物でも、色や形の組み合わせを楽しめる。毎回完璧に並べなくても、気分が向いた日の小さなおしゃれとして眺めていたい。'],
  ['共感','手芸の道具までかわいくそろえたくなる気持ち、わかる。\n作品に必要かどうかだけじゃなく、作業する場所の景色も楽しみの一部。効率だけで割り切れない好きがあるから、趣味の机は見ていて飽きない🥹。'],
  ['こだわり','鍵を置くための小さな器にも、かわいさを求めてしまう。\n置ければいいだけなんだけど、木にするか陶器にするかで思い浮かぶ玄関が変わる。大きな模様替えじゃなくても、好きな物を選ぶ余地はちゃんとある。この小さいこだわりが楽しい。'],
  ['問いかけ','収納ケースの中まで色をそろえるか、見えなければ自由にするか。\n外から見える場所は整えたいけど、引き出しの中まで頑張るかは別の話。暮らしやすさの基準も、人によって違いそう。見えない収納の見た目、どこまで気になる？'],
].map(([kind,text])=>({kind,text}));

export function validateDailyBatch(themes,history=[]) {
  if(!Array.isArray(themes)||themes.length!==3||new Set(themes.map(t=>t.kind)).size!==3||themes.some(t=>!DAILY_KINDS.includes(t.kind)))throw new Error('daily_batch_variety');
  return themes.map((t,i)=>validateDaily(t,[...history,...themes.slice(0,i).map(t=>t.text)]));
}
export function dailyBatch(day,history=[]) {
  const offset=Number(day.replaceAll('-',''))%DAILY_POOL.length;
  const result=[];
  for(let j=0;j<DAILY_POOL.length&&result.length<3;j++) {
    const theme=DAILY_POOL[(offset+j)%DAILY_POOL.length];
    if(result.some(t=>t.kind===theme.kind))continue;
    try{result.push(validateDaily({...theme},[...history,...result.map(t=>t.text)]));}catch{/* Skip exhausted/recent themes; no forced recycling. */}
  }
  return result;
}
export function renderDailyImage(text,{fontFiles=[]}={}) {
  validateDaily({text});
  const lines=[];
  for(const paragraph of text.split('\n')){const chars=Array.from(paragraph);for(let i=0;i<chars.length;i+=20)lines.push(chars.slice(i,i+20).join(''));}
  if (lines.length>10) throw new Error('image_text_overflow');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#faf8f2"/><rect x="60" y="60" width="960" height="960" rx="36" fill="#ffffff" stroke="#d8dfd0" stroke-width="4"/><text x="120" y="180" font-family="Noto Sans CJK JP,sans-serif" font-size="35" fill="#567363">暮らしの発掘室</text>${lines.map((l,i)=>`<text x="120" y="${300+i*60}" font-family="Noto Sans CJK JP,sans-serif" font-size="40" fill="#25342d">${escapeHtml(l)}</text>`).join('')}</svg>`;
  const rendered=new Resvg(svg,{font:{loadSystemFonts:true,fontFiles}}).render();
  return {svg,jpeg:jpeg.encode({data:rendered.pixels,width:1080,height:1080},85).data,width:1080,height:1080};
}
