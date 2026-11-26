package io.github.theyashsawarkar.ekatva.connect

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** ekatva_connect's Android side: EkatvaClient (the same file any Android app can use), for Flutter. */
class EkatvaConnectPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
  private lateinit var client: EkatvaClient
  private lateinit var methods: MethodChannel
  private lateinit var events: EventChannel
  private var sink: EventChannel.EventSink? = null

  private fun emit(event: String, data: String) {
    sink?.success(mapOf("event" to event, "data" to data))
  }

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    client = EkatvaClient(binding.applicationContext, object : EkatvaClient.Listener {
      override fun onWelcome(json: String) = emit("welcome", json)
      override fun onResult(json: String) = emit("result", json)
      override fun onIncoming(json: String) = emit("incoming", json)
      override fun onDisconnect(why: String) = emit("disconnect", why)
    })
    methods = MethodChannel(binding.binaryMessenger, "ekatva_connect").also { it.setMethodCallHandler(this) }
    events = EventChannel(binding.binaryMessenger, "ekatva_connect/events").also { it.setStreamHandler(this) }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    methods.setMethodCallHandler(null)
    events.setStreamHandler(null)
    client.disconnect()
  }

  override fun onListen(arguments: Any?, s: EventChannel.EventSink?) {
    sink = s
  }

  override fun onCancel(arguments: Any?) {
    sink = null
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    try {
      when (call.method) {
        "installed" -> result.success(client.installed())
        "connect" -> result.success(client.connect(call.argument<String>("manifest")!!))
        "send" -> result.success(client.send(call.argument<Int>("what")!!, call.argument<String>("json")!!))
        "callWithFiles" ->
          result.success(client.call(call.argument<String>("json")!!, call.argument<List<String>>("files")!!))
        "disconnect" -> {
          client.disconnect()
          result.success(null)
        }
        else -> result.notImplemented()
      }
    } catch (e: Exception) {
      result.error("ekatva", e.message, null)
    }
  }
}
