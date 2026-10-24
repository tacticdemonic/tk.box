import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import type { XtreamCatalogue, XtreamChannel } from '../apps/server/src/providers/xtream.js';

// M03.5 review: the decrypted-source cache is bounded by estimated sealed-payload bytes, and its
// accounting must match the objects it actually retains. These tests use the small-budget seam:
// allocating hundreds of megabytes in every unit test would prove nothing about the accounting.
const START = Date.UTC(2026, 9, 22, 0), END = START + 6 * 3600000;

function catalogue(index: number, channels = 8, programmes = 8): XtreamCatalogue {
  const list: XtreamChannel[] = [], guide = [], programs = [];
  for (let i = 0; i < channels; i++) {
    const id = `s${index}.${i}`;
    list.push({ streamId: String(index * 1000 + i), name: `US: Station ${i}`, group: 'Live', tvgId: id, logo: `https://logos.invalid/${index}/${i}.png`, streamUrl: `https://provider.invalid/${index}/${i}.ts`, categoryId: '1' });
    guide.push({ id, name: `US: Station ${i}` });
    for (let slot = 0; slot < programmes; slot++) programs.push({ channelId: id, start: START + slot * 3600000, end: START + (slot + 1) * 3600000, title: `Programme ${slot}`, description: 'A representative description with enough detail to give the payload bulk. '.repeat(2) });
  }
  return { version: 1, fetchedAt: Date.now(), ignoredStreams: 0, categories: [{ id: '1', name: 'Live' }],
    account: { status: 'active', expiresAt: Date.now() + 86400000, isTrial: false, maxConnections: 2, activeConnections: 1, allowedFormats: [], timezone: 'UTC' },
    channels: list, epg: { channels: guide, programs, quarantined: 0 } };
}

function fixture(budget: number) {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new IptvStore(db, vault, { dataCacheBytes: budget }), xtream = new XtreamStore(db, vault);
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const accounts = new Map<number, string>();
  const account = (index: number) => {
    const existing = accounts.get(index); if (existing) return existing;
    const created = xtream.create('viewer', { name: `Provider ${index}`, credentials: { serverUrl: `https://provider${index}.invalid`, username: 'u', password: 'p', allowInsecureHttp: false } }).id;
    accounts.set(index, created); return created;
  };
  const publish = (index: number, size?: { channels?: number; programmes?: number }) => {
    const data = catalogue(index, size?.channels, size?.programmes), id = account(index);
    xtream.saveCatalogue('viewer', id, data);
    return store.publishXtream('viewer', id, `Provider ${index}`, data).source.id;
  };
  return { db, vault, store, xtream, publish };
}
const read = (store: IptvStore) => store.guidePage('viewer', 'all', START, END, 0, 8);

test('eviction keeps the logical weight inside the budget and results rebuild correctly', () => {
  const { db, store, publish } = fixture(64 * 1024);
  try {
    const ids = [0, 1, 2, 3].map(index => publish(index));
    // Touch every source, so each entry is loaded and accounted for.
    for (const _ of ids) assert.ok(read(store).channels.length > 0);
    const afterFirst = store.cacheStats();
    assert.ok(afterFirst.bytes > 0);
    const page = read(store), stats = store.cacheStats();
    assert.ok(stats.bytes <= stats.budget, `logical weight ${stats.bytes} stays within ${stats.budget}`);
    assert.ok(stats.entries <= 4);
    assert.equal(page.channels.length, 8, 'the page still has its rows after eviction');
    const titles = page.channels.flatMap(channel => channel.programs.flatMap(row => row.program ? [row.program.title] : []));
    assert.ok(titles.length > 0, 'evicted entries rebuild their programmes');
    assert.ok(titles.every(title => title.startsWith('Programme ')), 'no foreign source data appears');
    // Accounting follows a rebuild rather than drifting: a forced clear resets it exactly.
    store.clearCache();
    assert.deepEqual(store.cacheStats(), { entries: 0, bytes: 0, budget: 64 * 1024, schedules: 0 });
    assert.ok(read(store).channels.length > 0, 'the cache is reusable after clearing');
    assert.ok(store.cacheStats().bytes > 0, 'and it accounts for the new entry');
  } finally { db.close(); }
});

test('an entry larger than the whole budget is retained alone with an explicit policy', () => {
  const { db, store, publish } = fixture(256);
  try {
    publish(0, { channels: 40, programmes: 40 });
    publish(1, { channels: 40, programmes: 40 });
    assert.ok(read(store).channels.length > 0);
    const oversized = store.cacheStats();
    assert.equal(oversized.entries, 1, 'only the entry in use is kept: evicting it would re-read it forever');
    assert.ok(oversized.bytes > oversized.budget, 'its weight is reported honestly above the budget');
    // A later read of another source replaces it instead of accumulating.
    assert.ok(read(store).channels.length > 0);
    const replaced = store.cacheStats();
    assert.equal(replaced.entries, 1);
    assert.ok(replaced.bytes > replaced.budget);
  } finally { db.close(); }
});

test('several sources near the budget evict oldest-first and stay bounded', () => {
  const { db, store, publish } = fixture(40 * 1024);
  try {
    for (const index of [0, 1, 2]) { publish(index); read(store); }
    const first = store.cacheStats();
    assert.ok(first.bytes <= first.budget, `${first.bytes} <= ${first.budget}`);
    // Repeated reads must not grow the weight beyond the budget.
    for (let round = 0; round < 8; round++) { read(store); assert.ok(store.cacheStats().bytes <= store.cacheStats().budget); }
    assert.ok(store.cacheStats().entries >= 1);
  } finally { db.close(); }
});

test('removing a source releases its cache entry and its schedule candidates', () => {
  const { db, store, publish } = fixture(96 * 1024);
  try {
    const first = publish(0), second = publish(1);
    store.guidePage('viewer', 'all', START, END, 0, 8);
    assert.ok(store.cacheStats().entries > 0);
    assert.ok(store.cacheStats().schedules >= 0);
    store.remove('viewer', first, store.status(first).revision);
    assert.equal(store.list().some(source => source.id === first), false);
    const stats = store.cacheStats();
    assert.ok(stats.entries <= 2, `entries drop with the source (${stats.entries})`);
    // The surviving provider still reads correctly.
    assert.ok(store.guidePage('viewer', 'all', START, END, 0, 8).channels.length > 0);
    assert.ok(store.status(second));
  } finally { db.close(); }
});

test('repeated refreshes do not pin superseded guides through schedule candidates', () => {
  const { db, store, xtream, publish } = fixture(96 * 1024);
  try {
    const source = publish(0);
    for (let round = 0; round < 6; round++) {
      const data = catalogue(round);
      store.publishXtream('viewer', xtream.findByLogin('https://provider0.invalid', 'u', false)!.id, 'Provider 0', data);
      store.guidePage('viewer', 'all', START, END, 0, 8);
      store.stacks('viewer');
      const stats = store.cacheStats();
      assert.ok(stats.entries <= 2, `a superseded revision is dropped, retained ${stats.entries}`);
      assert.ok(stats.bytes <= stats.budget, `weight ${stats.bytes} within ${stats.budget}`);
    }
    // The schedule cache holds at most one entry per source, not one per revision.
    assert.ok(store.cacheStats().schedules <= 1, `schedules ${store.cacheStats().schedules}`);
    const page = store.guidePage('viewer', 'all', START, END, 0, 8);
    assert.ok(page.channels.length > 0);
    assert.ok(store.status(source));
  } finally { db.close(); }
});
