import { readFileSync } from 'node:fs';

export function loadConfig(path = new URL('../config/default.json', import.meta.url), env = process.env) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  // Either source requesting dry-run/stop wins. A single environment override cannot unlock production.
  c.dryRun = c.dryRun !== false || env.DRY_RUN !== 'false';
  c.emergencyStop = c.emergencyStop || env.EMERGENCY_STOP === 'true';
  if (!Number.isFinite(c.monthlyBudgetYen) || c.monthlyBudgetYen <= 0) throw new Error('invalid_budget');
  return c;
}

export function assertProduction(c, env = process.env) {
  if (c.dryRun) throw new Error('dry_run_only');
  if (c.emergencyStop || c.termsStop) throw new Error('all_stopped');
  const p = c.production;
  if (!p.enabled || !p.persistentDatabaseVerified || !p.permissionsVerified || !p.hardBillingLimitVerified ||
      !p.termsVerifiedAt || Date.parse(p.termsVerifiedAt)>Date.now() || Date.now() - Date.parse(p.termsVerifiedAt) > 31 * 86400000 || !Number.isFinite(Date.parse(p.termsVerifiedAt))) throw new Error('production_not_approved');
  for (const [sns, prefix] of [['threads', 'THREADS'], ['instagram', 'INSTAGRAM']]) {
    if (c.platforms[sns] && (!env[`${prefix}_ACCESS_TOKEN`] || !env[`${prefix}_USER_ID`])) throw new Error('missing_credentials');
  }
}
