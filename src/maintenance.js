import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Budget } from './budget.js';
import { jstMonth } from './time.js';

const TABLES=['products','images','cache','posts','usage','events','opt_outs','logs','settings'];
export function exportDatabase(store,path) {
  const data={schemaVersion:1,exportedAt:new Date().toISOString(),tables:{}};
  store.transaction(()=>{ for(const table of TABLES) data.tables[table]=store.db.prepare(`SELECT * FROM ${table}`).all(); });
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(data,null,2),{mode:0o600});
  chmodSync(path,0o600);
  return path;
}
export async function backupDatabase(store,path) {
  mkdirSync(dirname(path),{recursive:true});
  await backup(store.db,path);
  chmodSync(path,0o600);
  const manifest={schemaVersion:1,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),at:new Date().toISOString()};
  writeFileSync(path+'.manifest.json',JSON.stringify(manifest),{mode:0o600});
  return manifest;
}
export function verifyRestore(path) {
  const manifest=JSON.parse(readFileSync(path+'.manifest.json','utf8'));
  if (createHash('sha256').update(readFileSync(path)).digest('hex')!==manifest.sha256) throw new Error('backup_hash_mismatch');
  const restored=new DatabaseSync(path,{readOnly:true});
  try {
    if (restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || restored.prepare('PRAGMA user_version').get().user_version!==1) throw new Error('backup_integrity');
    if (restored.prepare('PRAGMA foreign_key_check').all().length) throw new Error('backup_foreign_key');
    return Object.fromEntries(TABLES.map(t=>[t,restored.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  } finally { restored.close(); }
}
export function report(store,config,now=new Date()) {
  const month=jstMonth(now);
  const from=new Date(`${month}-01T00:00:00+09:00`).toISOString();
  return {
    month,dryRun:config.dryRun,emergencyStop:config.emergencyStop || !!store.setting('emergencyStop'),termsStop:config.termsStop,
    budgetTargetYen:config.monthlyBudgetYen,budget:new Budget(store,config).totals(now),budgetMode:new Budget(store,config).mode(now),
    posts:store.db.prepare('SELECT sns,state,COUNT(*) count FROM posts WHERE started_at>=? GROUP BY sns,state').all(from),
    replies:store.db.prepare('SELECT sns,state,COUNT(*) count FROM events WHERE detected_at>=? GROUP BY sns,state').all(from),
    aiUsage:store.db.prepare('SELECT service,category,COUNT(*) calls,SUM(tokens) tokens FROM usage WHERE month=? GROUP BY service,category').all(month),
    rights:{registered:store.db.prepare('SELECT COUNT(*) n FROM images').get().n,expired:store.db.prepare("SELECT COUNT(*) n FROM images WHERE json_extract(data,'$.expiresAt')<=?").get(now.toISOString()).n},
    errors:store.db.prepare('SELECT code,COUNT(*) count FROM logs WHERE at>=? GROUP BY code').all(from),
    warning:'金額は予約・推定額です。実請求額と一致せず、請求上限を保証しません。'
  };
}
