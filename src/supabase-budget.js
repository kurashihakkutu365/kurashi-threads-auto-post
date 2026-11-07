import { Budget } from './budget.js';

export class SupabaseBudget extends Budget {
  totals(now=new Date()) { return this.store.totals(now); }
  async mode(now=new Date()) {
    const ratio=(await this.totals(now)).committed/this.c.monthlyBudgetYen;
    return ratio>=1?'stop':ratio>=.95?'paid_stop':ratio>=.85?'essential_only':ratio>=.7?'vision_stop':'normal';
  }
  async reserve(request,now=new Date()) {
    const c=this.c;
    // Configuration and the reservation are checked atomically in PostgreSQL, not in a read-then-write REST sequence.
    return this.store.reserve(request,{
      emergencyStop:c.emergencyStop,termsStop:c.termsStop,monthlyBudgetYen:c.monthlyBudgetYen,
      visionBudgetYen:c.visionBudgetYen,textBudgetYen:c.textBudgetYen,
      maxAiCallsPerDay:c.maxAiCallsPerDay,maxAiTokensPerDay:c.maxAiTokensPerDay,
    },now);
  }
  settle(id,estimatedYen,tokens) { return this.store.settle(id,estimatedYen,tokens); }
  recordBill(id,actualYen) { return this.store.recordBill(id,actualYen); }
}
