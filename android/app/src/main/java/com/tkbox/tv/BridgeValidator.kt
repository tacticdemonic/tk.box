package com.tkbox.tv

import org.json.JSONException
import org.json.JSONObject

data class PlaybackRequest(
    val sessionId: String,
    val streamUrl: String,
    val title: String?,
    val subtitle: String?
)

/** Inputs arriving from page JavaScript. Unknown shapes are refused, never coerced. */
object BridgeValidator {
    private val sessionIdPattern = Regex("^[A-Za-z0-9_-]{16,128}$")

    fun isSessionId(value: String) = sessionIdPattern.matches(value)

    fun parse(payload: String, origin: String, allowCleartext: Boolean): PlaybackRequest? {
        if (payload.length > 4096) return null
        val json = try {
            JSONObject(payload)
        } catch (e: JSONException) {
            return null
        }
        val sessionId = json.optString("sessionId", "")
        if (!isSessionId(sessionId)) return null
        val streamUrl = OriginPolicy.resolveStream(json.optString("streamUrl", ""), sessionId, origin, allowCleartext)
            ?: return null
        return PlaybackRequest(sessionId, streamUrl, label(json, "title", 120), label(json, "subtitle", 200))
    }

    private fun label(json: JSONObject, key: String, limit: Int): String? {
        val value = if (json.has(key) && !json.isNull(key)) json.optString(key, "") else return null
        return value.filter { it.code >= 0x20 && it.code != 0x7f }.trim().take(limit).ifEmpty { null }
    }
}
