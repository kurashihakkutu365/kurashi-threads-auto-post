export class ApiError extends Error {
  constructor(code,status=0) { super(code); this.status=status; }
}
export async function request(url, { method='GET', headers={}, body, fetchImpl=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms)), retries=3, timeoutMs=20000, now=()=>Date.now(), random=Math.random } = {}) {
  for (let attempt=0; attempt<=retries; attempt++) {
    let res;
    try { res=await fetchImpl(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)}); }
    catch { throw new ApiError(method==='GET'?'network_error':'ambiguous_send'); }
    // Never retry POST: a response or socket failure may hide a successful write.
    if (method==='GET' && [429,502,503,504].includes(res.status) && attempt<retries) {
      const retry=res.headers.get('retry-after');
      const seconds=retry===null?NaN:Number(retry);
      const delay=retry===null?2**attempt*1000+Math.floor(random()*300):Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-now();
      if (!Number.isFinite(delay) || delay>60000) throw new ApiError('retry_deferred',res.status);
      await sleep(Math.max(delay,0)); continue;
    }
    if (!res.ok) throw new ApiError(res.status===401?'token_expired':res.status===429?'rate_limited':'api_error',res.status);
    try { return await res.json(); } catch { throw new ApiError(method==='GET'?'invalid_json':'ambiguous_send'); }
  }
}
