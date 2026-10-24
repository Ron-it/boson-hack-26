package expo.modules.bosonaudio

import org.json.JSONObject

/** Wire fields may be absent or JSON null; optString would turn null into "null". */
fun JSONObject.text(key: String): String = if (isNull(key)) "" else optString(key)
fun JSONObject.int(key: String): Int? = if (isNull(key)) null else (opt(key) as? Number)?.toInt()

/** What the rim shows. Each tone pairs with a label, so state never depends on color alone. */
enum class Tone { READY, USER, AGENT, BUSY, ACTING, ATTENTION, PAUSED, DONE, FAILED, UNCERTAIN }
enum class Level { NONE, MIC, PLAYBACK }

data class OverlayFrame(
  val tone: Tone,
  val level: Level,
  val label: String = "",
  val line: String = "",
  /** A second, concise detail; only used when an issue must stay visible beside pending work. */
  val note: String = "",
  /** What the user last said, kept above Boson's reply so the exchange reads as one turn. */
  val heard: String = "",
  /** When the frame changes without a new event, e.g. the post-speech thinking window closing. */
  val revalidateAt: Long? = null,
) {
  val captioned get() = label.isNotEmpty()
}

/**
 * Derives the overlay from the voice service's real inputs: server events, VAD, and the
 * speaker queue's actual playback. Older revisions and voice turns never overwrite newer ones.
 * Confined to one thread; the caller supplies the clock.
 */
class OverlayModel {
  private data class Task(val state: String, val detail: String, val goal: String, val revision: Int)
  private data class Issue(val tone: Tone, val label: String, val detail: String, val voiceTurn: Int?, val taskRevision: Int?)

  private var session = "connecting"
  private var task: Task? = null
  private var taskRevision = -1
  private var voiceTurn = -1
  private var issue: Issue? = null
  private var userSpeaking = false
  private var userTurnEndedAt: Long? = null
  private var userText = ""
  private val generating = mutableSetOf<String>()
  private var anonymousGenerating = false
  private var reading = false
  private val transcripts = LinkedHashMap<String, String>()
  private var playing: String? = null
  /** The reply that just finished playing stays readable until [Reply.until]. */
  private data class Reply(val id: String, val until: Long)
  private var reply: Reply? = null
  /** Shown while idle after a resolved task, until the user speaks again. */
  private var result: Task? = null

  fun session(state: String) { session = state }

  fun speechStarted() {
    userSpeaking = true
    userTurnEndedAt = null
    userText = ""
    result = null
    reply = null
  }

  /** The user's turn ended: transcript, response generation, or playback proves it. */
  private fun endUserTurn(now: Long) {
    if (userSpeaking) { userSpeaking = false; userTurnEndedAt = now }
  }

  fun userTranscript(text: String, now: Long) { userText = text.trim(); endUserTurn(now) }

  /** Partial transcription, when the voice model streams it; the completed transcript replaces it. */
  fun userTranscriptDelta(text: String) { userText += text }

  fun reading(active: Boolean) { reading = active }

  fun transcript(responseId: String, text: String, append: Boolean) {
    transcripts[responseId] = (if (append) transcripts[responseId].orEmpty() else "") + text
    while (transcripts.size > 8) transcripts.remove(transcripts.keys.first())
  }

  /** From the speaker thread: the response whose PCM is actually being written, or null when silent. */
  fun playback(responseId: String?, now: Long) {
    if (responseId != null) {
      // An audible reply answers the turn, so the post-speech thinking window no longer applies.
      userSpeaking = false; userTurnEndedAt = null; reply = null
    } else playing?.let { reply = Reply(it, now + REPLY_LINGER_MS) }
    playing = responseId
  }

  /** Returns false for a stale turn the caller must also discard. */
  fun voiceResponse(event: JSONObject, now: Long): Boolean {
    val turn = (event.int("voiceTurn") ?: -1)
    if (turn < voiceTurn) return false
    voiceTurn = turn
    val id = event.text("responseId")
    when (event.text("state")) {
      "generating" -> { endUserTurn(now); if (id.isEmpty()) anonymousGenerating = true else generating.add(id) }
      "audio" -> Unit
      else -> {
        if (id.isEmpty()) anonymousGenerating = false else generating.remove(id)
        if (event.text("state") == "finished" && issue?.voiceTurn != null && issue!!.voiceTurn!! < turn) issue = null
        if (event.text("state") in setOf("cancelled", "suppressed")) { transcripts.remove(id); return false }
      }
    }
    return true
  }

  fun voiceIssue(event: JSONObject) {
    val turn = (event.int("voiceTurn") ?: -1)
    val revision = event.int("taskRevision")
    if (turn < voiceTurn || (revision != null && revision < taskRevision)) return
    voiceTurn = turn
    generating.clear(); anonymousGenerating = false
    issue = Issue(if (event.text("state") == "unknown") Tone.UNCERTAIN else Tone.FAILED,
      if (event.text("state") == "unknown") "Reply uncertain" else "Voice issue", event.text("detail"), turn, revision)
  }

  fun task(event: JSONObject) {
    val revision = (event.int("revision") ?: -1)
    if (revision < taskRevision) return
    val next = Task(event.text("state"), event.text("detail"), event.text("goal"), revision)
    // Newer work supersedes any earlier issue. Same-revision progress keeps a voice issue visible beside it.
    if (revision > taskRevision || issue?.voiceTurn == null || next.state != "working") issue = null
    taskRevision = revision
    task = null
    when (next.state) {
      "working", "confirming", "question" -> task = next
      // Server detail is the only marker of a user stop; ask for a typed reason at this seam.
      "paused" -> if (next.detail.startsWith("Stopped by request")) result = next.copy(state = "stopped") else task = next
      "blocked" -> issue = Issue(Tone.FAILED, "Couldn't finish", next.detail, null, revision)
      "unknown" -> issue = Issue(Tone.UNCERTAIN, "Check the phone", next.detail, null, revision)
      "completed", "declined" -> result = next
    }
  }

  fun frame(now: Long): OverlayFrame {
    if (session == "connecting") return OverlayFrame(Tone.BUSY, Level.NONE, "Connecting")
    val pending = task?.let { taskLabel(it.state) }
    fun live(label: String) = if (pending == null) label else "$label · $pending"

    fun said(id: String, level: Level, until: Long? = null) =
      OverlayFrame(Tone.AGENT, level, live("Boson"), transcripts[id].orEmpty().trim(), heard = userText.trim(), revalidateAt = until)

    playing?.let { return said(it, Level.PLAYBACK) }
    if (userSpeaking) return OverlayFrame(Tone.USER, Level.MIC, live("Listening"), userText.trim())
    // A buffer underrun or the server's late "finished" must not flash Thinking between two halves of one reply.
    val lingering = reply?.takeIf { now < it.until && !transcripts[it.id].isNullOrBlank() }
    val thinkingUntil = userTurnEndedAt?.plus(THINKING_GRACE_MS)
    val generatingOther = generating.any { it != lingering?.id } || anonymousGenerating
    if (reading || generatingOther || (thinkingUntil != null && now < thinkingUntil)) {
      return OverlayFrame(Tone.BUSY, Level.NONE, live(if (reading) "Reading screen" else "Thinking"), userText.trim(),
        revalidateAt = thinkingUntil?.takeIf { now < it && !reading && !generatingOther })
    }
    lingering?.let { return said(it.id, Level.NONE, it.until) }
    val issue = issue
    task?.let { pendingTask ->
      val tone = when (pendingTask.state) { "working" -> Tone.ACTING; "paused" -> Tone.PAUSED; else -> Tone.ATTENTION }
      return OverlayFrame(tone, Level.NONE, pending!!, pausedDetail(pendingTask), issue?.let { "${it.label}. ${it.detail}" }.orEmpty())
    }
    if (issue != null) return OverlayFrame(issue.tone, Level.NONE, issue.label, issue.detail)
    result?.let {
      return when (it.state) {
        "completed" -> OverlayFrame(Tone.DONE, Level.NONE, "Done", it.goal)
        "declined" -> OverlayFrame(Tone.PAUSED, Level.NONE, "Cancelled", it.detail)
        else -> OverlayFrame(Tone.PAUSED, Level.NONE, "Stopped")
      }
    }
    return OverlayFrame(Tone.READY, Level.NONE)
  }

  private fun taskLabel(state: String) = when (state) {
    "working" -> "Working"
    "paused" -> "Paused"
    "confirming" -> "Needs your OK"
    else -> "Question"
  }

  private fun pausedDetail(task: Task) =
    if (task.state == "paused" && !task.detail.contains("continue", ignoreCase = true)) "Say continue to resume." else task.detail

  companion object {
    const val THINKING_GRACE_MS = 4_000L
    const val REPLY_LINGER_MS = 8_000L
  }
}
