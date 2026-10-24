import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import type { XtreamCatalogue, XtreamChannel } from '../apps/server/src/providers/xtream.js';
import { resolveGuideMapping, guideIndex, type Program, type XmlChannel } from '../apps/server/src/providers/iptv.js';

// M03.5 read-path work counts. These assert how many decrypts, parses and full-guide scans a request
// performs, not how long it takes: a timing test alone cannot tell a fixed read path from a lucky run.

type Counts = { opens: Record<string, number>; parses: number; parseBytes: number };

// Wraps the vault and JSON.parse so a test can count the operations production code really performs.
function counted(fn: (counts: Counts) => void) {
  const counts: Counts = { opens: {}, parses: 0, parseBytes: 0 }, open = Vault.prototype.open, parse = JSON.parse;
  Vault.prototype.open = function (value: string, context: string) {
    // `iptv:guide:<id>`, `iptv:channel:<id>`, `xtream:catalogue:<id>`: group by payload type, not owner.
    const parts = context.split(':'), kind = parts[0] === 'iptv' ? `${parts[0]}:${parts[1]}` : parts[0]!;
    counts.opens[kind] = (counts.opens[kind] ?? 0) + 1;
    return open.call(this, value, context);
  };
  JSON.parse = function (text: string, reviver?: (key: string, value: unknown) => unknown) {
    counts.parses++; counts.parseBytes += text.length;
    return parse(text, reviver as never);
  };
  try { fn(counts); } finally { Vault.prototype.open = open; JSON.parse = parse; }
  return counts;
}

const STATIONS = 60, PER_STATION = 6, PROGRAMMES = 480;
function provider() {
  const channels: XtreamChannel[] = [], guide: XmlChannel[] = [], programs: Program[] = [];
  for (let station = 0; station < STATIONS; station++) {
    const id = `guide.${station}`, name = `US: Station ${station}`;
    guide.push({ id, name, icon: `https://icons.invalid/${station}.png` });
    // Quality variants of one station, as a real panel publishes them.
    for (let variant = 0; variant < PER_STATION; variant++) channels.push({ streamId: String(station * 100 + variant),
      name: `${name} ${['FHD', 'HD', 'SD', '4K', '', 'Backup'][variant]}`, group: 'Live', tvgId: id,
      logo: variant === 0 ? `https://logos.invalid/${station}.png` : '', streamUrl: `https://provider.invalid/${station}/${variant}.ts`, categoryId: '1' });
    for (let slot = 0; slot < PROGRAMMES / STATIONS; slot++) {
      const from = Date.UTC(2026, 9, 22, slot);
      programs.push({ channelId: id, start: from, end: from + 3600000, title: `Station ${station} slot ${slot}`,
        description: 'A representative description that gives the guide realistic bulk.' });
    }
  }
  const catalogue: XtreamCatalogue = { version: 1, fetchedAt: Date.now(), ignoredStreams: 0,
    categories: [{ id: '1', name: 'Live' }], account: { status: 'active', expiresAt: Date.now() + 86400000, isTrial: false,
      maxConnections: 2, activeConnections: 1, allowedFormats: [], timezone: 'UTC' }, channels, epg: { channels: guide, programs, quarantined: 0 } };
  return catalogue;
}
function fixture(catalogue = provider()) {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new IptvStore(db, vault), xtream = new XtreamStore(db, vault);
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
  const account = xtream.create('owner', { name: 'Provider', credentials: { serverUrl: 'https://provider.invalid', username: 'u', password: 'p', allowInsecureHttp: false } });
  xtream.grant('viewer', account.id);
  xtream.saveCatalogue('owner', account.id, catalogue);
  const published = store.publishXtream('owner', account.id, 'Provider', catalogue);
  return { db, vault, store, xtream, account, sourceId: published.source.id, catalogue };
}
const start = Date.UTC(2026, 9, 22, 0), end = start + 6 * 3600000;

test('a guide page costs one guide decryption regardless of how many rows it returns', () => {
  const { db, store } = fixture();
  try {
    const one = counted(counts => store.guidePage('viewer', 'all', start, end, 0, 1));
    const fifty = counted(counts => store.guidePage('viewer', 'all', start, end, 0, 50));
    const sixty = counted(counts => store.guidePage('viewer', 'all', start, end, 0, 60));
    const guideBytes = JSON.stringify(provider().epg).length;
    for (const [label, counts, rows] of [['1', one, 1], ['50', fifty, 50], ['60', sixty, 60]] as const) {
      assert.equal(counts.opens['iptv:guide'] ?? 0, 0, `${label} rows decrypt no guide blob on a warm process`);
      // Per-channel metadata is a few hundred bytes each; the guide is hundreds of kilobytes. What
      // matters is that the row count does not multiply a guide-sized parse.
      assert.ok(counts.parseBytes < guideBytes / 4, `${label} rows parse no guide-sized payload (${counts.parseBytes} of ${guideBytes})`);
      assert.equal(store.guidePage('viewer', 'all', start, end, 0, rows).channels.length, Math.min(rows, STATIONS), label);
    }
    // Page size changes the slice, not the work behind it.
    assert.equal(fifty.opens['iptv:guide'] ?? 0, sixty.opens['iptv:guide'] ?? 0);
    assert.ok((sixty.parseBytes - one.parseBytes) < guideBytes / 8, 'a larger page adds only per-row work');
    // Publication performs the bounded cold work once. After it, no page size re-pays for the guide.
    const cold = fixture();
    try { assert.equal(counted(counts => cold.store.guidePage('viewer', 'all', start, end, 0, 60)).opens['iptv:guide'] ?? 0, 0, 'a published source needs no further guide decryption'); }
    finally { cold.db.close(); }
    // A brand new store over the same published data pays once on first use, then never again.
    const warmless = (() => { const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new IptvStore(db, vault), xtream = new XtreamStore(db, vault);
      db.prepare('INSERT INTO users VALUES(?,1)').run('viewer'); db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
      return { db, store, xtream, catalogue: provider() }; })();
    try {
      const account = warmless.xtream.create('owner', { name: 'Provider', credentials: { serverUrl: 'https://provider.invalid', username: 'u', password: 'p', allowInsecureHttp: false } });
      warmless.xtream.grant('viewer', account.id);
      warmless.xtream.saveCatalogue('owner', account.id, warmless.catalogue);
      const publishes = counted(() => warmless.store.publishXtream('owner', account.id, 'Provider', warmless.catalogue));
      assert.ok((publishes.opens['iptv:guide'] ?? 0) === 1, `publishing decrypts the guide a bounded number of times, not per channel (${publishes.opens['iptv:guide']})`);
      assert.equal(publishes.opens.xtream ?? 0, 0, 'channel metadata no longer comes from the EPG-bearing catalogue');
      assert.equal(counted(counts => warmless.store.guidePage('viewer', 'all', start, end, 0, 60)).opens['iptv:guide'] ?? 0, 0, 'and the first page after it decrypts none');
    } finally { warmless.db.close(); }
  } finally { db.close(); }
});

test('logo requests perform no programme-guide decryption or parse', () => {
  const { db, store } = fixture();
  try {
    // Warm the derived projection exactly as a publish does, then count only logo work.
    const channel = store.visible('viewer')[0]!;
    const counts = counted(() => {
      for (const feed of store.visible('viewer').flatMap(row => row.id)) {
        const logo = store.logo(feed, 'viewer');
        assert.ok(logo.name);
      }
    });
    assert.equal(counts.opens['iptv:guide'] ?? 0, 0, 'no guide blob is decrypted for any logo');
    assert.ok(counts.parseBytes < 65536, `no guide-sized payload is parsed for ${counts.parses} logos (${counts.parseBytes} bytes)`);
    // The icon URL is sealed, so each logo pays one small channel-bound record — never a guide read.
    assert.equal(counts.opens['iptv:icon'] ?? 0, store.visible('viewer').length, 'exactly one small record per logo');
    // Semantics are preserved: playlist logo first, derived guide icon second.
    assert.deepEqual(store.logo(channel.id, 'viewer').urls, ['https://logos.invalid/0.png', 'https://icons.invalid/0.png']);
  } finally { db.close(); }
});

test('a missing guide id is a cached miss, not a full station-index rebuild per channel', () => {
  const sourceChannels = Array.from({ length: 50 }, (_, i) => ({ tvgId: `missing.${i}`, name: `US: Station ${i}`, group: '', logo: '', streamUrl: 'u' }));
  const xml = { channels: Array.from({ length: 50 }, (_, i) => ({ id: `present.${i}`, name: `US: Station ${i}` })), programs: [], quarantined: 0 };
  const index = guideIndex(sourceChannels, xml), scope = { sourceId: 's', feedId: 'f', channelId: 'c' };
  // A supplied index stays authoritative: every lookup is a plain Map miss against a snapshot that
  // has no such id, so none of these can rebuild the station map.
  for (const channel of sourceChannels) assert.equal(resolveGuideMapping(scope, channel, sourceChannels, xml, undefined, index), undefined);
  assert.equal(index.xml.size, 50);
  assert.equal(index.byTvgId.size, 50);
});

test('refresh and mapping changes invalidate the derived icon and cached guide without stale results', () => {
  const { db, store, xtream, account, catalogue, sourceId } = fixture();
  try {
    const channel = store.visible('viewer')[0]!;
    assert.equal(store.logo(channel.id, 'viewer').urls[1], 'https://icons.invalid/0.png');
    // A new guide revision with a new icon must replace the projection.
    const next = provider(), changed = next.epg!.channels.map(c => c.id === 'guide.0' ? { ...c, icon: 'https://icons.invalid/changed.png' } : c);
    next.epg = { ...next.epg!, channels: changed };
    xtream.saveCatalogue('owner', account.id, next);
    store.publishXtream('owner', account.id, 'Provider', next);
    assert.equal(store.logo(channel.id, 'viewer').urls[1], 'https://icons.invalid/changed.png', 'a refresh updates the icon');
    // The page must show the new guide, never the previous revision's programmes.
    const page = store.guidePage('viewer', 'all', start, end, 0, 5);
    assert.equal(page.channels.length, 5);
    assert.ok(JSON.stringify(page).includes('Station 0 slot 0'));
  } finally { db.close(); }
});

test('repeated publishes retain a bounded number of decrypted revisions', () => {
  const { db, store, xtream, account } = fixture();
  try {
    // Each publish is a new revision. The cache is keyed by revision, so old entries must be dropped
    // rather than accumulate every import for the life of the process.
    for (let round = 0; round < 12; round++) {
      const next = provider(), stamp = Date.now() + round;
      next.fetchedAt = stamp;
      xtream.saveCatalogue('owner', account.id, next, stamp);
      store.publishXtream('owner', account.id, 'Provider', next, stamp);
      assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 5);
    }
    const retained = (store as unknown as { dataCache: Map<unknown, unknown> }).dataCache.size;
    assert.ok(retained <= 8, `expected a bounded cache, retained ${retained} revisions`);
  } finally { db.close(); }
});

test('a page for one provider never lists another provider, and revoked access stops it', () => {
  const { db, store, xtream } = fixture();
  try {
    const second = xtream.create('owner', { name: 'Second', credentials: { serverUrl: 'https://second.invalid', username: 'u2', password: 'p', allowInsecureHttp: false } });
    const other = provider();
    other.channels = other.channels.slice(0, 12).map((c, i) => ({ ...c, streamId: String(700000 + i), tvgId: `second.${i}`, name: `CA: Other ${i}` }));
    other.epg = { channels: other.channels.map(c => ({ id: c.tvgId, name: c.name })), programs: [], quarantined: 0 };
    xtream.saveCatalogue('owner', second.id, other);
    store.publishXtream('owner', second.id, 'Second', other);
    const ids = new Set(xtream.access(second.id));
    assert.deepEqual([...ids], ['owner'], 'the creator keeps access');
    const page = store.guidePage('viewer', 'all', start, end, 0, 60);
    assert.equal(page.sources.length, 1, 'viewer sees only the granted provider');
    assert.ok(page.channels.every(c => c.sourceId !== second.id));
  } finally { db.close(); }
});

test('an existing populated database gains the icon projection on upgrade without a reimport', () => {
  const root = mkdtempSync(join(tmpdir(), 'tkbox-icons-')), file = join(root, 'tk.box.sqlite'), keyFile = join(root, 'secret.key');
  try {
    // Publish through a store whose vault is on disk, so the reopened process can read it.
    const db = openDatabase(file), vault = Vault.fromFile(keyFile), store = new IptvStore(db, vault), xtream = new XtreamStore(db, vault);
    db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
    db.prepare('INSERT INTO users VALUES(?,1)').run('owner');
    const catalogue = provider();
    const account = xtream.create('owner', { name: 'Provider', credentials: { serverUrl: 'https://provider.invalid', username: 'u', password: 'p', allowInsecureHttp: false } });
    xtream.grant('viewer', account.id);
    xtream.saveCatalogue('owner', account.id, catalogue);
    store.publishXtream('owner', account.id, 'Provider', catalogue);
    const channel = store.visible('viewer')[0]!;
    assert.deepEqual(store.logo(channel.id, 'viewer').urls[1], 'https://icons.invalid/0.png');
    // Model a database published before migration 1005: neither the table nor its projection exists.
    db.exec('DROP TABLE iptv_channel_icons');
    db.prepare('DELETE FROM migrations WHERE version=1005').run();
    db.close();

    // Reopening applies the migration; `relistAll()` is the startup pass that backfills from the guide.
    const reopened = openDatabase(file), store2 = new IptvStore(reopened, Vault.fromFile(keyFile));
    try {
      assert.ok(reopened.prepare('SELECT 1 FROM migrations WHERE version=1005').get(), 'the migration is recorded');
      assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM iptv_channel_icons').get() as {n: number}).n, 0, 'nothing is invented before the backfill runs');
      const backfill = counted(counts => store2.relistAll());
      assert.ok((backfill.opens['iptv:guide'] ?? 0) >= 1, 'the startup pass reads the stored guide once');
      assert.deepEqual(store2.logo(channel.id, 'viewer').urls[1], 'https://icons.invalid/0.png', 'the icon is backfilled without a reimport');
      assert.equal(counted(counts => store2.logo(channel.id, 'viewer')).opens['iptv:guide'] ?? 0, 0, 'and the logo route reads only the projection');
    } finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the source projection never walks the guide blob, however often a page asks for it', () => {
  // `encrypted_guide IS NOT NULL` must scan the entire value in SQLite; on a real 37 MB guide that is
  // 20 ms per call, and the page used to make that call once per channel. `typeof()` reads only the
  // header. Guard the projection itself, so a future column cannot reintroduce the walk unnoticed.
  const { db } = fixture();
  try {
    const plans = (db.prepare("SELECT sql FROM sqlite_master WHERE name='iptv_sources'").get() as {sql: string}).sql;
    assert.ok(plans.includes('encrypted_guide'));
    const big = Buffer.alloc(1024 * 1024).toString('base64');
    db.prepare("UPDATE iptv_sources SET encrypted_guide=? WHERE kind='xtream'").run(big);
    const id = (db.prepare("SELECT id FROM iptv_sources WHERE kind='xtream'").get() as {id: string}).id;
    const walk = db.prepare('SELECT encrypted_guide IS NOT NULL AS present FROM iptv_sources WHERE id=?');
    const header = db.prepare("SELECT typeof(encrypted_guide)='text' AS present FROM iptv_sources WHERE id=?");
    assert.equal((walk.get(id) as {present: number}).present, 1);
    assert.equal((header.get(id) as {present: number}).present, 1);
    const measure = (statement: typeof walk) => { const at = performance.now(); for (let i = 0; i < 40; i++) statement.get(id); return performance.now() - at; };
    const walked = measure(walk), headed = measure(header);
    // Not a timing threshold: the ratio is the property. Reading a header cannot cost what scanning
    // the body costs, and the difference must stay large enough to matter on a page of 60 rows.
    assert.ok(headed * 4 < walked, `header read (${headed.toFixed(1)}ms) must be far cheaper than the full walk (${walked.toFixed(1)}ms)`);
  } finally { db.close(); }
});

test('a cached guide is still authorised per request: revocation, disablement and cross-account reads', () => {
  const { db, store, xtream, account } = fixture();
  try {
    assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 5);
    assert.equal(store.guidePage('stranger', 'all', start, end, 0, 5).channels.length, 0, 'no grant means no cached rows');
    // Revocation must apply even though the guide is warm.
    xtream.setAccess('owner', account.id, []);
    assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 0, 'a revoked viewer gets no cached data');
    xtream.setAccess('owner', account.id, ['viewer']);
    assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 5, 'restoring the grant restores access');
    // Disabling the provider fails closed on the same warm cache.
    const status = xtream.status(account.id);
    xtream.update('owner', account.id, { expectedRevision: status.revision, enabled: false });
    assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 0, 'a disabled provider serves nothing');
    assert.throws(() => store.logo(store.visible('viewer')[0]?.id ?? 'missing', 'viewer'), { code: 'CHANNEL_NOT_FOUND' });
  } finally { db.close(); }
});

test('a provider guide never satisfies another provider listings', () => {
  const { db, store, xtream } = fixture();
  try {
    const other = xtream.create('owner', { name: 'Other', credentials: { serverUrl: 'https://other.invalid', username: 'u3', password: 'p', allowInsecureHttp: false } });
    const second = provider();
    // Same guide ids as the first provider, but different titles: a cross-scope read would show them.
    second.epg = { ...second.epg!, programs: second.epg!.programs.map(p => ({ ...p, title: `OTHER ${p.title}` })) };
    second.channels = second.channels.map((c, i) => ({ ...c, streamId: String(800000 + i), streamUrl: `https://other.invalid/${i}.ts` }));
    xtream.saveCatalogue('owner', other.id, second);
    store.publishXtream('owner', other.id, 'Other', second);
    xtream.grant('viewer', other.id);
    const page = store.guidePage('viewer', 'all', start, end, 0, 120);
    const firstSource = page.channels.filter(c => c.sourceId !== page.sources.find(s => s.name === 'Other')?.id);
    assert.ok(firstSource.length > 0);
    assert.ok(firstSource.every(c => c.programs.every(p => !p.program?.title.startsWith('OTHER '))), 'the first provider keeps its own listings');
    const titles = page.channels.flatMap(c => c.programs.map(p => p.program?.title ?? ''));
    assert.ok(titles.some(t => t.startsWith('OTHER ')), 'the second provider serves its own listings');
  } finally { db.close(); }
});

test('a clock-minute change re-joins cached evidence instead of rebuilding immutable indexes', () => {
  const { db, store } = fixture();
  const realNow = Date.now;
  try {
    assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 5);
    // Move the clock to the next minute boundary. Station stacking depends on the minute (a schedule
    // comparison), but the source snapshots, guide and resolved mappings do not.
    const base = realNow();
    Date.now = () => base + 61000;
    const counts = counted(() => assert.equal(store.guidePage('viewer', 'all', start, end, 0, 5).channels.length, 5));
    assert.equal(counts.opens['iptv:guide'] ?? 0, 0, 'the minute change decrypts no guide');
    assert.equal(counts.opens['xtream'] ?? 0, 0, 'and parses no catalogue');
    // Correctness: the page still carries real programme data across the boundary.
    Date.now = () => base + 122000;
    const page = store.guidePage('viewer', 'all', start, end, 0, 5);
    assert.ok(page.channels.some(c => c.programs.some(p => p.program?.title)));
    const names = store.guidePage('viewer', 'all', start, end, 0, 5).channels.map(c => c.feeds.map(f => f.id).join());
    assert.deepEqual(store.guidePage('viewer', 'all', start, end, 0, 5).channels.map(c => c.feeds.map(f => f.id).join()), names, 'station grouping stays stable across the boundary');
  } finally { Date.now = realNow; db.close(); }
});
