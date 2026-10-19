import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './database.js';
import { Vault, digest } from '../security/vault.js';
import { requireThat } from '../errors.js';
import { normalizeXtreamEndpoint, xtreamCredentials, type XtreamAccount, type XtreamCatalogue } from '../providers/xtream.js';

type AccountRow = {
  id: string; name: string; server_origin: string; revision: number; encrypted_credentials: string;
  encrypted_catalogue: string | null; catalogue_at: number | null; catalogue_channels: number | null;
  account_status: string | null; expires_at: number | null; max_connections: number | null;
  active_connections: number | null; is_trial: number | null; owner_account_id: string | null; login_key: string | null;
  last_validated: number | null; last_error: string | null; enabled: number; created_at: number; updated_at: number;
};

export const xtreamAccountCreate = z.object({ name: z.string().trim().min(1).max(120), credentials: xtreamCredentials }).strict();
export const xtreamAccountUpdate = z.object({
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  credentials: xtreamCredentials.optional()
}).strict().refine(value => value.name !== undefined || value.enabled !== undefined || value.credentials !== undefined, 'Nothing to update.');
// Application account IDs are Plex account IDs (numeric strings today), not UUIDs.
export const xtreamAccess = z.object({ accountIds: z.array(z.string().trim().min(1).max(64)).max(200) }).strict();
const MAX_ACCOUNTS = 32;

// Provider accounts are deliberately separate from application users: an Xtream subscription
// is a resource this server reads, not an identity it signs people in with.
export class XtreamStore {
  // Told when a provider account is disabled, removed or re-keyed, so its live relays end.
  onChange: (id: string) => void = () => {};
  constructor(private db: Db, private vault: Vault) {}
  private row(id: string) {
    const row = this.db.prepare('SELECT * FROM xtream_accounts WHERE id=?').get(id) as AccountRow | undefined;
    requireThat(row, 'XTREAM_ACCOUNT_NOT_FOUND', 'Xtream account not found.', 404);
    return row;
  }
  private audit(actor: string, event: string, id: string, now: number) {
    this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, event, now, JSON.stringify({ id }));
  }
  private statusOf(row: AccountRow) {
    return {
      id: row.id, name: row.name, serverOrigin: row.server_origin, revision: row.revision, enabled: !!row.enabled,
      lastValidated: row.last_validated, lastError: row.last_error, catalogueAt: row.catalogue_at,
      catalogueChannels: row.catalogue_channels, accountStatus: row.account_status, expiresAt: row.expires_at,
      maxConnections: row.max_connections, activeConnections: row.active_connections, isTrial: !!row.is_trial,
      ownerAccountId: row.owner_account_id, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }
  // Never includes the credentials, the username or a stream address.
  list() { return (this.db.prepare('SELECT * FROM xtream_accounts ORDER BY created_at,rowid').all() as AccountRow[]).map(row => this.statusOf(row)); }
  status(id: string) { return this.statusOf(this.row(id)); }
  create(actor: string, input: z.input<typeof xtreamAccountCreate>, now = Date.now()) {
    const value = xtreamAccountCreate.parse(input), id = randomUUID();
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM xtream_accounts').get() as { n: number };
    requireThat(count.n < MAX_ACCOUNTS, 'XTREAM_ACCOUNT_LIMIT', 'Too many Xtream accounts are configured.', 409);
    const endpoint = normalizeXtreamEndpoint(value.credentials);
    const sealed = this.vault.seal(JSON.stringify({ ...value.credentials, serverUrl: endpoint.serverUrl }), `xtream:credentials:${id}`);
    // The owner is the application account that added the provider, when it is a real user.
    const owner = this.db.prepare('SELECT 1 FROM users WHERE account_id=?').get(actor) ? actor : null;
    const loginKey = digest(JSON.stringify([endpoint.serverUrl, value.credentials.username]));
    requireThat(!this.db.prepare('SELECT 1 FROM xtream_accounts WHERE login_key=?').get(loginKey), 'XTREAM_ACCOUNT_EXISTS', 'This provider subscription is already connected. Sign in with it or edit the existing account.', 409);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO xtream_accounts(id,name,server_origin,revision,encrypted_credentials,owner_account_id,login_key,created_at,updated_at)
        VALUES(?,?,?,0,?,?,?,?,?)`).run(id, value.name, endpoint.serverUrl, sealed, owner, loginKey, now, now);
      // The creator can use what it added; access grants are also how viewers reach a provider.
      if (owner) this.db.prepare('INSERT OR IGNORE INTO xtream_access VALUES(?,?)').run(id, owner);
      this.audit(actor, 'xtream_account_created', id, now);
    })();
    return this.status(id);
  }
  update(actor: string, id: string, input: z.input<typeof xtreamAccountUpdate>, now = Date.now()) {
    const value = xtreamAccountUpdate.parse(input);
    return this.db.transaction(() => {
      const row = this.row(id);
      requireThat(row.revision === value.expectedRevision, 'REVISION_CONFLICT', 'Xtream account changed. Reload and retry.', 409);
      let serverOrigin = row.server_origin, credentials = row.encrypted_credentials, reset = '', loginKey: string | null = null;
      if (value.credentials) {
        const endpoint = normalizeXtreamEndpoint(value.credentials);
        serverOrigin = endpoint.serverUrl;
        credentials = this.vault.seal(JSON.stringify({ ...value.credentials, serverUrl: endpoint.serverUrl }), `xtream:credentials:${id}`);
        loginKey = digest(JSON.stringify([endpoint.serverUrl, value.credentials.username]));
        // A new address or password invalidates every stored result from the old one.
        reset = ',encrypted_catalogue=NULL,catalogue_at=NULL,catalogue_channels=NULL,account_status=NULL,expires_at=NULL,max_connections=NULL,active_connections=NULL,is_trial=NULL,last_validated=NULL,last_error=NULL';
        // Channels from the old subscription must not stay viewable under the new one.
        this.db.prepare(`UPDATE iptv_sources SET revision=revision+1,encrypted_snapshot=NULL,encrypted_guide=NULL,last_error='XTREAM_CREDENTIALS_CHANGED' WHERE xtream_account_id=?`).run(id);
        this.db.prepare('UPDATE iptv_channels SET present=0,missing_since=? WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(now, id);
      }
      this.db.prepare(`UPDATE xtream_accounts SET name=?,enabled=?,server_origin=?,encrypted_credentials=?,revision=revision+1,updated_at=?${loginKey ? ',login_key=?' : ''}${reset} WHERE id=?`)
        .run(value.name ?? row.name, Number(value.enabled ?? !!row.enabled), serverOrigin, credentials, now, ...(loginKey ? [loginKey] : []), id);
      if (value.credentials || value.enabled === false) this.onChange(id);
      this.audit(actor, 'xtream_account_updated', id, now);
      return this.status(id);
    })();
  }
  remove(actor: string, id: string, expectedRevision: number, now = Date.now()) {
    return this.db.transaction(() => {
      requireThat(this.row(id).revision === expectedRevision, 'REVISION_CONFLICT', 'Xtream account changed. Reload and retry.', 409);
      // Channels, guide and curation for this provider belong to the account being removed.
      this.db.prepare('DELETE FROM iptv_guide_coverage WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_channel_health WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_offline_slates WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_health_policies WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_listing_policies WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_groups WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM sports_windows WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM sports_admitted WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM sports_policies WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_favorites WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_mappings WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM lineup_numbers WHERE channel_id IN (SELECT c.id FROM iptv_channels c JOIN iptv_sources s ON s.id=c.source_id WHERE s.xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_channels WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_source_feeds WHERE source_id IN (SELECT id FROM iptv_sources WHERE xtream_account_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_sources WHERE xtream_account_id=?').run(id);
      this.db.prepare('DELETE FROM xtream_access WHERE xtream_id=?').run(id);
      this.db.prepare('DELETE FROM xtream_accounts WHERE id=?').run(id);
      this.onChange(id);
      this.audit(actor, 'xtream_account_removed', id, now);
      return { status: 'removed' as const, id };
    })();
  }
  // Server-side only. The password is decrypted here and handed to the adapter for one request.
  credentials(id: string): z.infer<typeof xtreamCredentials> {
    const row = this.row(id);
    return xtreamCredentials.parse(JSON.parse(this.vault.open(row.encrypted_credentials, `xtream:credentials:${id}`)));
  }
  // A repeated sign-in with the same subscription must not clear the catalogue or stop relays.
  credentialsMatch(id: string, input: z.input<typeof xtreamCredentials>) {
    const current = this.credentials(id);
    return current.serverUrl === normalizeXtreamEndpoint(input).serverUrl && current.username === input.username && current.password === input.password && current.allowInsecureHttp === input.allowInsecureHttp;
  }
  // Validation results are provider metadata, not configuration: no revision bump.
  validated(id: string, account: XtreamAccount | null, error: string | null, now = Date.now()) {
    this.row(id);
    this.db.prepare('UPDATE xtream_accounts SET last_validated=?,last_error=?,account_status=?,expires_at=?,max_connections=?,active_connections=?,is_trial=? WHERE id=?')
      .run(now, error, account?.status ?? null, account?.expiresAt ?? null, account?.maxConnections ?? null, account?.activeConnections ?? null, account ? Number(account.isTrial) : null, id);
    return this.status(id);
  }
  // A failed refresh keeps the last good catalogue; an expiry or disabled panel also marks the
  // account inactive so its channels stop being listed and playback is refused.
  refreshFailed(id: string, error: string, now = Date.now()) {
    this.row(id);
    const inactive = error === 'XTREAM_ACCOUNT_EXPIRED' || error === 'XTREAM_ACCOUNT_INACTIVE';
    this.db.prepare('UPDATE xtream_accounts SET last_error=?,last_validated=?,account_status=COALESCE(?,account_status) WHERE id=?')
      .run(error, now, inactive ? 'inactive' : null, id);
    if (inactive) this.onChange(id);
    return this.status(id);
  }
  saveCatalogue(actor: string, id: string, catalogue: XtreamCatalogue, now = Date.now()) {
    const row = this.row(id);
    this.db.prepare('UPDATE xtream_accounts SET encrypted_catalogue=?,catalogue_at=?,catalogue_channels=?,updated_at=? WHERE id=?')
      .run(this.vault.seal(JSON.stringify(catalogue), `xtream:catalogue:${id}`), catalogue.fetchedAt, catalogue.channels.length, now, id);
    this.audit(actor, 'xtream_catalogue_refreshed', id, now);
    return this.status(id);
  }
  catalogue(id: string): XtreamCatalogue | undefined {
    const row = this.row(id);
    return row.encrypted_catalogue ? JSON.parse(this.vault.open(row.encrypted_catalogue, `xtream:catalogue:${id}`)) as XtreamCatalogue : undefined;
  }
  // Which application accounts may use a provider account. The caller is always an administrator.
  setAccess(actor: string, id: string, accountIds: string[], now = Date.now()) {
    const value = xtreamAccess.parse({ accountIds });
    return this.db.transaction(() => {
      this.row(id);
      const unique = [...new Set(value.accountIds)];
      for (const accountId of unique) requireThat(this.db.prepare('SELECT 1 FROM users WHERE account_id=?').get(accountId), 'XTREAM_ACCESS_UNKNOWN_USER', 'One of the selected accounts does not exist.', 400);
      this.db.prepare('DELETE FROM xtream_access WHERE xtream_id=?').run(id);
      const put = this.db.prepare('INSERT INTO xtream_access VALUES(?,?)');
      for (const accountId of unique) put.run(id, accountId);
      this.audit(actor, 'xtream_access_changed', id, now);
      return { xtreamId: id, accountIds: unique };
    })();
  }
  access(id: string) { this.row(id); return (this.db.prepare('SELECT account_id FROM xtream_access WHERE xtream_id=? ORDER BY account_id').all(id) as { account_id: string }[]).map(row => row.account_id); }
  // The provider row for an origin and username, so a viewer logging in with the same
  // subscription resumes one provider account rather than creating duplicates.
  findByLogin(serverUrl: string, username: string) {
    const key = digest(JSON.stringify([normalizeXtreamEndpoint({serverUrl}).serverUrl, username]));
    const row = this.db.prepare('SELECT * FROM xtream_accounts WHERE login_key=? ORDER BY created_at,rowid LIMIT 1').get(key) as AccountRow | undefined;
    return row ? this.statusOf(row) : undefined;
  }
  // The creator of a provider keeps ownership, but any granted account can use it.
  isOwner(accountId: string, id: string) { return this.row(id).owner_account_id === accountId; }
  grant(actor: string, id: string) {
    this.row(id);
    this.db.prepare('INSERT OR IGNORE INTO xtream_access VALUES(?,?)').run(id, actor);
  }
  // Per-user authorisation for the viewer-facing catalogue and playback routes. A disabled or
  // expired provider fails closed, so a lapsed subscription never keeps serving channels.
  canUse(accountId: string, xtreamId: string) {
    return !!this.db.prepare(`SELECT 1 FROM xtream_access x JOIN xtream_accounts a ON a.id=x.xtream_id
      WHERE x.xtream_id=? AND x.account_id=? AND a.enabled=1 AND (a.account_status IS NULL OR a.account_status='active') AND (a.expires_at IS NULL OR a.expires_at>?)`).get(xtreamId, accountId, Date.now());
  }
  // Every provider account granted to an application account, for its own management page.
  granted(accountId: string) {
    return (this.db.prepare(`SELECT a.* FROM xtream_accounts a JOIN xtream_access x ON x.xtream_id=a.id WHERE x.account_id=? ORDER BY a.created_at,a.rowid`).all(accountId) as AccountRow[]).map(row => this.statusOf(row));
  }
  // The provider account behind an IPTV source, for its own per-provider connection budget.
  limit(accountId: string) {
    const row = this.db.prepare('SELECT max_connections,enabled,account_status,expires_at FROM xtream_accounts WHERE id=?').get(accountId) as {max_connections:number|null;enabled:number;account_status:string|null;expires_at:number|null}|undefined;
    if (!row || !row.enabled || (row.account_status !== null && row.account_status !== 'active') || (row.expires_at !== null && row.expires_at <= Date.now())) return 0;
    return row.max_connections ?? undefined;
  }
  ownerAccountId(id: string) { return this.row(id).owner_account_id ?? undefined; }
}
