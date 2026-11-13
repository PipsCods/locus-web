// One pond behind the whole page.
// At the top the view rests on the lotus. As the visitor scrolls towards "How it works" the
// camera glides across the water, past drifting leaves, to the racks and the server's board,
// where the story then plays. The cursor stirs the water everywhere.
//
// Kept light on purpose: fixed parts are merged into a few meshes, nothing is worked out for
// things that are not in view, and the picture quality steps down by itself on devices that
// cannot keep up (see QUALITY below).

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createWater } from "./water.js";
import { createFlower, padGeometry, padTexture } from "./lotus.js";
import { createStory } from "./story.js";
import { createFinish } from "./finish.js";

const PAGE = 0x050706;
const STAGE = new THREE.Vector3(30, 0, -4); // where the "how it works" story stands, across the water from the lotus
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;

// Quality levels, best first. The page starts high and steps down, one level at a time, while a
// picture takes longer to make than the screen allows; it never steps back up, so it cannot flicker.
//   ratio   canvas pixels per screen pixel (never more than the screen has)
//   smooth  edge smoothing samples         glow    soft glow round bright things
//   shadow  shadow picture size (0 = off)  mirror  size of the water's mirror image, share of the canvas
//   every   redraw the mirror image every n-th picture (0 = no mirror image)
//   grid    ripple grid size and steps per second
const QUALITY = [
  { ratio: 1.5, smooth: 4, glow: true, shadow: 1536, mirror: 0.5, every: 1, grid: [1024, 60] },
  { ratio: 1.25, smooth: 2, glow: true, shadow: 1024, mirror: 0.42, every: 1, grid: [1024, 60] },
  { ratio: 1.0, smooth: 0, glow: true, shadow: 1024, mirror: 0.36, every: 1, grid: [512, 30] },
  { ratio: 0.8, smooth: 0, glow: false, shadow: 0, mirror: 0.36, every: 2, grid: [512, 30] },
  { ratio: 0.62, smooth: 0, glow: false, shadow: 0, mirror: 0.25, every: 0, grid: [512, 30] },
];
// ms: a picture that takes longer than this misses its turn on a 60-a-second screen (?budget=5 forces the stepping-down, for testing)
const BUDGET = Number(new URLSearchParams(location.search).get("budget")) || 19;
const STORE = "locus-quality";

function startLevel() {
  const asked = new URLSearchParams(location.search).get("q"); // ?q=0..4 pins a level (testing)
  if (asked !== null && asked !== "" && !Number.isNaN(Number(asked))) return { level: Number(asked), pinned: true };
  let level = 0;
  const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) <= 900;
  if ((navigator.hardwareConcurrency || 8) < 4 || (navigator.deviceMemory || 8) <= 2) level = 2; // a modest machine: start lower, no stutter while it finds out
  else if (phone) level = 1;
  try { const kept = Number(sessionStorage.getItem(STORE)); if (kept > level) level = kept; } catch { /* private mode: fine */ }
  return { level, pinned: false };
}

export function initWorld({ host, how, dom }) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  try {
    // failIfMajorPerformanceCaveat: with no real graphics chip the pond would crawl, so the page shows its plain version instead
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true });
  } catch (err) {
    console.warn("locus: WebGL unavailable, showing the page without the pond.", err);
    return null;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // shadows are only redrawn while the story is in view
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;opacity:0";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAGE);
  scene.fog = new THREE.FogExp2(PAGE, 0.03);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.36;
  const camera = new THREE.PerspectiveCamera(28, 2, 0.5, 260);

  scene.add(new THREE.HemisphereLight(0xdcefe8, 0x030504, 0.5));
  const key = new THREE.DirectionalLight(0xfff1e6, 2.0); // soft daylight from the front-left; follows the view
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  Object.assign(key.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
  key.shadow.bias = -0.0004;
  key.shadow.radius = 5;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xf3b6cb, 1.5); // low pink back light: the petals' glowing edges
  scene.add(rim, rim.target);

  const finish = createFinish(renderer);
  const bloom = finish.glow;

  // ── things on the water ──
  const water = createWater(renderer, { size: 72, res: 1024, center: [16, -4], rate: 60, dropRadius: 0.17, plane: 180 });
  scene.add(water.mesh);

  const flower = createFlower();
  scene.add(flower);

  // Floating leaves, as three fixed clusters (round the lotus, along the way, round the story): one mesh each.
  const padMat = new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.78, metalness: 0, envMapIntensity: 0.3, side: THREE.DoubleSide });
  const m4 = new THREE.Matrix4();
  const padCluster = (list) => scene.add(new THREE.Mesh(mergeGeometries(list.map(([x, z, r, turn]) => padGeometry(r).applyMatrix4(m4.makeRotationY(turn).setPosition(x, 0.022, z)))), padMat));
  padCluster([[-2.7, -1.0, 1.55, 0.5], [2.6, -1.8, 1.35, 2.3], [-0.5, -3.4, 1.7, 4.1], [4.3, 0.5, 1.15, 3.3], [-4.6, 0.9, 1.25, 5.6], [1.9, 1.7, 0.62, 1.2]]);
  padCluster([[8.5, 2.6, 1.2, 0.9], [11.5, -4.2, 1.6, 2.7], [15.5, 1.6, 0.9, 4.4], [18.0, -6.4, 1.3, 1.8], [21.5, 4.4, 1.5, 3.6], [6.2, -6.0, 1.0, 5.1]]); // they slide past as the view crosses the water
  padCluster([[-5.2, -3.4, 1.5], [5.6, -4.4, 1.15], [-5.6, 6.4, 0.9], [6.1, 7.2, 1.7], [0.2, 9.4, 1.25]].map(([x, z, r], i) => [STAGE.x + x, STAGE.z + z, r, i * 1.3 + 0.4]));

  const story = createStory(scene, water, dom);

  // ── quality ──
  const start = startLevel();
  let level = -1, q = QUALITY[0], still = false; // still: last resort, the pond only redraws when the page moves
  function setLevel(n) {
    n = Math.max(0, Math.min(QUALITY.length - 1, Math.round(n)));
    if (n === level) return;
    level = n; q = QUALITY[n];
    finish.setSamples(q.smooth);
    key.castShadow = q.shadow > 0;
    if (q.shadow > 0 && key.shadow.mapSize.x !== q.shadow) { key.shadow.mapSize.set(q.shadow, q.shadow); key.shadow.map?.dispose(); key.shadow.map = null; }
    water.setDetail(q.grid[0], q.grid[1]);
    water.setMirrorEvery(q.every);
    document.body.classList.toggle("pond-lite", n >= 2); // the page drops its frosted-glass blur too
    if (W > 1) resize();
  }

  // ── sizing ──
  let W = 1, H = 1, narrow = null, heroDist = 10.5;
  const buf = new THREE.Vector2();
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.ratio));
    renderer.setSize(W, H, false);
    renderer.getDrawingBufferSize(buf);
    finish.setSize(buf.x, buf.y);
    water.setMirrorSize(buf.x * q.mirror, buf.y * q.mirror);
    camera.aspect = W / H;
    heroDist = Math.max(10.5, 2.3 / (Math.tan(THREE.MathUtils.degToRad(14)) * camera.aspect)); // keep the whole flower in frame
    narrow = camera.aspect < 1.05;
    // The story is always staged in depth (racks behind, board in front): on wide screens it shares the
    // window with its text column, on narrow ones with the text above and below, so its own area is squarish.
    story.place(true, STAGE, { aspect: camera.aspect, bandH: narrow ? 0.94 : 0.56, bandV: narrow ? 0.42 : 0.84 });
    dirty = true;
  }
  let dirty = true, lastScroll = -1e9;
  setLevel(start.level);
  new ResizeObserver(resize).observe(host);
  resize();
  window.addEventListener("scroll", () => { lastScroll = performance.now(); dirty = true; }, { passive: true });

  // ── how far the visitor has scrolled from the lotus (0) to "How it works" (1) ──
  const navH = 64;
  let forced = null;
  function travel(top) {
    if (forced !== null) return forced;
    const from = window.innerHeight * 0.94, to = navH + 4;
    return clamp((from - top) / (from - to));
  }

  // ── cursor → ripples, anywhere on the page ──
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(V(0, 1, 0), 0), hit = V(0, 0, 0), ptr = new THREE.Vector2();
  const lastDrop = { x: 999, z: 999, t: 0 };
  let sway = 0, swayT = 0;
  const calm = () => reduce || still; // the water is not stirred
  function toWater(e) {
    ptr.set((e.clientX / W) * 2 - 1, -((e.clientY / H) * 2 - 1));
    swayT = ptr.x;
    ray.setFromCamera(ptr, camera);
    return ray.ray.intersectPlane(plane, hit);
  }
  window.addEventListener("pointermove", (e) => {
    if (calm() || !toWater(e)) return;
    const now = performance.now(), dx = hit.x - lastDrop.x, dz = hit.z - lastDrop.z, moved = Math.hypot(dx, dz);
    if (moved < 0.12) return;
    if (moved > 4 || now - lastDrop.t > 400) water.drop(hit.x, hit.z, -0.02);
    else {
      const speed = Math.min(1, (moved / Math.max(8, now - lastDrop.t)) * 14), n = Math.min(10, Math.ceil(moved / 0.12));
      for (let i = 1; i <= n; i++) water.drop(lastDrop.x + (dx * i) / n, lastDrop.z + (dz * i) / n, -(0.005 + 0.007 * speed));
    }
    lastDrop.x = hit.x; lastDrop.z = hit.z; lastDrop.t = now;
  }, { passive: true });
  window.addEventListener("pointerdown", (e) => { if (!calm() && !e.target.closest?.("a, button, input") && toWater(e)) water.drop(hit.x, hit.z, -0.1); }, { passive: true });
  document.addEventListener("pointerleave", () => { swayT = 0; });

  // ── one picture ──
  const heroRig = { fov: 28, az: 0, el: Math.atan(0.332), dist: 11, target: V(0, -0.9, 0) };
  const storyRig = { fov: 26, az: 0.1, el: 0.4, dist: 35, target: V(0, 0, 0) };
  const target = V(0, 0, 0), focus = V(0, 0, 0);
  let clock = 0, st = reduce ? story.settled : 0, nextShed = 0.5, p = 0, t0 = 0, fade = 0;

  function render(dt, now, top = how.getBoundingClientRect().top, quiet = false) {
    clock += calm() ? 0 : dt;
    const t = clock;
    p = travel(top);
    const pe = smooth(p);

    // the lotus floats: a slow breath and a sway of a few degrees
    flower.position.y = 0.03 + Math.sin(t * 1.05) * 0.018 + Math.sin(t * 0.63 + 1.3) * 0.008;
    flower.rotation.set(Math.sin(t * 0.8) * 0.012, Math.PI / 8 + Math.sin(t * 0.13) * 0.12, Math.sin(t * 0.57 + 2) * 0.012);
    if (!calm() && pe < 0.7 && t > nextShed) { for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; water.drop(Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.016); } nextShed = t + 2.8; }

    // the story plays once the view has arrived, and rewinds when the visitor goes back up
    const playing = !calm() && p > 0.9;
    if (playing) st = (st + dt) % story.loop; else if (!calm() && p < 0.3) st = 0;
    story.update(st, playing ? dt : 0);
    story.rig(st, storyRig);

    // camera: the lotus framing, blended into the story's framing as the page scrolls
    sway += (swayT - sway) * Math.min(1, dt * 1.6);
    heroRig.dist = heroDist * 1.0537; heroRig.target.set(0, -0.085 * heroDist, 0);
    const fov = mix(heroRig.fov, storyRig.fov, pe), az = mix(heroRig.az, storyRig.az, pe) + sway * mix(0.04, 0.03, pe);
    const el = mix(heroRig.el, storyRig.el, pe) + Math.sin(pe * Math.PI) * 0.06; // rises a little mid-crossing
    const dist = mix(heroRig.dist, storyRig.dist, pe);
    target.lerpVectors(heroRig.target, storyRig.target, pe);
    camera.fov = fov;
    // on wide screens the story sits to the right of its text; on narrow ones a little above centre
    const offX = narrow ? 0 : W * 0.21 * pe, offY = narrow ? -H * 0.05 * pe : H * 0.02 * pe;
    camera.setViewOffset(W, H, -offX, -offY, W, H);
    camera.position.set(target.x + dist * Math.sin(az) * Math.cos(el), target.y + dist * Math.sin(el), target.z + dist * Math.cos(az) * Math.cos(el));
    camera.lookAt(target);
    camera.updateMatrixWorld();

    // light and atmosphere follow the view
    focus.set(target.x, 0, target.z);
    key.target.position.copy(focus); key.position.set(focus.x - 8, 18, focus.z + 12);
    key.intensity = mix(2.0, 2.3, pe);
    renderer.shadowMap.needsUpdate = key.castShadow && pe > 0.02; // only the story's things cast or catch shadows
    rim.target.position.copy(focus); rim.position.set(focus.x + 2, 4.5, focus.z - 9);
    rim.intensity = mix(1.5, 0.3, pe);
    scene.fog.density = mix((0.045 * 8.4) / heroDist, 0.018, pe);
    bloom.strength = mix(0.22, 0.42, pe); bloom.threshold = mix(0.9, 0.96, pe);
    finish.setGlow(q.glow ? smooth((pe - 0.08) / 0.12) : 0); // nothing by the lotus is bright enough to glow, so the glow only switches on as the view leaves it
    const wu = water.mesh.material.uniforms;
    wu.uCentre.value.set(target.x, target.z);
    wu.uFade.value.set(mix(6, 13, pe), mix(15, 28, pe));
    wu.uMirror.value = q.every > 0 ? mix(1, 0.5, pe) : 0;
    wu.uGlow.value = mix(1, 0.45, pe);

    if (!calm()) water.advance(dt);
    water.update(t, camera);
    finish.render(scene, camera);
    if (!quiet) story.label(camera, W, H, smooth((p - 0.7) / 0.3), st);

    if (fade < 1 && !quiet) { // the pond fades in once, then the canvas is left alone
      fade = Math.min(1, (now - t0) / 1400);
      canvas.style.opacity = (fade * fade * (3 - 2 * fade)).toFixed(3);
    }
  }

  // ── keeping it smooth ──
  // Every few pictures we time the whole job: our own work plus the graphics chip finishing it (a marker
  // placed after the last drawing command tells us when). If that keeps running over the screen's
  // budget the quality steps down a level. Timing the work itself, not the pace of pictures, means a
  // browser that is saving power by showing fewer pictures does not get mistaken for a slow device.
  const gl = renderer.getContext();
  const watch = { on: !start.pinned && !reduce && typeof gl.fenceSync === "function", busy: false, n: 0, hold: 0, costs: [], strikes: 0, last: 0 };
  function lower(by, cost, now) {
    watch.strikes = 0;
    if (level >= QUALITY.length - 1) {
      if (cost > BUDGET * 2.4) { still = true; st = story.settled; dirty = true; watch.on = false; } // even the lightest level crawls: hold the pond still
      return;
    }
    setLevel(level + by);
    watch.hold = now + 900; // let the change settle before timing again
    try { sessionStorage.setItem(STORE, String(level)); } catch { /* fine */ }
  }
  function timeIt(ownMs, now) {
    if (!watch.on || watch.busy || now < watch.hold || watch.n++ % 4) return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    gl.flush();
    watch.busy = true;
    const sent = performance.now();
    const poll = () => {
      const state = gl.clientWaitSync(sync, 0, 0);
      const waited = performance.now() - sent;
      if (state === gl.TIMEOUT_EXPIRED && waited < 400) { setTimeout(poll, waited < 4 ? 0 : 2); return; }
      gl.deleteSync(sync);
      watch.busy = false;
      if (state === gl.WAIT_FAILED || document.hidden) return;
      watch.last = ownMs + waited;
      watch.costs.push(watch.last);
      if (watch.costs.length < 9) return;
      const cost = watch.costs.sort((a, b) => a - b)[4]; // the middle one: a single hiccup does not count
      watch.costs.length = 0;
      const t = performance.now();
      if (cost > BUDGET * 1.8) lower(2, cost, t);
      else if (cost > BUDGET) { if (++watch.strikes >= 2) lower(1, cost, t); }
      else watch.strikes = 0;
    };
    setTimeout(poll, 0);
  }

  // ── frame loop ──
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    // a calm scene needs no more than 60 pictures a second; faster screens get every picture only while the page is scrolling
    if (now - last < 10.5 && performance.now() - lastScroll > 160) return;
    const rect = how.getBoundingClientRect();
    if (rect.bottom < -40) { last = now; return; }                    // scrolled past: the closing section hides the pond
    if (calm() && !dirty && fade >= 1) { last = now; return; }        // nothing moves: keep the last picture
    dirty = false;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const began = performance.now();
    render(dt, now, rect.top);
    timeIt(performance.now() - began, now);
  }

  // Get everything ready before the first picture: shaders are built in the background, then one hidden
  // picture of the story warms up its models and textures, so the first scroll down does not stutter.
  let started = false;
  function begin() {
    if (started) return;
    started = true;
    forced = 1; render(1 / 60, performance.now(), 0, true); forced = null;
    t0 = last = performance.now();
    watch.hold = t0 + 1800;
    requestAnimationFrame(frame);
  }
  try {
    renderer.setRenderTarget(finish.target);
    const ready = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(null);
    ready.then(begin, begin);
    setTimeout(begin, 3000); // never wait for ever
  } catch { begin(); }

  return {
    canvas,
    progress: () => p,
    level: () => (still ? "still" : level),
    setLevel: (n) => { watch.on = false; setLevel(n); },
    cost: () => watch.last,
    seek: (sec) => { st = sec; },
    play: (sec, step = 1 / 60) => { for (let s = 0; s < sec; s += step) render(step, performance.now()); return st; }, // run forward right now (tests)
    bench: (n = 30) => { const px = new Uint8Array(4), a = performance.now(); for (let i = 0; i < n; i++) { render(1 / 60, performance.now()); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return (performance.now() - a) / n; },
    loop: story.loop,
    debug: { renderer, finish, scene, camera, water, key, bloom, story, watch },
  };
}
