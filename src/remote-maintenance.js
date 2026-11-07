import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';

function keyBytes(value) {
  if(typeof value!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('backup_key_missing');
  const key=Buffer.from(value,'base64');
  if(key.length!==32) throw new Error('backup_key_invalid'); return key;
}
export async function backupRemote(store,path,keyValue) {
  const key=keyBytes(keyValue); // Validate before contacting the database.
  const snapshot=await store.export();
  const plain=Buffer.from(JSON.stringify(snapshot));
  if(plain.length>50_000_000) throw new Error('backup_size_limit');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const envelope={version:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')};
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(envelope),{mode:0o600});chmodSync(path,0o600);
  return {path,bytes:encrypted.length,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),schemaVersion:snapshot.schemaVersion};
}
export function decryptBackup(path,keyValue) {
  const key=keyBytes(keyValue);
  let snapshot;
  try {
    const e=JSON.parse(readFileSync(path,'utf8'));
    if(e.version!==1 || e.algorithm!=='aes-256-gcm') throw Error();
    const iv=Buffer.from(e.iv,'base64'),tag=Buffer.from(e.tag,'base64'),encrypted=Buffer.from(e.data,'base64');
    if(iv.length!==12 || tag.length!==16 || encrypted.length>50_000_000) throw Error();
    const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);
    snapshot=JSON.parse(Buffer.concat([d.update(encrypted),d.final()]).toString());
    if(snapshot.schemaVersion!==1 || !snapshot.tables) throw Error();
  } catch { throw new Error('backup_integrity_failed'); }
  return snapshot;
}
export async function remoteReport(store,config,now) {
  const [data,budget]=await Promise.all([store.report(now),store.totals(now)]);
  return {...data,storageBackend:'supabase',dryRun:config.dryRun,termsStop:config.termsStop,
    emergencyStop:config.emergencyStop||data.emergencyStop,budgetTargetYen:config.monthlyBudgetYen,budget,
    warning:'推定額と実請求は異なる可能性があります。請求上限を保証しません。'};
}
