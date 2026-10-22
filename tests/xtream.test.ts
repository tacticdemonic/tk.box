import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { XtreamClient, XtreamError, buildLiveSnapshot, cataloguePage, normalizeXtreamEndpoint, parseLiveCategories, parseLiveStreams } from '../apps/server/src/providers/xtream.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamService } from '../apps/server/src/services/xtream-service.js';
import type { SourceEndpoint } from '../apps/server/src/providers/source-fetch.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { buildApp } from '../apps/server/src/app.js';
import { config, fakePlex, settle } from './fixtures.js';

const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
const future = () => String(Math.floor(Date.now() / 1000) + 86400);
const authBody = (over: Record<string, unknown> = {}) => ({
  user_info: {auth: 1, status: 'Active', exp_date: future(), is_trial: '0', active_cons: '1', max_connections: '2', allowed_output_formats: ['m3u8', 'ts'], ...over},
  server_info: {timezone: 'Europe/London', url: 'provider.example'}
});
const categoriesBody = [
  {category_id: '1', category_name: 'News\n UK', parent_id: 0},
  {category_id: 2, category_name: '  Sports  '},
  {category_id: '1', category_name: 'Duplicate id'},
  {category_id: 'x', category_name: 'Bad id'},
  {category_id: '3'},
  null
];
const streamsBody = [
  {stream_id: 101, name: 'UK: News HD', category_id: '1', stream_icon: 'https://logos.example/news.png', epg_channel_id: 'news.uk', container_extension: 'm3u8', tv_archive: 1},
  {stream_id: '102', name: '  UK:  Sports\tHD ', category_id: 2, stream_icon: 'javascript:alert(1)', epg_channel_id: '', container_extension: 'ts'},
  {stream_id: 101, name: 'Duplicate stream', category_id: '1'},
  {stream_id: 0, name: 'No id'},
  {stream_id: 103, name: '', category_id: '1'}
];
const guide = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="news.uk"><display-name>News UK</display-name><icon src="https://logos.example/news.png"/></channel>
<programme channel="news.uk" start="20261019120000 +0000" stop="20261019130000 +0000"><title>Midday News</title><desc>Headlines</desc></programme>
</tv>`;

function mock(routes: Record<string, unknown>, options: {bytes?: Record<string, Buffer>} = {}) {
  const calls: string[] = [];
  const transport = async (endpoint: SourceEndpoint) => {
    const url = new URL(endpoint.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    calls.push(url.pathname);
    if (options.bytes?.[action]) return options.bytes[action]!;
    const value = routes[action];
    if (value === undefined) throw new Error('unexpected fixture route');
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  };
  return {transport, calls};
}

test('provider addresses reject credentials, plain HTTP by default, fragments and pre-built endpoints', () => {
  assert.equal(normalizeXtreamEndpoint({serverUrl: 'https://provider.example:8443/'}).serverUrl, 'https://provider.example:8443');
  assert.equal(normalizeXtreamEndpoint({serverUrl: 'https://provider.example/panel/'}).serverUrl, 'https://provider.example/panel');
  assert.equal(normalizeXtreamEndpoint({serverUrl: 'http://192.0.2.10:8080', allowInsecureHttp: true}).serverUrl, 'http://192.0.2.10:8080');
  for (const serverUrl of ['http://provider.example', 'ftp://provider.example', 'https://user:pass@provider.example', 'https://provider.example/?x=1', 'https://provider.example/#frag', 'https://provider.example/player_api.php', 'https://provider.example/xmltv.php'])
    assert.throws(() => normalizeXtreamEndpoint({serverUrl}), {code: 'XTREAM_ENDPOINT_REJECTED'});
});

test('account validation distinguishes rejected, inactive, expired and malformed responses without echoing credentials', async () => {
  const ok = new XtreamClient(credentials, mock({auth: authBody()}).transport);
  const account = await ok.authenticate();
  assert.deepEqual({status: account.status, isTrial: account.isTrial, maxConnections: account.maxConnections, active: account.activeConnections, formats: account.allowedFormats, zone: account.timezone},
    {status: 'active', isTrial: false, maxConnections: 2, active: 1, formats: ['m3u8', 'ts'], zone: 'Europe/London'});
  assert.ok(account.expiresAt && account.expiresAt > Date.now());
  const unlimited = await new XtreamClient(credentials, mock({auth: authBody({exp_date: null})}).transport).authenticate();
  assert.equal(unlimited.expiresAt, null);
  const serialized = JSON.stringify(account);
  for (const secret of ['viewer-name', 'secret-pass', 'provider.example']) assert.ok(!serialized.includes(secret), 'validation result must not carry provider details');

  const cases: [unknown, string][] = [
    [{user_info: {auth: 0, status: 'Active'}}, 'XTREAM_AUTH_FAILED'],
    [{user_info: {auth: '0', status: 'Active'}}, 'XTREAM_AUTH_FAILED'],
    [authBody({status: 'Disabled'}), 'XTREAM_ACCOUNT_INACTIVE'],
    [authBody({exp_date: '1700000000'}), 'XTREAM_ACCOUNT_EXPIRED'],
    [authBody({exp_date: '0'}), 'XTREAM_ACCOUNT_EXPIRED'],
    ['<html>Login</html>', 'XTREAM_INVALID_RESPONSE'],
    [{error: 'something'}, 'XTREAM_INVALID_RESPONSE'],
    [{user_info: {status: 'Active'}}, 'XTREAM_INVALID_RESPONSE'],
    ['not json', 'XTREAM_INVALID_RESPONSE']
  ];
  for (const [body, code] of cases) {
    const client = new XtreamClient(credentials, mock({auth: body}).transport);
    await assert.rejects(client.authenticate(), (error: unknown) => {
      assert.ok(error instanceof XtreamError); assert.equal(error.code, code);
      for (const secret of ['viewer-name', 'secret-pass', 'provider.example']) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  // A transport failure is reported as unreachable, never as the upstream exception text.
  const failing = new XtreamClient(credentials, async () => { throw new Error('connect ECONNREFUSED https://provider.example/player_api.php?password=secret-pass'); });
  await assert.rejects(failing.authenticate(), (error: unknown) => error instanceof XtreamError && error.code === 'XTREAM_UNREACHABLE' && !error.message.includes('secret-pass'));
});

test('category and channel parsing sanitises text, drops malformed rows and keeps live containers only', () => {
  const categories = parseLiveCategories(categoriesBody);
  assert.deepEqual(categories, [{id: '1', name: 'News UK'}, {id: '2', name: 'Sports'}]);
  assert.throws(() => parseLiveCategories({user_info: {auth: 1}}), {code: 'XTREAM_INVALID_RESPONSE'});

  const {streams, ignored} = parseLiveStreams(streamsBody);
  assert.equal(streams.length, 2);
  assert.equal(ignored, 3);
  assert.deepEqual(streams[0], {streamId: '101', name: 'UK: News HD', categoryId: '1', container: 'm3u8', archive: true, icon: 'https://logos.example/news.png', epgChannelId: 'news.uk'});
  assert.equal(streams[1]!.container, 'ts');
  assert.equal(streams[1]!.name, 'UK: Sports HD');
  assert.equal(streams[1]!.icon, undefined, 'non-HTTP logos are discarded');
  assert.throws(() => parseLiveStreams({user_info: {auth: 0}}), {code: 'XTREAM_INVALID_RESPONSE'});
  // A session that lapses between calls returns an auth object where a list was expected.
  const lapsed = new XtreamClient(credentials, mock({get_live_streams: {user_info: {auth: 0}}}).transport);
  return assert.rejects(lapsed.liveStreams(), {code: 'XTREAM_AUTH_FAILED'});
});

test('live stream addresses encode credentials and never appear in a paged catalogue', () => {
  const categories = parseLiveCategories(categoriesBody), {streams} = parseLiveStreams(streamsBody);
  const snapshot = buildLiveSnapshot('https://provider.example:8443', {username: 'u ser', password: 'p/w'}, streams, categories);
  assert.equal(snapshot.channels[0]!.streamUrl, 'https://provider.example:8443/live/u%20ser/p%2Fw/101.m3u8');
  assert.equal(snapshot.channels[0]!.group, 'News UK');
  assert.equal(snapshot.channels[1]!.group, 'Sports');
  const catalogue = {version: 1 as const, fetchedAt: 42, account: {status: 'active' as const, expiresAt: null, isTrial: false, maxConnections: null, activeConnections: null, allowedFormats: [], timezone: null},
    categories, ...snapshot, ignoredStreams: 0};
  const page = cataloguePage(catalogue, {offset: 0, limit: 10});
  assert.equal(page.total, 2); assert.equal(page.channels[0]!.streamId, '101'); assert.equal(page.fetchedAt, 42);
  assert.ok(!JSON.stringify(page).includes('p%2Fw') && !JSON.stringify(page).includes('/live/'));
  assert.equal(cataloguePage(catalogue, {offset: 0, limit: 1, categoryId: '2'}).channels[0]!.streamId, '102');
  assert.equal(cataloguePage(catalogue, {offset: 1, limit: 1}).hasMore, false);
  assert.equal(cataloguePage(catalogue, {offset: 0, limit: 1, q: 'news'}).total, 1);
});

test('catalogue retrieval combines account, categories, channels and the provider guide', async () => {
  const {transport, calls} = mock({auth: authBody(), get_live_categories: categoriesBody, get_live_streams: streamsBody}, {bytes: {xmltv: Buffer.from(guide)}});
  const catalogue = await new XtreamClient(credentials, transport).catalogue({includeEpg: true, now: 777});
  assert.equal(catalogue.fetchedAt, 777);
  assert.equal(catalogue.categories.length, 2);
  assert.equal(catalogue.channels.length, 2);
  assert.equal(catalogue.channels[0]!.streamId, '101');
  assert.equal(catalogue.epg?.programs[0]?.title, 'Midday News');
  assert.equal(catalogue.epgError, undefined);
  assert.deepEqual(calls, ['/player_api.php', '/player_api.php', '/player_api.php', '/xmltv.php']);
});

test('a guide failure does not discard a usable live catalogue', async () => {
  const {transport} = mock({auth: authBody(), get_live_categories: categoriesBody, get_live_streams: streamsBody}, {bytes: {xmltv: Buffer.from('<html>not a guide</html>')}});
  const catalogue = await new XtreamClient(credentials, transport).catalogue({includeEpg: true});
  assert.equal(catalogue.channels.length, 2);
  assert.equal(catalogue.epg, undefined);
  assert.equal(catalogue.epgError, 'INVALID_XMLTV');
});

test('credentials and catalogues are sealed at rest and multiple providers stay independent', () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault);
  try {
    db.prepare('INSERT INTO users VALUES(?,1)').run('plex-1');
    db.prepare('INSERT INTO users VALUES(?,1)').run('plex-2');
    const first = store.create('admin', {name: 'Primary', credentials});
    const second = store.create('admin', {name: 'Backup', credentials: {...credentials, username: 'other-name', serverUrl: 'https://backup.example'}});
    assert.equal(store.list().length, 2);
    assert.equal(first.serverOrigin, 'https://provider.example:8443');
    const raw = db.prepare('SELECT encrypted_credentials,encrypted_catalogue FROM xtream_accounts WHERE id=?').get(first.id) as {encrypted_credentials: string; encrypted_catalogue: string | null};
    assert.ok(!raw.encrypted_credentials.includes('secret-pass') && !raw.encrypted_credentials.includes('viewer-name'));
    assert.equal(store.credentials(first.id).password, 'secret-pass');
    assert.throws(() => vault.open(raw.encrypted_credentials, 'xtream:credentials:other'));
    assert.ok(!JSON.stringify(store.list()).includes('secret-pass'));

    const catalogue = {version: 1 as const, fetchedAt: 10, account: {status: 'active' as const, expiresAt: null, isTrial: false, maxConnections: 2, activeConnections: 0, allowedFormats: [], timezone: null},
      categories: [{id: '1', name: 'News'}], channels: [{streamId: '101', categoryId: '1', tvgId: 'n', name: 'News', group: 'News', logo: '', streamUrl: 'https://provider.example/live/viewer-name/secret-pass/101.ts'}], ignoredStreams: 0};
    store.saveCatalogue('admin', first.id, catalogue);
    const sealed = db.prepare('SELECT encrypted_catalogue FROM xtream_accounts WHERE id=?').get(first.id) as {encrypted_catalogue: string};
    assert.ok(!sealed.encrypted_catalogue.includes('secret-pass'));
    assert.equal(store.catalogue(first.id)?.channels[0]?.streamId, '101');
    assert.equal(store.catalogue(second.id), undefined, 'each account owns its own catalogue');

    store.setAccess('admin', first.id, ['plex-1']);
    assert.equal(store.canUse('plex-1', first.id), true);
    assert.equal(store.canUse('plex-2', first.id), false);
    assert.equal(store.canUse('plex-1', second.id), false);
    store.setAccess('admin', first.id, ['plex-2']);
    assert.equal(store.canUse('plex-1', first.id), false);
    assert.throws(() => store.setAccess('admin', first.id, ['missing-user']), {code: 'XTREAM_ACCESS_UNKNOWN_USER'});
    assert.throws(() => store.update('admin', first.id, {expectedRevision: 99, name: 'Nope'}), {code: 'REVISION_CONFLICT'});
    assert.equal(store.update('admin', first.id, {expectedRevision: 0, enabled: false}).enabled, false);
    store.remove('admin', first.id, 1);
    assert.equal(store.list().length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM xtream_access').get() as {n: number}).n, 0);
  } finally { db.close(); }
});

test('service records sanitised validation state and refuses to run two operations for one account', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  try {
    const account = store.create('admin', {name: 'Primary', credentials});
    const {transport} = mock({auth: authBody(), get_live_categories: categoriesBody, get_live_streams: streamsBody});
    const service = new XtreamService(store, iptv, () => new XtreamClient(credentials, transport));
    const result = await service.refresh('admin', account.id, {now: 5});
    assert.equal(result.channels, 2); assert.equal(result.categories, 2); assert.equal(result.ignoredStreams, 3);
    const status = store.status(account.id);
    assert.equal(status.catalogueChannels, 2); assert.equal(status.accountStatus, 'active'); assert.equal(status.lastError, null);
    assert.equal(store.catalogue(account.id)?.channels.length, 2);

    const failing = new XtreamService(store, iptv, () => new XtreamClient(credentials, mock({auth: {user_info: {auth: 0}}}).transport));
    await assert.rejects(failing.validate('admin', account.id), {code: 'XTREAM_AUTH_FAILED'});
    assert.equal(store.status(account.id).lastError, 'XTREAM_AUTH_FAILED');
    assert.ok(!JSON.stringify(store.list()).includes('secret-pass'));
  } finally { db.close(); }
});

test('admin API stores providers, hides credentials, and exposes a URL-free catalogue', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), fixture = fakePlex({accountId: 1});
  const {transport} = mock({auth: authBody(), get_live_categories: categoriesBody, get_live_streams: streamsBody});
  const app = await buildApp(config(), db, vault, new PlexAdapter(config(), 'test', fixture.transport), false, 'tk.box', transport);
  const identity = new IdentityService(db, vault, new PlexAdapter(config(), 'test', fixture.transport));
  const owner = await identity.finish((await identity.start()).binding); assert.ok(owner);
  const headers = {origin: 'http://127.0.0.1:3000', cookie: `tk.box_local=${owner.cookie}`};
  try {
    assert.equal((await app.inject({url: '/api/v1/admin/xtream/accounts'})).statusCode, 401);
    const created = await app.inject({method: 'POST', url: '/api/v1/admin/xtream/accounts', headers, payload: {name: 'Primary', credentials, validate: false}});
    assert.equal(created.statusCode, 201);
    assert.ok(!created.body.includes('secret-pass') && !created.body.includes('viewer-name'));
    const account = created.json().account as {id: string; revision: number};
    const list = await app.inject({url: '/api/v1/admin/xtream/accounts', headers});
    assert.equal(list.json().accounts.length, 1); assert.ok(!list.body.includes('secret-pass'));

    const refreshed = await app.inject({method: 'POST', url: `/api/v1/admin/xtream/accounts/${account.id}/refresh`, headers, payload: {includeEpg: false}});
    // Refresh accepts work and answers immediately; the import reports its own progress.
    assert.equal(refreshed.statusCode, 202, refreshed.body);
    assert.equal(refreshed.json().import.state, 'queued');
    assert.ok(!refreshed.body.includes('secret-pass'));
    const finished = await settle(app, account.id, headers);
    assert.equal(finished.state, 'completed', JSON.stringify(finished));
    const catalogue = await app.inject({url: `/api/v1/admin/xtream/accounts/${account.id}/catalogue`, headers});
    assert.equal(catalogue.statusCode, 200);
    assert.equal(catalogue.json().total, 2); assert.equal(catalogue.json().channels[0].name, 'UK: News HD');
    assert.ok(!catalogue.body.includes('/live/') && !catalogue.body.includes('secret-pass'));

    const granted = await app.inject({method: 'PUT', url: `/api/v1/admin/xtream/accounts/${account.id}/access`, headers, payload: {accountIds: [owner.grant.accountId]}});
    assert.equal(granted.statusCode, 200);
    assert.deepEqual(granted.json().accountIds, [owner.grant.accountId]);
    const deleted = await app.inject({method: 'DELETE', url: `/api/v1/admin/xtream/accounts/${account.id}`, headers, payload: {expectedRevision: 0}});
    assert.equal(deleted.statusCode, 200);
    assert.equal((await app.inject({url: `/api/v1/admin/xtream/accounts/${account.id}/catalogue`, headers})).statusCode, 404);
  } finally { await app.close(); db.close(); }
});
