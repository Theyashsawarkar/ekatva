package io.github.theyashsawarkar.ekatva.phone

import android.Manifest
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException

class NeedsUsbGrant :
  CodedException(
    "E_NEEDS_GRANT",
    "Switching the phone's dark mode needs a one-time permission over USB",
    null,
  )

/**
 * The phone's light and dark mode. Reading it is free; switching it is a
 * system setting Android keeps from apps: it takes WRITE_SECURE_SETTINGS,
 * which only `adb shell pm grant` can give (once; it stays).
 *
 * Switching: UiModeManager.setNightMode first (some builds let it through),
 * else write Settings.Secure "ui_night_mode" (1 no, 2 yes) and nudge the
 * system to apply it now by entering and leaving car mode, which makes
 * UiModeManagerService re-read the setting.
 */
object Appearance {
  const val WHY = "Switching the phone's dark mode needs a one-time permission over USB"

  fun canSet(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
      PackageManager.PERMISSION_GRANTED

  /** "dark" or "light": what the system shows now (auto and custom read as what's applied). */
  fun mode(context: Context): String {
    val ui = context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    return when (ui.nightMode) {
      UiModeManager.MODE_NIGHT_YES -> "dark"
      UiModeManager.MODE_NIGHT_NO -> "light"
      else -> {
        val night = context.applicationContext.resources.configuration.uiMode and
          Configuration.UI_MODE_NIGHT_MASK
        if (night == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
      }
    }
  }

  fun set(context: Context, dark: Boolean) {
    val ui = context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    val want = if (dark) UiModeManager.MODE_NIGHT_YES else UiModeManager.MODE_NIGHT_NO
    try {
      ui.nightMode = want
      if (ui.nightMode == want) return
    } catch (_: SecurityException) {
      // most builds: only the system may; the setting below is the way
    }
    if (!canSet(context)) throw NeedsUsbGrant()
    Settings.Secure.putInt(context.contentResolver, "ui_night_mode", if (dark) 2 else 1)
    try {
      ui.enableCarMode(0)
      ui.disableCarMode(0)
    } catch (_: Exception) {
      // the setting is written; it applies on the next configuration change
    }
  }
}
