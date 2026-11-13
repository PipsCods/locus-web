// Hero: the lotus is the only light source on a black page.
// A full-size WebGL layer draws five beams (one per petal), a soft glow, a floor
// reflection and a dot grid that only shows where the light falls. Hovering a
// petal raises the brightness: outer petals a little, the centre petal the most.

const LEVEL = [0.6, 0.8, 1, 0.8, 0.6]; // brightness per petal, outer → centre → outer
const IDLE = 0.45;

const VERT = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";

const FRAG = `
precision highp float;
uniform vec2 uRes;    // buffer size, px
uniform vec2 uO;      // light origin (where the petals meet), px from top-left
uniform float uU;     // px per lotus unit
uniform float uDpr;
uniform float uLum;   // overall brightness 0..1
uniform float uP[5];  // extra brightness of each petal 0..1
uniform float uTime;

const vec3 PINK  = vec3(0.914, 0.627, 0.714);
const vec3 ROSE  = vec3(0.930, 0.500, 0.630);   // pink, deepened so thin light still reads as pink
const vec3 BLUSH = vec3(0.953, 0.784, 0.831);
const vec3 GREEN = vec3(0.153, 0.341, 0.278);
const vec3 BG    = vec3(0.020, 0.027, 0.024);
const float BASE = 25.2;  // the flat baseline sits this far above the origin

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

float ray(vec2 p, float a, float w, float len, float I, float seed){
  float r = length(p);
  float d = atan(p.x, p.y) - a;                       // angle from this petal's axis
  float soft = exp(-(d * d) / (w * w));               // wide haze
  float lines = 0.0;                                  // fine beams inside the haze
  for (int k = 0; k < 5; k++) {
    float fk = float(k) - 2.0;
    float dk = d - fk * w * 0.62;
    lines += exp(-(dk * dk) / 0.00003) * (1.0 - 0.24 * abs(fk));
  }
  float fall = exp(-r / (len * (0.45 + 0.55 * I)));
  float shimmer = 0.93 + 0.07 * sin(uTime * 0.9 + seed * 6.283 + r * 0.012);
  return pow(I, 0.7) * fall * (soft * 0.62 + lines * 0.5 * smoothstep(60.0, 220.0, r)) * shimmer;
}

float light(vec2 p){
  float L = 0.0;
  L += ray(p, -1.0996, 0.100, 520.0, uLum * 0.50 + uP[0] * 0.8, 0.13);
  L += ray(p, -0.5411, 0.115, 700.0, uLum * 0.72 + uP[1] * 0.8, 0.37);
  L += ray(p,  0.0,    0.130, 900.0, uLum * 1.00 + uP[2] * 0.8, 0.51);
  L += ray(p,  0.5411, 0.115, 700.0, uLum * 0.72 + uP[3] * 0.8, 0.71);
  L += ray(p,  1.0996, 0.100, 520.0, uLum * 0.50 + uP[4] * 0.8, 0.89);
  return L;
}

float blob(vec2 p, vec2 c, float s){ vec2 d = p - c; return exp(-dot(d, d) / (2.0 * s * s)); }

void main(){
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = (fc - uO) / uU;
  p.y = -p.y;                                // lotus units, y up, origin where petals meet
  float yb = p.y - BASE;                     // height above the baseline
  float above = smoothstep(-1.0, 5.0, yb);

  float L = light(p) * above;
  float R = light(vec2(p.x, 2.0 * BASE - p.y)) * (1.0 - above) * 0.26 * exp(yb / 110.0);

  vec2 heart = vec2(0.0, BASE + 95.0);
  float core = blob(p, heart, 125.0) * (0.10 + 0.55 * uLum);
  float wide = blob(p, heart, 470.0) * (0.06 + 0.34 * uLum);
  float bloom = uP[0] * blob(p, vec2(-134.0, BASE + 40.0), 52.0)
              + uP[1] * blob(p, vec2( -90.0, BASE + 92.0), 60.0)
              + uP[2] * blob(p, vec2(   0.0, BASE + 112.0), 70.0)
              + uP[3] * blob(p, vec2(  90.0, BASE + 92.0), 60.0)
              + uP[4] * blob(p, vec2( 134.0, BASE + 40.0), 52.0);
  float floorLine = exp(-(yb * yb) / 1.4) * exp(-abs(p.x) / (240.0 + 560.0 * uLum)) * (0.22 + 0.78 * uLum);

  // dot grid, in CSS px, centred on the lotus: it is lit by whatever light reaches it
  vec2 cell = fract((fc - uO) / uDpr / 26.0 + 0.5) - 0.5;
  float dotMask = smoothstep(1.5, 0.6, length(cell) * 26.0);
  float lit = L + R * 1.6 + core * 0.8 + wide * 0.75 + bloom * 0.5;

  vec3 glow = ROSE * (L * 0.46 + R * 0.6) + PINK * (core * 0.50 + bloom * 0.42);
  glow += GREEN * (wide * 0.85 + L * 0.45 * smoothstep(140.0, 620.0, length(p)));
  glow += mix(GREEN * 1.9, PINK, clamp(lit * 1.25, 0.0, 1.0)) * dotMask * (0.045 + lit * 1.15);
  glow += BLUSH * floorLine * 0.85;
  vec3 col = BG + (1.0 - exp(-glow * 1.9));  // lifts the resting state, keeps full brightness from blowing out
  col += (hash(fc) - 0.5) / 170.0;           // dither against banding
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function initHero() {
  const hero = document.querySelector(".hero");
  if (!hero) return;
  const canvas = hero.querySelector(".hero__light");
  const svg = hero.querySelector(".lotus");
  const petals = [...svg.querySelectorAll(".petals path")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // highlight copies + generous hit areas, cloned from the logo paths
  const hots = petals.map((p) => svg.querySelector(".hots").appendChild(p.cloneNode()));
  const hits = petals.map((p) => svg.querySelector(".hits").appendChild(p.cloneNode()));

  let hover = -1;
  let release = 0;
  hits.forEach((h, i) => {
    const on = () => { clearTimeout(release); hover = i; };
    h.addEventListener("pointerenter", on);
    h.addEventListener("pointerdown", on);
    h.addEventListener("pointerleave", (e) => {
      if (hover !== i) return;
      if (e.pointerType === "mouse") hover = -1;
      else release = setTimeout(() => { hover = -1; }, 1400); // keep a tap lit for a moment
    });
  });

  // ── WebGL light layer ──
  let gl = null, U = null;
  try {
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("no webgl");
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    U = Object.fromEntries(["uRes", "uO", "uU", "uDpr", "uLum", "uP", "uTime"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  } catch (err) {
    console.warn("locus hero: WebGL unavailable, using the static fallback.", err);
    gl = null;
    hero.classList.add("no-gl");
  }

  const geo = { ox: 0, oy: 0, u: 1, dpr: 1 };
  function measure() {
    const hr = hero.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const s = sr.width / 380; // CSS px per lotus unit (viewBox is 380 wide)
    geo.u = s;
    geo.ox = sr.left - hr.left + 190 * s;
    geo.oy = sr.top - hr.top + (226 + 25.2) * s;
    geo.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (!gl) return;
    const w = Math.max(1, Math.round(hr.width * geo.dpr));
    const h = Math.max(1, Math.round(hr.height * geo.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  new ResizeObserver(measure).observe(hero);
  document.fonts?.ready.then(measure);
  measure();

  let lum = 0;
  const p = new Float32Array(5);
  let last = performance.now();
  const t0 = last;
  let running = true;

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - t0) / 1000;

    const breathe = reduce ? 0 : Math.sin(t * 0.9) * 0.035;
    const target = hover >= 0 ? LEVEL[hover] : IDLE + breathe;
    const speed = hover >= 0 ? 7 : t < 2.4 ? 1.5 : 3;
    lum += (target - lum) * (1 - Math.exp(-dt * speed));
    for (let i = 0; i < 5; i++) {
      const near = hover >= 0 && Math.abs(i - hover) === 1;
      const pt = i === hover ? 1 : hover === 2 ? 0.35 : near ? 0.12 : 0;
      p[i] += (pt - p[i]) * (1 - Math.exp(-dt * 9));
      hots[i].style.opacity = p[i].toFixed(3);
    }
    hero.style.setProperty("--lum", lum.toFixed(3));

    if (gl) {
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform2f(U.uO, geo.ox * geo.dpr, geo.oy * geo.dpr);
      gl.uniform1f(U.uU, geo.u * geo.dpr);
      gl.uniform1f(U.uDpr, geo.dpr);
      gl.uniform1f(U.uLum, lum);
      gl.uniform1fv(U.uP, p);
      gl.uniform1f(U.uTime, reduce ? 0 : t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  }

  new IntersectionObserver(([e]) => {
    const was = running;
    running = e.isIntersecting;
    if (running && !was) { last = performance.now(); requestAnimationFrame(frame); }
  }).observe(hero);
  requestAnimationFrame(frame);

  // handy for checking states from the console or automated tests
  window.__locusHero = { set: (i) => { hover = i; } };
  const forced = new URLSearchParams(location.search).get("petal"); // e.g. ?petal=2 keeps the centre petal lit
  if (forced !== null) hover = Number(forced);
}
