// Scene: a room of graphics cards (left) hands its job to one ordinary server (right).
// Everything is drawn as dots in three.js. Neutral dots = the usual way, green = your
// server, pink = the model and anything that is live.

import * as THREE from "three";

const PINK = [0.914, 0.627, 0.714];
const BLUSH = [0.953, 0.784, 0.831];
const IVORY = [0.969, 0.953, 0.929];
const GREEN = [0.26, 0.58, 0.47]; // brand mid-green, lifted so single dots read on black

const LOOP = 21; // seconds

const VERT = `
attribute float aSeed;
attribute float aOrder;
attribute float aSize;
attribute float aAlpha;
uniform float uReveal, uFill, uOpacity, uPx, uSize, uHotBoost;
uniform vec3 uColor, uHot;
varying vec3 vColor;
varying float vAlpha;
void main(){
  float vis = smoothstep(aSeed * 0.85, aSeed * 0.85 + 0.15, uReveal);
  float hot = 1.0 - smoothstep(uFill - 0.06, uFill, aOrder);
  vColor = mix(uColor, uHot, hot);
  vAlpha = uOpacity * vis * aAlpha * mix(1.0, uHotBoost, hot);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.5, aSize * uSize * uPx * mix(1.0, 1.4, hot));
}`;

const FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main(){
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.08, d));
}`;

function dotMaterial(color, { hot = PINK, size = 0.075, hotBoost = 1.5 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(...color) },
      uHot: { value: new THREE.Vector3(...hot) },
      uReveal: { value: 0 },
      uFill: { value: 0 },
      uOpacity: { value: 1 },
      uPx: { value: 60 },
      uSize: { value: size },
      uHotBoost: { value: hotBoost },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

class Cloud {
  constructor() { this.pos = []; this.seed = []; this.order = []; this.size = []; this.alpha = []; }
  pt(x, y, z, o = {}) {
    this.pos.push(x, y, z);
    this.seed.push(o.seed ?? Math.random());
    this.order.push(o.order ?? 2);
    this.size.push(o.size ?? 1);
    this.alpha.push(o.alpha ?? 1);
    return this;
  }
  line(a, b, step, o = {}, seedFn) {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
      this.pt(x, y, z, { ...o, seed: seedFn ? seedFn(x, y, z) : o.seed, order: typeof o.order === "function" ? o.order() : o.order });
    }
    return this;
  }
  box(lo, hi, step, o, seedFn) {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
    for (const [y, z] of [[y0, z0], [y0, z1], [y1, z0], [y1, z1]]) this.line([x0, y, z], [x1, y, z], step, o, seedFn);
    for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]) this.line([x, y0, z], [x, y1, z], step, o, seedFn);
    for (const [x, y] of [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]) this.line([x, y, z0], [x, y, z1], step, o, seedFn);
    return this;
  }
  points(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(this.seed, 1));
    g.setAttribute("aOrder", new THREE.Float32BufferAttribute(this.order, 1));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(this.size, 1));
    g.setAttribute("aAlpha", new THREE.Float32BufferAttribute(this.alpha, 1));
    const p = new THREE.Points(g, material);
    p.frustumCulled = false;
    return p;
  }
}

// ── the usual way: six racks ──────────────────────────────────
const RACK = { n: 6, w: 1.05, h: 3.0, d: 1.3, pitch: 1.2 };

function buildRacks() {
  const c = new Cloud();
  const { n, w, h, d, pitch } = RACK;
  const seed = (x, y) => Math.min(1, (y / h) * 0.7 + Math.random() * 0.3);
  for (let r = 0; r < n; r++) {
    const x0 = (r - (n - 1) / 2) * pitch - w / 2, x1 = x0 + w, z0 = -d / 2, z1 = d / 2;
    c.box([x0, 0, z0], [x1, h, z1], 0.1, { alpha: 0.8 }, seed);
    for (let k = 1; k < 12; k++) {
      const y = k * 0.25;
      c.line([x0 + 0.12, y, z1], [x1 - 0.12, y, z1], 0.09, { alpha: 0.36, size: 0.85 }, seed);
      if (r === n - 1) c.line([x1, y, z0 + 0.12], [x1, y, z1 - 0.12], 0.09, { alpha: 0.3, size: 0.85 }, seed);
    }
  }
  return c;
}

// ── your server: memory, processor, one graphics card ─────────
const RAM = { n: 8, x0: -2.1, pitch: 0.22, y0: 0.1, y1: 0.9, z: 1.0 };
const GPU = { x0: 1.75, x1: 2.15, y0: 0.1, y1: 1.15, z: 1.35 };

function buildServer() {
  const struct = new Cloud(), ram = new Cloud(), cpu = new Cloud(), gpu = new Cloud();
  const X = 2.6, Z = 1.6, H = 1.25;
  const seed = (x, y) => Math.min(1, y / H * 0.5 + Math.random() * 0.5);

  struct.box([-X, 0, -Z], [X, H, Z], 0.1, { alpha: 0.85 }, seed);
  for (let i = 1; i < 26; i++) for (let j = 1; j < 16; j++) {
    struct.pt(-X + i * 0.2, 0, -Z + j * 0.2, { alpha: 0.2, size: 0.7, seed: Math.random() * 0.5 });
  }

  for (let i = 0; i < RAM.n; i++) {
    const x = RAM.x0 + i * RAM.pitch;
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 20; b++) {
      const edge = a === 0 || a === 8 || b === 0 || b === 20;
      ram.pt(x, RAM.y0 + a * 0.1, -RAM.z + b * 0.1, {
        order: (a / 8) * 0.7 + (i / (RAM.n - 1)) * 0.3, // fills bottom-up, stick after stick
        alpha: edge ? 0.9 : 0.42,
        size: edge ? 1 : 0.8,
        seed: 0.15 + (a / 8) * 0.45 + Math.random() * 0.4,
      });
    }
  }

  const cx = 0.55;
  for (let a = -5; a <= 5; a++) for (let b = -5; b <= 5; b++) {
    const edge = Math.abs(a) === 5 || Math.abs(b) === 5;
    const core = Math.abs(a) <= 2 && Math.abs(b) <= 2;
    cpu.pt(cx + a * 0.11, 0.12, b * 0.11, { order: core ? 0 : 2, alpha: edge || core ? 0.9 : 0.3, size: core ? 1 : 0.85 });
    if (core) cpu.pt(cx + a * 0.11, 0.24, b * 0.11, { order: 0, alpha: 0.7 });
  }

  gpu.box([GPU.x0, GPU.y0, -GPU.z], [GPU.x1, GPU.y1, GPU.z], 0.09, { alpha: 0.9, order: () => Math.random() }, seed);
  for (let k = 1; k < 5; k++) {
    gpu.line([GPU.x0, GPU.y0 + k * 0.21, -GPU.z], [GPU.x0, GPU.y0 + k * 0.21, GPU.z], 0.12, { alpha: 0.25, size: 0.8, order: () => Math.random() }, seed);
  }
  return { struct, ram, cpu, gpu };
}

function buildFan() {
  const c = new Cloud(); // lies in the y–z plane, spins around x
  const ring = (r, n, o) => { for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; c.pt(0, Math.cos(t) * r, Math.sin(t) * r, o); } };
  ring(0.42, 34, { order: 0, alpha: 0.95, seed: 0.6 });
  ring(0.15, 12, { order: 0, alpha: 0.9, seed: 0.6 });
  for (let b = 0; b < 7; b++) for (let k = 0; k < 5; k++) {
    const r = 0.2 + k * 0.045, t = (b / 7) * Math.PI * 2 + k * 0.16;
    c.pt(0, Math.cos(t) * r, Math.sin(t) * r, { order: 0, alpha: 0.6, size: 0.85, seed: 0.7 });
  }
  return c;
}

const ss = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };

export function initScene(root) {
  const view = root.querySelector(".panel__view");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (err) {
    console.warn("locus scene: WebGL unavailable.", err);
    root.querySelectorAll(".tag, .pill").forEach((el) => { el.style.opacity = 1; });
    return;
  }
  renderer.setClearColor(0x000000, 0);
  view.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

  // materials
  const M = {
    racks: dotMaterial(IVORY, { size: 0.07 }),
    struct: dotMaterial(GREEN),
    ram: dotMaterial(GREEN, { hot: PINK, hotBoost: 1.7 }),
    cpu: dotMaterial(GREEN, { hot: BLUSH, hotBoost: 1.5 }),
    gpu: dotMaterial(GREEN, { hot: PINK, hotBoost: 1.6 }),
    fan: dotMaterial(GREEN, { hot: BLUSH, hotBoost: 1.5, size: 0.08 }),
    pulse: dotMaterial(BLUSH, { size: 0.12 }),
    live: dotMaterial(BLUSH, { size: 0.13 }),
  };
  M.pulse.uniforms.uReveal.value = 1;
  M.live.uniforms.uReveal.value = 1;
  const dotMats = Object.values(M);

  // objects
  const racksG = new THREE.Group();
  racksG.add(buildRacks().points(M.racks));
  const serverG = new THREE.Group();
  const s = buildServer();
  serverG.add(s.struct.points(M.struct), s.ram.points(M.ram), s.cpu.points(M.cpu), s.gpu.points(M.gpu));
  const fans = [-0.66, 0.66].map((z) => {
    const f = buildFan().points(M.fan);
    f.position.set(GPU.x1 + 0.01, 0.62, z);
    serverG.add(f);
    return f;
  });
  scene.add(racksG, serverG);

  // streams from racks to server (rebuilt when the layout changes)
  const lineMat = new THREE.LineBasicMaterial({ color: 0xe9a0b6, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
  let lines = null, curves = [], pulses = null, pulseMeta = [];
  const TRAIL = 6, PER = 2, STREAMS = 38;

  function buildStreams() {
    if (lines) { scene.remove(lines); lines.geometry.dispose(); }
    if (pulses) { scene.remove(pulses); pulses.geometry.dispose(); }
    racksG.updateMatrixWorld(true);
    serverG.updateMatrixWorld(true);
    curves = [];
    const seg = [];
    for (let i = 0; i < STREAMS; i++) {
      const r = Math.floor(Math.random() * RACK.n);
      const a = new THREE.Vector3((r - (RACK.n - 1) / 2) * RACK.pitch + (Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 2.3, RACK.d / 2).applyMatrix4(racksG.matrixWorld);
      const toCard = Math.random() < 0.25;
      const bl = toCard
        ? new THREE.Vector3(GPU.x0, 0.3 + Math.random() * 0.7, (Math.random() - 0.5) * 2.2)
        : new THREE.Vector3(RAM.x0 + Math.floor(Math.random() * RAM.n) * RAM.pitch, RAM.y1, (Math.random() - 0.5) * 1.8);
      const b = bl.applyMatrix4(serverG.matrixWorld);
      const lift = 1.0 + Math.random() * 2.2;
      const c1 = a.clone().lerp(b, 0.3).add(new THREE.Vector3(0, lift, 0));
      const c2 = a.clone().lerp(b, 0.78).add(new THREE.Vector3(0, lift * 1.15 + 0.8, 0));
      const curve = new THREE.CubicBezierCurve3(a, c1, c2, b);
      curves.push(curve);
      const pts = curve.getPoints(44);
      for (let k = 0; k < pts.length - 1; k++) seg.push(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    lines = new THREE.LineSegments(lg, lineMat);
    lines.frustumCulled = false;
    scene.add(lines);

    const c = new Cloud();
    pulseMeta = [];
    for (let i = 0; i < STREAMS; i++) for (let j = 0; j < PER; j++) {
      pulseMeta.push({ i, phase: Math.random(), speed: 0.13 + Math.random() * 0.1 });
      for (let k = 0; k < TRAIL; k++) c.pt(0, 0, 0, { seed: 0, size: 1 - k * 0.14, alpha: 1 - k * 0.16 });
    }
    pulses = c.points(M.pulse);
    scene.add(pulses);
  }

  // the "live" loop inside the server: memory → processor → card
  const livePath = [[-1.33, 0.14, 0], [0.55, 0.14, 0], [1.95, 0.14, 0]].map((v) => new THREE.Vector3(...v));
  const liveCloud = new Cloud();
  const LIVE = 3, LTRAIL = 7;
  for (let i = 0; i < LIVE * LTRAIL; i++) liveCloud.pt(0, 0, 0, { seed: 0, size: 1 - (i % LTRAIL) * 0.12, alpha: 1 - (i % LTRAIL) * 0.13 });
  const livePts = liveCloud.points(M.live);
  serverG.add(livePts);

  // labels
  const chips = [...root.querySelectorAll(".chip")].map((el) => ({
    el,
    at: { ram: new THREE.Vector3(-1.33, 1.9, 0), cpu: new THREE.Vector3(0.55, 1.0, 0), gpu: new THREE.Vector3(1.95, 2.35, 0) }[el.dataset.anchor],
  }));
  const tagRacks = root.querySelector('[data-tag="racks"]');
  const tagServer = root.querySelector('[data-tag="server"]');
  const pill = root.querySelector("[data-live]");
  const steps = [...root.querySelectorAll("[data-step]")];

  // layout + camera
  const target = new THREE.Vector3();
  let mobile = null, W = 1, H = 1, viewH = 12;
  const place = (g, sx, sy) => { // screen-space offsets → ground position for the fixed camera angle
    const d = -sy / 0.3536, e = sx / 0.7071;
    g.position.set((e + d) / 2, 0, (d - e) / 2);
  };
  function layout() {
    if (mobile) {
      place(racksG, -0.1, 2.05); racksG.scale.setScalar(0.92);
      place(serverG, 0.1, -3.45); serverG.scale.setScalar(1.12);
      target.set(0, 0, 0);
    } else {
      place(racksG, -5.4, 0.2); racksG.scale.setScalar(0.95);
      place(serverG, 4.3, -1.5); serverG.scale.setScalar(1.5);
      target.set(0, 0.55, 0);
    }
    buildStreams();
  }
  function resize() {
    const r = view.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    const aspect = W / H;
    const m = aspect < 1.05;
    if (m !== mobile) { mobile = m; layout(); }
    const needW = mobile ? 9.4 : 19.4, needH = mobile ? 12 : 10.4;
    viewH = Math.max(needH, needW / aspect);
    camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.right = (viewH * aspect) / 2; camera.left = -camera.right;
    camera.updateProjectionMatrix();
    for (const mat of dotMats) mat.uniforms.uPx.value = (H * dpr) / viewH;
    if (reduce) draw(15);
  }

  // gentle parallax
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  view.addEventListener("pointermove", (e) => {
    const r = view.getBoundingClientRect();
    look.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    look.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  });
  view.addEventListener("pointerleave", () => { look.tx = 0; look.ty = 0; });

  const v = new THREE.Vector3();
  function draw(t, dt = 0) {
    // timeline
    const fade = 1 - ss(LOOP - 1.6, LOOP - 0.4, t);
    const racksIn = ss(0.2, 2.4, t);
    const serverIn = ss(1.8, 3.8, t);
    const flow = ss(3.8, 4.8, t) * (1 - ss(10.4, 12, t));
    const fill = ss(4.6, 10.4, t);
    const card = ss(6, 8, t);
    const racksDim = 1 - 0.84 * ss(9.6, 12, t);
    const live = ss(11, 12.2, t);
    const step = t < 3.8 ? 1 : t < 10.4 ? 2 : 3;

    M.racks.uniforms.uReveal.value = racksIn;
    M.racks.uniforms.uOpacity.value = racksDim * fade;
    for (const k of ["struct", "ram", "cpu", "gpu", "fan"]) {
      M[k].uniforms.uReveal.value = serverIn;
      M[k].uniforms.uOpacity.value = fade;
    }
    M.ram.uniforms.uFill.value = fill * 1.06;
    M.cpu.uniforms.uFill.value = ss(5.2, 6.2, t) * 0.07;
    M.cpu.uniforms.uHotBoost.value = 1.3 + 0.35 * Math.sin(t * 5);
    M.gpu.uniforms.uFill.value = card * 0.42;
    M.fan.uniforms.uFill.value = card * 0.07;
    lineMat.opacity = flow * 0.2 * fade;
    M.pulse.uniforms.uOpacity.value = flow * fade;
    M.live.uniforms.uOpacity.value = live * fade;
    for (const f of fans) f.rotation.x += dt * 3.2 * card;

    // camera
    look.x += (look.tx - look.x) * Math.min(1, dt * 3);
    look.y += (look.ty - look.y) * Math.min(1, dt * 3);
    const az = Math.PI / 4 + look.x * 0.09, el = 0.5236 - look.y * 0.045;
    camera.position.set(target.x + 60 * Math.cos(el) * Math.sin(az), target.y + 60 * Math.sin(el), target.z + 60 * Math.cos(el) * Math.cos(az));
    camera.lookAt(target);
    camera.updateMatrixWorld();

    // stream pulses
    if (pulses) {
      const pos = pulses.geometry.attributes.position;
      let n = 0;
      for (const m of pulseMeta) {
        for (let k = 0; k < TRAIL; k++) {
          const u = (((m.phase + t * m.speed - k * 0.011) % 1) + 1) % 1;
          curves[m.i].getPoint(u, v);
          pos.setXYZ(n++, v.x, v.y, v.z);
        }
      }
      pos.needsUpdate = true;
    }
    // live loop
    {
      const pos = livePts.geometry.attributes.position;
      for (let i = 0; i < LIVE; i++) for (let k = 0; k < LTRAIL; k++) {
        const u = ((((i / LIVE + t * 0.28 - k * 0.012) % 1) + 1) % 1) * 2;
        const a = livePath[Math.min(1, Math.floor(u))], b = livePath[Math.min(2, Math.floor(u) + 1)];
        v.lerpVectors(a, b, u % 1);
        pos.setXYZ(i * LTRAIL + k, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;
    }

    renderer.render(scene, camera);

    // labels
    for (const c of chips) {
      v.copy(c.at).applyMatrix4(serverG.matrixWorld).project(camera);
      c.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%)`;
      c.el.style.opacity = (serverIn * fade).toFixed(2);
    }
    tagRacks.style.opacity = (racksIn * fade).toFixed(2);
    tagRacks.classList.toggle("is-off", racksDim < 0.5);
    tagServer.style.opacity = (serverIn * fade).toFixed(2);
    pill.style.opacity = (live * fade).toFixed(2);
    for (const el of steps) el.classList.toggle("is-active", Number(el.dataset.step) === step);
  }

  new ResizeObserver(resize).observe(view);
  resize();

  let t = 0, last = 0, running = false, freeze = null;
  function frame(now) {
    if (!running) return;
    if (freeze !== null) { draw(freeze, 0); return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t = (t + dt) % LOOP;
    draw(t, dt);
    requestAnimationFrame(frame);
  }
  if (reduce) {
    draw(15); // settled state, no motion
  } else {
    new IntersectionObserver(([e]) => {
      const was = running;
      running = e.isIntersecting;
      if (running && !was) { last = performance.now(); requestAnimationFrame(frame); }
    }, { threshold: 0.15 }).observe(view);
  }

  // handy for checking a moment of the loop from the console or automated tests
  window.__locusScene = { at: (sec) => { running = false; t = sec; draw(sec, 0); } };
  const frozen = new URLSearchParams(location.search).get("t"); // e.g. ?t=15 freezes the loop at 15 s
  if (frozen !== null) {
    freeze = Number(frozen);
    const hero = document.querySelector(".hero"); if (hero) hero.style.display = "none"; // still-capture mode: scene only
    draw(freeze, 0);
  }
}
