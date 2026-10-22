import { gunzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { AppError, requireThat } from '../errors.js';
import { stackKey } from '../services/channel-stacks.js';

const MAX_BYTES = 16 * 1024 * 1024;
export type M3uChannel = { tvgId: string; name: string; group: string; logo: string; streamUrl: string };
export type M3uSnapshot = { channels: M3uChannel[]; ignoredNonLive: number };
export function parseM3u(text: string): M3uSnapshot {
  requireThat(Buffer.byteLength(text) <= MAX_BYTES, 'IMPORT_LIMIT', 'Playlist exceeds import limit.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  requireThat(lines[0]?.startsWith('#EXTM3U'), 'INVALID_M3U', 'Expected an extended M3U playlist.');
  const channels: M3uChannel[] = []; let pending: (M3uChannel & { live: boolean }) | undefined, ignoredNonLive = 0;
  for (const line of lines.slice(1)) {
    requireThat(line.length <= 16384, 'IMPORT_LIMIT', 'Playlist line exceeds limit.');
    if (line.startsWith('#EXTINF:')) {
      requireThat(!pending, 'INCOMPLETE_M3U', 'A playlist entry has no stream URI.');
      // Find the separator outside quoted attributes; station/group names may contain commas.
      let quoted = false, separator = -1;
      for (let i = 8; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        if (line[i] === ',' && !quoted) { separator = i; break; }
      }
      requireThat(separator > 0, 'INVALID_M3U', 'Malformed playlist entry.');
      const info = line.slice(8, separator), duration = Number(info.match(/^-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
      requireThat(Number.isFinite(duration), 'INVALID_M3U', 'Invalid playlist duration.');
      const attrs: Record<string, string> = {};
      for (const m of info.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]!.toLowerCase()] = m[2]!;
      const name = line.slice(separator + 1).trim() || attrs['tvg-name'] || '';
      requireThat(name, 'INVALID_M3U', 'Playlist entry has no name.');
      pending = { tvgId: attrs['tvg-id'] ?? '', name, group: attrs['group-title'] ?? '', logo: attrs['tvg-logo'] ?? '', streamUrl: '',
        live: duration <= 0 && !/vod|movie|series/i.test(attrs['type'] ?? '') };
    } else if (line.startsWith('#EXTGRP:') && pending) pending.group = line.slice(8);
    else if (!line.startsWith('#')) {
      requireThat(pending, 'INVALID_M3U', 'Unexpected playlist URI.');
      let url: URL;
      try { url = new URL(line); } catch { throw new AppError('INVALID_M3U', 'Invalid playlist URI.'); }
      requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'UNSUPPORTED_TRANSPORT', 'Only HTTP(S) IPTV transports are supported in this spike.');
      if (pending.live && !/\/(movie|series|vod)\//i.test(url.pathname) && !/\.(mp4|mkv|avi|mov|m4v)$/i.test(url.pathname)) {
        const { live: _, ...channel } = pending; channels.push({ ...channel, streamUrl: url.href });
      } else ignoredNonLive++;
      pending = undefined;
    }
  }
  requireThat(!pending, 'INCOMPLETE_M3U', 'Playlist ends before the final stream URI.');
  requireThat(channels.length > 0, 'EMPTY_M3U', 'Empty or non-live-only snapshots require administrator investigation.');
  return { channels, ignoredNonLive };
}

export type XmlChannel = { id: string; name: string; icon?: string };
export type Program = { channelId: string; start: number; end: number; title: string; subtitle?: string; description?: string; category?: string; continuous?: boolean; status?: 'starting_soon' };
export type XmlSnapshot = { channels: XmlChannel[]; programs: Program[]; quarantined: number };
export function xmltvTime(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+([+-])(\d{2})(\d{2})$/.exec(value);
  requireThat(m, 'INVALID_XMLTV_TIME', 'XMLTV timestamps need full dates and explicit UTC offsets.');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const local = new Date(0); local.setUTCFullYear(year, month - 1, day); local.setUTCHours(hour, minute, second, 0);
  requireThat(local.getUTCFullYear() === year && local.getUTCMonth() === month - 1 && local.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && Number(m[8]) <= 14 && Number(m[9]) <= 59 && !(Number(m[8]) === 14 && Number(m[9]) !== 0), 'INVALID_XMLTV_TIME', 'Invalid XMLTV calendar date or timezone.');
  return local.getTime() - (m[7] === '+' ? 1 : -1) * (Number(m[8]) * 60 + Number(m[9])) * 60000;
}
export type XmlLimits = {maxBytes?: number; maxProgrammes?: number};
// A primary XMLTV feed can legitimately exceed a playlist's ceiling. The cap stays explicit and
// bounded, and the parser's own structure limits (depth, tags, field length) still apply.
export const XMLTV_MAX_BYTES = 16 * 1024 * 1024;
export const XMLTV_MAX_PROGRAMMES = 500000;
export function parseXmltv(input: Buffer | string, limits: XmlLimits = {}): XmlSnapshot {
  const maxBytes=limits.maxBytes??MAX_BYTES, maxProgrammes=limits.maxProgrammes??XMLTV_MAX_PROGRAMMES;
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  requireThat(bytes.length <= maxBytes, 'IMPORT_LIMIT', 'XMLTV input exceeds limit.');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: maxBytes }); }
    catch { throw new AppError('INVALID_XMLTV', 'Invalid or oversized compressed XMLTV.'); }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // XMLTV feeds conventionally carry `<!DOCTYPE tv SYSTEM "xmltv.dtd">`. That prologue is harmless:
  // nothing here fetches the external DTD and the parser will not expand a declared entity. An
  // internal subset (`<!DOCTYPE tv [ ... ]>`) and entity declarations stay refused, because that is
  // where expansion attacks begin.
  requireThat(!/<!ENTITY/i.test(text) && !/<!DOCTYPE[^>]*\[/i.test(text), 'UNSAFE_XML', 'XML declarations with an internal DTD subset or entities are not accepted.');
  const channels: XmlChannel[] = [], raw: Program[] = [];
  let depth = 0, count = 0, root = false, quarantined = 0, programmeCount = 0;
  let channel: XmlChannel | undefined, program: Program | undefined, field = '', content = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', n => {
    depth++; count++;
    requireThat(depth <= 16 && count <= 500000, 'IMPORT_LIMIT', 'XMLTV structure exceeds limits.');
    if (depth === 1) { requireThat(n.name === 'tv', 'INVALID_XMLTV', 'Expected XMLTV root.'); root = true; }
    if (depth === 2 && n.name === 'channel') channel = { id: String(n.attributes.id ?? ''), name: '' };
    if (depth === 2 && n.name === 'programme') {
      // A limit breach is not a malformed record: it must stop the import rather than be
      // silently counted as a quarantined programme.
      requireThat(++programmeCount <= maxProgrammes, 'IMPORT_LIMIT', 'XMLTV programme count exceeds limit.');
      try {
        const start = xmltvTime(String(n.attributes.start ?? '')), end = xmltvTime(String(n.attributes.stop ?? ''));
        requireThat(start < end && n.attributes.channel, 'INVALID_XMLTV_TIME', 'Invalid program interval.');
        program = { channelId: String(n.attributes.channel), start, end, title: '' };
      } catch { quarantined++; program = undefined; }
    }
    if (depth === 3 && channel && n.name === 'icon' && !channel.icon && /^https?:\/\//i.test(String(n.attributes.src ?? ''))) channel.icon = String(n.attributes.src).slice(0, 2048);
    if (depth === 3 && ['title', 'display-name', 'sub-title', 'desc', 'category'].includes(n.name)) { field = n.name; content = ''; }
  });
  const append = (s: string) => { if (field) { content += s; requireThat(content.length <= 16384, 'IMPORT_LIMIT', 'XMLTV text exceeds limit.'); } };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', n => {
    if (depth === 3 && n.name === field) {
      if (channel && field === 'display-name' && !channel.name) channel.name = content.trim();
      if (program && field === 'title' && !program.title) program.title = content.trim();
      // Optional listing detail, bounded so a verbose feed cannot bloat guide responses.
      const text = content.trim().slice(0, 1200), key = ({ 'sub-title': 'subtitle', desc: 'description', category: 'category' } as const)[field as 'desc'];
      if (program && key && text && !program[key]) program[key] = text;
      field = ''; content = '';
    }
    if (depth === 2 && n.name === 'channel') { if (channel?.id) channels.push(channel); else quarantined++; channel = undefined; }
    if (depth === 2 && n.name === 'programme') { if (program?.title) raw.push(program); else if (program) quarantined++; program = undefined; }
    depth--;
  });
  try { parser.write(text).close(); } catch (e) { if (e instanceof AppError) throw e; throw new AppError('INVALID_XMLTV', 'XMLTV document is malformed or incomplete.'); }
  requireThat(root && channels.length > 0 && raw.length > 0, 'EMPTY_XMLTV', 'Untrusted empty XMLTV snapshot.');
  // An id is usable when every declaration of it names the same station, or when only one
  // declaration exists. See guideStations().
  const ids = guideStations(channels);
  const validIds = new Set([...ids].filter(([, entry]) => !entry.ambiguous).map(([id]) => id));
  const unique = [...new Map(raw.map(p => [JSON.stringify(p), p])).values()].sort((a, b) => a.channelId.localeCompare(b.channelId) || a.start - b.start || a.end - b.end);
  // Quarantine ALL records involved in an overlap, instead of guessing which title airs.
  const bad = new Set<Program>(); let farthest: Program | undefined;
  for (const p of unique) {
    if (!validIds.has(p.channelId)) bad.add(p);
    if (farthest?.channelId === p.channelId && p.start < farthest.end) { bad.add(p); bad.add(farthest); }
    if (!farthest || farthest.channelId !== p.channelId || p.end > farthest.end) farthest = p;
  }
  quarantined += bad.size;
  const programs = unique.filter(p => !bad.has(p));
  requireThat(programs.length > 0, 'EMPTY_XMLTV', 'No trustworthy program records remain. Preserve the last good snapshot.');
  return { channels, programs, quarantined };
}

// Providers routinely declare one station several times under a single guide id — "BBC One | SD |",
// "| FHD |", "| HD |", "| Catchup Backup". Requiring exactly one declaration discarded the listings
// for the stations viewers watch most. Two declarations are compatible when their station names
// agree; an id shared by *different* stations stays ambiguous, because no listing can be attributed
// to one of them without guessing.
export type GuideStationEntry = {count: number; station: string | null; ambiguous: boolean};
// A feed qualifier does not make a different station. stackKey already ignores backup/alt/alternate;
// providers also mark a timeshift or archive feed as "Catchup Backup", which would otherwise make
// BBC One's own guide id look shared. Only the guide identity comparison widens the set.
const guideStationKey = (name: string) => (stackKey(name) || name.trim().toLocaleLowerCase('en'))
  .replace(/\s+catch ?up\b/g, ' ').replace(/\s+/g, ' ').trim();
export function guideStations(channels: {id: string; name: string}[]): Map<string, GuideStationEntry> {
  const seen = new Map<string, Map<string, number>>();
  for (const channel of channels) {
    const names = seen.get(channel.id) ?? new Map<string, number>();
    const station = guideStationKey(channel.name);
    names.set(station, (names.get(station) ?? 0) + 1);
    seen.set(channel.id, names);
  }
  const stations = new Map<string, GuideStationEntry>();
  for (const [id, names] of seen) {
    const count = [...names.values()].reduce((total, n) => total + n, 0);
    // A single declaration is unambiguous even when its display name is empty.
    stations.set(id, {count, station: names.size === 1 ? [...names.keys()][0]! : null, ambiguous: count > 1 && names.size > 1});
  }
  return stations;
}
const normalized = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export type GuideMapping = { sourceId: string; feedId: string; channelId: string; xmlId: string; method: 'exact_id' | 'admin'; reviewedBy?: string; revision: number };
// Guide resolution runs for every channel of a source. Indexing the provider ids once per pass
// keeps that linear: without it, a large lineup compares every channel against every other.
export type GuideIndex = { byTvgId: Map<string, M3uChannel[]>; xml: Map<string, GuideStationEntry> };
export function guideIndex(sourceChannels: M3uChannel[], xml: XmlSnapshot): GuideIndex {
  const byTvgId = new Map<string, M3uChannel[]>();
  for (const c of sourceChannels) {
    const list = byTvgId.get(c.tvgId);
    if (list) list.push(c); else byTvgId.set(c.tvgId, [c]);
  }
  return { byTvgId, xml: guideStations(xml.channels) };
}
// A guide id resolves automatically when the feed declares it for one station only, and — for a
// channel whose tvgId is shared by several playlist feeds — when those feeds are that station.
// A provider's display-name need not match the playlist's name, so the two are not compared: the
// id is the identifier, and the name is only evidence when the feed itself contradicts it.
function usableGuideId(xmlId: string, station: string, sourceChannels: M3uChannel[], xml: XmlSnapshot, index?: GuideIndex) {
  const entry = index?.xml.get(xmlId) ?? guideStations(xml.channels).get(xmlId);
  if (!entry || entry.ambiguous) return false;
  const siblings = index?.byTvgId.get(xmlId) ?? sourceChannels.filter(c => c.tvgId === xmlId);
  return siblings.length <= 1 || (!!station && siblings.every(c => guideStationKey(c.name) === station));
}
export function resolveGuideMapping(scope: {sourceId: string; feedId: string; channelId: string}, channel: M3uChannel, sourceChannels: M3uChannel[], xml: XmlSnapshot, current?: GuideMapping, index?: GuideIndex): GuideMapping | undefined {
  if (current) {
    const scoped = current.sourceId === scope.sourceId && current.feedId === scope.feedId && current.channelId === scope.channelId;
    // An administrator's choice outlives name changes; it only needs the id to still name one
    // station. An automatic choice must still pass the same test that produced it.
    if (current.method === 'admin') {
      const entry = index?.xml.get(current.xmlId) ?? guideStations(xml.channels).get(current.xmlId);
      return scoped && !!entry && !entry.ambiguous ? current : undefined;
    }
    if (!scoped || !usableGuideId(current.xmlId, guideStationKey(channel.name), sourceChannels, xml, index)) return undefined;
  }
  const exactId = exactGuideId(channel, sourceChannels, xml, index);
  return exactId ? {...scope, xmlId: exactId, method: 'exact_id', revision: current?.xmlId === exactId ? current.revision : (current?.revision ?? 0) + 1} : undefined;
}
// Multiple feeds may share one guide ID. It is automatic only when their station names agree;
// unrelated stations reusing an ID still require a manual guide choice. Resolving runs for every channel on
// each sports rematch, so it skips mappingCandidates' name suggestions, which normalize every guide name.
function exactGuideId(channel: M3uChannel, sourceChannels: M3uChannel[], xml: XmlSnapshot, index?: GuideIndex) {
  if (!channel.tvgId) return undefined;
  return usableGuideId(channel.tvgId, guideStationKey(channel.name), sourceChannels, xml, index) ? channel.tvgId : undefined;
}
export function mappingCandidates(channel: M3uChannel, sourceChannels: M3uChannel[], xml: XmlSnapshot) {
  // Suggestions come from ids that name one station, so a shared event id never proposes a merge.
  const stations = guideStations(xml.channels);
  const uniqueXml = xml.channels.filter(c => !stations.get(c.id)?.ambiguous);
  return { exactId: exactGuideId(channel, sourceChannels, xml), suggestions: uniqueXml.filter(c => normalized(c.name) === normalized(channel.name)).map(c => ({ xmlId: c.id, reason: 'normalized_name', applied: false as const })) };
}
export function approveMapping(input: { role: 'admin' | 'viewer'; accountId: string; sourceId: string; feedId: string; channelId: string; xmlId: string; expectedRevision: number }, current: GuideMapping | undefined, scope: {sourceId: string; feedId: string}, xml: XmlSnapshot): GuideMapping {
  requireThat(input.role === 'admin', 'FORBIDDEN', 'Administrator access required.', 403);
  requireThat(input.sourceId === scope.sourceId && input.feedId === scope.feedId, 'MAPPING_SCOPE', 'Cross-source guide mapping is not permitted.');
  requireThat(!current || (current.sourceId === input.sourceId && current.feedId === input.feedId && current.channelId === input.channelId), 'MAPPING_SCOPE', 'Existing mapping belongs to a different source/channel.');
  requireThat((current?.revision ?? 0) === input.expectedRevision, 'REVISION_CONFLICT', 'Mapping changed.', 409);
  // A manual choice still requires that the id names exactly one station; an id that different
  // stations share cannot be attributed to this channel by an administrator either.
  requireThat(!guideStations(xml.channels).get(input.xmlId)?.ambiguous && xml.channels.some(c => c.id === input.xmlId), 'MAPPING_CONFLICT', 'XMLTV identity is missing or ambiguous.');
  return { sourceId: input.sourceId, feedId: input.feedId, channelId: input.channelId, xmlId: input.xmlId, method: 'admin', reviewedBy: input.accountId, revision: input.expectedRevision + 1 };
}
// "24/7 Marvel Movies" style channels loop one theme and rarely ship XMLTV; their name is the listing.
const continuousTitle = (name?: string) => name && /\b24\s*\/\s*7\b/.test(name) ? name.replace(/^[A-Z]{2,3}\s*[:|]\s*/, '') : undefined;
export function guideWindow(programs: Program[], xmlId: string | undefined, start: number, end: number, channelName?: string) {
  requireThat(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end, 'INVALID_WINDOW', 'Invalid guide window.');
  const title = continuousTitle(channelName);
  const gap = (from: number, to: number) => ({ start: from, end: to, program: title ? { channelId: xmlId ?? '', start: from, end: to, title, continuous: true } : null });
  const rows: { start: number; end: number; program: Program | null }[] = []; let cursor = start;
  for (const p of programs.filter(p => xmlId && p.channelId === xmlId && p.start < end && p.end > start).sort((a, b) => a.start - b.start)) {
    if (p.start > cursor) rows.push(gap(cursor, p.start));
    rows.push({ start: Math.max(start, p.start), end: Math.min(end, p.end), program: p }); cursor = Math.min(end, p.end);
  }
  if (cursor < end) rows.push(gap(cursor, end));
  return rows;
}
