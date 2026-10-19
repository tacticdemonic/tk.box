import { AppError } from '../errors.js';

export type ConnectionLease = { release: () => void; closing: () => void };
type Lease = { kind: 'viewer' | 'check'; providerId?: string; cancel?: () => void; closing: boolean };
type Waiter = { grant: () => void; providerId?: string };

// Provider plans allow a fixed number of simultaneous streams (often one or two), and every
// source of this server counts against the same limit. Everything that opens an upstream stream
// holds a lease here until its process has exited, so a relay or check that is still shutting
// down keeps counting until its socket is gone. Viewers always come first: a viewer cancels
// running checks and waits for them to exit, and a check never starts while a viewer is waiting
// or every connection is taken. Viewers never displace each other; once viewers hold every
// connection, the next one is refused.
//
// An Xtream account also has its own ceiling (`max_connections`), shared by its relays and
// checks. A lease names that account so one subscription cannot be overrun by the server-wide
// budget, and a viewer may reclaim a check of the same provider.
export class ProviderConnections {
  private leases = new Set<Lease>();
  private waiters: Waiter[] = [];
  constructor(private limit: () => number, private waitMs = 15000, private providerLimit: (providerId: string) => number | undefined = () => undefined) {}
  usage() {
    const held = [...this.leases];
    return { limit: this.limit(), viewers: held.filter(l => l.kind === 'viewer').length, checks: held.filter(l => l.kind === 'check').length };
  }
  tryCheck(cancel: () => void, providerId?: string): ConnectionLease | undefined {
    const cap = providerId === undefined ? undefined : this.providerLimit(providerId);
    const fitsProvider = cap === undefined || [...this.leases].filter(l => l.providerId === providerId).length < cap;
    if (this.waiters.length || this.leases.size >= this.limit() || !fitsProvider) return undefined;
    return this.lease({ kind: 'check', providerId, cancel, closing: false });
  }
  async viewer(signal?: AbortSignal, providerId?: string): Promise<ConnectionLease> {
    const limit = this.limit(), cap = providerId === undefined ? undefined : this.providerLimit(providerId);
    const held = [...this.leases], queued = this.waiters.length;
    const providerHeld = providerId === undefined ? 0 : held.filter(l => l.providerId === providerId).length;
    if (!queued && held.length < limit && (cap === undefined || providerHeld < cap)) return this.lease({ kind: 'viewer', providerId, closing: false });
    const watching = held.filter(l => l.kind === 'viewer' && !l.closing).length + queued;
    if (watching >= limit) throw new AppError('LIVE_CONNECTIONS_FULL', `Live TV allows ${limit} connection${limit === 1 ? '' : 's'} at a time and ${limit === 1 ? 'it is' : 'all are'} in use. Try again when someone stops watching.`, 503, true);
    const sameProviderQueued = this.waiters.filter(w => w.providerId === providerId).length;
    const providerViewers = providerId === undefined ? 0 : held.filter(l => l.kind === 'viewer' && !l.closing && l.providerId === providerId).length;
    if (cap !== undefined && providerViewers + sameProviderQueued >= cap) {
      throw new AppError('XTREAM_CONNECTIONS_FULL', `This provider allows ${cap} connection${cap === 1 ? '' : 's'} at a time and ${cap === 1 ? 'it is' : 'all are'} in use. Try again when someone stops watching.`, 503, true);
    }
    // Take back just enough connections from checks for this viewer and those queued ahead.
    let open = held.filter(l => !l.closing).length + queued + 1 - limit;
    let providerOpen = cap === undefined ? 0 : providerHeld + sameProviderQueued + 1 - cap;
    for (const lease of held) {
      if (open <= 0 && providerOpen <= 0) break;
      if (lease.kind !== 'check' || lease.closing) continue;
      const sameProvider = providerId !== undefined && lease.providerId === providerId;
      if (open <= 0 && !sameProvider) continue;
      lease.closing = true; lease.cancel?.();
      if (open > 0) open--;
      if (sameProvider) providerOpen--;
    }
    signal?.throwIfAborted();
    return new Promise<ConnectionLease>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiters = this.waiters.filter(w => w !== waiter); };
      const fail = (error: AppError) => { done(); reject(error); this.drain(); };
      const abort = () => fail(new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409));
      const timer = setTimeout(() => fail(new AppError('LIVE_CONNECTIONS_BUSY', 'A provider connection did not free up in time. Please try again.', 503, true)), this.waitMs);
      const waiter: Waiter = { providerId, grant: () => { done(); resolve(this.lease({ kind: 'viewer', providerId, closing: false })); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }
  private lease(lease: Lease): ConnectionLease {
    this.leases.add(lease);
    return {
      closing: () => { lease.closing = true; },
      release: () => { if (this.leases.delete(lease)) this.drain(); },
    };
  }
  private drain() {
    while (this.waiters.length) {
      const waiter = this.waiters[0]!, cap = waiter.providerId === undefined ? undefined : this.providerLimit(waiter.providerId);
      const fitsProvider = cap === undefined || [...this.leases].filter(l => l.providerId === waiter.providerId).length < cap;
      if (this.leases.size >= this.limit() || !fitsProvider) break;
      this.waiters.shift();
      waiter.grant();
    }
  }
}
