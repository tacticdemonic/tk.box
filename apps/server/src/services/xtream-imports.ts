import type { XtreamImport, XtreamStore } from '../persistence/xtream-store.js';
import type { XtreamService } from './xtream-service.js';
import type { XtreamAccount } from '../providers/xtream.js';
import { requireThat } from '../errors.js';

// Catalogue and guide retrieval is work, not part of a sign-in response. This manager owns that
// work for every caller (sign-in, manual refresh, the schedule), so one account never runs two
// imports: `XtreamStore.queueImport` enforces that in SQLite and this class bounds how many
// accounts run at once. Nothing is detached or unobserved: every job has a row, a state and a
// terminal error code, and `close()` ends in-flight work before the process exits.
const MAX_IMPORTS = 2;
type Waiter = { promise: Promise<XtreamImport>; resolve: (job: XtreamImport) => void };

export class XtreamImports {
  private active = new Map<string, AbortController>();
  private waiters = new Map<string, Waiter>();
  // Provider authentication a sign-in already performed, used once by the job it queued.
  private authenticated = new Map<string, XtreamAccount>();
  private pending = new Set<Promise<void>>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  // Called after a catalogue is published, e.g. to rematch sports events against the new lineup.
  published: (sourceId: string) => void = () => {};
  constructor(private store: XtreamStore, private service: XtreamService, private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {
    // A previous process cannot still be fetching; report its unfinished rows honestly instead
    // of leaving them "running" until the next restart.
    const interrupted = store.interruptStaleImports();
    if (interrupted) this.log('xtream imports marked interrupted after restart', { count: interrupted });
  }
  start(intervalMs = 5000) {
    this.timer = setInterval(() => this.pump(), intervalMs);
    this.timer.unref();
    this.pump();
  }
  private waiter(id: string) {
    let waiter = this.waiters.get(id);
    if (!waiter) {
      let resolve: (job: XtreamImport) => void = () => {};
      const promise = new Promise<XtreamImport>(done => { resolve = done; });
      waiter = { promise, resolve };
      this.waiters.set(id, waiter);
    }
    return waiter;
  }
  // Joins the account's active import when one exists, so repeated sign-ins and refreshes do not
  // queue duplicate work. Throws only when the job could not be recorded at all.
  schedule(actor: string, accountId: string, includeEpg = true, now = Date.now(), account?: XtreamAccount) {
    requireThat(!this.stopped, 'IMPORT_STOPPED', 'The import service is shutting down.', 503);
    const { import: job, created } = this.store.queueImport(actor, accountId, includeEpg, now);
    this.waiter(job.id);
    if (created && account) this.authenticated.set(job.id, account);
    if (created) this.pump();
    return job;
  }
  // Schedule and wait for the terminal state. Scheduled refreshes use this so the existing
  // source retry/backoff applies; a browser request never does.
  run(actor: string, accountId: string, includeEpg = true) {
    const job = this.schedule(actor, accountId, includeEpg);
    return this.waiter(job.id).promise;
  }
  activeImport(accountId: string) { return this.store.importStatus(accountId).active; }
  private pump() {
    if (this.stopped) return;
    while (this.active.size < MAX_IMPORTS) {
      const next = this.store.claimImport();
      if (!next) return;
      const controller = new AbortController();
      this.active.set(next.import.id, controller);
      const work = this.execute(next.import, next.actor, controller).finally(() => {
        this.active.delete(next.import.id);
        this.pending.delete(work);
      });
      this.pending.add(work);
    }
  }
  private async execute(job: XtreamImport, actor: string, controller: AbortController): Promise<void> {
    let final = job;
    try {
      const result = await this.service.import(actor, job.accountId, {
        includeEpg: job.includeEpg,
        signal: controller.signal,
        account: this.authenticated.get(job.id),
        onStage: stage => this.store.importStage(job.id, stage),
        // Credentials replaced, the provider disabled or the account removed while we fetched:
        // the result is stale, so it must not be sealed or published.
        guard: () => {
          requireThat(!controller.signal.aborted, 'IMPORT_INTERRUPTED', 'The import was interrupted.', 503);
          requireThat(this.store.importCurrent(job), 'XTREAM_CREDENTIALS_CHANGED', 'The provider changed while it was being read.', 409);
        }
      });
      // A guide problem never fails the import: the channels are published and the guide outcome
      // is recorded beside them, with the primary diagnostic retained for context.
      final = this.store.finishImport(job.id, { state: 'completed', ...(result.epgError ? { guideError: result.epgError } : {}), ...(result.guide ? { guide: result.guide } : {}) }) ?? final;
      this.published(result.sourceId);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'XTREAM_UNREACHABLE';
      const aborted = controller.signal.aborted || code === 'IMPORT_INTERRUPTED';
      const state = aborted ? 'interrupted' : 'failed';
      final = this.store.finishImport(job.id, { state, error: aborted ? 'IMPORT_INTERRUPTED' : code }) ?? final;
      // Stable code only: an upstream message could quote the provider URL and credentials.
      this.log('xtream import did not complete', { importId: job.id, code, state });
    } finally {
      this.authenticated.delete(job.id);
      const waiter = this.waiters.get(job.id);
      if (waiter) { this.waiters.delete(job.id); waiter.resolve(final); }
      this.pump();
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
    // Queued jobs that never started are reported as interrupted, not left pending forever.
    this.store.interruptStaleImports();
    this.authenticated.clear();
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      // A provider removed during shutdown takes its job rows with it; the wait ends either way.
      try { waiter.resolve(this.store.import(id)); } catch { /* the account is gone */ }
    }
  }
}
