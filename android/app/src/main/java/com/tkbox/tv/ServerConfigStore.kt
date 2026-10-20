package com.tkbox.tv

import android.content.Context

/** The one configured server, kept across restarts. */
class ServerConfigStore(context: Context) {
    private val preferences = context.getSharedPreferences("tkbox", Context.MODE_PRIVATE)

    var origin: String?
        get() = preferences.getString(KEY_ORIGIN, null)
        set(value) {
            preferences.edit().apply {
                if (value == null) remove(KEY_ORIGIN) else putString(KEY_ORIGIN, value)
            }.apply()
        }

    private companion object {
        const val KEY_ORIGIN = "server_origin"
    }
}
