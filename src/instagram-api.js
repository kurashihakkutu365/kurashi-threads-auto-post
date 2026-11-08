export function instagramApiBase(config) {
  const version=config.api?.instagramVersion;
  // Keep the previous Instagram Login behavior for old configs; new configs explicitly select Unified Login.
  const mode=config.api?.instagramLoginMode??'instagram';
  if(!/^v\d+\.\d+$/.test(version??'') || !['unified','instagram'].includes(mode)) throw new Error('instagram_api_config_invalid');
  return `https://graph.${mode==='unified'?'facebook':'instagram'}.com/${version}`;
}
