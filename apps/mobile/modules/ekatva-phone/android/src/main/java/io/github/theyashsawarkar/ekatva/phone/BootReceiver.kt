package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After the phone restarts, ekatva's keys stay locked until you unlock them
 * with your fingerprint, so it can't reconnect by itself. If a laptop is
 * paired, this says so once: "Tap to reconnect". Opening ekatva clears it.
 */
class BootReceiver : BroadcastReceiver() {
  companion object {
    const val CHANNEL = "ekatva-reconnect"
    const val ID = 4712
    private const val PREFS = "ekatva.link"
    private const val PAIRED = "paired"

    /** Remembered by the link service: whether a laptop is paired (no keys, just yes or no). */
    fun setPaired(context: Context, paired: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PAIRED, paired).apply()
      if (paired) clear(context)
    }

    fun clear(context: Context) {
      context.getSystemService(NotificationManager::class.java)?.cancel(ID)
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PAIRED, false)) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Reconnect after a restart", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "After the phone restarts, ekatva needs your fingerprint once to reach your laptop"
          setShowBadge(false)
        }
      )
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
    } ?: return
    val n = Notification.Builder(context, CHANNEL)
      .setContentTitle("Tap to reconnect to your laptop")
      .setContentText(
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) "The phone restarted: ekatva needs your fingerprint once"
        else "ekatva was updated: it needs your fingerprint once"
      )
      .setSmallIcon(R.drawable.ic_stat_ekatva)
      .setColor(LaptopNotifications.BRASS)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    runCatching { nm.notify(ID, n) } // notifications not allowed: nothing to say it with
  }
}
