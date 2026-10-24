package expo.modules.bosonaudio

import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlin.math.*

object VoiceState {
  @Volatile var listener: ((String) -> Unit)? = null
  private val values = mutableMapOf<String, String>()
  @Synchronized fun emit(event: JSONObject) {
    val type = event.optString("type")
    values[type] = event.toString()
    listener?.invoke(event.toString())
  }
  @Synchronized fun reset() { values.clear() }
  @Synchronized fun snapshot(): String = JSONObject(values as Map<*, *>).toString()
}

class VoiceService : Service() {
  private companion object { const val ISSUE_NOTIFICATION = 2 }
  private var socket: WebSocket? = null
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
  @Volatile private var running = false
  @Volatile private var ready = false
  private var recorder: AudioRecord? = null
  private var track: AudioTrack? = null
  private var echo: AcousticEchoCanceler? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var audioFocus: AudioFocusRequest? = null
  private var previousMode: Int? = null
  private val epoch = AtomicLong(0)
  private val playback = PcmPlaybackQueue()
  private val audioLock = Any()
  private var activeResponse = ""
  private val rejectedResponses = mutableSetOf<String>()
  private var voiceTurn = -1
  private var overlay: RimOverlay? = null
  /** The server explains a closing session just before the socket ends. */
  private var lastNotice = ""
  private var lastNoticeAt = 0L
  /** Frames handed to the speaker since its last flush; playback is audible until the head reaches them. */
  private var framesWritten = 0L

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP") { stopSelf(); return START_NOT_STICKY }
    if (running) return START_NOT_STICKY
    VoiceState.reset()
    try {
      check(checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "Allow microphone access first" }
      getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("voice", "Voice session", NotificationManager.IMPORTANCE_LOW))
      val stop = PendingIntent.getService(this, 1, Intent(this, VoiceService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE)
      val open = PendingIntent.getActivity(this, 2, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
      startForeground(1, Notification.Builder(this, "voice").setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle("Phone voice is listening").setContentText("Tap Stop to end microphone access")
        .setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, "Stop", stop).build()).build())
      running = true
      getSystemService(NotificationManager::class.java).cancel(ISSUE_NOTIFICATION)
      overlay = RimOverlay(this).also { it.start(appInForeground = true) }
      wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:voice").also { it.acquire(60 * 60 * 1000L) }
      val prefs = getSharedPreferences("connection", 0)
      val url = prefs.getString("url", "") ?: ""
      val token = prefs.getString("token", "") ?: ""
      check(url.startsWith("https://") && token.length >= 24) { "Set the server address and pairing code" }
      emit("connecting", "Connecting to Boson")
      socket = client.newWebSocket(Request.Builder().url(url.replaceFirst("https://", "wss://") + "/session").header("Authorization", "Bearer $token").build(), object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
          try { onServerEvent(JSONObject(text)) } catch (error: Exception) { fail(error.message ?: "Invalid voice event") }
        }
        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) { fail(if (response?.code == 503) "Portal is disconnected. Connect it and try again." else "Voice connection failed. Check the server and pairing code.") }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason); if (running) fail("Voice connection ended. Tap Start to reconnect.") }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (running) fail("Voice connection ended. Tap Start to reconnect.") }
      })
    } catch (error: Exception) { fail(error.message ?: "Could not start microphone") }
    return START_NOT_STICKY
  }

  private fun onServerEvent(event: JSONObject) {
    when (event.optString("type")) {
      "ready" -> { if (!ready && running) { ready = true; startAudio(); emit("listening", "Listening") } }
      "response.output_audio.delta" -> {
        val response = event.optString("response_id")
        if (!running || rejectedResponses.contains(response)) return
        activeResponse = response
        val bytes = Base64.decode(event.getString("delta"), Base64.DEFAULT)
        val currentEpoch = epoch.get()
        if (!playback.enqueue(bytes, currentEpoch, response)) fail("The spoken reply is too long. Please restart with a shorter request.")
      }
      "input_audio_buffer.speech_started" -> {
        reject(activeResponse)
        interruptPlayback()
        overlay?.update { speechStarted() }
        VoiceState.emit(event)
      }
      "command" -> executeCommand(event)
      else -> { showOnOverlay(event); VoiceState.emit(event) }
    }
  }

  private fun reject(response: String) {
    if (response.isEmpty()) return
    if (rejectedResponses.size > 64) rejectedResponses.clear()
    rejectedResponses.add(response)
    if (response == activeResponse) interruptPlayback()
  }

  private fun notice(message: String) { lastNotice = message; lastNoticeAt = System.currentTimeMillis() }

  private fun showOnOverlay(event: JSONObject) {
    val overlay = overlay ?: return
    val response = event.text("response_id")
    when (event.text("type")) {
      "voice_response" -> {
        val turn = (event.int("voiceTurn") ?: -1)
        val stale = turn < voiceTurn
        voiceTurn = max(voiceTurn, turn)
        // A stale, cancelled or suppressed response must not be heard, even if bytes already arrived.
        if (stale || event.text("state") in setOf("cancelled", "suppressed")) reject(event.text("responseId"))
        overlay.update { voiceResponse(event, it) }
      }
      "voice_issue" -> { voiceTurn = max(voiceTurn, (event.int("voiceTurn") ?: -1)); notice(event.text("detail")); overlay.update { voiceIssue(event) } }
      "task" -> overlay.update { task(event) }
      "help" -> overlay.update { reading(event.text("state") == "reading") }
      "notice" -> notice(event.text("message"))
      "conversation.item.input_audio_transcription.completed" -> overlay.update { userTranscript(event.text("transcript"), it) }
      "response.output_audio_transcript.delta" -> if (!rejectedResponses.contains(response)) overlay.update { transcript(response, event.text("delta"), append = true) }
      "response.output_audio_transcript.done" -> if (!rejectedResponses.contains(response)) overlay.update { transcript(response, event.text("transcript"), append = false) }
    }
  }

  @Suppress("MissingPermission")
  private fun startAudio() {
    val manager = getSystemService(AudioManager::class.java)
    previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    manager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { manager.setCommunicationDevice(it) }
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    audioFocus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
      .setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS) fail("Another app took audio focus. Restart when ready.") }.build()
    check(manager.requestAudioFocus(audioFocus!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Microphone audio is busy" }
    val size = max(7680, AudioRecord.getMinBufferSize(24000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT))
    val input = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
      .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setBufferSizeInBytes(size).build()
    recorder = input
    check(input.state == AudioRecord.STATE_INITIALIZED && input.sampleRate == 24000) { "24 kHz microphone is unavailable" }
    if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(input.audioSessionId)?.also { it.enabled = true }
    val output = AudioTrack.Builder().setAudioAttributes(attributes)
      .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(max(7680, AudioTrack.getMinBufferSize(24000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT))).build()
    track = output
    check(output.state == AudioTrack.STATE_INITIALIZED) { "Speaker could not start" }
    output.play()
    input.startRecording()
    thread(name = "boson-capture") {
      val buffer = ByteArray(1920)
      try {
        while (running) {
          val count = input.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
          if (count < 0) { if (running) fail("Microphone read failed"); break }
          if (count > 0 && running) {
            overlay?.level(Level.MIC, buffer, count)
            if ((socket?.queueSize() ?: 0) > 1_000_000) { fail("Network is too slow for live audio"); break }
            if (socket?.send(JSONObject().put("type", "input_audio_buffer.append").put("audio", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)).toString()) != true) { fail("Voice connection ended"); break }
          }
        }
      } catch (_: Exception) { if (running) fail("Microphone stopped unexpectedly") }
    }
    thread(name = "boson-speaker") {
      var audible: String? = null
      fun audible(response: String?) { if (response != audible) { audible = response; overlay?.update { playback(response, it) } } }
      try {
        while (running) {
          val packet = playback.poll(80)
          if (packet == null) {
            // Silent once the speaker has played everything it was given, not when the server finished sending.
            val drained = synchronized(audioLock) { output.playbackHeadPosition.toLong() and 0xFFFFFFFFL >= framesWritten }
            if (drained) audible(null)
            continue
          }
          var offset = 0
          while (running && packet.epoch == epoch.get() && offset < packet.bytes.size) {
            synchronized(audioLock) {
              if (packet.epoch == epoch.get() && running) {
                if (output.playState != AudioTrack.PLAYSTATE_PLAYING) output.play()
                val written = output.write(packet.bytes, offset, packet.bytes.size - offset, AudioTrack.WRITE_BLOCKING)
                check(written > 0) { "Speaker write failed" }
                framesWritten += written / 2
                overlay?.level(Level.PLAYBACK, packet.bytes.copyOfRange(offset, offset + written), written)
                audible(packet.response)
                offset += written
              }
            }
          }
          if (packet.epoch != epoch.get()) audible(null)
        }
      } catch (_: Exception) { if (running) fail("Speaker stopped unexpectedly") }
    }
    VoiceState.emit(JSONObject().put("type", "audio_info").put("sampleRate", input.sampleRate).put("echoCancellation", echo?.enabled == true))
  }

  private fun interruptPlayback() {
    epoch.incrementAndGet()
    playback.clear()
    synchronized(audioLock) { try { track?.pause(); track?.flush() } catch (_: Exception) { }; framesWritten = 0 }
    overlay?.update { playback(null, it) }
  }

  private fun executeCommand(event: JSONObject) {
    var result = JSONObject()
    try {
      check(!getSystemService(KeyguardManager::class.java).isDeviceLocked) { "Unlock the phone first" }
      when (event.getString("name")) {
        "open_display" -> { startActivity(Intent(Settings.ACTION_DISPLAY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); result.put("status", "opened") }
        "read_brightness" -> {
          val actual = Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS)
          result.put("status", "observed").put("observedRawValue", actual)
        }
        "set_brightness" -> {
          check(Settings.System.canWrite(this)) { "Enable brightness control in the voice app, or use the Settings UI task" }
          val percent = event.getJSONObject("args").getDouble("percent").coerceIn(10.0, 100.0)
          val normalized = percent / 100.0
          val linear = (if (normalized <= 0.5) (normalized / 0.5).pow(2) else exp((normalized - 0.55991073) / 0.17883277) + 0.28466892) / 12.0
          val value = (linear * 255).roundToInt().coerceIn(1, 255)
          check(Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, value)) { "Android rejected brightness change" }
          val actual = Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS)
          check(actual == value) { "Brightness did not retain the requested value" }
          result.put("status", "completed").put("requestedPercent", percent).put("observedRawValue", actual).put("note", "Approximate Android slider percentage; adaptive brightness remains unchanged.")
        }
        "read_media_volume", "set_media_volume", "resolve_handler", "create_timer", "create_alarm" -> {
          result = PhoneCommands(this).execute(event.getString("name"), event.getJSONObject("args"))
        }
        else -> error("Unknown phone command")
      }
    } catch (error: Exception) { result.put("status", "blocked").put("reason", error.message) }
    socket?.send(JSONObject().put("type", "command_result").put("id", event.getString("id")).put("result", result).toString())
  }

  private fun emit(state: String, detail: String) {
    overlay?.update { session(state) }
    VoiceState.emit(JSONObject().put("type", "state").put("state", state).put("detail", detail))
  }
  private fun fail(message: String) {
    if (running) notifyEnded(lastNotice.takeIf { System.currentTimeMillis() - lastNoticeAt < 3000 } ?: message)
    emit("error", message)
    stopSelf()
  }

  /** The overlay leaves with the microphone, so a lost session stays visible as a dismissible notification. */
  private fun notifyEnded(detail: String) {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("voice-issues", "Voice session problems", NotificationManager.IMPORTANCE_DEFAULT))
    val open = PendingIntent.getActivity(this, 3, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
    manager.notify(ISSUE_NOTIFICATION, Notification.Builder(this, "voice-issues").setSmallIcon(android.R.drawable.stat_notify_error)
      .setContentTitle("Voice stopped").setContentText(detail).setStyle(Notification.BigTextStyle().bigText(detail))
      .setContentIntent(open).setAutoCancel(true).build())
  }
  override fun onDestroy() {
    running = false
    ready = false
    overlay?.stop(); overlay = null
    socket?.close(1000, "Stopped by user")
    interruptPlayback()
    try { recorder?.stop() } catch (_: Exception) { }
    recorder?.release(); recorder = null
    synchronized(audioLock) { track?.release(); track = null }
    echo?.release(); echo = null
    val manager = getSystemService(AudioManager::class.java)
    if (previousMode != null) { manager.clearCommunicationDevice(); audioFocus?.let { manager.abandonAudioFocusRequest(it) }; manager.mode = previousMode!! }
    if (wakeLock?.isHeld == true) wakeLock?.release()
    stopForeground(STOP_FOREGROUND_REMOVE)
    emit("stopped", "Session ended")
    super.onDestroy()
  }
}
