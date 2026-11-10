import { request } from './http.js';
import { assertProduction } from './config.js';
import { validateImage } from './rights.js';
import { instagramApiBase } from './instagram-api.js';

export class MockPublisher {
  constructor(sns) { this.sns=sns; this.calls=[]; this.fail=null; this.dryRunSafe=true; }
  async prepare(payload) {
    this.calls.push(['prepare',payload]);
    if (payload.kind==='product' && payload.images.length!==2) throw new Error('two_licensed_images_required');
    return `mock-container-${this.sns}-${this.calls.length}`;
  }
  async publish(container) {
    this.calls.push(['publish',container]);
    if (this.fail) throw new Error(this.fail);
    return `mock-post-${this.sns}-${this.calls.length}`;
  }
  async status() { return 'FINISHED'; }
  async reconcile() { return {state:'unknown'}; }
}

// Protocol implementation for verified official endpoints. Never instantiated by the CLI.
// Authentication/app review, live limit lookup and persistent production store are separate release gates.
export class MetaPublisher {
  constructor(sns,{config,env=process.env,fetchImpl=fetch}) {
    assertProduction(config,env);
    if (!['threads','instagram'].includes(sns)) throw new Error('unsupported_platform');
    this.sns=sns; this.config=config; this.fetchImpl=fetchImpl;
    this.user=env[sns==='threads'?'THREADS_USER_ID':'INSTAGRAM_USER_ID'];
    this.token=env[sns==='threads'?'THREADS_ACCESS_TOKEN':'INSTAGRAM_ACCESS_TOKEN'];
    const version=sns==='threads'?config.api.threadsVersion:config.api.instagramVersion;
    if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(this.user)) throw new Error('invalid_api_config');
    this.base=sns==='threads'?`https://graph.threads.com/${version}`:instagramApiBase(config);
  }
  async call(path,data) {
    if (this.config.emergencyStop || this.config.termsStop || !this.config.platforms[this.sns]) throw new Error('platform_stopped');
    const options={headers:{Authorization:`Bearer ${this.token}`},fetchImpl:this.fetchImpl};
    if (data) Object.assign(options,{method:'POST',body:new URLSearchParams(data)});
    return request(`${this.base}/${path}`,options);
  }
  async prepare(payload) {
    if(payload.images.some(i=>i.dryRunOnly))throw new Error('dry_run_image_not_publishable');
    if (payload.kind==='product' && payload.images.length!==2) throw new Error('two_licensed_images_required');
    for (const image of payload.images) validateImage(image,this.sns,new Date(),{site:this.sns==='instagram' && payload.kind==='product'&&this.config.productCopyMode!=='ranked'});
    if (payload.kind==='product' && new Set(payload.images.map(i=>i.hash)).size!==2) throw new Error('two_licensed_images_required');
    const endpoint=this.sns==='threads'?'threads':'media';
    const captionKey=this.sns==='threads'?'text':'caption';
    if (!payload.images.length && this.sns==='instagram') throw new Error('image_required');
    if (payload.images.length<2) {
      const i=payload.images[0];
      const data={ [captionKey]:payload.text, ...(i?{image_url:i.publicUrl}:{}), ...(this.sns==='threads'?{media_type:i?'IMAGE':'TEXT'}:{}) };
      return (await this.call(`${this.user}/${endpoint}`,data)).id;
    }
    const children=[];
    for (const i of payload.images) {
      const data={image_url:i.publicUrl,is_carousel_item:'true',...(this.sns==='threads'?{media_type:'IMAGE'}:{})};
      const child=await this.call(`${this.user}/${endpoint}`,data);
      if (!child.id) throw new Error('container_missing');
      children.push(child.id);
    }
    const parent=await this.call(`${this.user}/${endpoint}`,{media_type:'CAROUSEL',children:children.join(','),[captionKey]:payload.text});
    if (!parent.id) throw new Error('container_missing');
    return parent.id;
  }
  async status(container) {
    if (!/^\d+$/.test(container)) throw new Error('invalid_container');
    const r=await this.call(`${container}?fields=${this.sns==='threads'?'status':'status_code'}`);
    return r.status_code ?? r.status;
  }
  async publish(container) {
    const endpoint=this.sns==='threads'?'threads_publish':'media_publish';
    const r=await this.call(`${this.user}/${endpoint}`,{creation_id:container});
    if (!r.id) throw new Error('ambiguous_send');
    return r.id;
  }
  async reconcile(container) {
    const status=await this.status(container);
    // Container status alone cannot identify the published media. Retain an unknown hold until a verified media ID is reconciled.
    return {state:'unknown',containerStatus:status};
  }
}
