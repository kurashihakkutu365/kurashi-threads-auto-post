// Reviewed official standard text rates; refresh the review date only after checking the source.
export const PREVIEW_POLICY=Object.freeze({model:'gpt-5.4-mini-2026-03-17',inputUsdPerMillion:0.75,outputUsdPerMillion:4.5,verifiedAt:'2026-11-11T00:00:00+09:00',maxInputTokens:8000,maxOutputTokens:1200,usdJpy:200});
export function previewConfig(base) {
  const c=structuredClone(base),p=PREVIEW_POLICY;
  Object.assign(c,{usdJpy:p.usdJpy,maxAiCallsPerDay:1,maxAiTokensPerDay:Math.min(c.maxAiTokensPerDay,p.maxInputTokens+p.maxOutputTokens),monthlyBudgetYen:Math.min(c.monthlyBudgetYen,1000),textBudgetYen:Math.min(c.textBudgetYen,200)});
  c.aiLimits={maxInputTokens:p.maxInputTokens,maxOutputTokens:p.maxOutputTokens,maxVisionInputTokens:null};
  c.pricing={model:p.model,version:'standard-text-2026-11-11',inputUsdPerMillion:p.inputUsdPerMillion,outputUsdPerMillion:p.outputUsdPerMillion,verifiedAt:p.verifiedAt};
  return c;
}
export function assertPreviewPolicy(c,env) {
  const p=PREVIEW_POLICY;
  if(env.OPENAI_PREVIEW_APPROVED!=='true')throw new Error('openai_preview_confirmation_required');
  if(c.dryRun!==true||c.paidAiEnabled!==false||c.production.enabled!==false||c.emergencyStop||c.termsStop)throw new Error('openai_preview_stopped');
  if(c.pricing.model!==p.model||c.pricing.inputUsdPerMillion!==p.inputUsdPerMillion||c.pricing.outputUsdPerMillion!==p.outputUsdPerMillion||c.pricing.verifiedAt!==p.verifiedAt||c.usdJpy!==p.usdJpy||c.aiLimits.maxInputTokens!==p.maxInputTokens||c.aiLimits.maxOutputTokens!==p.maxOutputTokens||c.aiLimits.maxVisionInputTokens!==null||c.maxAiCallsPerDay!==1||c.maxAiTokensPerDay>9200||c.monthlyBudgetYen>1000||c.textBudgetYen>200)throw new Error('openai_preview_policy_invalid');
  if(![c.monthlyBudgetYen,c.textBudgetYen,c.maxAiTokensPerDay].every(n=>Number.isFinite(n)&&n>0))throw new Error('openai_preview_policy_invalid');
  if(typeof env.OPENAI_API_KEY!=='string'||!env.OPENAI_API_KEY.trim()||/[\r\n]/.test(env.OPENAI_API_KEY.trim()))throw new Error('openai_key_missing_or_invalid');
}
