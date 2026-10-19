# Android / Fire TV App — MVP Implementation Plan

Status: **research + design only**. No Android SDK is available in this environment, so this
milestone delivers the plan below, not a built APK. Building it later needs a machine with
JDK 17, Android SDK platform 34 and build-tools 34.

Goal: a sideloadable Android TV app for old Fire TV Sticks that browses the existing tk.box
web UI and plays live channels reliably — including devices whose WebView cannot play HLS.

## 0. Backend facts this plan relies on (verified in the repo)

- Session auth is **cookie-based** (`apps/server/src/app.ts`, `services/identity.ts`):
  `tk.box_local` over plain HTTP, `__Host-tk.box` over HTTPS (`secureCookies` is set only when
  `PUBLIC_BASE_URL` is configured — `config.ts`). Cookies are `httpOnly`, `SameSite=Lax`,
  expire after **12 h**.
- Non-GET requests must send `Origin` equal to `config.browserOrigin` (CSRF check) and
  `Content-Type: application/json`.
- Tuning: `POST /api/v1/live/sessions` `{channelId}` → `{id, streamUrl, channel, delivery, ...}`
  (`streamUrl` is **relative** — `/api/v1/live/sessions/{id}/index.m3u8` — and the server
  serves it as `application/vnd.apple.mpegurl`). The browser resolves it against the page
  origin; the native player must resolve it against the saved server origin.
  **Segments are MPEG-TS** (`video/mp2t`), cookie-authed.
- `DELETE /api/v1/live/sessions/{id}` stops the FFmpeg relay. Playlist requests fully
  reauthorize; segments use a lighter session check. Relay routes are rate-limited.
- IPTV channels are strictly live. Custom Plex channels additionally offer pause/resume/go-live
  (`/pause`, `/resume`, `/go-live`) and per-program WebVTT subtitles.
- The web player (`apps/web/src/player.tsx`) plays `*.m3u8` via **hls.js over MSE**, with
  native HLS only as fallback. DRM is never used or bypassed anywhere; the relay emits
  plain HLS, so DRM is out of scope by construction (never strip or bypass Widevine/PlayReady).

## 1. Target devices and platform levels

| Fire OS | Android | API | Devices (relevant) |
|---|---|---|---|
| 5 | 5.1 | 22 | Fire TV Stick 1st/2nd gen (2014/2016) — **32-bit ARM**, 1 GB RAM; Fire TV 2nd gen box (2015) — 32-bit, 2 GB |
| 6 | 7.1 | 25 | Fire TV 3rd gen pendant (2017), Cube 1st gen (2018); 2018 Stick 4K shipped here, later updated |
| 7 | 9 | 28 | Fire TV Stick 3rd gen (2020), Stick 4K / 4K Max, Cube 2nd/3rd gen |

- Fire TV Sticks in the field run Fire OS 5–7 (API 22/25/28). Only pre-2015 boxes still on
  Fire OS 3/4 (API 17/19) are lost by `minSdk 22` — acceptable; their WebView/GPU are too
  old to be worth supporting.
- **minSdk 22 trade-offs**: everything we need — Media3 (`minSdk 21`), OkHttp 4
  (`minSdk 21`), the leanback-ish WebView pattern — works at 22. Going lower buys only
  pre-Fire-OS-5 boxes, forces ExoPlayer 2.x (Media3 starts at 21) and an older WebView:
  not worth it. `targetSdk 34`, `compileSdk 34`.
- 32-bit ARM: Fire TV Stick 1st/2nd gen are `armeabi-v7a`. Media3 and OkHttp are pure
  Java/Kotlin (no native code), so one universal APK works on both ABIs. If native code is
  ever added (e.g. FFmpegKit), ship `armeabi-v7a` + `arm64-v8a` splits.
- RAM is 1–1.5 GB on the sticks in scope: keep the app single-process, no background
  services, and one ExoPlayer instance at a time.

## 2. Packaging options

| | (a) Plain WebView wrapper | (b) Capacitor | (c) Hybrid: WebView UI + Media3 player |
|---|---|---|---|
| Code reuse | ~100% | ~100% | ~100% of UI; small native layer |
| Maintenance | trivial shell | capacitor core + plugins to track | one activity + client, ~500 LOC |
| Playback reliability | **fails on old Fire OS** (see §3) | same WebView limitation | **good** — Media3 handles HLS/TS |
| D-pad / TV support | poor (mouse-oriented web UI) | poor | natively acceptable; focus fixes in web UI later |
| APK size | ~3–6 MB | ~10–15 MB | ~8–12 MB |
| Build complexity | lowest | medium (Capacitor toolchain) | low (plain Gradle, no extra toolchain) |

**Recommendation: (c).** Options (a)/(b) ship a TV app whose core feature — live playback —
does not work on the target devices. The shell can keep ~100% UI reuse; only the player is
native. Build a thin wrapper on top of the existing API contract, keep the web app as the
single UI source, and let native code do one job: reliable playback (§3).

## 3. Playback: why WebView video fails, and the Media3 handoff

**WebView limits on Fire OS 5/6/7:**
- Android WebView has no native HLS support. hls.js needs MSE (`MediaSource`); Amazon's
  embedded WebView on Fire OS 5/6 does not reliably expose a usable MSE path for HLS (Silk
  does, the WebView does not), and newer WebViews still cannot demux MPEG-TS. Result:
  `*.m3u8` playback in the WebView is unreliable at best.
- MPEG-TS (`video/mp2t`) is playable in **no** Android WebView — no TS demuxer. The relay's
  segments are MPEG-TS, so the WebView cannot play them even if the playlist loaded.
- Codecs on Fire TV hardware: H.264 (baseline/main) is universally supported; HEVC only on
  Fire OS 7-era devices; AAC-LC is safe. Since the relay transcodes/remuxes to H.264/AAC,
  H.264/AAC is all the native player must guarantee. DRM: out of scope, never bypass.

**Why Media3/ExoPlayer:** `androidx.media3:media3-exoplayer-hls` downloads `index.m3u8`
itself and demuxes the MPEG-TS segments with the built-in `TsExtractor` (`HlsMediaSource` /
`DefaultMediaSourceFactory` auto-detects HLS by URI). It is pure Java — runs on 32-bit ARM
with 1 GB RAM — and is the standard Android playback stack. WebView stays for UI only; even
Fire OS 5 gets reliable playback.

**Handoff:** the web UI already performs the whole tune flow (POST session, then plays
`streamUrl`). Two ways to hand it to native, in order of preference:

1. **Explicit hook (recommended, one small web PR).** Add `window.tkbox.onChannelRequest`
   to the player: when defined, the web app calls
   `window.tkbox.onChannelRequest({channelId, streamUrl, sessionId})` instead of starting
   hls.js. The Android shell defines it and starts `PlayerActivity`. This avoids a second
   player and gives the web app a clean TV mode.
2. **Fetch shim (zero web changes, MVP fallback).** On `onPageFinished`, wrap `window.fetch`:
   when a response to `POST /api/v1/live/sessions` carries `{id, streamUrl}`, call
   `Android.playStream(streamUrl, sessionId)`; native starts `PlayerActivity` (resolving the
   relative URL against the saved origin and playing HLS with cookies). The web player still
   receives the response and may show a playback error behind the native player; reload the
   WebView when the player closes.

Either way, `DELETE /api/v1/live/sessions/{id}` runs natively on player exit, so the FFmpeg
relay is released. The bridge contract in §7 is the same for both.

## 4. D-pad, focus, Back, overscan, launcher

- **Focus**: Fire TV remotes send `KEYCODE_DPAD_*`, which Chromium maps to arrow keys and to
  DOM focus movement — no injected key handling is the baseline. Keep the web UI's focusable
  elements in DOM order (they already are), give the WebView focus at start, and keep the
  existing `:focus-visible` outline visible. `KEYCODE_DPAD_CENTER` clicks the focused element,
  which opens the IME for text inputs.
- **Back button** (`OnBackPressedCallback`, androidx.activity): in the WebView activity —
  `canGoBack()` first (web history), else exit. In `PlayerActivity`, Back stops playback,
  `DELETE`s the session, and returns to the WebView — never web-history inside the player.
- **Overscan / safe area**: Amazon recommends 5% title-safe margins. Apply 5% padding to the
  WebView activity root and to the player's control overlay; the video surface stays
  full-bleed. No insets plumbing.
- **Leanback launcher**: the launcher activity's intent-filter needs
  `android.intent.action.MAIN` + `android.intent.category.LEANBACK_LAUNCHER` (not the phone
  `LAUNCHER`) and `android:banner` (320×180 px drawable, e.g. the tk.box logo + wordmark on
  dark). Because the app is TV-only, declare
  `android.software.leanback` `required="true"`, and declare
  `android.hardware.touchscreen` `required="false"` (touchscreen not required).
- `android:keepScreenOn` while playing; react to `ACTION_HEADSET_PLUG`/volume keys only if
  needed (not in MVP).

## 5. Sessions, login, networking

- **Cookie sharing**: WebView and OkHttp share the process-wide Android `CookieManager`
  (`CookieManager.getInstance()`). `httpOnly` cookies are stored by CookieManager (only JS
  is barred from reading them), so signing in inside the WebView (the existing Plex PIN flow)
  automatically authenticates native requests. OkHttp gets a `JavaNetCookieJar(CookieManager)`;
  no manual cookie plumbing.
- **CSRF/JSON**: native POSTs (`/live/sessions`, pause/resume later) must send
  `Origin: <server origin>` and `Content-Type: application/json` — the same rules the web
  app obeys. `SameSite=Lax` is not an issue: playlist/segment requests are same-site (same
  host as the page origin).
- **LAN vs HTTPS**: LAN dev hosts run plain HTTP (`APP_HOST`/`APP_PORT`, cookie
  `tk.box_local`). Fire OS 7 (API 28) blocks cleartext by default: set
  `android:usesCleartextTraffic="true"` **only** in a `debug` manifest overlay and keep the
  release manifest cleartext-free, or use a `network_security_config` allowing cleartext for
  LAN hosts explicitly. Remote deployments use `PUBLIC_BASE_URL` (HTTPS-only by validation)
  with `__Host-` secure cookies — no cleartext needed.
- **Certificates**: user-installed CAs are not trusted by default at API 24+. For a
  self-signed LAN cert, either install the CA as a system cert on the Fire TV (adb, not
  user-friendly) or — recommended — run TLS with a public/Let's Encrypt cert, or plain HTTP
  on LAN only. Do not ship a custom TrustManager that accepts anything.
- **Server address entry**: first-run screen with a URL field + "Test connection"
  (`GET /api/v1/setup` + `/health`), persisted in DataStore/SharedPreferences. Keep a
  last-used list. **mDNS** (`NsdManager`, `_http._tcp` browse) is optional and explicitly
  deferred — manual entry is the MVP.
- 12 h session expiry: on 401 the WebView redirects to sign-in; a "Session expired, sign in
  again" overlay in the shell re-loads the origin.

## 6. Sideloading and updates

- **Install routes** (no Play Store):
  - `adb connect <tv-ip>:5555 && adb install app-debug.apk` — requires ADB debugging on the
    Stick (Settings → My Fire TV → About → click 7× → Developer options → ADB debugging).
  - AFTV **Downloader** app: use it to fetch the APK on-device (Downloader itself is
    sideloaded once via adb, or installed from Amazon's Appstore where available).
  - Fire OS 5/6: Settings → Applications → Unknown sources. Fire OS 7: Developer options →
    Install unknown apps → allow for Downloader.
- **versionCode strategy**: strict monotonic integer, `versionCode = 10000*major + 100*minor
  + patch` (e.g. 1.2.3 → 10203); never decrease it on a release you have shipped.
- **In-app update check**: on launch (throttled to once/day), `GET <server>/tv/update.json`
  — a static manifest (served from the tk.box server's web root or any static host):
  `{"versionCode": 10203, "versionName": "1.2.3", "apkUrl": "https://…/tkbox-tv-1.2.3.apk", "sha256": "…"}`.
  If `versionCode` > installed: download to `getExternalFilesDir`, verify sha256, then
  `FileProvider` + `ACTION_INSTALL_PACKAGE` (`REQUEST_INSTALL_PACKAGES` permission, Fire OS 7;
  plain `ACTION_VIEW` intent works at API 22). No Play Store dependency anywhere.

## 7. MVP scope

`android/` at the repo root, fully separate from the npm workspace (no `package.json`
changes; the server build ignores it).

```
android/
├─ settings.gradle.kts          # pluginManagement repositories: google(), mavenCentral()
├─ build.gradle.kts             # AGP 8.5.2, Kotlin 2.0.20
├─ gradle.properties            # org.gradle.jvmargs=-Xmx2g; android.useAndroidX=true
└─ app/
   ├─ build.gradle.kts          # compileSdk 34, minSdk 22, targetSdk 34
   └─ src/main/
      ├─ AndroidManifest.xml    # LEANBACK_LAUNCHER, banner, no touchscreen requirement
      ├─ res/drawable/banner.png # 320×180
      └─ java/com/tkbox/tv/
         ├─ MainActivity.kt     # WebView host (launcher); loads saved server origin
         ├─ TvWebViewClient.kt  # page lifecycle, error page, fetch-shim injection
         ├─ ChannelBridge.kt    # @JavascriptInterface("Android") bridge
         ├─ PlayerActivity.kt   # Media3 ExoPlayer (HLS), session stop on exit
         ├─ SessionApi.kt       # OkHttp: cookie jar, Origin/JSON headers, POST+DELETE session
         ├─ ServerStore.kt      # DataStore: url, last-used
         └─ UpdateChecker.kt    # manifest check + installer
```

- **Toolchain** (modern build machine): JDK 17, Gradle 8.9, AGP 8.5.2, Kotlin 2.0.20,
  `androidx.media3:media3-exoplayer-hls:1.4.1` (1.5+ requires compileSdk 35),
  `com.squareup.okhttp3:okhttp:4.12.0`, `androidx.activity:activity-ktx`,
  `androidx.webkit:webkit`.
- **Key classes**:
  - `MainActivity`: `WebView` (JavaScript + DOM storage enabled), loads `origin/`; injects
    `ChannelBridge` and the fetch shim in `TvWebViewClient.onPageFinished`; Back =
    `canGoBack()` → history, else exit.
  - `TvWebViewClient`: injects `fetch` wrapper; renders an offline/error page when the origin
    is unreachable; restarts the activity on renderer death (`onRenderProcessGone`, API 26+;
    on older devices the whole process dies — the launcher activity is the recovery path).
  - `ChannelBridge`: `@JavascriptInterface fun playStream(streamUrl: String, sessionId: String)`
    → starts `PlayerActivity` with extras; `@JavascriptInterface fun isTv(): Boolean` → `true`
    (lets future web hooks detect the shell).
  - `PlayerActivity`: `ExoPlayer.Builder(context).build()`, `DefaultMediaSourceFactory`,
    `PlaybackException` → toast + finish (and `DELETE` session); `onDestroy` → release +
    `DELETE`. `setWakeMode(C.WAKE_MODE_NETWORK)` + `keepScreenOn`, and
    `setHandleAudioBecomingNoisy(true)`.
  - `SessionApi`: `POST /api/v1/live/sessions` `{channelId: String}` with `Origin` + JSON
    headers, cookie jar on; `DELETE /api/v1/live/sessions/{id}` with the same headers and an
    empty `{}` JSON body (the server's CSRF hook requires both on every non-GET), treating
    404/409 as success (the relay may already have been reaped).
- **JS bridge contract** (the future web hook; the fetch shim implements it today):
  `window.Android.playStream(streamUrl, sessionId)` — native takes over playback of an
  already-created session; `window.Android.isTv()` — feature detection; the session delete is
  native on exit, idempotent if the server already reaped it. No web-app source changes in MVP.

## 8. Risks and phased plan

**Risks**
- WebView generation skew on Fire OS 5 (Chromium ~M61-era): parts of the web UI may render
  poorly. Mitigate: prioritize Fire OS 7 dev/testing; treat 5/6 as best-effort with an in-app
  compatibility banner; never depend on WebView video.
- Session leak: if the app is force-stopped, the `DELETE` never fires and the FFmpeg relay
  keeps running. The server has stream ownership/reaping (`LiveTv.stop`, session tracking) —
  verify idle-timeout behavior during phase 2 and surface a server fix if missing.
- 12 h cookie expiry: long-running TV in the living room will hit sign-out; the 401 overlay
  re-auth flow must be frictionless.
- `SameSite=Lax` + OkHttp: requests to the same host are same-site, but verify with a real
  Stick early (phase 1 acceptance).

**Phases**

| Phase | Scope | Acceptance | Effort |
|---|---|---|---|
| 1 MVP | WebView shell, server URL entry, fetch shim, `PlayerActivity` (HLS+TS), session delete, leanback launcher, banner, cookies | On a Fire TV Stick 4K (Fire OS 7): sign in, tune a 10-channel source, zap < 3 s, Back exits playback and stops the relay, relaunch keeps the session; on a Stick 2nd gen (Fire OS 5): same, no crash | 2–3 weeks part-time |
| 2 Playback robustness | Feed failover (re-POST with next `channel.feeds` id on 4xx/stall), stall watchdog (port `LivePlaybackWatchdog`), error surfaces, verify idle reaping | 24 h soak on 3 channels, mixed lossy WiFi; auto-switch to backup feed; no relay leaks, no memory growth | 1–2 weeks |
| 3 Polish | Pause/resume/go-live for custom channels (existing endpoints), VOD playback via native player, in-app update UI + manifest, `session expired` overlay, web PR for explicit `onChannelRequest` hook, mDNS (optional) | Custom-channel pause survives 5 min, resume/Golive correct; update installs over 2 released versions; hook replaces shim | 2–3 weeks |

## 9. Environment note

No Android SDK (no `sdkmanager`, platform-tools, emulator) exists in this environment, and
no Android build was run. This document is the milestone deliverable; the repo tree and the
backend contract above are verified, but every Android build/toolchain claim (§7) is
standard-practice, not exercised here.
