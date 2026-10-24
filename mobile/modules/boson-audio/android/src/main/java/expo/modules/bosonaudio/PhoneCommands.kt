package expo.modules.bosonaudio

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import android.provider.AlarmClock
import android.provider.Settings
import android.media.AudioManager
import org.json.JSONObject
import kotlin.math.roundToInt

/** Maintained command boundary for the voice wire protocol, not arbitrary Android invocation. */
class PhoneCommands(private val context: Context) {
  fun execute(name: String, args: JSONObject): JSONObject {
    var dispatched = false
    return try {
      check(!context.getSystemService(KeyguardManager::class.java).isDeviceLocked) { "Unlock the phone first" }
      when (name) {
        "read_media_volume", "set_media_volume" -> {
          requireKeys(args, if (name == "set_media_volume") setOf("percent") else emptySet())
          val audio = context.getSystemService(AudioManager::class.java)
          val min = audio.getStreamMinVolume(AudioManager.STREAM_MUSIC)
          val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          var percent: Double? = null
          var target: Int? = null
          if (name == "set_media_volume") {
            percent = number(args, "percent", 0.0, 100.0)
            check(!audio.isVolumeFixed) { "This device has fixed media volume. Use its external volume controls." }
            require(context.checkSelfPermission(android.Manifest.permission.MODIFY_AUDIO_SETTINGS) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "Media volume permission is unavailable. Use Android volume controls." }
            target = (min + percent / 100 * (max - min)).roundToInt()
            dispatched = true
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
          }
          val observed = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
          JSONObject().put("status", if (target == null) "observed" else if (target == observed) "completed" else "unknown")
            .put("stream", "media").put("observedIndex", observed).put("minIndex", min).put("maxIndex", max).apply {
              if (target != null) {
                put("requestedPercent", percent).put("requestedIndex", target)
                if (target != observed) put("reason", "Android media volume did not retain the requested index. Inspect before retrying.")
              }
            }
        }
        "resolve_handler" -> {
          requireKeys(args, setOf("target"))
          val action = when (args.get("target")) {
            "timer" -> AlarmClock.ACTION_SET_TIMER
            "alarm" -> AlarmClock.ACTION_SET_ALARM
            "display" -> Settings.ACTION_DISPLAY_SETTINGS
            else -> error("Unsupported handler target")
          }
          val handler = Intent(action).resolveActivity(context.packageManager)
          JSONObject().put("status", "observed").put("available", handler != null).apply {
            if (handler != null) put("handlerPackage", handler.packageName)
          }
        }
        "create_timer", "create_alarm" -> {
          val timer = name == "create_timer"
          requireKeys(args, if (timer) setOf("seconds", "label") else setOf("hour", "minute", "label"))
          val intent = if (timer) {
            Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, integer(args, "seconds", 1, 86400))
          } else {
            Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, integer(args, "hour", 0, 23))
              .putExtra(AlarmClock.EXTRA_MINUTES, integer(args, "minute", 0, 59))
          }
          val label = label(args)
          require(context.checkSelfPermission("com.android.alarm.permission.SET_ALARM") == PackageManager.PERMISSION_GRANTED) { "Clock permission is unavailable. Open Clock manually." }
          intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          val handler = intent.resolveActivity(context.packageManager)
            ?: return JSONObject().put("status", "blocked").put("reason", "No installed handler for this Clock request. Open Clock manually.")
          dispatched = true
          context.startActivity(intent)
          JSONObject().put("status", "handoff").put("handlerPackage", handler.packageName)
            .put("note", "Requested Clock handoff only. Observe the resulting timer or alarm before reporting it created.")
        }
        else -> error("Unsupported phone command")
      }
    } catch (error: ActivityNotFoundException) {
      JSONObject().put("status", "blocked").put("reason", "Clock handler is unavailable. Open Clock manually.")
    } catch (error: SecurityException) {
      JSONObject().put("status", "blocked").put("reason", "Android denied permission: ${error.message}")
    } catch (error: Exception) {
      JSONObject().put("status", if (dispatched) "unknown" else "blocked").put("reason", error.message ?: "Phone command failed")
    }
  }

  private fun requireKeys(args: JSONObject, keys: Set<String>) {
    require(args.keys().asSequence().toSet() == keys) { "Supply only the declared command arguments" }
  }

  private fun integer(args: JSONObject, key: String, min: Int, max: Int): Int {
    val value = number(args, key, min.toDouble(), max.toDouble())
    require(value % 1 == 0.0) { "$key must be an integer" }
    return value.toInt()
  }

  private fun label(args: JSONObject): String {
    val value = args.get("label")
    require(value is String && value.length <= 120) { "label must be text up to 120 characters" }
    return value
  }

  private fun number(args: JSONObject, key: String, min: Double, max: Double): Double {
    val raw = args.get(key)
    require(raw is Number) { "$key must be numeric" }
    val value = raw.toDouble()
    require(value.isFinite() && value in min..max) { "$key is out of range" }
    return value
  }
}
