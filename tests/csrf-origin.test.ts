import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { buildApp, classifyCsrfRejection, hasShellMarker } from '../apps/server/src/app.js';
import { fakePlex } from './fixtures.js';
import { loadConfig } from '../apps/server/src/config.js';

// A Plex-configured LAN deployment: the bind address is a wildcard, the browser-facing origin is
// the LAN address a Fire Stick actually enters, and the two must not be conflated.
const lan = () => loadConfig({APP_HOST: '0.0.0.0', APP_ORIGIN: 'http://192.168.1.50:3000',
  PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10,20'});
const credentials = {serverUrl: 'https://provider.example:8443', username: 'viewer-name', password: 'secret-pass'};
const rejectingPanel = async () => Buffer.from(JSON.stringify({user_info: {auth: 0}}));

test('the listen address is separated from the browser-facing origin', () => {
  const c = lan();
  assert.equal(c.listenHost, '0.0.0.0');
  assert.equal(c.listenPort, 3000);
  assert.equal(c.browserOrigin, 'http://192.168.1.50:3000');
  assert.equal(c.appOrigin, 'http://192.168.1.50:3000');
  assert.equal(c.publicOrigin, undefined);
  assert.equal(c.wildcardBind, true);
  assert.equal(c.unconfiguredWildcardOrigin, false);
  // A wildcard bind is not loopback-reachable only: another device can connect.
  assert.equal(c.loopbackOnly, false);
  // No wildcard is ever accepted as an origin.
  assert.throws(() => loadConfig({APP_ORIGIN: 'http://0.0.0.0:3000'}), /APP_ORIGIN/);
  assert.throws(() => loadConfig({APP_ORIGIN: 'http://[::]:3000'}), /APP_ORIGIN/);
  assert.throws(() => loadConfig({APP_ORIGIN: 'http://192.168.1.50:3000/path'}), /APP_ORIGIN/);
  assert.throws(() => loadConfig({APP_ORIGIN: 'http://user:pass@192.168.1.50:3000'}), /APP_ORIGIN/);
});

test('HTTP LAN, HTTPS remote and loopback development keep their own cookie and origin rules', () => {
  // LAN HTTP debug: no Secure cookie, origin is the LAN IP.
  const http = lan();
  assert.equal(http.secureCookies, false);
  // A wildcard bind with neither APP_ORIGIN nor PUBLIC_BASE_URL is flagged, not silently trusted.
  const bare = loadConfig({APP_HOST: '0.0.0.0', INITIAL_ADMIN_TOKEN: 'owner-initial-token'});
  assert.equal(bare.unconfiguredWildcardOrigin, true);
  assert.equal(bare.browserOrigin, 'http://0.0.0.0:3000');
  // Remote HTTPS: PUBLIC_BASE_URL is canonical, Secure cookies, no trailing-slash mismatch.
  const remote = loadConfig({DEPLOYMENT_MODE: 'remote', PUBLIC_BASE_URL: 'https://tv.example.com/', INITIAL_ADMIN_TOKEN: 'owner-initial-token'});
  assert.equal(remote.browserOrigin, 'https://tv.example.com');
  assert.equal(remote.secureCookies, true);
  // Loopback development is unchanged and needs no origin at all.
  const loopback = loadConfig({PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10'});
  assert.equal(loopback.browserOrigin, 'http://127.0.0.1:3000');
  assert.equal(loopback.secureCookies, false);
  assert.equal(loopback.loopbackOnly, true);
  // Two different origins for the same listener is a configuration error, not a guess.
  assert.throws(() => loadConfig({APP_ORIGIN: 'http://192.168.1.50:3000', PUBLIC_BASE_URL: 'https://tv.example.com',
    PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10'}), /must match/);
  // HTTPS APP_ORIGIN on a LAN origin still opts into Secure cookies.
  assert.equal(loadConfig({APP_ORIGIN: 'https://tv.example.com', PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10'}).secureCookies, true);
});

test('a LAN origin is accepted for login and state changes, while other hosts and ports are refused', async () => {
  const c = lan(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'lan-csrf', fakePlex({accountId: 1}).transport), false);
  const post = (origin?: string, extra: Record<string, string> = {}) =>
    app.inject({method: 'POST', url: '/api/v1/auth/plex/start', payload: {}, headers: {...(origin === undefined ? {} : {origin}), ...extra}});
  try {
    assert.equal((await post(c.browserOrigin)).statusCode, 200);
    for (const other of ['http://192.168.1.50:3001', 'http://192.168.1.51:3000', 'https://192.168.1.50:3000', 'http://localhost:3000', 'https://evil.example']) {
      const response = await post(other);
      assert.equal(response.statusCode, 403, other);
      assert.equal(response.json().code, 'CSRF_REJECTED');
    }
    // Missing, empty and malformed Origin are rejected, never treated as "same origin".
    for (const origin of ['', 'not-a-url', 'file:///etc/passwd', 'null']) {
      assert.equal((await post(origin)).statusCode, 403, origin);
    }
  } finally {await app.close(); db.close();}
});

test('the Android shell marker is accepted only with a null Origin, JSON and no cross-site metadata', async () => {
  const c = lan(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'lan-shell', fakePlex({accountId: 1}).transport), false);
  const post = (headers: Record<string, string>) => app.inject({method: 'POST', url: '/api/v1/auth/logout', headers, payload: {}});
  try {
    const json = 'application/json';
    // Old WebView: null Origin + package marker.
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'content-type': json})).statusCode, 200);
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'sec-fetch-site': 'same-origin', 'content-type': json})).statusCode, 200);
    // A WebView that repeats the header (native + page) still matches the one package.
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv, com.tkbox.tv', 'content-type': json})).statusCode, 200);
    assert.equal(hasShellMarker('com.tkbox.tv,com.tkbox.tv'), true);
    for (const marker of [undefined, '', 'XMLHttpRequest', 'com.evil', 'com.tkbox.tv/extra'])
      assert.equal((await post({origin: 'null', ...(marker === undefined ? {} : {'x-requested-with': marker}), 'content-type': json})).statusCode, 403, String(marker));
    // Cross-site fetch metadata kills the exception even with the right marker.
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'sec-fetch-site': 'cross-site', 'content-type': json})).statusCode, 403);
    // A real hostile origin is never rescued by the marker.
    assert.equal((await post({origin: 'https://evil.example', 'x-requested-with': 'com.tkbox.tv', 'content-type': json})).statusCode, 403);
    // JSON stays required for every accepted origin.
    assert.equal((await post({origin: c.browserOrigin, 'content-type': 'text/plain'})).statusCode, 415);
    assert.equal((await post({origin: 'null', 'x-requested-with': 'com.tkbox.tv', 'content-type': 'text/plain'})).statusCode, 415);
  } finally {await app.close(); db.close();}
});

test('no CORS headers are emitted, so a preflight cannot unlock the shell marker', async () => {
  const c = lan(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'lan-cors', fakePlex({accountId: 1}).transport), false);
  try {
    for (const preflight of [
      {origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with,content-type'},
      {origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'},
      {origin: c.browserOrigin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'content-type'}
    ]) {
      const response = await app.inject({method: 'OPTIONS', url: '/api/v1/auth/logout', headers: preflight});
      for (const header of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials'])
        assert.equal(response.headers[header], undefined, `${header} for ${preflight.origin}`);
    }
  } finally {await app.close(); db.close();}
});

test('an accepted CSRF origin is distinguishable from a later credential or auth failure', async () => {
  const c = lan(), db = openDatabase(':memory:'), vault = new Vault(randomBytes(32));
  const app = await buildApp(c, db, vault, new PlexAdapter(c, 'lan-auth', fakePlex({accountId: 1}).transport), false, 'tk.box', rejectingPanel);
  const origin = c.browserOrigin;
  try {
    // Xtream: the provider rejects the credentials, so CSRF passed and the error is the panel's.
    const login = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers: {origin}, payload: credentials});
    assert.equal(login.json().code, 'XTREAM_AUTH_FAILED', login.body);
    // Wrong origin fails earlier, with the CSRF code, not the credential code.
    const csrf = await app.inject({method: 'POST', url: '/api/v1/auth/xtream/login', headers: {origin: 'https://evil.example'}, payload: credentials});
    assert.equal(csrf.statusCode, 403);
    assert.equal(csrf.json().code, 'CSRF_REJECTED');
    // Plex: start succeeds; a status call without the binding cookie fails on auth, not CSRF.
    assert.equal((await app.inject({method: 'POST', url: '/api/v1/auth/plex/start', headers: {origin}, payload: {}})).statusCode, 200);
    const status = await app.inject({method: 'POST', url: '/api/v1/auth/plex/status', headers: {origin}, payload: {}});
    assert.equal(status.statusCode, 401);
    assert.equal(status.json().code, 'AUTH_EXPIRED');
    // Native session release from the shell (Origin + marker, no session) reaches the auth guard.
    const release = await app.inject({method: 'DELETE', url: `/api/v1/live/sessions/${'A'.repeat(24)}`,
      headers: {origin, 'x-requested-with': 'com.tkbox.tv', 'content-type': 'application/json'}, payload: {}});
    assert.equal(release.statusCode, 401);
    assert.equal(release.json().code, 'UNAUTHENTICATED');
  } finally {await app.close(); db.close();}
});

test('CSRF diagnostics classify the rejection without logging secrets or query strings', async () => {
  const c = lan();
  const request = {
    id: 'req-1', method: 'POST', url: '/api/v1/auth/xtream/login?token=provider-secret&username=private',
    routeOptions: {url: '/api/v1/auth/xtream/login'},
    headers: {origin: 'https://evil.example', 'x-requested-with': 'com.tkbox.tv', 'sec-fetch-site': 'cross-site',
      cookie: 'tk.box_local=session-secret', authorization: 'Bearer provider-secret', 'user-agent': 'Mozilla/5.0 TkBoxTV/1.0.0'}
  };
  const diagnostic = classifyCsrfRejection(request, c);
  assert.equal(diagnostic.requestId, 'req-1');
  assert.equal(diagnostic.method, 'POST');
  assert.equal(diagnostic.route, '/api/v1/auth/xtream/login');
  assert.equal(diagnostic.originClass, 'mismatched');
  assert.equal(diagnostic.requestOrigin, 'https://evil.example');
  assert.equal(diagnostic.expectedOrigin, 'http://192.168.1.50:3000');
  assert.equal(diagnostic.xRequestedWith, 'shell_package');
  assert.equal(diagnostic.secFetchSite, 'cross-site');
  assert.equal(diagnostic.androidShell, true);
  assert.equal(diagnostic.reason, 'cross_site_fetch_metadata');
  const serialized = JSON.stringify(diagnostic);
  for (const secret of ['session-secret', 'provider-secret', 'username=private', 'Bearer', 'tk.box_local'])
    assert.ok(!serialized.includes(secret), secret);
  // Classification covers the other rejection paths without echoing arbitrary header values.
  const classify = (origin: string | undefined, extra: Record<string, string> = {}) =>
    classifyCsrfRejection({id: 'r', method: 'POST', url: '/api/v1/x', headers: {...(origin === undefined ? {} : {origin}), ...extra}}, c);
  assert.equal(classify(undefined).reason, 'missing_origin');
  assert.equal(classify('null').reason, 'null_origin_missing_marker');
  assert.equal(classify('null', {'x-requested-with': 'com.other'}).reason, 'null_origin_invalid_marker');
  assert.equal(classify('not a url').reason, 'malformed_origin');
  assert.equal(classify('https://evil.example').reason, 'origin_mismatch');
  assert.equal(classify(c.browserOrigin, {'sec-fetch-site': 'same-site'}).reason, 'cross_site_fetch_metadata');
  // Arbitrary marker text is classified, never copied into the record.
  assert.equal(classify('null', {'x-requested-with': 'Bearer secret-token'}).xRequestedWith, 'other');
  assert.ok(!JSON.stringify(classify('null', {'x-requested-with': 'Bearer secret-token'})).includes('secret-token'));
});
