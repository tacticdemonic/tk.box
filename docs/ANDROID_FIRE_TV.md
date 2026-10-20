# Android / Fire TV App — M03 implementation

Status: **implemented in M03 on `feature/firetv-mvp`**. The `android/` project builds a debug
APK, and every native-playback, cookie, origin and cleanup rule below is covered by automated
tests. Real-device UAT is **pending** — see §9. No claim in this document substitutes a build
or a unit test for a Fire TV.

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
`WebViewCookies` takes a snapshot of `CookieManager.getCookie(origin)` on page load, before a
handoff, and on resume, and `OriginCookieInterceptor` adds that snapshot as a `Cookie` header
**only** to requests whose scheme, host and port match the configured origin. Cookie values are
never logged, returned to JavaScript or written anywhere else.

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
That is a race on a public host: whoever signs in first owns the instance. M03 adds:

- `INITIAL_ADMIN_TOKEN` (16–256 chars, optional). `loadConfig` refuses to start a public or
  remote deployment (`PUBLIC_BASE_URL` or `DEPLOYMENT_MODE=remote`) without Plex configuration
  unless the token is set.
- The first Xtream login on an empty installation must present `bootstrapToken` matching the
  configured token (constant-time comparison of SHA-256 digests). A wrong or missing token is
  rejected **before** the provider panel is contacted.
- After an administrator exists, the token is ignored: later logins need no token and are
  viewers, exactly as in M02. Plex-configured deployments are unchanged; a local
  (`DEPLOYMENT_MODE=local`) Plex-less deployment keeps the zero-configuration first-user flow.
- `GET /api/v1/setup` returns `bootstrapTokenRequired` so the login screen can show the field
  only when it is needed. Tests: `tests/xtream-live.test.ts` ("the first provider identity
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
- Stopping playback returns focus to the control that started it (hashchange in
  `tv-navigation.ts`).
- Older WebViews: the Vite build targets `chrome61` + `es2018`, and `apps/web/src/compat.ts`
  fills only the builtins the bundle calls (`Object.fromEntries`, `Array.prototype.at`,
  `String.prototype.replaceAll`, `Promise.allSettled`, `AbortSignal.timeout/any`,
  `queueMicrotask`). `tests/firetv-navigation.test.ts` asserts the target and the polyfills.

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

## 8. Sideloading and UAT procedure

### 8.1 Identify the device

Settings → My Fire TV → About → Fire TV Stick. Note the model (e.g. "Fire TV Stick 4K") and
Fire OS version (e.g. Fire OS 7.6.x). Devices on Fire OS 5 (API 22) are the compatibility
floor for M03.

### 8.2 Enable ADB

Settings → My Fire TV → About → click the device name 7 times → Developer Options →
ADB debugging **on**. Note the device IP under Settings → My Fire TV → About → Network.

```bash
adb connect 192.168.1.50:5555
adb devices          # expect "device", not "unauthorized"
```

### 8.3 Install

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Fire OS 5/6 also needs Settings → Applications → Unknown sources for sideloaded updates;
the first `adb install` is enough for a fresh install.

### 8.4 First launch

1. The app opens directly on the server screen (no browser).
2. Enter the tk.box address with the remote and the on-screen keyboard, e.g.
   `https://tv.example.com` or, in a debug build on a LAN, `http://192.168.1.10:3000`.
3. Select **Test connection** — expect "Connected to …".
4. Select **Save and continue** — the tk.box sign-in screen loads inside the app.

### 8.5 Sign in

- **Xtream:** expand "Sign in with an Xtream provider", enter the panel address, username and
  password. If the server requires an initial administrator token, the field appears; enter
  the operator's `INITIAL_ADMIN_TOKEN`.
- **Plex:** if the backend has Plex configured, use the Plex button and complete the PIN on a
  phone or computer; the app polls and signs in automatically.

### 8.6 Browse and tune

Live TV → D-pad to a channel (the accent ring follows) → **OK** to tune. The WebView shows
"Playback is running in the TV player" while the native activity plays the channel. Channel
up/down on the remote changes channels through the existing lineup order.

### 8.7 Verify the acceptance points

| Check | Expected |
|---|---|
| Playback | Picture and sound within a few seconds; "Buffering…" only briefly |
| D-pad | Focus moves between nav, filters, channel rows and player controls |
| OK | Opens details or starts the channel; opens the IME on text fields |
| Back in a dialog | Closes the dialog, stays on the page |
| Back in playback | Returns to the channel list; the server relay stops |
| Channel switch | Back to the guide, then tune another channel: the old relay stops before the new player starts |
| Relaunch | Server address and session persist; no re-login within 12 h |
| Server down | "Server unavailable" screen with Retry and Change address |
| Logout | Returns to sign-in; cookies cleared |

### 8.8 Capture logs without credentials

```bash
adb logcat -c
# reproduce the issue, then:
adb logcat -d | grep -iE 'tkbox|AndroidRuntime|Media3|ExoPlayer' > tkbox-firetv.log
```

The app never logs cookies, provider passwords or stream URLs. Review the file before sharing;
WebView and Media3 may still include URLs in framework logs, so scrub any `Cookie:` or
`password=` values.

## 9. Evidence, limitations and pending work

Implemented and verified here:

- Android project builds with `./gradlew testDebugUnitTest` and `assembleDebug`; 16 unit tests
  for origin/URL rules, bridge input validation, cookie scoping, authenticated playlist and
  segment requests, and one-time session release pass.
- Node tests cover the native bridge contract, browser fallback, TV navigation geometry, build
  target/polyfills and the bootstrap safeguard; typecheck and production build pass.

**Not verified — pending hardware UAT:**

- Launch from the Fire TV launcher, D-pad feel, IME, and overscan on an actual Stick.
- Real HLS playback, buffering behaviour and codec compatibility on Fire OS 5 hardware.
- Session persistence across a real app restart and after a 12 h expiry.
- No claim of hardware compatibility is made until Astra/user testing on a physical device
  completes. Record device model, Fire OS version and the outcome in this section.

Known limitations:

- The native player owns the remote while it is on screen: it handles Play/Pause and Back, but
  channel up/down and the guide are reached by pressing Back first. The WebView's own channel
  stepper remains available in browser playback.
- Live TV only; VOD and custom-channel pause/resume stay in the WebView player (M04).
- No in-app update manifest or signed release pipeline yet (M05).
- Force-stop during playback skips the `DELETE`; the server's idle reaper is the fallback.
