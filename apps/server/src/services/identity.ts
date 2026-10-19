import type { Db } from '../persistence/database.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import { Vault, opaque, digest } from '../security/vault.js';
import { normalizeXtreamEndpoint } from '../providers/xtream.js';
import { requireThat } from '../errors.js';

export class IdentityService {
  private authorizing = new Map<string,Promise<PlexGrant>>();
  constructor(private db: Db, private vault: Vault, private plex: PlexAdapter) {}
  // An application session that proves a provider login for accounts without Plex. The
  // session row keeps a sealed marker rather than any upstream credential.
  private issueSession(accountId: string, now: number) {
    const cookie = opaque(), hash = digest(cookie), expires = now + 12 * 60 * 60 * 1000;
    const user = this.db.prepare('SELECT allowed FROM users WHERE account_id=?').get(accountId) as {allowed: number};
    requireThat(user.allowed, 'ACCESS_DENIED', 'Account access is disabled.', 403);
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash, accountId, this.vault.seal('xtream', hash), expires);
    return { cookie, hash, accountId, expires };
  }
  // Xtream-only sign-in: the application account is derived from the provider origin and
  // username, so the same subscription always resumes the same local identity. A provider
  // password never becomes an application credential and is never stored in a session.
  async xtreamLogin(input: {serverUrl: string; username: string; password: string; allowInsecureHttp?: boolean}, authenticate: () => Promise<unknown>, bootstrapAdmin = false, now = Date.now()) {
    const account = await authenticate();
    const origin = normalizeXtreamEndpoint(input).serverUrl;
    const loginKey = digest(JSON.stringify([origin, input.username]));
    const existing = this.db.prepare('SELECT account_id,role FROM xtream_identities WHERE login_key=?').get(loginKey) as {account_id: string; role: 'admin'|'viewer'}|undefined;
    const accountId = existing?.account_id ?? `local:xtream:${loginKey}`;
    // On a deployment with no Plex owner, the first identity bootstraps the administrator; every
    // later identity is a viewer unless an administrator promotes it. With Plex configured there
    // is already an administrator, so a provider login never grants that role.
    const admin = existing ? existing.role === 'admin' : bootstrapAdmin && !this.db.prepare('SELECT 1 FROM xtream_identities').get();
    // The identity row must exist before a session is issued, or authentication would fall
    // through to Plex; both writes are idempotent for a repeated login.
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO users(account_id) VALUES(?)').run(accountId);
      this.db.prepare('INSERT INTO xtream_identities(account_id,login_key,role,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET login_key=excluded.login_key,updated_at=excluded.updated_at')
        .run(accountId, loginKey, admin ? 'admin' : 'viewer', now, now);
    })();
    const session = this.issueSession(accountId, now);
    return { ...session, role: admin ? 'admin' as const : 'viewer' as const, xtream: account };
  }
  // The role of a non-Plex application account, from its own table.
  localRole(accountId: string) { return (this.db.prepare('SELECT role FROM xtream_identities WHERE account_id=?').get(accountId) as {role:'admin'|'viewer'}|undefined)?.role; }
  async start(now = Date.now()) {
    const count = this.db.prepare('SELECT count(*) AS n FROM auth_challenges WHERE expires>?').get(now) as {n: number};
    requireThat(count.n < 100, 'LOGIN_LIMIT', 'Too many pending sign-ins.', 429);
    const pin = await this.plex.createPin(), binding = opaque();
    this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);
    this.db.prepare('INSERT INTO auth_challenges(hash,pin_id,code,expires) VALUES(?,?,?,?)').run(digest(binding), pin.id, pin.code, now + Math.min(pin.expiresIn * 1000, 600000));
    return { binding, authUrl: this.plex.authUrl(pin.code) };
  }
  async finish(binding: string, now = Date.now()) {
    const hash = digest(binding);
    const challenge = this.db.prepare('SELECT * FROM auth_challenges WHERE hash=? AND expires>?').get(hash, now) as {pin_id: number; code: string; last_poll: number} | undefined;
    requireThat(challenge, 'AUTH_EXPIRED', 'Plex sign-in expired. Start again.', 401);
    requireThat(now - challenge.last_poll >= 2000, 'POLL_TOO_FAST', 'Wait before polling again.', 429);
    this.db.prepare('UPDATE auth_challenges SET last_poll=? WHERE hash=?').run(now, hash);
    const accountToken = await this.plex.pollPin(challenge.pin_id, challenge.code);
    if (!accountToken) return undefined;
    const grant = await this.plex.authorize(accountToken);
    const cookie = opaque(), sessionHash = digest(cookie), expires = now + 12 * 60 * 60 * 1000;
    this.db.transaction(() => {
      const claimed = this.db.prepare('DELETE FROM auth_challenges WHERE hash=?').run(hash);
      requireThat(claimed.changes === 1, 'AUTH_EXPIRED', 'Sign-in challenge was already consumed.', 401);
      this.db.prepare('INSERT OR IGNORE INTO users(account_id) VALUES(?)').run(grant.accountId);
      const user = this.db.prepare('SELECT allowed FROM users WHERE account_id=?').get(grant.accountId) as {allowed: number};
      requireThat(user.allowed, 'ACCESS_DENIED', 'Account access is disabled.', 403);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sessionHash, grant.accountId, this.vault.seal(accountToken, sessionHash), expires);
    })();
    return { cookie, grant };
  }
  async authenticate(cookie: string | undefined, now = Date.now()) {
    requireThat(cookie, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
    return this.authenticateHash(digest(cookie), now);
  }
  // Local-only session check for high-frequency media segments. Callers must
  // pair it with periodic full Plex reauthorization (authenticateHash).
  session(cookie: string | undefined, now = Date.now()) {
    requireThat(cookie, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
    const hash = digest(cookie);
    const row = this.db.prepare('SELECT u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash, now) as {allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    return hash;
  }
  async authenticateHash(hash: string, now = Date.now()) {
    const row = this.db.prepare('SELECT s.*,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE hash=? AND expires>?').get(hash, now) as {account_id: string; encrypted_credential: string; allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    // A provider-backed identity has no Plex token to re-check. Its session and role are local,
    // so revocation is a session delete or a disabled access row, which the queries below honour.
    const role = this.localRole(row.account_id);
    if (role !== undefined) {
      const current = this.db.prepare('SELECT s.account_id,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash, now) as {account_id: string; allowed: number}|undefined;
      requireThat(current?.allowed && current.account_id === row.account_id, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
      return { hash, grant: { accountId: row.account_id, role, serverToken: '', libraries: [] } };
    }
    // Coalesce only overlapping checks (e.g. a grid of artwork requests), with
    // no successful-grant TTL. Every later request still checks Plex again.
    let pending=this.authorizing.get(hash);
    if(!pending){pending=this.plex.authorize(this.vault.open(row.encrypted_credential,hash)).finally(()=>this.authorizing.delete(hash));this.authorizing.set(hash,pending);}
    const grant=await pending;
    const current=this.db.prepare('SELECT s.account_id,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash,now) as {account_id:string;allowed:number}|undefined;
    requireThat(current?.allowed&&current.account_id===row.account_id,'UNAUTHENTICATED','Session expired or revoked.',401);
    requireThat(grant.accountId === row.account_id, 'ACCESS_DENIED', 'Plex account identity changed.', 403);
    return { hash, grant };
  }
  // A current administrator grant for background work, from the newest session of the given accounts that Plex still
  // authorizes as an administrator. Undefined when no administrator is signed in.
  async adminGrant(accountIds: string[], now = Date.now()) {
    if (!accountIds.length) return undefined;
    const rows = this.db.prepare(`SELECT hash FROM sessions WHERE account_id IN (${accountIds.map(() => '?').join(',')}) AND expires>? ORDER BY expires DESC LIMIT 3`).all(...accountIds, now) as {hash: string}[];
    for (const {hash} of rows) {
      const grant = await this.authenticateHash(hash, now).then(r => r.grant, () => undefined);
      if (grant?.role === 'admin') return grant;
    }
    return undefined;
  }
  // An administrator session for background work: any live administrator session, local or Plex.
  async anyAdmin(now = Date.now()) {
    const rows = this.db.prepare('SELECT hash FROM sessions WHERE expires>? ORDER BY expires DESC LIMIT 5').all(now) as {hash: string}[];
    for (const {hash} of rows) {
      const grant = await this.authenticateHash(hash, now).then(r => r.grant, () => undefined);
      if (grant?.role === 'admin') return grant;
    }
    return undefined;
  }
  logout(cookie?: string) { if (cookie) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(cookie)); }
  reap(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM playback_sessions WHERE expires<=?').run(now);
  }
}
