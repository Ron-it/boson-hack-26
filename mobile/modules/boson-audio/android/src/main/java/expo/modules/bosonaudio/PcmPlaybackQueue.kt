package expo.modules.bosonaudio

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.min

/** PCM buffering shared by WebSocket reception and the speaker thread. */
class PcmPlaybackQueue(private val capacityBytes: Int = 24_000 * 2 * 60) {
  data class Packet(val bytes: ByteArray, val epoch: Long)
  private val packets = ArrayDeque<Packet>()
  private val lock = ReentrantLock()
  private val available = lock.newCondition()
  private var queuedBytes = 0

  fun enqueue(bytes: ByteArray, epoch: Long): Boolean = lock.withLock {
    // Boson generates faster than playback. Bound memory by PCM bytes, not message count.
    // Never wait for the speaker here: this thread also receives speech-start interrupts.
    if (bytes.size > capacityBytes - queuedBytes) return false
    var offset = 0
    while (offset < bytes.size) {
      val end = min(offset + 1920, bytes.size)
      packets.addLast(Packet(bytes.copyOfRange(offset, end), epoch))
      offset = end
    }
    queuedBytes += bytes.size
    available.signal()
    true
  }

  fun poll(timeoutMs: Long): Packet? = lock.withLock {
    var remaining = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (packets.isEmpty()) {
      if (remaining <= 0) return null
      remaining = available.awaitNanos(remaining)
    }
    packets.removeFirst().also { queuedBytes -= it.bytes.size }
  }

  fun clear() = lock.withLock { packets.clear(); queuedBytes = 0 }
}
