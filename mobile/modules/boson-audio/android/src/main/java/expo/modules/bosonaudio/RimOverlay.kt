package expo.modules.bosonaudio

import android.animation.ValueAnimator
import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.*
import android.hardware.input.InputManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Rim A: a non-touchable edge glow over other apps. It redraws only on state changes and real
 * audio level changes, never on a timer. Touches reach the app below because the window stays
 * within Android's maximum obscuring opacity for untouchable overlays.
 */
class RimOverlay(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val model = OverlayModel()
  private val windows = context.getSystemService(WindowManager::class.java)
  private var root: FrameLayout? = null
  private var glow: GlowView? = null
  private var label: TextView? = null
  private var line: TextView? = null
  private var note: TextView? = null
  private var frame = OverlayFrame(Tone.BUSY, Level.NONE)
  private var resumedActivities = 0
  private var active = false
  private val revalidate = Runnable { render() }
  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    // The app already shows the session; the overlay is for other apps.
    override fun onActivityResumed(activity: Activity) { resumedActivities++; attachOrDetach() }
    override fun onActivityPaused(activity: Activity) { resumedActivities = max(0, resumedActivities - 1); attachOrDetach() }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
  }

  fun start(appInForeground: Boolean) = main.post {
    active = true
    resumedActivities = if (appInForeground) 1 else 0
    (context.applicationContext as Application).registerActivityLifecycleCallbacks(lifecycle)
    attachOrDetach()
  }

  fun stop() = main.post {
    active = false
    (context.applicationContext as Application).unregisterActivityLifecycleCallbacks(lifecycle)
    attachOrDetach()
  }

  /** Applies model inputs on the main thread, then renders. Safe from any thread. */
  fun update(change: OverlayModel.(now: Long) -> Unit) = main.post { model.change(SystemClock.uptimeMillis()); render() }

  /** RMS level of PCM16 audio that was actually captured or played. */
  fun level(source: Level, pcm: ByteArray, count: Int) {
    var sum = 0.0
    var samples = 0
    var i = 0
    while (i + 1 < count) {
      val sample = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toDouble()
      sum += sample * sample; samples++; i += 2
    }
    if (samples == 0) return
    val db = 20 * log10(max(sqrt(sum / samples) / 32768.0, 1e-6))
    val value = ((db + 50) / 40).coerceIn(0.0, 1.0).toFloat()
    main.post { if (frame.level == source) glow?.level(value) }
  }

  private fun render() {
    val now = SystemClock.uptimeMillis()
    frame = model.frame(now)
    main.removeCallbacks(revalidate)
    frame.revalidateAt?.let { main.postAtTime(revalidate, it) }
    val glow = glow ?: return
    glow.show(frame)
    label!!.text = frame.label
    label!!.setTextColor(toneColor(frame.tone))
    line!!.text = frame.line
    line!!.visibility = if (frame.line.isEmpty()) View.GONE else View.VISIBLE
    // Transcripts stay on one line; an actionable issue may need a second.
    line!!.maxLines = if (frame.tone == Tone.FAILED || frame.tone == Tone.UNCERTAIN || frame.tone == Tone.ATTENTION) 2 else 1
    line!!.ellipsize = if (frame.level == Level.NONE) TextUtils.TruncateAt.END else TextUtils.TruncateAt.START
    note!!.text = frame.note
    note!!.visibility = if (frame.note.isEmpty()) View.GONE else View.VISIBLE
    (label!!.parent as View).visibility = if (frame.captioned) View.VISIBLE else View.GONE
  }

  private fun attachOrDetach() {
    val wanted = active && resumedActivities == 0 && Settings.canDrawOverlays(context)
    if (wanted && root == null) attach() else if (!wanted && root != null) detach()
  }

  private fun attach() {
    val density = context.resources.displayMetrics.density
    val glow = GlowView(context)
    val text = { size: Float, color: Int -> TextView(context).apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, size); setTextColor(color) } }
    val label = text(12f, Color.WHITE).apply { isAllCaps = true; letterSpacing = 0.08f; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    val line = text(18f, Color.parseColor("#EEF6F1")).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); setLineSpacing(0f, 1.2f) }
    val note = text(14f, toneColor(Tone.FAILED)).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    val caption = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
      addView(label); addView(line, LinearLayout.LayoutParams(-1, -2).apply { topMargin = (6 * density).toInt() }); addView(note, LinearLayout.LayoutParams(-1, -2).apply { topMargin = (4 * density).toInt() })
    }
    val insets = windows.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.navigationBars() or WindowInsets.Type.displayCutout())
    val root = FrameLayout(context).apply {
      addView(glow, FrameLayout.LayoutParams(-1, -1))
      addView(caption, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
        val side = (24 * density).toInt()
        setMargins(side, 0, side, insets.bottom + (28 * density).toInt())
      })
    }
    val params = WindowManager.LayoutParams(-1, -1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT).apply {
      alpha = min(0.8f, context.getSystemService(InputManager::class.java).maximumObscuringOpacityForTouch)
      layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      fitInsetsTypes = 0
      title = "Phone voice overlay"
    }
    try { windows.addView(root, params) } catch (_: Exception) { return }
    this.root = root; this.glow = glow; this.label = label; this.line = line; this.note = note
    render()
  }

  private fun detach() {
    try { windows.removeView(root) } catch (_: Exception) { }
    root = null; glow = null; label = null; line = null; note = null
  }

  private class GlowView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shaderMatrix = Matrix()
    private var frame = OverlayFrame(Tone.BUSY, Level.NONE)
    private var color = toneColor(Tone.BUSY)
    private var scrim = 0f
    private var level = 0f
    private var fade: ValueAnimator? = null
    private val motion get() = ValueAnimator.areAnimatorsEnabled()

    fun show(next: OverlayFrame) {
      if (next == frame) return
      val from = color
      val to = toneColor(next.tone)
      val scrimFrom = scrim
      val scrimTo = if (next.captioned) 1f else 0f
      if (next.level != frame.level) level = if (next.level != Level.NONE && !motion) 0.35f else 0f
      frame = next
      fade?.cancel()
      if (!motion) { color = to; scrim = scrimTo; invalidate(); return }
      fade = ValueAnimator.ofFloat(0f, 1f).setDuration(280).apply {
        addUpdateListener {
          val t = it.animatedFraction
          color = blend(from, to, t)
          scrim = scrimFrom + (scrimTo - scrimFrom) * t
          invalidate()
        }
        start()
      }
    }

    fun level(value: Float) {
      if (!motion) return
      // Quick attack, slower release, so syllables read without flicker.
      val next = if (value > level) level + (value - level) * 0.6f else level + (value - level) * 0.25f
      if (kotlin.math.abs(next - level) < 0.01f) return
      level = next
      invalidate()
    }

    override fun onDraw(canvas: Canvas) {
      val w = width.toFloat(); val h = height.toFloat()
      val base = when (frame.tone) { Tone.READY -> 0.35f; Tone.USER, Tone.AGENT -> 0.55f; else -> 0.7f }
      val e = if (frame.level == Level.NONE) 0f else level
      val strength = (base + 0.45f * e).coerceAtMost(1f)

      if (scrim > 0f) {
        val top = h - 300 * density
        paint.shader = LinearGradient(0f, top, 0f, h, intArrayOf(Color.TRANSPARENT, Color.argb((214 * scrim).toInt(), 13, 16, 18), Color.argb((235 * scrim).toInt(), 13, 16, 18)), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, top, w, h, paint)
      }

      // Soft all-around rim, thin on the top and sides.
      val edge = (10 + 8 * e) * density
      val edgeColor = withAlpha(color, 0.55f * strength)
      paint.shader = LinearGradient(0f, 0f, 0f, edge, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(0f, 0f, w, edge, paint)
      paint.shader = LinearGradient(0f, 0f, edge, 0f, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(0f, 0f, edge, h, paint)
      paint.shader = LinearGradient(w, 0f, w - edge, 0f, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(w - edge, 0f, w, h, paint)

      // Strongest along the bottom edge.
      val bottom = (28 + 36 * e) * density
      paint.shader = LinearGradient(0f, h, 0f, h - bottom, withAlpha(color, 0.8f * strength), Color.TRANSPARENT, Shader.TileMode.CLAMP)
      canvas.drawRect(0f, h - bottom, w, h, paint)

      // Audio hotspot: grows with real input or playback level only.
      val radius = w * (0.42f + 0.3f * e)
      val core = if (frame.tone == Tone.AGENT) Color.parseColor("#D2F5DF") else color
      paint.shader = RadialGradient(0f, 0f, 1f, intArrayOf(withAlpha(core, 0.75f * strength), withAlpha(color, 0.3f * strength), Color.TRANSPARENT), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
      shaderMatrix.setScale(radius, radius * (0.5f + 0.3f * e)); shaderMatrix.postTranslate(w / 2, h)
      paint.shader.setLocalMatrix(shaderMatrix)
      canvas.drawRect(0f, h - radius, w, h, paint)
      paint.shader = null
    }

    private fun withAlpha(color: Int, alpha: Float) = Color.argb((255 * alpha.coerceIn(0f, 1f)).toInt(), Color.red(color), Color.green(color), Color.blue(color))
    private fun blend(a: Int, b: Int, t: Float) = Color.rgb(
      (Color.red(a) + (Color.red(b) - Color.red(a)) * t).toInt(),
      (Color.green(a) + (Color.green(b) - Color.green(a)) * t).toInt(),
      (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t).toInt())
  }

  companion object {
    fun toneColor(tone: Tone) = Color.parseColor(when (tone) {
      Tone.USER, Tone.ATTENTION -> "#2BCB3A"
      Tone.AGENT, Tone.DONE -> "#8CC4A4"
      Tone.BUSY -> "#9ACCF0"
      Tone.READY -> "#8CC4A4"
      Tone.PAUSED -> "#ADCABB"
      Tone.FAILED -> "#FFB4AB"
      Tone.UNCERTAIN -> "#F2CB7A"
    })
  }
}
