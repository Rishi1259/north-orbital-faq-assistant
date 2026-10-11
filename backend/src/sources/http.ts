import http from 'node:http';
import https from 'node:https';
import { CrawlError, type CrawlerConfig } from './config.js';
import { pinnedAddress, scopedUrl, type Resolver } from './url.js';
export interface RemoteResponse { url:string; status:number; headers:Record<string,string>; body:string }
export type Transport = (url:URL, headers:Record<string,string>, maxBytes:number, signal:AbortSignal)=>Promise<RemoteResponse>;
export function createTransport(resolver?: Resolver): Transport {
  return async(url,headers,maxBytes,signal)=>{
    const pinned=await Promise.race([pinnedAddress(url,resolver),new Promise<never>((_,reject)=>{
      if(signal.aborted) reject(new CrawlError('TIMEOUT',true));
      else signal.addEventListener('abort',()=>reject(new CrawlError('TIMEOUT',true)),{once:true});
    })]);
    if(signal.aborted) throw new CrawlError('TIMEOUT',true);
    return new Promise((resolve,reject)=>{
      const options:https.RequestOptions={
        method:'GET',headers,agent:false,signal,family:pinned.family,rejectUnauthorized:true,
        // No independent DNS lookup can occur after validation. URL hostname is
        // retained for Host, SNI, and standard certificate verification.
        lookup:(_host,_options,callback)=>callback(null,pinned.address,pinned.family),
      };
      const req=(url.protocol==='https:'?https:http).request(url,options,res=>{
        let bytes=0; const chunks:Buffer[]=[];
        const fail=(error:CrawlError)=>{res.destroy();req.destroy();reject(error);};
        if(res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') return fail(new CrawlError('UNSUPPORTED_ENCODING'));
        if(Number(res.headers['content-length']??0)>maxBytes) return fail(new CrawlError('BODY_TOO_LARGE'));
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxBytes)fail(new CrawlError('BODY_TOO_LARGE'));else chunks.push(chunk);});
        res.on('error',()=>reject(new CrawlError('NETWORK_FAILED',true)));
        res.on('end',()=>resolve({url:url.href,status:res.statusCode??0,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v??''])),body:Buffer.concat(chunks).toString('utf8')}));
      });
      req.on('error',()=>reject(new CrawlError(signal.aborted?'TIMEOUT':'NETWORK_FAILED',true)));
      req.end();
    });
  };
}
export class SafeFetcher {
  private bytes=0;
  private deadline:number;
  constructor(readonly config:CrawlerConfig, readonly origin:string, private transport:Transport=createTransport()) {
    this.deadline=Date.now()+config.CRAWLER_TOTAL_TIMEOUT_MS;
  }
  async get(input:string,maxBytes=this.config.CRAWLER_MAX_RESPONSE_BYTES,conditional:Record<string,string>={},allowed?:(url:URL)=>boolean):Promise<RemoteResponse> {
    let url=scopedUrl(input,this.origin);
    for(let hop=0;hop<=this.config.CRAWLER_MAX_REDIRECTS;hop++) {
      if(allowed && !allowed(url))throw new CrawlError('ROBOTS_DISALLOWED');
      const remaining=this.deadline-Date.now();if(remaining<=0)throw new CrawlError('CRAWL_TIMEOUT',true);
      const signal=AbortSignal.timeout(Math.min(remaining,this.config.CRAWLER_REQUEST_TIMEOUT_MS));
      const response=await this.transport(url,{'user-agent':this.config.CRAWLER_USER_AGENT,accept:'text/html, text/plain, application/xml, text/xml','accept-encoding':'identity',...conditional},Math.min(maxBytes,this.config.CRAWLER_MAX_TOTAL_BYTES-this.bytes),signal);
      this.bytes+=Buffer.byteLength(response.body);
      if(this.bytes>this.config.CRAWLER_MAX_TOTAL_BYTES || Buffer.byteLength(response.body)>maxBytes)throw new CrawlError('BODY_TOO_LARGE');
      if([301,302,303,307,308].includes(response.status)) {
        url=scopedUrl(response.headers.location??'',this.origin,url.href);continue;
      }
      if(response.status===429 || response.status>=500) {
        const retry=Number(response.headers['retry-after']);
        throw new CrawlError('REMOTE_TEMPORARY',true,Number.isFinite(retry)?Math.min(3600,Math.max(0,retry)):0);
      }
      return response;
    }
    throw new CrawlError('REDIRECT_LIMIT');
  }
}
