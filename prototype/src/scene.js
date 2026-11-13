// "How it works" scene.
// Left: a glass-cased row of racks full of graphics cards (the usual way).
// Right: one ordinary server board with its memory, its processor and one graphics card.
// The loop shows (1) the usual way, (2) the model moving over, and (3) how every word
// is then worked out: the card reads the request and picks specialists, the processor
// runs those specialists straight from memory, the card puts the word together.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const HEX = { bg: 0x080b0a, forest: 0x102f29, green: 0x275747, pink: 0xe9a0b6, blush: 0xf3c8d4, ivory: 0xf7f3ed };
const WORDS = ["Every", "word", "is", "worked", "out", "right", "here."];

// timeline, seconds
const T_MOVE = 3.2, T_OFF = 7.4, T_WORDS = 9.8, CYCLE = 2.1;
const T_DONE = T_WORDS + CYCLE * WORDS.length;
const LOOP = T_DONE + 2.6;

const ss = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const bump = (a, b, u) => (u <= a || u >= b ? 0 : Math.sin(((u - a) / (b - a)) * Math.PI));
const rand = (seed) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// ── small canvas textures for surface detail ──────────────────
function canvasTex(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function rackFrontTextures() {
  const units = 9;
  const paint = (lights) => (g, w, h) => {
    const uh = h / units;
    g.fillStyle = lights ? "#000" : "#0c1211";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < units; i++) {
      const y = i * uh;
      if (!lights) {
        g.fillStyle = "#1b2724"; g.fillRect(10, y + 5, w - 20, uh - 10);
        g.fillStyle = "#0a0f0e";
        for (let r = 0; r < 4; r++) for (let k = 0; k < 20; k++) { g.beginPath(); g.arc(46 + k * 8, y + 20 + r * 10, 2.3, 0, 6.3); g.fill(); }
        g.fillStyle = "#2b3b36"; g.fillRect(15, y + 11, 9, uh - 22); g.fillRect(w - 24, y + 11, 9, uh - 22);
        g.fillStyle = "#26342f"; g.fillRect(46, y + uh - 22, 60, 6);
      }
      g.fillStyle = lights ? "#f7f3ed" : "#3a4d47"; g.fillRect(w - 62, y + uh - 22, 7, 5);
      g.fillStyle = lights ? "#5fbf9f" : "#2f4a41"; g.fillRect(w - 48, y + uh - 22, 7, 5);
    }
  };
  return [canvasTex(256, 768, paint(false)), canvasTex(256, 768, paint(true))];
}

function boardTexture() {
  return canvasTex(1024, 720, (g, w, h) => {
    g.fillStyle = "#103a30"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#1a5545"; g.lineWidth = 2;
    for (let i = 0; i < 90; i++) { // right-angled copper tracks
      let x = rand(i) * w, y = rand(i + 99) * h;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 3; k++) {
        if ((i + k) % 2) x += (rand(i * 7 + k) - 0.5) * 260; else y += (rand(i * 13 + k) - 0.5) * 200;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = "#23705b";
    for (let i = 0; i < 160; i++) g.fillRect(rand(i + 500) * w, rand(i + 900) * h, 4, 4);
  });
}

export function initScene(root) {
  const view = root.querySelector(".panel__view");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    console.warn("locus scene: WebGL unavailable.", err);
    root.querySelectorAll(".tag").forEach((el) => { el.style.opacity = 1; });
    return;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  view.prepend(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(HEX.bg);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);

  scene.add(new THREE.HemisphereLight(0xcfe6dc, 0x050706, 0.55));
  const key = new THREE.DirectionalLight(0xfff3e6, 2.6);
  key.position.set(-9, 22, 15);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
  key.shadow.bias = -0.0004;
  key.shadow.radius = 5;
  scene.add(key);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.65, 0.95));
  composer.addPass(new OutputPass());

  // ── materials ──
  const std = (color, metalness, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
  const glow = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
  const [rackMap, rackLights] = rackFrontTextures();
  const M = {
    plinth: std(0x0d2621, 0.25, 0.55),
    plinthTop: std(0x15382f, 0.3, 0.45),
    rackFrame: std(0x141d1b, 0.75, 0.4),
    rackFront: std(0xffffff, 0.45, 0.55, { map: rackMap, emissiveMap: rackLights, emissive: 0xffffff, emissiveIntensity: 2 }),
    rackSide: std(0x19231f, 0.7, 0.45),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xcfe9dd, transparent: true, opacity: 0.03, roughness: 0.04, metalness: 0, envMapIntensity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    glassEdge: new THREE.LineBasicMaterial({ color: HEX.ivory, transparent: true, opacity: 0.3 }),
    board: std(0xffffff, 0.2, 0.5, { map: boardTexture() }),
    dark: std(0x090d0c, 0.3, 0.6),
    dimm: std(0x1b2a26, 0.8, 0.36),
    clip: std(0x8f9a94, 0.1, 0.55),
    steel: std(0xd9d4cb, 0.95, 0.25),
    lid: std(0xcfcac1, 0.95, 0.3, { emissive: HEX.pink, emissiveIntensity: 0 }),
    shroud: std(0x131c1a, 0.75, 0.36),
    bezel: std(0x222e2b, 0.8, 0.35),
    blade: std(0x1d2926, 0.6, 0.4),
    trace: glow(), strip: glow(), ring: glow(), hub: glow(), cell: glow(), pulse: glow(), mark: glow(), markPink: glow(),
  };
  const rackBase = { frame: M.rackFrame.color.clone(), side: M.rackSide.color.clone() };

  const COL = {
    off: new THREE.Color(0x0b1513),
    held: new THREE.Color(0x2f7a61).multiplyScalar(1.15),    // memory that holds a specialist
    traceIdle: new THREE.Color(HEX.green).multiplyScalar(0.9),
    hot: new THREE.Color(HEX.pink).multiplyScalar(2.0),       // anything doing work right now
  };
  M.trace.color.copy(COL.traceIdle);
  M.mark.color.set(HEX.green).multiplyScalar(0.8);
  M.markPink.color.set(HEX.pink).multiplyScalar(0.55);
  M.pulse.color.copy(COL.hot);

  const shade = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const rbox = (w, h, d, mat, r = 0.04) => shade(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, Math.min(w, h, d) / 2 - 0.001)), mat));
  const box = (w, h, d, mat) => shade(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
  const flat = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); // unlit, no shadow
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

  // floor: catches shadows only, so the page colour shows through
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({ opacity: 0.5 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // ── the usual way: racks of graphics cards in a glass case ──
  const RACK = { n: 5, w: 1.2, h: 3.7, d: 1.6, pitch: 1.3, y0: 0.28 };
  const racksG = new THREE.Group();
  {
    const { n, w, h, d, pitch, y0 } = RACK;
    const L = (n - 1) * pitch + w;
    racksG.add(at(rbox(L + 1.4, 0.2, d + 1.6, M.plinth, 0.05), 0, 0.1, 0));
    racksG.add(at(rbox(L + 1.0, 0.08, d + 1.2, M.plinthTop, 0.03), 0, 0.24, 0));
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * pitch;
      racksG.add(at(rbox(w, h, d, M.rackFrame, 0.03), x, y0 + h / 2, 0));
      racksG.add(at(new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, h - 0.16), M.rackFront), x, y0 + h / 2, d / 2 + 0.004));
      const side = new THREE.Mesh(new THREE.PlaneGeometry(d - 0.24, h - 0.3), M.rackSide);
      side.rotation.y = Math.PI / 2;
      racksG.add(at(side, x + w / 2 + 0.004, y0 + h / 2, 0));
      racksG.add(at(box(w - 0.3, 0.02, d - 0.4, M.rackSide), x, y0 + h + 0.01, 0));
    }
    const caseGeo = new THREE.BoxGeometry(L + 0.5, h + 0.3, d + 0.55);
    racksG.add(at(new THREE.Mesh(caseGeo, M.glass), 0, y0 + (h + 0.3) / 2, 0));
    racksG.add(at(new THREE.LineSegments(new THREE.EdgesGeometry(caseGeo), M.glassEdge), 0, y0 + (h + 0.3) / 2, 0));
    // floor markings, as in a studio product shot
    racksG.add(at(flat(L + 3.4, 0.004, 0.03, M.mark), 0, 0.004, d / 2 + 1.5));
    racksG.add(at(flat(1.3, 0.004, 0.16, M.markPink), -L / 2 + 0.2, 0.004, d / 2 + 1.9));
    racksG.add(at(flat(0.45, 0.004, 0.16, M.markPink), -L / 2 + 1.3, 0.004, d / 2 + 1.9));
  }
  scene.add(racksG);

  // ── your server: one board with memory, processor and one graphics card ──
  const Y0 = 0.28; // top of the board
  const BANK = { n: 12, x0: -3.7, pitch: 0.24, z: 0, len: 3.6, segs: 10 };
  const CPU = { x: 0.8, z: 0 };
  const CARD = { x: 3.15, z: 0, len: 4.2, depth: 1.55, top: Y0 + 0.58 };
  const LANE = { ram: [-0.98, -0.05], card: [1.65, 2.37] }; // x-range of the copper paths
  const serverG = new THREE.Group();
  const fans = [];
  let cells;
  {
    const BX = 4.15, BZ = 2.35;
    serverG.add(at(rbox(2 * BX + 1.3, 0.2, 2 * BZ + 1.3, M.plinth, 0.05), 0, 0.1, 0));
    serverG.add(at(rbox(2 * BX, 0.08, 2 * BZ, M.board, 0.03), 0, 0.24, 0));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const screw = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 20), M.steel));
      serverG.add(at(screw, sx * (BX - 0.22), Y0 + 0.02, sz * (BZ - 0.22)));
    }

    // memory: twelve sticks, each with a light bar of eight cells on top
    cells = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.07, BANK.len / BANK.segs - 0.05), M.cell, BANK.n * BANK.segs);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < BANK.n; i++) {
      const x = BANK.x0 + i * BANK.pitch;
      serverG.add(at(box(0.15, 0.1, BANK.len + 0.16, M.dark), x, Y0 + 0.05, BANK.z));
      serverG.add(at(box(0.17, 0.2, 0.09, M.clip), x, Y0 + 0.1, BANK.z - BANK.len / 2 - 0.1));
      serverG.add(at(box(0.17, 0.2, 0.09, M.clip), x, Y0 + 0.1, BANK.z + BANK.len / 2 + 0.1));
      serverG.add(at(rbox(0.08, 0.7, BANK.len, M.dimm, 0.02), x, Y0 + 0.45, BANK.z));
      serverG.add(at(box(0.11, 0.05, BANK.len, M.dark), x, Y0 + 0.82, BANK.z));
      for (let k = 0; k < BANK.segs; k++) {
        dummy.position.set(x, Y0 + 0.87, BANK.z - BANK.len / 2 + (k + 0.5) * (BANK.len / BANK.segs));
        dummy.updateMatrix();
        cells.setMatrixAt(i * BANK.segs + k, dummy.matrix);
        cells.setColorAt(i * BANK.segs + k, COL.off);
      }
    }
    serverG.add(cells);

    // processor
    serverG.add(at(rbox(1.7, 0.07, 1.7, M.dark, 0.03), CPU.x, Y0 + 0.035, CPU.z));
    serverG.add(at(rbox(1.5, 0.06, 1.5, M.dimm, 0.03), CPU.x, Y0 + 0.09, CPU.z));
    serverG.add(at(rbox(1.18, 0.11, 1.18, M.lid, 0.05), CPU.x, Y0 + 0.165, CPU.z));
    for (const [w, d, dx, dz] of [[1.86, 0.035, 0, -0.93], [1.86, 0.035, 0, 0.93], [0.035, 1.86, -0.93, 0], [0.035, 1.86, 0.93, 0]]) {
      serverG.add(at(flat(w, 0.02, d, M.ring), CPU.x + dx, Y0 + 0.012, CPU.z + dz));
    }

    // one graphics card, lying fans-up
    serverG.add(at(box(CARD.depth - 0.3, 0.12, CARD.len - 0.3, M.dark), CARD.x, Y0 + 0.06, CARD.z));
    serverG.add(at(rbox(CARD.depth, 0.42, CARD.len, M.shroud, 0.09), CARD.x, Y0 + 0.37, CARD.z));
    serverG.add(at(box(CARD.depth - 0.16, 0.02, 0.3, M.steel), CARD.x, CARD.top + 0.004, CARD.z));
    serverG.add(at(box(CARD.depth - 0.05, 0.72, 0.05, M.steel), CARD.x, Y0 + 0.36, CARD.z - CARD.len / 2 - 0.03));
    serverG.add(at(flat(0.03, 0.04, CARD.len - 0.6, M.strip), CARD.x + CARD.depth / 2 + 0.006, CARD.top - 0.1, CARD.z));
    serverG.add(at(flat(0.035, 0.02, CARD.len - 0.6, M.strip), CARD.x - CARD.depth / 2 + 0.14, CARD.top + 0.008, CARD.z));
    for (const fz of [-1.08, 1.08]) {
      const well = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.02, 48), M.dark);
      well.receiveShadow = true;
      serverG.add(at(well, CARD.x, CARD.top + 0.006, CARD.z + fz));
      const bezel = shade(new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 10, 56), M.bezel));
      bezel.rotation.x = Math.PI / 2;
      serverG.add(at(bezel, CARD.x, CARD.top + 0.02, CARD.z + fz));
      const fan = new THREE.Group();
      for (let b = 0; b < 9; b++) {
        const a = (b / 9) * Math.PI * 2;
        const blade = shade(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.012, 0.17), M.blade));
        blade.position.set(Math.cos(a) * 0.34, 0, Math.sin(a) * 0.34);
        blade.rotation.set(0.32, -a + 0.5, 0, "YXZ");
        fan.add(blade);
      }
      fan.add(shade(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.07, 28), M.shroud)));
      const hub = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 8, 32), M.hub);
      hub.rotation.x = Math.PI / 2;
      hub.position.y = 0.04;
      fan.add(hub);
      serverG.add(at(fan, CARD.x, CARD.top + 0.05, CARD.z + fz));
      fans.push(fan);
    }

    // copper paths: memory → processor, processor ↔ card
    for (let i = 0; i < 8; i++) serverG.add(at(flat(LANE.ram[1] - LANE.ram[0], 0.012, 0.035, M.trace), (LANE.ram[0] + LANE.ram[1]) / 2, Y0 + 0.007, -0.77 + i * 0.22));
    for (let i = 0; i < 5; i++) serverG.add(at(flat(LANE.card[1] - LANE.card[0], 0.012, 0.035, M.trace), (LANE.card[0] + LANE.card[1]) / 2, Y0 + 0.007, -0.24 + i * 0.12));
    serverG.add(at(flat(2 * BX + 3.2, 0.004, 0.03, M.mark), 0, 0.004, BZ + 1.5));
    serverG.add(at(flat(1.5, 0.004, 0.16, M.markPink), BX - 0.9, 0.004, BZ + 1.9));
  }
  scene.add(serverG);

  // moving packets on the copper paths
  const PKT = 26;
  const packets = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 0.055), M.pulse, PKT);
  packets.frustumCulled = false;
  serverG.add(packets);
  const pk = new THREE.Object3D();

  // streams that carry the model over (rebuilt when the layout changes)
  const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(HEX.pink).multiplyScalar(1.5), transparent: true, opacity: 0, depthWrite: false });
  const STREAMS = 30, PER = 2;
  const beads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 10, 8), M.pulse, STREAMS * PER);
  beads.frustumCulled = false;
  scene.add(beads);
  let lines = null, curves = [], beadMeta = [];
  function buildStreams() {
    if (lines) { scene.remove(lines); lines.geometry.dispose(); }
    racksG.updateMatrixWorld(true);
    serverG.updateMatrixWorld(true);
    curves = []; beadMeta = [];
    const seg = [];
    for (let i = 0; i < STREAMS; i++) {
      const r = Math.floor(rand(i + 1) * RACK.n);
      const a = new THREE.Vector3((r - (RACK.n - 1) / 2) * RACK.pitch + (rand(i + 20) - 0.5) * 0.8, RACK.y0 + 0.5 + rand(i + 40) * 2.8, RACK.d / 2 + 0.02).applyMatrix4(racksG.matrixWorld);
      const toCard = i % 5 === 0; // most of the model goes to memory, a small part to the card
      const bl = toCard
        ? new THREE.Vector3(CARD.x + (rand(i + 60) - 0.5) * 1.0, CARD.top + 0.05, CARD.z + (rand(i + 80) - 0.5) * 3.4)
        : new THREE.Vector3(BANK.x0 + Math.floor(rand(i + 60) * BANK.n) * BANK.pitch, Y0 + 0.92, BANK.z + (rand(i + 80) - 0.5) * BANK.len * 0.9);
      const b = bl.applyMatrix4(serverG.matrixWorld);
      const lift = 1.2 + rand(i + 100) * 2.4;
      const curve = new THREE.CubicBezierCurve3(a,
        a.clone().lerp(b, 0.3).add(new THREE.Vector3(0, lift * 0.5, 0)),
        a.clone().lerp(b, 0.8).add(new THREE.Vector3(0, lift + 1.2, 0)), b);
      curves.push(curve);
      const pts = curve.getPoints(48);
      for (let k = 0; k < pts.length - 1; k++) seg.push(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z);
      for (let j = 0; j < PER; j++) beadMeta.push({ i, phase: rand(i * 3 + j + 7), speed: 0.16 + rand(i + j * 31) * 0.1 });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    lines = new THREE.LineSegments(g, lineMat);
    lines.frustumCulled = false;
    scene.add(lines);
  }

  // which memory cells each word uses (a few specialists out of many)
  const NCELL = BANK.n * BANK.segs;
  const picks = WORDS.map((_, w) => { const s = new Set(); let k = 0; while (s.size < 7) s.add(Math.floor(rand(w * 17 + k++ + 3) * NCELL)); return [...s]; });
  const loadAt = Array.from({ length: NCELL }, (_, j) => (Math.floor(j / BANK.segs) / BANK.n) * 0.72 + rand(j + 300) * 0.2);

  // labels
  const anchors = {
    ram: new THREE.Vector3(BANK.x0 + ((BANK.n - 1) * BANK.pitch) / 2, Y0 + 1.3, BANK.z - BANK.len / 2 - 0.3),
    cpu: new THREE.Vector3(CPU.x, Y0 + 0.85, CPU.z - 1.5),
    gpu: new THREE.Vector3(CARD.x, CARD.top + 0.75, CARD.z - CARD.len / 2 - 0.3),
  };
  const LIFT = { ram: 0, cpu: 0, gpu: 24 }; // extra leader length, px, so neighbouring labels never collide
  const chips = [...root.querySelectorAll(".chip")].map((el) => {
    const key = el.dataset.anchor;
    el.style.setProperty("--lead", `${14 + LIFT[key]}px`);
    return { el, key, at: anchors[key], lift: LIFT[key] };
  });
  const tagRacks = root.querySelector('[data-tag="racks"]');
  const tagServer = root.querySelector('[data-tag="server"]');
  const steps = [...root.querySelectorAll("[data-step]")];
  const narrate = root.querySelector("[data-narrate]");
  const answer = root.querySelector("[data-answer]");
  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

  // layout + camera
  const target = new THREE.Vector3();
  let mobile = null, W = 1, H = 1, viewH = 12;
  let t = 0, last = 0, running = false, freeze = null, spin = 0;
  const place = (g, sx, sy) => { const d = -sy / 0.3536, e = sx / 0.7071; g.position.set((e + d) / 2, 0, (d - e) / 2); };
  function layout() {
    if (mobile) {
      place(racksG, -0.1, 2.0); racksG.scale.setScalar(0.74);
      place(serverG, 0.1, -3.3); serverG.scale.setScalar(0.9);
      target.set(0, 0, 0);
    } else {
      place(racksG, -6.1, -0.2); racksG.scale.setScalar(0.8);
      place(serverG, 3.9, -0.9); serverG.scale.setScalar(1.05);
      target.set(0, 0.2, 0);
    }
    buildStreams();
  }
  function resize() {
    const r = view.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(dpr);
    composer.setSize(W, H);
    const aspect = W / H;
    const m = aspect < 1.05;
    if (m !== mobile) { mobile = m; layout(); }
    const needW = mobile ? 9.9 : 19.8, needH = mobile ? 12.6 : 10.6;
    viewH = Math.max(needH, needW / aspect);
    camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.right = (viewH * aspect) / 2; camera.left = -camera.right;
    camera.updateProjectionMatrix();
    if (reduce || freeze !== null) draw(freeze ?? T_WORDS + CYCLE * 2.55, 0);
  }

  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  view.addEventListener("pointermove", (e) => {
    const r = view.getBoundingClientRect();
    look.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    look.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  });
  view.addEventListener("pointerleave", () => { look.tx = 0; look.ty = 0; });

  const v = new THREE.Vector3();
  const col = new THREE.Color();

  function draw(time, dt = 0) {
    const fade = ss(0, 1, time) * (1 - ss(LOOP - 1.3, LOOP - 0.2, time));
    const power = 1 - ss(T_OFF, T_OFF + 1.8, time);                         // the racks, on → off
    const flow = ss(T_MOVE, T_MOVE + 0.8, time) * (1 - ss(8.2, 9.4, time)); // the model moving over
    const load = ss(T_MOVE + 0.6, 8.6, time);
    const decoding = time >= T_WORDS && time < T_DONE;
    const wi = decoding ? Math.floor((time - T_WORDS) / CYCLE) : -1;
    const u = decoding ? ((time - T_WORDS) / CYCLE) % 1 : 0;

    // one word: card reads + picks → processor runs the picked specialists from memory → card finishes
    const cardOn = decoding ? Math.max(bump(0, 0.3, u), bump(0.84, 1.0, u)) : 0;
    const pick = decoding ? bump(0.26, 0.74, u) : 0;
    const cpuOn = decoding ? bump(0.4, 0.86, u) : 0;

    // racks
    M.rackFront.emissiveIntensity = power * (3.0 + 0.5 * Math.sin(time * 7));
    M.rackFront.color.setScalar(0.45 + 0.55 * power);
    M.rackFrame.color.copy(rackBase.frame).multiplyScalar(0.5 + 0.5 * power);
    M.rackSide.color.copy(rackBase.side).multiplyScalar(0.5 + 0.5 * power);
    M.glass.opacity = 0.014 + 0.018 * power;
    M.glassEdge.opacity = 0.12 + 0.18 * power;

    // memory cells
    for (let j = 0; j < NCELL; j++) {
      col.copy(COL.off).lerp(COL.held, ss(loadAt[j], loadAt[j] + 0.08, load));
      cells.setColorAt(j, col);
    }
    if (wi >= 0) for (const j of picks[wi]) { col.copy(COL.held).lerp(COL.hot, pick); cells.setColorAt(j, col); }
    cells.instanceColor.needsUpdate = true;

    // processor + card
    const cardLoaded = ss(0.25, 0.7, load);
    M.lid.emissiveIntensity = cpuOn * 0.6;
    M.ring.color.copy(COL.off).lerp(COL.traceIdle, load).lerp(COL.hot, cpuOn);
    M.strip.color.copy(COL.off).lerp(COL.held, cardLoaded).lerp(COL.hot, cardOn);
    M.hub.color.copy(COL.off).lerp(COL.held, cardLoaded).lerp(COL.hot, cardOn);
    spin += dt * (1.5 * cardLoaded + 7 * cardOn);
    for (const f of fans) f.rotation.y = spin;

    // packets on the copper paths
    let n = 0;
    const put = (x, z, alongX, len) => {
      if (n >= PKT) return;
      pk.position.set(x, Y0 + 0.02, z);
      pk.rotation.set(0, alongX ? 0 : Math.PI / 2, 0);
      pk.scale.set(len, 1, 1);
      pk.updateMatrix();
      packets.setMatrixAt(n++, pk.matrix);
    };
    if (decoding) {
      const ask = (u - 0.2) / 0.2, back = (u - 0.74) / 0.16, fetch = (u - 0.34) / 0.3;
      const [c0, c1] = LANE.card, [r0, r1] = LANE.ram;
      for (let i = 0; i < 5; i++) {
        const z = -0.24 + i * 0.12;
        if (ask > 0 && ask < 1) put(c1 - 0.08 - ask * (c1 - c0 - 0.16), z, true, 0.16);    // card → processor: which specialists
        if (back > 0 && back < 1) put(c0 + 0.08 + back * (c1 - c0 - 0.16), z, true, 0.16); // processor → card: the result
      }
      for (let i = 0; i < 8; i++) for (let k = 0; k < 2; k++) {
        const q = fetch * 1.5 - k * 0.5 - (i % 3) * 0.08;
        if (q > 0 && q < 1) put(r0 + 0.1 + q * (r1 - r0 - 0.2), -0.77 + i * 0.22, true, 0.2); // memory → processor
      }
    }
    while (n < PKT) { pk.scale.setScalar(0); pk.updateMatrix(); packets.setMatrixAt(n++, pk.matrix); }
    packets.instanceMatrix.needsUpdate = true;

    // streams
    lineMat.opacity = flow * 0.34;
    for (let k = 0; k < beadMeta.length; k++) {
      const m = beadMeta[k];
      curves[m.i].getPoint((((m.phase + time * m.speed) % 1) + 1) % 1, v);
      pk.position.copy(v); pk.rotation.set(0, 0, 0); pk.scale.setScalar(flow > 0.02 ? 1 : 0); pk.updateMatrix();
      beads.setMatrixAt(k, pk.matrix);
    }
    beads.instanceMatrix.needsUpdate = true;

    // camera
    look.x += (look.tx - look.x) * Math.min(1, dt * 3);
    look.y += (look.ty - look.y) * Math.min(1, dt * 3);
    const az = Math.PI / 4 + look.x * 0.08, el = 0.5236 - look.y * 0.04;
    camera.position.set(target.x + 80 * Math.cos(el) * Math.sin(az), target.y + 80 * Math.sin(el), target.z + 80 * Math.cos(el) * Math.cos(az));
    camera.lookAt(target);
    camera.updateMatrixWorld();

    composer.render();
    canvas.style.opacity = fade.toFixed(3);

    // labels and read-out
    const lit = { ram: pick > 0.35 || (flow > 0.3 && load < 0.98), cpu: cpuOn > 0.35, gpu: cardOn > 0.35 };
    for (const ch of chips) {
      v.copy(ch.at).applyMatrix4(serverG.matrixWorld).project(camera);
      ch.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%) translateY(${-ch.lift}px)`;
      ch.el.style.opacity = fade.toFixed(2);
      ch.el.classList.toggle("is-on", lit[ch.key]);
    }
    tagRacks.style.opacity = fade.toFixed(2);
    tagRacks.classList.toggle("is-off", power < 0.5);
    tagServer.style.opacity = fade.toFixed(2);
    const step = time < T_MOVE ? 1 : time < T_WORDS ? 2 : 3;
    for (const el of steps) el.classList.toggle("is-active", Number(el.dataset.step) === step);

    let now;
    if (time < T_MOVE) now = "The usual way: the whole model sits on a room of graphics cards.";
    else if (time < T_WORDS) now = "locus moves it over: the specialists into your server's memory, a small part onto one card.";
    else if (!decoding) now = "Done. Nothing left the building.";
    else if (u < 0.3) now = "Graphics card: reads the request and picks the few specialists this word needs.";
    else if (u < 0.84) now = "Processor: runs those specialists straight from memory.";
    else now = "Graphics card: puts the result together. One more word.";
    setText(narrate, now);
    const shown = decoding ? wi + (u >= 0.9 ? 1 : 0) : time >= T_DONE ? WORDS.length : 0;
    setText(answer, WORDS.slice(0, shown).join(" "));
  }

  new ResizeObserver(resize).observe(view);
  resize();

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
    draw(T_WORDS + CYCLE * 2.55, 0); // one settled moment, no motion
  } else {
    new IntersectionObserver(([e]) => {
      const was = running;
      running = e.isIntersecting;
      if (running && !was) { last = performance.now(); requestAnimationFrame(frame); }
    }, { threshold: 0.15 }).observe(view);
  }

  // handy for checking a moment of the loop from the console or automated tests
  window.__locusScene = { at: (sec) => { running = false; t = sec; draw(sec, 0); }, loop: LOOP, words: T_WORDS, cycle: CYCLE };
  const frozen = new URLSearchParams(location.search).get("t"); // e.g. ?t=15 freezes the loop at 15 s
  if (frozen !== null) {
    freeze = Number(frozen);
    const hero = document.querySelector(".hero");
    if (hero) hero.style.display = "none"; // still-capture mode: scene only
    draw(freeze, 0);
  }
}
