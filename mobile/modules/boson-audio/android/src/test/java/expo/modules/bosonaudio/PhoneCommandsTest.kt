package expo.modules.bosonaudio

import android.content.Context
import android.content.Intent
import android.content.pm.ResolveInfo
import android.content.pm.ActivityInfo
import android.provider.AlarmClock
import android.media.AudioManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PhoneCommandsTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()

  @Test fun mediaVolumeReturnsReadbackWithoutChangingRingVolume() {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(android.Manifest.permission.MODIFY_AUDIO_SETTINGS)
    val audio = context.getSystemService(AudioManager::class.java)
    audio.setStreamVolume(AudioManager.STREAM_RING, 2, 0)
    val commands = PhoneCommands(context)
    val result = commands.execute("set_media_volume", JSONObject().put("percent", 40))
    assertEquals(result.toString(), "completed", result.getString("status"))
    assertEquals(6, result.getInt("observedIndex"))
    assertEquals(2, audio.getStreamVolume(AudioManager.STREAM_RING))
    assertEquals(6, commands.execute("read_media_volume", JSONObject()).getInt("observedIndex"))
  }
  @Test fun timerHandoffUsesExplicitDurationAndVisibleClockWithoutClaimingSaved() {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions("com.android.alarm.permission.SET_ALARM")
    val handler = ResolveInfo().apply {
      activityInfo = ActivityInfo().apply { packageName = "test.clock"; name = "test.clock.Timer"; exported = true }
    }
    shadowOf(context.packageManager).addResolveInfoForIntent(Intent(AlarmClock.ACTION_SET_TIMER), handler)
    val result = PhoneCommands(context).execute("create_timer", JSONObject().put("seconds", 300).put("label", "Tea"))
    assertEquals(result.toString(), "handoff", result.getString("status"))
    val intent = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
    assertEquals(AlarmClock.ACTION_SET_TIMER, intent.action)
    assertEquals(300, intent.getIntExtra(AlarmClock.EXTRA_LENGTH, -1))
    assertEquals(false, intent.getBooleanExtra(AlarmClock.EXTRA_SKIP_UI, true))
    assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK, intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  @Test fun alarmHandoffUsesExplicitLocalTimeWithoutClaimingSaved() {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions("com.android.alarm.permission.SET_ALARM")
    val handler = ResolveInfo().apply {
      activityInfo = ActivityInfo().apply { packageName = "test.clock"; name = "test.clock.Alarm"; exported = true }
    }
    shadowOf(context.packageManager).addResolveInfoForIntent(Intent(AlarmClock.ACTION_SET_ALARM), handler)
    val result = PhoneCommands(context).execute("create_alarm", JSONObject().put("hour", 14).put("minute", 30).put("label", "Call"))
    assertEquals(result.toString(), "handoff", result.getString("status"))
    val intent = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
    assertEquals(AlarmClock.ACTION_SET_ALARM, intent.action)
    assertEquals(14, intent.getIntExtra(AlarmClock.EXTRA_HOUR, -1))
    assertEquals(30, intent.getIntExtra(AlarmClock.EXTRA_MINUTES, -1))
    assertEquals(false, intent.getBooleanExtra(AlarmClock.EXTRA_SKIP_UI, true))
  }

  @Test fun missingClockHandlerIsObservableAndCannotLaunch() {
    val commands = PhoneCommands(context)
    val result = commands.execute("resolve_handler", JSONObject().put("target", "timer"))
    assertEquals(result.toString(), "observed", result.getString("status"))
    assertEquals(false, result.getBoolean("available"))
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions("com.android.alarm.permission.SET_ALARM")
    assertEquals("blocked", commands.execute("create_timer", JSONObject().put("seconds", 60).put("label", "")).getString("status"))
    assertEquals(null, shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
  }

  @Test fun deniedClockPermissionLeavesThePhoneUntouched() {
    shadowOf(RuntimeEnvironment.getApplication()).denyPermissions("com.android.alarm.permission.SET_ALARM")
    val result = PhoneCommands(context).execute("create_alarm", JSONObject().put("hour", 14).put("minute", 30).put("label", "Call"))
    assertEquals("blocked", result.getString("status"))
    assertEquals("Clock permission is unavailable. Open Clock manually.", result.getString("reason"))
    assertEquals(null, shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
  }

  @Test fun invalidTimerArgumentsCannotBeCoercedOrForwardArbitraryExtras() {
    val commands = PhoneCommands(context)
    for (args in listOf(
      JSONObject().put("seconds", "60").put("label", ""),
      JSONObject().put("seconds", 0.5).put("label", ""),
      JSONObject().put("seconds", 60).put("label", "").put("skipUi", true)
    )) {
      val result = commands.execute("create_timer", args)
      assertEquals("blocked", result.getString("status"))
      assertEquals(null, shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
    }
  }

}
