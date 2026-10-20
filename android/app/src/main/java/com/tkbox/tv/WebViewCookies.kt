package com.tkbox.tv

import android.webkit.CookieManager

/**
 * A snapshot of the WebView cookies for one origin. CookieManager must be read on the main
 * thread, and media requests run on OkHttp threads, so the shell takes the snapshot before
 * playback starts and refreshes it after sign-in or a page load.
 *
 * WebView 66's `getCookie()` also hides some cookies the page can send; [observe] records the
 * header the WebView itself used, so the native player reuses exactly that.
 */
object WebViewCookies : CookieSource {
    @Volatile private var origin: String? = null
    @Volatile private var stored: String? = null
    @Volatile private var observed: String? = null

    fun refresh(serverOrigin: String) {
        if (origin != serverOrigin) observed = null
        origin = serverOrigin
        stored = CookieManager.getInstance().getCookie("$serverOrigin/")
    }

    /** Records the Cookie header of a request the WebView actually made, for this origin only. */
    fun observe(url: String, cookie: String?) {
        val server = origin ?: return
        if (cookie.isNullOrBlank() || !OriginPolicy.isTrusted(url, server)) return
        observed = cookie
    }

    fun flush() {
        CookieManager.getInstance().flush()
    }

    /** Sign-out: the next request must not reuse a session cookie the server just revoked. */
    fun clear() {
        stored = null
        observed = null
    }

    override fun cookieHeader(url: String): String? {
        val server = origin ?: return null
        if (!OriginPolicy.isTrusted(url, server)) return null
        return observed ?: stored
    }
}
