// Fire OS 5/6 ship an older WebView (Chromium ~M61) than the build targets assume. Only the
// builtins the bundle actually calls are added back; syntax lowering comes from the Vite target.
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
