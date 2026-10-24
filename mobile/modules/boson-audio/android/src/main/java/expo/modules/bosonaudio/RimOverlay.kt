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
import android.os.Build
import android.view.Gravity
import android.view.RoundedCorner
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Rim A: a non-touchable edge glow over other apps, drawn with Paper's Pulsing Border shader.
 * It breathes while idle and follows the real mic or playback level while someone talks; with
 * Android animations off it holds a still frame. Touches reach the app below because the window
 * stays within Android's maximum obscuring opacity for untouchable overlays.
 */
class RimOverlay(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val model = OverlayModel()
  private val windows = context.getSystemService(WindowManager::class.java)
  private var root: FrameLayout? = null
  private var glow: GlowView? = null
  private var caption: LinearLayout? = null
  private var heard: TextView? = null
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
    val previous = frame
    frame = model.frame(now)
    main.removeCallbacks(revalidate)
    frame.revalidateAt?.let { main.postAtTime(revalidate, it) }
    val glow = glow ?: return
    val caption = caption!!; val heard = heard!!; val label = label!!; val line = line!!; val note = note!!
    glow.show(frame)
    // A caption fading out still counts as gone, so a quick return enters again instead of vanishing.
    val appearing = frame.captioned && (caption.visibility != View.VISIBLE || !previous.captioned)
    if (appearing) {
      caption.animate().cancel()
      caption.visibility = View.VISIBLE
      caption.alpha = 0f; caption.translationY = 16 * density
      caption.animate().alpha(1f).translationY(0f).setDuration(320).setInterpolator(EASE_OUT)
    } else if (!frame.captioned && previous.captioned) {
      caption.animate().cancel()
      caption.animate().alpha(0f).translationY(8 * density).setDuration(180).setInterpolator(EASE_OUT).withEndAction { caption.visibility = View.GONE }
    }
    if (!frame.captioned) return

    show(heard, if (frame.heard.isEmpty()) "" else "\u201C${frame.heard}\u201D", fresh = !appearing && frame.heard != previous.heard)
    show(label, frame.label, fresh = !appearing && frame.label != previous.label, rise = 0f)
    label.setTextColor(toneColor(frame.tone))
    // Live speech follows its newest words; task details and recovery steps read from the start.
    val spoken = frame.tone == Tone.USER || frame.tone == Tone.AGENT || frame.tone == Tone.BUSY
    line.maxLines = 4
    line.ellipsize = if (spoken) null else TextUtils.TruncateAt.END
    line.gravity = if (spoken) Gravity.BOTTOM or Gravity.START else Gravity.TOP or Gravity.START
    line.isVerticalFadingEdgeEnabled = spoken
    if (!spoken) line.scrollTo(0, 0)
    // Streaming text extends the line; anything else is a new sentence and enters on its own.
    show(line, frame.line, fresh = !appearing && frame.line != previous.line && !frame.line.startsWith(previous.line.ifEmpty { "\u0000" }))
    show(note, frame.note, fresh = !appearing && frame.note != previous.note)
  }

  /** Sets a caption row; a fresh value fades in with a short rise, from text that is already in place. */
  private fun show(view: TextView, value: String, fresh: Boolean, rise: Float = 6f) {
    view.text = value
    view.visibility = if (value.isEmpty()) View.GONE else View.VISIBLE
    if (!fresh || value.isEmpty()) return
    view.animate().cancel()
    view.alpha = 0.2f; view.translationY = rise * density
    view.animate().alpha(1f).translationY(0f).setDuration(260).setInterpolator(EASE_OUT)
  }

  private val density get() = context.resources.displayMetrics.density

  private fun attachOrDetach() {
    val wanted = active && resumedActivities == 0 && Settings.canDrawOverlays(context)
    if (wanted && root == null) attach() else if (!wanted && root != null) detach()
  }

  private fun attach() {
    val density = context.resources.displayMetrics.density
    val glow = GlowView(context)
    val text = { size: Float, color: Int -> TextView(context).apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, size); setTextColor(color); includeFontPadding = false } }
    val label = text(11f, Color.WHITE).apply { isAllCaps = true; letterSpacing = 0.08f; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setLineHeight(TypedValue.COMPLEX_UNIT_SP, 16f) }
    val line = text(19f, Color.parseColor("#EFF0F0")).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); letterSpacing = -0.01f; setLineHeight(TypedValue.COMPLEX_UNIT_SP, 26f) }
    val note = text(14f, toneColor(Tone.FAILED)).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setLineHeight(TypedValue.COMPLEX_UNIT_SP, 20f) }
    val heard = text(15f, Color.parseColor("#B7C7BE")).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setLineHeight(TypedValue.COMPLEX_UNIT_SP, 21f) }
    line.setFadingEdgeLength((22 * density).toInt())
    // Every added line slides the block up instead of jumping it: the caption grows from the bottom, and
    // a full line scrolls inside itself.
    line.setOnScrollChangeListener { view, _, y, _, oldY -> if (y > oldY && view.isShown) glide(view, (y - oldY).toFloat()) }
    val caption = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
      visibility = View.GONE
      addView(heard, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = (12 * density).toInt() })
      addView(label); addView(line, LinearLayout.LayoutParams(-1, -2).apply { topMargin = (6 * density).toInt() }); addView(note, LinearLayout.LayoutParams(-1, -2).apply { topMargin = (4 * density).toInt() })
      addOnLayoutChangeListener { view, _, top, _, bottom, _, oldTop, _, oldBottom ->
        if (bottom == oldBottom && oldTop != 0 && top != oldTop && view.isShown && view.alpha == 1f) glide(view, (oldTop - top).toFloat())
        glow.captionTop = top.toFloat(); glow.invalidate()
      }
    }
    val captionParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM)
    val root = FrameLayout(context).apply {
      addView(glow, FrameLayout.LayoutParams(-1, -1))
      addView(caption, captionParams)
    }
    // Insets follow rotation and the app below; the caption clears the gesture bar, side cutouts and the screen's rounded corners.
    root.setOnApplyWindowInsetsListener { view, insets ->
      val bars = insets.getInsets(WindowInsets.Type.navigationBars() or WindowInsets.Type.displayCutout())
      val corner = insets.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT)?.radius ?: 0
      glow.cornerRadius = corner.toFloat()
      val side = (24 * density).toInt()
      captionParams.setMargins(max(side, bars.left + side), 0, max(side, bars.right + side), max(bars.bottom + (24 * density).toInt(), corner))
      caption.layoutParams = captionParams
      view.invalidate()
      insets
    }
    val params = WindowManager.LayoutParams(-1, -1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT).apply {
      alpha = min(0.8f, context.getSystemService(InputManager::class.java).maximumObscuringOpacityForTouch)
      layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      fitInsetsTypes = 0
      title = "Tandem overlay"
    }
    glow.windowAlpha = params.alpha
    try { windows.addView(root, params) } catch (_: Exception) { return }
    this.root = root; this.glow = glow; this.caption = caption; this.heard = heard; this.label = label; this.line = line; this.note = note
    render()
  }

  private fun detach() {
    try { windows.removeView(root) } catch (_: Exception) { }
    root = null; glow = null; caption = null; heard = null; label = null; line = null; note = null
  }

  /** Offsets a view by how far its content just jumped, then eases it home. */
  private fun glide(view: View, by: Float) {
    view.translationY += by
    view.animate().translationY(0f).setDuration(240).setInterpolator(EASE_OUT)
  }

  /** Per-tone look, taken from the Rim A prototype's idle/listening/thinking/speaking/acting states. */
  private class Style(val colors: List<Pair<String, Float>>, val base: Float, val react: Float, val speed: Float, val breathe: Float)

  private class GlowView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shaderMatrix = Matrix()
    private val rim = if (Build.VERSION.SDK_INT >= 33) RuntimeShader(RIM_SHADER) else null
    private val rimPaint = Paint().apply { shader = rim }
    private var frame = OverlayFrame(Tone.BUSY, Level.NONE)
    private var colors = style(Tone.BUSY).colors.map { rgba(it) }
    private var scrim = 0f
    private var rawLevel = 0f
    private var level = 0f
    private var energy = 0f
    private var clock = 0f
    private var shaderTime = 0f
    private var lastFrame = 0L
    /** Display corner radius in px, so the rim follows the real screen outline. */
    var cornerRadius = 0f
    /** Where the caption block starts, so the scrim always sits behind every line it shows. */
    var captionTop = Float.MAX_VALUE
    var windowAlpha = 1f
    private val motion get() = ValueAnimator.areAnimatorsEnabled()

    fun show(next: OverlayFrame) {
      if (next.level != frame.level) rawLevel = 0f
      frame = next
      if (!motion) snap()
      invalidate()
    }

    fun level(value: Float) { rawLevel = value }

    /** Reduced motion: a still frame at the state's resting look. */
    private fun snap() {
      colors = style(frame.tone).colors.map { rgba(it) }
      scrim = if (frame.captioned) 1f else 0f
      val s = style(frame.tone)
      level = if (frame.level == Level.NONE) 0f else 0.35f
      energy = min(1f, s.base * 0.5f + 0.5f * s.breathe * 0.35f + level * s.react * 0.9f)
    }

    private fun step() {
      val now = SystemClock.uptimeMillis()
      val dt = if (lastFrame == 0L) 0f else min(0.05f, (now - lastFrame) / 1000f)
      lastFrame = now
      val s = style(frame.tone)
      clock += dt
      val raw = if (frame.level == Level.NONE) 0f else rawLevel
      // Fast attack, slow release, like a VU meter.
      level += (raw - level) * (1 - exp(-dt * if (raw > level) 36f else 5f))
      val breath = (sin(clock * 1.6f) * 0.5f + 0.5f) * s.breathe
      val target = min(1f, s.base * 0.5f + breath * 0.35f + level * s.react * 0.9f)
      energy += (target - energy) * (1 - exp(-dt * 12f))
      val ease = 1 - exp(-dt * 3.7f)
      colors = colors.zip(s.colors.map { rgba(it) }) { a, b -> FloatArray(4) { a[it] + (b[it] - a[it]) * ease } }
      scrim += ((if (frame.captioned) 1f else 0f) - scrim) * (1 - exp(-dt * 10f))
      shaderTime += dt * s.speed * (1 + energy)
    }

    override fun onDraw(canvas: Canvas) {
      val animate = motion && isAttachedToWindow
      if (animate) step() else { lastFrame = 0L; snap() }
      val w = width.toFloat(); val h = height.toFloat()
      val e = energy

      if (scrim > 0.01f) {
        val top = min(h - 330 * density, captionTop - 160 * density)
        paint.shader = LinearGradient(0f, top, 0f, h, intArrayOf(Color.TRANSPARENT, Color.argb((217 * scrim).toInt(), 13, 16, 18), Color.argb((242 * scrim).toInt(), 13, 16, 18)), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, top, w, h, paint)
      }

      // Bottom hotspot: follows real input or playback level, breathes faintly otherwise.
      val primary = colors[0]
      val hot = (0.18f + 0.6f * e).coerceAtMost(0.8f)
      val radius = w * (0.4f + 0.3f * e)
      paint.shader = RadialGradient(0f, 0f, 1f, intArrayOf(color(primary, hot), color(primary, hot * 0.35f), Color.TRANSPARENT), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
      shaderMatrix.setScale(radius, radius * (0.35f + 0.25f * e)); shaderMatrix.postTranslate(w / 2, h)
      paint.shader.setLocalMatrix(shaderMatrix)
      canvas.drawRect(0f, h - radius, w, h, paint)
      paint.shader = null

      val rim = rim
      if (rim != null) {
        rim.setFloatUniform("size", w, h)
        rim.setFloatUniform("density", density)
        rim.setFloatUniform("time", shaderTime)
        rim.setFloatUniform("radius", (if (cornerRadius > 0f) cornerRadius / min(w, h) else 0.16f))
        rim.setFloatUniform("thicknessIn", 0.015f + 0.05f * e)
        rim.setFloatUniform("softness", 0.85f)
        rim.setFloatUniform("intensityIn", 0.12f + 0.45f * e)
        rim.setFloatUniform("bloomIn", 0.2f + 0.35f * e)
        rim.setFloatUniform("spotSizeIn", 0.35f + 0.3f * e)
        rim.setFloatUniform("smokeIn", 0.15f + 0.35f * e)
        rim.setFloatUniform("gain", 1f / windowAlpha)
        colors.forEachIndexed { i, c -> rim.setFloatUniform("color$i", c[0], c[1], c[2], c[3]) }
        canvas.drawRect(0f, 0f, w, h, rimPaint)
      } else {
        // API 31-32 fallback: plain gradients along each edge, heaviest at the bottom.
        val edge = (10 + 10 * e) * density
        val edgeColor = color(primary, 0.35f + 0.5f * e)
        paint.shader = LinearGradient(0f, 0f, 0f, edge, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(0f, 0f, w, edge, paint)
        paint.shader = LinearGradient(0f, 0f, edge, 0f, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(0f, 0f, edge, h, paint)
        paint.shader = LinearGradient(w, 0f, w - edge, 0f, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(w - edge, 0f, w, h, paint)
        paint.shader = LinearGradient(0f, h, 0f, h - 2 * edge, edgeColor, Color.TRANSPARENT, Shader.TileMode.CLAMP); canvas.drawRect(0f, h - 2 * edge, w, h, paint)
        paint.shader = null
      }
      if (animate) postInvalidateOnAnimation()
    }

    private fun rgba(c: Pair<String, Float>) = Color.parseColor(c.first).let { floatArrayOf(Color.red(it) / 255f, Color.green(it) / 255f, Color.blue(it) / 255f, c.second) }
    private fun color(c: FloatArray, alpha: Float) = Color.argb((255 * (alpha * c[3]).coerceIn(0f, 1f)).toInt(), (c[0] * 255).toInt(), (c[1] * 255).toInt(), (c[2] * 255).toInt())
  }

  companion object {
    /** Exponential ease-out: quick to respond, soft to land. */
    private val EASE_OUT = PathInterpolator(0.16f, 1f, 0.3f, 1f)
    private const val ACCENT = "#2BCB3A"
    private const val HOVER = "#50DE5D"
    private const val SOFT = "#8CC4A4"
    private const val PALE = "#D2F5DF"
    private const val INFO = "#9ACCF0"

    private fun style(tone: Tone) = when (tone) {
      Tone.READY -> Style(listOf(SOFT to 0.7f, ACCENT to 0.55f, PALE to 0.35f), 0.25f, 0f, 0.35f, 1f)
      Tone.USER -> Style(listOf(ACCENT to 1f, HOVER to 1f, PALE to 0.9f), 0.35f, 1f, 1f, 0.2f)
      Tone.BUSY -> Style(listOf(INFO to 0.9f, SOFT to 1f, ACCENT to 0.8f), 0.45f, 0f, 2.6f, 0.5f)
      Tone.AGENT -> Style(listOf(SOFT to 1f, PALE to 1f, ACCENT to 0.6f), 0.35f, 1f, 0.9f, 0.2f)
      Tone.ACTING -> Style(listOf(ACCENT to 0.8f, SOFT to 0.7f, PALE to 0.4f), 0.2f, 0f, 0.8f, 0.6f)
      Tone.ATTENTION -> Style(listOf(ACCENT to 1f, HOVER to 0.8f, PALE to 0.5f), 0.4f, 0f, 0.8f, 0.5f)
      Tone.DONE -> Style(listOf(SOFT to 1f, PALE to 0.6f, ACCENT to 0.5f), 0.3f, 0f, 0.5f, 0.4f)
      Tone.PAUSED -> Style(listOf("#ADCABB" to 0.9f, SOFT to 0.6f, PALE to 0.25f), 0.3f, 0f, 0.4f, 0.3f)
      Tone.FAILED -> Style(listOf("#FFB4AB" to 0.9f, "#FFB4AB" to 0.6f, PALE to 0.25f), 0.4f, 0f, 0.4f, 0.3f)
      Tone.UNCERTAIN -> Style(listOf("#F2CB7A" to 0.9f, "#F2CB7A" to 0.6f, PALE to 0.25f), 0.4f, 0f, 0.4f, 0.3f)
    }

    fun toneColor(tone: Tone) = Color.parseColor(when (tone) {
      Tone.USER, Tone.ATTENTION -> "#2BCB3A"
      Tone.AGENT, Tone.DONE -> "#8CC4A4"
      Tone.BUSY -> "#9ACCF0"
      Tone.ACTING -> "#2BCB3A"
      Tone.READY -> "#8CC4A4"
      Tone.PAUSED -> "#ADCABB"
      Tone.FAILED -> "#FFB4AB"
      Tone.UNCERTAIN -> "#F2CB7A"
    })
  }
}
