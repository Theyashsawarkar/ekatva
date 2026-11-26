package io.github.theyashsawarkar.ekatva.phone

import android.Manifest
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.util.Base64
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetSocketAddress
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NotAllowed(what: String) : CodedException("E_NOT_ALLOWED", "$what isn't allowed yet: allow it in ekatva's settings on the phone", null)

/**
 * What the phone app needs from Android that JavaScript can't reach. Each
 * function checks its permission and says plainly what's missing.
 */
class EkatvaPhoneModule : Module() {
  /**
   * While the link service runs, a headless JS task that never ends
   * ("ekatvaStayLinked", registered in src/ui/bridge.ts). React Native pauses
   * JS timers when the app leaves the screen unless a headless task is
   * running: without one, a dropped link never reconnects in the background
   * and a call, a text or a notification waits in the outbox until the app
   * is opened again. With it, they reach the laptop with the phone away.
   */
  private var stayTask: Int? = null

  private fun holdJs() {
    UiThreadUtil.runOnUiThread {
      if (stayTask != null) return@runOnUiThread
      val rc = appContext.reactContext as? ReactContext ?: return@runOnUiThread
      stayTask = try {
        HeadlessJsTaskContext.getInstance(rc)
          .startTask(HeadlessJsTaskConfig("ekatvaStayLinked", Arguments.createMap(), 0, true))
      } catch (e: Exception) {
        android.util.Log.w("ekatva", "couldn't keep JS running in the background: ${e.message}")
        null
      }
    }
  }

  private fun releaseJs() {
    UiThreadUtil.runOnUiThread {
      val id = stayTask ?: return@runOnUiThread
      stayTask = null
      val rc = appContext.reactContext as? ReactContext ?: return@runOnUiThread
      try {
        HeadlessJsTaskContext.getInstance(rc).finishTask(id)
      } catch (_: Exception) {
      }
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no context")

  private var callReceiver: BroadcastReceiver? = null
  private var smsReceiver: BroadcastReceiver? = null
  private var beaconSocket: DatagramSocket? = null
  private var multicastLock: WifiManager.MulticastLock? = null

  private fun stopBeacons() {
    beaconSocket?.close()
    beaconSocket = null
    multicastLock?.let { if (it.isHeld) it.release() }
    multicastLock = null
  }

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

  /**
   * Keeps the CPU awake a few seconds after a call, a text or a notification:
   * with the screen off Android wakes it only to hand over the broadcast, and
   * would sleep again before the app has told the laptop.
   */
  private fun awake(ms: Long = 15_000) {
    runCatching {
      context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ekatva:phone-event")
        .apply { setReferenceCounted(false) }
        .acquire(ms)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("EkatvaPhone")
    Events("onCall", "onSms", "onNotification", "onBeacon", "onRing", "onLaptopNotificationDismissed", "onShare", "onApp")

    // ---- other Vayu apps on this phone, through AppBridgeService (core/apps.ts)
    /** To an app: "welcome", "result" or "incoming", with its JSON. */
    Function("appSend") { pkg: String, what: String, json: String ->
      val code = when (what) {
        "welcome" -> AppBridge.WELCOME
        "result" -> AppBridge.RESULT
        else -> AppBridge.INCOMING
      }
      AppBridge.send(context, pkg, code, json)
    }
    /** Your decision on an app, pinned to its package, certificate and id. */
    Function("appDecide") { pkg: String, cert: String, id: String, name: String, allow: Boolean ->
      AppBridge.decide(context, pkg, cert, id, name, allow)
    }
    Function("appApprovals") { AppBridge.approvals(context) }
    Function("appRevoke") { pkg: String -> AppBridge.revoke(context, pkg) }
    /** ekatva's JS listens now: the apps already connected say hello again. */
    Function("appReady") { AppBridge.ready(context) }

    // ---- "Share → ekatva" from other apps
    OnNewIntent { intent ->
      Shared.read(context, intent)?.let { sendEvent("onShare", it) }
    }

    /** What the app was opened to share, once (null when nothing). */
    Function("takeShared") { Shared.read(context, appContext.currentActivity?.intent) }

    OnCreate {
      Notifications.listener = { n ->
        awake()
        sendEvent("onNotification", n)
      }
      Ring.listener = { on -> sendEvent("onRing", mapOf("ringing" to on)) }
      LaptopNotifications.listener = { id -> sendEvent("onLaptopNotificationDismissed", mapOf("id" to id)) }
      AppBridge.listener = { m -> sendEvent("onApp", m) }
    }

    OnDestroy {
      Notifications.listener = null
      Ring.listener = null
      LaptopNotifications.listener = null
      AppBridge.listener = null
      callReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      smsReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      stopBeacons()
    }

    // ---- the vault: ekatva's keys behind your fingerprint or screen lock (VaultKey.kt)
    Function("vaultExists") { VaultKey.exists(context) }

    Function("vaultWipe") { VaultKey.wipe(context) }

    // The laptop's pairing QR code, read by Google's code scanner: its screen and model live in
    // Play services, so ekatva needs no camera permission and ships no barcode model.
    AsyncFunction("scanQr") { promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_SCAN", "ekatva isn't on screen", null)
      val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .build()
      GmsBarcodeScanning.getClient(activity, options).startScan()
        .addOnSuccessListener { code -> promise.resolve(code.rawValue ?: "") }
        .addOnCanceledListener { promise.reject("E_CANCELLED", "Scanning was cancelled", null) }
        .addOnFailureListener { e -> promise.reject("E_SCAN", e.message ?: "Couldn't scan the code", e) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("vaultSeal") { text: String, title: String, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_VAULT", "ekatva isn't on screen", null)
      VaultKey.seal(activity, text, title) { r ->
        r.fold(
          { promise.resolve(null) },
          { e -> promise.reject((e as? VaultError)?.code ?: "E_VAULT", e.message, e) },
        )
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("vaultOpen") { title: String, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_VAULT", "ekatva isn't on screen", null)
      VaultKey.open(activity, title) { r ->
        r.fold(
          { text -> promise.resolve(text) },
          { e -> promise.reject((e as? VaultError)?.code ?: "E_VAULT", e.message, e) },
        )
      }
    }.runOnQueue(Queues.MAIN)

    // ---- what's allowed
    Function("status") {
      mapOf(
        "admin" to (context.getSystemService(DevicePolicyManager::class.java).isAdminActive(admin())),
        "notifications" to (Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
          ?.contains(context.packageName) == true),
        "allFiles" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()),
        "calls" to (has(Manifest.permission.CALL_PHONE) && has(Manifest.permission.READ_PHONE_STATE)),
        "sms" to (has(Manifest.permission.READ_SMS) && has(Manifest.permission.SEND_SMS)),
        "dnd" to context.getSystemService(android.app.NotificationManager::class.java).isNotificationPolicyAccessGranted,
        "background" to context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName),
        "appearance" to Appearance.canSet(context),
      )
    }

    /** Android's prompt to let ekatva run while the screen is off (no battery saver for it). */
    Function("requestBackground") {
      startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
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

    // Until stopped, at full volume, through silent and Do Not Disturb (see Ring.kt).
    Function("ring") { from: String -> Ring.start(context, from) }

    Function("stopRinging") { Ring.stop(context) }

    Function("ringing") { Ring.ringing }

    // A folder in one call (name, kind, size, time), instead of a stat per name from JS.
    AsyncFunction("listDir") { path: String ->
      val items = java.io.File(path).listFiles() ?: throw Exception("can't list $path")
      items.map { f ->
        mapOf(
          "name" to f.name,
          "isDir" to f.isDirectory,
          "size" to (if (f.isDirectory) 0L else f.length()).toDouble(),
          "mtime" to f.lastModified().toDouble(),
        )
      }
    }

    // Light and dark (Appearance.kt): switching needs a permission granted once over USB.
    Function("appearance") {
      val ok = Appearance.canSet(context)
      mapOf("mode" to Appearance.mode(context), "settable" to ok, "why" to if (ok) null else Appearance.WHY)
    }
    AsyncFunction("setAppearance") { dark: Boolean ->
      Appearance.set(context, dark)
      Appearance.mode(context)
    }

    // Changing Do Not Disturb (so ringing gets through "total silence" too): a system page.
    Function("openDndAccess") {
      startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
    }

    // ---- notifications, both ways
    Function("dismissNotification") { key: String -> Notifications.dismiss(key) }

    Function("notificationAction") { key: String, index: Int, reply: String? ->
      Notifications.act(context, key, index, reply)
    }

    /** One of the laptop's notifications, shown here; dismissing it here tells the laptop. */
    Function("showLaptopNotification") {
        id: String, app: String, title: String, text: String, icon: String?, picture: String?, urgency: Int? ->
      LaptopNotifications.show(context, id, app, title, text, icon, picture, urgency)
    }

    Function("closeLaptopNotification") { id: String -> LaptopNotifications.close(context, id) }

    // ---- staying linked
    Function("startLink") { text: String ->
      val i = Intent(context, LinkService::class.java).putExtra(LinkService.EXTRA_TEXT, text)
      context.startForegroundService(i)
      BootReceiver.setPaired(context, true)
      holdJs()
    }

    Function("stopLink") {
      context.stopService(Intent(context, LinkService::class.java))
      BootReceiver.setPaired(context, false)
      releaseJs()
    }

    // ---- finding the laptop on the same network
    // The laptop broadcasts small encrypted beacons (see @ekatva/link's beacon.ts); this only
    // hands datagrams of the right size, from IPv4 senders, to JS, which opens them.
    Function("listenBeacons") { port: Int, size: Int ->
      if (beaconSocket != null) return@Function
      val socket = DatagramSocket(null).apply {
        reuseAddress = true
        broadcast = true
        bind(InetSocketAddress(port))
      }
      beaconSocket = socket
      // Without it many phones drop broadcasts while the screen is off.
      val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      multicastLock = wifi.createMulticastLock("ekatva-beacon").apply {
        setReferenceCounted(false)
        acquire()
      }
      Thread({
        val buf = ByteArray(512)
        var last = 0L
        while (!socket.isClosed) {
          val p = DatagramPacket(buf, buf.size)
          try { socket.receive(p) } catch (e: Exception) { break }
          val from = p.address
          if (from !is Inet4Address || p.length != size) continue
          // A flood can't keep JS busy: at most 20 a second get through.
          val now = System.currentTimeMillis()
          if (now - last < 50) continue
          last = now
          sendEvent("onBeacon", mapOf(
            "from" to from.hostAddress,
            "data" to Base64.encodeToString(buf, 0, p.length, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
          ))
        }
      }, "ekatva-beacon").apply { isDaemon = true; start() }
    }

    Function("stopBeacons") { stopBeacons() }

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

    // The call history, newest first: in, out, missed or declined.
    Function("callLog") { limit: Int ->
      need(Manifest.permission.READ_CALL_LOG, "The call history")
      val out = mutableListOf<Map<String, Any?>>()
      context.contentResolver.query(
        CallLog.Calls.CONTENT_URI,
        arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE,
          CallLog.Calls.DATE, CallLog.Calls.DURATION),
        null, null, "${CallLog.Calls.DATE} DESC"
      )?.use { c ->
        while (c.moveToNext() && out.size < limit) {
          val number = c.getString(1) ?: ""
          val kind = when (c.getInt(3)) {
            CallLog.Calls.INCOMING_TYPE, CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "in"
            CallLog.Calls.OUTGOING_TYPE -> "out"
            CallLog.Calls.REJECTED_TYPE, CallLog.Calls.BLOCKED_TYPE -> "declined"
            else -> "missed"
          }
          out.add(mapOf(
            "id" to c.getLong(0).toString(), "number" to number,
            "contact" to (c.getString(2)?.takeIf { it.isNotBlank() } ?: contactName(number)),
            "kind" to kind, "at" to c.getLong(4), "seconds" to c.getLong(5)))
        }
      }
      out
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
          awake()
          android.util.Log.i("ekatva", "call: $state, to JS")
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
          awake()
          sendEvent("onSms", mapOf("from" to from, "contact" to contactName(from), "text" to text, "at" to System.currentTimeMillis()))
        }
      }
      context.registerReceiver(r, IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION), Context.RECEIVER_EXPORTED)
      smsReceiver = r
      null
    }
  }
}
