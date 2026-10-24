package expo.modules.bosonaudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OverlayModelTest {
  private fun task(state: String, revision: Int, detail: String = "Opening Display settings") =
    JSONObject().put("type", "task").put("state", state).put("goal", "Turn on Night Light").put("detail", detail).put("revision", revision)
  private fun voice(state: String, turn: Int, id: String? = "r$turn") =
    JSONObject().put("type", "voice_response").put("state", state).put("voiceTurn", turn).put("responseId", id ?: JSONObject.NULL)
  private fun issue(state: String, turn: Int, revision: Any = JSONObject.NULL) =
    JSONObject().put("type", "voice_issue").put("source", "voice").put("state", state).put("detail", "Boson didn't answer. Say it again.").put("voiceTurn", turn).put("taskRevision", revision)
  private fun listening() = OverlayModel().apply { session("listening") }

  @Test fun `pending work stays visible while Boson speaks and after its response finishes`() {
    val model = listening()
    model.speechStarted()
    model.voiceResponse(voice("generating", 1), 0)
    model.task(task("working", 2))
    model.transcript("r1", "What can I help you with?", append = false)
    model.playback("r1", 10)
    assertEquals("Boson · Working", model.frame(10).label)
    model.playback(null, 20)
    model.voiceResponse(voice("finished", 1), 20)
    val frame = model.frame(10_000)
    assertEquals(Tone.ACTING, frame.tone)
    assertEquals("Working", frame.label)
    assertEquals("Opening Display settings", frame.line)
  }

  @Test fun `failed and uncertain outcomes stay distinct and persist through speech and replies`() {
    val model = listening()
    model.task(task("unknown", 3, "I tapped send, but it doesn't show as sent yet. I won't send it again; check the conversation."))
    assertEquals(Tone.UNCERTAIN to "Check the phone", model.frame(0).let { it.tone to it.label })
    model.speechStarted()
    model.userTranscript("what happened", 100)
    model.voiceResponse(voice("finished", 4), 100)
    assertEquals("Check the phone", model.frame(10_000).label)
    model.task(task("blocked", 5, "I couldn't open Settings. Open Display settings, then say continue."))
    assertEquals(Tone.FAILED to "Couldn't finish", model.frame(10_000).let { it.tone to it.label })
    model.task(task("working", 6))
    assertEquals("Working", model.frame(10_000).label)
  }

  @Test fun `earlier revisions and voice turns cannot overwrite fresh work`() {
    val model = listening()
    model.voiceResponse(voice("generating", 4), 0)
    model.task(task("working", 7))
    model.task(task("blocked", 6, "Old failure"))
    model.voiceIssue(issue("blocked", 3))
    model.voiceIssue(issue("blocked", 4, revision = 6))
    model.voiceResponse(voice("finished", 4), 0)
    val frame = model.frame(10_000)
    assertEquals("Working", frame.label)
    assertEquals("", frame.note)
  }

  @Test fun `a current voice issue sits beside pending work and clears on a later good turn`() {
    val model = listening()
    model.task(task("working", 2))
    model.voiceIssue(issue("unknown", 1, revision = 2))
    assertEquals("Working" to "Reply uncertain. Boson didn't answer. Say it again.", model.frame(0).let { it.label to it.note })
    model.voiceResponse(voice("finished", 2, id = null), 0)
    assertEquals("", model.frame(0).note)
  }

  @Test fun `a finished reply stays readable under what the user said, then clears`() {
    val model = listening()
    model.speechStarted()
    model.userTranscriptDelta("turn on ")
    assertEquals("turn on", model.frame(0).line)
    model.userTranscript("turn on night light", 100)
    model.voiceResponse(voice("generating", 1), 100)
    model.transcript("r1", "Night Light is on.", append = false)
    model.playback("r1", 200)
    // A playback gap mid-reply, with the response still generating, keeps the reply up rather than flashing Thinking.
    model.playback(null, 1_000)
    assertEquals(Triple(Tone.AGENT, "Night Light is on.", "turn on night light"), model.frame(1_000).let { Triple(it.tone, it.line, it.heard) })
    model.voiceResponse(voice("finished", 1), 1_200)
    assertEquals(Tone.AGENT, model.frame(1_000 + OverlayModel.REPLY_LINGER_MS - 1).tone)
    assertEquals(Tone.READY, model.frame(1_000 + OverlayModel.REPLY_LINGER_MS).tone)
  }

  @Test fun `thinking after the user stops is bounded`() {
    val model = listening()
    model.speechStarted()
    model.userTranscript("turn on night light", 1_000)
    assertEquals(Tone.BUSY to "Thinking", model.frame(1_500).let { it.tone to it.label })
    assertEquals(Tone.READY, model.frame(1_000 + OverlayModel.THINKING_GRACE_MS).tone)
  }
}
