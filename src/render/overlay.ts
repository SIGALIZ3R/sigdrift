import {
  AdditiveBlending,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { OrthographicCamera, Texture } from 'three';

/**
 * Two full-screen layers drawn in the scene itself, just in front of the camera, so they work the same with and
 * without post-processing:
 * - a red glow round the edges of the screen, for the moment a crash is counted;
 * - a black veil, for dimming the picture once a run is over.
 * Both are invisible, and not drawn at all, the rest of the time.
 */

const EDGE_TEXTURE_SIZE = 64;
/** The glow starts this far from the centre of the screen (0) towards its corners (1.41). */
const EDGE_START = 0.5;
const EDGE_FULL = 1.25;
/** Metres in front of the camera: inside its near plane's reach, far in front of everything in the world. */
const OVERLAY_DISTANCE = 6;
/** Slightly larger than the view, so screen shake never shows an edge. */
const OVERSCAN = 1.04;

const FLASH_R = 1.0;
const FLASH_G = 0.06;
const FLASH_B = 0.12;

/** White texture whose alpha rises from nothing in the middle to full at the corners. */
function createEdgeTexture(): Texture {
  const size = EDGE_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const t = Math.min(1, Math.max(0, (Math.sqrt(u * u + v * v) - EDGE_START) / (EDGE_FULL - EDGE_START)));
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface ScreenOverlay {
  readonly group: Group;
  /**
   * Call once per frame after the camera has moved. `flash` (0..1) is the strength of the red edge glow, `dim`
   * (0..1) the opacity of the black veil.
   */
  update(camera: OrthographicCamera, flash: number, dim: number): void;
  /** While on, both layers are drawn with no visible effect, so their shaders exist before they are needed. */
  setWarmUp(on: boolean): void;
  dispose(): void;
}

class Overlay implements ScreenOverlay {
  readonly group = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly texture = createEdgeTexture();
  private readonly flashMaterial = new MeshBasicMaterial({
    map: this.texture,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly dimMaterial = new MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  private readonly flash = new Mesh(this.geometry, this.flashMaterial);
  private readonly veil = new Mesh(this.geometry, this.dimMaterial);
  private readonly forward = new Vector3();
  private warmUp = false;

  constructor() {
    for (const mesh of [this.veil, this.flash]) {
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
    }
    // Over everything, the veil first so the flash is never dimmed by it.
    this.veil.renderOrder = 20;
    this.flash.renderOrder = 21;
    this.flashMaterial.color.setRGB(0, 0, 0);
  }

  update(camera: OrthographicCamera, flash: number, dim: number): void {
    const showFlash = flash > 0.003;
    const showVeil = dim > 0.003;
    this.flash.visible = showFlash || this.warmUp;
    this.veil.visible = showVeil || this.warmUp;
    const glow = showFlash ? flash : 0;
    this.flashMaterial.color.setRGB(FLASH_R * glow, FLASH_G * glow, FLASH_B * glow);
    this.dimMaterial.opacity = showVeil ? Math.min(1, dim) : 0;
    if (!this.flash.visible && !this.veil.visible) return;

    // The group takes the camera's place and turn, then sits a little way down its line of sight.
    const group = this.group;
    group.quaternion.copy(camera.quaternion);
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    group.position.copy(camera.position).addScaledVector(this.forward, OVERLAY_DISTANCE);
    group.scale.set((camera.right - camera.left) * OVERSCAN, (camera.top - camera.bottom) * OVERSCAN, 1);
  }

  setWarmUp(on: boolean): void {
    this.warmUp = on;
    // Black on additive and a veil of no opacity: drawn, and so compiled, without showing. The next `update`
    // puts the visibility back to what the game asks for.
    if (on) {
      this.flash.visible = true;
      this.veil.visible = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.texture.dispose();
    this.flashMaterial.dispose();
    this.dimMaterial.dispose();
  }
}

export function createScreenOverlay(): ScreenOverlay {
  return new Overlay();
}
