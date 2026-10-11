import { describe,it,expect,vi } from 'vitest';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import { normalizeUrl,publicAddress,pinnedAddress } from '../src/sources/url.js';
import { SafeFetcher,createTransport,type Transport } from '../src/sources/http.js';
import { CrawlerEnvironmentSchema } from '../src/sources/config.js';
import { parseRobots,parseSitemap,robots,discoverSitemaps,extractPage } from '../src/sources/discovery.js';
const config=CrawlerEnvironmentSchema.parse({}),origin='https://example.com';
const fixture=(responses:Record<string,{status?:number;body?:string;headers?:Record<string,string>}>):Transport=>async url=>({url:url.href,status:responses[url.pathname]?.status??200,headers:responses[url.pathname]?.headers??{},body:responses[url.pathname]?.body??''});
describe('URL and address policy',()=>{
  it.each(['http://example.com','https://EXAMPLE.com:443/a/../b?q=1#x'])('accepts public URL %s',url=>expect(normalizeUrl(url).origin).toMatch(/^https?:\/\/example.com$/));
  it('preserves meaningful query order and default ports',()=>expect(normalizeUrl('https://EXAMPLE.com:443/a/../b?q=1&q=2#x').href).toBe('https://example.com/b?q=1&q=2'));
  it.each(['file:///etc/passwd','ftp://example.com','gopher://example.com','data:text/html,x','javascript:alert(1)','mailto:x@example.com','tel:123','unix:/tmp/sock','https://user:password@example.com','http://localhost','http://127.0.0.1','http://[::1]','http://10.1.2.3','http://172.16.1.1','http://192.168.1.1','http://169.254.1.1','http://169.254.169.254','http://168.63.129.16','http://[::ffff:127.0.0.1]','http://[fc00::1]','http://[fe80::1]','http://[ff02::1]','http://100.64.0.1','http://224.0.0.1','http://255.255.255.255','http://metadata.google.internal','http://2130706433','http://0x7f000001','http://127.1'])('rejects %s',url=>expect(()=>normalizeUrl(url)).toThrow());
  it('allows global IPv6 and rejects transition/documentation ranges',()=>{expect(publicAddress('2606:4700::1111')).toBe(true);for(const ip of ['2001:db8::1','2002:7f00:1::','2001::1','3fff::1'])expect(publicAddress(ip)).toBe(false);});
  it('rejects mixed public/private DNS results',async()=>{await expect(pinnedAddress(normalizeUrl(origin),async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}])).rejects.toMatchObject({code:'ADDRESS_BLOCKED'});});
  it('blocks a rebinding resolver before any connection',async()=>{const resolver=vi.fn().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValue([{address:'127.0.0.1',family:4}]);await pinnedAddress(normalizeUrl(origin),resolver);await expect(createTransport(resolver)(normalizeUrl(origin),{},100,AbortSignal.timeout(100))).rejects.toMatchObject({code:'ADDRESS_BLOCKED'});});
});
describe('bounded fetching',()=>{
  it('pins the actual connection lookup while preserving Host/SNI and mandatory TLS verification',async()=>{
    const resolver=vi.fn().mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValue([{address:'127.0.0.1',family:4}]);
    let captured:any;let target:URL|undefined;
    const spy=vi.spyOn(https,'request').mockImplementation(((url:URL,options:any,callback:any)=>{
      captured=options;target=url;const req=new EventEmitter() as any;req.destroy=()=>{};
      req.end=()=>{const response=new EventEmitter() as any;response.headers={};response.statusCode=200;response.destroy=()=>{};callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from('ok'));response.emit('end');});};return req;
    }) as any);
    try{
      await createTransport(resolver)(normalizeUrl(origin),{},100,AbortSignal.timeout(1000));
      const connected=await new Promise((resolve,reject)=>captured.lookup('example.com',{},(e:any,address:string)=>e?reject(e):resolve(address)));
      expect(connected).toBe('8.8.8.8');expect(resolver).toHaveBeenCalledTimes(1);expect(target?.hostname).toBe('example.com');expect(captured.rejectUnauthorized).toBe(true);expect(captured.agent).toBe(false);
    }finally{spy.mockRestore();}
  });
  it('bounds DNS resolution timeout',async()=>{
    await expect(createTransport(async()=>new Promise(()=>{}))(normalizeUrl(origin),{},100,AbortSignal.timeout(20))).rejects.toMatchObject({code:'TIMEOUT'});
  });
  it.each([{headers:{'content-length':'999'},body:'x',code:'BODY_TOO_LARGE'},{headers:{'content-encoding':'gzip'},body:'x',code:'UNSUPPORTED_ENCODING'},{headers:{},body:'oversized',code:'BODY_TOO_LARGE'}])('bounds transport response $code',async fixture=>{
    const spy=vi.spyOn(https,'request').mockImplementation(((_url:any,_options:any,callback:any)=>{
      const req=new EventEmitter() as any;req.destroy=()=>{};req.end=()=>{const response=new EventEmitter() as any;response.statusCode=200;response.headers=fixture.headers;response.destroy=()=>{};callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from(fixture.body));response.emit('end');});};return req;
    }) as any);
    try{await expect(createTransport(async()=>[{address:'8.8.8.8',family:4}])(normalizeUrl(origin),{},3,AbortSignal.timeout(1000))).rejects.toMatchObject({code:fixture.code});}finally{spy.mockRestore();}
  });
  it.each(['http://127.0.0.1/','https://other.example/'])('rejects redirect %s',async location=>{await expect(new SafeFetcher(config,origin,fixture({'/':{status:302,headers:{location}}})).get(origin)).rejects.toThrow();});
  it('limits redirects',async()=>{await expect(new SafeFetcher(config,origin,fixture({'/':{status:302,headers:{location:'/'}}})).get(origin)).rejects.toMatchObject({code:'REDIRECT_LIMIT'});});
  it('bounds body bytes even for injected transports',async()=>{await expect(new SafeFetcher(config,origin,fixture({'/':{body:'abcd'}})).get(origin,3)).rejects.toMatchObject({code:'BODY_TOO_LARGE'});});
  it('classifies 429 and bounds retry-after',async()=>{await expect(new SafeFetcher(config,origin,fixture({'/':{status:429,headers:{'retry-after':'999999'}}})).get(origin)).rejects.toMatchObject({code:'REMOTE_TEMPORARY',retryable:true,retryAfter:3600});});
});
describe('robots and sitemaps',()=>{
  it('obeys groups, longest match and allow ties',()=>{const p=parseRobots('User-agent: *\nDisallow: /\nUser-agent: NorthOrbitalKnowledgeCrawler\nDisallow: /private\nAllow: /private/public\nSitemap: https://example.com/map.xml',config.CRAWLER_USER_AGENT);expect(p.allowed(new URL(origin+'/private'))).toBe(false);expect(p.allowed(new URL(origin+'/private/public'))).toBe(true);expect(p.allowed(new URL(origin+'/docs'))).toBe(true);expect(p.sitemaps).toHaveLength(1);});
  it('allows missing robots and fails closed on temporary errors',async()=>{expect((await robots(new SafeFetcher(config,origin,fixture({'/robots.txt':{status:404}})))).allowed(new URL(origin))).toBe(true);await expect(robots(new SafeFetcher(config,origin,fixture({'/robots.txt':{status:500}})))).rejects.toThrow();});
  it('discovers robots sitemap indexes',async()=>{const f=new SafeFetcher(config,origin,fixture({'/map.xml':{body:'<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>'},'/child.xml':{body:'<urlset><url><loc>https://example.com/a</loc></url></urlset>'}}));expect(await discoverSitemaps(f,parseRobots('Sitemap: https://example.com/map.xml',config.CRAWLER_USER_AGENT))).toEqual([origin+'/a']);});
  it('uses conventional fallback',async()=>{expect(await discoverSitemaps(new SafeFetcher(config,origin,fixture({'/sitemap.xml':{body:'<urlset><url><loc>https://example.com/a</loc></url></urlset>'}})),parseRobots('',config.CRAWLER_USER_AGENT))).toEqual([origin+'/a']);});
  it.each(['<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>','<urlset><url></urlset>','<html/>'])('rejects malformed/unsafe XML',xml=>expect(()=>parseSitemap(xml,10)).toThrow());
  it('bounds URL enumeration',()=>expect(()=>parseSitemap('<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>',1)).toThrow());
  it.each(['https://other.example/a','http://169.254.169.254/'])('rejects unsafe sitemap URL %s',async url=>{await expect(discoverSitemaps(new SafeFetcher(config,origin,fixture({'/sitemap.xml':{body:`<urlset><url><loc>${url}</loc></url></urlset>`}})),parseRobots('',config.CRAWLER_USER_AGENT))).rejects.toThrow();});
  it('extracts visible content and only bounded normalized same-origin links',()=>{const p=extractPage('<title>Test</title><nav>Noise</nav><main><h1>Useful</h1><p>Hello</p><script>evil()</script><i hidden>hidden</i><a href="/a#x">A</a><a href="/a">A</a>'+['mailto:a@b.com','tel:12','javascript:alert(1)','data:text/html,x','/x.pdf','https://other.example/a'].map(h=>`<a href="${h}">x</a>`).join('')+'</main>',origin,config);expect(p.links).toEqual([origin+'/a']);expect(p.text).toContain('Useful Hello');expect(p.text).not.toMatch(/Noise|evil|hidden/);});
});

it('robots percent-normalization and wildcard rules cannot be bypassed by encoded unreserved paths',()=>{
  const p=parseRobots('User-agent: *\nDisallow: /private\nDisallow: /*?secret=*\nAllow: /private/public$',config.CRAWLER_USER_AGENT);
  expect(p.allowed(new URL(origin+'/%70rivate'))).toBe(false);
  expect(p.allowed(new URL(origin+'/private/public'))).toBe(true);
  expect(p.allowed(new URL(origin+'/private/public/child'))).toBe(false);
  expect(p.allowed(new URL(origin+'/a?secret=x'))).toBe(false);
});

it('does not apply a robots group intended exclusively for another crawler',()=>{
  expect(parseRobots('User-agent: Googlebot\nDisallow: /',config.CRAWLER_USER_AGENT).allowed(new URL(origin))).toBe(true);
});
