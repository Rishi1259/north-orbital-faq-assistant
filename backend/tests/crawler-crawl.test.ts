import {it,expect,vi} from 'vitest';
import {crawl,type StoredPage} from '../src/sources/crawl.js';
import {CrawlerEnvironmentSchema,CrawlError} from '../src/sources/config.js';
import type {Transport} from '../src/sources/http.js';
const config=CrawlerEnvironmentSchema.parse({CRAWLER_REQUEST_DELAY_MS:0}),seed='https://example.com/';
const embed=vi.fn(async(texts:string[])=>texts.map(()=>Array(1024).fill(0.1)));
function fixture(options:{missingSitemap?:boolean;mime?:string;links?:boolean;missing?:boolean;depth?:boolean;bad?:boolean}={}) {
  const visited:string[]=[];
  const transport:Transport=async(url)=>{
    visited.push(url.pathname);
    if(url.pathname==='/robots.txt')return {url:url.href,status:404,headers:{},body:''};
    if(url.pathname==='/sitemap.xml')return {url:url.href,status:options.missingSitemap?404:200,headers:{},body:options.depth?'<sitemapindex><sitemap><loc>https://example.com/deeper.xml</loc></sitemap></sitemapindex>':'<urlset/>'};
    if(url.pathname==='/deeper.xml')return {url:url.href,status:200,headers:{},body:'<urlset/>'};
    if(options.bad)throw new CrawlError('TIMEOUT',true);
    return {url:url.href,status:options.missing?404:200,headers:{'content-type':options.mime??'text/html'},body:`<main><h1>Visible</h1><p>Useful content</p>${options.links?'<a href="/a">A</a><a href="/b#x">B</a><a href="/a#dup">Again</a>':''}</main>`};
  };return {transport,visited};
}
it('falls back to deterministic breadth-first links without sitemap',async()=>{const f=fixture({missingSitemap:true,links:true});const r=await crawl(seed,[],config,{embed},f.transport);expect(r.pages.map(p=>p.url)).toEqual([seed,seed+'a',seed+'b']);expect(r.complete).toBe(true);});
it('page bound makes enumeration incomplete without unsafe removals',async()=>{const f=fixture({links:true});const r=await crawl(seed,[],{...config,CRAWLER_MAX_PAGES_PER_SOURCE:1},{embed},f.transport);expect(r.pages).toHaveLength(1);expect(r.complete).toBe(false);});
it('depth bound prevents fetching children',async()=>{const f=fixture({links:true});const r=await crawl(seed,[],{...config,CRAWLER_MAX_DEPTH:0},{embed},f.transport);expect(r.pages).toHaveLength(1);expect(f.visited).not.toContain('/a');expect(r.complete).toBe(false);});
it('sitemap depth bound fails conservatively',async()=>{await expect(crawl(seed,[],{...config,CRAWLER_MAX_SITEMAP_DEPTH:0},{embed},fixture({depth:true}).transport)).rejects.toMatchObject({code:'SITEMAP_LIMIT'});});
it.each(['application/pdf','image/png','application/octet-stream'])('rejects MIME %s',async mime=>{await expect(crawl(seed,[],config,{embed},fixture({mime}).transport)).rejects.toMatchObject({code:'UNSUPPORTED_CONTENT_TYPE'});});
it('explicit 404 marks a known page removed',async()=>{const r=await crawl(seed,[],config,{embed},fixture({missing:true}).transport);expect(r.pages[0]!.removed).toBe(true);});
it('fresh content hash avoids embedding and 304 retains discovery links',async()=>{
  const f=fixture();const first=await crawl(seed,[],config,{embed},f.transport);const page=first.pages[0]!;
  const old:StoredPage={id:'fixture',canonical_url:seed,content_hash:page.hash,etag:'v1',last_modified:null,links:[],state:'active',title:page.title};embed.mockClear();
  const r=await crawl(seed,[old],config,{embed},f.transport);expect(r.pages[0]!.unchanged).toBe(true);expect(embed).not.toHaveBeenCalled();
});
it('restored content re-embeds after removal',async()=>{const f=fixture();const first=await crawl(seed,[],config,{embed},f.transport);const p=first.pages[0]!;embed.mockClear();await crawl(seed,[{id:'id',canonical_url:seed,content_hash:p.hash,etag:'v1',last_modified:null,links:[],state:'removed',title:p.title}],config,{embed},f.transport);expect(embed).toHaveBeenCalled();});
it('navigation links are discovered but not indexed, and link truncation forbids removal',async()=>{
  const f=fixture();const network:Transport=async(url,h,b,s)=>url.pathname==='/'?{url:url.href,status:200,headers:{'content-type':'text/html',etag:'v1'},body:'<nav>Menu<a href="/a">A</a><a href="/b">B</a></nav><main>Useful content</main>'}:f.transport(url,h,b,s);
  const r=await crawl(seed,[],{...config,CRAWLER_MAX_LINKS_PER_PAGE:1},{embed},network);
  expect(r.pages.map(p=>p.url)).toEqual([seed,seed+'a']);expect(r.pages[0]!.chunks[0]!.text).toBe('Useful content');expect(r.pages[0]!.etag).toBeNull();expect(r.complete).toBe(false);
});
