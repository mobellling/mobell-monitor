package com.mobell.monitor

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject

/**
 * Refreshes the widget snapshot without a JS engine:
 *  - https://events.vercount.one/api/v2/log -> site_pv / site_uv
 *  - GitHub commits atom feed -> latest <updated> timestamp
 *
 * The cached JSON produced by the web app is preserved and merged into, so
 * fields the worker does not know about (blog count, total words, ...) survive.
 */
class WidgetWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val context = applicationContext
        val raw = WidgetState.loadRaw(context)
        val snapshot = runCatching { JSONObject(raw ?: "{}") }.getOrElse { JSONObject() }
        var changed = false

        runCatching {
            val body = Http.request(VERCOUNT_URL).bytes.toString(Charsets.UTF_8)
            val root = JSONObject(body)
            val data = root.optJSONObject("data") ?: root
            val pv = data.optInt("site_pv", -1)
            val uv = data.optInt("site_uv", -1)
            if (pv >= 0) {
                snapshot.put("sitePv", pv)
                changed = true
            }
            if (uv >= 0) {
                snapshot.put("siteUv", uv)
                changed = true
            }
        }.onFailure { Log.w(TAG, "vercount fetch failed", it) }

        runCatching {
            val atom = Http.request(ATOM_URL).bytes.toString(Charsets.UTF_8)
            val updated = UPDATED_PATTERN.find(atom)?.groupValues?.getOrNull(1)?.trim()
            if (!updated.isNullOrEmpty()) {
                snapshot.put("lastUpload", updated)
                snapshot.put("lastUpdate", updated)
                changed = true
            }
        }.onFailure { Log.w(TAG, "commit feed fetch failed", it) }

        if (changed) {
            snapshot.put("widgetSyncedAt", System.currentTimeMillis())
            WidgetState.saveRaw(context, snapshot.toString())
        }
        // Always repaint: a failed fetch still must fall back to "—" when no
        // cached value exists.
        WidgetUpdater.updateAll(context)
        return Result.success()
    }

    companion object {
        private const val TAG = "MobellWidgetWorker"

        const val VERCOUNT_URL =
            "https://events.vercount.one/api/v2/log?url=https%3A%2F%2Fmobellling.github.io%2F"
        const val ATOM_URL = "https://github.com/mobellling/mobellling.github.io/commits/master.atom"

        private val UPDATED_PATTERN = Regex("<updated>([^<]+)</updated>")
    }
}
