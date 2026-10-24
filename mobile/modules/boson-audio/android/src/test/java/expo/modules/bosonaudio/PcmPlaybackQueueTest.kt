package expo.modules.bosonaudio

import org.junit.Assert.*
import org.junit.Test

class PcmPlaybackQueueTest {
  @Test fun `a normal reply can arrive faster than the speaker plays it`() {
    val queue = PcmPlaybackQueue()
    val reply = ByteArray(24_000 * 2 * 8) { (it % 127).toByte() }
    assertTrue("An eight-second PCM reply must not end the voice session with Speaker buffer filled", queue.enqueue(reply, 7))
    var received = 0
    while (true) {
      val packet = queue.poll(0) ?: break
      assertEquals(7L, packet.epoch)
      assertTrue("Keep individual AudioTrack writes short enough to interrupt", packet.bytes.size <= 1920)
      assertArrayEquals(reply.copyOfRange(received, received + packet.bytes.size), packet.bytes)
      received += packet.bytes.size
    }
    assertEquals(reply.size, received)
  }

  @Test fun `network message boundaries do not consume extra audio capacity`() {
    val queue = PcmPlaybackQueue(24_000 * 2 * 12)
    repeat(240) { assertTrue(queue.enqueue(ByteArray(2400), 1)) }
    assertFalse("Audio beyond the byte budget must be rejected", queue.enqueue(ByteArray(2), 1))
  }

  @Test fun `interrupt discards the old reply and frees the byte budget`() {
    val queue = PcmPlaybackQueue(4800)
    assertTrue(queue.enqueue(ByteArray(4800), 1))
    queue.clear()
    assertTrue(queue.enqueue(ByteArray(4800) { 9 }, 2))
    var received = 0
    while (true) {
      val packet = queue.poll(0) ?: break
      assertEquals(2L, packet.epoch)
      assertTrue(packet.bytes.all { it == 9.toByte() })
      received += packet.bytes.size
    }
    assertEquals(4800, received)
  }

  @Test fun `oversized message is rejected without partially queuing it`() {
    val queue = PcmPlaybackQueue(4800)
    assertTrue(queue.enqueue(ByteArray(1920) { 3 }, 1))
    assertFalse(queue.enqueue(ByteArray(4800), 1))
    assertArrayEquals(ByteArray(1920) { 3 }, queue.poll(0)!!.bytes)
    assertNull(queue.poll(0))
  }
}
