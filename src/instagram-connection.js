import { instagramApiBase } from './instagram-api.js';

const validId=value=>typeof value==='string'&&/^\d{1,32}$/.test(value);
const validUsername=value=>typeof value==='string'&&/^[a-zA-Z0-9._]{1,30}$/.test(value);

export async function checkInstagramConnection(config,{env=process.env,fetchImpl=fetch}={}) {
  if(config.dryRun!==true) throw new Error('instagram_check_requires_dry_run');
  if(config.emergencyStop || config.termsStop || config.platforms?.instagram!==true) throw new Error('instagram_check_stopped');
  if(config.api?.instagramLoginMode!=='unified') throw new Error('instagram_check_requires_unified_login');
  const base=instagramApiBase(config);
  const token=typeof env.INSTAGRAM_ACCESS_TOKEN==='string'?env.INSTAGRAM_ACCESS_TOKEN.trim():'';
  if(!token) throw new Error('instagram_token_missing');
  if(/[\r\n]/.test(token)) throw new Error('instagram_token_format_invalid');
  const expected=(env.INSTAGRAM_EXPECTED_USERNAME??'').trim().replace(/^@/,'').toLowerCase();
  if(!validUsername(expected)) throw new Error('instagram_expected_username_required');
  let accountId=(env.INSTAGRAM_USER_ID??'').trim();
  if(accountId&&!validId(accountId)) throw new Error('instagram_user_id_invalid');
  async function read(path,params) {
    const url=new URL(`${base}/${path}`);url.search=new URLSearchParams(params).toString();
    let response;
    try { response=await fetchImpl(url.href,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}); }
    catch { throw new Error('instagram_connection_failed'); }
    if(response.status===401) throw new Error('instagram_token_invalid_or_expired');
    if(response.status===403) throw new Error('instagram_basic_permission_required');
    if(response.status===429) throw new Error('instagram_rate_limited');
    let data;
    try { data=await response.json(); } catch { throw new Error('instagram_response_invalid'); }
    if(data?.error||!response.ok) {
      if(data?.error?.code===190) throw new Error('instagram_token_invalid_or_expired');
      if([10,200].includes(data?.error?.code)) throw new Error('instagram_basic_permission_required');
      throw new Error('instagram_api_error');
    }
    return data;
  }
  if(!accountId) {
    // /me is a system user in Unified Login, not the Instagram account. Discover only assigned IG assets.
    let after;
    const seen=new Set();
    for(let page=0;page<3;page++) {
      const data=await read('me/assigned_instagram_accounts',{fields:'id,username',...(after?{after}:{})});
      if(!data||!Array.isArray(data.data)||data.data.some(p=>!validId(p?.id)||!validUsername(p?.username))) throw new Error('instagram_response_invalid');
      const matches=data.data.filter(p=>p.username.toLowerCase()===expected);
      if(matches.length>1) throw new Error('instagram_account_ambiguous');
      if(matches.length===1) { accountId=matches[0].id;break; }
      if(!data.paging?.next) throw new Error('instagram_account_not_found');
      after=data.paging?.cursors?.after;
      // Never follow paging.next: it may contain a credential or point at an unexpected host.
      if(typeof after!=='string'||!after||after.length>4096||/[\r\n]/.test(after)||after.includes(token)||seen.has(after)) throw new Error('instagram_pagination_invalid');
      seen.add(after);
    }
    if(!accountId) throw new Error('instagram_discovery_limit');
  }
  const profile=await read(accountId,{fields:'id,username'});
  if(!profile||!validId(profile.id)||!validUsername(profile.username)) throw new Error('instagram_response_invalid');
  if(profile.id!==accountId||profile.username.toLowerCase()!==expected) throw new Error('instagram_account_mismatch');
  return {connected:true,platform:'instagram',loginMode:'unified',username:expected,userId:profile.id,dryRun:true,
    publishingTested:false,replyPermissionsVerified:false,tokenExpiryVerified:false};
}
