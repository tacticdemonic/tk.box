package com.tkbox.tv

import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** The shell's non-media calls: the server probe and releasing a live session. */
class SessionClient(private val origin: String, private val client: OkHttpClient) {
    enum class Outcome { STOPPED, EXPIRED, GONE, FAILED }

    /** The server's readiness answer, used by the first-run connection test. */
    fun healthy(): Boolean = try {
        client.newCall(Request.Builder().url("$origin/health").header("Accept", "application/json").build())
            .execute().use { response ->
                response.isSuccessful && org.json.JSONObject(response.body?.string().orEmpty()).optString("status") == "ok"
            }
    } catch (e: Exception) {
        false
    }

    /**
     * Stops the FFmpeg relay behind a tuned channel. The server rejects a non-JSON or Origin-less
     * delete, and answers 404/409 when its reaper already closed the session, which is success.
     */
    fun stop(sessionId: String): Outcome {
        if (!BridgeValidator.isSessionId(sessionId)) return Outcome.FAILED
        val request = Request.Builder()
            .url("$origin/api/v1/live/sessions/$sessionId")
            .delete("{}".toRequestBody(JSON))
            .header("Origin", origin)
            .header("Accept", "application/json")
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    401, 403 -> Outcome.EXPIRED
                    404, 405, 409 -> Outcome.GONE
                    in 200..299 -> Outcome.STOPPED
                    else -> Outcome.FAILED
                }
            }
        } catch (e: Exception) {
            Outcome.FAILED
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun client(cookies: CookieSource, origin: String): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .addInterceptor(OriginCookieInterceptor(origin, cookies))
                .build()
    }
}
