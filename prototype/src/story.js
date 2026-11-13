// The "how it works" story, as things standing in the pond: the racks of graphics cards (the
// usual way), your server's board afloat, and the model drifting from one to the other as
// small lights that leave wakes. This module owns the objects and the timeline; the page's
// camera, renderer and water live in world.js.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { canvasTexture } from "./lotus.js";
import { mergeStatic } from "./merge.js";

const HEX = { green: 0x275747, pink: 0xe9a0b6, ivory: 0xf7f3ed };
const WORDS = ["Every", "word", "is", "worked", "out", "right", "here."];

// timeline, seconds: unhurried on purpose
const T_MOVE = 3.0, T_OFF = 11.6, T_WORDS = 15.2, CYCLE = 2.7;
const T_DONE = T_WORDS + CYCLE * WORDS.length;
export const LOOP = T_DONE + 3;

const ss = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const bump = (a, b, u) => (u <= a || u >= b ? 0 : Math.sin(((u - a) / (b - a)) * Math.PI));
const rand = (seed) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

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
      }
      g.fillStyle = lights ? "#f7f3ed" : "#3a4d47"; g.fillRect(w - 62, y + uh - 22, 7, 5);
      g.fillStyle = lights ? "#5fbf9f" : "#2f4a41"; g.fillRect(w - 48, y + uh - 22, 7, 5);
    }
  };
  return [canvasTexture(256, 768, paint(false)), canvasTexture(256, 768, paint(true))];
}

const boardTexture = () => canvasTexture(1024, 720, (g, w, h) => {
  g.fillStyle = "#103a30"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "#1a5545"; g.lineWidth = 2;
  for (let i = 0; i < 90; i++) {
    let x = rand(i) * w, y = rand(i + 99) * h;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 3; k++) { if ((i + k) % 2) x += (rand(i * 7 + k) - 0.5) * 260; else y += (rand(i * 13 + k) - 0.5) * 200; g.lineTo(x, y); }
    g.stroke();
  }
  g.fillStyle = "#23705b";
  for (let i = 0; i < 160; i++) g.fillRect(rand(i + 500) * w, rand(i + 900) * h, 4, 4);
});

export function createStory(scene, water, dom, { wake = 1 } = {}) {
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
    steel: std(0xb9b6ae, 0.9, 0.42),
    lid: std(0xb4b0a8, 0.9, 0.45, { emissive: HEX.pink, emissiveIntensity: 0 }),
    shroud: std(0x131c1a, 0.75, 0.36),
    bezel: std(0x222e2b, 0.8, 0.35),
    blade: std(0x1d2926, 0.6, 0.4),
    trace: glow(), strip: glow(), ring: glow(), hub: glow(), cell: glow(), pulse: glow(), mote: glow(),
  };
  const rackBase = { frame: M.rackFrame.color.clone(), side: M.rackSide.color.clone() };
  const COL = {
    off: new THREE.Color(0x0b1513),
    held: new THREE.Color(0x2f7a61).multiplyScalar(1.15),  // memory holding part of the model
    traceIdle: new THREE.Color(HEX.green).multiplyScalar(0.9),
    hot: new THREE.Color(HEX.pink).multiplyScalar(2.0),     // the model on the move, or a part at work
  };
  M.trace.color.copy(COL.traceIdle);
  M.pulse.color.copy(COL.hot);
  M.mote.color.copy(COL.hot);

  const shade = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const rbox = (w, h, d, mat, r = 0.04) => shade(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, Math.min(w, h, d) / 2 - 0.001)), mat));
  const box = (w, h, d, mat) => shade(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
  const flat = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

  // ── the usual way: racks of graphics cards in a glass case, standing in the water ──
  const RACK = { n: 5, w: 1.2, h: 3.7, d: 1.6, pitch: 1.3, y0: 0.28 };
  const RACK_L = (RACK.n - 1) * RACK.pitch + RACK.w;
  const racksG = new THREE.Group();
  {
    const { n, w, h, d, pitch, y0 } = RACK;
    racksG.add(at(rbox(RACK_L + 1.4, 0.2, d + 1.6, M.plinth, 0.05), 0, 0.1, 0));
    racksG.add(at(rbox(RACK_L + 1.0, 0.08, d + 1.2, M.plinthTop, 0.03), 0, 0.24, 0));
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * pitch;
      racksG.add(at(rbox(w, h, d, M.rackFrame, 0.03), x, y0 + h / 2, 0));
      racksG.add(at(new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, h - 0.16), M.rackFront), x, y0 + h / 2, d / 2 + 0.004));
      const side = new THREE.Mesh(new THREE.PlaneGeometry(d - 0.24, h - 0.3), M.rackSide);
      side.rotation.y = Math.PI / 2;
      racksG.add(at(side, x + w / 2 + 0.004, y0 + h / 2, 0));
      racksG.add(at(box(w - 0.3, 0.02, d - 0.4, M.rackSide), x, y0 + h + 0.01, 0));
    }
    const caseGeo = new THREE.BoxGeometry(RACK_L + 0.5, h + 0.3, d + 0.55);
    racksG.add(at(new THREE.Mesh(caseGeo, M.glass), 0, y0 + (h + 0.3) / 2, 0));
    racksG.add(at(new THREE.LineSegments(new THREE.EdgesGeometry(caseGeo), M.glassEdge), 0, y0 + (h + 0.3) / 2, 0));
  }
  mergeStatic(racksG); // nothing in the case moves: one mesh per material
  scene.add(racksG);

  // ── your server: one board with memory, processor and one graphics card, afloat ──
  const Y0 = 0.28, BX = 4.15, BZ = 2.35, AFLOAT = -0.06;
  const BANK = { n: 12, x0: -3.7, pitch: 0.24, z: 0, len: 3.6, segs: 10 };
  const CPU = { x: 0.8, z: 0 };
  const CARD = { x: 3.15, z: 0, len: 4.2, depth: 1.55, top: Y0 + 0.58 };
  const LANE = { ram: [-0.98, -0.05], card: [1.65, 2.37] };
  const NCELL = BANK.n * BANK.segs;
  const serverG = new THREE.Group();
  const fans = [], cellLocal = [];
  const dummy = new THREE.Object3D();
  serverG.add(at(rbox(2 * BX + 1.3, 0.2, 2 * BZ + 1.3, M.plinth, 0.05), 0, 0.1, 0));
  serverG.add(at(rbox(2 * BX, 0.08, 2 * BZ, M.board, 0.03), 0, 0.24, 0));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    serverG.add(at(shade(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 20), M.steel)), sx * (BX - 0.22), Y0 + 0.02, sz * (BZ - 0.22)));
  }
  const cells = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.07, BANK.len / BANK.segs - 0.05), M.cell, NCELL);
  for (let i = 0; i < BANK.n; i++) {
    const x = BANK.x0 + i * BANK.pitch;
    serverG.add(at(box(0.15, 0.1, BANK.len + 0.16, M.dark), x, Y0 + 0.05, BANK.z));
    serverG.add(at(box(0.17, 0.2, 0.09, M.clip), x, Y0 + 0.1, BANK.z - BANK.len / 2 - 0.1));
    serverG.add(at(box(0.17, 0.2, 0.09, M.clip), x, Y0 + 0.1, BANK.z + BANK.len / 2 + 0.1));
    serverG.add(at(rbox(0.08, 0.7, BANK.len, M.dimm, 0.02), x, Y0 + 0.45, BANK.z));
    serverG.add(at(box(0.11, 0.05, BANK.len, M.dark), x, Y0 + 0.82, BANK.z));
    for (let k = 0; k < BANK.segs; k++) {
      const p = V(x, Y0 + 0.87, BANK.z - BANK.len / 2 + (k + 0.5) * (BANK.len / BANK.segs));
      cellLocal.push(p);
      dummy.position.copy(p); dummy.updateMatrix();
      cells.setMatrixAt(i * BANK.segs + k, dummy.matrix);
      cells.setColorAt(i * BANK.segs + k, COL.off);
    }
  }
  serverG.add(cells);
  serverG.add(at(rbox(1.7, 0.07, 1.7, M.dark, 0.03), CPU.x, Y0 + 0.035, CPU.z));
  serverG.add(at(rbox(1.5, 0.06, 1.5, M.dimm, 0.03), CPU.x, Y0 + 0.09, CPU.z));
  serverG.add(at(rbox(1.18, 0.11, 1.18, M.lid, 0.05), CPU.x, Y0 + 0.165, CPU.z));
  for (const [w, d, dx, dz] of [[1.86, 0.035, 0, -0.93], [1.86, 0.035, 0, 0.93], [0.035, 1.86, -0.93, 0], [0.035, 1.86, 0.93, 0]]) {
    serverG.add(at(flat(w, 0.02, d, M.ring), CPU.x + dx, Y0 + 0.012, CPU.z + dz));
  }
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
    fan.userData.live = true; // only the blades turn; the hub and its ring look the same at any angle, so they stay with the card
    mergeStatic(fan);
    serverG.add(at(shade(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.07, 28), M.shroud)), CARD.x, CARD.top + 0.05, CARD.z + fz));
    const hub = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 8, 32), M.hub);
    hub.rotation.x = Math.PI / 2;
    serverG.add(at(hub, CARD.x, CARD.top + 0.09, CARD.z + fz));
    serverG.add(at(fan, CARD.x, CARD.top + 0.05, CARD.z + fz));
    fans.push(fan);
  }
  for (let i = 0; i < 8; i++) serverG.add(at(flat(LANE.ram[1] - LANE.ram[0], 0.012, 0.035, M.trace), (LANE.ram[0] + LANE.ram[1]) / 2, Y0 + 0.007, -0.77 + i * 0.22));
  for (let i = 0; i < 5; i++) serverG.add(at(flat(LANE.card[1] - LANE.card[0], 0.012, 0.035, M.trace), (LANE.card[0] + LANE.card[1]) / 2, Y0 + 0.007, -0.24 + i * 0.12));
  const PKT = 26;
  const packets = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 0.055), M.pulse, PKT);
  packets.frustumCulled = false;
  serverG.add(packets);
  mergeStatic(serverG); // the board's hundred-odd fixed parts become one mesh per material
  scene.add(serverG);

  // ── the model on the move: lights that drift over the water and climb aboard ──
  const NMOTE = 42, TRAIL = 4;
  const motes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 12, 8), M.mote, NMOTE * TRAIL);
  motes.frustumCulled = false; // (drawn only while the model is on its way over: see update)
  scene.add(motes);
  let journeys = [], cardAt = [T_MOVE + 5, T_MOVE + 8], narrow = false, motesEnd = T_OFF, motesShown = true;
  const heldAt = new Float32Array(NCELL);

  // two framings: the whole stage (racks, open water, your server), then close on the board
  const rigs = { wide: { fov: 26, t: V(0, 0, 0), az: 0.1, el: 0.4, dist: 35 }, close: { fov: 26, t: V(0, 0, 0), az: 0.2, el: 0.52, dist: 20.5 } };

  // frame: { aspect, bandH, bandV } = the window's shape and the share of it (across, down) the story may fill
  function place(isNarrow, origin, frame) {
    const aspect = frame.aspect;
    narrow = isNarrow;
    const O = origin;
    if (narrow) { racksG.position.set(O.x - 0.3, AFLOAT, O.z - 9.5); racksG.scale.setScalar(0.86); serverG.position.set(O.x + 0.3, AFLOAT, O.z + 2.4); }
    else { racksG.position.set(O.x - 8.0, AFLOAT, O.z - 7.6); racksG.scale.setScalar(1); serverG.position.set(O.x + 4.0, AFLOAT, O.z + 2.2); } // open water between them, for the model to cross
    const rs = racksG.scale.x, R = racksG.position, S = serverG.position;
    water.setBoxes([[R.x, R.z, ((RACK_L + 1.4) / 2) * rs, ((RACK.d + 1.6) / 2) * rs], [S.x, S.z, BX + 0.65, BZ + 0.65]]);
    racksG.updateMatrixWorld(true); serverG.updateMatrixWorld(true);

    const fit = Math.max(1, 1.78 / aspect);
    if (narrow) { // racks behind, board in front: suits a tall or squarish view
      const k = 2 * Math.tan(THREE.MathUtils.degToRad(20)); // height seen per unit of distance at a 40° view
      const fitDist = (w, h) => Math.max(h / (k * frame.bandV), w / (k * aspect * frame.bandH)); // far enough to fit both ways
      Object.assign(rigs.wide, { fov: 40, az: 0.0, el: 0.6, dist: fitDist(14, 18) }); rigs.wide.t.set(O.x, 0.3, O.z - 2.2); // sized generously: the board is nearer the camera than this point, so it looms larger
      Object.assign(rigs.close, { fov: 40, az: 0.1, el: 0.72, dist: fitDist(10.8, 6.8) }); rigs.close.t.set(S.x, 0.5, S.z);
    } else {
      Object.assign(rigs.wide, { fov: 26, az: 0.1, el: 0.4, dist: 35 * fit }); rigs.wide.t.set(O.x - 0.8, 0.2, O.z - 2.4);
      Object.assign(rigs.close, { fov: 26, az: 0.2, el: 0.52, dist: 20.5 * fit }); rigs.close.t.set(S.x - 0.3, 0.45, S.z - 0.2);
    }

    // routes: off the foot of a rack, a slow meander over the water, aboard at the board's edge, up into a memory cell (or the card)
    journeys = [];
    const inRaft = (p) => Math.abs(p.x - S.x) < BX + 0.8 && Math.abs(p.z - S.z) < BZ + 0.8;
    for (let i = 0; i < NMOTE; i++) {
      const toCard = i % 7 === 3;
      const cell = Math.floor(rand(i + 60) * NCELL);
      const local = toCard ? V(CARD.x + (rand(i + 61) - 0.5) * 1.0, CARD.top + 0.06, CARD.z + (rand(i + 81) - 0.5) * 3.4) : cellLocal[cell].clone();
      const end = local.applyMatrix4(serverG.matrixWorld);
      const start = V((rand(i + 1) - 0.5) * (RACK_L - 0.6), 0, RACK.d / 2 + 0.95).multiplyScalar(rs).add(V(R.x, 0, R.z)); start.y = 0.07;
      let edge = start.clone();
      for (let k = 1; k <= 80; k++) { const q = start.clone().lerp(end, k / 80); q.y = 0.07; if (inRaft(q)) break; edge = q; }
      const dir = edge.clone().sub(start), side = V(-dir.z, 0, dir.x).normalize(), bend = (rand(i + 140) - 0.5) * 2.4;
      const pts = [start, start.clone().lerp(edge, 0.33).addScaledVector(side, bend), start.clone().lerp(edge, 0.7).addScaledVector(side, -bend * 0.6), edge, edge.clone().lerp(end, 0.5).setY(end.y + 1.0), end];
      journeys.push({ curve: new THREE.CatmullRomCurve3(pts, false, "centripetal"), t0: T_MOVE + rand(i + 200) * 4.6, dur: 4.6 + rand(i + 220) * 1.6, toCard, last: start.clone() });
    }
    const arrive = journeys.filter((j) => !j.toCard);
    for (let c = 0; c < NCELL; c++) { const j = arrive[c % arrive.length]; heldAt[c] = j.t0 + j.dur * 0.97 + rand(c + 300) * 0.7; }
    const card = journeys.filter((j) => j.toCard).map((j) => j.t0 + j.dur).sort((x, y) => x - y);
    cardAt = [card[0], card[card.length - 1]];
    motesEnd = Math.max(...journeys.map((j) => j.t0 + j.dur));
    motesShown = true; lastTime = -1; // lay everything out afresh on the next picture
  }

  // which memory cells each word uses (a few specialists out of many)
  const picks = WORDS.map((_, w) => { const s = new Set(); let k = 0; while (s.size < 7) s.add(Math.floor(rand(w * 17 + k++ + 3) * NCELL)); return [...s]; });

  const v = V(0, 0, 0), col = new THREE.Color(), pk = new THREE.Object3D();
  let spin = 0, prevU = 0, prevWi = -2, lastTime = -1;
  const ring = (lx, lz, s) => { v.set(lx, 0, lz).applyMatrix4(serverG.matrixWorld); water.drop(v.x, v.z, s); }; // a soft ring leaving the board
  const state = { power: 1, pick: 0, cpuOn: 0, cardOn: 0, moving: false, decoding: false, wi: -1, u: 0 };

  // how close the view should be: 0 = whole stage, 1 = close on the board
  const nearAt = (time) => ss(T_OFF - 0.6, T_WORDS - 0.4, time) * (1 - ss(T_DONE + 0.5, LOOP - 0.5, time));

  function update(time, dt = 0) {
    if (time === lastTime && dt === 0) return; // paused: nothing has moved since the last picture
    lastTime = time;
    const power = 1 - ss(T_OFF, T_OFF + 2.4, time);
    const decoding = time >= T_WORDS && time < T_DONE;
    const wi = decoding ? Math.floor((time - T_WORDS) / CYCLE) : -1;
    const u = decoding ? ((time - T_WORDS) / CYCLE) % 1 : 0;
    const cardOn = decoding ? Math.max(bump(0, 0.3, u), bump(0.84, 1.0, u)) : 0;
    const pick = decoding ? bump(0.26, 0.74, u) : 0;
    const cpuOn = decoding ? bump(0.4, 0.86, u) : 0;
    Object.assign(state, { power, pick, cpuOn, cardOn, decoding, wi, u, moving: time > T_MOVE + 4 && time < T_OFF + 1.5 });

    // the board floats: a slow breath
    serverG.position.y = AFLOAT + Math.sin(time * 0.85) * 0.014 + Math.sin(time * 0.53 + 1) * 0.006;
    serverG.rotation.set(Math.sin(time * 0.6) * 0.004, 0, Math.sin(time * 0.47 + 2) * 0.004);
    serverG.updateMatrixWorld(true);

    // racks
    M.rackFront.emissiveIntensity = power * (3.0 + 0.5 * Math.sin(time * 7));
    M.rackFront.color.setScalar(0.45 + 0.55 * power);
    M.rackFrame.color.copy(rackBase.frame).multiplyScalar(0.5 + 0.5 * power);
    M.rackSide.color.copy(rackBase.side).multiplyScalar(0.5 + 0.5 * power);
    M.glass.opacity = 0.014 + 0.018 * power;
    M.glassEdge.opacity = 0.12 + 0.18 * power;

    // the model drifting over (once the last light has landed there is nothing to move)
    const drifting = time > T_MOVE && time < motesEnd;
    if (drifting || motesShown) for (let i = 0; i < NMOTE; i++) {
      const j = journeys[i], q = (time - j.t0) / j.dur;
      const on = q > 0 && q < 1;
      for (let k = 0; k < TRAIL; k++) {
        if (on) {
          j.curve.getPointAt(ss(0, 1, Math.max(0, q - k * 0.011)), pk.position);
          pk.scale.setScalar((1 - k * 0.22) * Math.min(1, q * 8) * Math.min(1, (1 - q) * 10));
        } else pk.scale.setScalar(0);
        pk.rotation.set(0, 0, 0); pk.updateMatrix();
        motes.setMatrixAt(i * TRAIL + k, pk.matrix);
        if (on && k === 0 && dt > 0 && pk.position.y < 0.14 && Math.hypot(pk.position.x - j.last.x, pk.position.z - j.last.z) > 0.24) {
          water.drop(pk.position.x, pk.position.z, -0.014 * wake); // its wake
          j.last.copy(pk.position);
        }
      }
      if (!on) j.last.copy(j.curve.points[0]);
    }
    if (drifting || motesShown) motes.instanceMatrix.needsUpdate = true;
    motesShown = motes.visible = drifting;

    // memory cells
    for (let c = 0; c < NCELL; c++) { col.copy(COL.off).lerp(COL.held, ss(heldAt[c], heldAt[c] + 0.5, time)); cells.setColorAt(c, col); }
    if (wi >= 0) for (const c of picks[wi]) { col.copy(COL.held).lerp(COL.hot, pick); cells.setColorAt(c, col); }
    cells.instanceColor.needsUpdate = true;

    // processor + card
    const cardLoaded = ss(cardAt[0], cardAt[1], time), loaded = ss(T_MOVE + 4, T_WORDS - 1.5, time);
    M.lid.emissiveIntensity = cpuOn * 0.6;
    M.ring.color.copy(COL.off).lerp(COL.traceIdle, loaded).lerp(COL.hot, cpuOn);
    M.strip.color.copy(COL.off).lerp(COL.held, cardLoaded).lerp(COL.hot, cardOn);
    M.hub.color.copy(COL.off).lerp(COL.held, cardLoaded).lerp(COL.hot, cardOn);
    spin += dt * (1.2 * cardLoaded + 6 * cardOn);
    for (const f of fans) f.rotation.y = spin;

    // packets on the copper paths
    let n = 0;
    const put = (x, z, len) => { if (n >= PKT) return; pk.position.set(x, Y0 + 0.02, z); pk.rotation.set(0, 0, 0); pk.scale.set(len, 1, 1); pk.updateMatrix(); packets.setMatrixAt(n++, pk.matrix); };
    if (decoding) {
      const ask = (u - 0.2) / 0.2, back = (u - 0.74) / 0.16, fetch = (u - 0.34) / 0.3;
      const [c0, c1] = LANE.card, [r0, r1] = LANE.ram;
      for (let i = 0; i < 5; i++) {
        const z = -0.24 + i * 0.12;
        if (ask > 0 && ask < 1) put(c1 - 0.08 - ask * (c1 - c0 - 0.16), z, 0.16);
        if (back > 0 && back < 1) put(c0 + 0.08 + back * (c1 - c0 - 0.16), z, 0.16);
      }
      for (let i = 0; i < 8; i++) for (let k = 0; k < 2; k++) {
        const q = fetch * 1.5 - k * 0.5 - (i % 3) * 0.08;
        if (q > 0 && q < 1) put(r0 + 0.1 + q * (r1 - r0 - 0.2), -0.77 + i * 0.22, 0.2);
      }
    }
    packets.count = n; // only the packets on the move are drawn
    packets.visible = n > 0;
    if (n > 0) packets.instanceMatrix.needsUpdate = true;

    // each stage of a word sends one soft ring out from the board
    if (dt > 0 && decoding) {
      const crossed = (m) => (wi !== prevWi ? u >= m : prevU < m && u >= m);
      if (crossed(0.04)) ring(BX + 1.0, 0.4, 0.03);
      if (crossed(0.46)) ring(0.6, BZ + 1.0, 0.026);
      if (crossed(0.88)) ring(BX + 1.0, -0.4, 0.03);
    }
    prevU = u; prevWi = wi;
  }

  // camera framing for this moment of the story
  function rig(time, out) {
    const near = nearAt(time), A = rigs.wide, B = rigs.close, mix = (x, y) => x + (y - x) * near;
    out.fov = mix(A.fov, B.fov); out.az = mix(A.az, B.az) + Math.sin(time * 0.11) * 0.02; out.el = mix(A.el, B.el); out.dist = mix(A.dist, B.dist);
    out.target.lerpVectors(A.t, B.t, near);
    return near;
  }

  // labels that sit on things in the scene, plus the read-out and the three steps
  const anchors = {
    ram: [serverG, V(BANK.x0 + ((BANK.n - 1) * BANK.pitch) / 2, Y0 + 1.3, BANK.z - BANK.len / 2 - 0.3)],
    cpu: [serverG, V(CPU.x, Y0 + 0.85, CPU.z - 1.5)],
    gpu: [serverG, V(CARD.x, CARD.top + 0.75, CARD.z - CARD.len / 2 - 0.3)],
    racks: [racksG, V(0, RACK.y0 + RACK.h + 0.9, 0)],
    server: [serverG, V(0.4, 1.9, -BZ - 0.2)],
  };
  const LIFT = { ram: 0, cpu: 0, gpu: 24, racks: 0, server: 0 };
  const labels = [...dom.labels].map((el) => {
    const k = el.dataset.anchor;
    el.style.setProperty("--lead", `${14 + LIFT[k]}px`);
    return { el, key: k, lift: LIFT[k] };
  });
  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
  let labelsShown = true, stepShown = 0;

  function label(camera, W, H, alpha, time) {
    const near = nearAt(time), parts = ss(0.45, 0.9, near), whole = 1 - ss(0.25, 0.7, near);
    const lit = { ram: state.pick > 0.35 || state.moving, cpu: state.cpuOn > 0.35, gpu: state.cardOn > 0.35 };
    if (alpha > 0 || labelsShown) for (const l of labels) { // hidden labels are left alone
      const [group, local] = anchors[l.key];
      v.copy(local).applyMatrix4(group.matrixWorld).project(camera);
      const show = l.key === "racks" || l.key === "server" ? whole : parts;
      l.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%) translateY(${-l.lift}px)`;
      l.el.style.opacity = (v.z < 1 ? alpha * show : 0).toFixed(2);
      l.el.classList.toggle("is-on", !!lit[l.key]);
      if (l.key === "racks") l.el.classList.toggle("is-off", state.power < 0.5);
    }
    labelsShown = alpha > 0;
    const step = time < T_MOVE ? 1 : time < T_WORDS ? 2 : 3;
    if (step !== stepShown) { stepShown = step; for (const el of dom.steps) el.classList.toggle("is-active", Number(el.dataset.step) === step); }
    const { decoding, u, wi } = state;
    let now;
    if (time < T_MOVE) now = "The usual way: the whole model sits on a GPU rack.";
    else if (time < T_WORDS) now = "locus moves it over: the specialists settle into your server's RAM, a small part onto one card.";
    else if (!decoding) now = "Done. Nothing left the building.";
    else if (u < 0.3) now = "Graphics card: reads the request and picks the few specialists this word needs.";
    else if (u < 0.84) now = "CPU: runs those specialists straight from RAM.";
    else now = "Graphics card: puts the result together. One more word.";
    setText(dom.narrate, now);
    const shown = decoding ? wi + (u >= 0.9 ? 1 : 0) : time >= T_DONE ? WORDS.length : 0;
    setText(dom.answer, WORDS.slice(0, shown).join(" "));
  }

  return { place, update, rig, label, loop: LOOP, settled: T_WORDS + CYCLE * 2.55 };
}
