// An illustrated version of the pond, switched on with ?art=ink (or ?art=paper).
// Two references shaped it: hand-painted bestiary plates (flat washes of colour, drawn
// contour lines, dots and stripes, the grain of the paper) and cut-paper collage (flat
// cut-outs standing in layers, things a little out of scale).
//
// What it changes:
//   • the picture is finished as a painting instead of a photograph (see PAINT_FRAG): colour
//     settles into a few flat tones, shapes get a drawn outline, paper grain shows through
//   • the water is a flat wash with ripples drawn as lines and reflections as broken brush
//     strokes, and a pale moon lying on it (see WATER_FRAG)
//   • surfaces lose their gloss (paintify), and cut-paper buds and seed heads stand in the pond

import * as THREE from "three";
import { canvasTexture } from "./lotus.js";

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; // as seen on screen
const lin = (hex) => new THREE.Color(hex);                                                      // as light in the scene

const STYLES = {
  // gouache and cut paper on black paper: keeps the page's dark structure
  ink: {
    dark: 1,
    ground: 0x050706,
    line: 0xf7f3ed,          // contour colour
    lineTint: 0.45,          // how much a contour takes the colour of what it outlines
    lineOpacity: 0.85,
    lineWeight: 1.5,         // canvas pixels, on a wide screen
    steps: 4, poster: 0.85, grain: 0.85,
    light: [-0.2, 0.16, -0.97],   // where the moon hangs (the water mirrors it upper-left of the lotus)
    sky: 2.3, skyGround: 0x8b9a94, key: 0.85,   // even light all round, a softer sun: flat colour, gentle shadows
    glow: 0.22,                   // how much the petals shine of themselves
    wake: 0.14,                   // the drifting lights barely stir the water: drawn ripples would scribble all over it
    water: { wash: 0x0c2e27, far: 0x040a09, ring: 0xf3c8d4, ringDark: 0x010202, moon: 0xf7ead9, stroke: 0.8 },
  },
  // watercolour and cut paper on ivory paper, like a plate from an old book: the page turns light with it
  paper: {
    dark: 0,
    ground: 0xf7f3ed,
    line: 0x102f29,
    lineTint: 0.55,
    lineOpacity: 0.8,
    lineWeight: 1.4,
    steps: 4, poster: 0.8, grain: 1.0,
    light: [-0.2, 0.16, -0.97],
    sky: 2.2, skyColor: 0xffffff, skyGround: 0xd8d2cc, key: 0.8,
    glow: 0.3,
    haze: 0.3,                    // far things barely fade: on paper they would only turn grey
    leaf: 1.7,                    // the floating leaves are painted lighter: sage on paper, not near-black
    wake: 0.14,
    pond: { edge: 0.74, hero: 0.37, story: 0.52, ragged: 0.4 }, // the water is one wash with paper left bare round it: how crisp its edge, its size by the lotus and by the story, how ragged
    water: { wash: 0xaed2c6, far: 0xd9e8df, ring: 0x275747, ringDark: 0x275747, moon: 0xfffdf8, stroke: 0.85 },
  },
};

export function artStyle() {
  const asked = new URLSearchParams(location.search).get("art");
  if (asked === null) return null;
  const name = STYLES[asked] ? asked : "ink";
  return { name, ...STYLES[name] };
}

// ── small noise, shared by the shaders ──
export const NOISE = /* glsl */ `
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }`;

// ── the last pass: from a lit 3D picture to a painted one ──
export const PAINT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uPx;        // one canvas pixel
  uniform vec2 uRes;       // canvas size in screen pixels: brush and grain keep their size on every screen
  uniform float uNear;
  uniform float uFar;
  uniform float uLine;     // contour weight, canvas pixels
  uniform float uDark;     // 1 = dark ground with light contours, 0 = light paper with dark contours
  uniform vec3 uInk;
  uniform vec4 uTune;      // x: how flat the colour is, y: number of tones, z: grain, w: contour opacity
  uniform vec2 uTint;      // x: how much a contour takes the colour of what it outlines, y: colour-edge sensitivity
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  varying vec2 vUv;
  ${NOISE}
  vec3 see(vec2 uv) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    c = uDark > 0.5 ? ACESFilmicToneMapping(c) : min(c, vec3(1.0)); // on paper colour is taken as it is, so the ground stays exactly the paper's colour
    return sRGBTransferOETF(vec4(c, 1.0)).rgb;
  }
  float far(vec2 uv) { float ndc = texture2D(tDepth, uv).r * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear)); }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec2 px = vUv * uRes;
    // a hand is never perfectly steady: everything is drawn a touch off true
    vec2 uv = vUv + (vec2(vnoise(px * 0.035), vnoise(px * 0.035 + 31.7)) - 0.5) * 2.4 * uLine * uPx;
    vec3 c = see(uv);
    float d = far(uv);

    // contours: where the depth breaks (the edge of a thing) or the colour does (one field against another)
    vec2 o = uPx * uLine * (0.75 + 0.6 * vnoise(px * 0.018 + 5.0)); // the line swells and thins like a brush line
    vec2 ox = vec2(o.x, 0.0), oy = vec2(0.0, o.y);
    vec3 cl = see(uv - ox), cr = see(uv + ox), cu = see(uv + oy), cd = see(uv - oy);
    float lap = abs(far(uv - ox) + far(uv + ox) + far(uv + oy) + far(uv - oy) - 4.0 * d) / d;
    float edge = max(smoothstep(0.004, 0.012, lap), smoothstep(uTint.y, uTint.y * 2.0, length(cl - cr) + length(cu - cd)) * 0.8);

    // paint: colour settles into a few flat tones, their borders uneven like a wash drying
    float l = luma(c);
    float t = l * uTune.y + (vnoise(px * 0.011) - 0.5) * 0.3 + 0.5;
    float tone = (floor(t) - 1.0 + smoothstep(0.4, 0.6, fract(t)) + 0.62) / uTune.y;
    vec3 paint = mix(c, c * clamp(tone / max(l, 0.02), 0.0, 2.0), uTune.x);
    paint = mix(vec3(luma(paint)), paint, 1.12); // a little more pigment

    // the paper's tooth: pigment sits unevenly on it
    float tooth = vnoise(px * 0.85) * 0.6 + vnoise(px * 2.1 + 11.0) * 0.4 - 0.5;
    float fibre = vnoise(vec2(px.x * 0.06, px.y * 1.3)) - 0.5;
    paint *= 1.0 + (vnoise(px * 0.006 + 3.0) - 0.5) * 0.22 * uTune.z;          // a wash never dries perfectly even
    paint *= 1.0 - (tooth * 0.22 + fibre * 0.08) * uTune.z;
    paint += (tooth * 0.014 + fibre * 0.006) * uTune.z;

    // the drawn line: light on a dark ground, dark on paper, tinted by what it outlines
    vec3 near5 = max(max(max(cl, cr), max(cu, cd)), c);
    vec3 low5 = min(min(min(cl, cr), min(cu, cd)), c);
    vec3 lineCol = uDark > 0.5 ? mix(uInk, near5 * 1.15 + 0.08, uTint.x) : mix(uInk, low5 * 0.55, uTint.x);
    paint = mix(paint, lineCol, edge * uTune.w * (0.82 + 0.3 * vnoise(px * 0.3))); // the line breaks up a little on the grain
    gl_FragColor = vec4(paint, 1.0);
  }`;

// ── the water, drawn ──
export const WATER_FRAG = (SIM, CX, CZ) => /* glsl */ `
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform sampler2D tH;
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uLight;
  uniform float uMirror;
  uniform float uGlow;
  uniform vec2 uCentre;
  uniform vec2 uFade;
  uniform float uE;
  uniform float uSlope;
  uniform float uBlend;
  uniform vec3 uWash;      // the water's own colour, near
  uniform vec3 uWashFar;   // and far
  uniform vec3 uRing;      // ripple line, the side facing the light
  uniform vec3 uRingDark;  // and the side turned away
  uniform vec3 uMoonCol;
  uniform vec3 uSky;       // what the mirror shows where nothing stands
  uniform vec4 uDraw;      // x: ripple lines per unit of wave height, y: mirror stroke amount, z: moon size (cosine), w: moon strength
  uniform sampler2D tKoi;  // a painted fish, seen from above, head at the top
  uniform vec4 uKoi[2];    // where each fish is: x, z, heading, half-length
  uniform float uRagged;   // how uneven the edge of the wash is
  varying vec4 vUv;
  varying vec3 vPos;
  const float SIM = ${SIM.toFixed(1)};
  const vec2 MID = vec2(${CX.toFixed(2)}, ${CZ.toFixed(2)});
  ${NOISE}
  float H(vec2 p) { vec2 h = texture2D(tH, p).rg; return mix(h.g, h.r, uBlend); }
  void main() {
    float reach = length(vPos.xz - uCentre) + (vnoise(vPos.xz * 0.3 + 4.0) + vnoise(vPos.xz * 0.9) * 0.5 - 0.75) * uFade.y * uRagged; // a wash ends where the brush left it
    float alpha = smoothstep(uFade.y, uFade.x, reach);
    if (alpha <= 0.002) discard;
    vec2 p = (vPos.xz - MID) / SIM + 0.5;
    float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
    float hE = H(p + vec2(uE, 0.0)), hW = H(p - vec2(uE, 0.0)), hN = H(p + vec2(0.0, uE)), hS = H(p - vec2(0.0, uE));
    vec2 raw = vec2(hE - hW, hN - hS) * inside * uSlope;
    vec2 slope = raw / (1.0 + length(raw) * 2.2);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 view = normalize(uCam - vPos);
    vec3 rdir = reflect(-view, n);

    // a flat wash, deeper into the distance
    vec3 col = mix(uWash, uWashFar, smoothstep(5.0, 24.0, distance(vPos.xz, uCam.xz)));

    // fish under the surface: painted flat, bent by the ripples above them, their bodies swaying as they swim
    for (int i = 0; i < 2; i++) {
      vec4 k = uKoi[i];
      vec2 q = vPos.xz + slope * 0.9 - k.xy;
      float cs = cos(k.z), sn = sin(k.z);
      q = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y) / k.w;          // into the fish's own frame: x across, y towards the head
      q.x += sin(q.y * 4.0 - uTime * 2.2 + float(i) * 2.0) * 0.05 * (0.7 - q.y);
      vec2 kuv = vec2(q.x / 1.15 + 0.5, q.y * 0.5 + 0.5);                 // drawn broad: seen low across the water it would vanish otherwise
      if (k.w > 0.0 && kuv.x > 0.0 && kuv.x < 1.0 && kuv.y > 0.0 && kuv.y < 1.0) {
        vec4 fish = texture2D(tKoi, kuv);
        col = mix(col, mix(uWash, fish.rgb, 0.82), fish.a * 0.92);
      }
    }

    // brush strokes that run across the water, stacked into the distance: reflections are laid down in them
    float lay = vnoise(vec2(vPos.x * 0.55 + 2.0, vPos.z * 5.5)) * 0.65 + vnoise(vec2(vPos.x * 1.7, vPos.z * 15.0 + 9.0)) * 0.35;
    float stroke = smoothstep(0.36, 0.5, lay);

    vec4 uv = vUv;
    uv.xy += n.xz * 0.1 * uv.w;
    vec3 mirror = texture2DProj(tDiffuse, uv).rgb;
    float there = smoothstep(0.012, 0.05, length(mirror - uSky));   // something stands here and is mirrored
    col = mix(col, mix(col, mirror, 0.72), there * mix(0.35, 1.0, stroke) * uDraw.y * uMirror);

    // the moon on the water: a pale disc where the surface mirrors it, cut into strokes and bent by every ripple
    float m = dot(rdir, uLight);
    float moon = smoothstep(uDraw.z, uDraw.z + 0.0012, m);
    float path = smoothstep(uDraw.z - 0.006, uDraw.z, m) * (1.0 - moon);        // a few stray glints round it
    col = mix(col, uMoonCol, (moon * mix(0.72, 1.0, stroke) + path * smoothstep(0.66, 0.72, lay) * 0.45) * uDraw.w * uGlow);

    // ripples, drawn the way a print draws them: each wave is a few thin lines of even weight (contour lines of its height),
    // bright along the crests, fainter in the troughs
    float v = (hE + hW + hN + hS) * 0.25 * inside * uDraw.x;
    float fw = max(fwidth(v), 1e-4);
    float ringLine = (1.0 - smoothstep(0.75, 1.6, abs(fract(v) - 0.5) / fw)) * (1.0 - smoothstep(0.22, 0.45, fw));
    ringLine *= mix(0.22, 1.0, 1.0 - smoothstep(uFade.x * 0.5, uFade.x * 1.05, distance(vPos.xz, uCentre))); // fainter away from the middle, where the page's words sit
    col = mix(col, uRing, ringLine * (v > 0.0 ? 0.85 : 0.4));
    gl_FragColor = vec4(col, alpha);
  }`;

export function waterUniforms(style, sky) {
  const w = style.water;
  return {
    uWash: { value: lin(w.wash) }, uWashFar: { value: lin(w.far) },
    uRing: { value: lin(w.ring) }, uRingDark: { value: lin(w.ringDark) },
    uMoonCol: { value: lin(w.moon) }, uSky: { value: lin(sky) },
    uDraw: { value: new THREE.Vector4(70, w.stroke, Math.cos(THREE.MathUtils.degToRad(2.6)), 1) },
    tKoi: { value: koiCard() }, uKoi: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uRagged: { value: style.pond ? style.pond.ragged : 0 },
  };
}

export function paintUniforms(style) {
  return {
    uInk: { value: new THREE.Vector3(...rgb(style.line)) },
    uDark: { value: style.dark },
    uLine: { value: style.lineWeight },
    uTune: { value: new THREE.Vector4(style.poster, style.steps, style.grain, style.lineOpacity) },
    uTint: { value: new THREE.Vector2(style.lineTint, 0.2) },
  };
}

// Gouache has no gloss: every surface becomes plain matt colour, and the glass case is left as its drawn edges.
export function paintify(scene, style) {
  scene.traverse((o) => {
    const m = o.material;
    if (o.isHemisphereLight) { o.intensity = style.sky; o.groundColor.set(style.skyGround); if (style.skyColor) o.color.set(style.skyColor); }
    if (!m || !m.isMeshStandardMaterial) return;
    if (m.transparent && m.opacity < 0.1) { o.visible = false; return; }
    m.roughness = 1;
    m.metalness = 0;
    m.envMapIntensity = 0;
    if (m.name === "pad" && style.leaf) m.color.setScalar(style.leaf);
    if (m.isMeshPhysicalMaterial) { m.sheen = 0; m.emissiveIntensity = style.glow; } // (the petals)
  });
}

// ── cut-paper plants ──
// Each is painted on a card: a pale margin left round it by the scissors, flat colour, a drawn line.
const PAPER = "#f1eadf";
function card(w, h, draw) {
  return canvasTexture(w, h, (g) => {
    g.lineJoin = g.lineCap = "round";
    // pass 1: the whole silhouette in paper colour, fat, so a margin shows round the painted part
    draw(g, (path, fill, line, lw = 5) => { g.strokeStyle = PAPER; g.fillStyle = PAPER; g.lineWidth = lw + 26; path(); g.stroke(); g.fill(); }, true);
    // pass 2: the painting
    draw(g, (path, fill, line, lw = 5) => { path(); g.fillStyle = fill; g.fill(); if (line) { g.strokeStyle = line; g.lineWidth = lw; g.stroke(); } }, false);
  });
}
const stalk = (g, x0, y0, x1, y1, bend) => () => { g.beginPath(); g.moveTo(x0 - 9, y0); g.quadraticCurveTo(x0 - 9 + bend, (y0 + y1) / 2, x1 - 6, y1); g.lineTo(x1 + 6, y1); g.quadraticCurveTo(x0 + 9 + bend, (y0 + y1) / 2, x0 + 9, y0); g.closePath(); };

const budCard = () => card(512, 1024, (g, put, under) => {
  put(stalk(g, 250, 1024, 262, 380, 46), "#2c6a55", "#123a30");
  if (!under) { g.fillStyle = "#123a30"; for (let i = 0; i < 16; i++) { g.beginPath(); g.arc(262 + Math.sin(i * 1.9) * 7 + (1 - Math.abs(i - 8) / 8) * 20, 430 + i * 36, 2.6, 0, 6.3); g.fill(); } } // prickles, as dots
  // the closed flower
  put(() => { g.beginPath(); g.moveTo(262, 392); g.bezierCurveTo(150, 340, 150, 170, 268, 40); g.bezierCurveTo(382, 170, 376, 340, 262, 392); g.closePath(); }, "#eda3bd", "#b04a78", 6);
  if (!under) {
    g.strokeStyle = "#b04a78"; g.lineWidth = 5;
    g.beginPath(); g.moveTo(262, 392); g.bezierCurveTo(214, 300, 228, 170, 268, 40); g.stroke();
    g.beginPath(); g.moveTo(262, 392); g.bezierCurveTo(318, 300, 306, 170, 268, 40); g.stroke();
    g.fillStyle = "rgba(255,238,244,0.55)"; g.beginPath(); g.moveTo(262, 380); g.bezierCurveTo(232, 300, 240, 190, 268, 70); g.bezierCurveTo(294, 190, 296, 300, 262, 380); g.fill(); // the pale middle petal
  }
  // two sepals holding it
  put(() => { g.beginPath(); g.moveTo(262, 400); g.bezierCurveTo(190, 392, 168, 330, 176, 270); g.bezierCurveTo(214, 300, 246, 350, 262, 400); g.closePath(); }, "#2c6a55", "#123a30");
  put(() => { g.beginPath(); g.moveTo(262, 400); g.bezierCurveTo(334, 392, 356, 330, 350, 270); g.bezierCurveTo(312, 300, 280, 350, 262, 400); g.closePath(); }, "#2c6a55", "#123a30");
});

const podCard = () => card(512, 1024, (g, put, under) => {
  put(stalk(g, 262, 1024, 250, 420, -40), "#2c6a55", "#123a30");
  // the seed head: a cone, striped, with a flat dotted top
  put(() => { g.beginPath(); g.moveTo(96, 236); g.bezierCurveTo(120, 330, 200, 410, 250, 432); g.bezierCurveTo(304, 410, 388, 330, 416, 236); g.closePath(); }, "#3c7d64", "#123a30", 6);
  if (!under) {
    g.strokeStyle = "#1c4d3f"; g.lineWidth = 4;
    for (let i = 1; i < 8; i++) { const x = 96 + i * 40; g.beginPath(); g.moveTo(x, 248); g.quadraticCurveTo(250 + (x - 256) * 0.5, 350, 250 + (x - 256) * 0.1, 424); g.stroke(); }
  }
  put(() => { g.beginPath(); g.ellipse(256, 232, 164, 58, 0, 0, 6.3); g.closePath(); }, "#f3c8d4", "#b04a78", 6);
  if (!under) {
    g.fillStyle = "#123a30";
    for (const [x, y, r] of [[256, 232, 15], [196, 218, 13], [316, 218, 13], [156, 236, 11], [356, 236, 11], [222, 252, 13], [290, 252, 13], [256, 200, 11], [200, 246, 0], [130, 222, 0]]) if (r) { g.beginPath(); g.ellipse(x, y, r, r * 0.55, 0, 0, 6.3); g.fill(); }
  }
});

// A koi from above, painted the way the bestiary paints its animals: flat body, rose patches, dark dots, a drawn line.
const rnd = (n) => { const x = Math.sin(n * 91.7 + 13.3) * 43758.5453; return x - Math.floor(x); };
function koiCard() {
  return canvasTexture(384, 1024, (g, w) => {
    const cx = w / 2, LINE = "#b04a78";
    g.lineJoin = g.lineCap = "round";
    const body = () => { g.beginPath(); g.moveTo(cx, 96); g.bezierCurveTo(cx + 104, 150, cx + 96, 470, cx + 20, 770); g.lineTo(cx - 20, 770); g.bezierCurveTo(cx - 96, 470, cx - 104, 150, cx, 96); g.closePath(); };
    const fin = (side) => { g.beginPath(); g.moveTo(cx + side * 70, 300); g.bezierCurveTo(cx + side * 170, 310, cx + side * 176, 420, cx + side * 120, 470); g.bezierCurveTo(cx + side * 110, 400, cx + side * 90, 350, cx + side * 66, 340); g.closePath(); };
    const tail = () => { g.beginPath(); g.moveTo(cx - 18, 760); g.bezierCurveTo(cx - 60, 840, cx - 130, 900, cx - 150, 990); g.bezierCurveTo(cx - 70, 960, cx - 20, 930, cx, 880); g.bezierCurveTo(cx + 20, 930, cx + 70, 960, cx + 150, 990); g.bezierCurveTo(cx + 130, 900, cx + 60, 840, cx + 18, 760); g.closePath(); };
    g.fillStyle = "rgba(243,200,212,0.85)"; g.strokeStyle = LINE; g.lineWidth = 5; // fins and tail: thin and pale
    for (const side of [-1, 1]) { fin(side); g.fill(); g.stroke(); }
    tail(); g.fill(); g.stroke();
    g.lineWidth = 2.5;
    for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(cx + i * 4, 792); g.quadraticCurveTo(cx + i * 22, 876, cx + i * 40, i === 0 ? 880 : 962 - Math.abs(i) * 6); g.stroke(); }
    body(); g.fillStyle = "#f6efe4"; g.fill();
    g.save(); body(); g.clip();
    g.fillStyle = "#e58aa8";
    for (const [x, y, rx, ry, rot] of [[cx - 22, 196, 72, 58, 0.3], [cx + 44, 404, 58, 92, -0.2], [cx - 30, 612, 50, 72, 0.4]]) { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, 6.3); g.fill(); }
    g.fillStyle = "#123a30";
    for (let i = 0; i < 24; i++) { g.beginPath(); g.arc(cx + (rnd(i + 3) - 0.5) * 150, 150 + rnd(i + 40) * 570, 4.5 + rnd(i + 80) * 4, 0, 6.3); g.fill(); }
    g.restore();
    body(); g.lineWidth = 6; g.stroke();
    g.lineWidth = 3; g.beginPath(); g.moveTo(cx, 250); g.quadraticCurveTo(cx + 6, 500, cx, 742); g.stroke(); // the line down its back
    for (const side of [-1, 1]) { g.beginPath(); g.arc(cx + side * 44, 172, 8, 0, 6.3); g.fill(); }             // eyes
  });
}

// Two fish on slow rounds: one about the lotus, a smaller one about the story's stage.
const ROUNDS = [{ cx: 0.2, cz: 0.6, rx: 3.5, rz: 2.5, speed: 0.085, phase: 2.2, size: 0.85 }, { cx: 30.4, cz: -3.2, rx: 8.4, rz: 6.6, speed: -0.06, phase: 0.6, size: 0.7 }];
export function swim(t, uniforms) {
  ROUNDS.forEach((r, i) => {
    const a = r.phase + t * r.speed, x = r.cx + Math.cos(a) * r.rx, z = r.cz + Math.sin(a) * r.rz;
    const dx = -Math.sin(a) * r.rx * Math.sign(r.speed), dz = Math.cos(a) * r.rz * Math.sign(r.speed); // the way it is heading
    uniforms.uKoi.value[i].set(x, z, Math.atan2(dx, dz), r.size);
  });
}

export function addCutouts(scene) {
  const flats = [];
  const place = (tex, x, z, height, lean, flip = 1) => {
    const g = new THREE.PlaneGeometry(height / 2, height).translate(0, height / 2, 0); // stands on its foot
    const paper = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }));
    const shade = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, transparent: true, opacity: 0.42, alphaTest: 0.2, depthWrite: false, side: THREE.DoubleSide }));
    shade.position.set(0.07, -0.04, -0.06); // the card's shadow on the layer behind
    paper.layers.set(1); shade.layers.set(1); // layer 1: seen by the page's camera, left out of the water's mirror image (paper stuck onto the picture casts no reflection)
    const flat = new THREE.Group();
    flat.add(shade, paper);
    flat.position.set(x, -0.25, z); // foot under the water line
    flat.scale.x = flip;
    flat.userData = { lean, phase: x * 1.7 + z };
    scene.add(flat);
    flats.push(flat);
  };
  const bud = budCard(), pod = podCard();
  // round the lotus, nearest the viewer largest: out of scale on purpose, as in a collage
  place(bud, -2.55, 3.1, 1.75, 0.06);
  place(pod, 2.5, 2.7, 1.5, -0.05);
  place(bud, 3.5, 0.2, 1.2, -0.08, -1);
  place(pod, -3.9, -0.6, 1.05, 0.04);
  return {
    update(t) { for (const f of flats) f.rotation.z = f.userData.lean + Math.sin(t * 0.5 + f.userData.phase) * 0.012; }, // they stir like reeds
  };
}
