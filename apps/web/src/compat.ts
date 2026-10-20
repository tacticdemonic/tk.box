// Fire OS 5/6 ship an older WebView (Chromium ~M61-66) than the build targets assume. Only the
// builtins the bundle actually calls are added back; syntax lowering comes from the Vite target.
// Chromium 66 (verified on an Android TV API 28 image) predates globalThis, and the whole
// bundle fails without it, so this file must stay the first import of the entry point.
const browser = (typeof window !== 'undefined' ? window : self) as unknown as {globalThis?: unknown};
if (typeof browser.globalThis === 'undefined') browser.globalThis = browser;
const object = Object as unknown as {fromEntries?: unknown};
object.fromEntries ??= (entries: Iterable<readonly [PropertyKey, unknown]>) => {
  const result: Record<PropertyKey, unknown> = {};
  for (const [key, value] of entries) result[key] = value;
  return result;
};
Array.prototype.at ??= function at(this: unknown[], index: number) {
  const length = this.length, offset = index < 0 ? length + index : index;
  return offset < 0 || offset >= length ? undefined : this[offset];
};
const replaceAll = function (this: string, search: string | RegExp, replacement: string) {
  return search instanceof RegExp ? this.replace(search.global ? search : new RegExp(search.source, `${search.flags}g`), replacement) : this.split(search).join(replacement);
};
(String.prototype as unknown as {replaceAll?: unknown}).replaceAll ??= replaceAll;
// Chromium 66 (the API 28 TV WebView here) also predates flat/flatMap; React's JSX transform uses them.
const array = Array.prototype as unknown as {flat?: unknown; flatMap?: unknown};
array.flat ??= function flat(this: unknown[], depth = 1): unknown[] {
  return depth < 1 ? this.slice() : this.reduce<unknown[]>((list, item) => list.concat(Array.isArray(item) ? (flat.call(item, depth - 1) as unknown[]) : item), []);
};
array.flatMap ??= function flatMap(this: unknown[], callback: (item: unknown, index: number, list: unknown[]) => unknown) {
  return (array.flat as (this: unknown[], depth?: number) => unknown[]).call(this.map(callback), 1);
};
Promise.allSettled ??= function allSettled<T>(values: Iterable<T | PromiseLike<T>>) {
  return Promise.all([...values].map(value => Promise.resolve(value).then(
    (value): PromiseSettledResult<T> => ({status: 'fulfilled', value}),
    (reason): PromiseSettledResult<T> => ({status: 'rejected', reason})
  )));
};
if (typeof AbortSignal !== 'undefined') {
  AbortSignal.timeout ??= (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  };
  AbortSignal.any ??= (signals: AbortSignal[]) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {controller.abort(signal.reason); break;}
      signal.addEventListener('abort', () => controller.abort(signal.reason), {once: true});
    }
    return controller.signal;
  };
}
if (typeof queueMicrotask === 'undefined') {
  (globalThis as {queueMicrotask?: (callback: () => void) => void}).queueMicrotask = callback => {void Promise.resolve().then(callback);};
}

// Chromium 66 accepts `gap`, `min()` and `clamp()` in some contexts and not others (grid gap
// exists, flex gap does not), so both are measured on the real layout instead of sniffed.
function supportsFlexGap() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;gap:4px';
  probe.innerHTML = '<i></i><i></i>';
  document.body.appendChild(probe);
  const works = probe.lastElementChild!.getBoundingClientRect().top - probe.firstElementChild!.getBoundingClientRect().bottom >= 3;
  probe.remove();
  return works;
}
function supportsModernCss() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:clamp(10px, 50px, 90px)';
  document.body.appendChild(probe);
  const ok = probe.getBoundingClientRect().width > 0;
  probe.remove();
  return ok;
}
if (typeof document !== 'undefined') {
  const apply = () => {
    const root = document.documentElement, flexGap = supportsFlexGap(), modern = supportsModernCss();
    if (!flexGap) root.classList.add('legacy-flex-gap');
    if (!modern) root.classList.add('legacy-css');
    console.info(`TkBoxCompat flexGap=${flexGap} modernCss=${modern} chrome=${/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? '?'}`);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, {once: true});
  else apply();
}
