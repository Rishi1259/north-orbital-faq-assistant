import { load } from 'cheerio';
import { SaxesParser } from 'saxes';
import { createHash } from 'node:crypto';
import { CrawlError, type CrawlerConfig } from './config.js';
import { scopedUrl } from './url.js';
import type { SafeFetcher } from './http.js';
export const hashContent=(text:string)=>createHash('sha256').update(text).digest('hex');
const whitespace=(text:string)=>text.replace(/\s+/g,' ').trim();
// RFC-style percent normalization: unreserved octets are equivalent; encoded
// delimiters remain encoded. The bounded glob matcher avoids regex backtracking.
const robotsPath=(value:string)=>value.replace(/[^\x21-\x7e]/gu,c=>encodeURIComponent(c)).replace(/%[0-9a-f]{2}/gi,hex=>{
  const c=String.fromCharCode(Number.parseInt(hex.slice(1),16));return /[A-Za-z0-9._~-]/.test(c)?c:hex.toUpperCase();
});
function pathMatch(pattern:string,text:string){
  const exact=pattern.endsWith('$');if(exact)pattern=pattern.slice(0,-1);else pattern+='*';
  let p=0,t=0,star=-1,back=0;
  while(t<text.length){if(pattern[p]===text[t]){p++;t++;}else if(pattern[p]==='*'){star=p++;back=t;}else if(star>=0){p=star+1;t=++back;}else return false;}
  while(pattern[p]==='*')p++;return p===pattern.length;
}
export function parseRobots(text:string,userAgent:string) {
  const groups:{agents:string[];rules:{path:string;allow:boolean}[]}[]=[];
  let group:typeof groups[number]|undefined; let ruled=false;const sitemaps:string[]=[];
  for(const line of text.split(/\r?\n/)) {
    const match=/^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0]!);if(!match)continue;
    const key=match[1]!.toLowerCase(),value=match[2]!;
    if(value.length>2048 || groups.length>1000)throw new CrawlError('ROBOTS_LIMIT');
    if(key==='sitemap'){sitemaps.push(value);continue;}
    if(key==='user-agent') {if(!group||ruled){group={agents:[],rules:[]};groups.push(group);ruled=false;}group.agents.push(value.toLowerCase());}
    else if(group && (key==='allow'||key==='disallow')) {ruled=true;if(value)group.rules.push({path:robotsPath(value),allow:key==='allow'});if(group.rules.length>1000)throw new CrawlError('ROBOTS_LIMIT');}
  }
  const agent=userAgent.toLowerCase();
  const specificity=(g:typeof groups[number])=>Math.max(-1,...g.agents.map(a=>a==='*'?0:agent.includes(a)?a.length:-1));
  const best=Math.max(-1,...groups.map(specificity));
  const rules=best<0?[]:groups.filter(g=>specificity(g)===best).flatMap(g=>g.rules);
  return {sitemaps,allowed:(url:URL)=>{
    const path=robotsPath(url.pathname+url.search);
    const matches=rules.filter(r=>pathMatch(r.path,path))
      .sort((a,b)=>b.path.replace(/\*/g,'').length-a.path.replace(/\*/g,'').length || Number(b.allow)-Number(a.allow));
    return matches[0]?.allow??true;
  }};
}
export async function robots(fetcher:SafeFetcher) {
  const response=await fetcher.get(`${fetcher.origin}/robots.txt`,512000);
  if(response.status===404)return parseRobots('',fetcher.config.CRAWLER_USER_AGENT);
  if(response.status!==200)throw new CrawlError('ROBOTS_UNAVAILABLE',response.status>=500);
  return parseRobots(response.body,fetcher.config.CRAWLER_USER_AGENT);
}
export function parseSitemap(xml:string,maxUrls:number) {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new CrawlError('INVALID_SITEMAP');
  const parser=new SaxesParser({xmlns:true});const stack:string[]=[];let root='';let value='';const urls:string[]=[];
  parser.on('opentag',tag=>{stack.push(tag.local);if(stack.length===1)root=tag.local;if(stack.length>8)throw new CrawlError('INVALID_SITEMAP');if(tag.local==='loc')value='';});
  parser.on('text',text=>{if(stack.at(-1)==='loc')value+=text;});
  parser.on('closetag',()=>{if(stack.at(-1)==='loc'){urls.push(value.trim());if(urls.length>maxUrls)throw new CrawlError('SITEMAP_LIMIT');}stack.pop();});
  try{parser.write(xml).close();}catch(e){if(e instanceof CrawlError)throw e;throw new CrawlError('INVALID_SITEMAP');}
  if(!['sitemapindex','urlset'].includes(root))throw new CrawlError('INVALID_SITEMAP');
  return {index:root==='sitemapindex',urls};
}
export async function discoverSitemaps(fetcher:SafeFetcher,policy:ReturnType<typeof parseRobots>) {
  const config=fetcher.config,seen=new Set<string>(),pages=new Set<string>();
  const queue=(policy.sitemaps.length?policy.sitemaps:[`${fetcher.origin}/sitemap.xml`]).map(url=>({url,depth:0}));
  while(queue.length) {
    const item=queue.shift()!;const url=scopedUrl(item.url,fetcher.origin).href;
    if(seen.has(url))continue;
    if(item.depth>config.CRAWLER_MAX_SITEMAP_DEPTH || seen.size>=config.CRAWLER_MAX_SITEMAP_DOCUMENTS)throw new CrawlError('SITEMAP_LIMIT');
    seen.add(url);const response=await fetcher.get(url,config.CRAWLER_MAX_SITEMAP_BYTES,{},policy.allowed);
    if(response.status===404 && !policy.sitemaps.length && item.depth===0)continue;
    if(response.status!==200)throw new CrawlError('SITEMAP_UNAVAILABLE');
    const sitemap=parseSitemap(response.body,config.CRAWLER_MAX_SITEMAP_URLS);
    for(const location of sitemap.urls) {
      const next=scopedUrl(location,fetcher.origin).href;
      if(sitemap.index)queue.push({url:next,depth:item.depth+1});else pages.add(next);
      if(pages.size>config.CRAWLER_MAX_SITEMAP_URLS || queue.length>config.CRAWLER_MAX_SITEMAP_DOCUMENTS)throw new CrawlError('SITEMAP_LIMIT');
    }
  }
  return [...pages].sort();
}
const binary=/\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|tar|exe|dmg|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|avi|woff2?|css|js)$/i;
export function extractPage(body:string,url:string,config:CrawlerConfig,plain=false) {
  if(plain){const text=whitespace(body);return {title:new URL(url).pathname,text,hash:hashContent(text),links:[] as string[],truncated:false};}
  const $=load(body);const title=whitespace($('title').first().text()||$('h1').first().text()||new URL(url).pathname).slice(0,300);
  $('script,style,noscript,template,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"]').remove();
  const links=new Set<string>();
  const truncated=$('a[href]').length>config.CRAWLER_MAX_LINKS_PER_PAGE;
  $('a[href]').slice(0,config.CRAWLER_MAX_LINKS_PER_PAGE).each((_,element)=>{try{const link=scopedUrl($(element).attr('href')!,new URL(url).origin,url);if(!binary.test(link.pathname))links.add(link.href);}catch{/* Foreign/invalid links are not crawl candidates. */}});
  $('nav,header,footer,aside,form').remove();
  const main=$('main').first().length?$('main').first():$('article').first().length?$('article').first():$('body');
  main.find('p,h1,h2,h3,h4,h5,h6,li,tr,div,br').each((_,element)=>{$(element).prepend(' ').append(' ');});
  const text=whitespace(main.text());
  return {title,text,hash:hashContent(title+'\n'+text),links:[...links],truncated};
}
