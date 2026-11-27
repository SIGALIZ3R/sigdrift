import {
  AdditiveBlending,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { OrthographicCamera, Texture } from 'three';

/**
 * Full-screen layers drawn in the scene itself, just in front of the camera, so they work the same with and
 * without post-processing:
 * - a red glow round the edges of the screen, for the moment a crash is counted or the car goes over an edge;
 * - a black veil, for dimming the picture once a run is over;
 * - streaks rushing up the screen with a glitchy jitter, while the car drops off the road.
 * All are invisible, and not drawn at all, the rest of the time.
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

// Falling: thin vertical streaks scrolling up the screen (the world rushing past as the car drops), in hazard red
// with the odd cyan glitch, jumping sideways every few frames.
const STREAK_TEXTURE_WIDTH = 128;
const STREAK_TEXTURE_HEIGHT = 64;
const STREAK_CHANCE = 0.16;
const STREAK_REPEAT_X = 2.5;
const STREAK_REPEAT_Y = 1.2;
/** Screen heights per second the streaks scroll at full strength. */
const STREAK_SPEED = 2.8;
/** Seconds between sideways glitch jumps. */
const GLITCH_PERIOD = 0.06;
const STREAK_R = 1.3;
const STREAK_G = 0.16;
const STREAK_B = 0.1;
const GLITCH_R = 0.15;
const GLITCH_G = 1.1;
const GLITCH_B = 1.4;
const STREAK_CALM = 0.3;

/** Streaks: a few columns lit with a bright head and a fading tail, black elsewhere. Additive. */
function createStreakTexture(): Texture {
  const w = STREAK_TEXTURE_WIDTH;
  const h = STREAK_TEXTURE_HEIGHT;
  const data = new Uint8Array(w * h * 4);
  // Cosmetic only: a fixed little generator so the pattern is the same every run.
  let seed = 0x5eed;
  const rand = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) / 16777216;
  };
  for (let x = 0; x < w; x++) {
    if (rand() > STREAK_CHANCE) continue;
    const length = 0.25 + rand() * 0.6;
    const head = rand();
    const brightness = 0.35 + rand() * 0.65;
    for (let y = 0; y < h; y++) {
      // Distance below the head, wrapping round so the streak tiles vertically.
      let d = head - y / h;
      if (d < 0) d += 1;
      if (d > length) continue;
      const v = Math.round(255 * brightness * (1 - d / length) ** 2);
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const texture = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.repeat.set(STREAK_REPEAT_X, STREAK_REPEAT_Y);
  texture.needsUpdate = true;
  return texture;
}

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
   * (0..1) the opacity of the black veil, `fall` (0..1) the strength of the falling streaks. `dt` drives their
   * scroll; `calm` (reduced flashes) slows them, dims them and stops the glitch jumps.
   */
  update(camera: OrthographicCamera, flash: number, dim: number, fall?: number, dt?: number, calm?: boolean): void;
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
  private readonly streakTexture = createStreakTexture();
  private readonly streakMaterial = new MeshBasicMaterial({
    map: this.streakTexture,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly flash = new Mesh(this.geometry, this.flashMaterial);
  private readonly veil = new Mesh(this.geometry, this.dimMaterial);
  private readonly streaks = new Mesh(this.geometry, this.streakMaterial);
  private readonly forward = new Vector3();
  private warmUp = false;
  private glitchClock = 0;
  private glitchCyan = false;

  constructor() {
    for (const mesh of [this.veil, this.flash, this.streaks]) {
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
    }
    // Over everything, the veil first so the flash and the streaks are never dimmed by it.
    this.veil.renderOrder = 20;
    this.flash.renderOrder = 21;
    this.streaks.renderOrder = 22;
    this.flashMaterial.color.setRGB(0, 0, 0);
    this.streakMaterial.color.setRGB(0, 0, 0);
  }

  update(camera: OrthographicCamera, flash: number, dim: number, fall = 0, dt = 0, calm = false): void {
    const showFlash = flash > 0.003;
    const showVeil = dim > 0.003;
    const showStreaks = fall > 0.01;
    this.flash.visible = showFlash || this.warmUp;
    this.veil.visible = showVeil || this.warmUp;
    this.streaks.visible = showStreaks || this.warmUp;
    const glow = showFlash ? flash : 0;
    this.flashMaterial.color.setRGB(FLASH_R * glow, FLASH_G * glow, FLASH_B * glow);
    this.dimMaterial.opacity = showVeil ? Math.min(1, dim) : 0;
    this.updateStreaks(showStreaks ? Math.min(1, fall) : 0, dt, calm);
    if (!this.flash.visible && !this.veil.visible && !this.streaks.visible) return;

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
      this.streaks.visible = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.texture.dispose();
    this.streakTexture.dispose();
    this.flashMaterial.dispose();
    this.dimMaterial.dispose();
    this.streakMaterial.dispose();
  }

  /** Scrolls the streaks up, jumps them sideways now and then, and sets their colour for strength `k`. */
  private updateStreaks(k: number, dt: number, calm: boolean): void {
    if (k <= 0) {
      this.streakMaterial.color.setRGB(0, 0, 0);
      return;
    }
    const strength = calm ? k * STREAK_CALM : k;
    const offset = this.streakTexture.offset;
    // The world rushes up past a falling car: the pattern moves up the screen, i.e. its texture coordinate down.
    offset.y -= STREAK_SPEED * (calm ? 0.4 : 1) * (0.4 + 0.6 * k) * Math.max(0, dt);
    offset.y -= Math.floor(offset.y);
    this.glitchClock += Math.max(0, dt);
    if (!calm && this.glitchClock >= GLITCH_PERIOD) {
      this.glitchClock = 0;
      // Cosmetic only, so Math.random is fine.
      offset.x = Math.random();
      this.glitchCyan = Math.random() < 0.18;
    }
    if (this.glitchCyan && !calm) this.streakMaterial.color.setRGB(GLITCH_R * strength, GLITCH_G * strength, GLITCH_B * strength);
    else this.streakMaterial.color.setRGB(STREAK_R * strength, STREAK_G * strength, STREAK_B * strength);
  }
}

export function createScreenOverlay(): ScreenOverlay {
  return new Overlay();
}
