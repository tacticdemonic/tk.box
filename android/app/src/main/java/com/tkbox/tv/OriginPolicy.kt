package com.tkbox.tv

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Every address the shell accepts or requests is checked here: one configured tk.box origin,
 * HTTPS in release builds, and no path other than a live session's own playlist.
 */
object OriginPolicy {
    private const val LIVE_PLAYLIST = "/api/v1/live/sessions/%s/index.m3u8"

    /** Returns the normalized origin (`https://host[:port]`) or null when unusable. */
    fun normalize(raw: String, allowCleartext: Boolean): String? {
        if (raw.length > 2048 || raw.any { it.code < 0x20 || it.code == 0x7f }) return null
        val text = raw.trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        val candidate = if (text.contains("://")) text else "https://$text"
        val url = candidate.toHttpUrlOrNull() ?: return null
        if (!schemeAllowed(url.scheme, allowCleartext)) return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        if (url.query != null || text.contains('#') || text.contains('?')) return null
        if (url.encodedPath != "/") return null
        return "${url.scheme}://${url.host}${if (url.port == defaultPort(url.scheme)) "" else ":${url.port}"}"
    }

    fun isTrusted(raw: String, origin: String): Boolean {
        val url = raw.toHttpUrlOrNull() ?: return false
        val base = origin.toHttpUrlOrNull() ?: return false
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return false
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }

    /**
     * Resolves the playlist the server returned (relative, as the web app receives it) against
     * the configured origin. Any other path, another origin, a query or a fragment is refused.
     */
    fun resolveStream(streamUrl: String, sessionId: String, origin: String, allowCleartext: Boolean): String? {
        if (streamUrl.isEmpty() || streamUrl.length > 2048) return null
        if (streamUrl.any { it.isWhitespace() || it.code < 0x20 }) return null
        if (streamUrl.contains('?') || streamUrl.contains('#')) return null
        val base = origin.toHttpUrlOrNull() ?: return null
        if (!schemeAllowed(base.scheme, allowCleartext)) return null
        val resolved = base.resolve(streamUrl) ?: return null
        if (!isTrusted(resolved.toString(), origin)) return null
        if (resolved.encodedPath != LIVE_PLAYLIST.format(sessionId)) return null
        return resolved.toString()
    }

    private fun schemeAllowed(scheme: String, allowCleartext: Boolean) =
        scheme == "https" || (scheme == "http" && allowCleartext)

    private fun defaultPort(scheme: String) = if (scheme == "https") 443 else 80
}
