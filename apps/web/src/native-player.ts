// Explicit bridge to the Android Fire TV shell. The page keeps playing with hls.js when no
// bridge is present; the shell only takes over an already-created live session.
export type NativePlaybackRequest = {sessionId: string; streamUrl: string; title?: string; subtitle?: string};
export type NativePlayback = {sessionId: string; streamUrl: string; title?: string; subtitle?: string};
export type NativePlaybackEvent = {state: 'ended' | 'error'; sessionId?: string; code?: string; message?: string};
type WindowLike = {
  location?: {origin?: string};
  TkBoxNative?: {playLiveStream?: (payload: string) => unknown; stopLiveStream?: () => unknown};
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
};
export const NATIVE_EVENT = 'tkbox:native-playback';
const sessionPattern = /^[A-Za-z0-9_-]{16,128}$/;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || undefined : undefined;

// The URL may be the relative playlist the server returned or the same URL made absolute.
// Nothing outside the configured origin and the session's own playlist is accepted.
export function resolvePlaylistUrl(streamUrl: unknown, sessionId: string, origin: string): string | undefined {
  if (typeof streamUrl !== 'string' || !streamUrl || streamUrl.length > 2048 || /[\s\u0000-\u001f]/.test(streamUrl)) return undefined;
  const expected = `/api/v1/live/sessions/${sessionId}/index.m3u8`;
  let url: URL;
  try { url = new URL(streamUrl, origin); } catch { return undefined; }
  if (url.origin !== origin || url.username || url.password || url.pathname !== expected || url.search || url.hash) return undefined;
  return `${origin}${expected}`;
}
export function nativePlaybackRequest(input: Partial<NativePlaybackRequest>, origin: string): NativePlayback | undefined {
  if (!sessionPattern.test(String(input.sessionId ?? ''))) return undefined;
  const streamUrl = resolvePlaylistUrl(input.streamUrl, input.sessionId!, origin);
  if (!streamUrl) return undefined;
  return {sessionId: input.sessionId!, streamUrl, title: text(input.title, 120), subtitle: text(input.subtitle, 200)};
}
const originOf = (win: WindowLike) => { try { const origin = win.location?.origin; return origin && /^https?:\/\//.test(origin) ? origin : undefined; } catch { return undefined; } };
export function nativePlaybackAvailable(win: WindowLike = globalThis as WindowLike): boolean {
  return typeof win.TkBoxNative?.playLiveStream === 'function';
}
// Hands the tuned session to the shell. Returns the accepted playback so the caller can stop it;
// undefined means the web player must keep playing.
export function beginNativePlayback(win: WindowLike = globalThis as WindowLike, input: Partial<NativePlaybackRequest> = {}): NativePlayback | undefined {
  const origin = originOf(win), request = origin && nativePlaybackRequest(input, origin);
  if (!request || typeof win.TkBoxNative?.playLiveStream !== 'function') return undefined;
  try { return win.TkBoxNative.playLiveStream(JSON.stringify(request)) === false ? undefined : request; } catch { return undefined; }
}
// Stops the native player and returns the session the caller still has to release server-side.
export function endNativePlayback(win: WindowLike = globalThis as WindowLike, playback?: NativePlayback): string | undefined {
  if (!playback) return undefined;
  try { win.TkBoxNative?.stopLiveStream?.(); } catch { /* the shell closes with the activity */ }
  return playback.sessionId;
}
// The shell reports its player closing as an event, so the page can drop the session and focus.
export function onNativePlaybackEvent(listener: (event: NativePlaybackEvent) => void, win: WindowLike = globalThis as WindowLike): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<NativePlaybackEvent>).detail;
    if (!detail || (detail.state !== 'ended' && detail.state !== 'error')) return;
    listener({state: detail.state, sessionId: text(detail.sessionId, 128), code: text(detail.code, 64), message: text(detail.message, 200)});
  };
  win.addEventListener?.(NATIVE_EVENT, handle);
  return () => win.removeEventListener?.(NATIVE_EVENT, handle);
}
// Events for another session (a channel switched before the old player closed) must not affect
// the current one. A matching end or error releases the session and, for auth failures, reloads.
export function nativePlaybackOutcome(active: NativePlayback | undefined, event: NativePlaybackEvent) {
  if (!active) return {release: false, expired: false};
  if (event.sessionId && event.sessionId !== active.sessionId) return {release: false, expired: false};
  return {release: true, expired: event.code === 'UNAUTHENTICATED' || event.code === 'SESSION_EXPIRED', message: event.state === 'error' ? event.message ?? 'The TV player could not play this channel.' : undefined};
}
