package io.github.theyashsawarkar.ekatva.phone

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NotAllowed(what: String) : CodedException("E_NOT_ALLOWED", "$what isn't allowed yet: allow it in ekatva's settings on the phone", null)

/**
 * What the phone app needs from Android that JavaScript can't reach. Each
 * function checks its permission and says plainly what's missing.
 */
class EkatvaPhoneModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no context")

  private var ringtone: Ringtone? = null
  private var callReceiver: BroadcastReceiver? = null
  private var smsReceiver: BroadcastReceiver? = null

  private fun has(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun need(permission: String, what: String) {
    if (!has(permission)) throw NotAllowed(what)
  }

  private fun admin() = ComponentName(context, AdminReceiver::class.java)

  private fun startActivity(intent: Intent) {
    // On top of the app's screen when there is one: Android refuses some
    // (adding a device admin) as a new task, and closes them at once.
    val activity = appContext.currentActivity
    if (activity != null) activity.startActivity(intent)
    else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun contactName(number: String?): String? {
    if (number.isNullOrBlank() || !has(Manifest.permission.READ_CONTACTS)) return null
    val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
    context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) return it.getString(0)
    }
    return null
  }

  override fun definition() = ModuleDefinition {
    Name("EkatvaPhone")
    Events("onCall", "onSms", "onNotification")

    OnCreate {
      Notifications.listener = { n -> sendEvent("onNotification", n) }
    }

    OnDestroy {
      Notifications.listener = null
      callReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      smsReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      ringtone?.stop()
    }

    // ---- what's allowed
    Function("status") {
      mapOf(
        "admin" to (context.getSystemService(DevicePolicyManager::class.java).isAdminActive(admin())),
        "notifications" to (Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
          ?.contains(context.packageName) == true),
        "allFiles" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()),
        "calls" to (has(Manifest.permission.CALL_PHONE) && has(Manifest.permission.READ_PHONE_STATE)),
        "sms" to (has(Manifest.permission.READ_SMS) && has(Manifest.permission.SEND_SMS)),
      )
    }

    Function("requestAdmin") {
      startActivity(Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
        putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin())
        putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Lets your laptop lock this phone through ekatva. Nothing else.")
      })
    }

    Function("openNotificationAccess") {
      startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    Function("requestAllFiles") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}")))
      }
    }

    // ---- lock and ring
    Function("lock") {
      val dpm = context.getSystemService(DevicePolicyManager::class.java)
      if (!dpm.isAdminActive(admin())) throw NotAllowed("Locking the phone")
      dpm.lockNow()
    }

    Function("ring") { seconds: Int ->
      ringtone?.stop()
      val uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      // As an alarm, so it rings even on silent: that's the point of "find my phone".
      val r = RingtoneManager.getRingtone(context, uri)
      r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
      r.play()
      ringtone = r
      Handler(Looper.getMainLooper()).postDelayed({ if (ringtone === r) r.stop() }, seconds.coerceIn(3, 60) * 1000L)
    }

    Function("stopRinging") {
      ringtone?.stop()
      ringtone = null
    }

    // ---- staying linked
    Function("startLink") { text: String ->
      val i = Intent(context, LinkService::class.java).putExtra(LinkService.EXTRA_TEXT, text)
      context.startForegroundService(i)
    }

    Function("stopLink") {
      context.stopService(Intent(context, LinkService::class.java))
    }

    // ---- calls
    Function("dial") { number: String ->
      need(Manifest.permission.CALL_PHONE, "Placing calls")
      startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)))
    }

    Function("answer") {
      need(Manifest.permission.ANSWER_PHONE_CALLS, "Answering calls")
      @Suppress("MissingPermission")
      context.getSystemService(TelecomManager::class.java).acceptRingingCall()
    }

    Function("hangUp") {
      need(Manifest.permission.ANSWER_PHONE_CALLS, "Ending calls")
      @Suppress("MissingPermission", "DEPRECATION")
      context.getSystemService(TelecomManager::class.java).endCall()
    }

    Function("watchCalls") {
      if (callReceiver != null) return@Function null
      need(Manifest.permission.READ_PHONE_STATE, "Seeing calls")
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          val state = when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
            TelephonyManager.EXTRA_STATE_OFFHOOK -> "active"
            TelephonyManager.EXTRA_STATE_IDLE -> "ended"
            else -> return
          }
          @Suppress("DEPRECATION")
          val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""
          sendEvent("onCall", mapOf("state" to state, "number" to number, "contact" to contactName(number)))
        }
      }
      context.registerReceiver(r, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED), Context.RECEIVER_EXPORTED)
      callReceiver = r
      null
    }

    // ---- messages
    Function("smsThreads") { limit: Int ->
      need(Manifest.permission.READ_SMS, "Reading messages")
      val out = mutableListOf<Map<String, Any?>>()
      val seen = mutableSetOf<String>()
      context.contentResolver.query(
        Telephony.Sms.CONTENT_URI,
        arrayOf(Telephony.Sms._ID, Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
        null, null, "${Telephony.Sms.DATE} DESC"
      )?.use { c ->
        while (c.moveToNext() && out.size < limit) {
          val thread = c.getString(1) ?: continue
          if (!seen.add(thread)) continue
          val address = c.getString(2) ?: ""
          out.add(mapOf(
            "thread" to thread,
            "contact" to contactName(address),
            "last" to mapOf("id" to c.getString(0), "thread" to thread, "from" to address, "contact" to contactName(address),
              "text" to (c.getString(3) ?: ""), "at" to c.getLong(4), "mine" to (c.getInt(5) == Telephony.Sms.MESSAGE_TYPE_SENT)),
          ))
        }
      }
      out
    }

    Function("smsRead") { thread: String, limit: Int ->
      need(Manifest.permission.READ_SMS, "Reading messages")
      val out = mutableListOf<Map<String, Any?>>()
      context.contentResolver.query(
        Telephony.Sms.CONTENT_URI,
        arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
        "${Telephony.Sms.THREAD_ID} = ?", arrayOf(thread), "${Telephony.Sms.DATE} DESC LIMIT $limit"
      )?.use { c ->
        while (c.moveToNext()) {
          val address = c.getString(1) ?: ""
          out.add(mapOf("id" to c.getString(0), "thread" to thread, "from" to address, "contact" to contactName(address),
            "text" to (c.getString(2) ?: ""), "at" to c.getLong(3), "mine" to (c.getInt(4) == Telephony.Sms.MESSAGE_TYPE_SENT)))
        }
      }
      out.reversed()
    }

    Function("smsSend") { to: String, text: String ->
      need(Manifest.permission.SEND_SMS, "Sending messages")
      val sms = context.getSystemService(SmsManager::class.java)
      sms.sendMultipartTextMessage(to, null, sms.divideMessage(text), null, null)
    }

    Function("watchSms") {
      if (smsReceiver != null) return@Function null
      need(Manifest.permission.RECEIVE_SMS, "Seeing new messages")
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
          val from = parts.firstOrNull()?.originatingAddress ?: return
          val text = parts.joinToString("") { it.messageBody ?: "" }
          sendEvent("onSms", mapOf("from" to from, "contact" to contactName(from), "text" to text, "at" to System.currentTimeMillis()))
        }
      }
      context.registerReceiver(r, IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION), Context.RECEIVER_EXPORTED)
      smsReceiver = r
      null
    }
  }
}
