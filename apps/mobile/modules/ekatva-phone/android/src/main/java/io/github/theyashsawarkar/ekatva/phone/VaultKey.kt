package io.github.theyashsawarkar.ekatva.phone

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class VaultError(val code: String, message: String) : Exception(message)

/**
 * ekatva's secrets, sealed with a keystore key that never leaves the phone's
 * secure hardware and works only right after you prove it's you: your
 * fingerprint, or your phone's own PIN, pattern or password (Android asks).
 *
 * Because the screen lock opens it too, enrolling a new fingerprint doesn't
 * destroy it (keys tied to fingerprints alone are). Only removing the screen
 * lock or wiping the phone does: then the app says so and you pair again.
 */
object VaultKey {
  private const val ALIAS = "ekatva-vault"
  private const val PREFS = "ekatva-vault"
  private const val BLOB = "blob"
  private const val GCM_TAG = 128

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun exists(ctx: Context): Boolean = prefs(ctx).contains(BLOB)

  fun wipe(ctx: Context) {
    prefs(ctx).edit().clear().commit()
    runCatching { keystore().deleteEntry(ALIAS) }
  }

  private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun key(create: Boolean): SecretKey? {
    (keystore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Each use needs a fresh fingerprint or screen-lock check, bound to that one operation.
      spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
    } else {
      @Suppress("DEPRECATION")
      spec.setUserAuthenticationValidityDurationSeconds(15)
    }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      .apply { init(spec.build()) }
      .generateKey()
  }

  /** Seals `text` (replacing what was there), after Android checks it's you. */
  fun seal(activity: Activity, text: String, title: String, done: (Result<Unit>) -> Unit) {
    val cipher = try {
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
    } catch (e: KeyPermanentlyInvalidatedException) {
      // A key from a screen lock that's gone: a new one.
      runCatching { keystore().deleteEntry(ALIAS) }
      try {
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
      } catch (e2: Exception) {
        return done(Result.failure(VaultError("E_VAULT", e2.message ?: "can't make a key")))
      }
    } catch (e: Exception) {
      return done(Result.failure(VaultError("E_VAULT", e.message ?: "can't make a key")))
    }
    authenticate(activity, title, cipher) { r ->
      done(r.mapCatching { c ->
        val box = c.doFinal(text.toByteArray(Charsets.UTF_8))
        val blob = Base64.encodeToString(c.iv + box, Base64.NO_WRAP)
        prefs(activity).edit().putString(BLOB, blob).commit()
        Unit
      })
    }
  }

  /** The sealed text, after Android checks it's you; null when nothing is sealed. */
  fun open(activity: Activity, title: String, done: (Result<String?>) -> Unit) {
    val blob = prefs(activity).getString(BLOB, null) ?: return done(Result.success(null))
    val raw = Base64.decode(blob, Base64.NO_WRAP)
    val iv = raw.copyOfRange(0, 12)
    val box = raw.copyOfRange(12, raw.size)
    val cipher = try {
      val k = key(create = false) ?: return done(Result.failure(VaultError("E_KEY_GONE", "the key is gone")))
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(GCM_TAG, iv)) }
    } catch (e: KeyPermanentlyInvalidatedException) {
      return done(Result.failure(VaultError("E_KEY_GONE", "the screen lock changed, so Android dropped the key")))
    } catch (e: Exception) {
      return done(Result.failure(VaultError("E_VAULT", e.message ?: "can't open the vault")))
    }
    authenticate(activity, title, cipher) { r ->
      done(r.mapCatching { c -> String(c.doFinal(box), Charsets.UTF_8) })
    }
  }

  /** Android's own prompt: the fingerprint, or the screen lock. */
  private fun authenticate(activity: Activity, title: String, cipher: Cipher, done: (Result<Cipher>) -> Unit) {
    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        done(Result.success(result.cryptoObject?.cipher ?: cipher))
      }

      override fun onAuthenticationError(code: Int, message: CharSequence) {
        val cancelled = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
          code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
        done(Result.failure(VaultError(if (cancelled) "E_CANCELLED" else "E_AUTH", message.toString())))
      }
    }
    val signal = CancellationSignal()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      BiometricPrompt.Builder(activity)
        .setTitle(title)
        .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
        .build()
        .authenticate(BiometricPrompt.CryptoObject(cipher), signal, activity.mainExecutor, callback)
    } else {
      // Android 10: the key opens for a few seconds after the check.
      @Suppress("DEPRECATION")
      BiometricPrompt.Builder(activity)
        .setTitle(title)
        .setDeviceCredentialAllowed(true)
        .build()
        .authenticate(signal, activity.mainExecutor, callback)
    }
  }
}
