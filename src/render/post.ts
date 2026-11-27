import { HalfFloatType } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, VignetteEffect } from 'postprocessing';
import { BLOOM } from './palette';

/**
 * MSAA for the half-float scene buffer, chosen by how many pixels that buffer really has. Four samples of RGBA16F
 * plus depth is the single most expensive thing in the frame, so it is only paid up to about 1080p. Larger
 * buffers get two samples while their pixels are still big on screen, and none once the pixel ratio hides the
 * edges anyway.
 */
const MSAA_FULL_SAMPLES = 4;
const MSAA_FULL_MAX_PIXELS = 1920 * 1200;
const MSAA_LIGHT_SAMPLES = 2;
const MSAA_LIGHT_MAX_PIXEL_RATIO = 1.25;

/** `lean` is set once the renderer has had to give up resolution for frame rate: no four-sample buffer then. */
function msaaSamples(width: number, height: number, pixelRatio: number, lean: boolean): number {
  if (!lean && width * height * pixelRatio * pixelRatio <= MSAA_FULL_MAX_PIXELS) return MSAA_FULL_SAMPLES;
  return pixelRatio <= MSAA_LIGHT_MAX_PIXEL_RATIO ? MSAA_LIGHT_SAMPLES : 0;
}

export interface PostFx {
  render(dt: number): void;
  /** Call after the renderer's own size and pixel ratio have been set. `lean` asks for the cheaper buffers. */
  setSize(width: number, height: number, lean?: boolean): void;
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
    setSize(width, height, lean = false) {
      composer.multisampling = msaaSamples(width, height, renderer.getPixelRatio(), lean);
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
