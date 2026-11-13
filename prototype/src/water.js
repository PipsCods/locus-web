// Shared pond water: a ripple simulation (a height field stepped on the GPU) drawn as a dark
// mirror whose image is bent by the ripples.
//
//   const water = createWater(renderer, { size: 30 });
//   scene.add(water.mesh);
//   water.drop(x, z, -0.05);          // disturb the surface at a world position
//   water.advance(dt);                 // step the simulation
//   water.update(time, camera);        // before rendering
//
// Cost controls, for slower devices:
//   water.setDetail(res, rate)         // size of the ripple grid and how many steps it takes per second
//   water.setMirrorSize(w, h)          // size of the mirror image
//   water.setMirrorEvery(n)            // redraw the mirror image every n-th picture (0 = never)

import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";

const QUAD_VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SIM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tPrev;      // r = height now, g = height one step ago
  uniform vec2 uTexel;
  uniform vec3 uDrops[8];       // xy = position (uv), z = strength
  uniform int uCount;           // how many of them are in use this step
  uniform float uDropR;
  uniform float uDamp;
  uniform vec4 uBox[2];         // things standing in the water: centre.xy, half-size.zw (uv); waves break against them
  varying vec2 vUv;
  void main() {
    vec4 d = texture2D(tPrev, vUv);
    float s = texture2D(tPrev, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tPrev, vUv - vec2(uTexel.x, 0.0)).r
            + texture2D(tPrev, vUv + vec2(0.0, uTexel.y)).r + texture2D(tPrev, vUv - vec2(0.0, uTexel.y)).r;
    float h = (s * 0.5 - d.g) * uDamp;
    for (int i = 0; i < 8; i++) {
      if (i >= uCount) break;
      float q = distance(vUv, uDrops[i].xy) / uDropR;
      h += uDrops[i].z * exp(-q * q);
    }
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    h *= smoothstep(0.0, 0.07, edge);
    for (int i = 0; i < 2; i++) {
      vec2 q = abs(vUv - uBox[i].xy) - uBox[i].zw;
      h *= uBox[i].z > 0.0 ? smoothstep(-0.004, 0.004, max(q.x, q.y)) : 1.0;
    }
    gl_FragColor = vec4(h, d.r, 0.0, 1.0);
  }`;
const COPY_FRAG = "precision highp float; uniform sampler2D tPrev; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tPrev, vUv); }";

export function createWater(renderer, opts = {}) {
  const SIM = opts.size ?? 30;
  const RES0 = opts.res ?? 640, RATE0 = opts.rate ?? 120;   // the grid the look was tuned on
  const DROP0 = opts.dropRadius ?? 0.135, DAMP0 = opts.damping ?? 0.994;
  const [CX, CZ] = opts.center ?? [0, 0]; // world position of the middle of the simulated water
  const [fadeNear, fadeFar] = opts.fade ?? [9, 22];
  let res = RES0, step = 1 / RATE0, dropGain = 1;
  const speed = ((SIM / RES0) * Math.SQRT1_2) * RATE0; // how fast ripples travel, world units per second

  // two channels are all the simulation needs: half the memory traffic of a four-channel buffer
  const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  let a = new THREE.WebGLRenderTarget(res, res, rtOpts), b = new THREE.WebGLRenderTarget(res, res, rtOpts);
  const sim = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / res, 1 / res) },
      uDrops: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) }, uCount: { value: 0 },
      uDropR: { value: DROP0 / SIM }, uDamp: { value: DAMP0 },
      uBox: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    },
  });
  const copy = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false, uniforms: { tPrev: sim.uniforms.tPrev } });
  const simScene = new THREE.Scene();
  const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sim);
  simScene.add(simQuad);
  const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const queue = [];

  function pass(material, into) {
    simQuad.material = material;
    renderer.setRenderTarget(into);
    renderer.render(simScene, simCam);
    renderer.setRenderTarget(null);
  }
  function stepOnce() {
    const u = sim.uniforms, n = Math.min(8, queue.length);
    for (let i = 0; i < n; i++) { const q = queue.shift(); u.uDrops.value[i].set((q[0] - CX) / SIM + 0.5, (q[1] - CZ) / SIM + 0.5, q[2] * dropGain); }
    u.uCount.value = n; // still water costs nothing extra
    u.tPrev.value = a.texture;
    pass(sim, b);
    [a, b] = [b, a];
  }

  const shader = {
    name: "LocusPondWater",
    uniforms: {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
      tH: { value: null }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3(0, 2, 8) },
      uLight: { value: new THREE.Vector3(...(opts.light ?? [-0.08, 0.26, -0.96])).normalize() },
      uCentre: { value: new THREE.Vector2(0, 0) },                 // the pond dissolves into the page away from here
      uFade: { value: new THREE.Vector2(fadeNear, fadeFar) },
      uMirror: { value: opts.mirror ?? 1 },   // how strongly the surface mirrors what stands on it
      uGlow: { value: opts.glow ?? 1 },       // strength of the back light's path on the water
      uE: { value: 1 / res },                 // one cell of the ripple grid
      uSlope: { value: 5 },                   // keeps ripples looking the same on a coarser grid
      uBlend: { value: 0 },                   // how far we are between two simulation steps
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
      uniform float uMirror;
      uniform float uGlow;
      uniform vec2 uCentre;
      uniform vec2 uFade;
      uniform float uE;
      uniform float uSlope;
      uniform float uBlend;
      varying vec4 vUv;
      varying vec3 vPos;
      const float SIM = ${SIM.toFixed(1)};
      const vec2 MID = vec2(${CX.toFixed(2)}, ${CZ.toFixed(2)});
      float H(vec2 p) { vec2 h = texture2D(tH, p).rg; return mix(h.g, h.r, uBlend); } // glides from one step to the next
      void main() {
        float alpha = smoothstep(uFade.y, uFade.x, length(vPos.xz - uCentre)); // dissolves into the dark page
        if (alpha <= 0.002) discard;                                           // and beyond that there is nothing to work out
        vec2 p = (vPos.xz - MID) / SIM + 0.5;
        float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
        vec2 raw = vec2(H(p + vec2(uE, 0.0)) - H(p - vec2(uE, 0.0)), H(p + vec2(0.0, uE)) - H(p - vec2(0.0, uE))) * inside * uSlope;
        vec2 slope = raw / (1.0 + length(raw) * 2.2);              // soft limit: tall waves stay believable
        slope += vec2(sin(vPos.x * 1.7 + uTime * 0.6) * cos(vPos.z * 1.3 - uTime * 0.45),
                      cos(vPos.x * 1.1 - uTime * 0.5) * sin(vPos.z * 1.9 + uTime * 0.38)) * 0.014; // a slow swell
        vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec4 uv = vUv;
        uv.xy += n.xz * 0.075 * uv.w;                              // ripples bend the mirror image
        vec3 mirror = texture2DProj(tDiffuse, uv).rgb;
        vec3 view = normalize(uCam - vPos);
        float fres = pow(1.0 - max(dot(view, n), 0.0), 3.0);
        vec3 rdir = reflect(-view, n);                             // the night sky the water mirrors
        vec3 sky = mix(vec3(0.012, 0.046, 0.037), vec3(0.0, 0.004, 0.003), pow(clamp(rdir.y, 0.0, 1.0), 0.5));
        sky += vec3(0.95, 0.6, 0.72) * pow(max(dot(rdir, uLight), 0.0), 48.0) * 0.08 * uGlow;
        vec3 col = color + sky * (0.35 + 0.65 * fres) + mirror * (0.5 + 0.45 * fres) * uMirror;
        float glint = pow(max(dot(n, normalize(view + uLight)), 0.0), 500.0);
        col += vec3(1.0, 0.82, 0.88) * glint * 0.16 * uGlow;
        float r = length(vPos.xz);
        float lit = clamp(-dot(raw, normalize(uLight.xz)) * 2.4, 0.0, 0.3) + clamp(length(raw) * 0.6, 0.0, 0.08);
        col += mix(vec3(0.14, 0.32, 0.28), vec3(0.85, 0.5, 0.62), exp(-r * 0.22)) * lit; // rings catch the back light
        gl_FragColor = vec4(col, alpha);
      }`,
  };
  // The mirror image is seen through ripples and dimmed, so it can be much smaller than the picture
  // (see setMirrorSize); its edges stay smoothed, or calm water would show them as little steps.
  const mesh = new Reflector(new THREE.PlaneGeometry(opts.plane ?? 90, opts.plane ?? 90), { textureWidth: 512, textureHeight: 512, multisample: 4, color: opts.color ?? 0x03100d, clipBias: 0.003, shader });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(CX, 0, CZ);
  mesh.material.transparent = true;
  const reflect = mesh.onBeforeRender;
  let mirrorEvery = 1, tick = 0;
  mesh.onBeforeRender = function (r, s, c) { if (mirrorEvery > 0 && tick++ % mirrorEvery === 0) reflect.call(this, r, s, c); };

  let acc = 0;
  return {
    mesh,
    speed,
    drop(x, z, strength) { if (Math.abs(x - CX) < SIM / 2 && Math.abs(z - CZ) < SIM / 2 && queue.length < 400) queue.push([x, z, strength]); },
    advance(dt) {
      acc += dt;
      for (let n = 0; acc >= step && n < 5; n++, acc -= step) stepOnce();
      if (acc > step * 5) acc = 0;
    },
    update(time, camera) {
      const u = mesh.material.uniforms;
      u.tH.value = a.texture;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      u.uBlend.value = Math.min(1, acc / step);
    },
    setBoxes(list) { sim.uniforms.uBox.value.forEach((v4, i) => { const b = list[i]; if (b) v4.set((b[0] - CX) / SIM + 0.5, (b[1] - CZ) / SIM + 0.5, b[2] / SIM, b[3] / SIM); else v4.set(0, 0, 0, 0); }); },
    setMirrorSize(w, h = w) { mesh.getRenderTarget().setSize(Math.max(64, Math.min(2048, Math.round(w))), Math.max(64, Math.min(2048, Math.round(h)))); },
    setMirrorEvery(n) { mirrorEvery = n; },
    // A coarser grid stepped less often: ripples travel at the same speed and fade the same, only a little softer.
    setDetail(newRes, rate) {
      if (newRes === res && Math.abs(1 / rate - step) < 1e-9) return;
      if (newRes !== res) {
        const a2 = new THREE.WebGLRenderTarget(newRes, newRes, rtOpts), b2 = new THREE.WebGLRenderTarget(newRes, newRes, rtOpts);
        sim.uniforms.tPrev.value = a.texture;
        pass(copy, a2);                                 // carry the ripples over
        a.dispose(); b.dispose();
        a = a2; b = b2; res = newRes;
      }
      step = 1 / rate; acc = 0;
      const u = sim.uniforms, r = Math.max(DROP0, (2.2 * SIM) / res); // a drop must stay wider than two cells
      u.uTexel.value.set(1 / res, 1 / res);
      u.uDropR.value = r / SIM;
      u.uDamp.value = Math.pow(DAMP0, RATE0 / rate);    // same fading per second
      dropGain = (DROP0 / r) ** 2;                      // a wider drop moves more water: weaken it to match
      mesh.material.uniforms.uE.value = 1 / res;
      mesh.material.uniforms.uSlope.value = (5 * res) / RES0;
    },
  };
}
