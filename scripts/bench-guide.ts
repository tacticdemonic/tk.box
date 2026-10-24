import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault, digest } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import type { XtreamCatalogue, XtreamChannel } from '../apps/server/src/providers/xtream.js';
import type { Program, XmlChannel, XmlSnapshot } from '../apps/server/src/providers/iptv.js';

// M03.5 reproduction and acceptance benchmark. Seeds a synthetic but representative provider
// through the same sealed publication path a real import uses, then measures the compiled server.
// Never touches ./data: every run owns a fresh temporary DATA_DIR.
const FEEDS = 8436, PROGRAMMES = 62660, STATIONS = 3200, SECONDARY_FEEDS = 420;

function stationName(i: number) {
  const regions = ['US', 'UK', 'CA', 'AU'];
  const words = ['News', 'Sports', 'Movies', 'Kids', 'Music', 'Docs', 'Drama', 'Comedy'];
  return `${regions[i % regions.length]}: ${words[i % words.length]} ${i}`;
}
const qualities = ['FHD', 'HD', 'SD', ''];

export function dataset() {
  const channels: XtreamChannel[] = [], guide: XmlChannel[] = [], programs: Program[] = [];
  const start = Date.UTC(2026, 9, 22, 0);
  let feed = 0;
  for (let station = 0; station < STATIONS && feed < FEEDS; station++) {
    const base = stationName(station);
    // A few stations share one guide id on purpose: the listing must stay ambiguous.
    const ambiguous = station % 97 === 0;
    const guideId = ambiguous ? `amb.${station % 13}` : `guide.${station}`;
    for (let variant = 0; variant < 4 && feed < FEEDS; variant++) {
      const quality = qualities[(station + variant) % qualities.length]!;
      const name = quality ? `${base} ${quality}` : base;
      channels.push({ streamId: String(100000 + feed), name, group: `Group ${station % 40}`,
        tvgId: station % 31 === 0 ? '' : station % 23 === 0 ? `missing.${station}` : guideId,
        logo: station % 11 === 0 ? '' : `https://logos.invalid/${station}.png`,
        streamUrl: `https://provider.invalid/live/${100000 + feed}.ts`, categoryId: String(station % 40) });
      feed++;
      if (variant === 0 && station % 23 !== 0) guide.push({ id: guideId, name: base, icon: station % 7 === 0 ? undefined : `https://icons.invalid/${station}.png` });
    }
  }
  // Ambiguous guide ids name two unrelated stations, which must never auto-map.
  for (let id = 0; id < 13; id++) guide.push({ id: `amb.${id}`, name: `Conflicting ${id}`, icon: `https://icons.invalid/amb-${id}.png` });
  const guideIds = [...new Set(guide.filter(channel => !channel.id.startsWith('amb.')).map(channel => channel.id))];
  for (let n = 0; n < PROGRAMMES; n++) {
    const id = guideIds[n % guideIds.length]!, slot = Math.floor(n / guideIds.length), from = start + slot * 3600000;
    programs.push({ channelId: id, start: from, end: from + 3600000,
      title: `Programme ${n}`, subtitle: `Episode ${n % 24}`, category: 'General',
      description: `${'A representative programme description with enough detail to match real XMLTV payload sizes. '.repeat(3)}Record ${n}.` });
  }
  return { channels, guide, programs };
}

function catalogue(name: string, channels: XtreamChannel[], epg: XmlSnapshot): XtreamCatalogue {
  return { version: 1, fetchedAt: Date.now(), ignoredStreams: 0, categories: [{ id: '1', name: 'Live' }],
    account: { status: 'active', expiresAt: Date.now() + 86400000, isTrial: false, maxConnections: 2, activeConnections: 1, allowedFormats: [], timezone: 'UTC' },
    channels, epg, guide: { source: 'xmltv', state: 'available', parsedChannels: epg.channels.length, parsedPrograms: epg.programs.length, mappedChannels: channels.length } };
}

export function seed(dir: string) {
  const db = openDatabase(join(dir, 'tk.box.sqlite')), vault = Vault.fromFile(join(dir, 'secret.key'));
  const xtream = new XtreamStore(db, vault), iptv = new IptvStore(db, vault), now = Date.now();
  const { channels, guide, programs } = dataset();
  db.prepare('INSERT OR IGNORE INTO users VALUES(?,1)').run('owner');
  db.prepare('INSERT OR IGNORE INTO users VALUES(?,1)').run('viewer');
  db.prepare("INSERT OR REPLACE INTO xtream_identities(account_id,login_key,role,created_at,updated_at) VALUES('owner','bench-owner','admin',?,?)").run(now, now);
  db.prepare("INSERT OR REPLACE INTO xtream_identities(account_id,login_key,role,created_at,updated_at) VALUES('viewer','bench-viewer','viewer',?,?)").run(now, now);
  const account = xtream.create('owner', { name: 'Bench provider', credentials: { serverUrl: 'https://provider.invalid', username: 'bench', password: 'bench-secret', allowInsecureHttp: false } });
  const primary = catalogue('Bench provider', channels, { channels: guide, programs, quarantined: 0 });
  xtream.saveCatalogue('owner', account.id, primary);
  const published = iptv.publishXtream('owner', account.id, 'Bench provider', primary, now);
  // A second provider keeps the cross-scope rules exercised by the same run.
  const second = xtream.create('viewer', { name: 'Second provider', credentials: { serverUrl: 'https://second.invalid', username: 'bench2', password: 'bench-secret', allowInsecureHttp: false } });
  const secondChannels: XtreamChannel[] = Array.from({ length: SECONDARY_FEEDS }, (_, i) => ({ streamId: String(900000 + i), name: stationName(i), group: 'Second',
    tvgId: `second.${i}`, logo: '', streamUrl: `https://second.invalid/live/${i}.ts`, categoryId: '1' }));
  const secondEpg: XmlSnapshot = { channels: secondChannels.map(c => ({ id: c.tvgId, name: c.name })), quarantined: 0,
    programs: secondChannels.map((c, i) => ({ channelId: c.tvgId, start: Date.UTC(2026, 9, 22, i % 12), end: Date.UTC(2026, 9, 22, (i % 12) + 1), title: `Second ${i}` })) };
  const secondary = catalogue('Second provider', secondChannels, secondEpg);
  xtream.saveCatalogue('viewer', second.id, secondary);
  iptv.publishXtream('viewer', second.id, 'Second provider', secondary, now);
  // A session in the shape the Xtream sign-in issues, so the HTTP benchmark authenticates like a viewer.
  const cookie = randomBytes(32).toString('base64url');
  db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').run(digest(cookie), 'owner', vault.seal('xtream', digest(cookie)), now + 12 * 3600000);
  // Warm the read path once and report its logical cache weight separately from process memory:
  // the budget counts estimated sealed-payload bytes, never a heap measurement.
  const start = Date.UTC(2026, 9, 22, 0);
  iptv.guidePage('owner', 'all', start, start + 6 * 3600000, 0, 50);
  const cache = iptv.cacheStats();
  db.close();
  writeFileSync(join(dir, 'bench-cookie'), cookie);
  return { sourceId: published.source.id, feeds: channels.length, programmes: programs.length, cache };
}

// Counts real vault decryptions and JSON parses without changing production code paths.
function instrument() {
  const counts = { open: {} as Record<string, number>, openBytes: 0, parses: 0, parseBytes: 0 };
  const open = Vault.prototype.open;
  Vault.prototype.open = function (value: string, context: string) {
    const kind = context.split(':').slice(0, 2).join(':');
    counts.open[kind] = (counts.open[kind] ?? 0) + 1;
    counts.openBytes += value.length;
    return open.call(this, value, context);
  };
  const parse = JSON.parse;
  JSON.parse = function (text: string, reviver?: (key: string, value: unknown) => unknown) {
    counts.parses++; counts.parseBytes += text.length;
    return parse(text, reviver as never);
  };
  return { counts, restore() { Vault.prototype.open = open; JSON.parse = parse; } };
}

function freePort() {
  return new Promise<number>(done => {
    const server = createServer(); server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not listening yet */ }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('server did not become ready');
}

type Sample = { name: string; ms: number[] };
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
};
function report(samples: Sample[]) {
  return samples.map(sample => ({ name: sample.name, n: sample.ms.length, p50: Math.round(pct(sample.ms, 0.5)), p95: Math.round(pct(sample.ms, 0.95)), max: Math.round(Math.max(...sample.ms)) }));
}

async function httpBench(dir: string, base: string, cookie: string, page: number) {
  const start = Date.UTC(2026, 9, 22, 0), end = start + 6 * 3600000, headers = { cookie: `tk.box_local=${cookie}`, origin: base };
  const guideUrl = `${base}/api/v1/guide?start=${start}&end=${end}&offset=${page}&limit=50`;
  const timed = async (url: string, init: RequestInit = {}) => {
    const at = performance.now();
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    const body = await response.arrayBuffer();
    // A 429 measures the limiter, not the read path. Report it rather than crashing the run.
    if (response.status === 429) return { ms: performance.now() - at, bytes: body.byteLength, limited: true };
    if (!response.ok) throw new Error(`${url} ${response.status} ${Buffer.from(body).toString('utf8').slice(0, 200)}`);
    return { ms: performance.now() - at, bytes: body.byteLength, limited: false };
  };
  // The logo route has its own ceiling (1200/min); every other route shares the global 120/min. A
  // benchmark must measure the read path, so non-logo requests are paced inside that budget exactly
  // as a viewer's traffic would be, and a 429 is reported rather than counted as a fast request.
  const budget = { used: 0 };
  const pace = async (cost = 1) => {
    if (budget.used + cost > 90) { await new Promise(done => setTimeout(done, 61000)); budget.used = 0; }
    budget.used += cost;
  };
  const samples: Sample[] = [], add = (name: string, ms: number) => {
    const sample = samples.find(s => s.name === name); if (sample) sample.ms.push(ms); else samples.push({ name, ms: [ms] });
  };
  const cold = await timed(guideUrl); add('guide cold', cold.ms);
  // First request after the clock crosses a minute boundary (F): station keys must not rebuild.
  const boundary = 60000 - (Date.now() % 60000) + 50;
  if (boundary < 30000) {
    await new Promise(done => setTimeout(done, boundary));
    add('guide after minute boundary', (await timed(guideUrl)).ms);
  }
  // Warm pages: sequential offsets across the same window.
  for (let run = 0; run < 12; run++) {
    const offset = (run % 6) * 50;
    await pace(3);
    const { ms, limited } = await timed(`${base}/api/v1/guide?start=${start}&end=${end}&offset=${offset}&limit=50`);
    if (!limited) add('guide warm 50', ms);
    const wide = await timed(`${base}/api/v1/guide?start=${start}&end=${end}&offset=${offset}&limit=60`);
    if (!wide.limited) add('guide warm 60', wide.ms);
    if (limited || wide.limited) add('guide rate limited', ms);
  }
  // A logo burst as the grid generates it, with /health and /me alongside.
  await pace();
  const pageBody = await (await fetch(guideUrl, { headers })).json() as { channels: { id: string; feeds: { id: string }[] }[] };
  const logos = pageBody.channels.flatMap(channel => channel.feeds.slice(0, 1).map(feed => feed.id)).slice(0, 60);
  for (let burst = 0; burst < 2; burst++) {
    const logosAt = performance.now();
    await Promise.all(logos.map(async id => {
      const at = performance.now();
      const response = await fetch(`${base}/api/v1/iptv/channels/${id}/logo`, { headers });
      await response.arrayBuffer(); add('logo', performance.now() - at);
    }));
    add('logo burst total', performance.now() - logosAt);
    // Sample the concurrent probes throughout a second burst, so p95 is meaningful rather than n=2.
    const sampling = (async () => {
      for (let round = 0; round < 15; round++) {
        if (budget.used + 2 > 90) break;
        budget.used += 2;
        const health = await timed(`${base}/health`), me = await timed(`${base}/api/v1/me`);
        if (!health.limited) add('health during logos', health.ms);
        if (!me.limited) add('me during logos', me.ms);
        await new Promise(done => setTimeout(done, 40));
      }
    })();
    const concurrent = performance.now();
    await Promise.all(logos.map(async id => { const response = await fetch(`${base}/api/v1/iptv/channels/${id}/logo`, { headers }); await response.arrayBuffer(); }));
    await sampling;
    add('logo burst under probes', performance.now() - concurrent);
  }
  // Repeated bursts: warm logo traffic must stay flat and bounded in memory.
  for (let burst = 0; burst < 3; burst++) {
    const at = performance.now();
    await Promise.all(logos.map(async id => { const response = await fetch(`${base}/api/v1/iptv/channels/${id}/logo`, { headers }); await response.arrayBuffer(); }));
    add('logo burst warm', performance.now() - at);
  }
  // Sequential paging across the whole lineup, as a viewer scrolls.
  for (let offset = 0; offset < 300; offset += 50) {
    await pace();
    const page = await timed(`${base}/api/v1/guide?start=${start}&end=${end}&offset=${offset}&limit=50`);
    if (!page.limited) add('sequential page', page.ms); else add('sequential page rate limited', page.ms);
  }
  await pace();
  const memory = await (await fetch(`${base}/health`)).json().catch(() => ({}));
  return { samples: report(samples), coldBytes: cold.bytes, memory };
}

export async function main(argv = process.argv.slice(2)) {
  const root = mkdtempSync(join(tmpdir(), 'tkbox-m035-'));
  const dir = resolve(root, 'data');
  try {
    console.log(JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), data: dir }));
    const seeded = seed(dir);
    console.log(JSON.stringify({ seeded }));
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
      env: { ...process.env, DATA_DIR: dir, CACHE_DIR: join(dir, 'cache'), APP_HOST: '127.0.0.1', APP_PORT: String(port),
        APP_ORIGIN: `http://127.0.0.1:${port}`, SECRET_KEY_FILE: join(dir, 'secret.key'), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitFor(base, child);
      const cookie = (await readFile(join(dir, 'bench-cookie'), 'utf8')).trim();
      const result = await httpBench(dir, base, cookie, 0);
      console.log(JSON.stringify({ result }, null, 2));
      const memory = execFileSync('sh', ['-c', `ps -o rss= -p ${child.pid}`], { encoding: 'utf8' }).trim();
      console.log(JSON.stringify({ serverRssMb: Math.round(Number(memory) / 1024) }));
    } finally {
      child.kill('SIGTERM');
      await new Promise(done => child.once('exit', done));
      if (child.exitCode !== 0 && child.exitCode !== null) console.error(output.slice(-2000));
    }
  } finally {
    if (!argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
    else console.error(`kept ${root}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) void main();
