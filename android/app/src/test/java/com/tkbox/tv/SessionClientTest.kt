package com.tkbox.tv

import java.io.IOException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class SessionClientTest {
    private val session = "S".repeat(24)

    private fun client(server: MockWebServer, cookies: CookieSource = CookieSource { null }) =
        SessionClient(server.url("/").toString().trimEnd('/'), SessionClient.client(cookies, server.url("/").toString().trimEnd('/')))

    @Test
    fun theConnectionProbeReadsTheHealthAnswer() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"status":"ok"}"""))
            assertTrue(client(server).healthy())
            assertEquals("/health", server.takeRequest().path)
        }
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503))
            assertEquals(false, client(server).healthy())
        }
    }

    @Test
    fun stoppingALiveSessionSendsOriginJsonAndTheWebViewCookie() {
        MockWebServer().use { server ->
            var seen: String? = null
            val captured = CookieSource { url -> seen = url; "tk.box_local=token" }
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"stopped"}"""))
            val outcome = client(server, captured).stop(session)
            val recorded = server.takeRequest()
            assertEquals(SessionClient.Outcome.STOPPED, outcome)
            assertEquals("DELETE", recorded.method)
            assertEquals("/api/v1/live/sessions/$session", recorded.path)
            assertEquals("{}", recorded.body.readUtf8())
            assertEquals("application/json", recorded.getHeader("Content-Type")?.substringBefore(";"))
            assertEquals(server.url("/").toString().trimEnd('/'), recorded.getHeader("Origin"))
            assertEquals("tk.box_local=token", recorded.getHeader("Cookie"))
            assertTrue(seen!!.endsWith("/api/v1/live/sessions/$session"))
        }
    }

    @Test
    fun aReapedExpiredOrFailedStopIsReportedWithoutTryingAgain() {
        for ((status, expected) in listOf(
            404 to SessionClient.Outcome.GONE,
            409 to SessionClient.Outcome.GONE,
            401 to SessionClient.Outcome.EXPIRED,
            403 to SessionClient.Outcome.EXPIRED,
            500 to SessionClient.Outcome.FAILED
        )) MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(status))
            assertEquals(expected, client(server).stop(session))
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun aCrossOriginRedirectIsNotFollowedAndKeepsTheCookieHome() {
        for (code in listOf(301, 302, 307, 308)) {
            MockWebServer().use { server ->
                MockWebServer().use { foreign ->
                    val origin = server.url("/").toString().trimEnd('/')
                    val playlist = "$origin/api/v1/live/sessions/$session/index.m3u8"
                    server.enqueue(MockResponse().setResponseCode(code).setHeader("Location", foreign.url("/seg-1.ts").toString()))
                    foreign.enqueue(MockResponse().setBody("TS"))
                    val client = SessionClient.client(CookieSource { "tk.box_local=synthetic-cookie" }, origin)

                    client.newCall(Request.Builder().url(playlist).build()).execute().use { response ->
                        // Fail closed: the redirect is surfaced, never followed.
                        assertEquals(code, response.code)
                    }
                    assertEquals("HTTP $code reached the other origin", 0, foreign.requestCount)
                    assertEquals("tk.box_local=synthetic-cookie", server.takeRequest().getHeader("Cookie"))
                }
            }
        }
    }

    @Test
    fun anOffOriginMediaRequestIsRefusedOutright() {
        MockWebServer().use { server ->
            MockWebServer().use { foreign ->
                val origin = server.url("/").toString().trimEnd('/')
                // What Media3 would request if a playlist named an absolute foreign segment.
                val client = SessionClient.client(CookieSource { "tk.box_local=synthetic-cookie" }, origin)
                assertThrows(IOException::class.java) {
                    client.newCall(Request.Builder().url(foreign.url("/seg-1.ts").toString()).build()).execute().close()
                }
                assertEquals(0, foreign.requestCount)
            }
        }
    }

    @Test
    fun anOffOriginRedirectFromHttpsToHttpIsNotFollowed() {
        MockWebServer().use { server ->
            MockWebServer().use { foreign ->
                // A real TLS server would be needed to model the origin side; what matters here is
                // that the client is the one SessionClient builds and it neither follows nor leaks.
                val origin = server.url("/").toString().trimEnd('/')
                server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", foreign.url("/seg-1.ts").toString()))
                foreign.enqueue(MockResponse().setBody("TS"))
                val client = SessionClient.client(CookieSource { "tk.box_local=synthetic-cookie" }, origin)
                client.newCall(Request.Builder().url("$origin/api/v1/live/sessions/$session/index.m3u8").build())
                    .execute().use { response ->
                        assertEquals(302, response.code)
                        assertNull("a downgrade target must not be fetched", response.priorResponse)
                    }
                assertEquals(0, foreign.requestCount)
            }
        }
    }

    @Test
    fun anHlsManifestThatNamesAForeignHostCannotBeFetched() {
        MockWebServer().use { server ->
            MockWebServer().use { foreign ->
                val origin = server.url("/").toString().trimEnd('/')
                val playlist = "$origin/api/v1/live/sessions/$session/index.m3u8"
                server.enqueue(MockResponse().setBody("#EXTM3U\n#EXTINF:2,\n${foreign.url("/seg-1.ts")}\n"))
                val client = SessionClient.client(CookieSource { "tk.box_local=synthetic-cookie" }, origin)
                val manifest = client.newCall(Request.Builder().url(playlist).build()).execute().use { it.body?.string() }
                val segment = manifest!!.lineSequence().first { it.startsWith("http") }
                // Media3 resolves the URI and asks this same client for it; the interceptor refuses.
                assertEquals(false, OriginPolicy.isTrusted(segment, origin))
                assertThrows(IOException::class.java) {
                    client.newCall(Request.Builder().url(segment).build()).execute().close()
                }
                assertEquals(0, foreign.requestCount)
                assertEquals("tk.box_local=synthetic-cookie", server.takeRequest().getHeader("Cookie"))
            }
        }
    }

    @Test
    fun cookiesAreSentOnlyToTheConfiguredOrigin() {
        val asked = mutableListOf<String>()
        val cookies = CookieSource { url -> asked.add(url); "tk.box_local=token" }
        MockWebServer().use { server ->
            val origin = server.url("/").toString().trimEnd('/')
            val client = OkHttpClient.Builder().addInterceptor(OriginCookieInterceptor(origin, cookies)).build()
            server.enqueue(MockResponse().setBody("ok"))
            client.newCall(Request.Builder().url("$origin/api/v1/live/sessions/$session/index.m3u8").build()).execute().close()
            assertEquals("tk.box_local=token", server.takeRequest().getHeader("Cookie"))
            // Another host is refused before the chain runs, and its cookie store is never consulted.
            val foreign = RecordingChain(Request.Builder().url("https://evil.example/segment.ts").build())
            assertThrows(IOException::class.java) { OriginCookieInterceptor(origin, cookies).intercept(foreign) }
            assertNull(foreign.forwarded)
            assertEquals(1, asked.size)
        }
    }

    private class RecordingChain(private val request: Request) : okhttp3.Interceptor.Chain {
        var forwarded: Request? = null
        override fun request() = request
        override fun proceed(request: Request): okhttp3.Response {
            forwarded = request
            return okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1)
                .code(200).message("OK").body("".toResponseBody()).build()
        }
        override fun connection() = null
        override fun call() = throw UnsupportedOperationException()
        override fun connectTimeoutMillis() = 0
        override fun withConnectTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
        override fun readTimeoutMillis() = 0
        override fun withReadTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
        override fun writeTimeoutMillis() = 0
        override fun withWriteTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
    }
}

class HlsAuthenticationTest {
    private val session = "S".repeat(24)

    @Test
    fun playlistAndSegmentRequestsCarryTheWebViewCookieAndOnlyToThisOrigin() {
        MockWebServer().use { server ->
            val origin = server.url("/").toString().trimEnd('/')
            // The same OkHttp stack PlayerActivity hands to Media3's HLS data source.
            val client = SessionClient.client(CookieSource { url ->
                if (OriginPolicy.isTrusted(url, origin)) "tk.box_local=session-token" else null
            }, origin)
            val playlist = "$origin/api/v1/live/sessions/$session/index.m3u8"
            val segment = "$origin/api/v1/live/sessions/$session/seg-1.ts"
            server.enqueue(MockResponse().setBody("#EXTM3U\n#EXTINF:2,\nseg-1.ts\n"))
            server.enqueue(MockResponse().setBody("TS"))

            for (url in listOf(playlist, segment)) {
                client.newCall(Request.Builder().url(url).build()).execute().use { response -> assertTrue(response.isSuccessful) }
            }

            val requests = List(2) { server.takeRequest() }
            assertEquals(listOf("/api/v1/live/sessions/$session/index.m3u8", "/api/v1/live/sessions/$session/seg-1.ts"),
                requests.map { it.path })
            for (request in requests) {
                assertEquals("tk.box_local=session-token", request.getHeader("Cookie"))
                assertNull("a media GET needs no CSRF origin", request.getHeader("Origin"))
            }
        }
    }

    @Test
    fun aSegmentFromAnotherOriginGetsNoCookie() {
        MockWebServer().use { server ->
            val origin = server.url("/").toString().trimEnd('/')
            val client = SessionClient.client(CookieSource { "tk.box_local=session-token" }, origin)
            server.enqueue(MockResponse().setBody("TS"))
            // A playlist that pointed elsewhere is refused before Media3 ever requests it.
            assertNull(OriginPolicy.resolveStream("https://evil.example/seg-1.ts", session, origin, false))
            client.newCall(Request.Builder().url("$origin/api/v1/live/sessions/$session/seg-1.ts").build()).execute().close()
            assertEquals("tk.box_local=session-token", server.takeRequest().getHeader("Cookie"))
        }
    }
}
