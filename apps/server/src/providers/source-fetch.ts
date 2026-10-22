import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';

export const sourceEndpoint = z.object({
  url: z.string().url().max(8192),
  headers: z.record(z.string(), z.string().max(8192)).default({}),
  allowInsecureHttp: z.boolean().default(false)
}).strict();
export type SourceEndpoint = z.infer<typeof sourceEndpoint>;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED = 16 * 1024 * 1024;
// Per-call limits. Only a caller that legitimately reads a large feed raises them, so a normal
// playlist or logo fetch keeps the default ceiling. Both the transferred and the decompressed
// size stay bounded: a small gzip body can inflate without limit.
export type SourceLimits = {maxBytes?: number; maxInflatedBytes?: number};
// Safe diagnostics: numbers, our own enums and the HTTP status. Never a URL, header, body or
// upstream message, any of which may quote the provider's credentials.
export type SourceDetail = {httpStatus?: number; bytes?: number; limit?: number; elapsedMs?: number; compression?: string; network?: string};
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(ip,prefix,'ipv4');
// Permit native global unicast IPv6 only, excluding protocol assignments,
// documentation and 6to4. This also excludes mapped IPv4, NAT64 and link-local.
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(ip,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export function validateEndpoint(input: SourceEndpoint): SourceEndpoint {
  const endpoint = sourceEndpoint.parse(input), url = new URL(endpoint.url);
  requireThat((url.protocol === 'https:' || (url.protocol === 'http:' && endpoint.allowInsecureHttp)) && !url.username && !url.password && !url.hash,
    'SOURCE_ENDPOINT_REJECTED','Use an HTTPS source without userinfo or fragments; HTTP requires explicit administrator opt-in.');
  const headers: Record<string,string> = {};
  for (const [key,value] of Object.entries(endpoint.headers)) {
    const name = key.toLowerCase();
    requireThat(['authorization','user-agent','referer','accept'].includes(name) && !/[\r\n\0]/.test(value) && !(name in headers), 'SOURCE_HEADERS_REJECTED','Source headers are invalid or unsupported.');
    headers[name] = value;
  }
  return {...endpoint,url:url.href,headers};
}
type Address = {address: string; family: number};
export type SourceResponse = {status: number; headers: IncomingHttpHeaders; body: Buffer; complete: boolean};
export type SourceExchange = (url: URL, address: Address, headers: Record<string,string>, signal: AbortSignal, maxBytes?: number) => Promise<SourceResponse>;

// No pooled socket, second DNS lookup, automatic redirect, environment proxy,
// or relaxed TLS verification. The URL retains Host/SNI/certificate identity.
export const exchangeSource: SourceExchange = (url,address,headers,signal,maxBytes=MAX_BYTES) => new Promise((resolve,reject) => {
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    agent:false, signal, headers:{...headers,'accept-encoding':'gzip'}, maxHeaderSize:16384,
    lookup: (_host,_options,callback) => callback(null,[{address:address.address,family:address.family}])
  }, res => {
    let length=0; const chunks:Buffer[]=[];
    res.on('data',(chunk:Buffer) => {
      length += chunk.length;
      if(length>maxBytes) {req.destroy(new SourceFetchError('SOURCE_TOO_LARGE',undefined,{bytes:length,limit:maxBytes}));return;}
      chunks.push(chunk);
    });
    res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode ?? 0,headers:res.headers,body:Buffer.concat(chunks),complete:res.complete}));
  });
  req.on('error',reject); req.setTimeout(10000,()=>req.destroy(new SourceFetchError('SOURCE_TIMEOUT'))); req.end();
});
export class SourceFetchError extends AppError {
  constructor(code: string, public retryAt?: number, public detail: SourceDetail = {}) {super(code,'Source refresh could not be completed.',502);}
}
// Node reports the cause in `code`. Only the code is read: an error message may quote the URL.
const NETWORK: Record<string,string> = {ENOTFOUND:'dns', EAI_AGAIN:'dns', EAI_FAIL:'dns', ECONNREFUSED:'connect', ECONNRESET:'reset', EPIPE:'reset', EHOSTUNREACH:'unreachable', ENETUNREACH:'unreachable', ETIMEDOUT:'timeout'};
function networkFailure(error: unknown, aborted: boolean, elapsedMs: number): SourceFetchError {
  if (aborted) return new SourceFetchError('SOURCE_TIMEOUT',undefined,{elapsedMs});
  const code = typeof (error as {code?: unknown})?.code === 'string' ? (error as {code: string}).code : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return new SourceFetchError('SOURCE_TLS_FAILED',undefined,{network:'tls',elapsedMs});
  const kind = NETWORK[code];
  if (kind === 'dns') return new SourceFetchError('SOURCE_DNS_FAILED',undefined,{network:'dns',elapsedMs});
  if (kind === 'timeout') return new SourceFetchError('SOURCE_TIMEOUT',undefined,{network:'timeout',elapsedMs});
  if (kind) return new SourceFetchError('SOURCE_NETWORK_FAILED',undefined,{network:kind,elapsedMs});
  return new SourceFetchError('SOURCE_FETCH_FAILED',undefined,{elapsedMs});
}
export class RestrictedSourceFetcher {
  constructor(private resolve: (host:string)=>Promise<Address[]> = host=>lookup(host,{all:true,verbatim:true}), private exchange:SourceExchange=exchangeSource) {}
  async fetch(input:SourceEndpoint, signal?:AbortSignal, limits:SourceLimits={}):Promise<Buffer> {
    const endpoint=validateEndpoint(input), initial=new URL(endpoint.url);
    const maxBytes=limits.maxBytes??MAX_BYTES, maxInflated=limits.maxInflatedBytes??MAX_INFLATED, started=Date.now();
    const timeout=AbortSignal.timeout(30000), bounded=signal ? AbortSignal.any([signal,timeout]) : timeout;
    try {
      let url=initial;
      for(let redirects=0;redirects<=3;redirects++) {
        bounded.throwIfAborted();
        const host=url.hostname.replace(/^\[|\]$/g,'');
        // Race DNS against deadline as OS resolver cancellation is unavailable.
        const records=await abortable(isIP(host) ? Promise.resolve([{address:host,family:isIP(host)}]) : this.resolve(host),bounded);
        requireThat(records.length>0 && records.every(r=>publicAddress(r.address) && isIP(r.address)===r.family), 'SOURCE_ADDRESS_REJECTED','Source must resolve exclusively to public addresses.');
        const response=await abortable(this.exchange(url,records[0]!,endpoint.headers,bounded,maxBytes),bounded);
        if([301,302,303,307,308].includes(response.status)) {
          requireThat(redirects<3 && typeof response.headers.location==='string','SOURCE_REDIRECT_REJECTED','Source redirect rejected.');
          const next=new URL(response.headers.location,url);
          requireThat(next.origin===initial.origin && !next.username && !next.password && !next.hash,'SOURCE_REDIRECT_REJECTED','Only redirects within the approved source origin are allowed.');
          url=next; continue;
        }
        if(response.status===429 || response.status===503) {
          const raw=response.headers['retry-after']; let at=Date.now()+60000;
          if(typeof raw==='string') {const delta=/^\d+$/.test(raw) ? Date.now()+Number(raw)*1000 : Date.parse(raw);if(Number.isFinite(delta)) at=Math.max(at,Math.min(delta,Date.now()+7*86400000));}
          throw new SourceFetchError('SOURCE_RATE_LIMITED',at,{httpStatus:response.status,elapsedMs:Date.now()-started});
        }
        // A rejected request is not an unreachable provider: the status is carried into the diagnostic.
        if(response.status!==200) throw new SourceFetchError('SOURCE_HTTP_STATUS',undefined,{httpStatus:response.status,elapsedMs:Date.now()-started});
        // A truncated 200 is an incomplete response, not a rejected one. Both incomplete cases
        // carry the same code, so callers can treat them as one retryable stage.
        const length=response.headers['content-length'];
        if(!response.complete || response.body.length===0 || response.body.length>maxBytes ||
          (length!==undefined && !(typeof length==='string' && /^\d+$/.test(length) && Number(length)===response.body.length)))
          throw new SourceFetchError('SOURCE_INCOMPLETE',undefined,{bytes:response.body.length,elapsedMs:Date.now()-started});
        const encoding=response.headers['content-encoding'];
        requireThat(encoding===undefined || encoding==='identity' || encoding==='gzip','SOURCE_ENCODING_REJECTED','Unsupported source compression.');
        const gzip=encoding==='gzip' || (response.body[0]===0x1f && response.body[1]===0x8b);
        let bytes:Buffer;
        if(gzip) {
          try { bytes=gunzipSync(response.body,{maxOutputLength:maxInflated}); }
          // A size refusal is distinct from corrupt compression: one is a configured ceiling, the other a bad body.
          catch(error) { if((error as {code?:string}).code==='ERR_BUFFER_TOO_LARGE') throw new SourceFetchError('SOURCE_DECOMPRESSION_LIMIT',undefined,{bytes:response.body.length,limit:maxInflated,compression:'gzip',elapsedMs:Date.now()-started}); throw new SourceFetchError('SOURCE_INVALID_GZIP',undefined,{bytes:response.body.length,compression:'gzip',elapsedMs:Date.now()-started}); }
          if(bytes.length>maxInflated) throw new SourceFetchError('SOURCE_DECOMPRESSION_LIMIT',undefined,{limit:maxInflated,compression:'gzip',elapsedMs:Date.now()-started});
        } else bytes=response.body;
        try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
        catch { throw new SourceFetchError('SOURCE_INVALID_TEXT',undefined,{bytes:bytes.length,elapsedMs:Date.now()-started}); }
        return bytes;
      }
      throw new SourceFetchError('SOURCE_REDIRECT_REJECTED');
    } catch(e) {
      if(e instanceof AppError) throw e;
      throw networkFailure(e,bounded.aborted,Date.now()-started);
    }
  }
}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new SourceFetchError('SOURCE_TIMEOUT'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
