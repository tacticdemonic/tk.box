import type { XtreamStore } from '../persistence/xtream-store.js';
import { XtreamClient, type XtreamAccount, type XtreamCatalogue } from '../providers/xtream.js';
import { AppError, requireThat } from '../errors.js';

export type XtreamRefreshResult = {
  account: XtreamAccount; categories: number; channels: number; ignoredStreams: number;
  epgPrograms: number; epgError?: string;
};

// Keeps provider traffic bounded: one operation per account at a time and a small
// server-wide ceiling, so a slow panel cannot be hammered by repeated admin clicks.
export class XtreamService {
  private running = new Map<string, Promise<unknown>>();
  private inflight = 0;
  constructor(private store: XtreamStore, private createClient: (id: string) => XtreamClient = id => new XtreamClient(this.store.credentials(id))) {}
  private run<T>(id: string, work: (client: XtreamClient) => Promise<T>): Promise<T> {
    const active = this.running.get(id);
    if (active) return active as Promise<T>;
    requireThat(this.inflight < 4, 'XTREAM_CAPACITY', 'Too many Xtream operations are active. Try again shortly.', 429);
    this.inflight++;
    // Defer so the map holds the promise even when a test client resolves synchronously.
    const task = Promise.resolve().then(() => work(this.createClient(id)))
      .finally(() => { this.inflight--; this.running.delete(id); });
    this.running.set(id, task);
    return task;
  }
  active(id: string) { return this.running.has(id); }
  validate(actor: string, id: string) {
    return this.run(id, async client => {
      try {
        const account = await client.authenticate();
        this.store.validated(id, account, null);
        return account;
      } catch (error) {
        // Persist the code only: upstream messages can quote the request URL and its credentials.
        this.store.validated(id, null, error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE');
        throw error;
      }
    });
  }
  refresh(actor: string, id: string, options: { includeEpg?: boolean; now?: number } = {}) {
    return this.run(id, async client => {
      try {
        const catalogue = await client.catalogue({ includeEpg: options.includeEpg, now: options.now });
        this.store.validated(id, catalogue.account, null);
        this.store.saveCatalogue(actor, id, catalogue);
        return this.summary(catalogue);
      } catch (error) {
        this.store.validated(id, null, error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE');
        throw error;
      }
    });
  }
  private summary(catalogue: XtreamCatalogue): XtreamRefreshResult {
    return { account: catalogue.account, categories: catalogue.categories.length, channels: catalogue.channels.length,
      ignoredStreams: catalogue.ignoredStreams, epgPrograms: catalogue.epg?.programs.length ?? 0,
      ...(catalogue.epgError ? { epgError: catalogue.epgError } : {}) };
  }
}
