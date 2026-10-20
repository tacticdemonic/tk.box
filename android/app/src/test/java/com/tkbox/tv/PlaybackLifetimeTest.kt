package com.tkbox.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlaybackLifetimeTest {
    @Test
    fun backErrorsAndLifecycleStopsReleaseTheRelayExactlyOnce() {
        val lifetime = PlaybackLifetime("S".repeat(24))
        assertEquals("S".repeat(24), lifetime.release())
        // A second path (onStop after Back, an error after a stop broadcast) must not DELETE again.
        assertNull(lifetime.release())
        assertNull(lifetime.release())
    }

    @Test
    fun twoViewersOfTheSameChannelEachReleaseTheirOwnSession() {
        val session = "S".repeat(24)
        assertEquals(session, PlaybackLifetime(session).release())
        assertEquals(session, PlaybackLifetime(session).release())
    }
}
