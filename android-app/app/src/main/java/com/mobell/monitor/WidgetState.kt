package com.mobell.monitor

import android.content.Context
import org.json.JSONObject

/**
 * Widget snapshot stored in SharedPreferences ("mobell" / "widget_state").
 *
 * The web app owns the JSON. Canonical shape (per the shared contract):
 * {"sitePv":56,"siteUv":1,"posts":10,"comments":11,"lastUpload":"2026-11-03T06:31:48Z"}
 *
 * Parsing is deliberately lenient: several key spellings are accepted and the
 * nested "data"/"stats" objects are inspected as well.
 */
data class WidgetState(
    val sitePv: String = "",
    val siteUv: String = "",
    val posts: String = "",
    val comments: String = "",
    val totalWords: String = "",
    val lastUploadRaw: String = "",
) {
    val lastUploadRelative: String
        get() = relativeTime(lastUploadRaw)

    companion object {
        const val PREFS_NAME = "mobell"
        const val STATE_KEY = "widget_state"
        const val LEGACY_STATE_KEY = "widgetData"

        private val PV_KEYS = listOf("sitePv", "site_pv", "sitePV", "pv", "sitePvCount")
        private val UV_KEYS = listOf("siteUv", "site_uv", "siteUV", "uv", "siteUvCount")
        private val POSTS_KEYS = listOf(
            "posts", "postCount", "post_count", "blogCount", "blog_count",
            "totalPosts", "total_posts", "blogs", "articles", "articleCount",
        )
        private val COMMENTS_KEYS = listOf(
            "comments", "commentCount", "comment_count", "totalComments", "total_comments",
        )
        private val WORDS_KEYS = listOf(
            "totalWords", "total_words", "wordCount", "word_count", "words", "totalWordCount",
        )
        private val UPLOAD_KEYS = listOf(
            "lastUpload", "last_upload", "lastUpdate", "last_update", "lastUpdated",
            "last_updated", "latestUpdate", "latest_update", "updatedAt", "updated_at",
        )

        fun loadRaw(context: Context): String? {
            val prefs = prefs(context)
            return prefs.getString(STATE_KEY, null) ?: prefs.getString(LEGACY_STATE_KEY, null)
        }

        fun saveRaw(context: Context, json: String) {
            prefs(context).edit()
                .putString(STATE_KEY, json)
                .putString(LEGACY_STATE_KEY, json)
                .apply()
        }

        fun parse(json: String?): WidgetState {
            if (json.isNullOrBlank()) return WidgetState()
            val root = runCatching { JSONObject(json) }.getOrNull() ?: return WidgetState()
            val scopes = listOfNotNull(root, root.optJSONObject("data"), root.optJSONObject("stats"))
            return WidgetState(
                sitePv = readFirst(scopes, PV_KEYS),
                siteUv = readFirst(scopes, UV_KEYS),
                posts = numeral(readFirst(scopes, POSTS_KEYS)),
                comments = numeral(readFirst(scopes, COMMENTS_KEYS)),
                totalWords = numeral(readFirst(scopes, WORDS_KEYS)),
                lastUploadRaw = readFirst(scopes, UPLOAD_KEYS),
            )
        }

        private fun prefs(context: Context) =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        private fun readFirst(scopes: List<JSONObject>, keys: List<String>): String {
            for (scope in scopes) {
                for (key in keys) {
                    if (!scope.has(key) || scope.isNull(key)) continue
                    val text = valueToString(scope.opt(key))
                    if (text.isNotEmpty()) return text
                }
            }
            return ""
        }

        private fun valueToString(value: Any?): String = when (value) {
            null, JSONObject.NULL -> ""
            is String -> value.trim()
            is Double -> if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()
            is Float -> if (value % 1.0f == 0.0f) value.toLong().toString() else value.toString()
            is Number, is Boolean -> value.toString()
            else -> value.toString()
        }

        /** Adds thousands separators to plain integer strings, leaves other text alone. */
        private fun numeral(raw: String): String {
            if (raw.isEmpty()) return raw
            val digits = raw.replace(",", "").replace(" ", "")
            if (digits.length !in 1..15 || digits.any { !it.isDigit() }) return raw
            return runCatching {
                java.text.NumberFormat.getIntegerInstance(java.util.Locale.US).format(digits.toLong())
            }.getOrDefault(raw)
        }

        private val ISO_PATTERN = Regex(
            """^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$""",
        )

        fun parseIso(raw: String): java.util.Date? {
            val match = ISO_PATTERN.find(raw.trim()) ?: return null
            return runCatching {
                val g = match.groupValues
                val seconds = if (g[6].isEmpty()) "00" else g[6]
                val utc = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply {
                    timeZone = java.util.TimeZone.getTimeZone("UTC")
                }
                utc.parse("${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:$seconds")
            }.getOrNull()
        }

        /** "刚刚" / "3 分钟前" / "2 小时前" / "5 天前" / "yyyy-MM-dd". */
        fun relativeTime(raw: String): String {
            if (raw.isBlank()) return ""
            val date = parseIso(raw) ?: return raw
            val diff = System.currentTimeMillis() - date.time
            return when {
                diff < 60_000L -> "刚刚"
                diff < 3_600_000L -> "${diff / 60_000L} 分钟前"
                diff < 86_400_000L -> "${diff / 3_600_000L} 小时前"
                diff < 30L * 86_400_000L -> "${diff / 86_400_000L} 天前"
                else -> java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault())
                    .format(date)
            }
        }
    }
}
