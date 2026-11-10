import test from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_POOL,DAILY_KINDS,dailyBatch,validateDailyBatch } from '../src/daily.js';
import { validateDaily,isDailyQuestion } from '../src/content.js';
import { slotsForDay } from '../src/time.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';

test('daily repertoire has six kinds, 24 valid templates, and one hook-only line break',()=>{
  assert.equal(DAILY_POOL.length,24);assert.equal(new Set(DAILY_POOL.map(t=>t.kind)).size,6);
  for(const theme of DAILY_POOL){assert.ok(DAILY_KINDS.includes(theme.kind));validateDaily(theme);assert.equal(theme.text.split('\n').length,2);assert.ok(theme.text.split('\n')[0].endsWith('。'));}
});
test('all calendar rotations return three kinds and at most one question',()=>{
  for(let d=1;d<=31;d++){
    const themes=dailyBatch(`2026-12-${String(d).padStart(2,'0')}`);assert.equal(themes.length,3);validateDailyBatch(themes);
    assert.ok(themes.filter(t=>isDailyQuestion(t.text)).length<=1);
  }
});
test('recent questions and implicit requests do not trigger another engagement question',()=>{
  const q=DAILY_POOL.find(t=>t.kind==='問いかけ');
  for(const history of [['気になる色を教えてください。'],['どんな柄が好き？','好きな色は自由でいい。']])assert.throws(()=>validateDaily(q,history),/daily_question_frequency/);
  const themes=dailyBatch('2026-11-10',['気になる色を教えてください。']);
  assert.ok(!isDailyQuestion(themes[0].text));assert.ok(!isDailyQuestion(themes[1].text));
});
test('batch rejects repeated kinds, recent copies, multiple questions and old line layout',()=>{
  const batch=dailyBatch('2026-11-10');assert.throws(()=>validateDailyBatch([batch[0],batch[0],batch[2]]),/daily_batch_variety/);
  assert.throws(()=>validateDaily(batch[0],[batch[0].text]),/invalid_daily/);
  const q=DAILY_POOL.find(t=>t.kind==='問いかけ');assert.throws(()=>validateDaily({...q,text:q.text+'どう思う？'}),/daily_question_frequency/);
  assert.throws(()=>validateDaily({...batch[0],text:batch[0].text.replace('\n','')}),/daily_layout/);
  assert.throws(()=>validateDaily({...batch[0],text:batch[0].text+'\n追加'}),/daily_layout/);
});
test('SQLite accepts all eight scheduled slots and stops a ninth daily claim',t=>{
  const store=new Store();t.after(()=>store.close());const config=loadConfig(undefined,{}),slots=slotsForDay('2026-11-10');
  for(const slot of slots)assert.equal(store.claim(slot,'threads',null,new Date(slot.scheduledAt),config),true);
  assert.throws(()=>store.claim({id:'2026-11-10/extra',kind:'daily',scheduledAt:slots[7].scheduledAt},'threads',null,new Date(slots[7].scheduledAt),config),/daily_post_limit/);
});
test('workflow UTC crons match the eight JST slots including noon',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/schedule.yml',import.meta.url),'utf8');
  const crons=[...workflow.matchAll(/cron: '([^']+)'/g)].map(m=>m[1]);assert.equal(crons.length,8);
  for(const s of slotsForDay('2026-11-10')){const at=new Date(s.scheduledAt);assert.ok(crons.includes(`${at.getUTCMinutes()} ${at.getUTCHours()} * * *`));}
});
