import { z } from 'zod';
import { AppError } from '../errors.js';
import { RestrictedSourceFetcher, SourceFetchError, type SourceDetail, type SourceEndpoint, type SourceLimits } from './source-fetch.js';
import { parseXmltv, xmltvTime, type M3uChannel, type M3uSnapshot, type Program, type XmlSnapshot } from './iptv.js';

// Xtream Codes provider adapter. It speaks only the documented player_api.php and
// xmltv.php interfaces: no DRM handling, no panel scraping and no provider-specific
// shortcuts. Everything here is server-side; provider credentials stay in the vault
// and are never part of a value returned to a browser.
const MAX_CATALOGUE = 20000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const hasControl = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value);

export class XtreamError extends AppError {
  constructor(code: string, message: string, status = 502, retryable = false, public detail: SourceDetail = {}) { super(code, message, status, retryable); }
}
// Every rejection in this adapter is an XtreamError, so callers can tell provider failures
// apart from internal faults without inspecting messages.
function ensure(condition: unknown, code: string, message: string, status = 502): asserts condition {
  if (!condition) throw new XtreamError(code, message, status);
}

export const xtreamCredentials = z.object({
  serverUrl: z.string().trim().min(1).max(2048),
  username: z.string().min(1).max(128).refine(value => !hasControl(value), 'Username contains control characters.'),
  password: z.string().min(1).max(128).refine(value => !hasControl(value), 'Password contains control characters.'),
  // Xtream panels are frequently plain HTTP on a non-standard port; that stays an explicit choice.
  allowInsecureHttp: z.boolean().default(false)
}).strict();
export type XtreamCredentials = z.infer<typeof xtreamCredentials>;

export type XtreamEndpoint = { serverUrl: string; allowInsecureHttp: boolean };
// Normalises the administrator's server address. The credentials never appear in it,
// and a URL that already names an endpoint is rejected rather than silently re-based.
export function normalizeXtreamEndpoint(input: {serverUrl: string; allowInsecureHttp?: boolean}): XtreamEndpoint {
  const raw = z.string().trim().min(1).max(2048).parse(input.serverUrl);
  let url: URL;
  try { url = new URL(raw); } catch { throw new XtreamError('XTREAM_ENDPOINT_REJECTED', 'Enter the provider server address, for example https://provider.example:8080.', 400); }
  const allowInsecureHttp = input.allowInsecureHttp === true;
  ensure(!url.username && !url.password && !url.search && !url.hash, 'XTREAM_ENDPOINT_REJECTED', 'The provider address must not contain credentials, a query or a fragment.', 400);
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && allowInsecureHttp), 'XTREAM_ENDPOINT_REJECTED', 'Use an HTTPS provider address; HTTP requires explicit administrator opt-in.', 400);
  const path = url.pathname.replace(/\/+$/, '');
  ensure(!/\/(player_api|panel_api|get|xmltv)\.php$/i.test(path), 'XTREAM_ENDPOINT_REJECTED', 'Enter the server address only; the adapter adds the API endpoint.', 400);
  return { serverUrl: `${url.origin}${path}`, allowInsecureHttp };
}

export type XtreamCategory = { id: string; name: string; parentId?: string };
export type XtreamLiveStream = {
  streamId: string; name: string; categoryId: string; icon?: string; epgChannelId?: string;
  container: 'ts' | 'm3u8'; archive: boolean;
};
// A playlist-shaped channel plus the provider identifiers the catalogue API pages by.
export type XtreamChannel = M3uChannel & { streamId: string; categoryId: string };
export type XtreamAccount = {
  status: 'active' | 'inactive'; expiresAt: number | null; isTrial: boolean;
  maxConnections: number | null; activeConnections: number | null;
  allowedFormats: string[]; timezone: string | null;
};
export type XtreamCatalogue = {
  version: 1; fetchedAt: number; account: XtreamAccount;
  categories: XtreamCategory[]; channels: XtreamChannel[]; ignoredStreams: number;
  epg?: XmlSnapshot; epgError?: string;
  // The guide outcome, kept separate from the catalogue outcome. Present on every import that
  // considered a guide, so a partial fallback is never presented as a complete guide.
  guide?: GuideStatus;
};
export type XtreamCataloguePage = {
  categories: XtreamCategory[]; total: number; offset: number; limit: number; hasMore: boolean;
  channels: { streamId: string; name: string; group: string; tvgId: string; logo: string }[];
  fetchedAt: number; ignoredStreams: number; epgPrograms: number;
};
// What actually happened to the guide, separately from the catalogue. A guide failure never
// becomes an account or catalogue failure, and a partial fallback is never reported as complete.
export type GuideState = 'available' | 'partial' | 'unmatched' | 'empty' | 'failed' | 'disabled';
export type GuideDiagnostic = {
  // Sanitised code only: never a URL, body or upstream message.
  code?: string;
  httpStatus?: number;
  elapsedMs?: number;
  bytes?: number;
  limit?: number;
  compression?: string;
  parsedChannels?: number;
  parsedPrograms?: number;
  rejected?: number;
};
export type GuideStatus = {
  // The guide actually in use.
  source: 'xmltv' | 'short_epg' | 'none';
  state: GuideState;
  code?: string;
  elapsedMs?: number;
  parsedChannels?: number;
  parsedPrograms?: number;
  rejected?: number;
  // Fallback accounting: requests attempted, answered, refused, and channels left uncovered.
  requested?: number;
  succeeded?: number;
  skipped?: number;
  mappedChannels?: number;
  // The primary XMLTV attempt, kept even when a fallback succeeded, so a recovery is visible and
  // an old failure is not repeated as a current one.
  primary?: GuideDiagnostic & {state: 'available' | 'unmatched' | 'empty' | 'failed'};
};
// Transport-level fields are merged into a diagnostic without ever carrying a URL or a body.
const numericDetail = (detail: SourceDetail): GuideDiagnostic => ({
  ...(detail.httpStatus ? {httpStatus: detail.httpStatus} : {}),
  ...(detail.elapsedMs !== undefined ? {elapsedMs: detail.elapsedMs} : {}),
  ...(detail.bytes !== undefined ? {bytes: detail.bytes} : {}),
  ...(detail.limit !== undefined ? {limit: detail.limit} : {}),
  ...(detail.compression ? {compression: detail.compression} : {})
});
// A short-EPG request is bounded in count, concurrency and wall time, so a large lineup cannot
// turn one refresh into thousands of provider calls.
const SHORT_EPG_CHANNELS = 40;
const SHORT_EPG_CONCURRENCY = 4;
const SHORT_EPG_BUDGET_MS = 20000;
// The provider's XMLTV feed is legitimately larger than a playlist. These are explicit ceilings,
// measured against a real 20.6 MiB feed, and apply only to this fetch path.
const XMLTV_GUIDE_LIMITS = {maxBytes: 16 * 1024 * 1024, maxInflatedBytes: 64 * 1024 * 1024};
const XMLTV_PARSE_LIMITS = {maxBytes: 64 * 1024 * 1024, maxProgrammes: 500000};

// get_short_epg returns a channel's listings as JSON, sometimes base64-encoded. Only the
// documented fields are read; malformed rows are dropped rather than failing the refresh.
const shortEpgSchema = z.object({ epg_listings: z.array(z.record(z.string(), z.unknown())) }).passthrough();
// Provider text arrives either as plain UTF-8 or as base64 of it. Base64 has no spaces, is a
// multiple of four characters and round-trips exactly, so all three must hold before decoding:
// a plain title such as "Midday News" or "News" is otherwise valid base64 alphabetically.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export function decodeGuideText(value: unknown, max = 4096): string | undefined {
  const raw = textOf(value, max);
  if (!raw) return undefined;
  if (raw.length % 4 !== 0 || !BASE64.test(raw)) return raw;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw) return raw;
  let decoded: string;
  // A fatal decoder is what keeps plain text safe: lenient decoding turns stray bytes into
  // replacement characters that would pass a printable-character check.
  try { decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { return raw; }
  if (!decoded || CONTROL.test(decoded)) return raw;
  return decoded.slice(0, max);
}
// A guide instant is accepted only from an unambiguous representation. A wall-clock string with
// no offset is resolved in the provider's own timezone, never this machine's.
const PLAUSIBLE_MIN = Date.UTC(2000, 0, 1) / 1000;
const PLAUSIBLE_MAX = Date.UTC(2100, 0, 1) / 1000;
function unixSeconds(value: unknown) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : undefined;
  return number !== undefined && Number.isSafeInteger(number) && number >= PLAUSIBLE_MIN && number < PLAUSIBLE_MAX ? number * 1000 : undefined;
}
// Offset of `timeZone` at `instant`, in milliseconds. Intl is the only timezone data available here.
function zoneOffset(instant: number, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
    const at = (name: string) => Number(parts.find(part => part.type === name)?.value);
    const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'));
    return Number.isFinite(asUtc) ? asUtc - instant : undefined;
  } catch { return undefined; }
}
// Wall-clock time in a named zone to an instant. Two passes settle the offset across a DST edge.
function localTime(value: string, timeZone?: string | null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || !timeZone) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(part => Number(part ?? 0)) as [number, number, number, number, number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(naive).getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  const first = zoneOffset(naive, timeZone);
  if (first === undefined) return undefined;
  const settled = zoneOffset(naive - first, timeZone);
  return naive - (settled ?? first);
}
export function guideInstant(value: unknown, timeZone?: string | null) {
  if (typeof value === 'number') return unixSeconds(value);
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d{10,12}$/.test(raw)) return unixSeconds(raw);
  if (/^\d{14}\s+[+-]\d{4}$/.test(raw)) { try { return xmltvTime(raw); } catch { return undefined; } }
  // ISO 8601 with an explicit offset is self-describing and needs no provider timezone.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const instant = Date.parse(raw);
    return Number.isFinite(instant) ? instant : undefined;
  }
  return localTime(raw, timeZone);
}
export type ShortEpgParse = {programs: Program[]; rejected: number; ambiguous: number};
// `xmlId` is the provider's guide identity (tvgId), never the stream id used to request the data.
export function parseShortEpgDetailed(input: unknown, xmlId: string, timeZone?: string | null, now = Date.now()): ShortEpgParse {
  const parsed = shortEpgSchema.safeParse(input);
  ensure(parsed.success, 'XTREAM_INVALID_RESPONSE', 'The provider returned an unexpected guide response.');
  const programs: Program[] = []; let rejected = 0, ambiguous = 0;
  for (const row of parsed.data.epg_listings.slice(0, 2000)) {
    const title = decodeGuideText(row.title, 300);
    // Unix seconds are the provider's own field and win over a wall-clock rendering of the same slot.
    const start = unixSeconds(row.start_timestamp) ?? guideInstant(row.start, timeZone);
    const end = unixSeconds(row.stop_timestamp) ?? guideInstant(row.end, timeZone);
    if (start === undefined || end === undefined) {
      if (!timeZone && row.start !== undefined) ambiguous++; else rejected++;
      continue;
    }
    if (!(end > start) || !title) { rejected++; continue; }
    const description = decodeGuideText(row.description, 1200);
    programs.push({channelId: xmlId, start, end, title, ...(description ? {description} : {})});
  }
  // Two listings for one channel claiming the same airtime are ambiguous, exactly as in the
  // primary parser: keep the earliest and drop the rest rather than invent an ordering.
  const unique = [...new Map(programs.map(program => [`${program.start}:${program.end}:${program.title}`, program])).values()]
    .filter(program => program.end > now - 86400000)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: Program[] = []; let overlap = 0;
  for (const program of unique) {
    if (accepted.length && program.start < accepted[accepted.length - 1]!.end) { overlap++; continue; }
    accepted.push(program);
  }
  return {programs: accepted, rejected: rejected + (programs.length - accepted.length), ambiguous};
}
export function parseShortEpg(input: unknown, xmlId: string, timeZone?: string | null): Program[] {
  return parseShortEpgDetailed(input, xmlId, timeZone).programs;
}
const textOf = (value: unknown, max: number) => typeof value === 'string' || typeof value === 'number' ? text(value, max) : undefined;

const numberish = (value: unknown) => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value.trim())) return Number(value);
  return undefined;
};
const positiveId = (value: unknown) => {
  const number = numberish(value);
  return number !== undefined && number > 0 ? String(number) : undefined;
};
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const cleaned = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
};
const truthy = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
const webIcon = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href.slice(0, 2048) : undefined;
  } catch { return undefined; }
};

// Categories are metadata only. Malformed entries are dropped rather than failing a whole
// catalogue, but the response itself must still be a JSON array.
export function parseLiveCategories(input: unknown): XtreamCategory[] {
  ensure(Array.isArray(input), 'XTREAM_INVALID_RESPONSE', 'The provider returned an unexpected category list.');
  ensure(input.length <= 2000, 'IMPORT_LIMIT', 'The provider returned too many categories.', 413);
  const seen = new Set<string>(), categories: XtreamCategory[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>, id = positiveId(row.category_id), name = text(row.category_name, 200);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const parentId = positiveId(row.parent_id);
    categories.push({ id, name, ...(parentId && parentId !== '0' ? { parentId } : {}) });
  }
  return categories;
}

export function parseLiveStreams(input: unknown): { streams: XtreamLiveStream[]; ignored: number } {
  ensure(Array.isArray(input), 'XTREAM_INVALID_RESPONSE', 'The provider returned an unexpected live channel list.');
  ensure(input.length <= MAX_CATALOGUE * 4, 'IMPORT_LIMIT', 'The provider returned too many live channels.');
  const seen = new Set<string>(), streams: XtreamLiveStream[] = []; let ignored = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object') { ignored++; continue; }
    const row = item as Record<string, unknown>, streamId = positiveId(row.stream_id), name = text(row.name, 200);
    if (!streamId || !name || seen.has(streamId)) { ignored++; continue; }
    // Only live-capable containers are accepted; anything else cannot be relayed as live TV.
    const container = text(row.container_extension, 12)?.toLowerCase() === 'm3u8' ? 'm3u8' : 'ts';
    seen.add(streamId);
    const icon = webIcon(row.stream_icon), epgChannelId = text(row.epg_channel_id, 128);
    const categoryId = positiveId(row.category_id);
    streams.push({ streamId, name, categoryId: categoryId ?? '', container, archive: truthy(row.tv_archive),
      ...(icon ? { icon } : {}), ...(epgChannelId ? { epgChannelId } : {}) });
    if (streams.length > MAX_CATALOGUE) throw new XtreamError('IMPORT_LIMIT', 'The provider returned too many live channels.', 413);
  }
  return { streams, ignored };
}

export function buildLiveSnapshot(serverUrl: string, credentials: Pick<XtreamCredentials, 'username' | 'password'>, streams: XtreamLiveStream[], categories: XtreamCategory[]): { channels: XtreamChannel[]; ignoredNonLive: number } {
  const base = serverUrl.replace(/\/+$/, ''), names = new Map(categories.map(category => [category.id, category.name]));
  // The provider's own stream address embeds its credentials, exactly like an M3U line.
  // It is stored sealed and never returned by an API route.
  const channels: XtreamChannel[] = streams.map(stream => ({
    streamId: stream.streamId,
    categoryId: stream.categoryId,
    tvgId: stream.epgChannelId ?? '',
    name: stream.name,
    group: names.get(stream.categoryId) ?? '',
    logo: stream.icon ?? '',
    streamUrl: `${base}/live/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}/${stream.streamId}.${stream.container}`
  }));
  return { channels, ignoredNonLive: 0 };
}

export function cataloguePage(catalogue: XtreamCatalogue, page: {offset: number; limit: number; categoryId?: string; q?: string}): XtreamCataloguePage {
  const query = page.q?.trim().toLocaleLowerCase() ?? '';
  // Channel DTOs deliberately omit the stream address: it carries provider credentials.
  const rows = catalogue.channels
    .filter(channel => !page.categoryId || channel.categoryId === page.categoryId)
    .filter(channel => !query || channel.name.toLocaleLowerCase().includes(query) || channel.tvgId.toLocaleLowerCase().includes(query))
    .map(channel => ({ streamId: channel.streamId, name: channel.name, group: channel.group, tvgId: channel.tvgId, logo: channel.logo }));
  const slice = rows.slice(page.offset, page.offset + page.limit);
  return { categories: catalogue.categories, total: rows.length, offset: page.offset, limit: page.limit, hasMore: page.offset + page.limit < rows.length,
    channels: slice, fetchedAt: catalogue.fetchedAt, ignoredStreams: catalogue.ignoredStreams, epgPrograms: catalogue.epg?.programs.length ?? 0 };
}

export type XtreamTransport = (endpoint: SourceEndpoint, signal?: AbortSignal, limits?: SourceLimits) => Promise<Buffer>;
const defaultTransport: XtreamTransport = (endpoint, signal, limits) => new RestrictedSourceFetcher().fetch(endpoint, signal, limits);

// Never let an upstream message reach a log or a response: it may quote the request URL,
// which contains the provider's username and password. Only our own codes and numeric
// diagnostics survive this boundary.
export function transportFailure(error: unknown): XtreamError {
  const detail = (error instanceof SourceFetchError ? error.detail : {}) as SourceDetail;
  const fail = (code: string, message: string, status = 502, retryable = false) => new XtreamError(code, message, status, retryable, detail);
  if (error instanceof AppError) {
    switch (error.code) {
      case 'SOURCE_RATE_LIMITED': return fail('XTREAM_RATE_LIMITED', 'The provider is rate limiting requests. Try again later.', 429, true);
      case 'SOURCE_TIMEOUT': return fail('XTREAM_TIMEOUT', 'The provider did not respond in time.', 504, true);
      case 'SOURCE_ADDRESS_REJECTED':
      case 'SOURCE_ENDPOINT_REJECTED':
      case 'SOURCE_REDIRECT_REJECTED':
      case 'SOURCE_HEADERS_REJECTED': return fail('XTREAM_ENDPOINT_REJECTED', 'The provider address is not a permitted public HTTPS endpoint.', 400);
      // A rejection or an oversized body is a provider-side answer, not an unreachable host.
      case 'SOURCE_HTTP_STATUS': return fail('XTREAM_HTTP_STATUS', 'The provider refused the request.', 502);
      case 'SOURCE_TOO_LARGE':
      case 'SOURCE_DECOMPRESSION_LIMIT': return fail('XTREAM_RESPONSE_TOO_LARGE', 'The provider response exceeds the configured limit.', 502);
      case 'SOURCE_ENCODING_REJECTED': return fail('XTREAM_ENCODING_UNSUPPORTED', 'The provider used an unsupported compression.', 502);
      case 'SOURCE_INVALID_GZIP': return fail('XTREAM_INVALID_COMPRESSION', 'The provider response was not valid gzip.', 502);
      case 'SOURCE_INVALID_TEXT': return fail('XTREAM_INVALID_ENCODING', 'The provider response was not valid UTF-8.', 502);
      case 'SOURCE_INCOMPLETE': return fail('XTREAM_INCOMPLETE_RESPONSE', 'The provider response ended early.', 502, true);
      case 'SOURCE_DNS_FAILED': return fail('XTREAM_DNS_FAILED', 'The provider address could not be resolved.', 502, true);
      case 'SOURCE_TLS_FAILED': return fail('XTREAM_TLS_FAILED', 'The provider connection could not be secured.', 502, true);
      case 'SOURCE_NETWORK_FAILED': return fail('XTREAM_NETWORK_FAILED', 'The provider connection failed.', 502, true);
    }
  }
  return fail('XTREAM_UNREACHABLE', 'The provider could not be reached.', 502, true);
}

const playerApi = z.object({ user_info: z.record(z.string(), z.unknown()), server_info: z.record(z.string(), z.unknown()).optional() }).passthrough();

export class XtreamClient {
  private readonly endpoint: XtreamEndpoint;
  private readonly username: string;
  private readonly password: string;
  constructor(input: z.input<typeof xtreamCredentials>, private transport: XtreamTransport = defaultTransport) {
    const credentials = xtreamCredentials.parse(input);
    this.endpoint = normalizeXtreamEndpoint(credentials);
    this.username = credentials.username;
    this.password = credentials.password;
  }
  // Server-side only. Callers must never place this value in a response, a log or a template.
  private endpointUrl(file: 'player_api.php' | 'xmltv.php', action?: string, params: Record<string, string> = {}) {
    const base = this.endpoint.serverUrl.endsWith('/') ? this.endpoint.serverUrl : `${this.endpoint.serverUrl}/`;
    const url = new URL(file, base);
    url.searchParams.set('username', this.username);
    url.searchParams.set('password', this.password);
    if (action) url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
  private async bytes(url: string, signal?: AbortSignal, limits?: SourceLimits) {
    try { return await this.transport({ url, headers: {}, allowInsecureHttp: this.endpoint.allowInsecureHttp }, signal, limits); }
    catch (error) { throw transportFailure(error); }
  }
  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const bytes = await this.bytes(url, signal);
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').trim(); }
    catch { throw new XtreamError('XTREAM_INVALID_RESPONSE', 'The provider response was not valid UTF-8.'); }
    ensure(body && body[0] !== '<', 'XTREAM_INVALID_RESPONSE', 'The provider returned a web page instead of the Xtream API.');
    try { return JSON.parse(body); }
    catch { throw new XtreamError('XTREAM_INVALID_RESPONSE', 'The provider response was not valid JSON.'); }
  }
  private list(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    // A session can lapse between calls; a player_api error object then replaces the list.
    const info = data && typeof data === 'object' ? (data as { user_info?: Record<string, unknown> }).user_info : undefined;
    if (info && !truthy(info.auth)) throw new XtreamError('XTREAM_AUTH_FAILED', 'The provider rejected these credentials.', 422);
    throw new XtreamError('XTREAM_INVALID_RESPONSE', 'The provider returned an unexpected response.');
  }
  async authenticate(signal?: AbortSignal): Promise<XtreamAccount> {
    const data = await this.json(this.endpointUrl('player_api.php'), signal);
    const parsed = playerApi.safeParse(data);
    ensure(parsed.success, 'XTREAM_INVALID_RESPONSE', 'The provider did not return an Xtream account response.');
    const info = parsed.data.user_info;
    ensure('auth' in info, 'XTREAM_INVALID_RESPONSE', 'The provider did not confirm the account.');
    ensure(truthy(info.auth), 'XTREAM_AUTH_FAILED', 'The provider rejected these credentials.', 422);
    const status = text(info.status, 40)?.toLocaleLowerCase() ?? '';
    const expiresAt = (() => {
      if (info.exp_date === null || info.exp_date === undefined || info.exp_date === '' || info.exp_date === 'null') return null;
      const seconds = numberish(info.exp_date);
      // A numeric zero or negative date is an expiry, not an unlimited account.
      return seconds !== undefined ? seconds * 1000 : null;
    })();
    const account: XtreamAccount = {
      status: status === 'active' || status === 'trial' ? 'active' : 'inactive',
      expiresAt,
      isTrial: truthy(info.is_trial),
      maxConnections: numberish(info.max_connections) ?? null,
      activeConnections: numberish(info.active_cons) ?? null,
      allowedFormats: Array.isArray(info.allowed_output_formats) ? info.allowed_output_formats.map(format => text(format, 20)).filter((format): format is string => !!format).slice(0, 8) : [],
      timezone: text(parsed.data.server_info?.timezone, 64) ?? null
    };
    // Expiry is the more specific failure: a panel often marks an expired line inactive too.
    ensure(account.expiresAt === null || account.expiresAt > Date.now(), 'XTREAM_ACCOUNT_EXPIRED', 'The provider account has expired.', 422);
    ensure(account.status === 'active', 'XTREAM_ACCOUNT_INACTIVE', 'The provider account is not active.', 422);
    return account;
  }
  async liveCategories(signal?: AbortSignal): Promise<XtreamCategory[]> {
    return parseLiveCategories(this.list(await this.json(this.endpointUrl('player_api.php', 'get_live_categories'), signal)));
  }
  async liveStreams(categoryId?: string, signal?: AbortSignal): Promise<{ streams: XtreamLiveStream[]; ignored: number }> {
    return parseLiveStreams(this.list(await this.json(this.endpointUrl('player_api.php', 'get_live_streams', categoryId ? { category_id: categoryId } : {}), signal)));
  }
  // Future VOD/series work uses the same authenticated transport; these stay typed and
  // unfiltered until the catalogue milestone defines their listing rules.
  async vodCategories(signal?: AbortSignal): Promise<XtreamCategory[]> {
    return parseLiveCategories(this.list(await this.json(this.endpointUrl('player_api.php', 'get_vod_categories'), signal)));
  }
  async vodStreams(categoryId?: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.list(await this.json(this.endpointUrl('player_api.php', 'get_vod_streams', categoryId ? { category_id: categoryId } : {}), signal));
  }
  async series(categoryId?: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.list(await this.json(this.endpointUrl('player_api.php', 'get_series', categoryId ? { category_id: categoryId } : {}), signal));
  }
  async seriesInfo(seriesId: string, signal?: AbortSignal): Promise<unknown> {
    ensure(/^\d{1,20}$/.test(seriesId), 'XTREAM_INVALID_RESPONSE', 'Invalid series identifier.');
    return this.json(this.endpointUrl('player_api.php', 'get_series_info', { series_id: seriesId }), signal);
  }
  // The provider's XMLTV feed. Its limits are larger than a playlist's but still explicit: a real
  // feed inflates to ~20.6 MiB, so a 16 MiB ceiling rejected a valid guide as unreachable.
  async epg(signal?: AbortSignal): Promise<XmlSnapshot> {
    const bytes = await this.bytes(this.endpointUrl('xmltv.php'), signal, XMLTV_GUIDE_LIMITS);
    try { return parseXmltv(bytes, XMLTV_PARSE_LIMITS); }
    catch (error) { throw error instanceof AppError ? error : new XtreamError('XTREAM_INVALID_RESPONSE', 'The provider guide could not be read.'); }
  }
  // One channel's listings, for panels that publish no usable XMLTV feed. `streamId` is what the
  // provider accepts on get_short_epg; `xmlId` is the guide identity the listing is stored under.
  // These are different namespaces and must never be substituted for one another.
  async shortEpg(streamId: string, xmlId: string, timeZone?: string | null, signal?: AbortSignal, now = Date.now()): Promise<ShortEpgParse> {
    ensure(/^\d{1,20}$/.test(streamId), 'XTREAM_INVALID_RESPONSE', 'Invalid stream identifier.');
    ensure(/^[\w.:-]{1,128}$/.test(xmlId), 'XTREAM_INVALID_RESPONSE', 'Invalid guide channel identifier.');
    return parseShortEpgDetailed(await this.json(this.endpointUrl('player_api.php', 'get_short_epg', {stream_id: streamId}), signal), xmlId, timeZone, now);
  }
  // The fallback is bounded in every dimension: how many channels are asked for, how many run at
  // once, how long the whole pass may take, and how it stops once the provider pushes back.
  private async fallbackGuide(channels: XtreamChannel[], timeZone: string | null, signal?: AbortSignal, now = Date.now()): Promise<{epg?: XmlSnapshot; status: GuideStatus}> {
    const targets: {streamId: string; xmlId: string}[] = [], seen = new Set<string>();
    for (const channel of channels) {
      if (!channel.tvgId || !/^[\w.:-]{1,128}$/.test(channel.tvgId)) continue;
      if (seen.has(channel.tvgId)) continue;
      seen.add(channel.tvgId);
      targets.push({streamId: channel.streamId, xmlId: channel.tvgId});
      if (targets.length >= SHORT_EPG_CHANNELS) break;
    }
    // The budget is wall-clock time. `now` is the caller's catalogue timestamp and may be any
    // instant, so it must not decide how long the pass may run.
    const deadline = Date.now() + SHORT_EPG_BUDGET_MS;
    const programs: Program[] = []; let succeeded = 0, skipped = 0, rejected = 0, ambiguous = 0, refused = 0;
    const answered = new Set<string>();
    let next = 0, stopped = false;
    // A provider that rate-limits or refuses one request is not asked the remaining 39 times.
    const worker = async () => {
      while (!stopped && next < targets.length && Date.now() < deadline && !signal?.aborted) {
        const target = targets[next++]!;
        try {
          const parsed = await this.shortEpg(target.streamId, target.xmlId, timeZone, signal, now);
          succeeded++; answered.add(target.xmlId); rejected += parsed.rejected; ambiguous += parsed.ambiguous;
          programs.push(...parsed.programs);
        } catch (error) {
          refused++;
          const code = error instanceof AppError ? error.code : '';
          if (code === 'XTREAM_RATE_LIMITED' || code === 'XTREAM_HTTP_STATUS' || code === 'XTREAM_TIMEOUT') stopped = true;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(SHORT_EPG_CONCURRENCY, targets.length)}, worker));
    skipped = targets.length - next;
    // Coverage is honest: a 40-channel fallback for an 8,000-channel lineup is partial, not complete.
    const eligible = new Set(channels.map(channel => channel.tvgId).filter(id => id && /^[\w.:-]{1,128}$/.test(id))).size;
    const complete = answered.size >= eligible;
    const base: GuideStatus = {source: 'short_epg', state: 'failed', requested: targets.length, succeeded, skipped, mappedChannels: answered.size};
    if (!programs.length) {
      // Channels were asked and answered but carry no listings: an empty guide, not a broken one.
      if (succeeded) return {status: {...base, state: 'empty', code: 'XTREAM_GUIDE_EMPTY', rejected: rejected + ambiguous}};
      return {status: {...base, code: refused ? 'XTREAM_SHORT_EPG_REFUSED' : 'XTREAM_GUIDE_EMPTY'}};
    }
    const epg: XmlSnapshot = {
      channels: [...answered].map(id => ({id, name: channels.find(channel => channel.tvgId === id)?.name ?? id})),
      programs, quarantined: 0
    };
    return {epg, status: {...base, state: complete ? 'available' : 'partial',
      ...(complete ? {} : {code: stopped ? 'XTREAM_SHORT_EPG_STOPPED' : 'XTREAM_SHORT_EPG_PARTIAL'}),
      rejected: rejected + ambiguous}};
  }
  async catalogue(options: { includeEpg?: boolean; signal?: AbortSignal; now?: number; account?: XtreamAccount } = {}): Promise<XtreamCatalogue> {
    // A sign-in has just authenticated this account; repeating that call would put a second
    // provider round trip in the same login sequence for no new information.
    const account = options.account ?? await this.authenticate(options.signal);
    const categories = await this.liveCategories(options.signal);
    const { streams, ignored } = await this.liveStreams(undefined, options.signal);
    const catalogue: XtreamCatalogue = {
      version: 1, fetchedAt: options.now ?? Date.now(), account, categories,
      channels: buildLiveSnapshot(this.endpoint.serverUrl, { username: this.username, password: this.password }, streams, categories).channels,
      ignoredStreams: ignored
    };
    if (!options.includeEpg) { catalogue.guide = {source: 'none', state: 'disabled'}; return catalogue; }
    const started = Date.now();
    let primary: GuideStatus['primary'];
    try {
      catalogue.epg = await this.epg(options.signal);
      // Coverage is measured against what the guide actually contains, not how many channels exist:
      // a valid feed whose ids match nothing is "unmatched", not "available".
      const counts = new Map<string, number>();
      for (const channel of catalogue.epg.channels) counts.set(channel.id, (counts.get(channel.id) ?? 0) + 1);
      const matched = new Set(catalogue.channels.map(channel => channel.tvgId).filter(id => id && counts.get(id) === 1)).size;
      // A matched id with nothing airing around now is a valid guide with no current programmes,
      // which is different from a feed that matches no channel at all.
      const from = (options.now ?? catalogue.fetchedAt) - 86400000, to = from + 8 * 86400000;
      const current = matched ? catalogue.epg.programs.some(program => program.end > from && program.start < to) : false;
      const state = matched ? (current ? 'available' : 'empty') : 'unmatched';
      primary = {state, elapsedMs: Date.now() - started,
        parsedChannels: catalogue.epg.channels.length, parsedPrograms: catalogue.epg.programs.length,
        rejected: catalogue.epg.quarantined};
      catalogue.guide = {source: 'xmltv', state, elapsedMs: Date.now() - started,
        parsedChannels: catalogue.epg.channels.length, parsedPrograms: catalogue.epg.programs.length,
        mappedChannels: matched, rejected: catalogue.epg.quarantined, primary};
      // Any parsed feed ends the guide work. A valid guide with nothing current is reported as
      // empty rather than spending the bounded fallback's request budget on a healthy provider.
      return catalogue;
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'XTREAM_INVALID_RESPONSE';
      catalogue.epgError = code;
      const detail = error instanceof XtreamError ? numericDetail(error.detail) : {};
      // The code names the stage that actually failed: a refused request, an oversized feed and a
      // malformed document are not the same fault, and none of them is "unreachable" by default.
      primary = {state: 'failed', code, ...detail, elapsedMs: Date.now() - started};
      catalogue.guide = {source: 'xmltv', state: 'failed', code, ...detail, elapsedMs: Date.now() - started, primary};
    }
    // Some panels publish no XMLTV feed or publish one the parser cannot accept. For those, ask
    // for each channel's short guide instead, within the bounded pass above.
    const fallback = await this.fallbackGuide(catalogue.channels, catalogue.account.timezone, options.signal, options.now ?? Date.now());
    // The primary failure stays recorded, so a later recovery is distinguishable from an import
    // where the primary feed was fine all along.
    // The fallback's own numbers replace the primary's: a successful fallback must not inherit the
    // primary's HTTP status or byte counts. The primary attempt is kept under `primary`.
    if (fallback.epg) {
      catalogue.epg = fallback.epg;
      catalogue.guide = {...fallback.status, primary};
    } else {
      // Neither source produced listings, and the primary itself failed. Say so, keeping the
      // fallback's request accounting so the failure is actionable.
      catalogue.guide = {source: 'none', state: 'failed', code: fallback.status.code ?? primary?.code,
        requested: fallback.status.requested, succeeded: fallback.status.succeeded, skipped: fallback.status.skipped,
        mappedChannels: fallback.status.mappedChannels, primary};
    }
    return catalogue;
  }
}
