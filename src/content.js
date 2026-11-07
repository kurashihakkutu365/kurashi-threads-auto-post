import Ajv from 'ajv';
import { styleFor } from './products.js';

const ajv = new Ajv({allErrors:true,strict:true});
export const COPY_SCHEMA = {
  type:'object',additionalProperties:false,required:['style','lines','hashtags','factIds'],
  properties:{
    style:{enum:['A','B','C']},
    lines:{type:'array',minItems:1,maxItems:3,items:{type:'string',minLength:1,maxLength:100}},
    hashtags:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{type:'string',pattern:'^#[^\\s#]+$',maxLength:30}},
    factIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string'}}
  }
};
const validate = ajv.compile(COPY_SCHEMA);
export function similar(a,b) {
  const grams = s => {
    const chars = Array.from(s.normalize('NFKC').replace(/【PR】|https?:\/\/\S+|#\S+|商品No\.\d+|プロフィールのリンクからチェック/g,'').replace(/\s|\p{P}/gu,''));
    return new Set(chars.slice(1).map((c,i)=>chars[i]+c));
  };
  const x=grams(a),y=grams(b);
  if (!x.size || !y.size) return a === b;
  return [...x].filter(g=>y.has(g)).length / new Set([...x,...y]).size >= .65;
}
export function generateCopy(p) {
  // Deterministic factual fallback; no AI request or fabricated experience.
  return {style:styleFor(p),lines:[p.name,p.shortFact],hashtags:[`#${p.genre}`],factIds:['name','shortFact']};
}
export function validateCopy(copy,p,history=[]) {
  if (!validate(copy)) throw new Error('copy_schema');
  const text = copy.lines.join('\n');
  if (copy.lines.some(l=>/[\r\n]|https?:|【PR】|#/.test(l))) throw new Error('copy_injected_markup');
  if (copy.style !== styleFor(p)) throw new Error('copy_style');
  const facts = {name:p.name,shortFact:p.shortFact,...p.approvedFacts};
  // Fail closed: every generated line must match a pre-approved factual phrase.
  // Rule validators cannot establish semantic truth for arbitrary LLM prose.
  if (copy.factIds.some(k=>!facts[k]) || copy.lines.some(l=>!copy.factIds.some(k=>facts[k]===l))) throw new Error('unsupported_claim');
  if (/(使ってみ|愛用|買って|購入しま|絶対|必ず効|治る)/.test(text)) throw new Error('fabricated_experience');
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emojis>2) throw new Error('too_many_emoji');
  if (history.some(h=>similar(text,h))) throw new Error('similar_copy');
  return copy;
}
export function renderCopy(copy,p,sns) {
  const body = copy.lines.map((l,i)=>(i===0?'【PR】':'')+l).join('\n');
  const cta = sns==='threads' ? p.affiliateUrl : `商品No.${p.number}｜プロフィールのリンクからチェック`;
  const text = `${body}\n${cta}\n${copy.hashtags.join(' ')}`;
  if (!text.startsWith('【PR】') || Array.from(text).length>(sns==='threads'?500:2200)) throw new Error('invalid_caption');
  return text;
}
export function validateDaily(theme,history=[]) {
  if (!theme || typeof theme.text!=='string' || theme.text.length<5 || theme.text.length>150 || /https?:|【PR】|買って|使ってみ|私が|昨日/.test(theme.text) || history.some(h=>similar(theme.text,h))) throw new Error('invalid_daily');
  return theme;
}
