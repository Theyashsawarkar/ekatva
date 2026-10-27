package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the app's process (and so the link to the laptop) alive in the
 * background, with an ongoing notification saying so.
 */
class LinkService : Service() {
  companion object {
    const val CHANNEL = "ekatva-link"
    const val ID = 4711
    const val EXTRA_TEXT = "text"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Linked with the laptop", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while ekatva stays connected to your laptop"
          setShowBadge(false)
        }
      )
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Linked with your laptop"
    val notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("ekatva")
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(ID, notification)
    }
    return START_STICKY
  }
}
