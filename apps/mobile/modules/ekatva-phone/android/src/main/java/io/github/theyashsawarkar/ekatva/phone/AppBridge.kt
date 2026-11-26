package io.github.theyashsawarkar.ekatva.phone

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Other Vayu apps on this phone (nāda, vāgdevī…) talk to their laptop
 * halves through ekatva: they bind to AppBridgeService and exchange
 * Messages, each carrying JSON in its data Bundle ("json").
 *
 * Who an app is comes from Android, never from what it says: the Message's
 * sendingUid gives its package, and the package its signing certificate.
 * The first time an app says hello you're asked in ekatva; your answer is
 * pinned to that package *and* certificate (and the app's id), so another
 * app under the same name, or a re-signed copy, is refused. Every message
 * is checked against the pin, not just the hello.
 *
 * What an app sends:   HELLO (its manifest), CALL, EMIT, STATUS (each with an id), REPLY
 * What ekatva sends:   WELCOME (where it stands), RESULT (an answer, by id), INCOMING (a call or event)
 * An app links once: its HELLO says "link": true when its user asked for that (from the
 * app's own settings); until then it's only "unlinked", and nothing is asked.
 *
 * Files travel as descriptors beside the JSON ("fd0", "fd1"…, described by its "files"): an
 * app gets the ones handed to it and can open nothing else of ekatva's, and the other way.
 * Those coming in are copied to FILES first; the JSON's "_files" is always ours, never the app's.
 *
 * Everything past the pin check goes to ekatva's JS (core/apps.ts) through the module's
 * "onApp" event; with ekatva not open (locked), a call is answered at once, in words.
 */
object AppBridge {
  const val ACTION = "io.github.theyashsawarkar.ekatva.APPS"

  const val HELLO = 1
  const val CALL = 2
  const val EMIT = 3
  const val REPLY = 4
  const val STATUS = 5
  const val BYE = 6

  const val WELCOME = 101
  const val RESULT = 102
  const val INCOMING = 103

  private const val PREFS = "ekatva-apps"
  private const val MAX_FILES = 16
  private const val MAX_BYTES = 4L * 1024 * 1024 * 1024
  private val io = Executors.newFixedThreadPool(2)

  /** Where files for calls wait (core/apps.ts reads and writes here too). */
  private fun filesDir(context: Context) = File(context.cacheDir, "app-files")

  /** ekatva's JS, while it runs (set by the module). */
  @Volatile var listener: ((Map<String, Any?>) -> Unit)? = null

  private val clients = ConcurrentHashMap<String, Messenger>()
  private val hellos = ConcurrentHashMap<String, String>()

  // ------------------------------------------------------------ identity
  private fun packageOf(context: Context, uid: Int): String? =
    context.packageManager.getPackagesForUid(uid)?.sorted()?.firstOrNull()

  /** The SHA-256 of the package's signing certificate(s), hex. */
  fun certOf(context: Context, pkg: String): String? = runCatching {
    val info = context.packageManager.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
    val signing = info.signingInfo ?: return null
    val certs = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
    val sha = MessageDigest.getInstance("SHA-256")
    // Several signers: all of them, in a fixed order. A rotated key: the current one.
    val chosen = if (signing.hasMultipleSigners()) certs.sortedBy { it.toCharsString() } else listOf(certs.last())
    for (c in chosen) sha.update(c.toByteArray())
    sha.digest().joinToString("") { "%02x".format(it) }
  }.getOrNull()

  // ------------------------------------------------------------ approvals
  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun pinOf(context: Context, pkg: String): JSONObject? =
    prefs(context).getString(pkg, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

  fun approvals(context: Context): List<Map<String, Any?>> =
    prefs(context).all.mapNotNull { (pkg, v) ->
      val o = runCatching { JSONObject(v as String) }.getOrNull() ?: return@mapNotNull null
      mapOf(
        "package" to pkg,
        "cert" to o.optString("cert"),
        "id" to o.optString("id"),
        "name" to o.optString("name"),
        "state" to o.optString("state"),
      )
    }

  /** Your decision, pinned; an app connected now hears it at once. */
  fun decide(context: Context, pkg: String, cert: String, id: String, name: String, allow: Boolean) {
    val o = JSONObject()
      .put("cert", cert).put("id", id).put("name", name)
      .put("state", if (allow) "allowed" else "denied")
    prefs(context).edit().putString(pkg, o.toString()).apply()
    hellos[pkg]?.let { hello(context, pkg, it) }
  }

  fun revoke(context: Context, pkg: String) {
    prefs(context).edit().remove(pkg).apply()
    // Asked again only when its user links it again.
    hellos[pkg]?.let { hellos[pkg] = runCatching { JSONObject(it).put("link", false).toString() }.getOrDefault("{}") }
    send(context, pkg, WELCOME, JSONObject().put("status", "unlinked").put("why", "its link was taken back").toString())
  }

  /** Where an app stands: allowed, pending (not asked yet), denied, or refused (not the app you allowed). */
  private fun statusOf(context: Context, pkg: String, cert: String?, id: String?): String {
    val pin = pinOf(context, pkg) ?: return "pending"
    if (cert == null || pin.optString("cert") != cert) return "refused"
    if (id != null && pin.optString("id") != id) return "refused"
    return if (pin.optString("state") == "allowed") "allowed" else "denied"
  }

  // ------------------------------------------------------------ messages
  fun handle(context: Context, msg: Message) {
    val pkg = packageOf(context, msg.sendingUid) ?: return
    val json = msg.data?.getString("json") ?: "{}"
    val replyTo = msg.replyTo
    when (msg.what) {
      HELLO -> {
        if (replyTo != null) remember(pkg, replyTo)
        hellos[pkg] = json
        hello(context, pkg, json)
      }
      BYE -> forget(pkg)
      CALL, EMIT, STATUS, REPLY -> {
        if (replyTo != null && !clients.containsKey(pkg)) remember(pkg, replyTo)
        val status = statusOf(context, pkg, certOf(context, pkg), null)
        if (status != "allowed") {
          answer(context, pkg, json, "allow this app in ekatva on the phone first")
          return
        }
        val l = listener
        if (l == null) {
          if (msg.what != REPLY) answer(context, pkg, json, "ekatva isn't open on the phone: open it once")
          return
        }
        val kind = when (msg.what) { CALL -> "call"; EMIT -> "emit"; STATUS -> "status"; else -> "reply" }
        val body = runCatching { JSONObject(json) }.getOrDefault(JSONObject()).apply { remove("_files") }
        val fds = if (msg.what == CALL) descriptors(msg.data) else emptyList()
        if (fds.isEmpty()) {
          l(mapOf("kind" to kind, "package" to pkg, "json" to body.toString()))
          return
        }
        io.execute {
          val copied = runCatching { body.put("_files", receive(context, body.optJSONArray("files"), fds)) }
          fds.forEach { runCatching { it.close() } }
          if (copied.isSuccess) l(mapOf("kind" to kind, "package" to pkg, "json" to body.toString()))
          else answer(context, pkg, json, "couldn't take the files (${copied.exceptionOrNull()?.message})")
        }
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun descriptors(data: Bundle?): List<ParcelFileDescriptor> {
    data ?: return emptyList()
    data.classLoader = ParcelFileDescriptor::class.java.classLoader
    return (0 until MAX_FILES).mapNotNull { data.getParcelable<ParcelFileDescriptor>("fd$it") }
  }

  /** The files handed over, copied here under made-up names: [{name, mime, size, path}]. */
  private fun receive(context: Context, about: JSONArray?, fds: List<ParcelFileDescriptor>): JSONArray {
    val dir = filesDir(context).apply { mkdirs() }
    val out = JSONArray()
    val made = ArrayList<File>()
    try {
      fds.forEachIndexed { i, fd ->
        val file = File(dir, UUID.randomUUID().toString())
        made.add(file)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { from ->
          file.outputStream().use { to ->
            val buf = ByteArray(256 * 1024)
            var total = 0L
            while (true) {
              val n = from.read(buf)
              if (n < 0) break
              total += n
              require(total <= MAX_BYTES) { "over 4 GB" }
              to.write(buf, 0, n)
            }
          }
        }
        val a = about?.optJSONObject(i) ?: JSONObject()
        out.put(
          JSONObject()
            .put("name", a.optString("name").substringAfterLast('/').take(200).ifBlank { "file" })
            .put("mime", a.optString("mime").take(100).ifBlank { "application/octet-stream" })
            .put("size", file.length())
            .put("path", file.path)
        )
      }
    } catch (e: Throwable) {
      made.forEach { it.delete() }
      throw e
    }
    return out
  }

  private fun hello(context: Context, pkg: String, json: String) {
    val cert = certOf(context, pkg)
    val id = runCatching { JSONObject(json).optString("id") }.getOrNull()
    val status = statusOf(context, pkg, cert, id)
    val asks = runCatching { JSONObject(json).optBoolean("link") }.getOrDefault(false)
    val l = listener
    if (l == null || cert == null) {
      // ekatva's JS isn't running: tell the app where it stands; it's handed over when JS starts.
      val why = if (status == "allowed") "ekatva isn't open on the phone: open it once" else null
      val shown = when {
        status == "allowed" -> "waiting"
        status == "pending" && !asks -> "unlinked"
        else -> status
      }
      send(context, pkg, WELCOME, JSONObject().put("status", shown)
        .apply { if (why != null) put("why", why) }.toString())
      return
    }
    l(mapOf("kind" to "hello", "package" to pkg, "cert" to cert, "status" to status, "json" to json))
  }

  /** ekatva's JS is listening: everyone connected says hello again. */
  fun ready(context: Context) {
    for ((pkg, json) in hellos) if (clients.containsKey(pkg)) hello(context, pkg, json)
  }

  /** A call or status refused here: its RESULT, by its id. */
  private fun answer(context: Context, pkg: String, json: String, error: String) {
    val id = runCatching { JSONObject(json).opt("id") }.getOrNull()
    val out = JSONObject().put("id", id ?: JSONObject.NULL).put("ok", false).put("error", error)
    send(context, pkg, RESULT, out.toString())
  }

  private fun remember(pkg: String, m: Messenger) {
    clients[pkg] = m
    runCatching { m.binder.linkToDeath({ if (clients[pkg] === m) forget(pkg) }, 0) }
  }

  private fun forget(pkg: String) {
    clients.remove(pkg)
    hellos.remove(pkg)
    listener?.invoke(mapOf("kind" to "bye", "package" to pkg))
  }

  fun send(context: Context, pkg: String, what: Int, json: String) {
    val m = clients[pkg] ?: return
    val fds = ArrayList<ParcelFileDescriptor>()
    try {
      val body = if (what == INCOMING) withFiles(context, json, fds) else json
      val msg = Message.obtain(null, what).apply {
        data = Bundle().apply {
          putString("json", body)
          fds.forEachIndexed { i, fd -> putParcelable("fd$i", fd) }
        }
      }
      m.send(msg)
    } catch (e: RemoteException) {
      forget(pkg)
    } finally {
      // Sending duplicated them.
      fds.forEach { runCatching { it.close() } }
    }
  }

  /** A call's files (paths in FILES, from ekatva's JS) become descriptors; the app never sees a path. */
  private fun withFiles(context: Context, json: String, fds: MutableList<ParcelFileDescriptor>): String {
    val body = JSONObject(json)
    val files = body.optJSONArray("files") ?: return json
    val root = filesDir(context).canonicalPath + File.separator
    for (i in 0 until files.length()) {
      val f = files.getJSONObject(i)
      val file = File(f.getString("path")).canonicalFile
      require(file.path.startsWith(root)) { "not one of ekatva's files" }
      fds.add(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY))
      f.remove("path")
    }
    return body.toString()
  }
}

/** What other apps bind to (action io.github.theyashsawarkar.ekatva.APPS). */
class AppBridgeService : Service() {
  private val messenger by lazy {
    Messenger(Handler(Looper.getMainLooper()) { msg ->
      AppBridge.handle(applicationContext, msg)
      true
    })
  }

  override fun onBind(intent: Intent?): IBinder? =
    if (intent?.action == AppBridge.ACTION) messenger.binder else null
}
