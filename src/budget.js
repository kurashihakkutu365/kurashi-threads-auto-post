import { randomUUID } from 'node:crypto';
import { jstDay, jstMonth } from './time.js';

export class Budget {
  constructor(store, config) { this.store = store; this.c = config; }
  totals(now = new Date()) {
    return this.store.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN MAX(reserved,COALESCE(actual_billed,0)) ELSE MAX(estimated,COALESCE(actual_billed,0)) END),0) committed, COALESCE(SUM(estimated),0) estimated, SUM(actual_billed) actualBilled FROM usage WHERE month=?`).get(jstMonth(now));
  }
  mode(now = new Date()) {
    const ratio = this.totals(now).committed / this.c.monthlyBudgetYen;
    return ratio >= 1 ? 'stop' : ratio >= .95 ? 'paid_stop' : ratio >= .85 ? 'essential_only' : ratio >= .7 ? 'vision_stop' : 'normal';
  }
  reserve({ category, service, maximumYen, maximumTokens = 0, essential = false }, now = new Date()) {
    if (!Number.isFinite(maximumYen) || maximumYen <= 0 || !Number.isInteger(maximumTokens) || maximumTokens < 0) throw new Error('invalid_reservation');
    if (this.c.emergencyStop || this.c.termsStop || this.store.setting('emergencyStop')) throw new Error('all_stopped');
    return this.store.transaction(() => {
      const mode = this.mode(now);
      if (['stop','paid_stop'].includes(mode) || (category === 'vision' && mode !== 'normal') || (mode === 'essential_only' && !essential)) throw new Error('budget_throttled');
      if (this.totals(now).committed + maximumYen > this.c.monthlyBudgetYen) throw new Error('monthly_budget');
      const used = this.store.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN MAX(reserved,COALESCE(actual_billed,0)) ELSE MAX(estimated,COALESCE(actual_billed,0)) END),0) n FROM usage WHERE month=? AND category=?`).get(jstMonth(now),category).n;
      const cap = category === 'vision' ? this.c.visionBudgetYen : category === 'text' ? this.c.textBudgetYen : this.c.monthlyBudgetYen;
      if (used + maximumYen > cap) throw new Error('category_budget');
      const daily = this.store.db.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(tokens),0) tokens FROM usage WHERE day=?`).get(jstDay(now));
      if (daily.calls >= this.c.maxAiCallsPerDay || daily.tokens + maximumTokens > this.c.maxAiTokensPerDay) throw new Error('daily_ai_limit');
      const id = randomUUID();
      this.store.db.prepare('INSERT INTO usage(id,month,day,category,service,state,reserved,tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,jstMonth(now),jstDay(now),category,service,'reserved',maximumYen,maximumTokens,now.toISOString());
      return id;
    });
  }
  settle(id, estimatedYen, tokens) {
    const r = this.store.db.prepare('SELECT * FROM usage WHERE id=?').get(id);
    if (!r || r.state !== 'reserved' || !Number.isFinite(estimatedYen) || estimatedYen < 0 || !Number.isInteger(tokens) || tokens < 0) throw new Error('invalid_settlement');
    // Even an unexpectedly larger bill is recorded; stop future work instead of hiding it.
    this.store.db.prepare("UPDATE usage SET state='settled',estimated=?,tokens=? WHERE id=?").run(estimatedYen,tokens,id);
  }
  recordBill(id,actualYen) {
    if (!Number.isFinite(actualYen) || actualYen<0) throw new Error('invalid_bill');
    if (this.store.db.prepare('UPDATE usage SET actual_billed=? WHERE id=?').run(actualYen,id).changes!==1) throw new Error('unknown_reservation');
  }
  estimate(inputTokens, outputTokens) {
    const p = this.c.pricing;
    if (!p.model || !p.version || !p.verifiedAt || !Number.isFinite(this.c.usdJpy) || this.c.usdJpy <= 0 ||
        ![p.inputUsdPerMillion,p.outputUsdPerMillion].every(v => Number.isFinite(v) && v > 0) ||
        Date.now() - Date.parse(p.verifiedAt) > 31*86400000 || !Number.isFinite(Date.parse(p.verifiedAt))) throw new Error('pricing_unverified');
    if (![inputTokens,outputTokens].every(n => Number.isInteger(n) && n >= 0)) throw new Error('invalid_token_count');
    return (inputTokens*p.inputUsdPerMillion + outputTokens*p.outputUsdPerMillion) / 1e6 * this.c.usdJpy;
  }
}
