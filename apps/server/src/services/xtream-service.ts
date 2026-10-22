import type { XtreamStore } from '../persistence/xtream-store.js';
import type { IptvStore } from '../persistence/iptv-store.js';
import { XtreamClient, type XtreamAccount, type XtreamCatalogue } from '../providers/xtream.js';
import { AppError, requireThat } from '../errors.js';

export type XtreamRefreshResult = {
  account: XtreamAccount; categories: number; channels: number; ignoredStreams: number;
  epgPrograms: number; epgError?: string; sourceId: string;
};

export type XtreamOperation = 'validate' | 'import';
export type XtreamImportOptions = {
  includeEpg?: boolean; now?: number; signal?: AbortSignal;
  // The account the sign-in already authenticated, so the same sequence does not ask twice.
  account?: XtreamAccount;
  // Checked after the fetch and before anything is sealed or published.
  guard?: () => void;
  onStage?: (stage: 'catalogue' | 'publish') => void;
};

// Keeps provider traffic bounded: one operation per account at a time and a small server-wide
// ceiling, so a slow panel cannot be hammered by repeated admin clicks. A failed or superseded
// import never writes: the catalogue, guide and published channels stay at the last good state.
export class XtreamService {
  private running = new Map<string, { kind: XtreamOperation; promise: Promise<unknown> }>();
  private inflight = 0;
  constructor(private store: XtreamStore, private iptv: IptvStore, private createClient: (id: string) => XtreamClient = id => new XtreamClient(this.store.credentials(id))) {}
  private async run<T>(kind: XtreamOperation, id: string, work: () => Promise<T>): Promise<T> {
    // A validation and an import are different operations, but both talk to one provider. Wait for
    // the other to finish rather than colliding or reporting one as the other.
    for (let active = this.running.get(id); active; active = this.running.get(id)) {
      if (active.kind === kind) return active.promise as Promise<T>;
      await active.promise.catch(() => {});
    }
    requireThat(this.inflight < 4, 'XTREAM_CAPACITY', 'Too many Xtream operations are active. Try again shortly.', 429);
    this.inflight++;
    // Defer so the map holds the promise even when a test client resolves synchronously.
    const task = Promise.resolve().then(work)
      .finally(() => { this.inflight--; this.running.delete(id); });
    this.running.set(id, { kind, promise: task });
    return task;
  }
  active(id: string) { return this.running.has(id); }
  usage() { return { operations: this.inflight, accounts: this.running.size }; }
  validate(actor: string, id: string) {
    return this.run('validate', id, async () => {
      try {
        const account = await this.createClient(id).authenticate();
        this.store.validated(id, account, null);
        return account;
      } catch (error) {
        // Persist the code only: upstream messages can quote the request URL and its credentials.
        this.store.refreshFailed(id, error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE');
        throw error;
      }
    });
  }
  import(actor: string, id: string, options: XtreamImportOptions = {}) {
    return this.run('import', id, async () => {
      // Shutdown may have cancelled the job between queuing it and reaching here.
      options.signal?.throwIfAborted();
      const now = options.now ?? Date.now();
      try {
        options.onStage?.('catalogue');
        const catalogue = await this.createClient(id).catalogue({ includeEpg: options.includeEpg, now, signal: options.signal, account: options.account });
        // An empty provider response would silently wipe a working lineup: treat it as a failure
        // and keep the last known channels and guide.
        requireThat(catalogue.channels.length > 0, 'XTREAM_EMPTY_CATALOGUE', 'The provider returned no live channels. The last known channel list is still in use.', 502);
        // A credential change, disable or removal that happened during the fetch must not publish.
        options.guard?.();
        this.store.validated(id, catalogue.account, null, now);
        this.store.saveCatalogue(actor, id, catalogue, now);
        options.onStage?.('publish');
        const published = this.iptv.publishXtream(actor, id, this.store.status(id).name, catalogue, now);
        return { ...this.summary(catalogue), sourceId: published.source.id };
      } catch (error) {
        // Keep the saved catalogue and its channels; record only the stable error code.
        this.store.refreshFailed(id, error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE', now);
        throw error;
      }
    });
  }
  // The synchronous form used by tests and by callers that want to await one import.
  refresh(actor: string, id: string, options: XtreamImportOptions = {}) { return this.import(actor, id, options); }
  private summary(catalogue: XtreamCatalogue): Omit<XtreamRefreshResult, 'sourceId'> {
    return { account: catalogue.account, categories: catalogue.categories.length, channels: catalogue.channels.length,
      ignoredStreams: catalogue.ignoredStreams, epgPrograms: catalogue.epg?.programs.length ?? 0,
      ...(catalogue.epgError ? { epgError: catalogue.epgError } : {}) };
  }
}
