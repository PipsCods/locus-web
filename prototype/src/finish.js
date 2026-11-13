// The last steps of every picture: the scene is drawn into a wide-range buffer, bright spots get
// a soft glow, and one final pass adds the glow and maps the result to the screen's range.
// (The stock chain did the same in three full-screen passes; this does it in one.)

import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { OutputShader } from "three/addons/shaders/OutputShader.js";
import { PAINT_FRAG, paintUniforms } from "./art.js";

// The stock glow, minus its last step (laying the glow back over the picture): the final pass does that.
class Glow extends UnrealBloomPass {
  get texture() { return this.renderTargetsHorizontal[0].texture; }
  setSize(w, h) {
    super.setSize(w, h);
    if (this.lean === false) return;
    // The tightest blur and the summed-up glow are soft enough to be kept at quarter size instead of half:
    // about half the glow's cost. (Its blur still steps in half-size cells, so it is exactly as wide as before.)
    const quarter = this.renderTargetsHorizontal[1];
    this.renderTargetsHorizontal[0].setSize(quarter.width, quarter.height);
    this.renderTargetsVertical[0].setSize(quarter.width, quarter.height);
  }
  render(renderer, _unused, source) {
    const quad = this._fsQuad;
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // keep only the bright parts
    this.highPassUniforms.tDiffuse.value = source.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    quad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    quad.render(renderer);

    // blur them, smaller and wider each time
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      quad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      quad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      quad.render(renderer);
      input = this.renderTargetsVertical[i];
    }

    // and add the blurs up
    const u = this.compositeMaterial.uniforms;
    u.bloomStrength.value = this.strength;
    u.bloomRadius.value = this.radius;
    u.bloomTintColors.value = this.bloomTintColors;
    quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    quad.render(renderer);

    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = autoClear;
  }
}

export function createFinish(renderer, { samples = 4, art = null } = {}) {
  // The illustrated style draws its own contours from the scene's depth, so it keeps that as a texture
  // (and needs no edge smoothing: every edge ends up under a drawn line).
  const target = new THREE.WebGLRenderTarget(4, 4, art
    ? { type: THREE.HalfFloatType, samples: 0, depthTexture: new THREE.DepthTexture(4, 4) }
    : { type: THREE.HalfFloatType, samples });
  const glow = new Glow(new THREE.Vector2(256, 256), 0.22, 0.7, 0.9);
  const material = new THREE.RawShaderMaterial({
    name: "LocusFinish",
    defines: { ACES_FILMIC_TONE_MAPPING: "", SRGB_TRANSFER: "" },
    uniforms: { tDiffuse: { value: null }, tGlow: { value: null }, uGlow: { value: 1 }, toneMappingExposure: { value: 1 } },
    vertexShader: OutputShader.vertexShader,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform sampler2D tGlow;
      uniform float uGlow;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb + texture2D(tGlow, vUv).rgb * uGlow;
        gl_FragColor = sRGBTransferOETF(vec4(ACESFilmicToneMapping(c), 1.0));
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const paint = art && new THREE.RawShaderMaterial({
    name: "LocusPaint",
    defines: { ACES_FILMIC_TONE_MAPPING: "", SRGB_TRANSFER: "" },
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, toneMappingExposure: { value: 1 },
      uPx: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() }, uNear: { value: 0.5 }, uFar: { value: 260 },
      ...paintUniforms(art),
    },
    vertexShader: OutputShader.vertexShader,
    fragmentShader: PAINT_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(paint || material);
  const css = new THREE.Vector2();
  let glowAmount = 1;

  return {
    target,
    glow,
    setSize(w, h) { target.setSize(w, h); glow.setSize(w, h); },
    paint,
    setSamples(n) { if (!art && target.samples !== n) { target.samples = n; target.dispose(); } }, // rebuilt on the next picture
    setGlow(amount) { glowAmount = amount; }, // 0..1; at 0 the glow is not worked out at all
    render(scene, camera) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      if (paint) {
        const u = paint.uniforms;
        u.tDiffuse.value = target.texture;
        u.tDepth.value = target.depthTexture;
        u.toneMappingExposure.value = renderer.toneMappingExposure;
        u.uPx.value.set(1 / target.width, 1 / target.height);
        u.uLine.value = art.lineWeight * Math.min(1.15, Math.max(0.72, target.width / 1700)); // a finer pen on a small screen
        u.uRes.value.copy(renderer.getSize(css));
        u.uNear.value = camera.near; u.uFar.value = camera.far;
        renderer.setRenderTarget(null);
        quad.render(renderer);
        return;
      }
      const glowOn = glowAmount > 0;
      if (glowOn) glow.render(renderer, null, target);
      const u = material.uniforms;
      u.tDiffuse.value = target.texture;
      u.tGlow.value = glowOn ? glow.texture : target.texture;
      u.uGlow.value = glowAmount;
      u.toneMappingExposure.value = renderer.toneMappingExposure;
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
  };
}
