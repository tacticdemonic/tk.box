import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';

// M03.5 review: a playlist's cached snapshot also carries a guide index derived from a separately
// versioned XMLTV feed. Refreshing only the guide must invalidate that index, or icons and mapping
// decisions stay at the previous guide revision. Every read below runs on one IptvStore instance:
// no playlist refresh, no cache-clear command and no process restart.

const PLAYLIST = ['#EXTM3U',
  '#EXTINF:-1 tvg-id="station.one",US: One',
  'https://streams.invalid/one',
  '#EXTINF:-1 tvg-id="station.two",US: Two',
  'https://streams.invalid/two',
  '#EXTINF:-1 tvg-id="late.id",US: Late',
  'https://streams.invalid/late'].join('\n');

const START = Date.UTC(2026, 9, 22, 0), END = START + 6 * 3600000;
const programme = (channel: string, title: string) =>
  `<programme channel="${channel}" start="20261022000000 +0000" stop="20261022010000 +0000"><title>${title}</title></programme>`;
const guide = (channels: string, programmes: string) => Buffer.from(`<tv>${channels}${programmes}</tv>`);

const guideA = guide(
  '<channel id="station.one"><display-name>One</display-name><icon src="https://icons.invalid/one-a.png?token=guide-secret"/></channel>' +
  '<channel id="station.two"><display-name>Two</display-name></channel>',
  programme('station.one', 'One at A') + programme('station.two', 'Two at A'));
// Only the guide changes: a new icon, a previously absent id, and an id now naming two stations.
const guideB = guide(
  '<channel id="station.one"><display-name>One</display-name><icon src="https://icons.invalid/one-b.png?token=guide-secret"/></channel>' +
  '<channel id="station.two"><display-name>Two</display-name></channel>' +
  '<channel id="station.two"><display-name>Something Else</display-name></channel>' +
  '<channel id="late.id"><display-name>Late</display-name><icon src="https://icons.invalid/late.png"/></channel>',
  programme('station.one', 'One at B') + programme('late.id', 'Late arrives'));
// A later refresh resolves the ambiguity again.
const guideC = guide(
  '<channel id="station.one"><display-name>One</display-name><icon src="https://icons.invalid/one-c.png"/></channel>' +
  '<channel id="station.two"><display-name>Two</display-name></channel>' +
  '<channel id="late.id"><display-name>Late</display-name></channel>',
  programme('station.one', 'One at C') + programme('station.two', 'Two at C') + programme('late.id', 'Late at C'));

function fixture() {
  const db = openDatabase(':memory:'), store = new IptvStore(db, new Vault(randomBytes(32)));
  const guideFeed = store.create('owner', { kind: 'xmltv', name: 'Guide' });
  store.ingest('owner', guideFeed.id, 0, guideA);
  const playlist = store.create('owner', { kind: 'm3u', name: 'Playlist' });
  store.ingest('owner', playlist.id, 0, Buffer.from(PLAYLIST));
  store.bindFeed('owner', playlist.id, guideFeed.id, store.status(playlist.id).revision);
  const channels = store.adminChannels(playlist.id);
  // Listing is not what this test measures; make every channel visible without channel checks.
  for (const channel of channels) store.editChannel('owner', channel.id, { expectedRevision: store.status(playlist.id).revision, listing: 'always' });
  const byTvg = new Map(store.adminChannels(playlist.id).map(c => [c.tvgId, c.id]));
  return { db, store, guideFeed, playlistId: playlist.id, byTvg };
}
const mappingOf = (store: IptvStore, channelId: string, feedId: string) => store.mappingReview(channelId, feedId).mapping?.xmlId;
const titles = (store: IptvStore, channelId: string, feedId: string) =>
  store.guide(channelId, feedId, START, END).flatMap(row => row.program ? [row.program.title] : []);

test('an XMLTV-only refresh updates guide icons and mapping decisions for a cached playlist', () => {
  const { db, store, guideFeed, playlistId, byTvg } = fixture();
  try {
    const one = byTvg.get('station.one')!, two = byTvg.get('station.two')!, late = byTvg.get('late.id')!;
    // Warm the guide, mapping, stack and logo reads exactly as a page and a grid would.
    assert.equal(mappingOf(store, one, guideFeed.id), 'station.one');
    assert.equal(mappingOf(store, two, guideFeed.id), 'station.two');
    assert.equal(mappingOf(store, late, guideFeed.id), undefined, 'the guide has no such id yet');
    assert.deepEqual(store.logo(one).urls, ['https://icons.invalid/one-a.png?token=guide-secret']);
    assert.deepEqual(titles(store, late, guideFeed.id), []);
    assert.ok(store.visible('').some(row => row.id === one));
    const stack = store.stacks('').find(row => row.feeds.some(f => f.id === one));
    assert.ok(stack, 'the station groups into a stack');

    // Refresh only the guide. Playlist revision, listing and numbers stay untouched.
    const playlistRevision = store.status(playlistId).revision;
    store.ingest('owner', guideFeed.id, store.status(guideFeed.id).revision, guideB);
    assert.equal(store.status(playlistId).revision, playlistRevision, 'no playlist refresh happened');

    assert.deepEqual(store.logo(one).urls, ['https://icons.invalid/one-b.png?token=guide-secret'], 'the guide icon updates');
    assert.equal(mappingOf(store, one, guideFeed.id), 'station.one');
    assert.equal(mappingOf(store, late, guideFeed.id), 'late.id', 'a previously absent id becomes available');
    assert.equal(mappingOf(store, two, guideFeed.id), undefined, 'an id naming two stations is ambiguous');
    assert.deepEqual(titles(store, late, guideFeed.id), ['Late arrives']);
    assert.deepEqual(titles(store, one, guideFeed.id), ['One at B']);
    assert.equal(store.guide(one, guideFeed.id, START, END)[0]?.program?.title, 'One at B');

    // A later guide refresh resolves the ambiguity and changes the icon again.
    store.ingest('owner', guideFeed.id, store.status(guideFeed.id).revision, guideC);
    assert.equal(mappingOf(store, two, guideFeed.id), 'station.two', 'ambiguity resolved by a later refresh');
    assert.deepEqual(store.logo(one).urls, ['https://icons.invalid/one-c.png'], 'the later icon wins');
    assert.deepEqual(titles(store, two, guideFeed.id), ['Two at C']);
    assert.ok(store.visible('').some(row => row.id === one), 'the station is still listed after the refreshes');

    // Two playlists sharing one guide each see the refreshed projection under their own channel.
    const second = store.create('owner', { kind: 'm3u', name: 'Second playlist' });
    store.ingest('owner', second.id, 0, Buffer.from(PLAYLIST));
    store.bindFeed('owner', second.id, guideFeed.id, store.status(second.id).revision);
    const secondOne = store.adminChannels(second.id).find(c => c.tvgId === 'station.one')!;
    store.editChannel('owner', secondOne.id, { expectedRevision: store.status(second.id).revision, listing: 'always' });
    store.ingest('owner', guideFeed.id, store.status(guideFeed.id).revision, guideB);
    assert.deepEqual(store.logo(secondOne.id).urls, ['https://icons.invalid/one-b.png?token=guide-secret'], 'the shared guide refreshes both playlists');
    assert.equal(mappingOf(store, secondOne.id, guideFeed.id), 'station.one');

    // Relinking a playlist to another guide must not retain the old guide's icon or mapping.
    const other = store.create('owner', { kind: 'xmltv', name: 'Other guide' });
    store.ingest('owner', other.id, 0, guide(
      '<channel id="station.one"><display-name>One</display-name><icon src="https://icons.invalid/other.png"/></channel>' +
      '<channel id="late.id"><display-name>Late</display-name></channel>',
      programme('station.one', 'One elsewhere')));
    store.bindFeed('owner', second.id, other.id, store.status(second.id).revision);
    assert.deepEqual(store.logo(secondOne.id).urls, ['https://icons.invalid/other.png'], 'the relinked guide supplies the icon');
    assert.deepEqual(titles(store, secondOne.id, other.id), ['One elsewhere']);
    assert.equal(mappingOf(store, secondOne.id, other.id), 'station.one');
    assert.throws(() => store.mappingReview(secondOne.id, guideFeed.id), { code: 'MAPPING_SCOPE' }, 'the old feed is no longer linked');
    // And the first playlist is unaffected by the second's relink.
    assert.deepEqual(store.logo(one).urls, ['https://icons.invalid/one-b.png?token=guide-secret']);
  } finally { db.close(); }
});
