package io.github.theyashsawarkar.ekatva.connect

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** @ekatva/connect's native side: EkatvaClient (the same file any Android app can use), for Expo. */
class EkatvaConnectModule : Module() {
  private val client by lazy {
    val context = appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")
    EkatvaClient(context, object : EkatvaClient.Listener {
      override fun onWelcome(json: String) = sendEvent("onWelcome", mapOf("json" to json))
      override fun onResult(json: String) = sendEvent("onResult", mapOf("json" to json))
      override fun onIncoming(json: String) = sendEvent("onIncoming", mapOf("json" to json))
      override fun onDisconnect(why: String) = sendEvent("onDisconnect", mapOf("why" to why))
    })
  }

  override fun definition() = ModuleDefinition {
    Name("EkatvaConnect")
    Events("onWelcome", "onResult", "onIncoming", "onDisconnect")

    Function("installed") { client.installed() }
    Function("connect") { manifest: String -> client.connect(manifest) }
    /** "call", "emit", "status" or "reply", with its JSON; false when not connected. */
    Function("send") { what: String, json: String ->
      client.send(
        when (what) {
          "call" -> EkatvaClient.CALL
          "emit" -> EkatvaClient.EMIT
          "status" -> EkatvaClient.STATUS
          else -> EkatvaClient.REPLY
        },
        json,
      )
    }
    /** A call with files (paths or URIs). */
    Function("callWithFiles") { json: String, files: List<String> -> client.call(json, files) }
    Function("disconnect") { client.disconnect() }

    OnDestroy { runCatching { client.disconnect() } }
  }
}
