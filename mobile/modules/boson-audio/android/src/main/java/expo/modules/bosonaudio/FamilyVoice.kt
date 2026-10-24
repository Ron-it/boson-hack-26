package expo.modules.bosonaudio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.max

const val SAMPLE_RATE = 24000
/** Boson accepts 3 to 30 seconds; shorter samples clone poorly. */
const val MIN_SAMPLE_SECONDS = 5
const val MAX_SAMPLE_SECONDS = 30

/** A 16-bit mono WAV file around raw PCM. */
fun wav(pcm: ByteArray, rate: Int = SAMPLE_RATE): ByteArray = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
  put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
  put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
  put("data".toByteArray()); putInt(pcm.size); put(pcm)
}.array()

/** Records the helper reading the sample paragraph, in memory, capped at 30 seconds. */
class SampleRecorder {
  private val pcm = ByteArrayOutputStream()
  @Volatile private var recording = false
  private var capture: Thread? = null

  @SuppressLint("MissingPermission")
  @Synchronized fun start() {
    stop()
    pcm.reset()
    val size = max(7680, AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT))
    val input = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
      .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setBufferSizeInBytes(size).build()
    if (input.state != AudioRecord.STATE_INITIALIZED) { input.release(); error("The microphone is busy. Stop any session and try again.") }
    recording = true
    input.startRecording()
    capture = thread(name = "family-sample") {
      val buffer = ByteArray(4800)
      try {
        while (recording) {
          val count = input.read(buffer, 0, buffer.size)
          if (count < 0) break
          synchronized(pcm) { if (pcm.size() < MAX_SAMPLE_SECONDS * SAMPLE_RATE * 2) pcm.write(buffer, 0, count) }
        }
      } finally { input.stop(); input.release() }
    }
  }

  /** Stops recording and returns the PCM captured so far. */
  @Synchronized fun stop(): ByteArray {
    recording = false
    capture?.join(1000)
    capture = null
    return synchronized(pcm) { pcm.toByteArray() }
  }
}

private val client = OkHttpClient.Builder().readTimeout(150, TimeUnit.SECONDS).build()

/** Sends the sample to the paired server, which clones it with Boson. Returns the voice ID. */
fun createVoice(server: String, token: String, sample: ByteArray, text: String): String {
  val body = JSONObject().put("audio", Base64.encodeToString(wav(sample), Base64.NO_WRAP)).put("text", text).toString()
  val request = Request.Builder().url("$server/voices").header("Authorization", "Bearer $token").post(body.toRequestBody("application/json".toMediaType())).build()
  client.newCall(request).execute().use { response ->
    if (response.code == 404) error("This server can't save voices yet. Update it, then record again.")
    val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
    check(response.isSuccessful) { json?.optString("error")?.ifBlank { null } ?: "Could not save your voice. Try again." }
    return json?.optString("voice")?.takeIf { it.startsWith("voice_") } ?: error("The server returned no voice. Try again.")
  }
}
