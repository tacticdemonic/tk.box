# tk.box implementation status

Updated October 22, 2026. **M03.5 removes the guide read-path stall that blocked paging on a
populated EPG. The dominant defect was not repeated guide decryption but `IS NOT NULL` on the
guide blob, which made every source-metadata read walk 37 MB of overflow pages. A 50-row page went
from ~50 s to ~185 ms on the same compiled server and dataset. M03.4 physical retest and the M03.5
physical retest both remain open. M03.3 physical acceptance was reported by the user/Hermes; see
its record.**

## Latest pass: M03.5 — guide and logo read-path stalls

- **Measured cause.** `IptvStore.source()` projected `encrypted_guide IS NOT NULL`. SQLite evaluates
  that by reading the value, so every call walked the whole 37 MB guide: 20.8 ms per call, on a
  projection the guide page made hundreds of times. `typeof(encrypted_guide)='text'` reads only the
  header (0.01 ms) with identical semantics.
- **Duplicate work removed.** Xtream channel metadata now comes from the published snapshot rather
  than the catalogue that also carries the guide; per-channel metadata is cached by its own sealed
  payload; programmes are indexed by guide id once per snapshot instead of being filtered per row;
  an indexed guide miss no longer rebuilds the station map; and a clock-minute change re-joins
  cached resolver evidence instead of re-resolving every mapping.
- **Logos.** Each channel's guide icon is published (migration 1005, backfilled by the existing
  startup pass) so a logo request decrypts and parses no programme guide. Existing databases need
  no reimport.
- **Verified.** `npm run typecheck`, `npm run build`, **255 of 255** Node tests (including 11
  deterministic work-count tests in `tests/guide-read-path.test.ts`), and a compiled-server
  benchmark. Warm 50-row page p95 241 ms, cold 667 ms, `/health` p95 33 ms and `/api/v1/me` p95
  87 ms during a logo burst. Baseline on the same harness reproduced the field report at
  54,458–74,830 ms. Details and budgets: [M03.5](M03.5-GUIDE-READ-PERFORMANCE.md).
- **APK.** No native source changed; the installed APK remains valid. M03.5 physical retest is
  **not** performed.

## Previous pass: M03.4 — Xtream EPG diagnosed and repaired

- **Cause.** The provider answered `200` in 522 ms with a valid gzip XMLTV feed, 2.87 MB compressed
  and 20.6 MiB inflated. The shared 16 MiB decompression ceiling made `gunzipSync` throw, the
  fetcher classified that as an unknown failure, and `transportFailure()` collapsed it to
  `XTREAM_UNREACHABLE`. Three further defects sat behind it: `parseXmltv` rejected the conventional
  `<!DOCTYPE tv SYSTEM "xmltv.dtd">` prologue; it also required a guide id to be declared exactly
  once, so the provider's four declarations of `bbc1.uk` (`SD`, `FHD`, `HD`, `Catchup Backup`)
  quarantined the listings for the most-watched stations; and the fallback sent `tvgId` as
  `stream_id`, which this provider answers with zero rows.
- **Guide identity.** `guideStations()` now decides usability from station agreement rather than a
  declaration count, so a station listed several times under one id maps, while `bbc2.uk` — shared
  by BBC Two and BBC Two NI — stays ambiguous and honestly shows no guide data instead of being
  silently merged. Parsing, automatic mapping, suggestions and manual approval all use that one
  rule.
- **Transport diagnostics.** `SourceFetchError` now carries a structured code and safe numeric
  detail (HTTP status, byte counts, limits, elapsed time, compression, network class). Each maps to
  its own `XTREAM_*` code; only an unknown failure remains `XTREAM_UNREACHABLE`. Guide limits are
  per call, so only the guide path is raised, and both compressed and inflated sizes stay bounded.
- **Short-EPG fallback corrected.** It asked with `tvgId`; the provider answers by `streamId` and
  returns zero rows for the guide id. Request identity and guide identity are now separate, and a
  listing is stored under the guide id. Timestamps accept validated Unix seconds, numeric strings,
  XMLTV offsets, ISO offsets and provider-zone wall clocks — never the host's zone. Base64 text is
  decoded only when it round-trips exactly; plain titles are untouched.
- **Fallback budget.** ≤40 channels, 4 concurrent, 20 s wall clock, abort-aware, stopping on the
  first rate-limit/HTTP/timeout refusal, reporting requested/succeeded/skipped/mapped coverage.
- **Honest guide state.** New `guide_status` (migration 1004, column-presence checked because 1002
  rebuilds `iptv_sources`) distinguishes available, partial, unmatched, empty, failed and
  retained, with the primary diagnostic preserved. A guide-only failure keeps the previously
  published guide; the UI says so instead of "the guide did not load". Fixed `publishXtream`
  reading a `has_guide` alias that `SELECT *` never produced, which silently dropped retained
  guides.
- **Evidence.** `tests/xtream-epg.test.ts` (15) covers every finding. Full suite: **243 tests, 0
  failures**. Typecheck and the production build are clean. The compiled server passed health,
  frontend, protected-route and port-collision checks manually (`smoke:built` needs a longer
  readiness window and a WAL-capable temp directory in this environment). An authorised,
  bounded real-provider read now yields `guide: available`, 62,553 programmes, 1,850 usable guide
  ids and 956 with programmes in the current window, with real listings on the rendered guide
  payload (previously "No guide data").
- **APK.** No native source changed; the installed APK remains valid. M03.4 physical retest is
  **not** performed. Details: [M03.4](M03.4-XTREAM-EPG.md).

## Previous pass: M03.3 — Xtream sign-in no longer waits for the catalogue

- **Confirmed mechanism.** `POST /api/v1/auth/xtream/login` authenticated the provider, then ran
  the full catalogue + EPG import inline before setting the session cookie. The web client's
  `AbortSignal.timeout(30000)` fired first on the device (30.8 s) while the same request took
  78.5 s from a PC, so a large provider could never sign in from the TV UI.
- **Authentication is now separate from import.** The login route makes exactly one bounded
  provider call (account authentication), establishes the identity and session, records the
  provider account and queues an import. It returns while that import is still queued or running.
  The frontend deadline stays at 30 s.
- **Managed import lifecycle.** `XtreamImports` owns sign-in, manual and scheduled imports. Job
  rows live in `xtream_imports` (fork migration 1003) with `queued`/`running`/`completed`/`failed`/
  `interrupted`, a current stage and a stable error code. A partial unique index allows one active
  import per provider; two run server-wide; a validation and an import exclude each other; a
  credential change, disable or removal during the fetch fails the job instead of publishing; a
  restart marks inherited rows `interrupted`; shutdown aborts and drains.
- **Manual refresh returns 202.** `POST /xtream/accounts/:id/refresh`, the admin equivalent and an
  Xtream IPTV source's refresh accept the work and expose status at
  `GET /xtream/accounts/:id/imports`, scoped by the existing provider access rule.
- **UI.** Sign-in leaves the form as soon as the session exists; a bounded 3-second poll reports
  "Signed in. Loading channels…", the publish stage, guide-only failure, import failure with
  Retry, and interruption. The guide shows a loading state instead of "No channels" during a first
  import, and cached channels stay browsable during a refresh. A deadline abort now reads as a
  timeout, not "The user aborted a request".
- **Responsiveness fix found by the large-catalogue test.** Publishing 8,436 channels blocked the
  event loop for 38 s: `coverage()` compared every channel against every other, `feedFor`/
  `channel()` were re-queried per channel, and `source()` copied the multi-megabyte sealed
  snapshot on every read. Guide resolution now uses a per-pass index, channel rows are reused
  within a pass, and source metadata is read without its sealed payloads. The publish step takes
  ~1.1 s and health/status/UI requests stay responsive.
- **Evidence.** `tests/xtream-imports.test.ts` (11) covers the delayed import, `/me` before
  completion, credential/bootstrap rejection, deduplication, account scoping, last-known-good,
  stale-publish prevention, restart, an 8,436-channel catalogue and the validation/import
  distinction. A Chromium run of the real form against a synthetic 8,436-channel panel that
  delays every catalogue call past 30 s signed in in ~120 ms, showed "Signed in. Loading
  channels…", never showed "No channels", and filled the 8,432-channel guide without a reload.
- **APK.** No native Android source change was needed; the currently installed APK remains valid.
  Physical acceptance on the AFTMM was **reported by the user/Hermes** (AFTMM, Fire OS 6.7.1.1,
  API 25): normal form sign-in in ~0.54 s without seeded cookies, catalogue import running
  independently, guide/channel navigation, native playback, audible audio, Back releasing the
  relay and the session surviving relaunch. OMP did not perform those steps; see the
  [M03.3 record](M03.3-XTREAM-LOGIN-TIMEOUT.md#physical-acceptance--reported-by-the-userhermes-not-performed-by-omp).
  The guide "No guide data" problem reported alongside it is diagnosed and repaired in M03.4.

## Previous pass: M03.2 — physical Fire Stick CSRF rejection

- **Root cause: server origin configuration, not WebView behaviour.** `loadConfig` used
  `APP_HOST` for both the listen address and the expected browser origin. With the documented
  LAN setup (`APP_HOST=0.0.0.0`), the expected origin became `http://0.0.0.0:3000`, which no
  client ever sends, so every state change from the Stick's `Origin: http://<lan-ip>:3000` was
  refused with `CSRF_REJECTED`. The emulator passed only because `adb reverse` reached the server
  on loopback, where the two happened to agree.
- **Listen address and browser origin are now separate.** `APP_ORIGIN` (`http://` or `https://`,
  no path/query/credentials) sets the browser-facing origin for LAN HTTP and any non-standard
  host; `PUBLIC_BASE_URL` remains the HTTPS public origin and takes precedence. Both are
  normalized to the RFC 6454 origin (`https://tv.example.com/` → `https://tv.example.com`),
  must agree when both are set, reject wildcard hosts, and are validated at startup. A wildcard
  bind without either emits an explicit warning. No wildcard, dynamic or CORS-permissive origin
  was introduced.
- **Fire TV compatibility is belt-and-braces, not a relaxation.** The page now sets
  `X-Requested-With: com.tkbox.tv` on non-GET `api()` calls when `TkBoxNative` is present, so
  older/newer Fire OS WebViews that omit the header still satisfy the existing `Origin: null`
  exception; duplicate header values are matched as one package. `SessionClient.stop` sends the
  same marker. The exception still requires a literal `null` Origin, JSON, and no cross-site
  fetch metadata; a real foreign origin is never accepted with the marker.
- **Opt-in diagnostics.** `CSRF_DIAGNOSTICS=true` logs request id, method, route template,
  origin classification/normalized value, expected origin, marker classification,
  `Sec-Fetch-Site`, shell detection and a reason code. No cookies, tokens, bodies, query strings
  or provider URLs.
- **Tests:** `tests/csrf-origin.test.ts` covers LAN/wildcard/loopback/remote origin rules,
  host/port/scheme mismatches, missing/malformed/`null` Origin, accepted and rejected markers,
  CORS preflight, "CSRF accepted but credentials rejected" separation, and secret-free
  diagnostics. `docs/ANDROID_FIRE_TV.md` §8 is now a focused ten-step physical retest with the
  server-origin check and a reason-code table. Physical acceptance is **not** claimed.

## Latest pass: M03.1 — Fire TV security and UAT readiness

- **Native playback was broken on WebView 66, and is fixed.** `CookieManager.getCookie()` on the API 28 / Chromium 66 image hides `SameSite` cookies, so the shell's snapshot never contained the session cookie and every native playlist request answered 401. The server now omits `SameSite` (`sameSite: false`, so browsers default to Lax) and `WebViewCookies.observe()` reuses the `Cookie` header of a same-origin request the WebView already made. Verified on the emulator: playlist, segments and the session DELETE all carry the cookie, and H.264/MPEG-TS playback runs with the picture advancing.
- **HTTP provider sign-in fixed.** `XtreamStore.findByLogin` re-normalised the provider URL without the `allowInsecureHttp` opt-in, so a plain-HTTP panel authenticated and then failed with `XTREAM_ENDPOINT_REJECTED`. The flag is now passed through.
- **Native credential leak fixed.** `OriginCookieInterceptor` attaches the WebView session cookie after OkHttp's redirect policy runs, so a followed 301/302/307/308 replayed the `Cookie` header to the redirect target, including a different origin. A two-`MockWebServer` test reproduced the cookie arriving at the foreign server. `SessionClient.client` now sets `followRedirects(false)`/`followSslRedirects(false)`, and the interceptor throws for any request outside the configured origin, so an HLS manifest naming a foreign segment or key cannot be fetched either. Covered by 4 new `SessionClientTest` cases plus the tightened origin test.
- **LAN bootstrap hardened.** `loadConfig` now treats any non-loopback `APP_HOST` (`0.0.0.0`, `::`, a LAN IP) as reachable and refuses to start a Plex-less deployment without `INITIAL_ADMIN_TOKEN`, regardless of `DEPLOYMENT_MODE`. Strictly loopback-only development keeps zero-configuration bootstrap. The token is never logged or persisted; `/api/v1/setup` only exposes the boolean.
- **Legacy WebView CSRF tightened.** The pre-83 WebView exception now requires the literal `Origin: null` **and** `X-Requested-With: com.tkbox.tv` (exact match, no pattern) and rejects `Sec-Fetch-Site: cross-site`. Tests assert hostile origins, other marker values and preflights receive no CORS headers. The CORS assumptions that would invalidate the exception are documented in `docs/ANDROID_FIRE_TV.md` §6.
- **Physical UAT ready.** `docs/ANDROID_FIRE_TV.md` §8 is now an 18-row acceptance checklist with exact ADB install/diagnostic commands for an older Fire TV Stick. Physical acceptance is **not** claimed.
- See `docs/ANDROID_FIRE_TV.md` and [auth model](AUTH_MODEL.md) for the invariants.

## Previous pass: M03 — Android Fire TV MVP

- `android/` is a standalone Kotlin/Gradle project: leanback launcher and banner, first-run server address with a connection test, persisted origin, hardened WebView for the existing React UI, and Media3/ExoPlayer HLS playback in `PlayerActivity`.
- The web app exposes one explicit bridge (`apps/web/src/native-player.ts`): detect the shell, hand off `{sessionId, streamUrl, title}`, stop it, and listen for `tkbox:native-playback`. No `window.fetch` patching. Without the bridge, hls.js plays exactly as before; with it, `PersistentPlayer` gets an empty URL so the playlist is fetched once, by ExoPlayer.
- Cookies come from WebView's `CookieManager` snapshot and are added only for the configured origin; playlist and MPEG-TS segment requests are authenticated without exposing the cookie to page JavaScript, and Back/errors/switching/page-stop close the server session once (`PlaybackLifetime`).
- Origin and URL rules reject foreign hosts, another session's playlist, query strings, credentials and plain HTTP in release builds. `INITIAL_ADMIN_TOKEN` now guards first-user bootstrap on public Plex-less deployments.
- Fire TV navigation is geometric D-pad focus with a visible ring, Back that closes a dialog first, and a `chrome61`/`es2018` build target plus narrow polyfills for Fire OS 5/6 WebViews.
- **207 Node tests pass**, typecheck and production build are clean; **16 Android unit tests pass** and `assembleDebug` produces `android/app/build/outputs/apk/debug/app-debug.apk`. Driven end to end on an Android TV API 28 emulator whose WebView is Chromium 66 (Fire OS 5/6 generation): launch from the TV launcher, setup, offline recovery, sign-in, guide, D-pad focus, native H.264/MPEG-TS playback, Back returning to the guide and stopping the FFmpeg relay, and the session surviving two app restarts. Four real WebView-66 failures were found and fixed there (`globalThis`, `flatMap`, zod's `BigInt` in the main bundle, and `clamp()`/`min()`/flex `gap`). Not verified: any physical Fire TV device. Device UAT procedure: [Fire TV](ANDROID_FIRE_TV.md) §8.

## Previous pass: M02 — Xtream authentication and Live TV

- Xtream subscriptions now load into the existing Live TV pipeline. A refresh publishes categories and channels into `iptv_sources`/`iptv_channels` with stable identity `xtream:{stream_id}`, so renames, re-categories and reordering keep the saved row, number, listing, stack and favourites. The provider XMLTV snapshot is stored per source and read by the existing guide; `get_short_epg` is a bounded fallback. A failed or empty refresh keeps the last known channels and guide.
- Accounts without Plex can sign in with a provider (`/api/v1/auth/xtream/login`). `xtream_identities` gives them a local role on the same session table; Plex accounts keep their existing re-authorisation. Administrators reach every provider; other accounts only granted ones, enforced on the catalogue, guide, tuning and playlist paths.
- Playback reuses `LiveTv` and the FFmpeg relay. `ProviderConnections` now enforces each Xtream account's `max_connections` in addition to the server-wide limit, sharing the budget with channel checks (which are off by default for Xtream). Disabling, removing or re-keying a provider, revoking a grant or an expired account ends live relays immediately.
- Settings → Xtream lists providers with status, expiry and connection limits; the sign-in screen offers the provider login. Fork migration 1002 widens `iptv_sources.kind`, adds `xtream_account_id`/`encrypted_guide`, and creates `xtream_identities`; upstream migrations continue to apply independently.
- **195 tests pass** (including 8 new Xtream integration/playback tests), typecheck and the production build are clean. Playback was verified against a synthetic Xtream panel streaming a locally generated H.264/MP2 MPEG-TS. Not verified: a real provider subscription, a Fire TV device, an APK build and hosted GitHub Actions execution. Details: [Xtream](XTREAM.md), [auth model](AUTH_MODEL.md).

## Previous pass: custom channels, phase 4 (automatic new episodes)

- Each show or season on a custom channel can automatically add new episodes (off by default, toggled per selection in the Shows tab). New episodes take their place in season and episode order, or follow the show's last entry if the list was rearranged. Removed episodes never come back. Each addition goes on air at the end of the current program and merges with any publish already waiting. Episodes with no runtime or that can't be played are held back. Checks run hourly and on demand, as a signed-in administrator; no Plex token is stored for this.

## Previous pass: custom channels, phase 3 (Pause, Resume, Go Live)

- On custom channels the player's Pause button pins that viewer's position, and Play continues from there, behind live, showing how far behind. Go Live jumps back to what's on now. Other viewers and the schedule aren't affected. Segments are shared and kept by broadcast time only while someone needs them, up to the pause retention setting (default 30 minutes), the per-channel disk cap and a free-space floor. Past that, the viewer sees "Buffer expired" with Go Live. Settings → Playback shows buffer use and warns before retention is lowered. IPTV stays strictly live.

## Previous pass: custom channels, phase 2 (playout)

- Custom channels can be watched (October 18, 2026). The first viewer starts a shared station that joins the airing program at its clock position, and each following program starts on schedule behind an HLS discontinuity. The station stops when the last viewer leaves. H.264 is copied; other video at 1080p or below is encoded within the shared encoder budget. Media is read from disk in same-host mode, otherwise through a loopback-only proxy, so the Plex token stays out of FFmpeg's arguments. No Plex timeline or watch state is ever written. Details and limits: [Custom channels](CUSTOM_CHANNELS.md#build-phases).

## Previous pass: custom channels, phase 1

- Settings → Channels (October 18, 2026): create, number, order, disable and delete custom channels. A Plex picker adds movies, whole shows, seasons or episodes. The program list supports drag or arrow reordering, repeats, removal and arrange tools (shuffle, block shuffle, interleave, sort by show or date, remove repeats or specials, repeat the list). Drafts are separate from what's on air, and a publish preview shows the handoff. Publishing takes effect when the airing program ends. Design and phases: [Custom channels](CUSTOM_CHANNELS.md).
- Published channels appear in the Live TV guide (all, Plex Channels and Favorites filters), with exact program times. They can be favorited but not yet watched; playout is phase 2.
- Programs that would need a forbidden encode (above 1080p and not H.264), or that have no file or runtime, are flagged when added and block publishing.

## Previous pass: automatic channel listing and settings redesign

- Removed channel approval (October 18, 2026). Channels list themselves by per-source rules: regular channels while they pass channel checks (optionally only after a first passing check, on by default) and, if the source asks for it, only while the guide has a program on now or within a look-ahead (default 2 hours), with always-on keyword (`24/7`) and per-category exceptions. Event categories list while their event is live or starting soon. Administrators can still hide a channel or always list it. Details: [Channel listing](IPTV_INGESTION.md#channel-listing).
- Sports events now apply per playlist category, so one playlist can mix event categories with regular stations; Auto Add and bulk approval are gone.
- Redesigned Settings: a section sidebar (IPTV sources, Live Sports, Playback, Account), a source list, and per-source tabs (Overview with why channels are not listed, Channels with bulk listing overrides, Listing rules and categories, Guide, Checks, Sports, Connection).
- **129 tests pass** and typecheck and the web build pass. Browser checks used the isolated `ui-preview` fixture at desktop and narrow widths. Not yet verified against a real provider playlist or EPG.

## Previous pass: compact library and fast browsing

- Replaced the library heading, descriptive text, toolbar panel and status tabs with one compact sticky search/control row. Genre, watch status, release year and content rating live in a Filters popover; Sort provides field/direction. Choices persist per account and media type in this browser. Removed app-added score overlays from posters.
- Movies/Shows now use continuous windowed browsing with 60-item requests, nearby-page prefetch, bounded metadata retention, stale-query cancellation and a right-side alphabet rail driven by Plex's native first-character counts. Verified real Movies/TV totals, filtered counts and descending order. No Previous/Next controls remain in those libraries.
- Startup reuses authorized libraries in the identity response, avoiding an extra authorization request. Independent Plex checks run concurrently. Catalog pages omit unneeded media/cast payloads. Bounded image reuse and conditional image responses still authorize the viewer and resolve current item metadata before every delivery/304.
- Current checks: **62 tests pass**, typecheck, build and compiled smoke pass. Real-server browser checks cover continuous browsing through the final title, A–Z jumps, live search, saved filters/layout, keyboard controls, and normal/390px/wide desktop layouts. Implementation and limits: [compact library UI](LIBRARY_UI.md).

## Previous pass: media UI and discovery

- Built the featured home page, horizontal media shelves, favorite-channel cards, grid/list browsing, server-side genre and unwatched queries, artwork-backed details, series/season navigation and Ctrl+K search. Mobile navigation retains accessible labels and Settings; the skip link focuses content without changing routes.
- Expanded the unified guide with search before pagination, channel deep links, dates, two/four-hour windows, program/now-next dialogs, current-time markers, progress and per-account filter memory for the browser session. The guide remains listings-only while streaming transport integration is open.
- Added administrator search and bulk review for up to 100 pending channels. Source/revision validation, approval, number allocation and audit changes commit atomically; conflicting, missing, cross-source and stale selections are rejected.
- **57 tests pass**, along with typecheck, production build and compiled smoke. Read-only owner verification passed against the configured Plex server for both Movies and TV: genres, genre filtering, unwatched pages, search, artwork, details, seasons and episodes. Browser checks used isolated synthetic fixtures at normal and 390px widths. Details and reproducible preview: [UI progress](UI_PROGRESS.md).

## Previous pass: remote Plex setup

- The remote HTTPS endpoint in `.env` is reachable. Live Plex PIN sign-in verified account ownership, unique server resource/identity and normal administrator authorization. One Movies and one TV library were discovered; verified numeric owner/server/library identifiers were written to `.env` without altering unrelated settings or saving an account token.
- Added `npm run setup:plex -- start / finish`, `services/plex-setup.ts` and adapter discovery methods. Encrypted expiring challenges, content-checked atomic configuration replacement, numeric-owner replacement refusal and sanitized reports. Local setup can repair a nonnumeric owner value only after verified ownership; ordinary application config stays strict. Empty optional fields now count as unset. Evidence: ignored `.local/plex-setup/report.json`; instructions: `docs/LIVE_PLEX_CHECKS.md`.
- **48 tests**, typecheck, build and compiled smoke pass. Live diagnostics now report `plexConfigured: true`. The compiled app was started with this configuration at loopback port 3000 for the workbench; no production service was installed. Main browser login is separate from CLI setup. No media was read, timeline reported or encoder started in this setup pass.

## Resume here

- Source of truth: `UNIFIED_MEDIA_PLATFORM_SPEC_v30.md`; all 1,438 lines were read before implementation. The requested unversioned filename was absent. Confirmed decisions remain unchanged.
- Initially only the specification and four reference snapshots existed; no Git repository. References remain read-only, excluded from builds and runtime, with no copied source. Architecture/licensing findings: `docs/REFERENCE_REVIEW.md` (dizqueTV zlib; Nevu/Nodecast GPL; plexjs MIT).
- Single-process Node/TypeScript/Fastify backend, React/Vite/TypeScript workbench, shared Zod contracts, SQLite/better-sqlite3 and external CPU-only FFmpeg/ffprobe. Configurable native listener and systemd draft, existing external HTTPS proxy; no Docker or GPU.
- Local development/configuration: `README.md`, `.env.example`; deployment and secrets/backups: `docs/DEPLOYMENT.md`, `deploy/tk.box.service`. Remote Plex identifiers are configured; no verification token files or IPTV credentials are supplied. Generated reports/media are ignored under `.local`; application state is ignored under `data`.

## Implemented foundations

- **Plex/security:** PIN linking, browser-bound challenges, hashed opaque HttpOnly cookies, encrypted tokens, configured owner bootstrap, current shared-server/library/item authorization, CSRF and sanitized errors/logging. Direct original VOD APIs/workbench, resume offset and VOD-only progress reporting. Stored playback mode is immutable; linear progress writes and cross-session access fail closed. Open VOD responses abort on Stop/logout and periodically revalidate access.
- **IPTV ingestion (latest pass):** `providers/source-fetch.ts`, `persistence/iptv-store.ts`, `services/source-refresh.ts`, `iptv-api.ts`. Schema 2 stores encrypted endpoints/snapshots/provider metadata, channels, global number reservations, favorites, source/feed bindings and mapping intent. Restricted metadata fetch pins validated public DNS addresses, permits only same-origin redirects, bounds HTTP/gzip/UTF-8 input and rejects incomplete responses. No dependency added.
- **IPTV publication:** transactional reconciliation, automatic listing by per-source rules (no approval), hidden/always-listed overrides, retained IDs/numbers/positions/favorites/name overrides, immediate missing-state visibility and unambiguous restoration honoring hidden state. Listing is separate from identity conflict. Feeds have separate internal identities; shared guide IDs and identical names can identify multiple feeds. Exact repeats deduplicate, stable labels/URIs preserve saved feeds across refreshes, and uncertain matches get an explicit candidate review. Cached legacy playlists upgrade automatically at startup without losing curation or refresh timestamps. Country, language, regional and time-shift variants stay distinct in station grouping. Majority disappearances are held for administrator review of an exact digest/revision; last-good state remains active.
- **Refresh/EPG:** independent persisted 12h M3U/6h XMLTV defaults, 1–168 whole-hour validation, static uploads, scheduled/manual single-flight, four concurrent metadata fetches, provider backoff, interval-edit race protection and shutdown cancellation. Explicit feed binding; unique exact-ID automatic mapping, inactive suggestions and revision-checked manual approval. Cached authentic program windows survive fetch failures, with null-program gaps. API exercise and limitations: `docs/IPTV_INGESTION.md`. Original pure/cache prototypes remain isolated tests, not application storage.
- **Clock/policy:** durable immutable schedule revisions, deterministic server-clock joins/looping and safe-boundary successor/fallback publication. CPU eligibility and FFmpeg guards reject all above-1080p/unknown-dimension video encodes, including 4K HEVC. Default-two encoder admission has no queue/capacity retry. Shared compatible upstream/refcount/provider-limit and finite recovery controllers exist; actual provider transport is not attached.
- **Continuous generated-media experiment:** atomic disk segments/deletion, byte/free-space limits, independent authorized viewer cursors/leases, Pause/Resume/Go Live/expiry and discontinuous HLS delivery. Real 17-second FFmpeg/clock experiment decoded 400 expected frames without packet warnings, used three shared program preparations for two viewers and released all cache bytes/encoder permits on Stop. Browser tests confirmed independent playback and delayed Resume/Go Live/expiry through repeated boundaries. This separate fixture server uses temporary fixture authentication, not production Plex grants. Evidence: `docs/CONTINUOUS_SPIKE.md` and `docs/PLAYBACK_SPIKE.md`.
- **Live Plex verification CLI:** `npm run verify:plex` checks owner/shared/unauthorized accounts and before/after history after bounded original-part EOF reads without timeline writes. It correctly returned `SETUP_REQUIRED` here. Protected-file setup and remaining natural-completion tests: `docs/LIVE_PLEX_CHECKS.md`.

## Current checks

| Check | Observed result |
| --- | --- |
| `npm test` | **243 passed** at M03.4, including catalog/genre queries, guide search, atomic bulk review, access control, durable IPTV, local HTTP, scheduler, policy, Plex fixtures and the 14 new Xtream guide tests |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; app about 298 KiB and lazy hls.js about 595 KiB; existing hls.js chunk-size warning |
| `npm run smoke:built` | Passed: compiled listener/frontend, protected Plex/IPTV APIs, shutdown and explicit port collision failure |
| `npm run db:migrate` | Passed; SQLite schema **2** |
| Prior media/browser checks | Recorded in playback/continuous-spike documents; not rerun for metadata-only changes |

Native HTTP socket tests and compiled smoke ran outside this Windows sandbox because its loopback connections return EACCES. No real Plex/provider compatibility follows from fixture tests. Initial dependency audit reported zero advisories; this pass changed no dependencies and did not rerun that audit.

## Risks and next tasks, in order

1. **Remaining real Plex acceptance:** remote owner PIN/resource/identity/admin checks and server/library configuration now pass. Shared/unauthorized test credentials and a designated media item remain unavailable. Verify normal browser cookies, shared-account grants/revocation, VOD seek/resume/completion/preferences and natural-completion custom-read history safety before enabling custom streaming.
2. **Real media/Linux acceptance:** carry the controlled clock/browser experiment to maintained Linux FFmpeg and permitted Plex media. General TS seek still showed about 443 ms A/V mismatch; CPU fMP4 on the old build failed validation and remains explicitly refused. Validate arbitrary GOPs/tracks/resolutions, long-file temporary-space caps, drift, CPU/disk/egress and the external proxy/browser matrix. No actual 4K HEVC direct/copy experiment occurred.
3. **Next independently implementable work:** equivalent restrictions for nested HLS playlists, media segments and keys, then authorized shared HLS/MPEG-TS relay/recovery with bounded cache and process cleanup. Obtain permitted M3U/XMLTV/media samples, required headers and provider sharing/concurrency terms to validate real behavior. Ambiguous signed-URL identity changes and provider completeness contracts remain open validation concerns. Majority-drop review cannot detect every logically incomplete export.
4. **Attach validated services:** connect real sources to shared upstream/recovery, encoder admission and disk cache; enforce per-viewer grants on every delivery, stop/revocation/handoff and crash recovery. Keep healthy streams independent of metadata refresh. One process only; no clustered admission or managed Plex encoder lifecycle.
5. **Later milestones:** track selection/preferences, persistent live shell and strict stop-live-before-VOD handoff, unified guide/channel editor, numbered custom-channel admission through `lineup_numbers`, episode synchronization and remaining admin curation. Production custom/IPTV streaming endpoints remain disabled; the media UI exposes real Plex catalog/VOD and IPTV metadata administration; live delivery remains disabled.
