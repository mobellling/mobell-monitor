package com.mobell.monitor

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * Small blocking HTTP helper shared by the widget worker and the JS bridge.
 * Never used on the UI thread.
 */
internal object Http {

    const val BROWSER_UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"

    data class Response(val status: Int, val bytes: ByteArray, val contentType: String?)

    fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        connectTimeoutMs: Int = 30_000,
        readTimeoutMs: Int = 30_000,
        maxBytes: Int = 8 * 1024 * 1024,
    ): Response {
        val parsed = runCatching { URL(url) }.getOrElse { throw IOException("无效的 URL: $url") }
        if (!parsed.protocol.equals("https", ignoreCase = true)) {
            throw IOException("仅支持 HTTPS: $url")
        }
        val connection = parsed.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.instanceFollowRedirects = true
        connection.setRequestProperty("User-Agent", BROWSER_UA)
        connection.setRequestProperty("Accept-Encoding", "gzip")
        for ((name, value) in headers) connection.setRequestProperty(name, value)
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val rawStream = if (status in 200..299) connection.inputStream else connection.errorStream
            val gzipped = connection.contentEncoding?.contains("gzip", ignoreCase = true) == true
            val stream: InputStream? = when {
                rawStream == null -> null
                gzipped -> GZIPInputStream(rawStream)
                else -> rawStream
            }
            val bytes = stream?.use { readAtMost(it, maxBytes) } ?: ByteArray(0)
            return Response(status, bytes, connection.contentType)
        } finally {
            connection.disconnect()
        }
    }

    private fun readAtMost(stream: InputStream, maxBytes: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) throw IOException("响应超过 ${maxBytes / (1024 * 1024)}MB 限制")
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
