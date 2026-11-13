// A lotus floating on dark water.
//  • Flower: six whorls of lance-shaped petals (outer ones lying on the water, inner ones
//    upright), sepals underneath, a ring of stamens in the heart. Petals carry a painted
//    gradient with fine veins.
//  • Water: a real ripple simulation (a height field stepped on the GPU). The cursor drops
//    ripples wherever it moves; the flower sheds faint rings of its own. The surface mirrors
//    the scene and bends that mirror image with the ripples.
//  • The flower and leaves bob gently, and rock a little when a ripple reaches them.
//
// Test switches:  ?still=1  no fade-in    ?warm=300  pre-run the water so stills show ripples

import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const PAGE = 0x050706;
const SIM = 18;      // world size of the simulated patch of water
const RES = 512;     // simulation grid
const STEP = 1 / 120; // simulation step, seconds
const WAVE_SPEED = (SIM / RES) * Math.SQRT1_2 / STEP; // world units per second

const rnd = (s) => { const x = Math.sin(s * 91.7 + 13.3) * 43758.5453; return x - Math.floor(x); };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// whorls, outside → heart. tilt: degrees from upright. bend/curl: radians along the petal, − curls up and in.
const WHORLS = [
  { n: 8, tilt: 82, L: 1.34, W: 0.31, cup: 0.14, bend: -0.2, curl: -0.3, r0: 0.26, y: 0.04, tint: 0xe98aae },
  { n: 8, tilt: 69, L: 1.28, W: 0.31, cup: 0.16, bend: -0.12, curl: -0.25, r0: 0.23, y: 0.065, tint: 0xf09bbb },
  { n: 8, tilt: 57, L: 1.16, W: 0.3, cup: 0.18, bend: -0.06, curl: -0.2, r0: 0.2, y: 0.09, tint: 0xf6adc8 },
  { n: 8, tilt: 45, L: 1.0, W: 0.27, cup: 0.19, bend: -0.02, curl: -0.22, r0: 0.18, y: 0.11, tint: 0xfbbdd3 },
  { n: 7, tilt: 34, L: 0.8, W: 0.23, cup: 0.2, bend: -0.08, curl: -0.28, r0: 0.17, y: 0.125, tint: 0xffcadb },
  { n: 6, tilt: 24, L: 0.52, W: 0.17, cup: 0.2, bend: -0.1, curl: -0.3, r0: 0.17, y: 0.135, tint: 0xffd6e3 },
];

// Local frame: base at the origin, length along +y, inside of the cup faces +z, outward is −z.
function petalGeometry({ L, W, cup, bend, curl }) {
  const SU = 28, SV = 12;
  const cy = [0], cz = [0], th = [0];
  for (let i = 1; i <= SU; i++) { // centre line: integrate the bend so the petal curves smoothly
    const u = i / SU, a = bend * u + curl * u * u * u;
    th.push(a);
    cy.push(cy[i - 1] + (Math.cos(a) * L) / SU);
    cz.push(cz[i - 1] - (Math.sin(a) * L) / SU);
  }
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= SU; i++) {
    const u = i / SU;
    // lance shape: narrow claw at the base, widest at ~40 %, drawn out to a point
    const hw = W * (Math.pow(Math.sin(Math.PI * Math.pow(u, 0.74)), 0.8) * (1 - 0.32 * smooth(0.78, 1, u)) + 0.16 * (1 - u) * (1 - u));
    for (let j = 0; j <= SV; j++) {
      const v = (j / SV) * 2 - 1, k = hw / W;
      const lift = cup * v * v * k - 0.035 * (1 - Math.abs(v)) * k; // cupped across, with a shallow crease down the middle
      pos.push(v * hw, cy[i] + lift * Math.sin(th[i]), cz[i] + lift * Math.cos(th[i]));
      uv.push((v + 1) / 2, u);
    }
  }
  for (let i = 0; i < SU; i++) for (let j = 0; j < SV; j++) {
    const a = i * (SV + 1) + j, b = a + 1, d = a + SV + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// pale at the base, deepening to the tip and towards the edges, with soft veins fanning out from the base
const petalTexture = () => canvasTexture(512, 1024, (g, w, h) => {
  const grad = g.createLinearGradient(0, h, 0, 0); // canvas bottom = base of the petal
  grad.addColorStop(0, "#fff6f9");
  grad.addColorStop(0.22, "#fddbe7");
  grad.addColorStop(0.6, "#f5aac6");
  grad.addColorStop(1, "#e27aa4");
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const mid = g.createLinearGradient(0, 0, w, 0); // lighter along the midrib, deeper at both edges
  mid.addColorStop(0, "rgba(205,88,138,0.42)"); mid.addColorStop(0.3, "rgba(205,88,138,0.04)");
  mid.addColorStop(0.5, "rgba(255,244,248,0.2)");
  mid.addColorStop(0.7, "rgba(205,88,138,0.04)"); mid.addColorStop(1, "rgba(205,88,138,0.42)");
  g.fillStyle = mid; g.fillRect(0, 0, w, h);
  g.lineCap = "round";
  for (let i = 0; i < 30; i++) { // each vein: a broad faint stroke with a fine one on top, so nothing reads as a hard line
    const x1 = ((i + 0.5) / 30) * w, x0 = w / 2 + (x1 - w / 2) * 0.1;
    for (const [wide, alpha] of [[9, 0.035], [2.2, 0.1 + rnd(i) * 0.07]]) {
      g.strokeStyle = `rgba(198,84,132,${alpha})`; g.lineWidth = wide;
      g.beginPath(); g.moveTo(x0, h); g.quadraticCurveTo(x0 + (x1 - x0) * 0.4, h * 0.6, x1, 0); g.stroke();
    }
  }
});

export const padTexture = () => canvasTexture(1024, 1024, (g, w) => {
  const c = w / 2;
  const grad = g.createRadialGradient(c, c, 20, c, c, c);
  grad.addColorStop(0, "#2d7f64"); grad.addColorStop(0.5, "#216650"); grad.addColorStop(0.86, "#184c3c"); grad.addColorStop(1, "#123a2e");
  g.fillStyle = grad; g.fillRect(0, 0, w, w);
  for (let i = 0; i < 46; i++) { // soft mottling, drawn as blurred patches so nothing looks stamped on
    const x = rnd(i + 3) * w, y = rnd(i + 7) * w, rad = 40 + rnd(i + 11) * 110;
    const m = g.createRadialGradient(x, y, 0, x, y, rad);
    const dark = rnd(i + 19) > 0.5;
    m.addColorStop(0, dark ? "rgba(6,28,22,0.16)" : "rgba(70,150,120,0.12)"); m.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = m; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.lineCap = "round";
  const vein = (x0, y0, x1, y1, wide, alpha) => { // each vein = a wide faint stroke under a fine brighter one
    g.strokeStyle = `rgba(110,190,158,${alpha * 0.35})`; g.lineWidth = wide * 3; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = `rgba(132,206,176,${alpha})`; g.lineWidth = wide; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  };
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, q = 0.56 + rnd(i + 31) * 0.1;
    const mx = c + Math.cos(a) * c * q, my = c + Math.sin(a) * c * q;
    vein(c, c, mx, my, 3, 0.5);
    for (const da of [-0.085, 0.085]) {
      const ex = c + Math.cos(a + da) * c * 0.9, ey = c + Math.sin(a + da) * c * 0.9;
      vein(mx, my, ex, ey, 2, 0.38);
      for (const db of [-0.04, 0.04]) vein(ex, ey, c + Math.cos(a + da + db) * c, c + Math.sin(a + da + db) * c, 1.2, 0.26);
    }
  }
  const rim = g.createRadialGradient(c, c, c * 0.9, c, c, c); // a slightly lighter lip
  rim.addColorStop(0, "rgba(120,196,166,0)"); rim.addColorStop(1, "rgba(120,196,166,0.22)");
  g.fillStyle = rim; g.fillRect(0, 0, w, w);
});

// A round floating leaf with the lily's V-shaped notch. Many small steps round the edge and
// eight rings from centre to rim give a smooth outline and a smooth, shallow dish with a lifted lip.
export function padGeometry(r, gap = 0.34) {
  const SEG = 180, RINGS = 8, pos = [0, 0, 0], uv = [0.5, 0.5], idx = [];
  for (let i = 0; i <= SEG; i++) {
    const a = gap / 2 + (i / SEG) * (Math.PI * 2 - gap);
    const fromNotch = Math.min(i, SEG - i) / SEG;                              // 0 at the two edges of the notch
    const outline = (1 + 0.03 * Math.sin(a * 3 + r * 4) + 0.014 * Math.sin(a * 5 + r * 9)) // slow, soft lobes
      * (1 - 0.1 * Math.exp(-Math.pow(fromNotch * 26, 2)));                    // rounded shoulders where the notch meets the rim
    for (let k = 1; k <= RINGS; k++) {
      const f = k / RINGS;
      const y = 0.05 * Math.pow(f, 4) + 0.007 * f * f * Math.sin(a * 4 + r * 2); // lip lifts gently; the blade undulates a little
      pos.push(Math.cos(a) * r * f * outline, y, Math.sin(a) * r * f * outline);
      uv.push(0.5 + Math.cos(a) * 0.5 * f, 0.5 + Math.sin(a) * 0.5 * f);
    }
  }
  const at = (i, k) => 1 + i * RINGS + (k - 1);
  for (let i = 0; i < SEG; i++) {
    idx.push(0, at(i + 1, 1), at(i, 1));
    for (let k = 1; k < RINGS; k++) idx.push(at(i, k), at(i + 1, k), at(i, k + 1), at(i, k + 1), at(i + 1, k), at(i + 1, k + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── ripple simulation: classic height-field wave equation, two buffers swapped every step ──
const SIM_VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SIM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tPrev;      // r = height now, g = height one step ago
  uniform vec2 uTexel;
  uniform vec3 uDrops[8];       // xy = position (uv), z = strength
  uniform float uDropR;
  uniform float uDamp;
  uniform float uIsland;        // radius (uv) of the flower: it sits in the water and breaks the waves
  varying vec2 vUv;
  void main() {
    vec4 d = texture2D(tPrev, vUv);
    float s = texture2D(tPrev, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tPrev, vUv - vec2(uTexel.x, 0.0)).r
            + texture2D(tPrev, vUv + vec2(0.0, uTexel.y)).r + texture2D(tPrev, vUv - vec2(0.0, uTexel.y)).r;
    float h = (s * 0.5 - d.g) * uDamp;
    for (int i = 0; i < 8; i++) {
      float q = distance(vUv, uDrops[i].xy) / uDropR;
      h += uDrops[i].z * exp(-q * q);
    }
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    h *= smoothstep(0.0, 0.07, edge);                                  // waves die out at the border
    h *= smoothstep(uIsland * 0.55, uIsland, distance(vUv, vec2(0.5))); // and against the flower
    gl_FragColor = vec4(h, d.r, 0.0, 1.0);
  }`;

const WaterShader = {
  name: "LocusWater",
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    tH: { value: null }, uTime: { value: 0 }, uCam: { value: V(0, 2, 8) }, uLight: { value: V(-0.08, 0.26, -0.96).normalize() }, // low back light: its glitter falls on the far water, behind the flower
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vPos;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tH;
    uniform float uTime;
    uniform vec3 uCam;
    uniform vec3 uLight;
    varying vec4 vUv;
    varying vec3 vPos;
    const float SIM = ${SIM.toFixed(1)};
    const float E = ${(1 / RES).toFixed(6)};
    float H(vec2 p) { return texture2D(tH, p).r; }
    void main() {
      vec2 p = vPos.xz / SIM + 0.5;
      float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
      vec2 raw = vec2(H(p + vec2(E, 0.0)) - H(p - vec2(E, 0.0)), H(p + vec2(0.0, E)) - H(p - vec2(0.0, E))) * inside * 5.0;
      vec2 slope = raw / (1.0 + length(raw) * 2.2);            // soft limit: tall waves stay believable
      // a slow swell, so the surface is never glass-flat even before anything touches it
      slope += vec2(sin(vPos.x * 1.7 + uTime * 0.6) * cos(vPos.z * 1.3 - uTime * 0.45),
                    cos(vPos.x * 1.1 - uTime * 0.5) * sin(vPos.z * 1.9 + uTime * 0.38)) * 0.014;
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec4 uv = vUv;
      uv.xy += n.xz * 0.075 * uv.w;                              // ripples bend the mirror image
      vec3 mirror = texture2DProj(tDiffuse, uv).rgb;
      vec3 view = normalize(uCam - vPos);
      float fres = pow(1.0 - max(dot(view, n), 0.0), 3.0);     // more mirror-like at a low angle
      // the night sky the water mirrors: near-black overhead, a dim green band at the horizon, a blush of
      // light where the back light sits. Ripples tilt the surface, so they show as bands of this sky.
      vec3 rdir = reflect(-view, n);
      float up = clamp(rdir.y, 0.0, 1.0);
      vec3 sky = mix(vec3(0.012, 0.046, 0.037), vec3(0.0, 0.004, 0.003), pow(up, 0.5));
      sky += vec3(0.95, 0.6, 0.72) * pow(max(dot(rdir, uLight), 0.0), 48.0) * 0.08;
      vec3 col = color + sky * (0.35 + 0.65 * fres) + mirror * (0.5 + 0.45 * fres);
      float glint = pow(max(dot(n, normalize(view + uLight)), 0.0), 500.0);
      col += vec3(1.0, 0.82, 0.88) * glint * 0.16;             // light catching the ripple crests
      float r = length(vPos.xz);
      // ripples catch the back light on the side that faces it: this is what makes each ring readable on dark water
      float lit = clamp(-dot(raw, normalize(uLight.xz)) * 2.4, 0.0, 0.3) + clamp(length(raw) * 0.6, 0.0, 0.08);
      col += mix(vec3(0.14, 0.32, 0.28), vec3(0.85, 0.5, 0.62), exp(-r * 0.3)) * lit;
      gl_FragColor = vec4(col, smoothstep(15.0, 6.0, r));       // the water dissolves into the dark page
    }`,
};

// Builds the flower on its own, so the hero test page and the shared pond use the very same model.
export function createFlower() {
  const flower = new THREE.Group();
  const tex = petalTexture();
  // All the petals are one mesh (their tint rides on the vertices), so the flower is drawn in a few calls instead of one per petal.
  const pivot = new THREE.Object3D(), blade = new THREE.Object3D();
  pivot.add(blade);
  const baked = (geo, tint) => {
    pivot.updateMatrixWorld(true);
    const g = geo.clone().applyMatrix4(blade.matrixWorld);
    if (tint) {
      const col = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < col.length; i += 3) tint.toArray(col, i);
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    }
    return g;
  };
  const petals = [];
  WHORLS.forEach((w, wi) => {
    const geo = petalGeometry(w), tint = new THREE.Color(w.tint);
    for (let k = 0; k < w.n; k++) {
      const seed = wi * 37 + k;
      pivot.rotation.y = ((k + (wi % 2) * 0.5) / w.n) * Math.PI * 2 + (rnd(seed) - 0.5) * 0.16;
      const up = k % 2 ? 1 : -1; // odd petals ride slightly inside and above their neighbours
      blade.position.set(0, w.y + up * 0.012, -w.r0 + up * 0.012);
      blade.rotation.set(-THREE.MathUtils.degToRad(w.tilt - up * 3 + (rnd(seed + 5) - 0.5) * 3), (rnd(seed + 13) - 0.5) * 0.07, (rnd(seed + 9) - 0.5) * 0.08);
      blade.scale.set(0.94 + rnd(seed + 3) * 0.12, 0.93 + rnd(seed + 17) * 0.14, 1);
      petals.push(baked(geo, tint));
    }
  });
  flower.add(new THREE.Mesh(mergeGeometries(petals), new THREE.MeshPhysicalMaterial({
    map: tex, vertexColors: true, side: THREE.DoubleSide, roughness: 0.52, metalness: 0,
    sheen: 0.6, sheenColor: new THREE.Color(0xf3c8d4), sheenRoughness: 0.5,
    emissive: new THREE.Color(0x9a3560), emissiveMap: tex, emissiveIntensity: 0.28, // light seeming to pass through the petal
  })));
  // the fleshy base the petals grow from: it closes the gap at the bottom of the flower, so you never see through to the stamens
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.3, 40, 24), new THREE.MeshStandardMaterial({ color: 0xf6c3d5, roughness: 0.6 }));
  base.scale.set(1, 0.42, 1);
  base.position.y = 0.07;
  flower.add(base);
  // four dark sepals under the outer petals
  const sepalGeo = petalGeometry({ L: 0.98, W: 0.25, cup: 0.1, bend: -0.06, curl: -0.1 });
  const sepalMat = new THREE.MeshStandardMaterial({ color: 0x235746, roughness: 0.65, side: THREE.DoubleSide }); // mid green, so they read as sepals and not as dark holes
  const sepals = [];
  blade.scale.set(1, 1, 1);
  for (let k = 0; k < 4; k++) {
    pivot.rotation.y = (k / 4) * Math.PI * 2 + Math.PI / 8 + 0.2;
    blade.position.set(0, 0.012, -0.27);
    blade.rotation.set(-THREE.MathUtils.degToRad(89), 0, 0);
    sepals.push(baked(sepalGeo));
  }
  flower.add(new THREE.Mesh(mergeGeometries(sepals), sepalMat));
  // stamens: three rings of fine curved filaments with darker tips
  const filament = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(0, 0, 0), V(0, 0.24, -0.07), V(0, 0.47, 0.02)), 8, 0.012, 5, false);
  const RINGS = [[38, 0.16, 40], [30, 0.11, 27], [20, 0.06, 12]];
  const count = RINGS.reduce((s, r) => s + r[0], 0);
  const filaments = new THREE.InstancedMesh(filament, new THREE.MeshStandardMaterial({ color: 0xf6d77a, roughness: 0.55, emissive: 0xb8860b, emissiveIntensity: 0.35 }), count);
  const anthers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshStandardMaterial({ color: 0xf2b23c, roughness: 0.6, emissive: 0xa35a00, emissiveIntensity: 0.3 }), count);
  const d = new THREE.Object3D();
  let si = 0;
  for (const [n, rad, lean] of RINGS) for (let i = 0; i < n; i++, si++) {
    const a = (i / n) * Math.PI * 2 + rnd(si) * 0.25;
    d.position.set(-Math.sin(a) * rad, 0.13, -Math.cos(a) * rad);
    d.rotation.set(0, 0, 0); d.scale.set(1, 0.85 + rnd(si + 60) * 0.3, 1);
    d.rotateY(a); d.rotateX(-THREE.MathUtils.degToRad(lean + (rnd(si + 30) - 0.5) * 10));
    d.updateMatrix();
    filaments.setMatrixAt(si, d.matrix);
    const tip = V(0, 0.47, 0.02).applyMatrix4(d.matrix);
    d.position.copy(tip); d.scale.set(1, 2.3, 1); d.updateMatrix();
    anthers.setMatrixAt(si, d.matrix);
  }
  flower.add(filaments, anthers);
  const stigma = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.08, 20), new THREE.MeshStandardMaterial({ color: 0xf0c75a, roughness: 0.6 }));
  stigma.position.y = 0.15;
  flower.add(stigma);
  const heart = new THREE.PointLight(0xffd9a8, 0.5, 2.2, 2); // a little warmth inside the cup
  heart.position.y = 0.5;
  flower.add(heart);
  flower.scale.setScalar(1.08);
  return flower;
}

export function initLotus(host, opts = {}) {
  const query = new URLSearchParams(location.search);
  const still = opts.still ?? query.has("still");
  const warm = Number(query.get("warm") || opts.warm || 0);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    console.warn("locus lotus: WebGL unavailable.", err);
    return null;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;opacity:0";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAGE);
  scene.fog = new THREE.FogExp2(PAGE, 0.045);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;
  const camera = new THREE.PerspectiveCamera(28, 2, 0.1, 100);

  scene.add(new THREE.HemisphereLight(0xdcefe8, 0x030504, 0.5));
  const key = new THREE.DirectionalLight(0xfff1e6, 2.0); // soft daylight from the front-left
  key.position.set(-4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xf3b6cb, 0.9); // back light: gives the petals their glowing edges
  rim.position.set(2, 3.5, -6);
  scene.add(rim);

  // ── flower ──
  const flower = createFlower();
  scene.add(flower);

  // ── leaves ──
  const padMat = new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.78, metalness: 0, envMapIntensity: 0.3, side: THREE.DoubleSide });
  const PAD_Y = 0.022; // clear of the surface, so a rocking leaf never dips through the water and leaves a jagged shoreline
  const pads = [[-2.7, -1.0, 1.55, 0.5], [2.6, -1.8, 1.35, 2.3], [-0.5, -3.4, 1.7, 4.1], [4.3, 0.5, 1.15, 3.3], [-4.6, 0.9, 1.25, 5.6], [1.9, 1.7, 0.62, 1.2]].map(([x, z, r, turn], i) => {
    const m = new THREE.Mesh(padGeometry(r), padMat);
    m.position.set(x, PAD_Y, z);
    m.rotation.y = turn;
    m.userData = { phase: i * 1.9, r };
    scene.add(m);
    return m;
  });
  // a few beads of water, each resting on (and moving with) its leaf
  const beadGeo = new THREE.SphereGeometry(1, 20, 14);
  const beadMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.3, envMapIntensity: 2 });
  for (let i = 0; i < 14; i++) {
    const pad = pads[i % 3 === 0 ? 5 : i % 2], a = rnd(i + 70) * 6.28, f = 0.15 + rnd(i + 80) * 0.6;
    const sz = 0.022 + rnd(i + 90) * 0.04;
    const bead = new THREE.Mesh(beadGeo, beadMat);
    bead.scale.set(sz, sz * 0.62, sz);
    bead.position.set(Math.cos(a) * pad.userData.r * f, 0.05 * Math.pow(f, 4) + sz * 0.5, Math.sin(a) * pad.userData.r * f);
    pad.add(bead);
  }

  // ── water ──
  const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  let simA = new THREE.WebGLRenderTarget(RES, RES, rtOpts), simB = new THREE.WebGLRenderTarget(RES, RES, rtOpts);
  const simMat = new THREE.ShaderMaterial({
    vertexShader: SIM_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / RES, 1 / RES) },
      uDrops: { value: Array.from({ length: 8 }, () => V(0, 0, 0)) }, uDropR: { value: 0.0075 }, uDamp: { value: 0.994 }, uIsland: { value: 0.3 / SIM },
    },
  });
  const simScene = new THREE.Scene();
  simScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat));
  const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const queue = []; // drops waiting to enter the water: { x, z, s } in world units
  const kicks = []; // ripples on their way to the flower: { at, amp, dx, dz }
  const drop = (x, z, s, now = 0, rock = true) => {
    if (Math.abs(x) > SIM / 2 || Math.abs(z) > SIM / 2) return;
    queue.push({ x, z, s });
    const dist = Math.hypot(x, z);
    if (rock && dist > 0.6) kicks.push({ at: now + dist / WAVE_SPEED, amp: Math.min(0.022, Math.abs(s) * 0.55 / (1 + dist * 0.5)), dx: x / dist, dz: z / dist });
    if (kicks.length > 10) kicks.shift();
  };
  function simStep() {
    const u = simMat.uniforms;
    for (let i = 0; i < 8; i++) { const q = queue.shift(); if (q) u.uDrops.value[i].set(q.x / SIM + 0.5, q.z / SIM + 0.5, q.s); else u.uDrops.value[i].set(0, 0, 0); }
    u.tPrev.value = simA.texture;
    renderer.setRenderTarget(simB);
    renderer.render(simScene, simCam);
    renderer.setRenderTarget(null);
    [simA, simB] = [simB, simA];
  }
  const shed = (now, s = 0.02) => { for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; queue.push({ x: Math.cos(a) * 0.75, z: Math.sin(a) * 0.75, s }); } }; // a ring leaving the flower

  const water = new Reflector(new THREE.PlaneGeometry(44, 44), { textureWidth: 1024, textureHeight: 1024, color: 0x03100d, clipBias: 0.003, shader: WaterShader });
  water.rotation.x = -Math.PI / 2;
  water.material.transparent = true;
  scene.add(water);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.7, 0.9));
  composer.addPass(new OutputPass());

  // ── sizing ──
  const target = V(0, opts.targetY ?? 0.36, 0); // lower it to push the flower up in the frame
  let camDist = 8.4;
  function resize() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    const mirror = Math.min(2048, Math.round(Math.max(w, h) * dpr * 0.8));
    water.getRenderTarget().setSize(mirror, mirror);
    camDist = Math.max(8.4, 2.3 / (Math.tan(THREE.MathUtils.degToRad(14)) * camera.aspect)); // keep the whole flower in frame on narrow screens
    scene.fog.density = (0.045 * 8.4) / camDist; // same haze on the flower however far back the camera sits
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // ── pointer → ripples ──
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(V(0, 1, 0), 0), hit = V(0, 0, 0), ptr = new THREE.Vector2();
  const lastDrop = { x: 99, z: 99, t: 0 };
  let sway = 0, swayT = 0, clock = 0;
  function pointerToWater(e) {
    const r = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    swayT = ptr.x;
    ray.setFromCamera(ptr, camera);
    return ray.ray.intersectPlane(plane, hit);
  }
  const pad = opts.pointerTarget || canvas; // listen on a larger element so ripples follow the cursor over text too
  pad.addEventListener("pointermove", (e) => {
    if (!pointerToWater(e)) return;
    const now = performance.now(), dx = hit.x - lastDrop.x, dz = hit.z - lastDrop.z, moved = Math.hypot(dx, dz);
    if (moved < 0.1) return;
    if (moved > 3 || now - lastDrop.t > 400) { // the cursor has just arrived: start a new wake here
      drop(hit.x, hit.z, -0.02, clock);
    } else {
      const speed = Math.min(1, (moved / Math.max(8, now - lastDrop.t)) * 14);
      const n = Math.min(10, Math.ceil(moved / 0.1));
      for (let i = 1; i <= n; i++) drop(lastDrop.x + (dx * i) / n, lastDrop.z + (dz * i) / n, -(0.005 + 0.007 * speed), clock, i === n); // only the last one rocks the flower
    }
    lastDrop.x = hit.x; lastDrop.z = hit.z; lastDrop.t = now;
  });
  pad.addEventListener("pointerdown", (e) => { // a tap or click = a pebble (but not when pressing a button or link)
    if (!e.target.closest?.("a, button, input") && pointerToWater(e)) drop(hit.x, hit.z, -0.11, clock);
  });
  pad.addEventListener("pointerleave", () => { swayT = 0; });

  if (warm) { // pre-run the water for stills: the flower's own rings plus a cursor trail across the front
    shed(0, 0.03);
    for (let i = 0; i < warm; i++) {
      if (i % 9 === 0 && i > 20) { const f = i / warm; drop(-4.2 + f * 8.4, 2.3 - Math.sin(f * 3.1) * 0.9, -0.045); }
      if (i === warm - 150) drop(3.2, 2.9, -0.11); // and one pebble, front right
      if (i % 150 === 149) shed(0, 0.03);
      simStep();
    }
    kicks.length = 0;
  }

  // ── frame loop ──
  let last = performance.now(), acc = 0, nextShed = 0.4, running = true;
  const t0 = last;
  function render(dt, now) {
    clock += reduce ? 0 : dt;
    const t = clock;

    if (!reduce) {
      if (t > nextShed) { shed(t, 0.016); nextShed = t + 2.8; }
      acc += dt;
      for (let n = 0; acc >= STEP && n < 5; n++, acc -= STEP) simStep();
      if (acc > STEP * 5) acc = 0;
    }

    // bobbing: a slow breath, plus a little rock when a ripple arrives
    let by = Math.sin(t * 1.05) * 0.018 + Math.sin(t * 0.63 + 1.3) * 0.008, tx = Math.sin(t * 0.8) * 0.012, tz = Math.sin(t * 0.57 + 2) * 0.012;
    for (const k of kicks) {
      const tau = t - k.at;
      if (tau < 0 || tau > 3.5) continue;
      const w = k.amp * Math.exp(-1.7 * tau) * Math.sin(8 * tau);
      by += w; tx += w * 2.4 * k.dz; tz -= w * 2.4 * k.dx;
    }
    flower.position.y = 0.03 + by;
    flower.rotation.set(tx, Math.PI / 8 + Math.sin(t * 0.13) * 0.12, tz); // turned so a gap between outer petals faces the viewer; it sways a few degrees, it doesn't spin
    for (const p of pads) {
      const ph = p.userData.phase;
      p.position.y = PAD_Y + Math.sin(t * 0.9 + ph) * 0.006;
      p.rotation.x = Math.sin(t * 0.7 + ph) * 0.004;
      p.rotation.z = Math.cos(t * 0.6 + ph) * 0.004;
    }

    sway += (swayT - sway) * Math.min(1, dt * 1.6);
    camera.position.set(sway * 0.45, target.y + camDist * 0.332, camDist); // always about 18° above the water
    camera.lookAt(target);
    camera.updateMatrixWorld();

    const wu = water.material.uniforms;
    wu.tH.value = simA.texture;
    wu.uTime.value = t;
    wu.uCam.value.copy(camera.position);
    composer.render();

    const seen = still ? 1 : Math.min(1, (now - t0) / 1400);
    canvas.style.opacity = (seen * seen * (3 - 2 * seen)).toFixed(3);
  }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(dt, now);
    requestAnimationFrame(frame);
  }
  // cost of one full frame in milliseconds, measured with the GPU forced to finish (works even in a background tab)
  function bench(n = 40) {
    const gl = renderer.getContext(), start = performance.now();
    for (let i = 0; i < n; i++) { render(1 / 60, performance.now()); gl.finish(); }
    return (performance.now() - start) / n;
  }
  new IntersectionObserver(([e]) => {
    const was = running;
    running = e.isIntersecting;
    if (running && !was) { last = performance.now(); requestAnimationFrame(frame); }
  }).observe(host);
  requestAnimationFrame(frame);

  return { drop: (x, z, s = -0.11) => drop(x, z, s, clock), canvas, bench, debug: { renderer, composer, scene, camera } };
}
