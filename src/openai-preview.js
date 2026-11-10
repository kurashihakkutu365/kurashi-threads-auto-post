import { OpenAIClient } from './ai.js';
import { previewConfig,assertPreviewPolicy,PREVIEW_POLICY } from './preview-policy.js';
import { SupabaseBudget } from './supabase-budget.js';

export async function runOpenAIPreview(store,base,{env=process.env,fetchImpl=fetch,now=new Date()}={}) {
  const config=previewConfig(base);
  assertPreviewPolicy(config,env);
  if(store.kind!=='supabase')throw new Error('openai_preview_requires_supabase');
  const health=await store.health();
  if(health?.schemaVersion!==1||health?.scheduleVersion!==2)throw new Error('supabase_schedule_update_required');
  const budget=new SupabaseBudget(store,config);
  // Reserve via the existing atomic RPC before sending the only OpenAI request.
  const reservedEstimateYen=budget.estimate(PREVIEW_POLICY.maxInputTokens,PREVIEW_POLICY.maxOutputTokens);
  const client=new OpenAIClient(store,config,{env:{...env,OPENAI_API_KEY:env.OPENAI_API_KEY.trim()},fetchImpl,clock:()=>now,oneShotPreview:true});
  const themes=await client.daily([]);
  return {preview:true,published:false,creditsConsumed:true,model:PREVIEW_POLICY.model,requests:1,reservedEstimateYen,assumedUsdJpy:PREVIEW_POLICY.usdJpy,estimatedMaximumUsd:reservedEstimateYen/PREVIEW_POLICY.usdJpy,themes};
}
