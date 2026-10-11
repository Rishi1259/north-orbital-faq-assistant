import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { CrawlError } from './config.js';
export function publicAddress(address: string): boolean {
  if(address==='168.63.129.16')return false; // Azure platform virtual address
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number) as [number,number,number];
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) ||
      (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
      (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (family === 6) {
    // Only global unicast 2000::/3. Exclude special-use, documentation,
    // transition/tunnel ranges; mapped IPv4 is deliberately never accepted.
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1,-1).toLowerCase();
    const first = Number.parseInt(canonical.split(':')[0]!,16);
    return first>=0x2000 && first<=0x3fff && !(first===0x2001 && (Number.parseInt(canonical.split(':')[1]||'0',16)<=0x1ff || canonical.startsWith('2001:db8:'))) &&
      !canonical.startsWith('2002:') && !canonical.startsWith('3fff:');
  }
  return false;
}
export function normalizeUrl(input: string, base?: string): URL {
  if (input.length>2048 || /[\u0000-\u0020\u007f\\]/.test(input)) throw new CrawlError('INVALID_URL');
  let url: URL;
  try { url = base ? new URL(input,base) : new URL(input); } catch { throw new CrawlError('INVALID_URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new CrawlError('INVALID_URL');
  url.hash='';
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if (host.endsWith('.') || !host.includes('.') && !isIP(host) || /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) ||
      ['metadata.google.internal','metadata.goog','instance-data.ec2.internal'].includes(host) || (isIP(host) && !publicAddress(host))) throw new CrawlError('ADDRESS_BLOCKED');
  if (url.href.length>2048) throw new CrawlError('INVALID_URL');
  return url;
}
export function scopedUrl(input: string, origin: string, base?: string) {
  const url=normalizeUrl(input,base);
  if(url.origin!==origin) throw new CrawlError('CROSS_ORIGIN');
  return url;
}
export type Resolver = (host: string) => Promise<{address:string;family:number}[]>;
export const resolvePublic: Resolver = host => lookup(host,{all:true,verbatim:true});
export async function pinnedAddress(url: URL, resolver: Resolver = resolvePublic) {
  const host=url.hostname.replace(/^\[|\]$/g,'');
  let addresses;
  try { addresses=isIP(host) ? [{address:host,family:isIP(host)}] : await resolver(host); }
  catch { throw new CrawlError('DNS_FAILED',true); }
  if (!addresses.length) throw new CrawlError('DNS_FAILED',true);
  if(addresses.some(a=>!publicAddress(a.address) || isIP(a.address)!==a.family)) throw new CrawlError('ADDRESS_BLOCKED');
  return addresses[0]!;
}
