# Authentication and credential model

Two kinds of secrets meet in tk.box, and they must never be conflated:

| Secret | Proves | Stored as | Used by |
| --- | --- | --- | --- |
| Application session | who is using tk.box | `sessions.hash` + sealed Plex token | every viewer route |
| IPTV provider credentials | which subscription a stream comes from | `xtream_accounts.encrypted_credentials` | server-side provider calls only |

A provider account is a **resource**, not an identity. Adding, validating or refreshing an
Xtream account does not create or sign in an application user, and a provider username is
never accepted as a login.

## Current application identity (unchanged)

`IdentityService` (`apps/server/src/services/identity.ts`):

1. `POST /api/v1/auth/plex/start` creates a Plex PIN and a short-lived binding cookie.
2. `POST /api/v1/auth/plex/status` polls the PIN, calls `PlexAdapter.authorize()` and
   writes `users(account_id)`, a `sessions` row and a sealed Plex token.
3. Every request re-authorises against Plex (`authenticateHash`), so revoked Plex access
   fails closed. High-frequency media segments use the local `session()` check plus
   periodic full re-authorisation.
4. Administrator role comes from `PLEX_OWNER_ACCOUNT_ID`; it is not derived from a
   provider subscription.

Provider credentials sit behind `XtreamStore`:

- sealed with AES-256-GCM and a per-row context (`xtream:credentials:{id}`)
- decrypted only inside `XtreamService` for one provider request
- never returned by an API route, never logged, never placed in a browser URL
- validation failures persist only a stable error code

`xtream_access` grants a provider account to an application account. It is independent of
who created the provider row and is enforced by `XtreamStore.canUse(accountId, xtreamId)`.
M01 exposes only the administrator configuration API; viewer routes in M02 must call
`canUse` before reading a catalogue or starting playback.

## Xtream-only users (M02)

The goal is an account that can watch IPTV without owning a Plex server. The smallest
change that preserves today's session model:

1. **Same session table, new identity namespace.** Add application accounts with IDs
   prefixed `local:` (for example `local:9f2c…`). `users.account_id` is already a text
   primary key; `sessions`, `iptv_favorites`, `custom_favorites` and `xtream_access`
   already reference it. No session code changes.
2. **Local credential table.** `local_credentials(account_id PRIMARY KEY REFERENCES
   users(account_id), password_hash TEXT, created_at, updated_at, disabled)`, hashed with
   Argon2id (or scrypt from Node's `crypto` if avoiding a new dependency). Never reversible,
   never logged.
3. **Login route.** `POST /api/v1/auth/local/login` with the same rate limits, timing-safe
   comparison and generic failure message as Plex sign-in. It inserts the same session row
   shape (`encrypted_credential` can hold an empty sealed marker) so `authenticate()` keeps
   one code path.
4. **No Plex requirement.** `grant.libraries` is empty, `role` is `viewer` unless the
   account is explicitly an administrator. Catalogue and playback routes only touch Plex
   when a Plex-backed feature is requested; IPTV routes already do not.
5. **Bootstrap.** The first administrator is created by a CLI (`npm run user:add`) that
   writes the hash locally; there is no public sign-up and no email requirement.
6. **Plex optional.** A local account may later link a Plex account, but that is an
   explicit action, not a prerequisite.

Until that exists, an Xtream-only deployment is not supported: `buildApp` still requires a
Plex adapter for authentication and `PLEX_*` configuration for the owner. M01 documents the
model and keeps provider data separate so the later change is additive.

### Compatibility notes

- `users.account_id` values are opaque strings everywhere in the schema; only config
  (`PLEX_OWNER_ACCOUNT_ID`) assumes digits.
- Sessions are authorised through `IdentityService.authenticateHash`, which currently calls
  Plex unconditionally. M02 must branch on the account namespace (`local:` → local
  session check, otherwise Plex) while keeping revocation and the 12-hour expiry.
- Administrator checks must not assume a Plex grant shape: `grant.role` becomes the single
  source of truth.
- Provider credentials remain per-provider, not per-user. Two application users can share
  one subscription through `xtream_access`; per-user provider logins are unnecessary and
  would multiply connection use.

## Threat model summary

| Threat | Control |
| --- | --- |
| Stolen database file | credentials and tokens sealed with a 32-byte key stored separately (`SECRET_KEY_FILE` / data dir, mode 0600) |
| Credential leak through API or logs | no credential fields in DTOs; upstream errors mapped to codes; relay redacts URLs |
| SSRF via a malicious provider URL | pinned DNS, public-address allow-list, same-origin redirects, no proxy, bounded responses |
| Cross-user provider access | `xtream_access` grants checked per request in M02; admin-only today |
| Provider connection exhaustion | one in-flight catalogue operation per account; playback leases shared through `ProviderConnections` |
| Brute-force local login (M02) | per-IP rate limit, Argon2id, generic errors, no account enumeration |
