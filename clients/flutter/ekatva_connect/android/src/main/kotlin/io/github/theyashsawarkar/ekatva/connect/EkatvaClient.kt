package io.github.theyashsawarkar.ekatva.connect

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
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
import java.util.UUID
import java.util.concurrent.Executors

/**
 * A phone app's line to ekatva, for any Android app (Kotlin, Java, Flutter,
 * React Native): one file, nothing but Android and org.json. Copy it in, and
 * add this to the app's manifest so Android lets it see ekatva:
 *
 *   <queries><package android:name="io.github.theyashsawarkar.ekatva" /></queries>
 *
 * It binds to ekatva's AppBridgeService and passes Messages both ways, each
 * with JSON in its data Bundle ("json"), and files as descriptors beside it
 * ("fd0", "fd1"…, described by the JSON's "files"). ekatva knows who this
 * app is from Android (its package and signing certificate), not from
 * anything sent here. It rebinds by itself when ekatva restarts.
 *
 * Callbacks arrive on the main thread.
 */
class EkatvaClient(context: Context, private val listener: Listener) {
  interface Listener {
    /** Where this app stands: {"status": "unlinked" | "pending" | "allowed" | …, "why"?}. */
    fun onWelcome(json: String)
    /** An answer, by its id: {"id", "ok", "result" | "error"}. */
    fun onResult(json: String)
    /** A call or event; a call's "files" each have a "uri" (this app's own copy). */
    fun onIncoming(json: String)
    fun onDisconnect(why: String)
  }

  companion object {
    const val EKATVA = "io.github.theyashsawarkar.ekatva"
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
    const val MAX_FILES = 16
  }

  private val context = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()
  private val inbox = File(this.context.cacheDir, "ekatva-in")
  private var service: Messenger? = null
  private var conn: ServiceConnection? = null
  private var hello: String = "{}"

  private val incoming = Messenger(Handler(Looper.getMainLooper()) { msg ->
    val data = msg.data
    val json = data?.getString("json") ?: "{}"
    when (msg.what) {
      WELCOME -> listener.onWelcome(json)
      RESULT -> listener.onResult(json)
      INCOMING -> {
        val fds = descriptors(data)
        if (fds.isEmpty()) listener.onIncoming(json) else receive(json, fds)
      }
    }
    true
  })

  /** Is ekatva on this phone at all? */
  fun installed(): Boolean =
    runCatching { context.packageManager.getPackageInfo(EKATVA, 0); true }.getOrDefault(false)

  /**
   * Binds and says hello with `manifest` (JSON); false when ekatva can't be
   * reached. With "link": true in it, ekatva asks the user to link this app.
   */
  fun connect(manifest: String): Boolean {
    hello = manifest
    if (service != null) return post(HELLO, manifest)
    // Copies from before: those calls are long over.
    if (conn == null) io.execute { inbox.deleteRecursively() }
    return bind()
  }

  /** CALL, EMIT, STATUS or REPLY; false when not connected. */
  fun send(what: Int, json: String): Boolean = post(what, json)

  /** A call with files (paths, file:// or content:// URIs). Throws when one can't be opened. */
  fun call(json: String, files: List<String>): Boolean {
    require(files.size <= MAX_FILES) { "at most $MAX_FILES files" }
    val fds = ArrayList<ParcelFileDescriptor>()
    try {
      val about = JSONArray()
      for (f in files) {
        val uri = Uri.parse(f)
        val fd = if (uri.scheme == "content") {
          context.contentResolver.openFileDescriptor(uri, "r") ?: throw IllegalArgumentException("can't open $f")
        } else {
          val path = if (uri.scheme == "file") uri.path ?: f else f
          ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        }
        fds.add(fd)
        about.put(JSONObject().put("name", nameOf(uri, f))
          .put("mime", context.contentResolver.getType(uri) ?: "application/octet-stream"))
      }
      return post(CALL, JSONObject(json).put("files", about).toString(), fds)
    } finally {
      // Sending duplicated them.
      fds.forEach { runCatching { it.close() } }
    }
  }

  fun disconnect() {
    post(BYE, "{}")
    unbind()
  }

  private fun nameOf(uri: Uri, f: String): String {
    if (uri.scheme == "content") runCatching {
      context.contentResolver.query(uri, arrayOf("_display_name"), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0)?.let { n -> return n }
      }
    }
    return (uri.lastPathSegment ?: f).substringAfterLast('/')
  }

  private fun post(what: Int, json: String, fds: List<ParcelFileDescriptor> = emptyList()): Boolean {
    val s = service ?: return false
    val msg = Message.obtain(null, what).apply {
      replyTo = incoming
      data = Bundle().apply {
        putString("json", json)
        fds.forEachIndexed { i, fd -> putParcelable("fd$i", fd) }
      }
    }
    return try {
      s.send(msg)
      true
    } catch (e: RemoteException) {
      false
    }
  }

  @Suppress("DEPRECATION")
  private fun descriptors(data: Bundle?): List<ParcelFileDescriptor> {
    data ?: return emptyList()
    data.classLoader = ParcelFileDescriptor::class.java.classLoader
    return (0 until MAX_FILES).mapNotNull { data.getParcelable<ParcelFileDescriptor>("fd$it") }
  }

  /** Files that came with a call: copied into this app's cache, then the call is handed over. */
  private fun receive(json: String, fds: List<ParcelFileDescriptor>) {
    io.execute {
      val out = JSONObject(json)
      val ok = runCatching {
        val files = out.getJSONArray("files")
        require(files.length() == fds.size)
        val dir = File(inbox, UUID.randomUUID().toString()).apply { mkdirs() }
        fds.forEachIndexed { i, fd ->
          val about = files.getJSONObject(i)
          val name = safe(about.optString("name"))
          val file = File(File(dir, "$i").apply { mkdirs() }, name)
          ParcelFileDescriptor.AutoCloseInputStream(fd).use { from -> file.outputStream().use { from.copyTo(it) } }
          about.put("uri", Uri.fromFile(file).toString()).put("size", file.length())
        }
      }.isSuccess
      if (!ok) {
        fds.forEach { runCatching { it.close() } }
        val reply = JSONObject().put("id", out.opt("id")).put("ok", false).put("error", "couldn't save the files")
        main.post { post(REPLY, reply.toString()) }
      } else main.post { listener.onIncoming(out.toString()) }
    }
  }

  private fun safe(name: String): String =
    name.substringAfterLast('/').replace(Regex("[\\u0000-\\u001f\\\\]"), "").trimStart('.').take(120).ifBlank { "file" }

  private fun bind(): Boolean {
    if (conn != null) return true
    val c = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        service = binder?.let { Messenger(it) }
        post(HELLO, hello)
      }
      override fun onServiceDisconnected(name: ComponentName?) {
        // ekatva went away (updated, killed): Android binds again when it's back.
        service = null
        listener.onDisconnect("ekatva stopped")
      }
      override fun onBindingDied(name: ComponentName?) {
        unbind()
        listener.onDisconnect("ekatva was updated or removed")
        bind()
      }
    }
    val intent = Intent(ACTION).setPackage(EKATVA)
    val ok = runCatching { context.bindService(intent, c, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
    if (ok) conn = c else runCatching { context.unbindService(c) }
    return ok
  }

  private fun unbind() {
    conn?.let { runCatching { context.unbindService(it) } }
    conn = null
    service = null
  }
}
