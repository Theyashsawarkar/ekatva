package io.github.theyashsawarkar.ekatva.phone

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Sees the phone's notifications (once you allow it in Android's settings)
 * and hands them to the module, which passes them to JavaScript.
 */
class Notifications : NotificationListenerService() {
  companion object {
    @Volatile var listener: ((Map<String, Any?>) -> Unit)? = null
    @Volatile var instance: Notifications? = null
  }

  override fun onListenerConnected() {
    instance = this
  }

  override fun onListenerDisconnected() {
    if (instance === this) instance = null
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) = emit(sbn, false)

  override fun onNotificationRemoved(sbn: StatusBarNotification) = emit(sbn, true)

  private fun emit(sbn: StatusBarNotification, removed: Boolean) {
    if (sbn.packageName == packageName) return
    val n = sbn.notification ?: return
    // Ongoing ones (music, downloads, ekatva's own) are noise on the laptop.
    if (!removed && (n.flags and Notification.FLAG_ONGOING_EVENT) != 0) return
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
        "removed" to removed,
      )
    )
  }
}
