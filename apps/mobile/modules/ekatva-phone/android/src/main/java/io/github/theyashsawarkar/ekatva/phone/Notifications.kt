package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.io.ByteArrayOutputStream

/**
 * Sees the phone's notifications (once you allow it in Android's settings)
 * and hands them to the module, which passes them to JavaScript.
 */
class Notifications : NotificationListenerService() {
  companion object {
    @Volatile var listener: ((Map<String, Any?>) -> Unit)? = null
    @Volatile var instance: Notifications? = null

    /** package → its icon as base64 PNG ("" when it has none), made once. */
    private val icons = HashMap<String, String>()

    /** A drawable as a square PNG of `px` pixels, base64; null if it can't be drawn. */
    private fun png(d: Drawable?, px: Int): String? {
      if (d == null) return null
      return try {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, px, px)
        d.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
      } catch (e: Exception) {
        null
      }
    }

    private fun find(key: String): StatusBarNotification? =
      instance?.activeNotifications?.firstOrNull { it.key == key }

    /** Dismissed on the laptop: gone here too. */
    fun dismiss(key: String): Boolean {
      val i = instance ?: return false
      if (find(key) == null) return false
      i.cancelNotification(key)
      return true
    }

    /** One of its buttons, pressed on the laptop; `reply` fills a reply field when it has one. */
    /** Index -1, -2, -3: a call-style notification's Answer, Decline, Hang up. */
    const val ANSWER = -1
    const val DECLINE = -2
    const val HANG_UP = -3

    /**
     * Sent with leave to start an activity: answering a WhatsApp call opens
     * its call screen, and Android 14 silently refuses that from a background
     * app unless the sender allows it.
     */
    private fun sendAllowed(pi: android.app.PendingIntent, context: Context, fill: Intent?) {
      val opts = if (Build.VERSION.SDK_INT >= 34)
        android.app.ActivityOptions.makeBasic()
          .setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
          .toBundle()
      else null
      pi.send(context, 0, fill, null, null, null, opts)
    }

    fun act(context: Context, key: String, index: Int, reply: String?): Boolean {
      val n = find(key)?.notification ?: return false
      if (index < 0) {
        val extra = when (index) {
          ANSWER -> Notification.EXTRA_ANSWER_INTENT
          DECLINE -> Notification.EXTRA_DECLINE_INTENT
          else -> Notification.EXTRA_HANG_UP_INTENT
        }
        @Suppress("DEPRECATION")
        val pi = n.extras.getParcelable<android.app.PendingIntent>(extra) ?: return false
        android.util.Log.i("ekatva", "call button $index of ${n.extras.getString(Notification.EXTRA_TEMPLATE) ?: "?"}")
        sendAllowed(pi, context, null)
        return true
      }
      val action = n.actions?.getOrNull(index) ?: return false
      android.util.Log.i("ekatva", "notification button $index")
      val inputs = action.remoteInputs
      if (inputs != null && inputs.isNotEmpty() && reply != null) {
        val results = Bundle()
        for (r in inputs) results.putCharSequence(r.resultKey, reply)
        val intent = Intent()
        RemoteInput.addResultsToIntent(inputs, intent, results)
        sendAllowed(action.actionIntent, context, intent)
      } else {
        sendAllowed(action.actionIntent, context, null)
      }
      return true
    }
  }

  override fun onListenerConnected() {
    instance = this
  }

  override fun onListenerDisconnected() {
    if (instance === this) instance = null
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) = emit(sbn, false)

  override fun onNotificationRemoved(sbn: StatusBarNotification) = emit(sbn, true)

  private fun iconOf(pkg: String): String? {
    val got = synchronized(icons) {
      icons.getOrPut(pkg) {
        try {
          png(packageManager.getApplicationIcon(pkg), 64) ?: ""
        } catch (e: Exception) {
          ""
        }
      }
    }
    return got.ifEmpty { null }
  }

  private fun emit(sbn: StatusBarNotification, removed: Boolean) {
    if (sbn.packageName == packageName) return
    val n = sbn.notification ?: return
    // An app's call (WhatsApp voice or video, Meet, Signal…): ongoing while it
    // rings and while it lasts, and exactly what the laptop must show.
    val call = n.category == Notification.CATEGORY_CALL
    // Other ongoing ones (music, downloads, ekatva's own) are noise on the laptop.
    if (!removed && !call && (n.flags and Notification.FLAG_ONGOING_EVENT) != 0) return
    val extras = n.extras
    val app = try {
      packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
    } catch (e: Exception) {
      sbn.packageName
    }
    listener?.invoke(
      mapOf(
        "id" to sbn.key,
        "app" to app,
        "title" to (extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""),
        "text" to (extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""),
        "actions" to (n.actions?.map { it.title.toString() } ?: emptyList<String>()),
        // The button that takes typed text (Reply), if one does.
        "reply" to (n.actions?.indexOfFirst { !it.remoteInputs.isNullOrEmpty() }?.takeIf { it >= 0 }),
        "removed" to removed,
        "call" to call,
        // A call-style notification (Android 12's CallStyle, WhatsApp's video
        // calls) says what it is, and keeps Answer / Decline / Hang up apart
        // from its buttons: the laptop needs both.
        "callState" to when (extras.getInt(Notification.EXTRA_CALL_TYPE, 0)) {
          Notification.CallStyle.CALL_TYPE_INCOMING, Notification.CallStyle.CALL_TYPE_SCREENING -> "ringing"
          Notification.CallStyle.CALL_TYPE_ONGOING -> "active"
          else -> null
        },
        // A video call, as the app marks it (CallStyle's setIsVideo), or says.
        "video" to (extras.getBoolean(Notification.EXTRA_CALL_IS_VIDEO, false) ||
          Regex("video", RegexOption.IGNORE_CASE).containsMatchIn(
            "${extras.getCharSequence(Notification.EXTRA_TEXT) ?: ""} ${extras.getCharSequence(Notification.EXTRA_SUB_TEXT) ?: ""} ${n.channelId ?: ""}")),
        "callButtons" to listOfNotNull(
          if (extras.containsKey(Notification.EXTRA_ANSWER_INTENT)) "answer" else null,
          if (extras.containsKey(Notification.EXTRA_DECLINE_INTENT)) "decline" else null,
          if (extras.containsKey(Notification.EXTRA_HANG_UP_INTENT)) "hangup" else null,
        ),
        // So the laptop shows WhatsApp's icon and the sender's photo, not a bell.
        "package" to sbn.packageName,
        "icon" to (if (removed) null else iconOf(sbn.packageName)),
        "picture" to (if (removed) null else try {
          png(n.getLargeIcon()?.loadDrawable(this), 128)
        } catch (e: Exception) {
          null
        }),
      )
    )
  }
}
