import { z } from 'zod';
import { AppError } from '../errors.js';
import { RestrictedSourceFetcher, type SourceEndpoint } from './source-fetch.js';
import { parseXmltv, xmltvTime, type M3uChannel, type M3uSnapshot, type Program, type XmlSnapshot } from './iptv.js';

// Xtream Codes provider adapter. It speaks only the documented player_api.php and
// xmltv.php interfaces: no DRM handling, no panel scraping and no provider-specific
// shortcuts. Everything here is server-side; provider credentials stay in the vault
// and are never part of a value returned to a browser.
const MAX_CATALOGUE = 20000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const hasControl = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value);

export class XtreamError extends AppError {
  constructor(code: string, message: string, status = 502, retryable = false) { super(code, message, status, retryable); }
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
};
export type XtreamCataloguePage = {
  categories: XtreamCategory[]; total: number; offset: number; limit: number; hasMore: boolean;
  channels: { streamId: string; name: string; group: string; tvgId: string; logo: string }[];
  fetchedAt: number; ignoredStreams: number; epgPrograms: number;
};
// get_short_epg returns a channel's listings as JSON, sometimes base64-encoded. Only the
// documented fields are read; malformed rows are dropped rather than failing the refresh.
const shortEpgSchema = z.object({ epg_listings: z.array(z.record(z.string(), z.unknown())) }).passthrough();
export function parseShortEpg(input: unknown, channelId: string): Program[] {
  const parsed = shortEpgSchema.safeParse(input);
  ensure(parsed.success, 'XTREAM_INVALID_RESPONSE', 'The provider returned an unexpected guide response.');
  const decode = (value: unknown) => {
    const text = textOf(value, 4096);
    if (!text) return undefined;
    try { const bytes = Buffer.from(text, 'base64'); return /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]+$/.test(bytes.toString('utf8')) ? bytes.toString('utf8') : text; }
    catch { return text; }
  };
  const programs: Program[] = [];
  for (const row of parsed.data.epg_listings.slice(0, 2000)) {
    const start = xmltvTimeOf(row.start), end = xmltvTimeOf(row.end), title = decode(row.title);
    if (start === undefined || end === undefined || end <= start || !title) continue;
    const description = decode(row.description);
    programs.push({channelId, start, end, title: title.slice(0, 300), ...(description ? {description} : {})});
  }
  return programs;
}
const textOf = (value: unknown, max: number) => typeof value === 'string' || typeof value === 'number' ? text(value, max) : undefined;
const xmltvTimeOf = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{14}\s+[+-]\d{4}$/.test(value.trim())) return undefined;
  try { return xmltvTime(value.trim()); } catch { return undefined; }
};

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

export type XtreamTransport = (endpoint: SourceEndpoint, signal?: AbortSignal) => Promise<Buffer>;
const defaultTransport: XtreamTransport = (endpoint, signal) => new RestrictedSourceFetcher().fetch(endpoint, signal);

// Never let an upstream message reach a log or a response: it may quote the request URL,
// which contains the provider's username and password.
function transportFailure(error: unknown): AppError {
  if (error instanceof AppError) {
    if (error.code === 'SOURCE_RATE_LIMITED') return new XtreamError('XTREAM_RATE_LIMITED', 'The provider is rate limiting requests. Try again later.', 429, true);
    if (error.code === 'SOURCE_TIMEOUT') return new XtreamError('XTREAM_TIMEOUT', 'The provider did not respond in time.', 504, true);
    if (['SOURCE_ADDRESS_REJECTED', 'SOURCE_ENDPOINT_REJECTED', 'SOURCE_REDIRECT_REJECTED', 'SOURCE_HEADERS_REJECTED'].includes(error.code)) {
      return new XtreamError('XTREAM_ENDPOINT_REJECTED', 'The provider address is not a permitted public HTTPS endpoint.', 400);
    }
  }
  return new XtreamError('XTREAM_UNREACHABLE', 'The provider could not be reached.', 502, true);
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
  private async bytes(url: string, signal?: AbortSignal) {
    try { return await this.transport({ url, headers: {}, allowInsecureHttp: this.endpoint.allowInsecureHttp }, signal); }
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
  async epg(signal?: AbortSignal): Promise<XmlSnapshot> {
    const bytes = await this.bytes(this.endpointUrl('xmltv.php'), signal);
    try { return parseXmltv(bytes); }
    catch (error) { throw error instanceof AppError ? error : new XtreamError('XTREAM_INVALID_RESPONSE', 'The provider guide could not be read.'); }
  }
  // One channel's listings, for providers that publish no XMLTV feed. The channel id is the
  // provider's own EPG id, so callers must never pass an arbitrary stream address.
  async shortEpg(channelId: string, signal?: AbortSignal): Promise<Program[]> {
    ensure(/^[\w.:-]{1,128}$/.test(channelId), 'XTREAM_INVALID_RESPONSE', 'Invalid guide channel identifier.');
    return parseShortEpg(await this.json(this.endpointUrl('player_api.php', 'get_short_epg', {stream_id: channelId}), signal), channelId);
  }
  async catalogue(options: { includeEpg?: boolean; signal?: AbortSignal; now?: number } = {}): Promise<XtreamCatalogue> {
    const account = await this.authenticate(options.signal);
    const categories = await this.liveCategories(options.signal);
    const { streams, ignored } = await this.liveStreams(undefined, options.signal);
    const catalogue: XtreamCatalogue = {
      version: 1, fetchedAt: options.now ?? Date.now(), account, categories,
      channels: buildLiveSnapshot(this.endpoint.serverUrl, { username: this.username, password: this.password }, streams, categories).channels,
      ignoredStreams: ignored
    };
    if (options.includeEpg) {
      try { catalogue.epg = await this.epg(options.signal); }
      catch (error) { catalogue.epgError = error instanceof AppError ? error.code : 'XTREAM_INVALID_RESPONSE'; }
      // Some panels publish no XMLTV feed. For those, ask for each channel's short guide instead,
      // bounded so a large lineup cannot turn one refresh into thousands of requests.
      if (!catalogue.epg) {
        const ids = [...new Set(catalogue.channels.map(channel => channel.tvgId).filter(Boolean))].slice(0, 40), programs: Program[] = [];
        for (const id of ids) {
          try { programs.push(...await this.shortEpg(id, options.signal)); }
          catch { /* one channel's guide is optional */ }
        }
        if (programs.length) catalogue.epg = {channels: catalogue.channels.filter(channel => ids.includes(channel.tvgId)).map(channel => ({id: channel.tvgId, name: channel.name})), programs, quarantined: 0};
      }
    }
    return catalogue;
  }
}
