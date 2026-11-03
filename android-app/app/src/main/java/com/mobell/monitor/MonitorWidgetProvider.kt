package com.mobell.monitor

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Home screen widget. Updates itself from the cached snapshot, enqueues a
 * network refresh, and handles the refresh button broadcast.
 */
class MonitorWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        WidgetUpdater.updateAll(context)
        MobellApp.scheduleWidgetWork(context)
        MobellApp.refreshNow(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == WidgetUpdater.ACTION_REFRESH) {
            Log.i(TAG, "widget refresh tapped")
            MobellApp.scheduleWidgetWork(context)
            MobellApp.refreshNow(context)
            // Repaint immediately from cache; the worker will repaint again.
            WidgetUpdater.updateAll(context)
        }
    }

    override fun onEnabled(context: Context) {
        MobellApp.scheduleWidgetWork(context)
        MobellApp.refreshNow(context)
    }

    private companion object {
        const val TAG = "MobellWidget"
    }
}
