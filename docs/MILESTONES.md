# Milestones and acceptance criteria

## M01 — Project bootstrap and Xtream foundation

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Working fork and development branch | met | `tacticdemonic/tk.box`, `develop`, `feature/xtream-firetv` |
| 2 | Upstream update management configured and verified | met for configuration and git logic; hosted-runner execution blocked by GitHub's queue | workflows on `main`, behind/merge/conflict logic verified by a local two-repository simulation; see `docs/UPSTREAM_SYNC.md` |
| 3 | Existing application builds; baseline tests pass | met | typecheck, `npm test`, `npm run build` clean |
| 4 | Isolated Xtream adapter validates mock accounts and retrieves mock live categories/channels | met | `apps/server/src/providers/xtream.ts`, `tests/xtream.test.ts` |
| 5 | Automated tests cover the adapter and failure conditions | met | auth rejection, inactive, expired, malformed JSON/HTML, sanitisation, sealed storage, admin API |
| 6 | Existing M3U, Plex and authentication behaviour unchanged | met | M01 changed no `IptvStore`, `IdentityService`, `LiveTv` or Plex code |
| 7 | Android/Fire TV strategy documented | met | `docs/ANDROID_FIRE_TV.md` |
| 8 | Next milestone defined | met | M02 below |

## M02 — Functional Xtream Live TV end to end

**Goal:** an account adds an Xtream subscription (with or without Plex), refreshes it, and its
Live TV channels appear in the existing guide and play through the existing FFmpeg relay —
with EPG, per-account access and provider connection limits.

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Xtream accounts authenticate without Plex | met | `POST /api/v1/auth/xtream/login`, `xtream_identities`, `identity.xtreamLogin`; `tests/xtream-live.test.ts` |
| 2 | Provider categories and channels load into tk.box | met | `XtreamService.refresh` → `IptvStore.publishXtream`; guide and `/api/v1/iptv/channels` |
| 3 | EPG information is available through the existing guide | met | `xmltv.php` snapshot stored per source; short-EPG fallback; guide window test |
| 4 | Live channel playback works with controlled test sources | met | `tests/xtream-playback.test.ts` with a synthetic panel and real FFmpeg MPEG-TS |
| 5 | Multiple providers are supported | met | independent accounts, catalogues, sources and grants |
| 6 | Credentials and sessions remain secure | met | sealed at rest, redacted, SSRF-guarded, scoped sessions |
| 7 | Existing Plex and IPTV functionality is preserved | met | full suite green (see below) |
| 8 | Automated tests, typecheck and build pass locally | met | 195 tests, typecheck, production build |
| 9 | Database migration compatibility is verified | met | migration 1002 rebuild plus upstream re-apply test |
| 10 | Documentation and evidence accurately reflect the implementation | met | `docs/XTREAM.md`, `docs/AUTH_MODEL.md`, this file |

### Work completed

1. **Source model.** Fork migration 1002 widens `iptv_sources.kind` to include `xtream`, adds
   `xtream_account_id` and `encrypted_guide`, and rebuilds the table with ids preserved.
2. **Refresh path.** `SourceRefresh` routes Xtream sources to `XtreamService`, which publishes
   through `IptvStore.publishXtream` with stable identity `xtream:{stream_id}`. Renames keep the
   saved row, number, listing, stack and favourites. Empty responses are rejected; failures keep
   the last known catalogue.
3. **Guide.** The provider XMLTV snapshot is stored per source and resolved by `feedFor` /
   `guideData` without a fabricated XMLTV row, reusing `resolveGuideMapping`, `guideWindow` and
   the existing guide API. `get_short_epg` is a bounded fallback.
4. **Playback.** `IptvStore.tune` still resolves the URL server-side; `LiveTv` needed only an
   account-aware visibility check and a per-provider connection lease. `ProviderConnections` now
   enforces both the server-wide and per-provider limits.
5. **Identity.** `xtream_identities` and `IdentityService.xtreamLogin` give Plex-less users a
   session; `authenticateHash` branches on the namespace. Roles: Plex owner stays administrator
   when Plex is configured; first provider identity bootstraps it otherwise.
6. **Access.** Viewer routes under `/api/v1/xtream/*`; provider visibility scoped by
   `xtream_access`; disabling/removing/re-keying a provider stops its relays.
7. **UI.** Settings → Xtream (list, add, edit, enable/disable, refresh, remove, status, expiry,
   connection counts) and an Xtream sign-in option on the login screen.
8. **Tests.** `tests/xtream-live.test.ts` (7) and `tests/xtream-playback.test.ts` (1) added; the
   M01 Xtream suite still passes.

### Verification notes

- `npm run typecheck` clean; `npm test` 195 pass / 0 fail; `npm run build` succeeds.
- Playback was exercised with a locally generated H.264/MP2 MPEG-TS stream served by a synthetic
  Xtream panel: tune, playlist, segment, provider-limit refusal, grant revocation and disabled
  account termination.
- Not verified: a real Xtream subscription, a real Fire TV device, an APK build (no Android
  SDK/JDK 17 here), and hosted GitHub Actions execution (runs stayed queued; workflow logic is
  separate from these local results).

### Deliberate non-goals in M02

- No VOD, series or catch-up.
- No password-based local accounts or public sign-up (provider login covers Plex-less use).
- No Android project code or APK.
- No DRM handling or panel scraping.

## M03 — Android Fire TV MVP

**Goal:** the first sideloadable APK: the existing React UI in a TV WebView, with live channels
playing in native Media3/ExoPlayer and the remote driving the whole flow.

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | TV-only `android/` project with leanback launcher, banner, server setup, persistent config | met | `android/`, `android/app/src/main/AndroidManifest.xml`, `docs/ANDROID_FIRE_TV.md` §2 |
| 2 | Native HLS playback through Media3, launched from a successful tune | met | `PlayerActivity.kt`, `apps/web/src/native-player.ts`; `tests/firetv-bridge.test.ts` |
| 3 | Authenticated playlist and segments from WebView cookies; no fetch monkey-patch | met | `WebViewCookies.kt`, `OriginCookieInterceptor.kt`; `SessionClientTest.kt` |
| 4 | Back, errors and channel switches release the server relay; one player at a time | met | `PlayerActivity.kt` (`singleTop`, `onStop`, session `DELETE`), bridge tests |
| 5 | D-pad navigation, focus ring, Back, IME and overscan | met | `apps/web/src/tv-navigation.ts`, `.tv-mode` styles; `tests/firetv-navigation.test.ts` |
| 6 | Older WebView and 32-bit ARM compatibility | met and exercised on WebView 66 | `vite.config.ts` target, `apps/web/src/compat.ts`; four real failures found and fixed, `docs/ANDROID_FIRE_TV.md` §6 |
| 7 | First-user administrator bootstrap is owner-controlled on public deployments | met | `INITIAL_ADMIN_TOKEN`, `IdentityService.hasLocalAdmin`; `tests/xtream-live.test.ts` |
| 8 | Debug APK builds with a real SDK and Gradle; unit tests pass | met | `./gradlew testDebugUnitTest assembleDebug`, JDK 17 / SDK 34 / Gradle 8.9 |
| 9 | Node tests, typecheck and production build stay green | met | see §Verification notes |
| 10 | End-to-end flow on a TV-class WebView | met (emulator) | Android TV API 28 / WebView 66: setup, sign-in, guide, D-pad, native playback, Back releasing the relay |
| 11 | Real Fire TV device acceptance (launch, playback, remote, relaunch) | **pending** | requires Astra/user testing on physical hardware; procedure in `docs/ANDROID_FIRE_TV.md` §8 |

Deliberate non-goals: VOD, series, catch-up, custom-channel pause/resume in the native player,
in-app updates, signed release builds.

## M04 — Xtream VOD, series and catch-up

- Normalise `get_vod_streams`, `get_series`, `get_series_info` into the catalogue model.
- Reuse Plex-style VOD playback policy and the transcoder budget; direct play vs HLS by codec.
- Movies/series browse UI, resume position; no DRM bypass, no catch-up unless documented.
- Optional: native VOD playback in the TV shell, reusing `PlayerActivity`.

## M05 — Release hardening

- Signed APK releases with `versionCode` discipline and an update manifest.
- Upstream sync cadence proven over several weeks; branch protection on `main`/`develop`.
- Backup/restore of `data/` including the vault key; key rotation runbook.
- Load check: 8 relays, 4 viewers per stream, provider connection ceilings.
- Fire TV device matrix acceptance recorded per Fire OS version.
