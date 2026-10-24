package expo.modules.bosonaudio

import android.content.Intent
import android.graphics.Rect
import android.provider.Settings
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * Renders Rim A over Clock on a device and records each state. Inputs are synthetic wire
 * events and PCM; this proves rendering, window behavior and touch pass-through, not a live session.
 */
class RimOverlayDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private val automation = instrumentation.uiAutomation

  private fun shell(command: String) = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
  private fun task(state: String, revision: Int, detail: String) =
    JSONObject().put("type", "task").put("state", state).put("goal", "Turn on Night Light and dim the screen").put("detail", detail).put("revision", revision)
  private fun voice(state: String, turn: Int) = JSONObject().put("type", "voice_response").put("state", state).put("voiceTurn", turn).put("responseId", "r$turn")

  /** 40 ms PCM16 chunks of a voiced tone with a syllable-like envelope. */
  private fun speech(chunk: Int) = ByteArray(1920).also { bytes ->
    val gain = 0.15 + 0.6 * sin(chunk * 0.9).let { it * it }
    for (i in 0 until 960) {
      val sample = (gain * 32767 * sin(2 * PI * 180 * (chunk * 960 + i) / 24_000)).toInt().toShort()
      bytes[i * 2] = sample.toByte(); bytes[i * 2 + 1] = (sample.toInt() shr 8).toByte()
    }
  }

  private fun capture(name: String, overlay: RimOverlay, level: Level? = null) {
    repeat(if (level == null) 20 else 14) { chunk ->
      if (level != null) overlay.level(level, speech(chunk), 1920)
      Thread.sleep(40)
    }
    shell("screencap -p /data/local/tmp/rim/$name.png")
  }

  private fun appHas(text: String) = automation.rootInActiveWindow?.findAccessibilityNodeInfosByText(text)?.isNotEmpty() == true

  @Test fun rendersStatesOverAnotherAppWithoutBlockingTouches() {
    shell("mkdir -p /data/local/tmp/rim")
    shell("appops set ${context.packageName} SYSTEM_ALERT_WINDOW allow")
    assertTrue("Overlay permission", Settings.canDrawOverlays(context))
    context.startActivity(context.packageManager.getLaunchIntentForPackage("com.google.android.deskclock")!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    Thread.sleep(2500)
    val overlay = RimOverlay(context)
    overlay.start(appInForeground = false)

    overlay.update { session("listening") }
    capture("01-ready", overlay)
    overlay.update { speechStarted() }
    capture("02-listening", overlay, Level.MIC)

    // Touches reach Clock through the overlay.
    assertTrue(appHas("Sat, Oct 24") || appHas("Alarm"))
    val target = automation.rootInActiveWindow!!.findAccessibilityNodeInfosByText("Stopwatch").first()
    val bounds = Rect().also { target.getBoundsInScreen(it) }
    shell("input tap ${bounds.centerX()} ${bounds.centerY()}")
    Thread.sleep(2000)
    assertTrue("Tap passed through to Clock", automation.rootInActiveWindow!!.findAccessibilityNodeInfosByText("Stopwatch").any { it.isSelected } || appHas("Start"))
    capture("03-tap-passed-through", overlay, Level.MIC)

    overlay.update { userTranscript("Turn on Night Light and dim the screen", it) }
    capture("04-thinking", overlay)
    overlay.update { voiceResponse(voice("generating", 1), it); task(task("working", 2, "Opening Display settings")); transcript("r1", "On it.", append = false); playback("r1", it) }
    capture("05-speaking-while-working", overlay, Level.PLAYBACK)
    overlay.update { playback(null, it); voiceResponse(voice("finished", 1), it) }
    capture("06-working-after-reply", overlay)
    overlay.update { task(task("confirming", 3, "Send \"Running 10 minutes late\" to Maya in Messages?")) }
    capture("07-confirming", overlay)
    overlay.update { task(task("paused", 4, "Paused for manual control. Say continue when ready.")) }
    capture("08-paused", overlay)
    overlay.update { task(task("blocked", 5, "I couldn't open Settings. Open Display settings, then say continue.")) }
    capture("09-blocked", overlay)
    overlay.update { task(task("unknown", 6, "I tapped send, but the message doesn't show as sent to Maya yet. I won't send it again; check the conversation.")) }
    capture("10-unknown", overlay)
    overlay.update {
      task(task("working", 7, "Turning on Night Light"))
      voiceIssue(JSONObject().put("type", "voice_issue").put("source", "voice").put("state", "unknown").put("voiceTurn", 1).put("taskRevision", 7)
        .put("detail", "Voice reply interrupted. Ask for the task status. Phone actions were not retried."))
    }
    capture("11-voice-issue-beside-work", overlay)
    overlay.update { task(task("completed", 8, "Observed Night Light on")) }
    capture("12-done", overlay)

    // Settings sets HIDE_NON_SYSTEM_OVERLAY_WINDOWS, so Android hides this overlay there.
    context.startActivity(Intent(Settings.ACTION_DISPLAY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    Thread.sleep(2500)
    capture("13-settings-hides-overlay", overlay)

    overlay.stop()
    Thread.sleep(500)
    capture("14-removed", overlay)
  }
}
