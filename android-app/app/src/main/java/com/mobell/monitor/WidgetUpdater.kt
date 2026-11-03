package com.mobell.monitor

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews

/** Builds and pushes RemoteViews updates for [MonitorWidgetProvider]. */
object WidgetUpdater {

    const val ACTION_REFRESH = "com.mobell.monitor.ACTION_REFRESH"

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, MonitorWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val state = WidgetState.parse(WidgetState.loadRaw(context))
        for (id in ids) {
            manager.updateAppWidget(id, buildViews(context, state))
        }
    }

    fun buildViews(context: Context, state: WidgetState): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_monitor)

        views.setTextViewText(
            R.id.widget_stats,
            "站点访问 PV ${display(state.sitePv)} · UV ${display(state.siteUv)}",
        )
        views.setTextViewText(R.id.widget_posts, "文章数 ${display(state.posts)}")
        views.setTextViewText(R.id.widget_comments, "评论数 ${display(state.comments)}")
        views.setTextViewText(R.id.widget_updated, "距上次上传 ${display(state.lastUploadRelative)}")

        // Optional fifth line: keep it when the web app supplies total words.
        if (state.totalWords.isNotBlank()) {
            views.setTextViewText(R.id.widget_words, "总字数 ${state.totalWords}")
            views.setViewVisibility(R.id.widget_words, View.VISIBLE)
        } else {
            views.setViewVisibility(R.id.widget_words, View.GONE)
        }

        val refreshIntent = Intent(context, MonitorWidgetProvider::class.java).apply {
            action = ACTION_REFRESH
        }
        val refreshPending = PendingIntent.getBroadcast(
            context,
            1001,
            refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshPending)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            context,
            1002,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(R.id.widget_root, openPending)

        return views
    }

    private fun display(value: String): String = value.ifBlank { "—" }
}
