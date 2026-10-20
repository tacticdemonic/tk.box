# Authentication and credential model

Two kinds of secrets meet in tk.box, and they must never be conflated:

| Secret | Proves | Stored as | Used by |
| --- | --- | --- | --- |
| Application session | who is using tk.box | `sessions.hash` plus a sealed Plex token, or a sealed `xtream` marker | every viewer route |
| IPTV provider credentials | which subscription a stream comes from | `xtream_accounts.encrypted_credentials` | server-side provider calls only |

A provider account is a **resource**, not an identity. A provider login can *create* an
application identity (M02), but provider credentials themselves are never authentication
material for tk.box and never appear in a session, a browser URL or a log.

## Application identities

Two kinds of account share one session table:

| Account namespace | Created by | Re-authorised by |
| --- | --- | --- |
| Plex account id (numeric) | Plex PIN sign-in | `PlexAdapter.authorize` on every request |
| `local:xtream:<digest>` | `POST /api/v1/auth/xtream/login` | the local session row plus `xtream_identities.role` |

`IdentityService` (`apps/server/src/services/identity.ts`):

1. **Plex.** `POST /api/v1/auth/plex/start` creates a PIN and a short-lived binding cookie;
   `POST /api/v1/auth/plex/status` polls it, authorises, writes `users(account_id)`, a `sessions`
   row and a sealed Plex token. Every request re-authorises against Plex, so revoked Plex access
   fails closed. High-frequency media segments use the local `session()` check with periodic full
   re-authorisation.
2. **Xtream.** `POST /api/v1/auth/xtream/login` asks the panel to authenticate the credentials,
   derives a stable login key from origin + username, upserts an `xtream_identities` row and
   issues the same session cookie. No provider password is stored in the session; the session
   credential is a sealed marker.
3. **Authorisation.** `authenticateHash` branches on the account namespace: an
   `xtream_identities` row means a local role and a local session check, otherwise Plex is asked.
   Revocation is a session delete, `users.allowed = 0`, or removing the identity.
4. **Administrator role.** With Plex configured, `PLEX_OWNER_ACCOUNT_ID` remains the only
   administrator; a provider login is a viewer. On a Plex-less deployment the first provider
   identity bootstraps the administrator. `grant.role` is the single source of truth for admin
   checks.

Provider credentials sit behind `XtreamStore`:

- sealed with AES-256-GCM and a per-row context (`xtream:credentials:{id}`),
- decrypted only inside `XtreamClient` for one provider request,
- never returned by an API route, logged, or placed in a browser URL,
- validation failures persist only a stable error code.

## Provider access

`xtream_access` grants a provider account to an application account and is independent of who
created the provider row. Creating a provider grants its creator. Enforced per request:

- viewer routes answer 404 for a provider the caller cannot use,
- account mutation needs ownership or administrator,
- the IPTV guide, channel list, tuning and playback all scope visibility to the caller's grants,
- disabling a provider, revoking a grant or an expired/inactive subscription hides its channels
  and ends live sessions immediately.

Multiple providers per account are supported by granting several rows; one subscription can be
shared between accounts without duplicating credentials.

## Local accounts: what was and was not built

M02 implements Xtream-only users. It does **not** add password-based local accounts
(`local_credentials`, Argon2/scrypt, `npm run user:add`): a Plex-less deployment signs in through
its provider, which is the smallest architecture that satisfies the milestone. The schema keeps
`users.account_id` opaque, so a later local-password namespace remains additive.

## Threat model summary

| Threat | Control |
| --- | --- |
| Stolen database file | credentials, catalogues and tokens sealed with a 32-byte key stored separately (`SECRET_KEY_FILE` / data dir, mode 0600) |
| Credential leak through API or logs | no credential fields in DTOs; upstream errors mapped to codes; relay redacts URLs |
| SSRF via a malicious provider URL | pinned DNS, public-address allow-list, same-origin redirects, no proxy, bounded responses |
| Cross-user provider access | `xtream_access` checked on every provider, guide, tune and playlist request |
| Provider connection exhaustion | one in-flight catalogue operation per account; relays and checks share a per-provider lease |
| Provider login brute force | per-IP rate limit (10/min), generic failure message, panel-side lockout |
| Session theft | opaque HttpOnly cookie, hashed at rest, 12-hour expiry, CSRF origin check |

## First-user administrator bootstrap (M03)

On a Plex-less deployment the first provider identity becomes the administrator. That is safe
only on a private LAN. On a public origin any visitor could win the race, so:

- `INITIAL_ADMIN_TOKEN` (16–256 characters) is set by the operator. `loadConfig` refuses to
  start when `PUBLIC_BASE_URL` or `DEPLOYMENT_MODE=remote` is used without Plex configuration
  and without this token.
- The first Xtream login must send `bootstrapToken` matching it. The check happens before the
  provider panel is contacted and compares SHA-256 digests in constant time.
- Once an administrator exists the token is ignored; later logins are viewers, and the setup
  endpoint reports `bootstrapTokenRequired: false`.
- A local (`DEPLOYMENT_MODE=local`) Plex-less deployment keeps the zero-configuration flow.
