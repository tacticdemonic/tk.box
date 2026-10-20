import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, SettingsStore } from '../apps/server/src/persistence/database.js';
import { Vault, digest } from '../apps/server/src/security/vault.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { PlaybackService } from '../apps/server/src/services/playback.js';
import { buildApp } from '../apps/server/src/app.js';
import { config, fakePlex } from './fixtures.js';
import { loadConfig } from '../apps/server/src/config.js';

test('configuration rejects unsafe origins, ports and blanket proxy trust', () => {
  for (const env of [{APP_PORT: '0'}, {APP_PORT: '3000.5'}, {PUBLIC_BASE_URL: 'http://media.example.com'}, {PUBLIC_BASE_URL: 'https://media.example.com/path'}, {TRUSTED_PROXY_CIDRS: '*'}, {DEPLOYMENT_MODE: 'remote'}]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({APP_PORT: '8765', TRUSTED_PROXY_CIDRS: '127.0.0.1/32'}).APP_PORT, 8765);
});
test('credentials use authenticated context-bound encryption', () => {
  const vault = new Vault(randomBytes(32)); const encrypted = vault.seal('not-a-real-secret', 'user-1');
  assert.ok(!encrypted.includes('not-a-real-secret')); assert.equal(vault.open(encrypted, 'user-1'), 'not-a-real-secret');
  assert.throws(() => vault.open(encrypted, 'user-2'));
});
test('Plex identity does not grant access; owner ID determines administrator', async () => {
  for (const accountId of [1, 2]) {
    const f = fakePlex({accountId}), plex = new PlexAdapter(config(), 'test-client', f.transport), grant = await plex.authorize('fixture-account-token');
    assert.equal(grant.role, accountId === 1 ? 'admin' : 'viewer');
    await plex.metadata(grant, '42');
    assert.equal(f.calls.find(c => c.path === '/library/metadata/42')?.token, 'fixture-viewer-server-token');
  }
  for (const options of [{authorized: false}, {missingLibrary: true}]) await assert.rejects(new PlexAdapter(config(), 'test', fakePlex(options).transport).authorize('fixture'), {code: 'PLEX_ACCESS_DENIED'});
});
test('PIN binding, encrypted persistence, polling bounds and revoked access fail closed', async () => {
  const db = openDatabase(':memory:'), f = fakePlex(), plex = new PlexAdapter(config(), 'test', f.transport), identity = new IdentityService(db, new Vault(randomBytes(32)), plex);
  try {
    const link = await identity.start(10000);
    await assert.rejects(identity.finish('other-browser', 13000), {code: 'AUTH_EXPIRED'});
    const signed = await identity.finish(link.binding, 13000); assert.ok(signed);
    const stored = db.prepare('SELECT encrypted_credential FROM sessions').get() as {encrypted_credential: string}; assert.ok(!stored.encrypted_credential.includes('fixture-account-token'));
    await identity.authenticate(signed.cookie, 15000);
    f.options.authorized = false;
    await assert.rejects(identity.authenticate(signed.cookie, 16000), {code: 'PLEX_ACCESS_DENIED'});
    identity.logout(signed.cookie); await assert.rejects(identity.authenticate(signed.cookie, 17000), {code: 'UNAUTHENTICATED'});
  } finally {db.close();}
});
test('immutable stored mode and ownership guard all history writes', async () => {
  const db = openDatabase(':memory:'), f = fakePlex(), plex = new PlexAdapter(config(), 'test', f.transport);
  const playback = new PlaybackService(db, plex), grant = await plex.authorize('fixture');
  try {
    db.prepare('INSERT INTO users VALUES(?,1)').run('2');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('session-hash', '2', 'fixture-encrypted', Date.now() + 10000);
    for (const mode of ['custom_linear', 'iptv_live']) {
      db.prepare('INSERT INTO playback_sessions VALUES(?,?,?,?,?)').run(mode, 'session-hash', mode, '42', Date.now() + 10000);
      await assert.rejects(playback.progress(mode, 'session-hash', grant, 2000, 'stopped'), {code: 'HISTORY_WRITE_FORBIDDEN'});
    }
    assert.ok(!f.calls.some(c => c.path === '/:/timeline'));
    const session = playback.createVod('session-hash', '42');
    await assert.rejects(playback.progress(session.id, 'different-session', grant, 2000, 'playing'), {code: 'SESSION_NOT_FOUND'});
    await playback.progress(session.id, 'session-hash', grant, 2000, 'playing');
    assert.equal(f.calls.filter(c => c.path === '/:/timeline').length, 1);
    assert.equal(f.calls.at(-1)?.token, 'fixture-viewer-server-token');
    await assert.rejects(playback.progress(session.id, 'session-hash', grant, 999999, 'playing'), {code: 'INVALID_PROGRESS'});
  } finally {db.close();}
});
test('HTTP health, CSRF, cookie login, role checks, settings revisions and secret-free responses', async () => {
  const db = openDatabase(':memory:'), f = fakePlex(), plex = new PlexAdapter(config(), 'test', f.transport), vault = new Vault(randomBytes(32));
  const app = await buildApp(config(), db, vault, plex, false), origin = 'http://127.0.0.1:3000';
  try {
    assert.equal((await app.inject({url: '/health', headers: {'x-forwarded-proto': 'https', host: 'attacker.invalid'}})).statusCode, 200);
    assert.equal((await app.inject({url: '/api/v1/admin/settings/playback'})).statusCode, 401);
    assert.equal((await app.inject({method: 'POST', url: '/api/v1/auth/plex/start', payload: {}, headers: {origin: 'https://attacker.invalid'}})).statusCode, 403);
    const start = await app.inject({method: 'POST', url: '/api/v1/auth/plex/start', payload: {}, headers: {origin}});
    assert.equal(start.statusCode, 200); assert.ok(start.json().authUrl.startsWith('https://app.plex.tv/auth#?'));
    const binding = start.cookies[0]!;
    const finish = await app.inject({method: 'POST', url: '/api/v1/auth/plex/status', payload: {}, headers: {origin, cookie: `${binding.name}=${binding.value}`}});
    assert.equal(finish.statusCode, 200);
    const session = finish.cookies.find(c => c.name === 'tk.box_local')!, headers = {origin, cookie: `tk.box_local=${session.value}`};
    assert.ok(session.httpOnly); assert.equal((await app.inject({url: '/api/v1/admin/settings/playback', headers})).statusCode, 403);
    const libs = await app.inject({url: '/api/v1/libraries', headers}); assert.equal(libs.json().libraries.length, 2); assert.ok(!libs.body.includes('token'));
    const vod = await app.inject({method: 'POST', url: '/api/v1/playback/sessions', headers, payload: {mode: 'plex_vod', ratingKey: '42', capabilities: {videoCodecs: ['h264:8'], audioCodecs: ['aac'], containers: ['mp4']}}}); assert.equal(vod.statusCode, 200); assert.ok(!vod.body.includes('fixture'));
    const file = await app.inject({url: vod.json().streamUrl, headers: {...headers, range:'bytes=0-2'}}); assert.equal(file.statusCode,206); assert.equal(file.headers['content-range'],'bytes 0-2/3'); assert.equal(file.rawPayload.length,3);
    assert.equal((await app.inject({url: vod.json().streamUrl})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/playback/sessions',headers,payload:{mode:'plex_vod',ratingKey:'42',url:'http://arbitrary.invalid'}})).statusCode,400);
    f.options.accountId = 1; // Obtain a new owner session, never mutate an existing session identity.
    const id = new IdentityService(db, vault, plex), ownerLink = await id.start(), owner = await id.finish(ownerLink.binding); assert.ok(owner);
    const adminHeaders = {origin, cookie: `tk.box_local=${owner.cookie}`};
    const store = new SettingsStore(db); assert.equal(store.get().maxConcurrentCpuVideoTranscodes, 2);
    const update = await app.inject({method: 'PATCH', url: '/api/v1/admin/settings/playback', headers: adminHeaders, payload: {expectedRevision: 0, maxConcurrentCpuVideoTranscodes: 3, pauseRetentionMinutes: 15}}); assert.equal(update.statusCode, 200);
    assert.equal((await app.inject({method: 'PATCH', url: '/api/v1/admin/settings/playback', headers: adminHeaders, payload: {expectedRevision: 0, maxConcurrentCpuVideoTranscodes: 3, pauseRetentionMinutes: 15}})).statusCode, 409);
    assert.equal(store.get().pauseRetentionMinutes, 15);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('token'));
    assert.equal(digest(owner.cookie).length, 64);
  } finally {await app.close(); db.close();}
});

test('preview authentication uses separate cookie names and cannot replace the real app session',async()=>{
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),fixture=fakePlex(),plex=new PlexAdapter(config(),'cookie-isolation',fixture.transport);
  const app=await buildApp(config(),db,vault,plex,false),preview=await buildApp(config(),db,vault,plex,false,'tk.box_ui_preview'),origin='http://127.0.0.1:3000';
  try {
    const login=async(server:typeof app,namespace:string)=>{
      const start=await server.inject({method:'POST',url:'/api/v1/auth/plex/start',headers:{origin},payload:{}});
      const challenge=start.cookies[0]!;assert.equal(challenge.name,`${namespace}_link`);
      const finish=await server.inject({method:'POST',url:'/api/v1/auth/plex/status',headers:{origin,cookie:`${challenge.name}=${challenge.value}`},payload:{}});
      assert.equal(finish.statusCode,200);
      const session=finish.cookies.find(c=>c.name===`${namespace}_local`)!;assert.ok(session);
      assert.ok(finish.cookies.every(c=>c.name.startsWith(`${namespace}_`)));
      return `${session.name}=${session.value}`;
    };
    const realCookie=await login(app,'tk.box'),previewCookie=await login(preview,'tk.box_ui_preview'),both=`${realCookie}; ${previewCookie}`;
    assert.equal((await app.inject({url:'/api/v1/me',headers:{cookie:both}})).statusCode,200);
    assert.equal((await preview.inject({url:'/api/v1/me',headers:{cookie:both}})).statusCode,200);
    await preview.inject({method:'POST',url:'/api/v1/auth/logout',headers:{origin,cookie:both},payload:{}});
    assert.equal((await app.inject({url:'/api/v1/me',headers:{cookie:both}})).statusCode,200);
    assert.equal((await preview.inject({url:'/api/v1/me',headers:{cookie:both}})).statusCode,401);
  }finally{await app.close();await preview.close();db.close();}
});

test('rebranding preserves existing Plex links and sessions with secure and preview cookie isolation', async () => {
  for (const secure of [false, true]) for (const preview of [false, true]) {
    const c = secure ? {...config(), PUBLIC_BASE_URL: 'https://media.example.com', secureCookies: true, browserOrigin: 'https://media.example.com'} : config();
    const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), fixture = fakePlex(), plex = new PlexAdapter(c, 'rebrand', fixture.transport);
    const namespace = preview ? 'tk.box_ui_preview_3012' : 'tk.box', legacy = preview ? 'enki_ui_preview_3012' : 'enki';
    const sessionName = secure ? `__Host-${namespace}` : `${namespace}_local`, oldSession = secure ? `__Host-${legacy}` : `${legacy}_local`;
    const app = await buildApp(c, db, vault, plex, false, namespace), identity = new IdentityService(db, vault, plex), origin = c.browserOrigin;
    try {
      const link = await identity.start();
      const finish = await app.inject({method: 'POST', url: '/api/v1/auth/plex/status', headers: {origin, cookie: `${legacy}_link=${link.binding}`}, payload: {}});
      assert.equal(finish.statusCode, 200);
      const session = finish.cookies.find(cookie => cookie.name === sessionName)!; assert.ok(session);
      assert.equal(session.httpOnly, true); assert.equal(!!session.secure, secure);
      const cookie = `${oldSession}=${session.value}`;
      const me = await app.inject({url: '/api/v1/me', headers: {cookie}});
      assert.equal(me.statusCode, 200); assert.equal(me.cookies.find(cookie => cookie.name === sessionName)?.value, session.value);
      assert.equal(me.cookies.find(cookie => cookie.name === oldSession)?.value, '');
      const wrongNamespace = secure ? `__Host-${preview ? 'enki' : 'enki_ui_preview_3012'}` : `${preview ? 'enki' : 'enki_ui_preview_3012'}_local`;
      assert.equal((await app.inject({url: '/api/v1/me', headers: {cookie: `${wrongNamespace}=${session.value}`}})).statusCode, 401);
      assert.equal((await app.inject({url: '/api/v1/me', headers: {cookie: `${sessionName}=invalid; ${cookie}`}})).statusCode, 401);
      assert.equal((await app.inject({method: 'POST', url: '/api/v1/auth/logout', headers: {origin, cookie}, payload: {}})).statusCode, 200);
      assert.equal((await app.inject({url: '/api/v1/me', headers: {cookie}})).statusCode, 401);
    } finally {await app.close(); db.close();}
  }
});

test('a Plex-less deployment reachable from another device always needs the bootstrap token', async () => {
  const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
  // A synthetic panel: auth, an empty category list and no live streams.
  const panel = async (endpoint: {url: string}) => {
    const action = new URL(endpoint.url).searchParams.get('action') ?? 'auth';
    return Buffer.from(JSON.stringify(action === 'auth'
      ? {user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}, server_info: {timezone: 'Europe/London'}}
      : []));
  };
  // Loopback-only development keeps zero-configuration bootstrap.
  for (const host of ['127.0.0.1', '::1', 'localhost', '127.0.0.53']) {
    assert.equal(loadConfig({APP_HOST: host}).loopbackOnly, true, host);
    assert.doesNotThrow(() => loadConfig({APP_HOST: host}), host);
  }
  // Any other bind is reachable from the LAN, whatever the deployment-mode label says.
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '100.64.0.1']) {
    assert.equal(loadConfig({APP_HOST: host, INITIAL_ADMIN_TOKEN: 'owner-initial-token'}).loopbackOnly, false, host);
    assert.throws(() => loadConfig({APP_HOST: host}), /INITIAL_ADMIN_TOKEN/, host);
  }
  assert.throws(() => loadConfig({DEPLOYMENT_MODE: 'remote', PUBLIC_BASE_URL: 'https://tv.example.com', APP_HOST: '127.0.0.1'}), /INITIAL_ADMIN_TOKEN/);

  // The runtime guard agrees with configuration: a LAN listener without a token cannot bootstrap.
  const lan = loadConfig({APP_HOST: '0.0.0.0', INITIAL_ADMIN_TOKEN: 'owner-initial-token'});
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const app = await buildApp(lan, db, vault, new PlexAdapter(lan, 'lan-bootstrap', fakePlex({accountId: 1}).transport), false, 'tk.box', panel);
  const headers = {origin: lan.browserOrigin};
  try {
    assert.equal((await app.inject({url: '/api/v1/setup'})).json().bootstrapTokenRequired, true);
    const missing = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: credentials});
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().code, 'BOOTSTRAP_TOKEN_REQUIRED');
    assert.ok(!missing.body.includes('owner-initial-token'));
    const first = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...credentials, bootstrapToken: 'owner-initial-token'}});
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().role, 'admin');
    // The token is configuration, never persisted with the account it created.
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM xtream_identities').all()).includes('owner-initial-token'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('owner-initial-token'));
  } finally {await app.close(); db.close();}
});

test('the Fire TV shell CSRF marker is accepted while a browser origin stays required', async () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), f = fakePlex({accountId: 1});
  const c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'test', f.transport), false);
  const post = (headers: Record<string, string>) => app.inject({method: 'POST', url: '/api/v1/auth/logout', headers, payload: {}});
  try {
    const origin = c.browserOrigin;
    // A WebView before 83 sends Origin: null plus its package marker.
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'content-type': 'application/json'})).statusCode, 200);
    // A page cannot forge that marker without a preflight this server refuses, so it is not a
    // CSRF bypass; the checks still reject everything they rejected before.
    // Logout is idempotent, so the status distinguishes the CSRF guard, not session state.
    const rejects = (headers: Record<string, string>) => post(headers).then(r => r.statusCode);
    assert.equal(await rejects({origin: 'null', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'null', 'x-requested-with': 'com.evil app', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'null', 'x-requested-with': 'com.tkbox.tv/extra', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'null', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'https://evil.example', 'x-requested-with': 'com.tkbox.tv', 'content-type': 'application/json'}), 403);
    assert.equal(await rejects({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'content-type': 'text/plain'}), 415);
    assert.equal(await rejects({'x-requested-with': 'com.tkbox.tv', 'content-type': 'application/json'}), 403);
    assert.equal((await post({origin, 'content-type': 'application/json'})).statusCode, 200);
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json'})).statusCode, 200);
    // No CORS headers are ever emitted, so a hostile page's preflight cannot unlock the marker.
    for (const preflight of [
      {origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with,content-type'},
      {origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'}
    ]) {
      const answer = await app.inject({method: 'OPTIONS', url: '/api/v1/auth/logout', headers: preflight});
      assert.equal(answer.headers['access-control-allow-origin'], undefined);
      assert.equal(answer.headers['access-control-allow-headers'], undefined);
      assert.equal(answer.headers['access-control-allow-methods'], undefined);
    }
    // A GET is never origin-checked, as before.
    assert.equal((await app.inject({url: '/health'})).statusCode, 200);
  } finally {await app.close(); db.close();}
});

test('the session cookie omits SameSite so an old WebView can hand it to the native player', async () => {
  // WebView 66's CookieManager.getCookie() hides Lax/Strict cookies, which left the native
  // player with no session. The server must therefore omit the attribute (browsers default it
  // to Lax) rather than emit SameSite=Lax explicitly.
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), f = fakePlex({accountId: 1});
  const c = config(), app = await buildApp(c, db, vault, new PlexAdapter(c, 'test', f.transport), false);
  const origin = c.browserOrigin;
  try {
    const start = await app.inject({method: 'POST', url: '/api/v1/auth/plex/start', headers: {origin}, payload: {}});
    const binding = start.cookies[0]!;
    assert.equal(binding.sameSite, undefined);
    const finish = await app.inject({method: 'POST', url: '/api/v1/auth/plex/status', headers: {origin, cookie: `${binding.name}=${binding.value}`}, payload: {}});
    const session = finish.cookies.find(cookie => cookie.name === 'tk.box_local')!;
    assert.equal(session.sameSite, undefined);
    // HttpOnly is unchanged: page JavaScript still cannot read it.
    assert.equal(session.httpOnly, true);
  } finally {await app.close(); db.close();}
});

test('an HTTP provider login is accepted with the same explicit opt-in it was stored with', async () => {
  const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
  const panel = async (endpoint: {url: string}) => {
    const action = new URL(endpoint.url).searchParams.get('action') ?? 'auth';
    return Buffer.from(JSON.stringify(action === 'auth'
      ? {user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400)}, server_info: {timezone: 'Europe/London'}}
      : []));
  };
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), c = config();
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'test', fakePlex({accountId: 1}).transport), false, 'tk.box', panel);
  const headers = {origin: c.browserOrigin};
  try {
    const first = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: credentials});
    assert.equal(first.statusCode, 200, first.body);
    // A plain-HTTP provider needs the opt-in both when stored and when looked up on sign-in;
    // the lookup previously re-normalised without it and answered XTREAM_ENDPOINT_REJECTED.
    const insecure = {...credentials, serverUrl: 'http://127.0.0.1:1', allowInsecureHttp: true};
    const rejected = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: {...insecure, allowInsecureHttp: false}});
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, 'XTREAM_ENDPOINT_REJECTED');
    // With the opt-in the endpoint is accepted; only the synthetic panel is unreachable.
    const accepted = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers, payload: insecure});
    assert.notEqual(accepted.json().code, 'XTREAM_ENDPOINT_REJECTED');
  } finally {await app.close(); db.close();}
});
