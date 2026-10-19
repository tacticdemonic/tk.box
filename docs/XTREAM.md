# Xtream Codes integration (M01 foundation, M02 Live TV)

Status: **M02 implemented.** Xtream provider accounts, Xtream-only application sign-in, Live TV
channel import, EPG, playback and per-provider connection limits are wired into the existing
guide, favourites, streaming and health paths. Verified against synthetic panels and a local
MPEG-TS relay; no real provider subscription has been tested.

## The shape of the integration

Xtream is not a parallel pipeline. A refresh writes through the same tables the M3U path uses:

```
Xtream panel ──player_api.php──▶ XtreamClient ──▶ XtreamCatalogue
                 xmltv.php /                      │
                 get_short_epg                    ▼
                                    xtream_accounts (sealed credentials + catalogue)
                                                  │
                                    iptv_sources  (kind='xtream', one per account)
                                                  │
                          iptv_channels · lineup_numbers · iptv_favorites
                                                  │
                                    iptv_sources.encrypted_guide (XMLTV snapshot)
                                                  │
                              guide · tuning · LiveTv relay · ChannelHealth
```

Consequences, all intentional:

- The existing guide, favourites, listing rules, numbering, sports matching, health checks and
  FFmpeg relay work on Xtream channels unchanged.
- `IptvStore.tune()` already resolves the upstream URL server-side, so playback needed no
  Xtream-specific transport; the relay still redacts URLs from its error log.
- Channel identity is `xtream:{stream_id}`. A rename, re-category or reorder on the provider
  updates the saved row instead of creating a new one, so curation survives.
- The last successful catalogue is stored sealed on the provider account. A failed refresh
  records the error code and publishes nothing, so the previous channels and guide stay live.

## Data model (fork migration 1002)

| Table / column | Purpose |
| --- | --- |
| `iptv_sources.kind='xtream'` | Widened `CHECK` (table rebuilt); `xtream_account_id` points at the provider and `encrypted_guide` holds its XMLTV snapshot. |
| `xtream_accounts` | Adds `active_connections`, `is_trial`, `owner_account_id` and `login_key` (origin + username digest, so one subscription maps to one row). Credentials and catalogue stay sealed. |
| `xtream_identities` | Application accounts that exist only through a provider login: `account_id`, `login_key`, `role`. Their rows in `users` make sessions, favourites and grants work without Plex. |

`xtream_access` still decides who can watch a provider. Creating a provider grants its creator;
an administrator can grant others. Disabling a provider or revoking a grant removes its channels
from that viewer's guide immediately and ends their live session.

Upstream migrations (`1..999`) and fork migrations (`1000+`) execute independently: each version
is checked and recorded separately, in ascending order, and migration 1002 preserves every
`iptv_sources` id so child rows keep resolving. `tests/xtream-live.test.ts` re-applies upstream
migrations 10 and 11 on a populated database that already has 1001 and 1002.

## Adapter endpoints

| Call | Purpose |
| --- | --- |
| `GET /player_api.php?username=&password=` | account validation: `auth`, `status`, `exp_date`, `max_connections`, `active_cons`, formats, timezone |
| `GET /player_api.php?...&action=get_live_categories` | categories |
| `GET /player_api.php?...&action=get_live_streams` | live channels, including `epg_channel_id` and container |
| `GET /xmltv.php?username=&password=` | full provider guide (gzip or plain XML) |
| `GET /player_api.php?...&action=get_short_epg&stream_id=` | per-channel fallback guide when `xmltv.php` is absent (bounded to 40 channels per refresh) |

Stream addresses are built server-side as `{server}/live/{username}/{password}/{stream_id}.{ts|m3u8}`
and stay inside the sealed catalogue and the relay. `get_vod_*` and `get_series*` remain reserved
for M03.

### Normalisation

IDs are positive integers; malformed rows are skipped and counted. Names and categories are
control-stripped, collapsed and bounded. Logos must be `http(s)` without userinfo. Only `m3u8`
and `ts` are relayed as live. Duplicate stream ids keep the first row. A catalogue is capped at
20,000 channels, 2,000 categories.

## Refresh and last-known-good

`XtreamService.refresh`:

1. authenticates (`XTREAM_AUTH_FAILED`, `XTREAM_ACCOUNT_INACTIVE`, `XTREAM_ACCOUNT_EXPIRED` fail closed),
2. fetches categories, channels and (optionally) guide,
3. rejects an empty channel list (`XTREAM_EMPTY_CATALOGUE`) rather than wiping a working lineup,
4. seals the catalogue, updates account metadata, then publishes into `iptv_sources`.

A failure at any step records the stable code on the account and leaves the previous catalogue,
channels, guide, numbers and favourites untouched. Scheduled refreshes run every 12 hours through
`SourceRefresh`, which routes `kind='xtream'` sources back to the account. Credential changes
clear the catalogue, hide the old channels and stop their relays.

## Application identity

Two kinds of secrets stay separate (see [`AUTH_MODEL.md`](AUTH_MODEL.md)):

| Secret | Proves | Stored as |
| --- | --- | --- |
| Application session | who is using tk.box | `sessions.hash`; Plex token or a sealed local marker |
| Provider credentials | which subscription a stream comes from | `xtream_accounts.encrypted_credentials` |

`POST /api/v1/auth/xtream/login` authenticates against the panel, then issues the same session
cookie Plex sign-in uses. `IdentityService.authenticateHash` treats an account with an
`xtream_identities` row as local: no Plex call, role from that row, revocation by session delete
or `users.allowed`. Plex accounts keep their existing re-authorisation path.

Roles: with Plex configured the existing owner stays the only administrator and a provider login
is a viewer. On a Plex-less deployment the first provider identity bootstraps the administrator.
Administrators reach every provider; everyone else only granted ones.

## API

Viewer routes (any signed-in account; provider access is checked on each call):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/xtream/login` | provider sign-in; body `{serverUrl, username, password, allowInsecureHttp?}` |
| `GET` | `/api/v1/xtream/accounts` | providers visible to the caller (administrators: all) |
| `GET` | `/api/v1/xtream/accounts/:id` | status: enabled, account status, expiry, connections, channel count, last error |
| `POST` | `/api/v1/xtream/accounts` | add a provider; body `{name, credentials, validate?}` |
| `PATCH` | `/api/v1/xtream/accounts/:id` | rename, enable/disable or replace credentials (owner or administrator) |
| `DELETE` | `/api/v1/xtream/accounts/:id` | remove provider, source, channels and curation (owner or administrator) |
| `POST` | `/api/v1/xtream/accounts/:id/validate` | re-run account validation |
| `POST` | `/api/v1/xtream/accounts/:id/refresh` | refresh channels and guide (defaults to `includeEpg: true`) |
| `GET` | `/api/v1/xtream/accounts/:id/catalogue` | paged, URL-free catalogue |

The M01 administrator routes under `/api/v1/admin/xtream/*` remain, including access grants.

Example:

```sh
curl -sS -X POST http://127.0.0.1:3000/api/v1/auth/xtream/login \
  -H "Origin: http://127.0.0.1:3000" -H 'Content-Type: application/json' \
  -d '{"serverUrl":"https://provider.example:8443","username":"u","password":"p"}'
```

## Playback

Xtream channels tune exactly like M3U channels:

- `POST /api/v1/live/sessions {channelId}` checks the provider grant, then starts the shared relay.
- The relay holds a `ProviderConnections` lease named by the provider, so a subscription's
  `max_connections` caps its relays **and** channel checks together, under the server-wide limit.
  Viewers take precedence; a check is reclaimed for a waiting viewer.
- Background checks are off by default for Xtream sources (interval 0) because they would compete
  with viewers on one- or two-connection plans. An administrator can opt in under Checks.
- Disabling/deleting a provider, replacing credentials, revoking a grant or an expired account
  ends live relays and refuses new tunes. Playlist requests also re-check visibility.

Xtream channels list as soon as a refresh publishes them (`require_check=0` for the source), so
they appear in the guide without waiting for a first passing probe.

## Security properties

- **Encryption at rest** — credentials and catalogues use `Vault` (AES-256-GCM) with per-row
  contexts `xtream:credentials:{id}` and `xtream:catalogue:{id}`; guide snapshots use
  `iptv:guide:{source}`. Moving a ciphertext to another row fails authentication.
- **No credential exposure** — no route returns a username, password or stream URL; upstream
  exception text is discarded and only stable codes persist. The relay redacts URLs from FFmpeg
  output before logging.
- **SSRF** — every provider call goes through `RestrictedSourceFetcher`: DNS resolved once and
  pinned, private/loopback/documentation ranges rejected, redirects same-origin only, bounded
  responses (16 MB / 30 s), TLS never relaxed.
- **Authorisation** — provider routes answer 404 for a provider the caller cannot use; account
  mutation needs ownership or administrator. Cross-account isolation is covered by tests.
- **Provider limits** — one in-flight catalogue operation per account, four server-wide, plus the
  playback/check leases described above.
- **Scope** — documented provider APIs only. No DRM circumvention, no panel scraping.

## Configuration

No new environment variables. Provider accounts are added in **Settings → Xtream** (or the API),
and the optional per-provider checks are configured under the source's Checks tab.

## Tests

- `tests/xtream.test.ts` (9): endpoint validation, account failures, parsing, catalogue, sealing,
  service state, admin API.
- `tests/xtream-live.test.ts` (7): publishing into source/guide, last-known-good, identity and
  curation across renames, expiry/disabled/empty handling, Plex-less login and isolation,
  credential redaction and access scoping, upstream migration compatibility.
- `tests/xtream-playback.test.ts` (1): a synthetic Xtream panel with a real FFmpeg MPEG-TS stream;
  remux, segment fetch, per-provider connection refusal, revocation and disabled-account
  termination.

## Limitations

- Real panels vary. Validation is fail-closed and fixtures follow the documented shape; a pilot
  against a real subscription is still outstanding.
- The short-EPG fallback covers at most 40 channels per refresh.
- Plain HTTP panels need the per-account opt-in; SSRF rules still apply and private LAN panels
  are rejected.
- VOD, series and catch-up are M03.
- Hosted GitHub Actions execution remains unverified (runner allocation), separate from these
  local results.
