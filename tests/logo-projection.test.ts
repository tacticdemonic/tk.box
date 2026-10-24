import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase, type Db } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { registerIptv } from '../apps/server/src/iptv-api.js';
import { SourceRefresh } from '../apps/server/src/services/source-refresh.js';
import type { ChannelLogos } from '../apps/server/src/providers/channel-logos.js';
import type { LogoLibrary } from '../apps/server/src/providers/logo-library.js';

// M03.5 review: coverage() publishes a guide icon so a logo request never decrypts the guide. The
// URL can carry a provider access token, so the projection must not be plaintext, must be bound to
// its channel, and must still reach the authorised server-side fetch.
const TOKEN = 'tok_9f3c2a-guide-secret';
const ICON = `https://icons.invalid/station.png?access_token=${TOKEN}`;
const guide = (icon: string) => Buffer.from(`<tv><channel id="c"><display-name>Station</display-name><icon src="${icon}"/></channel>` +
  `<programme channel="c" start="20261022000000 +0000" stop="20261022010000 +0000"><title>Programme</title></programme></tv>`);
const playlist = (logo = '') => Buffer.from(`#EXTM3U\n#EXTINF:-1 tvg-id="c"${logo ? ` tvg-logo="${logo}"` : ''},Station\nhttps://streams.invalid/station`);

type IconRow = { channel_id: string; icon: string };
const iconRows = (db: Db) => db.prepare('SELECT channel_id,icon FROM iptv_channel_icons').all() as IconRow[];
const everything = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
  .map(row => row.name).filter(name => !name.startsWith('sqlite_')).map(name => db.prepare(`SELECT * FROM "${name}"`).all());

function publish(store: IptvStore, text = playlist(), icon = ICON) {
  const feed = store.create('owner', { kind: 'xmltv', name: 'Guide' });
  store.ingest('owner', feed.id, 0, guide(icon));
  const source = store.create('owner', { kind: 'm3u', name: 'Playlist' });
  store.ingest('owner', source.id, 0, text);
  store.bindFeed('owner', source.id, feed.id, store.status(source.id).revision);
  const first = store.adminChannels(source.id)[0]!;
  store.editChannel('owner', first.id, { expectedRevision: store.status(source.id).revision, listing: 'always' });
  return { feed, source, channel: store.adminChannels(source.id)[0]! };
}

// A fetch double that records what the route would send upstream, without any network access.
function logos(seen: string[]) {
  const get = async (url: string) => { seen.push(url); return { type: 'image/png', bytes: Buffer.from([1, 2, 3]) }; };
  return { get } as unknown as ChannelLogos;
}
const noLibrary = { match: async () => undefined } as unknown as LogoLibrary;

test('the derived icon projection stores no plaintext token and still fetches the authorised URL', async () => {
  const db = openDatabase(':memory:'), store = new IptvStore(db, new Vault(randomBytes(32)));
  // A playlist logo with its own token, so both projection kinds are covered.
  const { channel } = publish(store, playlist(`https://logos.invalid/s.png?token=${TOKEN}`)), fetched: string[] = [];
  const access = async () => ({ grant: { accountId: 'viewer' } });
  const app = Fastify();
  registerIptv(app, store, new SourceRefresh(store, { fetch: async () => playlist() }), access, access, logos(fetched), noLibrary);
  try {
    assert.ok(!JSON.stringify(everything(db)).includes(TOKEN), 'no token in any persisted column of any table');

    const response = await app.inject({ url: `/api/v1/iptv/channels/${channel.id}/logo` });
    assert.equal(response.statusCode, 200, 'the logo route still serves the image');
    assert.ok(!response.body.includes(TOKEN));
    // The playlist logo carries the token, so it wins the ordering and the fetch receives it.
    assert.deepEqual(fetched, [`https://logos.invalid/s.png?token=${TOKEN}`], 'the server-side fetch receives the real URL');

    // Without a playlist logo the guide icon is fetched instead.
    const second = publish(store), fetched2: string[] = [];
    const app2 = Fastify();
    registerIptv(app2, store, new SourceRefresh(store, { fetch: async () => playlist() }), access, access, logos(fetched2), noLibrary);
    try {
      assert.equal((await app2.inject({ url: `/api/v1/iptv/channels/${second.channel.id}/logo` })).statusCode, 200);
      assert.deepEqual(fetched2, [ICON], 'the guide icon URL reaches the fetch intact');
    } finally { await app2.close(); }

    // Authorisation runs on every request, including while the projection row is warm.
    const denied = async () => { throw Object.assign(new Error('Sign in with Plex.'), { status: 401, code: 'UNAUTHENTICATED' }); };
    const app3 = Fastify();
    registerIptv(app3, store, new SourceRefresh(store, { fetch: async () => playlist() }), denied, denied, logos([]), noLibrary);
    try { assert.equal((await app3.inject({ url: `/api/v1/iptv/channels/${channel.id}/logo` })).statusCode, 401, 'an unauthenticated caller cannot read a protected logo'); }
    finally { await app3.close(); }
  } finally { await app.close(); db.close(); }
});

test('a sealed icon cannot be substituted between channels or opened with another context', () => {
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), store = new IptvStore(db, vault);
  try {
    const first = publish(store).channel;
    const second = publish(store, playlist(), 'https://icons.invalid/other.png?access_token=other').channel;
    const rows = iconRows(db), stolen = rows.find(row => row.channel_id === first.id)!.icon;
    assert.equal(store.logo(second.id).urls.at(-1), 'https://icons.invalid/other.png?access_token=other', 'the second channel has its own icon');
    // Copying one channel's ciphertext onto another must not yield the first channel's icon.
    db.prepare('UPDATE iptv_channel_icons SET icon=? WHERE channel_id=?').run(stolen, second.id);
    assert.equal(store.logo(second.id).urls.at(-1), undefined, 'the substituted record fails to open rather than borrowing another channel');
    assert.throws(() => vault.open(stolen.replace(/^sealed:/, ''), `iptv:icon:${second.id}`), /unable to authenticate|bad decrypt/i, 'context binding rejects another channel');
    assert.equal(vault.open(stolen.replace(/^sealed:/, ''), `iptv:icon:${first.id}`), ICON);
    assert.equal(store.logo(first.id).urls.at(-1), ICON, 'the original channel is unaffected');
  } finally { db.close(); }
});

test('a database that already applied 1005 drops its plaintext rows and republishes them sealed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tkbox-icons-')), file = join(root, 'tk.box.sqlite'), keyFile = join(root, 'secret.key');
  try {
    const db = openDatabase(file), vault = Vault.fromFile(keyFile), store = new IptvStore(db, vault);
    const { channel } = publish(store);
    // Model a deployment that applied 1005 and stored the raw URL before 1006 existed.
    db.prepare('UPDATE iptv_channel_icons SET icon=? WHERE channel_id=?').run(ICON, channel.id);
    db.prepare('DELETE FROM migrations WHERE version=1006').run();
    db.close();

    const reopened = openDatabase(file), store2 = new IptvStore(reopened, Vault.fromFile(keyFile));
    try {
      assert.ok(reopened.prepare('SELECT 1 FROM migrations WHERE version=1006').get(), '1006 is recorded');
      assert.equal(iconRows(reopened).length, 0, 'the plaintext rows are removed, not trusted');
      // The startup pass republishes the sealed projection from the stored guide.
      store2.relistAll();
      assert.equal(store2.logo(channel.id).urls.at(-1), ICON, 'the icon is available again, sealed');
      assert.ok(!JSON.stringify(everything(reopened)).includes(TOKEN), 'the token is absent from every live row');
    } finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
