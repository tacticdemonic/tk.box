import test from 'node:test';
import assert from 'node:assert/strict';
import {beginNativePlayback,endNativePlayback,nativePlaybackAvailable,nativePlaybackOutcome,nativePlaybackRequest,onNativePlaybackEvent,NATIVE_EVENT,resolvePlaylistUrl} from '../apps/web/src/native-player.js';

const origin='http://192.168.1.20:3000', sessionId='A'.repeat(32);
const streamUrl=`/api/v1/live/sessions/${sessionId}/index.m3u8`;
function shell(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const calls: unknown[] = [];
  const win = {
    location: {origin},
    TkBoxNative: {
      playLiveStream: (payload: string) => { calls.push(JSON.parse(payload)); },
      stopLiveStream: () => { calls.push('stop'); },
      ...overrides
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {(listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);},
    removeEventListener: (type: string, listener: (event: Event) => void) => {listeners.get(type)?.delete(listener);}
  };
  const emit = (detail: unknown) => {for (const listener of listeners.get(NATIVE_EVENT) ?? []) listener({type: NATIVE_EVENT, detail} as unknown as Event);};
  return {win, calls, emit};
}
const plain = {location: {origin}};

test('the native bridge is optional and normal browser playback stays untouched without it', () => {
  assert.equal(nativePlaybackAvailable(plain), false);
  assert.equal(beginNativePlayback(plain, {sessionId, streamUrl}), undefined);
  assert.equal(endNativePlayback(plain, undefined), undefined);
  const {win} = shell();
  assert.equal(nativePlaybackAvailable(win), true);
});

test('bridge input accepts only the session playlist on the configured origin', () => {
  assert.equal(resolvePlaylistUrl(streamUrl, sessionId, origin), `${origin}${streamUrl}`);
  assert.equal(resolvePlaylistUrl(`${origin}${streamUrl}`, sessionId, origin), `${origin}${streamUrl}`);
  for (const rejected of [
    `https://evil.example/api/v1/live/sessions/${sessionId}/index.m3u8`,
    `/api/v1/live/sessions/${'B'.repeat(32)}/index.m3u8`,
    `${streamUrl}?token=leak`,
    `${streamUrl}#fragment`,
    `//evil.example${streamUrl}`,
    `javascript:alert(1)`,
    `/api/v1/live/sessions/${sessionId}/seg-1.ts`,
    `${origin}${streamUrl} extra`
  ]) assert.equal(resolvePlaylistUrl(rejected, sessionId, origin), undefined, rejected);
  assert.equal(nativePlaybackRequest({sessionId: '../../etc/passwd', streamUrl}, origin), undefined);
  assert.equal(nativePlaybackRequest({sessionId, streamUrl}, origin)?.streamUrl, `${origin}${streamUrl}`);
  // Control characters are stripped from labels, never from the URL.
  assert.equal(nativePlaybackRequest({sessionId, streamUrl, title: 'News\u0000 One'}, origin)?.title, 'News One');
});

test('a tuned session is handed to the shell once and reported back for cleanup', () => {
  const {win, calls} = shell();
  const playback = beginNativePlayback(win, {sessionId, streamUrl, title: 'News', subtitle: 'Midday'});
  assert.deepEqual(playback, {sessionId, streamUrl: `${origin}${streamUrl}`, title: 'News', subtitle: 'Midday'});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {sessionId, streamUrl: `${origin}${streamUrl}`, title: 'News', subtitle: 'Midday'});
  assert.equal(endNativePlayback(win, playback), sessionId);
  assert.deepEqual(calls.at(-1), 'stop');
});

test('a failing shell refuses the handoff so the web player can take over', () => {
  const throwing = shell({playLiveStream: () => { throw new Error('dead'); }}).win;
  assert.equal(beginNativePlayback(throwing, {sessionId, streamUrl}), undefined);
  const refused = shell({playLiveStream: () => false}).win;
  assert.equal(beginNativePlayback(refused, {sessionId, streamUrl}), undefined);
});

test('player events release only their own session and flag an expired login', () => {
  const active = {sessionId, streamUrl: `${origin}${streamUrl}`};
  assert.deepEqual(nativePlaybackOutcome(active, {state: 'ended'}), {release: true, expired: false, message: undefined});
  assert.equal(nativePlaybackOutcome(active, {state: 'ended', sessionId: 'B'.repeat(32)}).release, false);
  assert.equal(nativePlaybackOutcome(undefined, {state: 'ended'}).release, false);
  const expired = nativePlaybackOutcome(active, {state: 'error', sessionId, code: 'UNAUTHENTICATED'});
  assert.equal(expired.release, true); assert.equal(expired.expired, true);
  assert.equal(nativePlaybackOutcome(active, {state: 'error', code: 'LIVE_TUNE_FAILED'}).message, 'The TV player could not play this channel.');
});

test('the page receives shell events until it unsubscribes', () => {
  const {win, emit} = shell(), seen: unknown[] = [];
  const stop = onNativePlaybackEvent(event => seen.push(event), win);
  emit({state: 'ended', sessionId});
  emit({state: 'nonsense'});
  stop();
  emit({state: 'ended', sessionId});
  assert.deepEqual(seen, [{state: 'ended', sessionId, code: undefined, message: undefined}]);
});
