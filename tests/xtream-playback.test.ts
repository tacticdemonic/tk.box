import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { randomBytes } from 'node:crypto';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { XtreamStore } from '../apps/server/src/persistence/xtream-store.js';
import { XtreamService } from '../apps/server/src/services/xtream-service.js';
import { XtreamClient } from '../apps/server/src/providers/xtream.js';
import { EncoderBudget } from '../apps/server/src/streaming/policy.js';
import { ProviderConnections } from '../apps/server/src/streaming/provider-connections.js';
import { LiveTv } from '../apps/server/src/services/live-tv.js';
import { AppError } from '../apps/server/src/errors.js';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const available = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;

// A synthetic Xtream panel: player_api and xmltv responses plus a live MPEG-TS endpoint. The
// provider's stream URLs include its credentials, exactly as a real panel builds them.
async function xtreamPanel(maxConnections: string) {
  const streams = {open: 0, peak: 0};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.endsWith('/player_api.php')) {
      const action = url.searchParams.get('action');
      const body = !action ? {user_info: {auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400), max_connections: maxConnections}, server_info: {timezone: 'UTC'}}
        : action === 'get_live_categories' ? [{category_id: '1', category_name: 'Live'}]
        : action === 'get_live_streams' ? [{stream_id: 1, name: 'Test One', category_id: '1', container_extension: 'ts'}, {stream_id: 2, name: 'Test Two', category_id: '1', container_extension: 'ts'}]
        : undefined;
      if (!body) { res.writeHead(400).end(); return; }
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(body));
      return;
    }
    if (url.pathname.endsWith('/xmltv.php')) { res.writeHead(200, {'content-type': 'application/xml'}).end('<tv><channel id="test.one"><display-name>Test One</display-name></channel></tv>'); return; }
    // Any provider stream path: endless H.264/MP2 in raw MPEG-TS, like a live channel.
    res.writeHead(200, {'content-type': 'video/mp2t'});
    streams.peak = Math.max(streams.peak, ++streams.open); res.on('close', () => streams.open--);
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'mp2', '-f', 'mpegts', 'pipe:1'], {stdio: ['ignore', 'pipe', 'ignore']});
    child.stdout.pipe(res); res.on('close', () => child.kill('SIGKILL'));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentials = {serverUrl: origin, username: 'panel-user', password: 'panel-secret', allowInsecureHttp: true};
  const transport = (async (endpoint: {url: string}) => {
    const response = await fetch(endpoint.url, {redirect: 'error'});
    return Buffer.from(await response.arrayBuffer());
  }) as never;
  return {server, streams, origin, credentials, transport};
}

test('Xtream channels tune through the shared relay within the provider connection limit and revoke on access changes', {skip: !available && 'FFmpeg unavailable', timeout: 120000}, async () => {
  const panel = await xtreamPanel('1'), cache = mkdtempSync(join(tmpdir(), 'tk-xtream-live-'));
  const db = openDatabase(':memory:'), vault = new Vault(randomBytes(32)), xtream = new XtreamStore(db, vault), iptv = new IptvStore(db, vault);
  const service = new XtreamService(xtream, iptv, () => new XtreamClient(panel.credentials, panel.transport));
  const live = new LiveTv(iptv, new EncoderBudget(() => 1), cache, ffmpeg, ffprobe);
  db.prepare('INSERT INTO users VALUES(?,1)').run('alice');
  db.prepare('INSERT INTO users VALUES(?,1)').run('bob');
  try {
    const account = xtream.create('alice', {name: 'Panel', credentials: panel.credentials});
    xtream.grant('bob', account.id);
    const refreshed = await service.refresh('alice', account.id, {includeEpg: true});
    assert.equal(refreshed.channels, 2);
    const channels = iptv.stacks('alice');
    assert.equal(channels.length, 2);

    // The shared pool enforces the provider's own limit, not only the server-wide one.
    live.connections = new ProviderConnections(() => 8, 15000, id => xtream.limit(id));
    const first = await live.start('session-a', channels[0]!.id, 'alice');
    assert.equal(first.delivery, 'remux', JSON.stringify(first.source));
    assert.ok(!JSON.stringify(first).includes(panel.origin), 'playback never exposes the provider origin');
    const playlist = await live.playlist(first.id, 'session-a');
    assert.match(playlist, /#EXTINF/);
    const segment = playlist.split('\n').find(line => line.startsWith('seg-'))!;
    const media = await live.segment(first.id, 'session-a', segment);
    assert.ok(media.size > 0); media.body.destroy();
    // A second distinct channel needs another provider connection; the plan allows one.
    await assert.rejects(live.start('session-b', channels[1]!.id, 'alice'), (error: unknown) => error instanceof AppError && error.code === 'XTREAM_CONNECTIONS_FULL');
    // Revoking bob's access ends playback at the next playlist request.
    const bobs = await live.start('session-c', channels[0]!.id, 'bob');
    xtream.setAccess('alice', account.id, ['alice']);
    await assert.rejects(live.playlist(bobs.id, 'session-c'), (error: unknown) => error instanceof AppError && error.code === 'CHANNEL_NOT_FOUND');
    // Disabling the provider revokes the remaining session too.
    xtream.update('alice', account.id, {expectedRevision: xtream.status(account.id).revision, enabled: false});
    await assert.rejects(live.playlist(first.id, 'session-a'), (error: unknown) => error instanceof AppError && error.code === 'CHANNEL_NOT_FOUND');
    live.stop(first.id, 'session-a');
    assert.equal(panel.streams.peak, 1, 'one upstream stream at a time');
  } finally {live.close(); panel.server.close(); db.close();}
});
