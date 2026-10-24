// Bounded concurrency for channel logo fetches.
// A logo holds a browser connection until its response finishes. The Fire TV WebView predates
// `loading="lazy"`, so a 50-row guide opened 50 at once, consumed every connection the page is
// allowed, and the next guide request sat in the browser's queue for seconds behind them. Logos
// are decoration, so at most `limit` are fetched at a time and a stuck one gives its slot back.
export type LogoLease = () => void;
export function createLogoSlots(limit = 4, timeoutMs = 15000) {
  const waiting: {start: () => void; giveUp: () => void}[] = [], timers = new Map<object, ReturnType<typeof setTimeout>>();
  let running = 0;
  const pump = () => {
    while (running < limit && waiting.length) {
      const next = waiting.shift()!;
      running++;
      next.start();
      const timer = setTimeout(() => { timers.delete(next); release(next); next.giveUp(); }, timeoutMs);
      // A browser timer has no unref; under Node a pending logo must not keep the process alive.
      (timer as {unref?: () => void}).unref?.();
      timers.set(next, timer);
    }
  };
  // Frees a running slot (or drops a queued waiter) exactly once.
  const release = (waiter: object) => {
    const queued = waiting.indexOf(waiter as {start: () => void; giveUp: () => void});
    if (queued >= 0) { waiting.splice(queued, 1); return; }
    clearTimeout(timers.get(waiter));
    timers.delete(waiter);
    running--;
    pump();
  };
  // Runs `start` once a slot is free; `giveUp` fires if that logo is still unsettled after
  // `timeoutMs`, and its slot is free again before `giveUp` runs. The returned lease is
  // idempotent: a queued logo leaves the queue without spending anyone's slot.
  return (start: () => void, giveUp: () => void): LogoLease => {
    const waiter = {start, giveUp};
    let released = false;
    waiting.push(waiter);
    pump();
    return () => { if (released) return; released = true; release(waiter); };
  };
}
