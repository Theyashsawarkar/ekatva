package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.util.Base64

/**
 * The laptop's notifications, on the phone. Swiping one away here tells
 * the laptop (through the module's event), so it goes there too.
 */
object LaptopNotifications {
  const val CHANNEL = "ekatva-laptop"
  const val ACTION_DISMISSED = "io.github.theyashsawarkar.ekatva.LAPTOP_NOTIFICATION_DISMISSED"
  const val EXTRA_ID = "id"
  @Volatile var listener: ((String) -> Unit)? = null

  /** Android wants an int; the laptop's ids are strings. */
  private fun intId(id: String) = 10_000 + (id.hashCode() and 0x3fffffff)

  /** ekatva's brass: the small icon's and the app name's tint in the shade. */
  const val BRASS = 0xFFCDB38A.toInt()
  private const val CHANNEL_URGENT = "ekatva-laptop-urgent"

  /** Each laptop app's notifications as one group, with a summary ("Mail, 3"), not all of them in one pile. */
  private fun groupOf(app: String) = "ekatva-laptop:" + app.lowercase()
  private fun summaryId(app: String) = 5_000 + (groupOf(app).hashCode() and 0xfff)

  private fun bitmap(b64: String?): Bitmap? {
    if (b64.isNullOrEmpty()) return null
    return try {
      val bytes = Base64.decode(b64, Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Exception) {
      null
    }
  }

  /** A person's picture as a circle (Android shows large icons square on some phones). */
  private fun round(src: Bitmap): Bitmap {
    val side = minOf(src.width, src.height)
    val out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    c.drawOval(RectF(0f, 0f, side.toFloat(), side.toFloat()), p)
    p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    c.drawBitmap(src, ((side - src.width) / 2).toFloat(), ((side - src.height) / 2).toFloat(), p)
    return out
  }

  private fun channels(nm: NotificationManager) {
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "From the laptop", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Your laptop's notifications, on this phone"
        }
      )
    }
    if (nm.getNotificationChannel(CHANNEL_URGENT) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_URGENT, "From the laptop: urgent", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "The laptop's urgent notifications (a failed job, a low battery)"
        }
      )
    }
  }

  fun show(
    context: Context,
    id: String,
    app: String,
    title: String,
    text: String,
    icon: String? = null,
    picture: String? = null,
    urgency: Int? = null,
  ) {
    val nm = context.getSystemService(NotificationManager::class.java)
    channels(nm)
    val dismissed = PendingIntent.getBroadcast(
      context, intId(id),
      Intent(ACTION_DISMISSED).setPackage(context.packageName).putExtra(EXTRA_ID, id),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    // Tapping it opens ekatva (a root request waits on its Home screen).
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, intId(id), it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // The large icon: the notification's own picture (a person), else the laptop app's icon.
    val large = bitmap(picture)?.let { round(it) } ?: bitmap(icon)
    val group = groupOf(app)
    val n = Notification.Builder(context, if (urgency == 2) CHANNEL_URGENT else CHANNEL)
      .setContentTitle(if (title.isNotEmpty()) title else app)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setSubText(app)
      .setSmallIcon(R.drawable.ic_stat_ekatva)
      .setColor(BRASS)
      .setGroup(group)
      .setAutoCancel(true)
      .setContentIntent(open)
      .setDeleteIntent(dismissed)
      .apply { if (large != null) setLargeIcon(large) }
      .build()
    nm.notify(intId(id), n)
    // The group's summary: what Android shows when it folds them (and keeps
    // other apps' laptop notifications out of this pile).
    val summary = Notification.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_ekatva)
      .setColor(BRASS)
      .setSubText(app)
      .setContentTitle(app)
      .setGroup(group)
      .setGroupSummary(true)
      .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
      .setAutoCancel(true)
      .setContentIntent(open)
      .apply { bitmap(icon)?.let { setLargeIcon(it) } }
      .build()
    nm.notify(summaryId(app), summary)
  }

  fun close(context: Context, id: String) {
    val nm = context.getSystemService(NotificationManager::class.java)
    nm.cancel(intId(id))
    // A group's summary with nothing left under it goes too.
    val active = runCatching { nm.activeNotifications.toList() }.getOrDefault(emptyList())
    for (s in active) {
      val g = s.notification.group ?: continue
      if (!g.startsWith("ekatva-laptop:") || (s.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0) continue
      val left = active.count { it.id != s.id && it.notification.group == g }
      if (left == 0) nm.cancel(s.id)
    }
  }
}

class LaptopNotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != LaptopNotifications.ACTION_DISMISSED) return
    intent.getStringExtra(LaptopNotifications.EXTRA_ID)?.let { LaptopNotifications.listener?.invoke(it) }
  }
}
