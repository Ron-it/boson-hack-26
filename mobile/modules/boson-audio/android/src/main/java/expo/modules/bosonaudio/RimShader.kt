package expo.modules.bosonaudio

/**
 * AGSL port of Paper's Pulsing Border shader (@paper-design/shaders), the effect the Rim A
 * prototype uses. Differences from the WebGL original: AGSL has no fwidth, so antialiasing uses
 * one pixel; the noise texture becomes a hash; the corner radius comes from the real display.
 * Pulse is fixed at 0 and there are always 3 colors and 4 spots, as in the prototype.
 */
internal const val RIM_SHADER = """
uniform float2 size;
uniform float density;
uniform float time;
uniform float radius;
uniform float thicknessIn;
uniform float softness;
uniform float intensityIn;
uniform float bloomIn;
uniform float spotSizeIn;
uniform float smokeIn;
/** 1 / window alpha, so the rim reads as bright as the prototype through the touch-through cap. */
uniform float gain;
uniform float4 color0;
uniform float4 color1;
uniform float4 color2;

const float TWO_PI = 6.28318530718;

float hash(float2 p) {
  p = fract(p * float2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(float2 st) {
  float2 i = floor(st);
  float2 f = fract(st);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1, 0)), u.x), mix(hash(i + float2(0, 1)), hash(i + float2(1, 1)), u.x), u.y);
}

float roundedBox(float2 uv, float2 halfSize, float dist, float cornerDist, float thickness, float soft, float aa) {
  float borderDistance = abs(dist);
  float border = 1.0 - smoothstep(min(mix(thickness, -thickness, soft), thickness + aa), max(mix(thickness, -thickness, soft), thickness + aa), borderDistance);
  float circles = 0.0;
  circles = mix(1.0, circles, smoothstep(0.0, 1.0, length((uv + halfSize) / thickness)));
  circles = mix(1.0, circles, smoothstep(0.0, 1.0, length((uv - float2(-halfSize.x, halfSize.y)) / thickness)));
  circles = mix(1.0, circles, smoothstep(0.0, 1.0, length((uv - float2(halfSize.x, -halfSize.y)) / thickness)));
  circles = mix(1.0, circles, smoothstep(0.0, 1.0, length((uv - halfSize) / thickness)));
  float cornerFade = smoothstep(0.0, mix(aa * 0.5, thickness, soft), cornerDist) * circles;
  return border + cornerFade;
}

half4 main(float2 frag) {
  float unit = min(size.x, size.y);
  float aa = 2.0 / unit;
  float2 uv = (frag - 0.5 * size) / unit;
  uv.y = -uv.y;
  float2 halfSize = 0.5 * size / unit;
  float t = 1.2 * (time + 109.0);

  float thickness = 0.5 * thicknessIn * min(halfSize.x, halfSize.y);
  halfSize -= mix(thickness, 0.0, softness);
  float2 d = abs(uv) - halfSize + radius;
  float outsideDistance = length(max(d, 0.0001)) - radius;
  float insideDistance = min(max(d.x, d.y), 0.0001);
  float cornerDistance = abs(min(max(d.x, d.y) - 0.45 * radius, 0.0));
  float dist = outsideDistance + insideDistance;

  float border = roundedBox(uv, halfSize, dist, cornerDistance, mix(thickness, 3.0 * thickness, softness), softness, aa);
  border = pow(border, 1.0 + softness);

  float2 smokeUV = 0.15 * 0.01 * (frag - 0.5 * size) / density;
  float smoke = clamp(3.0 * valueNoise(2.7 * smokeUV + 0.5 * t), 0.0, 1.0);
  smoke -= valueNoise(3.4 * smokeUV - 0.5 * t);
  smoke *= roundedBox(uv, halfSize, dist, cornerDistance, min(0.4, max(thickness + 0.2, 0.1)), 1.0, aa);
  // The hash noise is harsher than Paper's texture, so smoke is scaled down to match the prototype's wisps.
  smoke = clamp(30.0 * smoke * smoke * 0.5 * smokeIn * smokeIn * 0.15, 0.0, 1.0);
  border = clamp(border + smoke, 0.0, 1.0);

  float3 blendColor = float3(0);
  float blendAlpha = 0.0;
  float3 addColor = float3(0);
  float addAlpha = 0.0;
  float bloom = 4.0 * bloomIn;
  float intensity = 1.0 + (1.0 + 4.0 * softness) * intensityIn;
  float angle = atan(uv.y, uv.x) / TWO_PI;

  for (int ci = 0; ci < 3; ci++) {
    float cf = float(ci);
    float4 col = ci == 0 ? color0 : (ci == 1 ? color1 : color2);
    float3 c = col.rgb * col.a;
    for (int si = 0; si < 4; si++) {
      float sf = float(si);
      float2 seed = float2(sf * 10.0 + 2.0, 40.0 + cf);
      float2 randVal = float2(hash(seed), hash(seed + 17.13));
      float spotTime = (0.1 + 0.15 * abs(sin(sf * (2.0 + cf)) * cos(sf * (2.0 + 2.5 * cf)))) * t + randVal.x * 3.0;
      spotTime *= mix(1.0, -1.0, step(0.5, randVal.y));
      float mask = 0.5 + 0.5 * mix(sin(t + sf * (5.0 - 1.5 * cf)), cos(t + sf * (3.0 + 1.3 * cf)), step(mod(cf, 2.0), 0.5));
      float atg = fract(angle + spotTime);
      float spotSize = 0.05 + 0.6 * spotSizeIn * spotSizeIn + 0.05 * randVal.x;
      float sector = smoothstep(0.5 - spotSize, 0.5, atg) * (1.0 - smoothstep(0.5, 0.5 + spotSize, atg));
      sector = clamp(sector * mask * border * intensity, 0.0, 1.0);
      blendColor += (1.0 - blendAlpha) * c * sector;
      blendAlpha += (1.0 - blendAlpha) * col.a * sector;
      addColor += c * sector;
      addAlpha += col.a * sector;
    }
  }

  float3 color = mix(blendColor, addColor, bloom);
  float alpha = clamp(mix(blendAlpha, addAlpha, bloom) * gain, 0.0, 1.0);
  color *= gain;
  color += (fract(sin(dot(0.014 * frag, float2(12.9898, 78.233))) * 43758.5453123) - 0.5) / 256.0;
  return half4(half3(clamp(color, 0.0, alpha)), half(alpha));
}
"""
