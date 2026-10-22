import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { buildApp } from '../apps/server/src/app.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamService } from '../apps/server/src/services/xtream-service.js';
import { XtreamImports } from '../apps/server/src/services/xtream-imports.js';
import { XtreamClient } from '../apps/server/src/providers/xtream.js';
import type { SourceEndpoint } from '../apps/server/src/providers/source-fetch.js';
import { config, fakePlex, settle } from './fixtures.js';

const future = () => String(Math.floor(Date.now() / 1000) + 86400);
const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
const authBody = (over: Record<string, unknown> = {}) => ({user_info: {auth: 1, status: 'Active', exp_date: future(), max_connections: '2', ...over}, server_info: {timezone: 'Europe/London'}});
const categories = [{category_id: '1', category_name: 'News'}];
const streams = (count = 2) => Array.from({length: count}, (_, i) => ({stream_id: 101 + i, name: `Channel ${i + 1}`, category_id: '1', epg_channel_id: `news.${i + 1}`, container_extension: 'ts'}));
const guide = `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="news.1"><display-name>Channel 1</display-name></channel>
<programme channel="news.1" start="20261019120000 +0000" stop="20261019130000 +0000"><title>Midday News</title></programme></tv>`;

// A synthetic panel whose catalogue and guide calls wait until `release()`, honouring the abort
// signal the way the real transport does. Authentication answers at once, so nothing but the
// import itself can hold a sign-in response.
function panel(options: {streams?: unknown[]; guide?: string; failCatalogue?: boolean} = {}) {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const calls: string[] = [];
  const transport = async (endpoint: SourceEndpoint, signal?: AbortSignal) => {
    const url = new URL(endpoint.url), action = url.pathname.endsWith('xmltv.php') ? 'xmltv' : url.searchParams.get('action') ?? 'auth';
    calls.push(action);
    if (action === 'auth') return Buffer.from(JSON.stringify(authBody()));
    await new Promise<void>((resolve, reject) => {
      gate.then(resolve);
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
    });
    if (action === 'get_live_categories') return Buffer.from(JSON.stringify(categories));
    if (action === 'get_live_streams') {
      if (options.failCatalogue) throw new Error('synthetic provider failure');
      return Buffer.from(JSON.stringify(options.streams ?? streams()));
    }
    if (action === 'xmltv') return Buffer.from(options.guide ?? guide);
    throw new Error(`unexpected ${action}`);
  };
  return {transport, calls, release: () => open()};
}

const origin = 'http://127.0.0.1:3000';
const login = (app: {inject: Function}, payload: Record<string, unknown> = credentials) =>
  app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers: {origin}, payload});
const cookieOf = (response: {cookies: {name: string; value: string}[]}) => response.cookies.find(c => c.name === 'tk.box_local')!.value;
const importRows = (db: ReturnType<typeof openDatabase>) => db.prepare('SELECT * FROM xtream_imports ORDER BY created_at,rowid').all() as {id: string; state: string; error: string | null; guide_error: string | null}[];
const accountOf = (db: ReturnType<typeof openDatabase>) => (db.prepare('SELECT id FROM xtream_accounts').get() as {id: string}).id;

test('A/D. sign-in returns an authenticated session while a deliberately delayed import is still pending', async () => {
  const fixture = panel();
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-a', fakePlex({accountId: 1}).transport), false, 'tk.box', fixture.transport);
  try {
    // Nothing is released yet, so any code that awaited the catalogue would never answer.
    const response = await login(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'authenticated');
    const cookie = cookieOf(response);
    assert.ok(cookie, 'a session cookie is issued');
    const session = {origin, cookie: `tk.box_local=${cookie}`};

    // B. The authenticated shell works before the import finishes.
    assert.equal((await app.inject({url: '/api/v1/me', headers: session})).statusCode, 200);
    const account = accountOf(db);
    const status = (await app.inject({url: `/api/v1/xtream/accounts/${account}/imports`, headers: session})).json();
    assert.equal(status.active.state, 'running', JSON.stringify(status));
    assert.equal(importRows(db)[0]!.state, 'running', 'the import has not completed at sign-in');
    assert.equal((await app.inject({url: '/api/v1/iptv/channels', headers: session})).statusCode, 200);
  } finally {await app.close(); db.close();}
});

test('C. rejected credentials issue no session and queue no import', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-c', fakePlex({accountId: 1}).transport), false, 'tk.box',
    async () => Buffer.from(JSON.stringify({user_info: {auth: 0, status: 'Active'}})));
  try {
    const bad = await login(app);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.cookies.length, 0, 'no session before authentication');
    assert.equal(importRows(db).length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM xtream_accounts').get() as {n: number}).n, 0);
  } finally {await app.close(); db.close();}
});

test('C. a wrong bootstrap token issues 403 before authentication and queues no import', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const c = {...config(), plexConfigured: false, INITIAL_ADMIN_TOKEN: 'owner-initial-token'};
  let authCalls = 0;
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-c2', fakePlex({accountId: 1}).transport), false, 'tk.box',
    async (endpoint: SourceEndpoint, signal?: AbortSignal) => { authCalls++; return panel().transport(endpoint, signal); });
  try {
    const wrong = await login(app, {...credentials, bootstrapToken: 'not-the-token'});
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.json().code, 'BOOTSTRAP_TOKEN_REQUIRED');
    assert.equal(authCalls, 0, 'the panel is not called before the bootstrap guard passes');
    assert.equal(importRows(db).length, 0);
  } finally {await app.close(); db.close();}
});

test('E. repeated sign-ins, manual refreshes and scheduled work join one import per provider', async () => {
  const fixture = panel();
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-e', fakePlex({accountId: 1}).transport), false, 'tk.box', fixture.transport);
  try {
    const first = await login(app), second = await login(app);
    assert.equal(first.json().import.id, second.json().import.id, 'a repeated sign-in joins the pending import');
    const session = {origin, cookie: `tk.box_local=${cookieOf(first)}`}, account = accountOf(db);
    const manual = await app.inject({method: 'POST', url: `/api/v1/xtream/accounts/${account}/refresh`, headers: session, payload: {includeEpg: true}});
    assert.equal(manual.statusCode, 202, manual.body);
    assert.equal(manual.json().import.id, first.json().import.id);
    assert.equal(importRows(db).length, 1);

    fixture.release();
    const done = await settle(app, account, session);
    assert.equal(done.state, 'completed', JSON.stringify(done));
    // A manual refresh after completion starts exactly one new import, not a second concurrent one.
    const again = await app.inject({method: 'POST', url: `/api/v1/xtream/accounts/${account}/refresh`, headers: session, payload: {}});
    assert.equal(again.statusCode, 202, again.body);
    const settled = await settle(app, account, session);
    assert.equal(settled.state, 'completed');
    assert.notEqual(again.json().import.id, first.json().import.id);
    assert.equal(importRows(db).filter(row => row.state === 'completed').length, 2);
    assert.equal(importRows(db).filter(row => row.state === 'running' || row.state === 'queued').length, 0);
  } finally {await app.close(); db.close();}
});

test('F. import status is scoped to the provider account its viewer may read', async () => {
  const fixture = panel();
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-f', fakePlex({accountId: 1}).transport), false, 'tk.box', fixture.transport);
  try {
    const owner = await login(app), outsider = await login(app, {...credentials, username: 'other-user'});
    const ownerSession = {origin, cookie: `tk.box_local=${cookieOf(owner)}`}, otherSession = {origin, cookie: `tk.box_local=${cookieOf(outsider)}`};
    const account = (await app.inject({url: '/api/v1/xtream/accounts', headers: ownerSession})).json().accounts[0];
    const job = owner.json().import.id;
    assert.equal((await app.inject({url: `/api/v1/xtream/accounts/${account.id}/imports`, headers: otherSession})).statusCode, 404);
    assert.equal((await app.inject({url: `/api/v1/xtream/accounts/${account.id}/imports/${job}`, headers: otherSession})).statusCode, 404);
    assert.equal((await app.inject({url: `/api/v1/xtream/accounts/${account.id}/imports/${job}`, headers: ownerSession})).statusCode, 200);
    // Nor can the outsider start work on a provider it cannot see.
    assert.equal((await app.inject({method: 'POST', url: `/api/v1/xtream/accounts/${account.id}/refresh`, headers: otherSession, payload: {}})).statusCode, 404);
  } finally {await app.close(); db.close();}
});

test('G. catalogue and guide failures produce accurate states and keep the last known channels', async () => {
  const fixture = panel();
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  // The guide fails on the second import; the catalogue is fine.
  let guideBroken = false;
  const transport = async (endpoint: SourceEndpoint, signal?: AbortSignal) => {
    const action = new URL(endpoint.url).pathname.endsWith('xmltv.php') ? 'xmltv' : new URL(endpoint.url).searchParams.get('action') ?? 'auth';
    if (guideBroken && action === 'xmltv') throw new Error('synthetic guide failure');
    return fixture.transport(endpoint, signal);
  };
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-g', fakePlex({accountId: 1}).transport), false, 'tk.box', transport);
  try {
    const first = await login(app), session = {origin, cookie: `tk.box_local=${cookieOf(first)}`}, account = accountOf(db);
    fixture.release();
    assert.equal((await settle(app, account, session)).state, 'completed');
    assert.equal((await app.inject({url: '/api/v1/iptv/channels', headers: session})).json().channels.length, 2);

    // A guide-only failure is reported as such; the channels are untouched.
    guideBroken = true;
    await app.inject({method: 'POST', url: `/api/v1/xtream/accounts/${account}/refresh`, headers: session, payload: {}});
    const guided = await settle(app, account, session);
    assert.equal(guided.state, 'completed');
    assert.equal(guided.guideError, 'XTREAM_UNREACHABLE');
    assert.equal((await app.inject({url: '/api/v1/iptv/channels', headers: session})).json().channels.length, 2);
  } finally {await app.close(); db.close();}
});

test('G. a catalogue failure is an import failure, not a credential failure', async () => {
  const fixture = panel(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const failTransport: typeof fixture.transport = async (endpoint, signal) => {
    if ((new URL(endpoint.url).searchParams.get('action') ?? 'auth') === 'get_live_streams') throw new Error('synthetic catalogue failure');
    return fixture.transport(endpoint, signal);
  };
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-g2', fakePlex({accountId: 1}).transport), false, 'tk.box', failTransport);
  try {
    const first = await login(app), session = {origin, cookie: `tk.box_local=${cookieOf(first)}`}, account = accountOf(db);
    fixture.release();
    const failed = await settle(app, account, session);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'XTREAM_UNREACHABLE');
    // The sign-in still stands: the session is usable and the account is not marked invalid.
    assert.equal((await app.inject({url: '/api/v1/me', headers: session})).statusCode, 200);
    assert.equal((await app.inject({url: `/api/v1/xtream/accounts/${account}`, headers: session})).json().enabled, true);
  } finally {await app.close(); db.close();}
});

test('H. a credential change during an import publishes nothing stale', async () => {
  const fixture = panel(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-h', fakePlex({accountId: 1}).transport), false, 'tk.box', fixture.transport);
  try {
    const first = await login(app), session = {origin, cookie: `tk.box_local=${cookieOf(first)}`}, account = accountOf(db);
    const changed = await app.inject({method: 'PATCH', url: `/api/v1/xtream/accounts/${account}`, headers: session,
      payload: {expectedRevision: 0, credentials: {...credentials, password: 'new-secret'}}});
    assert.equal(changed.statusCode, 200, changed.body);
    fixture.release();
    const job = await settle(app, account, session);
    assert.equal(job.state, 'failed');
    assert.equal(job.error, 'XTREAM_CREDENTIALS_CHANGED');
    assert.equal((await app.inject({url: '/api/v1/iptv/channels', headers: session})).json().channels.length, 0, 'stale results are not published');
    assert.equal((db.prepare('SELECT encrypted_catalogue FROM xtream_accounts').get() as {encrypted_catalogue: string | null}).encrypted_catalogue, null);
  } finally {await app.close(); db.close();}
});

test('H. a restart reports unfinished imports as interrupted instead of running forever', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  try {
    const account = store.create('owner', {name: 'Primary', credentials});
    const service = new XtreamService(store, iptv, () => new XtreamClient(credentials, panel().transport));
    store.queueImport('owner', account.id, true);
    db.prepare("UPDATE xtream_imports SET state='running',started_at=1,stage='catalogue'").run();
    const imports = new XtreamImports(store, service);
    const status = store.importStatus(account.id);
    assert.equal(status.active, null);
    assert.equal(status.latest?.state, 'interrupted');
    assert.equal(status.latest?.error, 'IMPORT_INTERRUPTED');
    // The queue is usable again after the stale row is closed.
    imports.schedule('owner', account.id, true);
    assert.equal(importRows(db).length, 2);
    await imports.close();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM xtream_imports WHERE state IN (\'queued\',\'running\')').get() as {n: number}).n, 0);
  } finally {db.close();}
});

test('I. an 8,436-channel catalogue imports while health, status and UI reads stay responsive', async () => {
  const fixture = panel({streams: streams(8436)}), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'imports-i', fakePlex({accountId: 1}).transport), false, 'tk.box', fixture.transport);
  try {
    const started = Date.now();
    const first = await login(app);
    // The sign-in is answered by the authentication call alone, whatever the catalogue costs.
    assert.ok(Date.now() - started < 5000, `sign-in answered in ${Date.now() - started}ms`);
    const session = {origin, cookie: `tk.box_local=${cookieOf(first)}`}, account = accountOf(db);
    fixture.release();
    const probes = await Promise.all([
      app.inject({url: '/health'}),
      app.inject({url: '/api/v1/me', headers: session}),
      app.inject({url: '/api/v1/xtream/accounts', headers: session}),
      app.inject({url: `/api/v1/xtream/accounts/${account}/imports`, headers: session}),
      app.inject({url: '/api/v1/iptv/channels', headers: session})
    ]);
    for (const probe of probes) assert.ok(probe.statusCode < 500, probe.body);
    const done = await settle(app, account, session, 400);
    assert.equal(done.state, 'completed', JSON.stringify(done));
    // Channel rows, not guide stacks: the guide groups same-station names, so it is not the count.
    const published = (db.prepare("SELECT COUNT(*) AS n FROM iptv_channels WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?) AND present=1").get(account) as {n: number}).n;
    assert.equal(published, 8436);
  } finally {await app.close(); db.close();}
});

test('the import manager never mistakes a validation promise for a finished import', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  let releaseAuth!: () => void;
  const gate = new Promise<void>(resolve => { releaseAuth = resolve; });
  const transport = async (endpoint: SourceEndpoint) => {
    const action = new URL(endpoint.url).searchParams.get('action') ?? 'auth';
    if (action === 'auth') { await gate; return Buffer.from(JSON.stringify(authBody())); }
    if (action === 'get_live_categories') return Buffer.from(JSON.stringify(categories));
    return Buffer.from(JSON.stringify(streams()));
  };
  const service = new XtreamService(store, iptv, () => new XtreamClient(credentials, transport));
  const imports = new XtreamImports(store, service);
  try {
    const account = store.create('owner', {name: 'Primary', credentials});
    const validation = service.validate('owner', account.id);
    const job = imports.schedule('owner', account.id, false);
    // While validation holds the provider, the import has not completed and no catalogue exists:
    // a validation result must never stand in for an import's.
    assert.notEqual(store.import(job.id).state, 'completed');
    assert.equal(store.import(job.id).finishedAt, null);
    assert.equal(store.catalogue(account.id), undefined);
    releaseAuth();
    await validation;
    const finished = await imports.run('owner', account.id, false);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.error, null);
    assert.equal(store.catalogue(account.id)?.channels.length, 2);
  } finally {await imports.close(); db.close();}
});
