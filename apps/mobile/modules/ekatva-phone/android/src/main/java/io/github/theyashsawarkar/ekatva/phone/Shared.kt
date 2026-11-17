package io.github.theyashsawarkar.ekatva.phone

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

/**
 * "Share → ekatva" from any app: what was shared (text, links, files),
 * with files copied into the app's cache so JavaScript can read them.
 */
object Shared {
  /** Reads a SEND / SEND_MULTIPLE intent; null when it isn't one. */
  fun read(context: Context, intent: Intent?): Map<String, Any?>? {
    if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return null
    val uris = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND) {
      @Suppress("DEPRECATION")
      (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    }
    val dir = File(context.cacheDir, "shared").apply { mkdirs() }
    val files = uris.take(20).mapNotNull { uri -> copy(context, uri, dir) }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    // Read once: coming back to the app later doesn't share it again.
    intent.action = Intent.ACTION_MAIN
    if (files.isEmpty() && text.isNullOrBlank()) return null
    return mapOf("text" to text, "files" to files)
  }

  private fun copy(context: Context, uri: Uri, dir: File): Map<String, Any>? = runCatching {
    var name = "shared"
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0)?.let { n -> name = n }
    }
    val safe = name.replace(Regex("[/\\\\]"), "_").ifBlank { "shared" }
    val out = File(dir, "${System.currentTimeMillis()}-$safe")
    context.contentResolver.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } }
      ?: return@runCatching null
    mapOf("uri" to Uri.fromFile(out).toString(), "name" to safe, "size" to out.length().toDouble())
  }.getOrNull()
}
