import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../apps/server/src/persistence/database.js';
import { Vault, digest } from '../apps/server/src/security/vault.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { buildApp } from '../apps/server/src/app.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import type { XtreamCatalogue, XtreamTransport } from '../apps/server/src/providers/xtream.js';
import { config, fakePlex } from './fixtures.js';

// M03.5 review: a guide page asks for 50–60 logos at once. Those requests carry their own
// 1,200/minute allowance; the default 120/minute policy still covers every other route.
// There is no second, aggregate 120/minute ceiling: a burst simply does not consume the shared
// control-route budget, because the two routes use separate limiter stores.
const LIFETIME = 12 * 3600000;

function seeded() {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new IptvStore(db, vault), xtream = new XtreamStore(db, vault);
  db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const now = Date.now();
  const cookie = (account: string, role: 'admin' | 'viewer') => {
    const token = randomBytes(24).toString('base64url'), hash = digest(token);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash, account, vault.seal('xtream', hash), now + LIFETIME);
    db.prepare('INSERT INTO xtream_identities VALUES(?,?,?,?,?)').run(account, `key-${account}`, role, now, now);
    return token;
  };
  const owner = cookie('owner', 'admin'), viewer = cookie('viewer', 'viewer');
  const channels = Array.from({ length: 60 }, (_, i) => ({ streamId: String(5000 + i), name: `US: Station ${i}`, group: 'Live', tvgId: `g.${i}`, logo: '', streamUrl: `https://provider.invalid/${i}.ts`, categoryId: '1' }));
  const catalogue: XtreamCatalogue = { version: 1, fetchedAt: now, ignoredStreams: 0, categories: [{ id: '1', name: 'Live' }],
    account: { status: 'active', expiresAt: now + 86400000, isTrial: false, maxConnections: 2, activeConnections: 1, allowedFormats: [], timezone: 'UTC' },
    channels, epg: { channels: channels.map(c => ({ id: c.tvgId, name: c.name })), programs: [], quarantined: 0 } };
  const account = xtream.create('owner', { name: 'Provider', credentials: { serverUrl: 'https://provider.invalid', username: 'u', password: 'p', allowInsecureHttp: false } });
  xtream.grant('viewer', account.id); xtream.saveCatalogue('owner', account.id, catalogue);
  store.publishXtream('owner', account.id, 'Provider', catalogue);
  const ids = store.visible('viewer').map(row => row.id);
  return { db, vault, store, owner, viewer, ids };
}

async function app(db: Db, vault: Vault) {
  // The provider transport is never reached: a login attempt fails fast and locally.
  const transport: XtreamTransport = async () => { throw Object.assign(new Error('offline'), { code: 'XTREAM_UNREACHABLE' }); };
  const plex = new PlexAdapter(config(), 'test', fakePlex({ accountId: 1 }).transport);
  return buildApp(config(), db, vault, plex, false, 'tk.box', transport);
}

const origin = 'http://127.0.0.1:3000';
const headers = (cookie: string, extra: Record<string, string> = {}) => ({ origin, cookie: `tk.box_local=${cookie}`, ...extra });

test('a normal logo burst does not exhaust the shared control-route allowance', async () => {
  const { db, vault, ids, viewer } = seeded(), server = await app(db, vault);
  try {
    // One guide page's worth of logos plus the polls a client makes while it renders.
    const burst = await Promise.all(ids.map(id => server.inject({ url: `/api/v1/iptv/channels/${id}/logo`, headers: headers(viewer) })));
    assert.equal(burst.filter(response => response.statusCode === 429).length, 0, 'no logo is rejected during a 60-logo burst');
    for (let i = 0; i < 20; i++) {
      assert.equal((await server.inject({ url: '/health' })).statusCode, 200, '/health stays available during the burst');
      assert.equal((await server.inject({ url: '/api/v1/me', headers: headers(viewer) })).statusCode, 200, '/me stays available during the burst');
    }
    // The shared 120/minute budget is intact, and the logo route reports its own ceiling.
    const health = await server.inject({ url: '/health' });
    assert.equal(health.headers['x-ratelimit-limit'], '120');
    const logo = await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo`, headers: headers(viewer) });
    assert.equal(logo.headers['x-ratelimit-limit'], '1200', 'the logo route carries the documented 1,200/minute allowance');
  } finally { await server.close(); db.close(); }
});

test('different channel ids share the logo-route allowance for a client', async () => {
  const { db, vault, ids, viewer } = seeded(), server = await app(db, vault);
  try {
    const first = await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo`, headers: headers(viewer) });
    const second = await server.inject({ url: `/api/v1/iptv/channels/${ids[1]}/logo`, headers: headers(viewer) });
    const remaining = (r: { headers: Record<string, unknown> }) => Number(r.headers['x-ratelimit-remaining']);
    assert.ok(remaining(first) > remaining(second), 'the counter is per client, not per channel');
    assert.equal(remaining(first) - remaining(second), 1);
  } finally { await server.close(); db.close(); }
});

test('unauthenticated callers cannot fetch a protected logo, and rejected calls do not earn it', async () => {
  const { db, vault, ids, viewer } = seeded(), server = await app(db, vault);
  try {
    assert.equal((await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo` })).statusCode, 401);
    const forged = await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo`, headers: { origin, cookie: 'tk.box_local=forged' } });
    assert.equal(forged.statusCode, 401);
    // The authorised request passes the limiter and the visibility check; the image fetch fails
    // offline, which is a 404, never a 401/403/429.
    const allowed = await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo`, headers: headers(viewer, { 'x-forwarded-for': '203.0.113.9' }) });
    assert.ok(![401, 403, 429].includes(allowed.statusCode), `authorised logo request is not refused (${allowed.statusCode})`);
  } finally { await server.close(); db.close(); }
});

test('the limiter key is the client address, not an untrusted forwarded header', async () => {
  const { db, vault, viewer, ids } = seeded(), server = await app(db, vault);
  try {
    // Login keeps its tighter 10/minute limit, and a forged X-Forwarded-For must not reset it.
    const attempt = (forwarded: string) => server.inject({ method: 'POST', url: '/api/v1/auth/xtream/login',
      headers: headers(viewer, { 'x-forwarded-for': forwarded }),
      payload: { serverUrl: 'https://provider.invalid', username: 'u', password: 'p' } });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await attempt(`198.51.100.${i}`)).statusCode);
    assert.deepEqual(codes.slice(0, 10).map(code => code === 429), Array(10).fill(false), `the first ten attempts are handled, not limited (${codes})`);
    assert.equal(codes[10], 429, 'the eleventh is rejected despite a different forwarded address');
    // The logo allowance is untouched by login attempts, and /health is never limited here.
    const logo = await server.inject({ url: `/api/v1/iptv/channels/${ids[0]}/logo`, headers: headers(viewer) });
    assert.notEqual(logo.statusCode, 429, 'logo requests are not charged to the login budget');
    assert.equal((await server.inject({ url: '/health' })).statusCode, 200);
  } finally { await server.close(); db.close(); }
});

test('a mutation route keeps the default route policy, not the logo allowance', async () => {
  const { db, vault, ids, viewer } = seeded(), server = await app(db, vault);
  try {
    const favorite = () => server.inject({ method: 'PUT', url: `/api/v1/iptv/channels/${ids[0]}/favorite`,
      headers: headers(viewer, { 'content-type': 'application/json' }), payload: { favorite: true } });
    let limited = 0;
    // The default policy allows 120/minute per client, shared with every non-logo route.
    for (let i = 0; i < 121 && !limited; i++) limited = (await favorite()).statusCode === 429 ? i + 1 : 0;
    assert.equal(limited, 121, 'the request after 120 mutations is rejected');
    // Logo traffic has its own budget and is unaffected by an exhausted mutation allowance.
    assert.notEqual((await server.inject({ url: `/api/v1/iptv/channels/${ids[1]}/logo`, headers: headers(viewer) })).statusCode, 429);
  } finally { await server.close(); db.close(); }
});

test('exceeding the logo allowance is still rejected', async () => {
  const { db, vault, ids, viewer } = seeded(), server = await app(db, vault);
  try {
    // The allowance is 1,200/minute. The route's own counter is the only thing being measured, so
    // use its headers to confirm the boundary rather than sending a real provider burst.
    const route = server.printRoutes({ commonPrefix: false });
    assert.ok(route.includes('logo'), 'the logo route is registered');
    let rejected = 0, allowed = 0;
    // A 1,201st request must be refused. Requests are sequential and local, so the count is exact.
    for (let i = 0; i < 1201; i++) {
      const response = await server.inject({ url: `/api/v1/iptv/channels/${ids[i % ids.length]}/logo`, headers: headers(viewer) });
      if (response.statusCode === 429) rejected++; else allowed++;
      if (rejected) break;
    }
    assert.equal(rejected, 1, `the request after the allowance is rejected (allowed ${allowed})`);
    assert.equal(allowed, 1200, 'the documented allowance is exactly 1,200 per minute');
    // A control route remains usable after the logo allowance is spent: there is no aggregate ceiling.
    assert.equal((await server.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await server.inject({ url: '/api/v1/me', headers: headers(viewer) })).statusCode, 200);
  } finally { await server.close(); db.close(); }
});
