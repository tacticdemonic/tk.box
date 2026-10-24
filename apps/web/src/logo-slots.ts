// Bounded concurrency for channel logo fetches.
// A logo holds a browser connection until its response finishes. The Fire TV WebView predates
// `loading="lazy"`, so a 50-row guide opened 50 at once, consumed every connection the page is
// allowed, and the next guide request sat in the browser's queue for seconds behind them. Logos
// are decoration, so at most `limit` are fetched at a time and a stuck one gives its slot back.
export type LogoLease = () => void;
export function createLogoSlots(limit = 4, timeoutMs = 15000) {
  // One job is settled by exactly one of: its own completion, its deadline, or its cancellation.
  // The state lives on the job rather than in the caller's closure, so the deadline can retire a
  // job whose lease the caller still holds and a later settle of that lease changes nothing.
  type Job = { start: () => void; giveUp: () => void; state: 'queued' | 'running' | 'done' };
  const waiting: Job[] = [], timers = new Map<Job, ReturnType<typeof setTimeout>>();
  let running = 0;
  // Returns this job's capacity once. A queued job only leaves the queue; it never held a slot.
  // Callers pump afterwards, so a deadline can retire its job, let the caller unmount the stale
  // image, and only then admit the next one.
  const retire = (job: Job) => {
    if (job.state === 'done') return;
    if (job.state === 'queued') { waiting.splice(waiting.indexOf(job), 1); job.state = 'done'; return; }
    job.state = 'done';
    clearTimeout(timers.get(job));
    timers.delete(job);
    running--;
  };
  const pump = () => {
    while (running < limit && waiting.length) {
      const next = waiting.shift()!;
      next.state = 'running';
      running++;
      const timer = setTimeout(() => {
        // Only a job still running has timed out; a synchronous settle has already retired it.
        if (next.state !== 'running') return;
        retire(next); next.giveUp(); pump();
      }, timeoutMs);
      // A browser timer has no unref; under Node a pending logo must not keep the process alive.
      (timer as {unref?: () => void}).unref?.();
      timers.set(next, timer);
      next.start();
    }
  };
  // Runs `start` once a slot is free; `giveUp` fires if that logo is still unsettled after
  // `timeoutMs`, and its slot is free again before `giveUp` runs. The returned lease is safe to
  // call any number of times, before or after the deadline: capacity is returned once.
  return (start: () => void, giveUp: () => void): LogoLease => {
    const job: Job = {start, giveUp, state: 'queued'};
    waiting.push(job);
    pump();
    return () => { retire(job); pump(); };
  };
}
