# Milestones and acceptance criteria

## M01 — Project bootstrap and Xtream foundation (this milestone)

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Working fork and development branch | met | `tacticdemonic/tk.box`, `develop`, `feature/xtream-firetv` |
| 2 | Upstream update management configured and verified | met for the workflow; daily schedule needs the workflow files on `main` | `.github/workflows/upstream-sync.yml`, manual dispatch run, `docs/UPSTREAM_SYNC.md` |
| 3 | Existing application builds; baseline tests pass; pre-existing failures recorded | met | `npm run typecheck` clean, `npm test` 178/178 before changes, `npm run build` succeeds. One timing-sensitive test (`channel-health` scheduler) was made deterministic; see below |
| 4 | Isolated Xtream adapter validates mock accounts and retrieves mock live categories/channels | met | `apps/server/src/providers/xtream.ts`, `tests/xtream.test.ts` |
| 5 | Automated tests cover the adapter and failure conditions | met | 9 tests: auth rejection, inactive, expired, malformed JSON/HTML, sanitisation, URL-free paging, sealed storage, service and admin API |
| 6 | Existing M3U, Plex and authentication behaviour unchanged | met | no changes to `IptvStore`, `IdentityService`, `LiveTv` or Plex code; full suite 187/187 after the addition |
| 7 | Android/Fire TV strategy documented | met | `docs/ANDROID_FIRE_TV.md` |
| 8 | Next milestone defined | met | M02 below |

### Baseline and verification notes

- Baseline (upstream `1cff170`, before any fork change): `npm run typecheck` pass,
  `npm test` 178 pass / 0 fail, `npm run build` pass.
- After M01: 187 tests (178 existing + 9 Xtream), typecheck and build clean.
- **Pre-existing flake fixed:** `tests/channel-health.test.ts` waited a fixed 20 ms for
  the scheduler to settle. Under full-suite parallel load it failed roughly half the
  time. Replaced with bounded polling; it passed three consecutive full runs afterwards.
  No production code changed for this.
- Not verified: a real Xtream panel (no subscription available, by design), a real Fire TV
  device, and an APK build (no Android SDK/JDK 17 in this environment).

### Deliberate non-goals in M01

- No viewer UI for Xtream accounts and no channel import into the guide.
- No VOD/series catalogue.
- No local (non-Plex) application users.
- No Android project code or APK.

## M02 — Functional Xtream Live TV end to end (recommended next)

**Goal:** an administrator adds an Xtream account, refreshes it, and its Live TV channels
appear in the existing guide and play through the existing FFmpeg relay, alongside M3U
sources — with EPG, per-user access, and provider connection limits.

### Work

1. **Source model.** Fork migration `1002`: allow `iptv_sources.kind='xtream'` (SQLite table
   rebuild; copy existing rows, recreate indexes/foreign keys) and add
   `xtream_account_id TEXT REFERENCES xtream_accounts(id)`. Keep `m3u`/`xmltv` rows
   byte-identical. Test the migration against a populated pre-M02 database.
2. **Refresh path.** Branch `SourceRefresh.refresh` on source kind: Xtream sources call
   `XtreamService.refresh`, then publish through the existing `IptvStore.publish` path with
   stable channel identity `xtream:{stream_id}`. Curation (renames, numbers, favourites,
   listing overrides) must survive provider renames and reordering.
3. **Guide.** Store the provider EPG snapshot with the Xtream catalogue and resolve it in
   `IptvStore.guideData()` using `epg_channel_id` as the XMLTV id, instead of fabricating an
   `xmltv` source row. Reuse `resolveGuideMapping`, `guideWindow` and the existing guide API.
4. **Playback.** `IptvStore.tune()` already returns a server-side stream URL; the relay needs
   no change. Add a per-provider connection budget to `ProviderConnections` from
   `xtream_accounts.max_connections`, while keeping the server-wide ceiling.
5. **Administrator UI.** Settings screen: list/add/edit/delete accounts, validate, refresh,
   show channel counts and last error. No new viewer screens: Xtream channels enter the
   existing Live TV guide as another source.
6. **Access.** Viewer catalogue and playback routes check `xtream_access`; an application
   user only sees channels from providers granted to them. Admin routes stay admin-only.
7. **Tests.** Fixture-driven import → guide → tune → relay-start path; identity stability
   across a renamed stream; per-user visibility; migration round-trip; connection-limit
   denial; no credentials in any response or log line.
8. **Pilot.** Validate against one real provider (outside CI) and record sanitised results:
   category count, channel count, EPG coverage, tune success rate.

### Acceptance criteria

- An Xtream account can be added, validated, refreshed and disabled without a server restart.
- Its channels appear in `/api/v1/iptv/channels` and `/api/v1/guide` for granted users only,
  with EPG listings where the provider supplies them.
- Tuning an Xtream channel plays through `LiveTv` with the same behaviour as M3U (HLS
  output, health checks, failover across feeds).
- Provider `max_connections` is enforced for playback plus health checks.
- Re-running a refresh does not duplicate channels or lose curation.
- All existing M3U/Plex tests stay green; no credentials in API responses or logs.
- Documentation updated (`docs/XTREAM.md`, `docs/AUTH_MODEL.md`) with the final wiring.

### Stretch (only if M02 core is green)

- Local (Xtream-only) application users per `docs/AUTH_MODEL.md`: Argon2id credentials,
  `local:` account namespace, login route, admin bootstrap CLI. Acceptance: a user with no
  Plex account can sign in and watch a granted Xtream provider.

## M03 — Xtream VOD, series and catch-up

- Normalise `get_vod_streams`, `get_series`, `get_series_info` (seasons/episodes) into the
  catalogue model.
- Reuse Plex-style VOD playback policy and the existing transcoder budget; container/codec
  compatibility decides direct play vs HLS.
- Movies/series browse UI; resume position; no DRM bypass, no catch-up unless the provider
  documents it.

## M04 — Android / Fire TV MVP

- Implement phase 1 from `docs/ANDROID_FIRE_TV.md`: TV-only `android/` module, WebView shell,
  server URL entry, Media3 HLS/TS player, cookie sharing, leanback launcher, banner.
- Acceptance on a Fire TV Stick 4K (Fire OS 7) and a 2nd-gen Stick (Fire OS 5): sign in,
  browse, tune, zap, Back stops the relay, session survives relaunch.

## M05 — Release hardening

- Signed APK releases with `versionCode` discipline and an update manifest.
- Upstream sync cadence proven over several weeks; branch protection on `main`/`develop`.
- Backup/restore of `data/` including the vault key; key rotation runbook.
- Load check: 8 relays, 4 viewers per stream, provider connection ceilings.
