package expo.modules.bosonaudio

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class FamilyVoiceTest {
  @Test fun wavHeaderDescribes24kHzMonoPcm() {
    val pcm = ByteArray(48000)
    val file = ByteBuffer.wrap(wav(pcm)).order(ByteOrder.LITTLE_ENDIAN)
    assertEquals(44 + pcm.size, file.capacity())
    assertEquals("RIFF", String(wav(pcm), 0, 4))
    assertEquals(36 + pcm.size, file.getInt(4))
    assertEquals(1, file.getShort(22).toInt())
    assertEquals(24000, file.getInt(24))
    assertEquals(16, file.getShort(34).toInt())
    assertEquals(pcm.size, file.getInt(40))
  }
}
