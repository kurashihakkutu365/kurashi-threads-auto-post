// A deliberately read-only connection path. Do not import a publisher or instantiate a database here.
export async function checkThreadsConnection(config,{env=process.env,fetchImpl=fetch}={}) {
  if(config.dryRun!==true) throw new Error('threads_check_requires_dry_run');
  if(config.emergencyStop || config.termsStop || config.platforms?.threads!==true) throw new Error('threads_check_stopped');
  const token=typeof env.THREADS_ACCESS_TOKEN==='string'?env.THREADS_ACCESS_TOKEN.trim():'';
  if(!token) throw new Error('threads_token_missing');
  if(/[\r\n]/.test(token) || token.length>8192) throw new Error('threads_token_format_invalid');
  const expected=(env.THREADS_EXPECTED_USERNAME??'').trim().replace(/^@/,'').toLowerCase();
  if(!/^[a-z0-9._]{1,30}$/.test(expected)) throw new Error('threads_expected_username_required');
  const expectedId=(env.THREADS_USER_ID??'').trim();
  if(expectedId && !/^\d{1,32}$/.test(expectedId)) throw new Error('threads_user_id_invalid');
  const version=config.api?.threadsVersion;
  if(!/^v\d+\.\d+$/.test(version??'')) throw new Error('threads_api_version_invalid');
  // The credential is in the header, never a URL, error, file, output or artifact.
  const url=`https://graph.threads.com/${version}/me?fields=id,username`;
  let response;
  try {
    response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},
      redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  } catch { throw new Error('threads_connection_failed'); }
  if(response.status===401) throw new Error('threads_token_invalid_or_expired');
  if(response.status===403) throw new Error('threads_basic_permission_required');
  if(response.status===429) throw new Error('threads_rate_limited');
  let profile;
  try { profile=await response.json(); }
  catch { throw new Error('threads_response_invalid'); }
  if(profile?.error || !response.ok) {
    const code=profile?.error?.code;
    if(code===190) throw new Error('threads_token_invalid_or_expired');
    if(code===10 || code===200) throw new Error('threads_basic_permission_required');
    throw new Error('threads_api_error');
  }
  if(!profile || typeof profile.id!=='string' || !/^\d{1,32}$/.test(profile.id) ||
      typeof profile.username!=='string' || !/^[a-zA-Z0-9._]{1,30}$/.test(profile.username)) throw new Error('threads_response_invalid');
  if(profile.username.toLowerCase()!==expected || (expectedId && expectedId!==profile.id)) throw new Error('threads_account_mismatch');
  return {connected:true,platform:'threads',username:expected,userId:profile.id,dryRun:true,
    publishingTested:false,replyPermissionsVerified:false,tokenExpiryVerified:false};
}
