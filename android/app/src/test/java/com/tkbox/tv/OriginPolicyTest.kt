package com.tkbox.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    private val origin = "https://tv.example.com"
    private val session = "A".repeat(32)
    private val playlist = "/api/v1/live/sessions/$session/index.m3u8"

    @Test
    fun acceptsHttpsOriginAndPlainHttpOnlyWhenAllowed() {
        assertEquals("https://tv.example.com", OriginPolicy.normalize("https://tv.example.com", false))
        assertEquals("https://tv.example.com", OriginPolicy.normalize(" tv.example.com ", false))
        assertEquals("http://192.168.1.10:3000", OriginPolicy.normalize("http://192.168.1.10:3000", true))
        assertNull(OriginPolicy.normalize("http://192.168.1.10:3000", false))
        assertEquals("https://tv.example.com", OriginPolicy.normalize("https://tv.example.com:443", false))
    }

    @Test
    fun rejectsCredentialsPathsQueriesAndControlCharacters() {
        for (raw in listOf(
            "",
            "https://user:pass@tv.example.com",
            "https://tv.example.com/app",
            "https://tv.example.com/?x=1",
            "https://tv.example.com/#frag",
            "javascript:alert(1)",
            "file:///sdcard/secret",
            "https://tv.example.com\n",
            "https://tv.example.com/../etc"
        )) assertNull(raw, OriginPolicy.normalize(raw, true))
    }

    @Test
    fun resolvesOnlyTheSessionPlaylistOnTheConfiguredOrigin() {
        assertEquals("$origin$playlist", OriginPolicy.resolveStream(playlist, session, origin, false))
        assertEquals("$origin$playlist", OriginPolicy.resolveStream("$origin$playlist", session, origin, false))
    }

    @Test
    fun refusesAnotherOriginAnotherSessionAndQueryStrings() {
        val other = "B".repeat(32)
        for (bad in listOf(
            "https://evil.example/api/v1/live/sessions/$session/index.m3u8",
            "//evil.example$playlist",
            "/api/v1/live/sessions/$other/index.m3u8",
            "$playlist?token=secret",
            "$playlist#x",
            "/api/v1/live/sessions/$session/seg-1.ts",
            "/api/v1/playback/sessions/$session/file",
            "javascript:alert(1)",
            " $playlist",
            ""
        )) assertNull(bad, OriginPolicy.resolveStream(bad, session, origin, false))
        assertNull(OriginPolicy.resolveStream("http://tv.example.com$playlist", session, "http://tv.example.com", false))
    }

    @Test
    fun trustComparesSchemeHostAndPort() {
        assertTrue(OriginPolicy.isTrusted("https://tv.example.com/api", origin))
        assertFalse(OriginPolicy.isTrusted("https://tv.example.com:8443/api", origin))
        assertFalse(OriginPolicy.isTrusted("http://tv.example.com/api", origin))
        assertFalse(OriginPolicy.isTrusted("https://evil.example.com/api", origin))
        assertFalse(OriginPolicy.isTrusted("https://u:p@tv.example.com/api", origin))
    }
}
