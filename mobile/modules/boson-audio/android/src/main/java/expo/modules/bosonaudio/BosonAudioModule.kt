package expo.modules.bosonaudio

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BosonAudioModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BosonAudio")

    Events("onEvent")
    OnCreate { VoiceState.listener = { event -> sendEvent("onEvent", mapOf("json" to event)) } }
    OnDestroy { VoiceState.listener = null }
    Function("snapshot") { VoiceState.snapshot() }
    Function("configuration") {
      val prefs = appContext.reactContext!!.getSharedPreferences("connection", 0)
      mapOf("url" to prefs.getString("url", ""), "configured" to !prefs.getString("token", "").isNullOrBlank(), "preset" to prefs.getString("preset", "quick"))
    }
    Function("configure") { url: String, token: String ->
      require(url.startsWith("https://")) { "Use an https server address" }
      require(token.length >= 24) { "Enter the device pairing code" }
      appContext.reactContext!!.getSharedPreferences("connection", 0).edit().putString("url", url.trimEnd('/')).putString("token", token).apply()
    }
    Function("canSetBrightness") { Settings.System.canWrite(appContext.reactContext!!) }
    Function("requestBrightnessPermission") {
      val context = appContext.reactContext!!
      context.startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("canShowOverlay") { Settings.canDrawOverlays(appContext.reactContext!!) }
    Function("requestOverlayPermission") {
      val context = appContext.reactContext!!
      context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("start") { preset: String ->
      val context = appContext.reactContext!!
      check(appContext.currentActivity != null) { "Open the app to start listening" }
      context.getSharedPreferences("connection", 0).edit().putString("preset", preset).apply()
      context.startForegroundService(Intent(context, VoiceService::class.java))
    }
    Function("stop") {
      val context = appContext.reactContext!!
      context.stopService(Intent(context, VoiceService::class.java))
    }
  }
}
