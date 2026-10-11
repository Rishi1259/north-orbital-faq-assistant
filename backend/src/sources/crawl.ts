import { setTimeout as delay } from 'node:timers/promises';
import { CrawlError, type CrawlerConfig } from './config.js';
import { SafeFetcher, type Transport } from './http.js';
import { discoverSitemaps, extractPage, robots, hashContent } from './discovery.js';
import { scopedUrl } from './url.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { validateVector } from '../rag/repository.js';
export interface StoredPage { id:string; canonical_url:string; content_hash:string|null; etag:string|null; last_modified:string|null; links:string[]; state:string; title:string }
export interface PreparedPage { url:string; title:string; hash:string|null; etag:string|null; modified:string|null; links:string[]; status:number; mime:string; unchanged:boolean; removed:boolean; chunks:{text:string;hash:string;vector:number[]}[] }
export interface CrawlResult { pages:PreparedPage[]; complete:boolean }
export function splitContent(text:string,max:number) {
  // Same 140-word/30-word overlap principle as document chunking, with an
  // additional character cap for hostile very long tokens and FAQ prose.
  const words=text.match(/\S{1,200}/g)??[];const chunks:string[]=[];
  let i=0;
  while(i<words.length){
    let end=i,chars=0;
    while(end<words.length && end-i<140 && chars+words[end]!.length+1<=8000){chars+=words[end]!.length+1;end++;}
    chunks.push(words.slice(i,end).join(' '));if(chunks.length>max)throw new CrawlError('CHUNK_LIMIT');
    if(end>=words.length)break;i=Math.max(i+1,end-30);
  }
  return chunks;
}
export async function crawl(seed:string,existing:StoredPage[],config:CrawlerConfig,embeddings:EmbeddingProvider,transport?:Transport):Promise<CrawlResult> {
  const started=Date.now(),origin=new URL(seed).origin,fetcher=new SafeFetcher(config,origin,transport);
  const policy=await robots(fetcher);if(!policy.allowed(new URL(seed)))throw new CrawlError('ROBOTS_DISALLOWED');
  const sitemap=await discoverSitemaps(fetcher,policy);
  const queue=[...new Set([seed,...sitemap])].map(url=>({url,depth:0}));
  const seen=new Set<string>(),old=new Map(existing.map(p=>[p.canonical_url,p])),pages:PreparedPage[]=[];
  let complete=true,totalChunks=0;
  while(queue.length) {
    if(Date.now()-started>=config.CRAWLER_TOTAL_TIMEOUT_MS)throw new CrawlError('CRAWL_TIMEOUT',true);
    const item=queue.shift()!;const url=scopedUrl(item.url,origin).href;if(seen.has(url))continue;
    if(seen.size>=config.CRAWLER_MAX_PAGES_PER_SOURCE){complete=false;break;}
    seen.add(url);if(!policy.allowed(new URL(url))) {complete=false;continue;}
    const previous=old.get(url),conditional:Record<string,string>={};
    if(previous && ['active','unchanged'].includes(previous.state)) {
      if(previous.etag)conditional['if-none-match']=previous.etag;
      if(previous.last_modified)conditional['if-modified-since']=previous.last_modified;
    }
    await delay(config.CRAWLER_REQUEST_DELAY_MS);
    const response=await fetcher.get(url,config.CRAWLER_MAX_RESPONSE_BYTES,conditional,policy.allowed);
    if([404,410].includes(response.status)) {pages.push({url,title:previous?.title??'',hash:null,etag:null,modified:null,links:[],status:response.status,mime:'',unchanged:false,removed:true,chunks:[]});continue;}
    if(response.status===304 && (!previous || !Object.keys(conditional).length))throw new CrawlError('INVALID_NOT_MODIFIED');
    if(![200,304].includes(response.status))throw new CrawlError('PAGE_UNAVAILABLE');
    const mime=(response.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();
    if(response.status!==304 && !['text/html','text/plain'].includes(mime))throw new CrawlError('UNSUPPORTED_CONTENT_TYPE');
    const extracted=response.status===304?{title:previous!.title,hash:previous!.content_hash,text:'',links:previous!.links,truncated:previous!.links.length>=config.CRAWLER_MAX_LINKS_PER_PAGE}:extractPage(response.body,response.url,config,mime==='text/plain');
    if(extracted.truncated)complete=false;
    if(response.status!==304 && !extracted.text)throw new CrawlError('EMPTY_CONTENT');
    const unchanged=!!previous && ['active','unchanged'].includes(previous.state) && previous.content_hash===extracted.hash;
    const chunks:PreparedPage['chunks']=[];
    if(!unchanged) {
      const texts=splitContent(extracted.text,config.CRAWLER_MAX_CHUNKS_PER_PAGE);totalChunks+=texts.length;
      if(totalChunks>config.CRAWLER_MAX_CHUNKS_PER_RUN)throw new CrawlError('CHUNK_LIMIT');
      for(const text of texts) {
        if(Date.now()-started>=config.CRAWLER_TOTAL_TIMEOUT_MS)throw new CrawlError('CRAWL_TIMEOUT',true);
        let timer:ReturnType<typeof setTimeout>|undefined;
        const vectors=await Promise.race([embeddings.embed([text]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new CrawlError('CRAWL_TIMEOUT',true)),Math.max(1,config.CRAWLER_TOTAL_TIMEOUT_MS-(Date.now()-started)));})]).finally(()=>clearTimeout(timer));
        const [vector]=vectors;if(!vector)throw new CrawlError('EMBEDDING_FAILED',true);validateVector(vector);
        chunks.push({text,hash:hashContent(text),vector});
      }
    }
    pages.push({url,title:extracted.title,hash:extracted.hash,etag:extracted.truncated?null:(response.headers.etag??previous?.etag??null)?.slice(0,500)??null,
      modified:extracted.truncated?null:(response.headers['last-modified']??previous?.last_modified??null)?.slice(0,100)??null,links:extracted.links,
      status:response.status,mime:response.status===304?'text/html':mime,unchanged,removed:false,chunks});
    for(const link of extracted.links) {
      if(seen.has(link) || queue.some(q=>q.url===link))continue;
      if(item.depth>=config.CRAWLER_MAX_DEPTH || queue.length>=config.CRAWLER_MAX_SITEMAP_URLS){complete=false;continue;}
      queue.push({url:link,depth:item.depth+1});
    }
  }
  return {pages,complete};
}
