package com.tkbox.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeValidatorTest {
    private val origin = "https://tv.example.com"
    private val session = "S".repeat(24)
    private val playlist = "/api/v1/live/sessions/$session/index.m3u8"

    @Test
    fun parsesAValidHandoff() {
        val request = BridgeValidator.parse(
            """{"sessionId":"$session","streamUrl":"$playlist","title":"News","subtitle":"Midday"}""",
            origin, false
        )!!
        assertEquals(session, request.sessionId)
        assertEquals("$origin$playlist", request.streamUrl)
        assertEquals("News", request.title)
        assertEquals("Midday", request.subtitle)
    }

    @Test
    fun refusesMalformedPayloadsAndUnexpectedFields() {
        assertNull(BridgeValidator.parse("not json", origin, false))
        assertNull(BridgeValidator.parse("[]", origin, false))
        assertNull(BridgeValidator.parse("""{"streamUrl":"$playlist"}""", origin, false))
        assertNull(BridgeValidator.parse("""{"sessionId":"$session"}""", origin, false))
        // A session id must be an opaque server token, not a path or a short guess.
        assertNull(BridgeValidator.parse("""{"sessionId":"../../etc","streamUrl":"$playlist"}""", origin, false))
        assertNull(BridgeValidator.parse("""{"sessionId":"short","streamUrl":"$playlist"}""", origin, false))
        assertNull(BridgeValidator.parse("x".repeat(4097), origin, false))
    }

    @Test
    fun refusesForeignOriginsAndQueryStringsAndStripsControlCharacters() {
        assertNull(BridgeValidator.parse(
            """{"sessionId":"$session","streamUrl":"https://evil.example$playlist"}""", origin, false))
        assertNull(BridgeValidator.parse(
            """{"sessionId":"$session","streamUrl":"$playlist?token=x"}""", origin, false))
        val labelled = BridgeValidator.parse(
            """{"sessionId":"$session","streamUrl":"$playlist","title":"Ne\u0000ws","subtitle":42}""", origin, false)!!
        assertEquals("News", labelled.title)
        assertEquals("42", labelled.subtitle)
        assertEquals(120, BridgeValidator.parse(
            """{"sessionId":"$session","streamUrl":"$playlist","title":"${"t".repeat(400)}"}""", origin, false)!!.title!!.length)
    }
}
