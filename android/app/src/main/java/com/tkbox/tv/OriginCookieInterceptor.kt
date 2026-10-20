package com.tkbox.tv

import okhttp3.Interceptor
import okhttp3.Response

/** Supplies the Cookie header WebView would send for a URL. */
fun interface CookieSource {
    fun cookieHeader(url: String): String?
}

/**
 * WebView's CookieManager and OkHttp do not share a store. Media3 requests get the header the
 * WebView holds, but only for the configured origin, and the value is never logged or persisted.
 */
class OriginCookieInterceptor(private val origin: String, private val cookies: CookieSource) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!OriginPolicy.isTrusted(request.url.toString(), origin)) return chain.proceed(request)
        val header = cookies.cookieHeader(request.url.toString())?.trim()
        if (header.isNullOrEmpty()) return chain.proceed(request)
        return chain.proceed(request.newBuilder().header("Cookie", header).build())
    }
}
