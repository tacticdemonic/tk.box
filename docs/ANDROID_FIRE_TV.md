# Android / Fire TV App — M03 implementation

Status: **implemented and exercised in M03/M03.1 on `feature/firetv-mvp` and
`feature/m03-firetv-hardening`; M03.2 resolves the physical-Stick CSRF rejection and is ready
for retest.** The `android/` project builds a debug APK, automated tests cover the
native-playback, cookie, origin and cleanup rules, and the flow was driven end to end on an
**Android TV API 28 emulator whose WebView is Chromium 66** — the same generation as Fire OS 5/6.
Real Fire TV hardware is still **pending** (§9); M03.2's origin fix is verified by server tests
and emulator reruns, not by a physical device.

## 1. Device targets

| Fire OS | Android | API | Devices in scope |
|---|---|---|---|
| 5 | 5.1 | 22 | Fire TV Stick 1st/2nd gen, Fire TV 2nd gen box — 32-bit ARM, 1–2 GB RAM |
| 6 | 7.1 | 25 | Fire TV 3rd gen pendant, Cube 1st gen |
| 7 | 9 | 28 | Stick 3rd gen, Stick 4K / 4K Max, Cube 2nd/3rd gen |

`minSdk 22`, `compileSdk 34`, `targetSdk 34`. Media3, OkHttp and the shell are pure JVM code,
so one universal APK covers `armeabi-v7a` and `arm64-v8a`. Pre-2015 Fire OS 3/4 boxes are out
of scope.

Toolchain used to build and test this milestone: JDK 17 (Temurin 17.0.20.1), Gradle 8.9,
AGP 8.5.2, Kotlin 2.0.20, Android SDK platform 34, build-tools 34.0.0, Media3 1.4.1,
OkHttp 4.12.0. Media3 1.5+ requires `compileSdk 35`; 1.4.1 is the newest line that builds
against platform 34.

## 2. Project layout

```
android/
├─ settings.gradle.kts, build.gradle.kts, gradle.properties
├─ gradlew, gradlew.bat, gradle/wrapper/    # Gradle 8.9 wrapper
└─ app/
   ├─ build.gradle.kts                      # minSdk 22, debug ALLOW_CLEARTEXT=true, release=false
   └─ src/
      ├─ main/AndroidManifest.xml           # LEANBACK_LAUNCHER, banner, no touchscreen
      ├─ debug/AndroidManifest.xml          # cleartext HTTP for LAN development only
      ├─ main/res/                          # banner.png (320×180), app_icon, theme
      ├─ main/java/com/tkbox/tv/
      │  ├─ MainActivity.kt                 # WebView host, server setup, bridge, Back
      │  ├─ PlayerActivity.kt               # one Media3 HLS player, session release
      │  ├─ OriginPolicy.kt                 # origin/URL/cleartext rules
      │  ├─ BridgeValidator.kt              # JavaScript bridge input validation
      │  ├─ OriginCookieInterceptor.kt      # origin-scoped Cookie injection
      │  ├─ WebViewCookies.kt               # WebView CookieManager snapshot
      │  ├─ SessionClient.kt                # /health probe, authenticated session DELETE
      │  ├─ PlaybackLifetime.kt            # one relay release per player
      │  ├─ ServerConfigStore.kt            # persisted server origin
      │  └─ TvViews.kt                      # D-pad-focusable TV controls
      └─ test/java/com/tkbox/tv/            # origin, bridge, cookie/media, lifetime tests
```

The project is outside the npm workspace: no `package.json`, server or build-script changes
reach the Node application.

## 3. Playback architecture

The WebView renders the existing React UI unchanged. Playback differs by platform:

```mermaid
sequenceDiagram
    participant Web as React UI (WebView)
    participant Shell as TkBoxNative bridge
    participant Server as tk.box server
    participant Exo as PlayerActivity (Media3)
    Web->>Server: POST /api/v1/live/sessions {channelId}
    Server-->>Web: {id, streamUrl: /api/v1/live/sessions/{id}/index.m3u8}
    Web->>Shell: playLiveStream({sessionId, streamUrl, title})
    Shell->>Shell: validate origin + path, snapshot WebView cookies
    Shell->>Exo: start PlayerActivity (singleTop)
    Exo->>Server: GET playlist + MPEG-TS segments (Cookie, same origin)
    Note over Web: url="" for PersistentPlayer — no second playback
    Exo->>Server: DELETE /api/v1/live/sessions/{id} (Back, error, stop, onStop)
    Exo-->>Web: tkbox:native-playback {state, sessionId, code}
    Web->>Server: DELETE again (idempotent; 404/409 accepted)
```

- The web app still tunes through `LiveFailover` (feed selection and retry stay in one place).
- `apps/web/src/native-player.ts` is the explicit interface: detection
  (`window.TkBoxNative.playLiveStream`), a strict handoff payload, `stopLiveStream`, and a
  `tkbox:native-playback` event listener. Nothing patches `window.fetch`.
- No bridge → `beginNativePlayback` returns `undefined`, `PersistentPlayer` gets the real
  `streamUrl`, and hls.js behaves exactly as before. This is covered by
  `tests/firetv-bridge.test.ts`.
- With a bridge, `PersistentPlayer` is passed `url=""`, so hls.js never attaches and the
  playlist is fetched once, by ExoPlayer.
- `PlayerActivity` is `singleTop`: a second handoff (`onNewIntent`) releases the old relay and
  rebuilds the player in place, so a rapid re-tune never leaves two relays. Back is the route to
  the guide; the native player handles Play/Pause itself. It releases ExoPlayer and deletes the session on Back, on a playback error,
  on a page `stopLiveStream()` call, and in `onStop` (Home, app switch, backgrounded).
- H.264 video and AAC audio are demuxed from MPEG-TS by Media3's built-in `TsExtractor`;
  `DefaultLoadControl` buffers 15 s with a 60 s cap for slow Wi-Fi.

## 4. Authentication and cookies

WebView's `android.webkit.CookieManager` and OkHttp's cookie store do not share data.
`WebViewCookies` snapshots `CookieManager.getCookie(origin)` on page load, before a handoff, and
on resume, and `OriginCookieInterceptor` adds that snapshot as a `Cookie` header **only** to
requests whose scheme, host and port match the configured origin. Cookie values are never
logged, returned to JavaScript or written anywhere else.

WebView 66's `getCookie()` **omits SameSite cookies** — measured on the API 28 image, where a
`p_lax` cookie was invisible while `p_plain` and `p_httponly` were returned. Because the session
cookie used to be `SameSite=Lax`, the snapshot was empty and every native playlist request
answered 401. Two changes fix that:

- The server sets no `SameSite` attribute on the session cookie (browsers default it to `Lax`),
  so `getCookie()` returns it. `httpOnly` and `Secure` on a public origin are unchanged.
- `WebViewCookies.observe()` records the `Cookie` header of any same-origin request the WebView
  itself makes (`shouldInterceptRequest`), so the native player reuses exactly what the page
  sent even on a WebView that hides some cookies from `getCookie()`. Sign-out clears the
  snapshot before reloading.

- The session cookie stays `httpOnly`: page JavaScript cannot read it. The bridge exposes
  only `playLiveStream`, `stopLiveStream`, `isTv`, `logout`.
- `POST`, `DELETE` and other non-GET calls send `Origin: <configured origin>` and
  `Content-Type: application/json` with a `{}` body, matching the server's CSRF hook.
- `DELETE /api/v1/live/sessions/{id}` treats 200/204 as stopped, 404/405/409 as already gone,
  and 401/403 as an expired session.
- Sign-out clears `CookieManager` and reloads the origin. A native 401/403 event is forwarded
  to the page as `code: "UNAUTHENTICATED"`, which drops the session and reloads `/me`.
- WebView settings: JavaScript and DOM storage on; `allowFileAccess`, `allowContentAccess`,
  `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs` off;
  `MIXED_CONTENT_NEVER_ALLOW`; no multiple windows; no third-party cookies.
- Navigation and subresource loads outside the configured origin are blocked
  (`shouldOverrideUrlLoading` and `shouldInterceptRequest`).
- Plain HTTP is accepted only when `BuildConfig.ALLOW_CLEARTEXT` is true, which is the debug
  build only. The release manifest sets `usesCleartextTraffic="false"`, and `OriginPolicy`
  independently requires HTTPS. No custom `TrustManager` or hostname verifier exists.
- Release builds keep `android:allowBackup="false"` so the WebView cookie store is not backed
  up off-device.

## 5. First-user administrator safeguard (server)

M02 let the first Xtream identity bootstrap the administrator on any Plex-less deployment.
That is a race on a public host: whoever signs in first owns the instance. M03 adds
`INITIAL_ADMIN_TOKEN`; M03.1 also applies it to a LAN listener:

- `INITIAL_ADMIN_TOKEN` (16–256 chars, optional). `loadConfig` refuses to start a Plex-less
  deployment without it when **anything other than loopback** can reach the listener:
  `PUBLIC_BASE_URL`, `DEPLOYMENT_MODE=remote`, or an `APP_HOST` that is not a loopback address.
  `0.0.0.0`, `::`, and any LAN IP count as reachable even with `DEPLOYMENT_MODE=local`, because
  the label does not stop another device connecting.
- Loopback-only development (`127.0.0.0/8`, `::1`, `localhost`) keeps the zero-configuration
  first-user flow.
- The first Xtream login on an empty installation must present `bootstrapToken` matching the
  configured token (constant-time comparison of SHA-256 digests). A wrong or missing token is
  rejected **before** the provider panel is contacted.
- After an administrator exists, the token is ignored: later logins need no token and are
  viewers, exactly as in M02. Plex-configured deployments are unchanged.
- The token is read from configuration only. It is never logged, never written to SQLite, and
  never echoed in an error or the `/api/v1/setup` answer; only the boolean
  `bootstrapTokenRequired` is exposed.
- `GET /api/v1/setup` returns that boolean so the login screen shows the field only when needed.
  Tests: `tests/security.test.ts` ("a Plex-less deployment reachable from another device always
  needs the bootstrap token") and `tests/xtream-live.test.ts` ("the first provider identity
  becomes administrator only with an owner-controlled bootstrapping rule").

## 6. Fire TV remote and WebView compatibility

- Arrow keys move focus geometrically (`apps/web/src/tv-navigation.ts`) only when the shell is
  present (`window.TkBoxNative`). `<select>` and range inputs keep native arrow behaviour;
  text fields keep Left/Right for the caret and can move out vertically. Enter on an empty
  focus starts at the first control; the IME opens for text fields as usual.
- Back: the page closes an open dialog first (`window.TkBoxTv.handleBack`), then the shell
  walks WebView history, then exits.
- Focus is visible: 3 px accent ring, offset 4 px, plus a tinted background on guide cells.
  The shell adds `.tv-mode`, which applies 3.5 v/h overscan padding.
- Stopping playback returns focus to the control that started it, or to the current section's
  nav link when the row was re-rendered while the native player was up (hashchange in
  `tv-navigation.ts`).
- The skip link stays keyboard-only; it is excluded from TV focus so the remote never lands on
  invisible navigation.

### WebView compatibility (measured, not assumed)

Chromium 66 on an Android TV image exposed four real failures, each fixed and re-verified:

| Failure | Cause | Fix |
|---|---|---|
| Blank page, no API calls | `globalThis` undefined aborts the bundle | polyfill in `compat.ts`, imported first |
| `[9,15].flatMap is not a function` | React's JSX transform uses `flat`/`flatMap` (Chrome 69) | polyfills |
| Bundle parse error on `BigInt` | one runtime import of `qualityTiers` pulled all of zod in | `packages/contracts/src/quality-tiers.ts` is zod-free; the player imports it |
| Nav labels collide, zero padding | `clamp()` (Chrome 79) and `min()` unsupported; inside a custom property an invalid value is accepted and then computes to nothing | `.legacy-css` class applied by a layout probe, with plain fallbacks |

`gap` is the subtle one: `@supports (gap: 1px)` is **true** on Chromium 66 because *grid* gap
exists, while *flex* gap does not. `compat.ts` therefore measures real layout and adds
`.legacy-flex-gap`, whose rules are flat `.legacy-flex-gap .selector{margin-left:…}` — CSS
nesting is not available on that WebView either.

The Vite build targets `chrome61` + `es2018`. `tests/firetv-navigation.test.ts` asserts the
target, the polyfills and the fallback hooks. The app logs one line,
`TkBoxCompat flexGap=… modernCss=… chrome=…`, so a UAT log states the WebView's capabilities
without any credential.

### CSRF from an old WebView

Chromium 66 replaces the page's `Origin` header with the literal `null` on `fetch`, and adds
`X-Requested-With: <package>`. `WebSettingsCompat.setRequestedWithHeaderOriginAllowList`
(WebView 83+) fixes that but is unavailable here, so the server accepts
`Origin: null` **plus** the shell's exact `X-Requested-With: com.tkbox.tv` as an equivalent CSRF
signal. The page also sets that header itself on every non-GET `api()` call when
`window.TkBoxNative` is present (`apps/web/src/api.ts`), so the marker does not depend on a
particular WebView build adding it, and `SessionClient.stop` sends it with the session `DELETE`.
A repeated value (`com.tkbox.tv, com.tkbox.tv`, page plus WebView) still matches one package.
Any other value, or a request with no marker, is rejected, as is any
`Sec-Fetch-Site` other than `same-origin`/`none` (cross-site fetch metadata kills the exception
even with the right marker).

The marker exception is only needed when the WebView cannot send a real Origin. A modern Fire OS
WebView sends `Origin: http://<server>:<port>`, which is checked against the configured origin
instead; the two paths never overlap.

Why a hostile page cannot use it:

- Setting a custom request header forces a CORS preflight, and this server answers no preflight
  with `Access-Control-Allow-Origin`, `-Headers` or `-Methods`, so the browser never sends the
  actual request.
- The exception accepts only the literal `null` origin; a real foreign origin, even with the
  marker, is rejected.
- The session cookie omits `SameSite`, and modern browsers default that to `Lax`, so it is not
  attached to a cross-site request. (The attribute is omitted deliberately: WebView 66's
  `CookieManager.getCookie()` hides SameSite cookies, which stopped the shell handing the session
  to the native player. See §4.)

**Revisit these assumptions if CORS changes.** Any future `Access-Control-Allow-Origin: null`,
wildcard origin with credentials, or `Access-Control-Allow-Headers: x-requested-with` would let a
sandboxed iframe or foreign page satisfy the marker itself; at that point the exception must be
removed, or gated on something a page cannot forge. The same applies if `cookieOpts.sameSite`
ever weakens from `lax`. Tests: `tests/security.test.ts`, "the Fire TV shell CSRF marker…", and
`tests/csrf-origin.test.ts`.

### Server origin configuration for LAN and Fire TV

`APP_HOST` is the **listen** address. It is not the browser origin, and a wildcard
(`0.0.0.0`, `::`) can never appear in an `Origin` header. The browser-facing origin is resolved
in this order:

1. `PUBLIC_BASE_URL` (HTTPS only; required for `DEPLOYMENT_MODE=remote`),
2. `APP_ORIGIN` (HTTP or HTTPS, e.g. `http://192.168.1.10:3000` for LAN debugging),
3. `http://<APP_HOST>:<APP_PORT>` for loopback and single-address binds.

Set `APP_ORIGIN` whenever `APP_HOST` is a wildcard, or the server cannot know which LAN address
the Fire Stick and browsers type. Both values are normalized to their RFC 6454 serialization
(no trailing slash, default port omitted), so `PUBLIC_BASE_URL=https://tv.example.com/` matches
an `Origin: https://tv.example.com`. `APP_ORIGIN` and `PUBLIC_BASE_URL` must agree when both are
set, wildcard hosts and credentials/paths/queries are rejected at startup, and a wildcard bind
without either logs a warning. Secure cookies follow HTTPS (`PUBLIC_BASE_URL` or an HTTPS
`APP_ORIGIN`); LAN HTTP debug keeps plain cookies. No wildcard origin, dynamic origin or CORS
allowance is introduced.

### CSRF rejection diagnostics

`CSRF_DIAGNOSTICS=true` logs one structured warning per rejected state-changing request:

| Field | Contents |
|---|---|
| `requestId` | Fastify request id, for correlation with the 403 |
| `method`, `route` | HTTP method and matched route template; the query string is dropped |
| `originClass` | `missing`, `null`, `matched`, `mismatched`, `malformed` |
| `requestOrigin` | The normalized scheme/host/port, or `null`; never a path or query |
| `expectedOrigin` | The configured browser origin |
| `xRequestedWith` | `shell_package`, `absent`, `other` (other values are not echoed) |
| `secFetchSite` | `same-origin`, `same-site`, `cross-site`, `none`, `absent`, `other` |
| `androidShell` | Marker present, or the `TkBoxTV/<version>` user-agent token |
| `reason` | `cross_site_fetch_metadata`, `missing_origin`, `malformed_origin`, `null_origin_missing_marker`, `null_origin_invalid_marker`, `wildcard_bind_without_app_origin`, `origin_mismatch` |

Cookies, `Authorization`, request bodies, Xtream credentials, provider URLs and query strings are
never logged. Off by default. A `403 CSRF_REJECTED` with `mismatched` plus `wildcard_bind_without_app_origin`
means `APP_ORIGIN` is missing; `null_origin_missing_marker` means the WebView sent `Origin: null`
without the shell marker (the page bundle is older than this fix, or not running in the shell).

### Redirects and off-origin media

`SessionClient.client` builds the one OkHttp stack used for `/health`, session release, and
Media3's HLS data source. It sets `followRedirects(false)` and `followSslRedirects(false)`.
This is deliberate: `OriginCookieInterceptor` attaches the WebView's live session cookie as a
request header *after* OkHttp's own policy runs, so a followed 301/302/307/308 would replay that
header at the redirect target — including another origin, or HTTPS to HTTP. Before M03.1 that
happened: the regression test with two `MockWebServer` instances observed the cookie arriving at
the second, foreign server.

Now a redirect is surfaced as its own status instead of being followed, and the interceptor
throws for any request outside the configured origin, so an HLS manifest that names an absolute
foreign segment or key cannot be fetched either. Fail closed means a legitimate CDN redirect
also fails; the relay does not issue them. Tests: `SessionClientTest`
(`aCrossOriginRedirectIsNotFollowedAndKeepsTheCookieHome`, `anOffOriginMediaRequestIsRefusedOutright`,
`anOffOriginRedirectFromHttpsToHttpIsNotFollowed`,
`anHlsManifestThatNamesAForeignHostCannotBeFetched`) and `HlsAuthenticationTest`.

## 7. Build and test commands

```bash
# Node side
npm run typecheck
npx tsx --test tests/firetv-bridge.test.ts tests/firetv-navigation.test.ts
npx tsx --test tests/xtream-live.test.ts
npm test          # full suite, when releasing
npm run build

# Android side (JDK 17 + Android SDK 34)
cd android
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

### Emulator run (M03 and M03.1 evidence)

`android-28;android-tv;x86` under KVM, WebView 66.0.3359.158:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:<server-port> tcp:<server-port>   # server and synthetic panel stay on loopback
adb shell am start -n com.tkbox.tv/.MainActivity
```

Verified on that device **in M03.1** (synthetic Xtream panel, loopback server):

- first-run server entry with the IME, **Test connection** answering "Connected to …", then
  **Save and continue** loading the React app;
- Xtream sign-in on WebView 66 (the `Origin: null` + `X-Requested-With` CSRF path), then the
  Live TV guide with both channels, D-pad focus ring moving across header, filters and rows;
- tune handing off to `PlayerActivity`, H.264/MPEG-TS playback with the picture advancing
  (timestamp and frame counter moving), overlay hiding itself;
- the native playlist, every segment and the session `DELETE` carrying the session cookie —
  this is what failed before the SameSite/`observe` fix (§4);
- Back returning to the guide with the relay released, and a second channel tuning afterwards;
- the session surviving a force-stop/relaunch, with no re-login;
- a stopped server showing "Server unavailable" with Retry and Change address;
- an invalidated session returning to the sign-in screen instead of retrying the stream.

Verified in M03 (same image): launch from the Android TV launcher with its banner, offline
recovery, and the session surviving two relaunch cycles.

Not covered by either run: a physical Stick, Fire OS 5 specifically, HEVC, a real provider, and
12 h session expiry (the cookie's own expiry was simulated, not waited out).

## 8. Physical Fire TV Stick UAT

This checklist is for Astra/user testing on a real Stick. **Nothing below is claimed as passed**;
the emulator evidence in §7 is separate and does not cover a physical device (§9).

### 8.1 Record the device

Settings → My Fire TV → About → Fire TV Stick. Write down, for the UAT record:

| Field | Example |
|---|---|
| Model | Fire TV Stick (2nd gen) / 4K / 4K Max |
| Fire OS version | 5.2.9.x / 6.7.x / 7.6.x |
| Android API | 22 / 25 / 28 |
| WebView version | `adb shell dumpsys package com.amazon.webview \| grep versionName` |
| tk.box commit | the pushed M03.1 hash |
| APK SHA-256 | from `sha256sum`, must match the PR value |

Devices on Fire OS 5 (API 22) are the compatibility floor; a 1st/2nd-gen Stick is the most
useful test because it is the slowest.

### 8.2 Enable ADB and install

Settings → My Fire TV → About → click the device name **7 times** → Developer Options →
**ADB debugging on**, and **Apps from Unknown Sources on**. Find the address under
Settings → My Fire TV → About → Network.

```bash
adb connect 192.168.1.50:5555
adb devices                       # must say "device"; "unauthorized" = accept the prompt on screen

# Install the exact artifact whose checksum is recorded in the PR.
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell dumpsys package com.tkbox.tv | grep -E 'versionName|versionCode'   # expect 1.0.0 / 10000

# The server on the LAN: no adb reverse on a physical device.
# Confirm the Stick can reach it before blaming the app:
adb shell 'toybox nc -z -w 3 192.168.1.10 3000 && echo reachable || echo unreachable'
```

If a previous build is installed and behaves oddly, remove it first (`adb uninstall com.tkbox.tv`)
so the WebView cookie store and saved origin start clean.

### 8.2a Verify the server's browser-facing origin first

The Fire Stick failure in M03.1 (`403 CSRF_REJECTED`, "Request origin is not permitted") was a
server origin-configuration fault, not an Android one: `APP_HOST=0.0.0.0` was being used as the
expected browser origin, while the Stick sent `Origin: http://192.168.1.10:3000`. Run the server
like this for LAN testing (or use `PUBLIC_BASE_URL` for remote HTTPS):

```bash
# .env (Plex-less LAN test also needs INITIAL_ADMIN_TOKEN)
APP_HOST=0.0.0.0
APP_PORT=3000
APP_ORIGIN=http://192.168.1.10:3000    # exactly what the Stick enters, no trailing slash
CSRF_DIAGNOSTICS=true                  # temporary; remove after the retest
```

Confirm the server agrees before installing:

```bash
node --env-file=.env --import tsx -e \
  "import {loadConfig} from './apps/server/src/config.ts'; const c=loadConfig(); console.log({listen:c.listenHost+':'+c.listenPort, browserOrigin:c.browserOrigin, secureCookies:c.secureCookies})"
# expect { listen: '0.0.0.0:3000', browserOrigin: 'http://192.168.1.10:3000', secureCookies: false }
```

Then enter the **same** address (`http://192.168.1.10:3000`) on the Stick. If the two differ by
host, scheme or port, every sign-in and state change will be refused with 403 by design.

### 8.3 Focused M03.2 retest procedure

Run these ten steps in order on the device and record Pass/Fail plus what was seen. Any Fail:
capture the log and the CSRF diagnostic line (§8.4) before changing anything.

| # | Step | Pass condition |
|---|---|---|
| 1 | Verify the server address: `APP_ORIGIN` (or `PUBLIC_BASE_URL`) equals what the Stick will enter (§8.2a) | `browserOrigin` printed by the config check matches the address exactly |
| 2 | Confirm connectivity: `adb shell 'toybox nc -z -w 3 192.168.1.10 3000 && echo reachable'` | `reachable` |
| 3 | Install the exact APK whose SHA-256 is in the PR (`adb install -r …`), launch, enter the server address, **Test connection** → **Save and continue** | "Connected to …"; the React UI loads |
| 4 | Xtream sign-in (bootstrap token on a fresh Plex-less LAN server) | Signs in; no "Request origin is not permitted"; wrong token is refused on bootstrap |
| 5 | Confirm authenticated API requests: open Settings/account and the Live TV channel list | Data loads; no 401/403 loop; server log shows no `csrf origin rejected` |
| 6 | Browse the Live TV guide; move across header, filters and rows with the D-pad | Programme times/now marker render; focus ring always visible and moves in the pressed direction |
| 7 | Tune a channel (OK) | `PlayerActivity` opens; picture within a few seconds |
| 8 | Watch ≥60 s and check audio | A/V in sync, sound present, no stutter loop or green/black frames; overlay hides itself |
| 9 | Press Back | Returns to the guide with focus restored; the relay stops and the session directory disappears (`ls "$CACHE_DIR/live"`) |
| 10 | Force-stop (`adb shell am force-stop com.tkbox.tv`) and relaunch | No re-login; the server address and session survive |

Additional checks when time allows: a wrong server address shows a clear failure; keyboard/IME
in the search box; channel A → Back → channel B leaves one relay; server stopped shows "Server
unavailable" with Retry and Change address; invalidated session returns to sign-in; Home for
2 min then reopen leaves no stale player.

### 8.4 Capture diagnostics without credentials

With `CSRF_DIAGNOSTICS=true`, the server writes one line per rejected mutation:

```bash
journalctl -u tk.box -f | grep 'csrf origin rejected'      # systemd install
# or, for a foreground dev server: it is already on stdout

# What the Stick actually sends, captured without body or cookies:
adb shell settings get global http_proxy >/dev/null 2>&1 || true
adb logcat -c
# reproduce the failure, then:
adb logcat -d | grep -iE 'TkBox|tkbox|AndroidRuntime|Media3|ExoPlayer|chromium|console' > tkbox-firetv.log
adb shell dumpsys package com.tkbox.tv | grep -E 'versionName|versionCode' >> tkbox-firetv.log
adb shell dumpsys package com.amazon.webview | grep versionName >> tkbox-firetv.log
```

Read the diagnostic `reason`:

| `reason` | Meaning | Action |
|---|---|---|
| `wildcard_bind_without_app_origin` / `origin_mismatch` | Server expected an origin the Stick is not sending | Set `APP_ORIGIN` to the exact address the Stick uses (§8.2a); restart the server |
| `missing_origin` / `null_origin_missing_marker` | Old WebView sent no usable Origin and no shell marker | Confirm the installed APK contains the M03.2 bundle (`X-Requested-With` set by `api.ts`); reinstall |
| `null_origin_invalid_marker` | `Origin: null` with a different marker value | Reinstall the correct APK; do not relax the server |
| `cross_site_fetch_metadata` | `Sec-Fetch-Site` was `cross-site`/`same-site` | Something is proxying or rewriting the request; inspect the proxy |
| `malformed_origin` | Origin was not a bare scheme/host/port | Check the entered address |

The app logs no cookies, provider passwords or stream URLs, and the CSRF line carries no query
string, but WebView/Media3 framework lines can contain URLs. Scrub `Cookie:`, `password=`,
`token=` and provider usernames before sharing. Useful facts to include: device model, Fire OS
version, WebView version, the failing step, the full CSRF line, and whether the server was
reachable.

### 8.5 What to report back

For each failing row: checklist number, what happened, what was expected, the log file, the
exact APK SHA-256, and the tk.box commit. Physical acceptance stays **open** until these rows
are recorded by the tester.

## 9. Evidence, limitations and pending work

Implemented and verified in M03.1 on `feature/m03-firetv-hardening`:

- Android unit tests cover origin/URL rules, bridge input validation, cookie scoping,
  authenticated playlist and segment requests, one-time session release, and the redirect /
  off-origin refusal described in §6. `./gradlew testDebugUnitTest` and `assembleDebug` pass.
- Node tests cover the native bridge contract, browser fallback, TV navigation geometry, build
  target/polyfills, the bootstrap safeguard for loopback/LAN/remote, and the CSRF marker and
  preflight behaviour; typecheck and production build pass.

**Verified on the Android TV API 28 / WebView 66 emulator:** see §7, which records the exact
run. Automated test results and emulator observations are separate evidence; neither is a
physical-device result.

**Not verified — pending hardware UAT (§8):**

- Launch from the Fire TV launcher, D-pad feel, IME, and overscan on an actual Stick.
- Real HLS playback, buffering behaviour and codec compatibility on Fire OS 5 hardware.
- Session persistence across a real app restart and after a 12 h expiry.
- No claim of hardware compatibility is made until Astra/user testing on a physical device
  completes. Record device model, Fire OS version and the outcome in §8.1.

Known limitations:

- The native player owns the remote while it is on screen: it handles Play/Pause and Back, but
  channel up/down and the guide are reached by pressing Back first. The WebView's own channel
  stepper remains available in browser playback.
- Feed failover (`LiveFailover`) runs at tune time and on a WebView playback error. In native
  playback a failed stream returns to the guide with a message; automatic backup-feed retry
  inside `PlayerActivity` is deferred to M04, as is a stall watchdog.
- A redirect from the tk.box origin fails playback rather than being followed (§6). The relay
  does not redirect today; a future CDN hop would need an origin-restricted follow.
- Live TV only; VOD and custom-channel pause/resume stay in the WebView player (M04).
- No in-app update manifest or signed release pipeline yet (M05).
- Force-stop during playback skips the `DELETE`; the server's idle reaper is the fallback.
