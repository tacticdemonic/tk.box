import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { XtreamService } from '../apps/server/src/services/xtream-service.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { XtreamClient } from '../apps/server/src/providers/xtream.js';
import { buildApp } from '../apps/server/src/app.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { loadConfig } from '../apps/server/src/config.js';
import { config, fakePlex } from './fixtures.js';

const future = () => String(Math.floor(Date.now() / 1000) + 86400);
const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
const auth = (over: Record<string, unknown> = {}) => ({user_info: {auth: 1, status: 'Active', exp_date: future(), max_connections: '2', ...over}, server_info: {timezone: 'Europe/London'}});
const categories = [{category_id: '1', category_name: 'News'}, {category_id: '2', category_name: 'Sports'}];
const streams = (over: Record<string, unknown>[] = []) => [
  {stream_id: 101, name: 'News One', category_id: '1', epg_channel_id: 'news.one', container_extension: 'ts'},
  {stream_id: 102, name: 'News Two', category_id: '1', epg_channel_id: 'news.two', container_extension: 'm3u8'},
  ...over
];
const guide = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="news.one"><display-name>News One</display-name></channel>
<programme channel="news.one" start="20261019120000 +0000" stop="20261019130000 +0000"><title>Midday News</title></programme>
</tv>`;

// A synthetic panel. Routes can be replaced per test to model failures.
function panel(routes: {auth?: unknown; categories?: unknown; streams?: unknown; guide?: Buffer | string} = {}) {
  const calls: string[] = [];
  const transport = async (endpoint: {url: string}) => {
    const url = new URL(endpoint.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    calls.push(action);
    const value = action === 'auth' ? routes.auth ?? auth() : action === 'get_live_categories' ? routes.categories ?? categories : action === 'get_live_streams' ? routes.streams ?? streams() : action === 'xmltv' ? routes.guide ?? guide : undefined;
    if (value === undefined) throw new Error(`unexpected ${action}`);
    return Buffer.from(typeof value === 'string' ? value : value instanceof Buffer ? value : JSON.stringify(value));
  };
  return {transport, calls};
}
function fixture(routes: Parameters<typeof panel>[0] = {}) {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), xtream = new XtreamStore(db, vault), iptv = new IptvStore(db, vault), {transport, calls} = panel(routes);
  const service = new XtreamService(xtream, iptv, () => new XtreamClient(credentials, transport));
  return {db, vault, xtream, iptv, service, calls, transport};
}

test('a refreshed provider publishes its categories and channels into the Live TV source and guide', async () => {
  const {db, vault, xtream, iptv, service} = fixture();
  try {
    const account = xtream.create('owner', {name: 'Primary', credentials});
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    xtream.grant('owner', account.id);
    const result = await service.refresh('owner', account.id, {includeEpg: true});
    assert.equal(result.channels, 2);
    assert.equal(result.epgPrograms, 1);
    const source = iptv.status(result.sourceId);
    assert.equal(source.kind, 'xtream');
    assert.equal(source.xtreamAccountId, account.id);
    const channels = iptv.stacks('owner');
    assert.deepEqual(channels.map(channel => channel.name).sort(), ['News One', 'News Two']);
    // A viewer without a grant sees nothing from the provider.
    assert.equal(iptv.stacks('stranger').length, 0);
    const start = Date.UTC(2026, 9, 19, 11), end = Date.UTC(2026, 9, 19, 14);
    const page = iptv.guidePage('owner', 'iptv', start, end, 0, 30);
    assert.equal(page.channels.length, 2);
    assert.ok(page.channels.some(channel => channel.programs.some(slot => slot.program?.title === 'Midday News')));
    // No response value carries the provider credentials.
    assert.ok(!JSON.stringify({result, source, channels: page.channels}).includes('secret-pass'));
    assert.ok(channels.every(channel => vault && !JSON.stringify(channel).includes('/live/')));
  } finally {db.close();}
});

test('a failed refresh keeps the last known channels, guide and curation', async () => {
  const {db, xtream, iptv, service} = fixture();
  try {
    const account = xtream.create('owner', {name: 'Primary', credentials});
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    xtream.grant('owner', account.id);
    const first = await service.refresh('owner', account.id, {includeEpg: true});
    const channel = iptv.stacks('owner')[0]!;
    iptv.favorite('owner', channel.id, true);
    iptv.editChannel('owner', channel.id, {expectedRevision: iptv.status(first.sourceId).revision, displayName: 'My News', number: 77});
    const before = iptv.adminChannels(first.sourceId);

    const failing = new XtreamService(xtream, iptv, () => new XtreamClient(credentials, panel({auth: {user_info: {auth: 0}}}).transport));
    await assert.rejects(failing.refresh('owner', account.id), {code: 'XTREAM_AUTH_FAILED'});
    assert.equal(xtream.status(account.id).lastError, 'XTREAM_AUTH_FAILED');
    // The stale provider state did not erase the catalogue or the curated rows.
    assert.equal(iptv.stacks('owner').length, 2);
    assert.equal(iptv.favorites('owner')[0]!.id, channel.id);
    assert.deepEqual(iptv.adminChannels(first.sourceId), before);
    const start = Date.UTC(2026, 9, 19, 11), end = Date.UTC(2026, 9, 19, 14);
    assert.ok(iptv.guidePage('owner', 'iptv', start, end, 0, 30).channels.some(c => c.programs.some(slot => slot.program?.title === 'Midday News')));
  } finally {db.close();}
});

test('a refresh keeps channel identity, listings and favourites across renames and reordering', async () => {
  const {db, xtream, iptv, service} = fixture();
  try {
    const account = xtream.create('owner', {name: 'Primary', credentials});
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    xtream.grant('owner', account.id);
    const first = await service.refresh('owner', account.id, {includeEpg: true});
    const before = iptv.adminChannels(first.sourceId), chosen = before[0]!;
    iptv.favorite('owner', chosen.id, true);
    iptv.editChannel('owner', chosen.id, {expectedRevision: iptv.status(first.sourceId).revision, listing: 'always', displayName: 'Kept name', number: 501, position: 3});

    // The same stream ids arrive renamed and in reverse order.
    const renamed = new XtreamService(xtream, iptv, () => new XtreamClient(credentials, panel({streams: streams().reverse().map((s, i) => ({...s, name: `${s.name} Renamed ${i}`}))}).transport));
    await renamed.refresh('owner', account.id, {includeEpg: true});
    const after = iptv.adminChannels(first.sourceId);
    assert.deepEqual(after.map(c => c.id).sort(), before.map(c => c.id).sort());
    const kept = after.find(c => c.id === chosen.id)!;
    assert.equal(kept.name, 'Kept name');
    assert.equal(kept.number, 501);
    assert.equal(kept.position, 3);
    assert.equal(kept.listing, 'always');
    assert.equal(iptv.favorites('owner')[0]!.id, chosen.id);
    assert.equal(after.length, before.length, 'one row per provider stream');
    assert.equal(new Set(after.map(c => c.id)).size, after.length);
  } finally {db.close();}
});

test('provider expiry, disabled accounts and empty refreshes fail closed without losing data', async () => {
  const expired = fixture({auth: auth({status: 'Expired', exp_date: '0'})});
  try {
    const account = expired.xtream.create('owner', {name: 'Primary', credentials});
    await assert.rejects(expired.service.refresh('owner', account.id), {code: 'XTREAM_ACCOUNT_EXPIRED'});
    assert.equal(expired.xtream.status(account.id).accountStatus, 'inactive');
    assert.equal(expired.xtream.canUse('owner', account.id), false);
  } finally {expired.db.close();}

  const empty = fixture({streams: []});
  try {
    const account = empty.xtream.create('owner', {name: 'Primary', credentials});
    empty.db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    empty.xtream.grant('owner', account.id);
    await assert.rejects(empty.service.refresh('owner', account.id), {code: 'XTREAM_EMPTY_CATALOGUE'});
    assert.equal(empty.iptv.stacks('owner').length, 0, 'nothing is published from an empty catalogue');
  } finally {empty.db.close();}
});

test('a provider login creates an application identity without Plex, and a second one stays isolated', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), fixturePlex = fakePlex({accountId: 1});
  const {transport} = panel();
  const app = await buildApp(config(), db, vault, new PlexAdapter(config(), 'test', fixturePlex.transport), false, 'tk.box', transport);
  const headers = {origin: 'http://127.0.0.1:3000'};
  try {
    const first = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: credentials});
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(!first.body.includes('secret-pass') && !first.body.includes('viewer-name'));
    const cookie = first.cookies.find(c => c.name === 'tk.box_local')!.value;
    const session = {origin: headers.origin, cookie: `tk.box_local=${cookie}`};
    // No Plex account is needed: the session lists provider channels and the account page works.
    const accounts = await app.inject({url: '/api/v1/xtream/accounts', headers: session});
    assert.equal(accounts.statusCode, 200);
    assert.equal(accounts.json().accounts.length, 1);
    assert.ok(!accounts.body.includes('secret-pass'));
    const channels = await app.inject({url: '/api/v1/iptv/channels', headers: session});
    assert.equal(channels.statusCode, 200);
    assert.equal(channels.json().channels.length, 2);
    assert.ok(!channels.body.includes('/live/'));
    // A second provider login gets its own account and sees only its own catalogue.
    const second = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...credentials, username: 'other-user'}});
    assert.equal(second.statusCode, 200, second.body);
    const secondCookie = second.cookies.find(c => c.name === 'tk.box_local')!.value, other = {origin: headers.origin, cookie: `tk.box_local=${secondCookie}`};
    const otherAccounts = await app.inject({url: '/api/v1/xtream/accounts', headers: other});
    assert.equal(otherAccounts.json().accounts.length, 1);
    assert.notEqual(otherAccounts.json().accounts[0].id, accounts.json().accounts[0].id);
    assert.equal((await app.inject({url: '/api/v1/xtream/accounts', headers})).statusCode, 401);
    // Logging out ends the session; a second login can start a new one.
    assert.equal((await app.inject({method: 'POST', url: '/api/v1/auth/logout', headers: session, payload: {}})).statusCode, 200);
    assert.equal((await app.inject({url: '/api/v1/xtream/accounts', headers: session})).statusCode, 401);
  } finally {await app.close(); db.close();}
});

test('credentials are sealed, redacted and provider access is scoped per application account', async () => {
  const {db, vault, xtream, iptv, service} = fixture();
  try {
    db.prepare('INSERT INTO users VALUES(?,1)').run('alice');
    db.prepare('INSERT INTO users VALUES(?,1)').run('bob');
    const account = xtream.create('alice', {name: 'Primary', credentials});
    xtream.setAccess('alice', account.id, ['alice']);
    // The creator is already granted access by `create`; the explicit grant keeps the intent clear.
    assert.deepEqual(xtream.access(account.id), ['alice']);
    const raw = db.prepare('SELECT encrypted_credentials FROM xtream_accounts WHERE id=?').get(account.id) as {encrypted_credentials: string};
    assert.ok(!raw.encrypted_credentials.includes('secret-pass') && !raw.encrypted_credentials.includes('viewer-name'));
    assert.equal(vault.open(raw.encrypted_credentials, `xtream:credentials:${account.id}`).includes('secret-pass'), true);
    await service.refresh('alice', account.id);
    assert.equal(xtream.canUse('bob', account.id), false);
    assert.equal(iptv.stacks('bob').length, 0);
    // Revoking access hides the provider immediately.
    xtream.setAccess('alice', account.id, []);
    assert.equal(iptv.stacks('alice').length, 0);
    // Disabling the provider hides its channels without deleting them.
    xtream.setAccess('alice', account.id, ['alice']);
    xtream.update('alice', account.id, {expectedRevision: xtream.status(account.id).revision, enabled: false});
    assert.equal(iptv.stacks('alice').length, 0);
    assert.equal(xtream.canUse('alice', account.id), false);
    xtream.update('alice', account.id, {expectedRevision: xtream.status(account.id).revision, enabled: true});
    assert.equal(iptv.stacks('alice').length, 2);
    // Removing the provider removes its source, channels and catalogue.
    xtream.remove('alice', account.id, xtream.status(account.id).revision);
    assert.equal(iptv.stacks('alice').length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM iptv_sources WHERE kind='xtream'").get() as {n: number}).n, 0);
  } finally {db.close();}
});

test('upstream migrations still apply after the fork migration on a populated database', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tk-m02-migrations-'));
  try {
    const file = join(folder, 'db.sqlite'), vault = new Vault(randomBytes(32));
    let db = openDatabase(file);
    const store = new IptvStore(db, vault), source = store.create('owner', {kind: 'm3u', name: 'Existing'});
    store.ingest('owner', source.id, 0, Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="a",Station A\nhttps://provider.invalid/a.ts'));
    const guide = store.create('owner', {kind: 'xmltv', name: 'Guide'});
    store.bindFeed('owner', source.id, guide.id, store.status(source.id).revision);
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    store.setListingPolicy('owner', source.id, {expectedRevision: store.status(source.id).revision, requireCheck: false, requireGuide: false, guideHours: 2, alwaysOn: []});
    store.favorite('owner', store.adminChannels(source.id)[0]!.id, true);
    // Roll 1002 back to the pre-M02 shape while child rows exist, then apply it again.
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE old(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('m3u','xmltv')),name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
        interval_hours INTEGER NOT NULL,auto_add INTEGER NOT NULL DEFAULT 0,encrypted_endpoint TEXT,encrypted_snapshot TEXT,encrypted_candidate TEXT,
        candidate_digest TEXT,last_attempt INTEGER,last_success INTEGER,next_due INTEGER,last_error TEXT,retry_after INTEGER,sort_order INTEGER NOT NULL DEFAULT 0);
      INSERT INTO old SELECT id,kind,name,revision,interval_hours,auto_add,encrypted_endpoint,encrypted_snapshot,encrypted_candidate,
        candidate_digest,last_attempt,last_success,next_due,last_error,retry_after,sort_order FROM iptv_sources;
      DROP TABLE iptv_sources; ALTER TABLE old RENAME TO iptv_sources;
      DROP TABLE xtream_identities; DROP INDEX xtream_accounts_login_key;
      ALTER TABLE xtream_accounts DROP COLUMN login_key; ALTER TABLE xtream_accounts DROP COLUMN owner_account_id;
      ALTER TABLE xtream_accounts DROP COLUMN is_trial; ALTER TABLE xtream_accounts DROP COLUMN active_connections;
      DELETE FROM migrations WHERE version=1002;`);
    db.close();

    // Reopening applies 1002 over the populated tables and then upstream 10 and 11 again.
    db = openDatabase(file);
    try {
      const versions = (db.prepare('SELECT version FROM migrations ORDER BY version').all() as {version: number}[]).map(row => row.version);
      assert.ok(versions.includes(10) && versions.includes(11) && versions.includes(1001) && versions.includes(1002));
      assert.equal(new Set(versions).size, versions.length, 'every migration records once');
      const kept = new IptvStore(db, vault);
      assert.equal(kept.status(source.id).kind, 'm3u');
      assert.equal(kept.status(source.id).feedId, guide.id, 'the linked guide survived the rebuild');
      assert.equal(kept.visible().length, 1);
      assert.equal(kept.favorites('owner').length, 1);
      assert.equal(kept.adminChannels(source.id).length, 1);
      assert.equal(db.pragma('foreign_keys', {simple: true}), 1, 'foreign keys are enforced for normal operation');
    } finally {db.close();}
  } finally {rmSync(folder, {recursive: true, force: true});}
});

test('the first provider identity becomes administrator only with an owner-controlled bootstrapping rule', async () => {
  // A public deployment without Plex cannot initialize without INITIAL_ADMIN_TOKEN.
  assert.throws(() => loadConfig({PUBLIC_BASE_URL: 'https://tv.example.com'}), /INITIAL_ADMIN_TOKEN/);
  assert.throws(() => loadConfig({DEPLOYMENT_MODE: 'remote', PUBLIC_BASE_URL: 'https://tv.example.com'}), /INITIAL_ADMIN_TOKEN/);
  assert.doesNotThrow(() => loadConfig({PUBLIC_BASE_URL: 'https://tv.example.com', INITIAL_ADMIN_TOKEN: 'owner-initial-token'}));
  // A Plex-configured deployment never needs the token.
  assert.doesNotThrow(() => loadConfig({PUBLIC_BASE_URL: 'https://tv.example.com', PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10'}));

  const {transport} = panel();
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), fixture = fakePlex({accountId: 1});
  const publicConfig = loadConfig({PUBLIC_BASE_URL: 'https://tv.example.com', INITIAL_ADMIN_TOKEN: 'owner-initial-token'});
  const app = await buildApp(publicConfig, db, vault, new PlexAdapter(publicConfig, 'test', fixture.transport), false, 'tk.box', transport);
  const headers = {origin: 'https://tv.example.com'};
  try {
    const setup = await app.inject({url: '/api/v1/setup'});
    assert.equal(setup.json().bootstrapTokenRequired, true);
    // Unauthenticated first sign-in cannot claim the administrator role.
    const missing = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: credentials});
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().code, 'BOOTSTRAP_TOKEN_REQUIRED');
    const wrong = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...credentials, bootstrapToken: 'not-the-owner-token'}});
    assert.equal(wrong.statusCode, 403);
    assert.ok(!wrong.body.includes('owner-initial-token'));
    // The owner initializes the deployment with the server-configured token.
    const first = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...credentials, bootstrapToken: 'owner-initial-token'}});
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().role, 'admin');
    assert.equal((await app.inject({url: '/api/v1/setup'})).json().bootstrapTokenRequired, false);
    // Once an administrator exists, later sign-ins need no token and never become administrators.
    const second = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...credentials, username: 'second-user'}});
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().role, 'viewer');
  } finally {await app.close(); db.close();}

  // A local deployment without Plex keeps the existing zero-configuration first-user flow.
  const localDb = openDatabase(':memory:'), localVault = new Vault(randomBytes(32)), localConfig = loadConfig({});
  const local = await buildApp(localConfig, localDb, localVault, new PlexAdapter(localConfig, 'test', fakePlex({accountId: 1}).transport), false, 'tk.box', panel().transport);
  try {
    assert.equal((await local.inject({url: '/api/v1/setup'})).json().bootstrapTokenRequired, false);
    const first = await local.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers: {origin: 'http://127.0.0.1:3000'}, payload: credentials});
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().role, 'admin');
  } finally {await local.close(); localDb.close();}
});
