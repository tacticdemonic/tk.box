package com.tkbox.tv

/**
 * Guarantees one player, one relay release. Back, a playback error, a stop broadcast and the
 * activity stopping (Home, app switch) can all race; only the first caller claims the session.
 */
class PlaybackLifetime(private val sessionId: String) {
    @Volatile private var released = false

    /** Returns the session to release, or null when another path already released it. */
    @Synchronized fun release(): String? {
        if (released) return null
        released = true
        return sessionId
    }
}
