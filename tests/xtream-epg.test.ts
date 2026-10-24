import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { XtreamService } from '../apps/server/src/services/xtream-service.js';
import { RestrictedSourceFetcher, SourceFetchError, type SourceEndpoint } from '../apps/server/src/providers/source-fetch.js';
import { XtreamClient, decodeGuideText, guideInstant, parseShortEpgDetailed, transportFailure, type XtreamCatalogue } from '../apps/server/src/providers/xtream.js';
import { parseXmltv, resolveGuideMapping } from '../apps/server/src/providers/iptv.js';
import type { GuideStatus } from '../apps/server/src/providers/xtream.js';

const credentials = {serverUrl: 'https://provider.example', username: 'fixture-user', password: 'fixture-secret'};
const endpoint: SourceEndpoint = {url: 'https://provider.example/guide.xml', headers: {}, allowInsecureHttp: false};
const resolver = async () => [{address: '8.8.8.8', family: 4}];
const xmltv = (channelIds: string[], start = '20261022120000 +0000', stop = '20261022130000 +0000') =>
  `<tv>${channelIds.map(id => `<channel id="${id}"><display-name>${id}</display-name></channel>`).join('')}` +
  `${channelIds.map(id => `<programme channel="${id}" start="${start}" stop="${stop}"><title>Programme ${id}</title></programme>`).join('')}</tv>`;

// Every guide failure must name the stage that failed. "Unreachable" is reserved for a host that
// genuinely could not be contacted.
test('transport failures become accurate, sanitised guide codes instead of one catch-all', () => {
  const code = (error: unknown) => transportFailure(error).code;
  assert.equal(code(new SourceFetchError('SOURCE_HTTP_STATUS', undefined, {httpStatus: 404})), 'XTREAM_HTTP_STATUS');
  assert.equal(transportFailure(new SourceFetchError('SOURCE_HTTP_STATUS', undefined, {httpStatus: 403})).status, 502);
  assert.equal(code(new SourceFetchError('SOURCE_TOO_LARGE', undefined, {limit: 16})), 'XTREAM_RESPONSE_TOO_LARGE');
  assert.equal(code(new SourceFetchError('SOURCE_DECOMPRESSION_LIMIT', undefined, {limit: 64})), 'XTREAM_RESPONSE_TOO_LARGE');
  assert.equal(code(new SourceFetchError('SOURCE_ENCODING_REJECTED')), 'XTREAM_ENCODING_UNSUPPORTED');
  assert.equal(code(new SourceFetchError('SOURCE_INVALID_GZIP')), 'XTREAM_INVALID_COMPRESSION');
  assert.equal(code(new SourceFetchError('SOURCE_INVALID_TEXT')), 'XTREAM_INVALID_ENCODING');
  assert.equal(code(new SourceFetchError('SOURCE_INCOMPLETE')), 'XTREAM_INCOMPLETE_RESPONSE');
  assert.equal(code(new SourceFetchError('SOURCE_DNS_FAILED')), 'XTREAM_DNS_FAILED');
  assert.equal(code(new SourceFetchError('SOURCE_TLS_FAILED')), 'XTREAM_TLS_FAILED');
  assert.equal(code(new SourceFetchError('SOURCE_NETWORK_FAILED')), 'XTREAM_NETWORK_FAILED');
  assert.equal(code(new SourceFetchError('SOURCE_TIMEOUT')), 'XTREAM_TIMEOUT');
  assert.equal(code(new SourceFetchError('SOURCE_RATE_LIMITED', Date.now() + 60000)), 'XTREAM_RATE_LIMITED');
  // Only a genuinely unknown failure keeps the old catch-all.
  assert.equal(code(new Error('boom')), 'XTREAM_UNREACHABLE');
  // Diagnostics carry numbers, never a URL or a body.
  const detail = transportFailure(new SourceFetchError('SOURCE_HTTP_STATUS', undefined, {httpStatus: 404, bytes: 12})).detail;
  assert.equal(detail.httpStatus, 404);
  assert.ok(!JSON.stringify(detail).includes('fixture-secret'));
});

test('a compressed body above the configured limit is a size refusal, not a provider outage', async () => {
  const body = gzipSync(Buffer.alloc(1024));
  const fetcher = new RestrictedSourceFetcher(resolver, async () => ({status: 200, headers: {'content-encoding': 'gzip'}, body, complete: true}));
  await assert.rejects(fetcher.fetch(endpoint, undefined, {maxInflatedBytes: 512}), (error: unknown) =>
    error instanceof SourceFetchError && error.code === 'SOURCE_DECOMPRESSION_LIMIT' && error.detail.limit === 512);
  // The same body within a larger, explicit ceiling is accepted: the ceiling is the issue, not the provider.
  assert.equal((await fetcher.fetch(endpoint, undefined, {maxInflatedBytes: 4096})).length, 1024);
});

test('HTTP rejection and real network failure are distinguished at the fetch boundary', async () => {
  const http = new RestrictedSourceFetcher(resolver, async () => ({status: 404, headers: {}, body: Buffer.alloc(0), complete: true}));
  await assert.rejects(http.fetch(endpoint), (error: unknown) => error instanceof SourceFetchError && error.code === 'SOURCE_HTTP_STATUS' && error.detail.httpStatus === 404);
  const dns = new RestrictedSourceFetcher(async () => { throw Object.assign(new Error('lookup failed'), {code: 'ENOTFOUND'}); });
  await assert.rejects(dns.fetch(endpoint), (error: unknown) => error instanceof SourceFetchError && error.code === 'SOURCE_DNS_FAILED');
  const tls = new RestrictedSourceFetcher(resolver, async () => { throw Object.assign(new Error('certificate'), {code: 'DEPTH_ZERO_SELF_SIGNED_CERT'}); });
  await assert.rejects(tls.fetch(endpoint), (error: unknown) => error instanceof SourceFetchError && error.code === 'SOURCE_TLS_FAILED');
  const truncated = new RestrictedSourceFetcher(resolver, async () => ({status: 200, headers: {}, body: Buffer.from('x'), complete: false}));
  await assert.rejects(truncated.fetch(endpoint), (error: unknown) => error instanceof SourceFetchError && error.code === 'SOURCE_INCOMPLETE');
});

// The fallback used to send tvgId as stream_id. The provider accepts the stream id and returns
// nothing for the guide id, so the two namespaces must stay separate.
// A provider that lists one station several times under a single guide id is ordinary ("BBC One |
// SD |", "| FHD |", "| HD |", "| Catchup Backup"). Treating that as ambiguity discarded the
// listings for the most-watched stations.
test('a guide id repeated for one station maps, while an id shared by different stations does not', () => {
  const xml = (decls: [string, string][], programmes: string[]) => {
    const body = `<tv>${decls.map(([id, name]) => `<channel id="${id}"><display-name>${name}</display-name></channel>`).join('')}` +
      programmes.map(id => `<programme channel="${id}" start="20261022120000 +0000" stop="20261022130000 +0000"><title>P</title></programme>`).join('') + '</tv>';
    return parseXmltv(body);
  };
  const repeated = xml([['bbc1.uk', 'BBC One | SD |'], ['bbc1.uk', 'BBC One | FHD |'], ['bbc1.uk', 'BBC One | HD |']], ['bbc1.uk']);
  assert.equal(repeated.programs.length, 1, 'the repeated declaration does not quarantine the listings');
  assert.equal(repeated.quarantined, 0);

  // Different stations under one id stay ambiguous: attributing the listing would be a guess.
  // A second, valid channel keeps the snapshot non-empty, as a real feed always has one.
  const shared = xml([['event.id', 'PPV 01'], ['event.id', 'PPV 02'], ['news.uk', 'News UK']], ['event.id', 'news.uk']);
  assert.equal(shared.programs.length, 1);
  assert.equal(shared.programs[0]!.channelId, 'news.uk');
  assert.ok(shared.quarantined > 0, 'the shared listing is quarantined');

  // A "Catchup Backup" feed is the same station: stackKey already ignores backup/alt qualifiers,
  // and refusing to would quarantine the guide id for the most-watched channels.
  const withCatchup = xml([['bbc1.uk', 'BBC One | SD |'], ['bbc1.uk', 'BBC One | FHD |'], ['bbc1.uk', 'BBC One | Catchup Backup']], ['bbc1.uk']);
  assert.equal(withCatchup.programs.length, 1);
  assert.equal(withCatchup.quarantined, 0);
  const catchupPlaylist = ['BBC One | FHD |', 'BBC One | HD |', 'BBC One | SD |', 'BBC One | Catchup Backup']
    .map((name, i) => ({tvgId: 'bbc1.uk', name, group: '', logo: '', streamUrl: `https://s.example/${i}`}));
  assert.equal(resolveGuideMapping({sourceId: 's', feedId: 'f', channelId: 'c'}, catchupPlaylist[0]!, catchupPlaylist, withCatchup)?.xmlId, 'bbc1.uk');

  const playlist = [{tvgId: 'bbc1.uk', name: 'BBC One', group: '', logo: '', streamUrl: 'https://s.example/1'}];
  assert.equal(resolveGuideMapping({sourceId: 's', feedId: 'f', channelId: 'c'}, playlist[0]!, playlist, repeated)?.xmlId, 'bbc1.uk');
  assert.equal(resolveGuideMapping({sourceId: 's', feedId: 'f', channelId: 'c'}, {...playlist[0]!, tvgId: 'event.id'}, [{...playlist[0]!, tvgId: 'event.id'}], shared), undefined);
});

test('short EPG requests use the stream id while mapping to the guide id', async () => {
  const requested: string[] = [];
  const transport = async (target: SourceEndpoint) => {
    const url = new URL(target.url), action = url.searchParams.get('action');
    if (action === 'get_short_epg') {
      const streamId = url.searchParams.get('stream_id')!;
      requested.push(streamId);
      // This panel only answers for the stream id, exactly like the real one.
      return Buffer.from(JSON.stringify({epg_listings: streamId === '62415'
        ? [{title: 'TWFpbiBOZXdz', start_timestamp: '1792674000', stop_timestamp: '1792675800'}]
        : []}));
    }
    throw new Error('unexpected');
  };
  const client = new XtreamClient(credentials, transport);
  const parsed = await client.shortEpg('62415', 'bbc1.uk', 'Europe/London', undefined, Date.UTC(2026, 9, 22, 12));
  assert.deepEqual(requested, ['62415']);
  assert.equal(parsed.programs.length, 1);
  // The listing is keyed by the guide identity, never by the stream id used to fetch it.
  assert.equal(parsed.programs[0]!.channelId, 'bbc1.uk');
  assert.equal(parsed.programs[0]!.title, 'Main News');
  assert.equal(parsed.programs[0]!.start, 1792674000000);
});

test('timestamp fields: unix seconds, numeric strings, offsets, provider-local dates and ambiguity', () => {
  const instant = Date.UTC(2026, 9, 22, 12);
  assert.equal(guideInstant(1792674000), 1792674000000);
  assert.equal(guideInstant('1792674000'), 1792674000000);
  assert.equal(guideInstant('20261022120000 +0000'), instant);
  assert.equal(guideInstant('2026-10-22T12:00:00Z'), instant);
  assert.equal(guideInstant('2026-10-22T13:00:00+01:00'), instant);
  // A wall-clock string with no offset needs the provider's zone; the host's zone is never used.
  assert.equal(guideInstant('2026-10-22 13:00:00', 'Europe/London'), instant);
  assert.equal(guideInstant('2026-10-22 13:00:00'), undefined);
  assert.equal(guideInstant('2026-10-22 13:00:00', 'Not/AZone'), undefined);
  // Out-of-range and impossible values are refused rather than clamped.
  for (const bad of ['0', '1', '99999999999999', '2026-02-30 12:00:00', '2026-10-22 25:00:00', 'yesterday'])
    assert.equal(guideInstant(bad, 'Europe/London'), undefined, bad);
  // Daylight saving: the same wall clock is an hour apart either side of the transition.
  const before = guideInstant('2026-03-29 00:30:00', 'Europe/London')!;
  const after = guideInstant('2026-03-29 02:30:00', 'Europe/London')!;
  assert.equal(after - before, 3600000);
  assert.equal(guideInstant('2026-10-25 01:30:00', 'Europe/London') !== undefined, true);
});

test('programme text is base64-decoded only when it really is base64', () => {
  assert.equal(decodeGuideText('TWFpbiBOZXdz'), 'Main News');
  // Plain sentences are valid base64 alphabetically; decoding them would corrupt them.
  assert.equal(decodeGuideText('Midday News'), 'Midday News');
  assert.equal(decodeGuideText('News'), 'News');
  assert.equal(decodeGuideText('abc'), 'abc');
  assert.equal(decodeGuideText(''), undefined);
  assert.equal(decodeGuideText(undefined), undefined);
  // Non-UTF-8 bytes leave the original text intact, and output stays bounded.
  assert.equal(decodeGuideText('/w=='), '/w==');
  assert.equal(decodeGuideText('A'.repeat(10000))!.length, 4096);
});

test('short EPG drops unusable rows and reports why, without failing the channel', () => {
  const rows = [
    {title: 'TWFpbiBOZXdz', start_timestamp: '1792674000', stop_timestamp: '1792675800'},
    {title: 'Reversed', start_timestamp: '1792675800', stop_timestamp: '1792674000'},
    {title: 'Wall clock', start: '2026-10-22 13:00:00', end: '2026-10-22 14:00:00'},
    {title: '', start_timestamp: '1792674000', stop_timestamp: '1792675800'},
    {title: 'Duplicate of the first', start_timestamp: '1792674000', stop_timestamp: '1792675800'}
  ];
  const withoutZone = parseShortEpgDetailed({epg_listings: rows}, 'bbc1.uk', null, Date.UTC(2026, 9, 22, 12));
  assert.equal(withoutZone.programs.length, 1);
  assert.equal(withoutZone.programs[0]!.title, 'Main News');
  // Wall-clock rows are counted as ambiguous rather than silently reinterpreted in host time.
  assert.ok(withoutZone.ambiguous >= 1);
  assert.ok(withoutZone.rejected >= 2);
  const withZone = parseShortEpgDetailed({epg_listings: rows}, 'bbc1.uk', 'Europe/London', Date.UTC(2026, 9, 22, 12));
  assert.equal(withZone.programs.length, 2);
  assert.equal(withZone.ambiguous, 0);
  assert.throws(() => parseShortEpgDetailed({epg_listings: 'nope'}, 'bbc1.uk'), {code: 'XTREAM_INVALID_RESPONSE'});
});

// A guide that fails must not take the catalogue with it, and the fallback must be reported as
// partial when it cannot cover the lineup.
test('XMLTV failure falls back to a bounded short-EPG pass and reports partial coverage', async () => {
  const channels = Array.from({length: 60}, (_, i) => ({stream_id: 600 + i, name: `Channel ${i}`, epg_channel_id: `ch.${i}`, category_id: '1'}));
  const shortCalls: string[] = [];
  const transport = async (target: SourceEndpoint) => {
    const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    if (action === 'auth') return Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}, server_info: {timezone: 'Europe/London'}}));
    if (action === 'get_live_categories') return Buffer.from(JSON.stringify([{category_id: '1', category_name: 'All'}]));
    if (action === 'get_live_streams') return Buffer.from(JSON.stringify(channels));
    if (action === 'get_short_epg') {
      const streamId = url.searchParams.get('stream_id')!;
      shortCalls.push(streamId);
      return Buffer.from(JSON.stringify({epg_listings: [{title: 'TGlzdGluZw==', start_timestamp: '1792674000', stop_timestamp: '1792675800'}]}));
    }
    if (url.pathname.endsWith('xmltv.php')) throw new SourceFetchError('SOURCE_HTTP_STATUS', undefined, {httpStatus: 404});
    throw new Error(`unexpected ${action}`);
  };
  const catalogue = await new XtreamClient(credentials, transport).catalogue({includeEpg: true, now: Date.UTC(2026, 9, 22, 12)});
  assert.equal(catalogue.channels.length, 60, 'a guide failure never drops channels');
  assert.equal(catalogue.epgError, 'XTREAM_HTTP_STATUS');
  assert.equal(catalogue.epg?.programs.length, 40, 'the fallback stays bounded');
  assert.ok(shortCalls.length <= 40);
  assert.equal(new Set(shortCalls).size, shortCalls.length, 'each channel is asked once');
  assert.equal(catalogue.guide?.state, 'partial');
  assert.equal(catalogue.guide?.requested, 40);
  assert.ok((catalogue.guide?.succeeded ?? 0) + (catalogue.guide?.skipped ?? 0) >= 40);
  assert.equal(catalogue.guide?.primary?.code, 'XTREAM_HTTP_STATUS');
  assert.ok(!JSON.stringify(catalogue.guide).includes('fixture-secret'));
});

test('a rate-limited provider stops the fallback instead of being asked for every channel', async () => {
  const channels = Array.from({length: 40}, (_, i) => ({stream_id: 700 + i, name: `Channel ${i}`, epg_channel_id: `ch.${i}`, category_id: '1'}));
  let shortCalls = 0;
  const transport = async (target: SourceEndpoint) => {
    const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    if (action === 'auth') return Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}, server_info: {timezone: 'UTC'}}));
    if (action === 'get_live_categories') return Buffer.from('[]');
    if (action === 'get_live_streams') return Buffer.from(JSON.stringify(channels));
    if (action === 'get_short_epg') { shortCalls++; throw new SourceFetchError('SOURCE_RATE_LIMITED', Date.now() + 60000); }
    if (url.pathname.endsWith('xmltv.php')) return Buffer.from('<html>no guide</html>');
    throw new Error('unexpected');
  };
  const catalogue = await new XtreamClient(credentials, transport).catalogue({includeEpg: true});
  assert.equal(catalogue.channels.length, 40);
  assert.ok(shortCalls <= 4, `stopped after the first refusals, not all 40 (${shortCalls})`);
  assert.equal(catalogue.guide?.state, 'failed');
  assert.equal(catalogue.guide?.code, 'XTREAM_SHORT_EPG_REFUSED');
});

test('valid XMLTV with no matching channel ids or no current programmes is not a failed import', async () => {
  const streams = [{stream_id: 1, name: 'Channel', epg_channel_id: 'wanted.id', category_id: '1'}];
  const build = (guide: string) => async (target: SourceEndpoint) => {
    const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    if (action === 'auth') return Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}}));
    if (action === 'get_live_categories') return Buffer.from('[]');
    if (action === 'get_live_streams') return Buffer.from(JSON.stringify(streams));
    if (action === 'get_short_epg') return Buffer.from(JSON.stringify({epg_listings: []}));
    if (action === 'xmltv') return Buffer.from(guide);
    throw new Error('unexpected');
  };
  const unmatched = await new XtreamClient(credentials, build(xmltv(['someone.else']))).catalogue({includeEpg: true});
  assert.equal(unmatched.guide?.state, 'unmatched');
  assert.equal(unmatched.guide?.source, 'xmltv');
  assert.equal(unmatched.epg?.programs.length, 1, 'the guide itself parsed');
  // The guide is empty for this channel, so no fallback listings exist either.
  const empty = await new XtreamClient(credentials, build(xmltv(['wanted.id'], '20200101120000 +0000', '20200101130000 +0000'))).catalogue({includeEpg: true, now: Date.UTC(2026, 9, 22)});
  assert.equal(empty.guide?.state, 'empty');
  // The parsed guide is retained: an old but valid feed is not deleted just because nothing airs now.
  assert.equal(empty.epg?.programs.length, 1);
});

test('gzip and plain XMLTV are both accepted within the raised guide ceiling', async () => {
  const guide = xmltv(['wanted.id']);
  const streams = [{stream_id: 1, name: 'Channel', epg_channel_id: 'wanted.id', category_id: '1'}];
  for (const body of [Buffer.from(guide), gzipSync(Buffer.from(guide))]) {
    const transport = async (target: SourceEndpoint) => {
      const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
      if (action === 'auth') return Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}}));
      if (action === 'get_live_categories') return Buffer.from('[]');
      if (action === 'get_live_streams') return Buffer.from(JSON.stringify(streams));
      if (action === 'xmltv') return body;
      throw new Error('unexpected ' + action);
    };
    const catalogue = await new XtreamClient(credentials, transport).catalogue({includeEpg: true, now: Date.UTC(2026, 9, 22, 12)});
    assert.equal(catalogue.guide?.state, 'available');
    assert.equal(catalogue.epg?.programs.length, 1);
  }
});

// A guide-only failure keeps the guide already published, and the retained state is reported as
// such rather than as a fresh full import.
test('a later guide failure retains the last known guide and reports it as retained', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  try {
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    const account = store.create('owner', {name: 'Primary', credentials});
    store.setAccess('owner', account.id, ['owner']);
    const streams = [{stream_id: 1, name: 'Channel', epg_channel_id: 'wanted.id', category_id: '1'}];
    const accountBody = Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}, server_info: {timezone: 'Europe/London'}}));
    let guideFails = false;
    const transport = async (target: SourceEndpoint) => {
      const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
      if (action === 'auth') return accountBody;
      if (action === 'get_live_categories') return Buffer.from('[]');
      if (action === 'get_live_streams') return Buffer.from(JSON.stringify(streams));
      if (action === 'get_short_epg') return Buffer.from(JSON.stringify({epg_listings: []}));
      if (action === 'xmltv') {
        if (guideFails) throw new SourceFetchError('SOURCE_DECOMPRESSION_LIMIT', undefined, {limit: 64 * 1024 * 1024, compression: 'gzip'});
        return Buffer.from(xmltv(['wanted.id']));
      }
      throw new Error('unexpected');
    };
    const service = new XtreamService(store, iptv, () => new XtreamClient(credentials, transport));
    // The fixtures air on 22 October 2026; the production 24-hour lookback drops them once the real
    // clock passes. Pin the import clock so the test asserts retention, not today's date.
    const now = Date.UTC(2026, 9, 22, 12);
    const first = await service.refresh('owner', account.id, {includeEpg: true, now});
    assert.equal(first.guide?.state, 'available');
    const sourceId = first.sourceId;
    const before = iptv.guidePage('owner', 'all', Date.UTC(2026, 9, 22, 11), Date.UTC(2026, 9, 22, 14), 0, 30);
    assert.equal(before.channels[0]!.programs.filter(slot => slot.program).length, 1);

    guideFails = true;
    const second = await service.refresh('owner', account.id, {includeEpg: true, now});
    assert.equal(second.channels, 1, 'channels survive a guide-only failure');
    // Listings already published remain on screen.
    const after = iptv.guidePage('owner', 'all', Date.UTC(2026, 9, 22, 11), Date.UTC(2026, 9, 22, 14), 0, 30);
    assert.equal(after.channels[0]!.programs.filter(slot => slot.program).length, 1, 'the last good guide is kept');
    const status = iptv.status(sourceId).guideStatus as GuideStatus;
    assert.equal(status.state, 'partial');
    assert.equal(status.code, 'XTREAM_GUIDE_RETAINED');
    assert.equal(status.primary?.code, 'XTREAM_RESPONSE_TOO_LARGE');
  } finally { db.close(); }
});

test('a successful retry clears the previous guide failure state', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  try {
    const account = store.create('owner', {name: 'Primary', credentials});
    const streams = [{stream_id: 1, name: 'Channel', epg_channel_id: 'wanted.id', category_id: '1'}];
    let guideFails = true;
    const transport = async (target: SourceEndpoint) => {
      const url = new URL(target.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
      if (action === 'auth') return Buffer.from(JSON.stringify({user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}}));
      if (action === 'get_live_categories') return Buffer.from('[]');
      if (action === 'get_live_streams') return Buffer.from(JSON.stringify(streams));
      if (action === 'get_short_epg') return Buffer.from(JSON.stringify({epg_listings: []}));
      if (action === 'xmltv') {
        if (guideFails) throw new SourceFetchError('SOURCE_HTTP_STATUS', undefined, {httpStatus: 503});
        return Buffer.from(xmltv(['wanted.id']));
      }
      throw new Error('unexpected');
    };
    const service = new XtreamService(store, iptv, () => new XtreamClient(credentials, transport));
    const now = Date.UTC(2026, 9, 22, 12);
    const failed = await service.refresh('owner', account.id, {includeEpg: true, now});
    assert.equal(failed.guide?.state, 'failed');
    assert.equal(iptv.status(failed.sourceId).guideStatus?.state, 'failed');
    guideFails = false;
    const recovered = await service.refresh('owner', account.id, {includeEpg: true, now});
    assert.equal(recovered.guide?.state, 'available');
    const status = iptv.status(recovered.sourceId).guideStatus as GuideStatus;
    assert.equal(status.state, 'available');
    // The earlier failure is kept as history, not repeated as the current state.
    assert.equal(status.code, undefined);
  } finally { db.close(); }
});

test('guide state is scoped to its own provider account', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  try {
    const first = store.create('owner', {name: 'Primary', credentials});
    const second = store.create('owner', {name: 'Backup', credentials: {...credentials, username: 'other-user'}});
    const catalogue = (epgError?: string, guide?: GuideStatus): XtreamCatalogue => ({
      version: 1, fetchedAt: 1,
      account: {status: 'active', expiresAt: null, isTrial: false, maxConnections: null, activeConnections: null, allowedFormats: [], timezone: 'UTC'},
      categories: [], channels: [{streamId: '1', categoryId: '', tvgId: 'a', name: 'A', group: '', logo: '', streamUrl: 'https://provider.example/live/u/p/1.ts'}],
      ignoredStreams: 0, ...(epgError ? {epgError} : {}), ...(guide ? {guide} : {})
    });
    const good = iptv.publishXtream('owner', first.id, 'Primary', catalogue(undefined, {source: 'xmltv', state: 'available'}), 1);
    const bad = iptv.publishXtream('owner', second.id, 'Backup', catalogue('XTREAM_HTTP_STATUS', {source: 'xmltv', state: 'failed', code: 'XTREAM_HTTP_STATUS'}), 1);
    assert.equal(iptv.status(good.source.id).guideStatus?.state, 'available');
    assert.equal(iptv.status(bad.source.id).guideStatus?.state, 'failed');
    // One account's failure never rewrites the other's published state.
    assert.equal(iptv.status(good.source.id).guideStatus?.state, 'available');
  } finally { db.close(); }
});
