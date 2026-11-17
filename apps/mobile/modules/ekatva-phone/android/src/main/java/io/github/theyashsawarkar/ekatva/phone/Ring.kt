package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * "Find my phone": rings until someone stops it, as loud as the phone
 * goes, through silent, vibrate and Do Not Disturb (when ekatva may change
 * Do Not Disturb). It stops from the notification's button, from the app,
 * or from the laptop; then the volume and Do Not Disturb go back to what
 * they were.
 */
object Ring {
  const val CHANNEL = "ekatva-ring"
  const val ID = 4712
  const val ACTION_STOP = "io.github.theyashsawarkar.ekatva.STOP_RINGING"

  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null
  private var oldVolume: Int? = null
  private var oldFilter: Int? = null
  /** Told when ringing starts or stops (the app shows a stop button). */
  var listener: ((Boolean) -> Unit)? = null

  val ringing: Boolean
    get() = player != null

  fun start(context: Context, from: String) {
    val ctx = context.applicationContext
    stop(ctx, notify = false)
    val audio = ctx.getSystemService(AudioManager::class.java)
    val nm = ctx.getSystemService(NotificationManager::class.java)
    // Through Do Not Disturb, when allowed to change it.
    if (nm.isNotificationPolicyAccessGranted && nm.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL) {
      oldFilter = nm.currentInterruptionFilter
      runCatching { nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL) }
    }
    // As an alarm, at full volume: alarms ring on silent and on vibrate too.
    oldVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
    runCatching {
      audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
    }
    val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
      ?: RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
    player = runCatching {
      MediaPlayer().apply {
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        setDataSource(ctx, uri)
        isLooping = true
        prepare()
        start()
      }
    }.getOrNull() ?: MediaPlayer() // no sound to play: still "ringing" (vibrating), still stoppable
    vibrator = ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
    vibrator?.vibrate(
      VibrationEffect.createWaveform(longArrayOf(0, 800, 400), 0),
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build(),
    )
    showNotification(ctx, from)
    listener?.invoke(true)
  }

  fun stop(context: Context, notify: Boolean = true) {
    val ctx = context.applicationContext
    val was = player != null
    player?.let { runCatching { it.stop() }; it.release() }
    player = null
    vibrator?.cancel()
    vibrator = null
    val audio = ctx.getSystemService(AudioManager::class.java)
    oldVolume?.let { runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, it, 0) } }
    oldVolume = null
    val nm = ctx.getSystemService(NotificationManager::class.java)
    oldFilter?.let { if (nm.isNotificationPolicyAccessGranted) runCatching { nm.setInterruptionFilter(it) } }
    oldFilter = null
    nm.cancel(ID)
    if (was && notify) listener?.invoke(false)
  }

  private fun showNotification(ctx: Context, from: String) {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Find my phone", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "While your laptop rings this phone: a button to stop it"
          setSound(null, null) // the ring is the sound
          setBypassDnd(true)
        }
      )
    }
    val stop = PendingIntent.getBroadcast(
      ctx, 0, Intent(ACTION_STOP).setPackage(ctx.packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
      PendingIntent.getActivity(ctx, 1, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val n = Notification.Builder(ctx, CHANNEL)
      .setContentTitle("Ringing from $from")
      .setContentText("Tap Stop when you've found it")
      .setSmallIcon(R.drawable.ic_stat_ekatva)
      .setColor(LaptopNotifications.BRASS)
      .setCategory(Notification.CATEGORY_ALARM)
      .setOngoing(true)
      .setContentIntent(open)
      .setDeleteIntent(stop)
      .addAction(Notification.Action.Builder(null, "Stop ringing", stop).build())
      .build()
    runCatching { nm.notify(ID, n) } // without the notification permission: stop from the app or laptop
  }
}

/** The notification's "Stop ringing" button (and swiping it away). */
class RingStopReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Ring.ACTION_STOP) Ring.stop(context)
  }
}
