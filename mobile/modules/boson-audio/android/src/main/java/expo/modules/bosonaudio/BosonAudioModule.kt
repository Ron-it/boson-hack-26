package expo.modules.bosonaudio

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import kotlin.concurrent.thread
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BosonAudioModule : Module() {
  private val sample = SampleRecorder()
  private val prefs get() = appContext.reactContext!!.getSharedPreferences("connection", 0)

  override fun definition() = ModuleDefinition {
    Name("BosonAudio")

    Events("onEvent")
    OnCreate { VoiceState.listener = { event -> sendEvent("onEvent", mapOf("json" to event)) } }
    OnDestroy { VoiceState.listener = null; sample.stop() }
    Function("snapshot") { VoiceState.snapshot() }
    Function("configuration") {
      mapOf("url" to prefs.getString("url", ""), "configured" to !prefs.getString("token", "").isNullOrBlank(), "preset" to prefs.getString("preset", "quick"),
        "familyLanguage" to prefs.getString("familyLanguage", "hi"), "familyVoiceLanguage" to prefs.getString("familyVoiceLanguage", ""))
    }
    Function("setFamilyLanguage") { language: String -> prefs.edit().putString("familyLanguage", language).apply() }
    Function("startSample") { sample.start() }
    Function("cancelSample") { sample.stop(); Unit }
    /** Resolves with the voice or a message to show; it never rejects. */
    AsyncFunction("saveSample") { language: String, text: String, promise: Promise ->
      val pcm = sample.stop()
      thread(name = "family-voice") {
        promise.resolve(try {
          require(pcm.size >= MIN_SAMPLE_SECONDS * SAMPLE_RATE * 2) { "Keep reading for at least $MIN_SAMPLE_SECONDS seconds." }
          val voice = createVoice(prefs.getString("url", "").orEmpty(), prefs.getString("token", "").orEmpty(), pcm, text)
          prefs.edit().putString("familyVoice", voice).putString("familyVoiceLanguage", language).apply()
          mapOf("voice" to voice)
        } catch (e: Exception) {
          mapOf("error" to (if (e is java.io.IOException) "Could not reach the server. Check the connection and try again." else e.message ?: "Could not save your voice. Try again."))
        })
      }
    }
    Function("configure") { url: String, token: String ->
      require(url.startsWith("https://")) { "Use an https server address" }
      require(token.length >= 24) { "Enter the device pairing code" }
      val server = url.trimEnd('/')
      val edit = prefs.edit().putString("url", server).putString("token", token)
      // A voice belongs to the Boson key behind its server, so another server cannot use it.
      if (server != prefs.getString("url", "")) edit.remove("familyVoice").remove("familyVoiceLanguage")
      edit.apply()
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
