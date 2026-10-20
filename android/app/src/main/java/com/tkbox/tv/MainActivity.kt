package com.tkbox.tv

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/**
 * The TV shell: a hardened WebView for the existing React UI and a native bridge that hands a
 * tuned live session to PlayerActivity. Without the bridge, the web player keeps playing.
 */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var store: ServerConfigStore
    private var webView: WebView? = null
    private var origin: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerConfigStore(this)
        root = FrameLayout(this)
        setContentView(root)
        val saved = store.origin
        val normalized = saved?.let { OriginPolicy.normalize(it, allowCleartext()) }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView ?: run { finish(); return }
                // The page closes its own dialog first; otherwise Back walks web history, then exits.
                view.evaluateJavascript("!!(window.TkBoxTv && window.TkBoxTv.handleBack())") { handled ->
                    if (handled != "true") { if (view.canGoBack()) view.goBack() else finish() }
                }
            }
        })
        if (normalized == null) setupView(saved, failure = null) else openApp(normalized)
    }

    private fun allowCleartext() = BuildConfig.ALLOW_CLEARTEXT

    private fun setupView(initial: String?, failure: String?) {
        root.removeAllViews()
        webView = null
        val column = TvViews.column(this)
        column.addTv(TvViews.text(this, "tk.box", 44f, bold = true))
        column.addTv(TvViews.text(this, "Connect to your server", 20f))
        if (failure != null) column.addTv(TvViews.text(this, failure, 16f).apply { setTextColor(0xFFFF9B8F.toInt()) })
        val input = TvViews.field(this, if (allowCleartext()) "http://192.168.1.10:3000" else "https://tv.example.com")
        input.setText(initial.orEmpty())
        column.addTv(input)
        column.addTv(TvViews.text(this, "Test the address, then save it to load the app.", 14f).apply {
            setTextColor(0xFFA0A0AB.toInt())
        })
        val status = TvViews.text(this, "", 15f)
        column.addTv(status)
        column.addTv(TvViews.button(this, "Test connection") {
            val normalized = OriginPolicy.normalize(input.text.toString(), allowCleartext())
            if (normalized == null) {
                status.text = addressError()
                return@button
            }
            status.text = "Testing…"
            Thread {
                val answer = SessionClient(normalized, SessionClient.client(WebViewCookies, normalized)).healthy()
                runOnUiThread { status.text = if (answer) "Connected to $normalized" else "No answer from $normalized" }
            }.start()
        })
        column.addTv(TvViews.button(this, "Save and continue") {
            val normalized = OriginPolicy.normalize(input.text.toString(), allowCleartext())
            if (normalized == null) {
                status.text = addressError()
                return@button
            }
            store.origin = normalized
            openApp(normalized)
        })
        root.addView(column)
        input.requestFocus()
    }

    private fun addressError() =
        if (allowCleartext()) "Enter an http:// or https:// address." else "Enter an https:// address."

    @SuppressLint("SetJavaScriptEnabled")
    private fun openApp(serverOrigin: String) {
        origin = serverOrigin
        root.removeAllViews()
        val view = WebView(this)
        webView = view
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            builtInZoomControls = false
            displayZoomControls = false
            userAgentString = "$userAgentString TkBoxTV/${BuildConfig.VERSION_NAME}"
        }
        // WebView 83+ can send the page's real Origin for allowlisted hosts; older WebViews
        // (Fire OS 5/6, WebView 66 here) send "null" plus X-Requested-With, which the server
        // accepts as the shell marker.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST))
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(view.settings, setOf(serverOrigin))
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.setBackgroundColor(0xFF0C0C10.toInt())
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.webViewClient = TvWebViewClient()
        // Page console output goes to logcat so a UAT log shows a JavaScript failure; the page
        // never logs credentials, and this adds no URL or cookie to the line.
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i("TkBoxConsole", "${message.message()} (${message.lineNumber()})")
                return true
            }
        }
        view.addJavascriptInterface(Bridge(serverOrigin), "TkBoxNative")
        view.loadUrl("$serverOrigin/")
        root.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        view.requestFocus()
    }

    private inner class TvWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val server = origin ?: return true
            return !OriginPolicy.isTrusted(request.url.toString(), server)
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val server = origin ?: return blocked()
            if (!OriginPolicy.isTrusted(request.url.toString(), server)) return blocked()
            // The session cookie is not reliably visible to CookieManager.getCookie() on older
            // WebViews; the same header the WebView sends is the one the native player reuses.
            WebViewCookies.observe(request.url.toString(), request.requestHeaders["Cookie"])
            return null
        }

        override fun onPageFinished(view: WebView, url: String) {
            val server = origin ?: return
            // Sign-in sets the session cookie here; keep the native snapshot current.
            WebViewCookies.refresh(server)
            WebViewCookies.flush()

        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showOffline()
        }
    }

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

    private fun showOffline() {
        val server = origin ?: return
        root.removeAllViews()
        webView?.destroy()
        webView = null
        val column = TvViews.column(this)
        column.addTv(TvViews.text(this, "Server unavailable", 30f, bold = true))
        column.addTv(TvViews.text(this, "tk.box could not reach $server.", 17f))
        column.addTv(TvViews.button(this, "Retry") { openApp(server) })
        column.addTv(TvViews.button(this, "Change server address") {
            store.origin = null
            setupView(server, failure = null)
        })
        root.addView(column)
    }

    /** The only calls page JavaScript can make; every argument is validated again here. */
    private inner class Bridge(private val server: String) {
        @android.webkit.JavascriptInterface
        fun playLiveStream(payload: String): Boolean {
            val request = BridgeValidator.parse(payload, server, allowCleartext()) ?: return false
            runOnUiThread {
                WebViewCookies.refresh(server)
                WebViewCookies.flush()
                startActivity(Intent(this@MainActivity, PlayerActivity::class.java).apply {
                    putExtra(PlayerActivity.EXTRA_ORIGIN, server)
                    putExtra(PlayerActivity.EXTRA_SESSION_ID, request.sessionId)
                    putExtra(PlayerActivity.EXTRA_STREAM_URL, request.streamUrl)
                    putExtra(PlayerActivity.EXTRA_TITLE, request.title)
                    putExtra(PlayerActivity.EXTRA_SUBTITLE, request.subtitle)
                })
            }
            return true
        }

        @android.webkit.JavascriptInterface
        fun stopLiveStream() = PlayerActivity.stopCurrent()

        @android.webkit.JavascriptInterface
        fun isTv(): Boolean = true

        @android.webkit.JavascriptInterface
        fun logout() = runOnUiThread {
            WebViewCookies.clear()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            webView?.reload()
        }
    }

    /** Tells the page the native player closed so it can clear its session state and refocus. */
    fun nativeEnded(sessionId: String?, state: String, code: String?) {
        val detail = org.json.JSONObject().put("state", state)
        if (sessionId != null) detail.put("sessionId", sessionId)
        if (code != null) detail.put("code", code)
        webView?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('tkbox:native-playback',{detail:$detail}))", null
        )
        webView?.requestFocus()
    }

    override fun onPause() {
        super.onPause()
        WebViewCookies.flush()
    }

    override fun onResume() {
        super.onResume()
        origin?.let { WebViewCookies.refresh(it) }
        webView?.requestFocus()
        PlaybackOutcome.pending?.let { result ->
            PlaybackOutcome.pending = null
            nativeEnded(result.sessionId, result.state, result.code)
        }
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
