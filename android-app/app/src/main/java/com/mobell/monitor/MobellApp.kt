package com.mobell.monitor

import android.app.Application
import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MobellApp : Application() {

    override fun onCreate() {
        super.onCreate()
        scheduleWidgetWork(this)
    }

    companion object {
        private const val TAG = "MobellApp"
        private const val UNIQUE_PERIODIC_WORK = "mobell_widget_periodic"

        /** Periodic widget refresh every 15 minutes (WorkManager minimum). */
        fun scheduleWidgetWork(context: Context) {
            val request = PeriodicWorkRequestBuilder<WidgetWorker>(15, TimeUnit.MINUTES)
                .setConstraints(networkConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        /** One-off refresh, used by the widget refresh button and widget add. */
        fun refreshNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<WidgetWorker>()
                .setConstraints(networkConstraints())
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }

        private fun networkConstraints(): Constraints =
            Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
    }
}
