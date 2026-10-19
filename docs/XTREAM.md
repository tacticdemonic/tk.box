# Xtream Codes integration (M01)

Status: **foundation implemented and tested**, not yet wired into playback or the viewer UI.
Milestone M01 delivers an isolated provider adapter, sealed credential storage, an
administrator API and synthetic-fixture tests. It deliberately does not require a live
IPTV subscription.

## Why an adapter instead of a new source type yet

The existing IPTV pipeline is built around two source kinds:

- `m3u` — channels, groups, logos and stream addresses (`parseM3u`).
- `xmltv` — guide channels and programmes (`parseXmltv`).

`iptv_sources.kind` has `CHECK(kind IN ('m3u','xmltv'))`, and `IptvStore` assumes that
shape throughout reconciliation, listing rules, guide mapping and numbering. Adding a
third kind in M01 would mean a table rebuild plus changes to a large, well-tested store
before a single Xtream response had been proven.

Instead, M01 adds an independent adapter that produces exactly the same shapes the
existing pipeline already consumes:

```
Xtream panel ──player_api.php──▶ XtreamClient ──▶ XtreamCatalogue
                xmltv.php                         ├─ categories
                                                  ├─ channels: M3uChannel-like
                                                  │  (streamUrl includes provider creds)
                                                  └─ epg: XmlSnapshot
```

M02 maps that catalogue into the existing source/channel/guide tables (see
[`MILESTONES.md`](MILESTONES.md)), at which point the FFmpeg relay, health checks,
listing rules, favourites and guide UI work unchanged.

## Data model

Fork migration `1001` adds two tables. Nothing in the existing M3U/XMLTV tables changed.
Fork migrations use the `1000+` range, leaving `1..999` to upstream so a future upstream
migration cannot collide with ours when `upstream/main` is merged.

| Table | Purpose |
| --- | --- |
| `xtream_accounts` | One row per provider account: display name, public `server_origin`, revision, sealed credentials, sealed catalogue, validation metadata (`last_validated`, `last_error`, `account_status`, `expires_at`, `max_connections`), `enabled`. |
| `xtream_access` | `(xtream_id, account_id)` grants: which application account may use which provider account. Per-user authorisation, independent of who created the provider row. |

Provider accounts are **not** application users. See [`AUTH_MODEL.md`](AUTH_MODEL.md).

## Adapter

`apps/server/src/providers/xtream.ts`

- `xtreamCredentials` — server address, username, password, optional `allowInsecureHttp`.
- `normalizeXtreamEndpoint` — normalises the origin/path; rejects embedded userinfo,
  query strings, fragments, non-HTTP(S) schemes, plain HTTP unless explicitly allowed,
  and addresses that already point at `player_api.php`, `panel_api.php`, `get.php` or
  `xmltv.php`.
- `XtreamClient` — authenticated `player_api.php` access with an injectable transport
  (production: `RestrictedSourceFetcher`; tests: synthetic buffers).
  - `authenticate()` → sanitised `XtreamAccount`
  - `liveCategories()` / `liveStreams(categoryId?)`
  - `epg()` → existing `parseXmltv`
  - `vodCategories()` / `vodStreams()` / `series()` / `seriesInfo()` — typed entry points
    for the later catalogue milestone; not surfaced yet
  - `catalogue({includeEpg})` → `XtreamCatalogue`
- `parseLiveCategories`, `parseLiveStreams`, `buildLiveSnapshot`, `cataloguePage` — pure
  functions with synthetic tests.

Endpoints used:

| Call | Purpose |
| --- | --- |
| `GET /player_api.php?username=&password=` | account validation (`user_info.auth`, `status`, `exp_date`, limits) |
| `GET /player_api.php?...&action=get_live_categories` | Live TV categories |
| `GET /player_api.php?...&action=get_live_streams[&category_id=]` | Live channels |
| `GET /xmltv.php?username=&password=` | provider EPG (gzip or plain XML) |
| `GET /player_api.php?...&action=get_vod_*`, `get_series*` | reserved for M03 |

Live stream address built server-side:
`{server}/live/{username}/{password}/{stream_id}.{ts|m3u8}`. It is stored inside the
sealed catalogue and never returned by an API route — the same rule the existing
`IptvStore.tune()` follows for M3U stream URLs.

### Normalisation rules

- IDs must be positive integers (`"101"` and `101` both accepted); invalid rows are
  skipped and counted in `ignoredStreams` rather than failing the whole catalogue.
- Names and categories: control characters replaced, whitespace collapsed, trimmed,
  bounded (200 chars for names, 128 for EPG IDs, 2048 for logos).
- Logos must be `http(s)` with no embedded userinfo; `javascript:`, `data:` and malformed
  values are dropped.
- Live containers: `m3u8` is preserved, anything else falls back to `ts`. No other
  container is relayed as live TV.
- Duplicate stream IDs keep the first occurrence.
- Catalogue size is capped at 20,000 live channels, matching the existing import limit.

## Administrator API

All routes require an application administrator and the normal CSRF/content-type rules.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/admin/xtream/accounts` | list accounts (no credentials, no stream URLs) |
| `GET` | `/api/v1/admin/xtream/accounts/:id` | one account's status |
| `POST` | `/api/v1/admin/xtream/accounts` | create; body `{name, credentials, validate?}`. A failed validation keeps the row so the address can be corrected |
| `PATCH` | `/api/v1/admin/xtream/accounts/:id` | rename, enable/disable or replace credentials; new credentials clear the old validation and catalogue |
| `DELETE` | `/api/v1/admin/xtream/accounts/:id` | body `{expectedRevision}`; cascades access grants |
| `POST` | `/api/v1/admin/xtream/accounts/:id/validate` | re-run `player_api.php` account validation |
| `POST` | `/api/v1/admin/xtream/accounts/:id/refresh` | fetch categories + live channels (+ optional EPG) and store the catalogue |
| `GET` | `/api/v1/admin/xtream/accounts/:id/catalogue` | paged, URL-free catalogue (`offset`, `limit`, `categoryId`, `q`) |
| `GET/PUT` | `/api/v1/admin/xtream/accounts/:id/access` | per-application-account grants |

Example (administrator session cookie required):

```sh
curl -sS -X POST http://127.0.0.1:3000/api/v1/admin/xtream/accounts \
  -H "Origin: http://127.0.0.1:3000" -H 'Content-Type: application/json' \
  -b 'tk.box_local=<session>' \
  -d '{"name":"Primary","credentials":{"serverUrl":"https://provider.example:8443","username":"u","password":"p"},"validate":true}'
```

## Security properties

- **Encryption at rest** — credentials and catalogues use `Vault` (AES-256-GCM) with
  context strings `xtream:credentials:{id}` and `xtream:catalogue:{id}`. Moving a
  ciphertext to another row fails authentication.
- **No credential exposure** — responses contain neither username, password nor stream
  URL. Errors are mapped to stable codes; upstream exception text is discarded because
  it can quote the request URL. Validation status is stored as a code only.
- **SSRF** — every request goes through `RestrictedSourceFetcher`: DNS is resolved once
  and pinned, private/loopback/link-local/documentation ranges are rejected, redirects
  must stay on the approved origin, TLS verification is not relaxed, responses are
  bounded to 16 MB and 30 s.
- **Rate limits and provider limits** — one in-flight operation per provider account and
  at most four server-wide (`XTREAM_CAPACITY`). `max_connections` is recorded from
  `user_info` and will gate playback in M02 through the existing `ProviderConnections`
  lease, so viewers and health checks share one budget.
- **Authorisation** — every route is admin-only in M01. `xtream_access` and
  `XtreamStore.canUse()` are implemented and tested for the viewer routes that follow.
- **Scope** — only documented provider APIs are used. No DRM circumvention, no panel
  scraping, no access-control bypass.

## Compatibility and risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Real panels vary in `player_api.php` output | validation may reject an unusual but valid panel | tolerant parsers, fail-closed auth, fixtures modelled on the documented shape; M02 pilots a real panel |
| Plain-HTTP panels | rejected by default | explicit `allowInsecureHttp` per account; SSRF guard still applies |
| Provider is on a private LAN address | `RestrictedSourceFetcher` rejects private ranges | not supported in M01. A deliberate, per-account private-network opt-in is an M02 decision; do not weaken the shared fetcher |
| Stream URLs embed credentials | leak through logs/UI | server-only, sealed at rest, never serialised; relay already redacts URLs |
| Panel connection limits | failed tunes during refresh/playback | one catalogue fetch at a time; playback will reuse `ProviderConnections` |
| `iptv_sources.kind` check constraint | blocks a third source kind | M02 migration; M01 keeps tables untouched |
| Upstream refactors `IptvStore` | merge conflicts in M02 wiring | adapter is isolated; only `app.ts` gained a few lines in M01 |

## Tests

`tests/xtream.test.ts` (9 tests) uses a synthetic transport, no network:

- endpoint rejection: userinfo, HTTP by default, fragments, pre-built endpoints
- account validation: success, `auth=0`, inactive, expired, HTML, non-JSON, missing
  `auth`, transport failure — asserting no credential appears in results or messages
- category/channel parsing and sanitisation, duplicate and malformed row handling
- live URL construction and URL-free catalogue paging/filtering
- catalogue assembly including EPG, and EPG failure not discarding live channels
- sealed storage, context binding, multiple accounts, access grants, revision conflicts
- service validation-state recording and admin API end-to-end (401 without a session,
  201 create, refresh, catalogue without `/live/`, access grant, delete)
