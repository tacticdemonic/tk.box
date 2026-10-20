package com.tkbox.tv

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView

/** One native HLS player for one tuned live session. */
class PlayerActivity : ComponentActivity() {
    private var player: ExoPlayer? = null
    private var sessionId: String? = null
    private var origin: String? = null
    private var status: android.widget.TextView? = null
    private var overlay: android.widget.LinearLayout? = null
    private var lifetime: PlaybackLifetime? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val target = validatedTarget(intent) ?: run { finish(); return }
        setContentView(buildLayout(target.title, target.subtitle))
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = close("ended", null)
        })
        play(target)
    }

    /**
     * A second handoff replaces the picture in place: the old relay is released before the new
     * one starts, so there is never more than one live session and one player.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = validatedTarget(intent) ?: return
        if (target.sessionId == sessionId) return
        releaseRelay()
        player?.release()
        player = null
        playerView?.player = null
        setContentView(buildLayout(target.title, target.subtitle))
        play(target)
    }

    private data class Target(val origin: String, val sessionId: String, val streamUrl: String, val title: String?, val subtitle: String?)

    private fun validatedTarget(intent: Intent?): Target? {
        if (intent == null) return null
        val server = intent.getStringExtra(EXTRA_ORIGIN)?.takeIf { OriginPolicy.normalize(it, BuildConfig.ALLOW_CLEARTEXT) != null } ?: return null
        val session = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf(BridgeValidator::isSessionId) ?: return null
        val stream = intent.getStringExtra(EXTRA_STREAM_URL) ?: return null
        val resolved = OriginPolicy.resolveStream(stream, session, server, BuildConfig.ALLOW_CLEARTEXT) ?: return null
        return Target(server, session, resolved, intent.getStringExtra(EXTRA_TITLE), intent.getStringExtra(EXTRA_SUBTITLE))
    }

    private fun play(target: Target) {
        current = this
        origin = target.origin
        sessionId = target.sessionId
        lifetime = PlaybackLifetime(target.sessionId)
        startPlayback(target.origin, target.streamUrl)
    }

    private fun buildLayout(title: String?, subtitle: String?): ViewGroup {
        val root = FrameLayout(this)
        root.setBackgroundColor(0xFF000000.toInt())
        val view = PlayerView(this).apply {
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
        }
        playerView = view
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val overlay = TvViews.column(this).apply { gravity = Gravity.CENTER }
        this.overlay = overlay
        overlay.addTv(TvViews.text(this, title ?: "tk.box", 34f, bold = true))
        subtitle?.let { overlay.addTv(TvViews.text(this, it, 20f)) }
        val label = TvViews.text(this, "Starting playback…", 17f).apply { setTextColor(0xFFA0A0AB.toInt()) }
        status = label
        overlay.addTv(label)
        overlay.addTv(TvViews.button(this, "Stop and return to channels") { close("ended", null) })
        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return root
    }

    private var playerView: PlayerView? = null

    private fun startPlayback(server: String, streamUrl: String) {
        // The playlist and every segment go through the WebView's cookies, only to this origin.
        val client = SessionClient.client(WebViewCookies, server)
        val dataSource = OkHttpDataSource.Factory(client).setUserAgent("TkBoxTV/${BuildConfig.VERSION_NAME}")
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(15000, 60000, 2500, 5000)
            .build()
        val exo = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setHandleAudioBecomingNoisy(true)
            .build()
        player = exo
        playerView?.player = exo
        exo.setWakeMode(androidx.media3.common.C.WAKE_MODE_NETWORK)
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                status?.text = when (state) {
                    Player.STATE_BUFFERING -> "Buffering…"
                    Player.STATE_READY -> null
                    else -> null
                }
                status?.visibility = if (status?.text.isNullOrEmpty()) android.view.View.GONE else android.view.View.VISIBLE
                // Hide the title and Stop button once the picture is up; any key brings them back.
                if (state == Player.STATE_READY) handler.postDelayed(hideOverlay, 4000) else handler.removeCallbacks(hideOverlay)
            }

            override fun onPlayerError(error: PlaybackException) {
                // A 401/403 means the 12 h session lapsed: the page must return to sign-in rather
                // than retry the station's other feeds.
                val http = (error.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode
                val code = when {
                    http == 401 || http == 403 -> "UNAUTHENTICATED"
                    error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "HTTP_ERROR"
                    error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "NETWORK_ERROR"
                    else -> "PLAYBACK_FAILED"
                }
                status?.text = "This channel could not be played."
                // The page retries the station's next feed, or returns to sign-in for an expired session.
                close("error", code)
            }
        })
        val source = HlsMediaSource.Factory(dataSource).createMediaSource(MediaItem.fromUri(streamUrl))
        exo.setMediaSource(source)
        exo.prepare()
        exo.playWhenReady = true
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val hideOverlay = Runnable {
        if (player?.isPlaying == true) overlay?.visibility = android.view.View.GONE
    }

    private fun showOverlay() {
        overlay?.visibility = android.view.View.VISIBLE
        handler.removeCallbacks(hideOverlay)
        if (player?.isPlaying == true) handler.postDelayed(hideOverlay, 4000)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        showOverlay()
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
                player?.let { if (it.isPlaying) it.pause() else it.play() }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { player?.play(); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { player?.pause(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    /** Sends the session DELETE on a worker thread, at most once per player lifetime. */
    private fun releaseRelay(): String? {
        val session = lifetime?.release() ?: return null
        val server = OriginPolicy.normalize(origin.orEmpty(), BuildConfig.ALLOW_CLEARTEXT)
        if (server != null) Thread {
            SessionClient(server, SessionClient.client(WebViewCookies, server)).stop(session)
        }.start()
        return session
    }

    /** Stops the relay exactly once, then returns to the channel list. */
    private fun close(state: String, code: String?) {
        val session = releaseRelay() ?: return
        player?.release()
        player = null
        playerView?.player = null
        PlaybackOutcome.pending = PlaybackOutcome.Result(state, session, code)
        finish()
    }

    override fun onStop() {
        super.onStop()
        // Home or another app: the picture stops, so the server relay must stop with it.
        close("ended", null)
    }

    override fun onDestroy() {
        if (current === this) current = null
        player?.release()
        player = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_STREAM_URL = "streamUrl"
        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLE = "subtitle"

        // The page's stop call targets the shell's own player directly; no broadcast is exported.
        @Volatile private var current: PlayerActivity? = null

        fun stopCurrent() {
            current?.runOnUiThread { current?.close("ended", null) }
        }
    }
}

/** What the shell should report back to the page after the player closes. */
object PlaybackOutcome {
    data class Result(val state: String, val sessionId: String?, val code: String?)
    @Volatile var pending: Result? = null
}
