package com.tkbox.tv

import android.webkit.CookieManager

/**
 * A snapshot of the WebView cookies for one origin. CookieManager must be read on the main
 * thread, and media requests run on OkHttp threads, so the shell takes the snapshot before
 * playback starts and refreshes it after sign-in or a page load.
 */
object WebViewCookies : CookieSource {
    @Volatile private var origin: String? = null
    @Volatile private var header: String? = null

    fun refresh(serverOrigin: String) {
        origin = serverOrigin
        header = CookieManager.getInstance().getCookie("$serverOrigin/")
    }

    fun flush() {
        CookieManager.getInstance().flush()
    }

    override fun cookieHeader(url: String): String? {
        val server = origin ?: return null
        return if (OriginPolicy.isTrusted(url, server)) header else null
    }
}
