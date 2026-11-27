import { HalfFloatType } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, VignetteEffect } from 'postprocessing';
import { BLOOM } from './palette';

/** MSAA for the scene buffer when pixels are large; at a device pixel ratio near 2 the edges are fine without. */
const MSAA_SAMPLES = 4;
const MSAA_MAX_PIXEL_RATIO = 1.5;

export interface PostFx {
  render(dt: number): void;
  /** Call after the renderer's own size and pixel ratio have been set. */
  setSize(width: number, height: number): void;
  setReducedFlash(reduced: boolean): void;
  dispose(): void;
}

/** The high-quality path: scene into a half-float buffer, then bloom and a vignette in one pass. */
export function createPost(renderer: WebGLRenderer, scene: Scene, camera: Camera): PostFx {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType });
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: BLOOM.threshold,
    luminanceSmoothing: BLOOM.smoothing,
    radius: BLOOM.radius,
    intensity: BLOOM.intensity,
  });
  const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new EffectPass(camera, bloom, vignette));

  return {
    render(dt) {
      composer.render(dt);
    },
    setSize(width, height) {
      composer.multisampling = renderer.getPixelRatio() > MSAA_MAX_PIXEL_RATIO ? 0 : MSAA_SAMPLES;
      composer.setSize(width, height, false);
    },
    setReducedFlash(reduced) {
      bloom.intensity = reduced ? BLOOM.intensityReduced : BLOOM.intensity;
    },
    dispose() {
      composer.dispose();
      // The composer switched this off when it took over; direct rendering needs it back.
      renderer.autoClear = true;
    },
  };
}
