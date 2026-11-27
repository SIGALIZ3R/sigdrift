import { AmbientLight, Color, DirectionalLight, Scene, WebGLRenderer } from 'three';
import type {
  CarParams,
  CarState,
  CollisionEvent,
  GameRenderer,
  Level,
  RenderFrame,
  Settings,
} from '../types';
import { createFollowCamera } from './camera';
import { createCarVisual, wheelOffsetX, wheelOffsetZ } from './carMesh';
import { buildLevelVisual } from './levelMesh';
import type { LevelVisual } from './levelMesh';
import { BACKGROUND } from './palette';
import { createPost } from './post';
import type { PostFx } from './post';
import { ResolutionWatchdog, budgetPixelRatio } from './quality';
import { createSkidMarks } from './skid';
import { createSmoke, createSoftTexture, createSparks } from './smoke';

const MAX_PIXEL_RATIO = 2;

const SMOKE_SLIDE_THRESHOLD = 0.35;
const SMOKE_MIN_SPEED = 3;
/** Chance per rear wheel per sim tick at full slide. */
const SMOKE_SPAWN_CHANCE = 0.5;
/** Share of the car's velocity a new puff inherits. */
const SMOKE_DRIFT = 0.2;

const SPARK_MIN_IMPACT = 1.2;
const SPARK_COOLDOWN_TICKS = 6;
const SPARK_COOLDOWN_TICKS_REDUCED = 48;
const SPARK_COUNT_REDUCED = 4;
const SPARK_COUNT_MAX = 22;
const SHAKE_IMPACT_REF = 18;
const SHAKE_METRES = 0.55;

class NeonRenderer implements GameRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly follow = createFollowCamera();
  private readonly softTexture = createSoftTexture();
  private readonly car = createCarVisual(this.softTexture);
  private readonly skid = createSkidMarks();
  private readonly smoke = createSmoke(this.follow.right, this.follow.up, this.softTexture);
  private readonly sparks = createSparks();
  private level: LevelVisual | null = null;
  private post: PostFx | null = null;

  private high = false;
  private reducedFlash = false;
  private width = 1;
  private height = 1;
  private time = 0;
  private ticksSinceSparks = SPARK_COOLDOWN_TICKS_REDUCED;
  private readonly watchdog = new ResolutionWatchdog();
  /** Draw the smoke and spark meshes once, invisibly, on the next frame: see `warmUp`. */
  private warmUpPending = true;

  constructor(container: HTMLElement, settings: Settings) {
    // Antialiasing is fixed at context creation; the low-quality path draws straight to the canvas and needs it.
    this.gl = new WebGLRenderer({ antialias: true, stencil: false, powerPreference: 'high-performance' });
    this.canvas = this.gl.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);

    this.scene.background = new Color(BACKGROUND);
    this.addLights();
    this.scene.add(this.car.group, this.skid.mesh, this.smoke.mesh, this.sparks.points);

    this.width = container.clientWidth || window.innerWidth;
    this.height = container.clientHeight || window.innerHeight;
    this.applySettings(settings);
  }

  setLevel(level: Level): void {
    this.level?.dispose();
    this.level = buildLevelVisual(level);
    this.scene.add(this.level.group);
    this.clearEffects();
    this.follow.snap();
    this.warmUpPending = true;
  }

  onSimTick(car: CarState, params: CarParams, collision: CollisionEvent | null): void {
    this.skid.lay(car, params);
    if (this.high) this.emitSmoke(car, params);
    this.ticksSinceSparks++;
    if (collision) this.onCollision(collision);
  }

  clearEffects(): void {
    this.skid.clear();
    this.smoke.clear();
    this.sparks.clear();
  }

  render(frame: RenderFrame): void {
    const dt = frame.dt;
    this.time += dt;
    this.car.update(frame);
    this.level?.update(frame.run, this.time, this.reducedFlash);
    this.follow.update(frame.pose, frame.car, dt);
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.skid.flush();
    const warm = this.warmUpPending;
    if (warm) this.warmUp(true);
    if (this.post) this.post.render(dt);
    else this.gl.render(this.scene, this.follow.camera);
    if (warm) this.warmUp(false);
    if (this.watchdog.frame(dt)) this.applySize();
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    // A different window is a different load: give full resolution another chance.
    if (w !== this.width || h !== this.height) this.watchdog.reset();
    this.width = w;
    this.height = h;
    this.applySize();
  }

  applySettings(settings: Settings): void {
    this.reducedFlash = settings.reducedFlash;
    const wasHigh = this.high;
    this.high = settings.quality === 'high';
    this.smoke.setEnabled(this.high);
    if (this.high && !this.post) {
      this.post = createPost(this.gl, this.scene, this.follow.camera);
    } else if (!this.high && this.post) {
      this.post.dispose();
      this.post = null;
    }
    this.post?.setReducedFlash(this.reducedFlash);
    if (this.high !== wasHigh) {
      this.watchdog.reset();
      // Low and high quality compile different variants of every shader.
      this.warmUpPending = true;
    }
    this.applySize();
  }

  dispose(): void {
    this.level?.dispose();
    this.level = null;
    this.post?.dispose();
    this.post = null;
    this.car.dispose();
    this.skid.dispose();
    this.smoke.dispose();
    this.sparks.dispose();
    this.softTexture.dispose();
    this.gl.dispose();
    // Browsers cap the number of live WebGL contexts; give this one back now rather than at garbage collection.
    this.gl.forceContextLoss();
    this.canvas.remove();
  }

  /**
   * Sizes the drawing buffer: the device pixel ratio (high quality only), limited by the pixel budget and by
   * whatever the frame-time watchdog has taken off.
   */
  private applySize(): void {
    const wanted = this.high ? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) : 1;
    this.gl.setPixelRatio(budgetPixelRatio(this.width, this.height, wanted) * this.watchdog.scale);
    this.gl.setSize(this.width, this.height, false);
    this.post?.setSize(this.width, this.height, this.watchdog.scale < 1);
    this.follow.setAspect(this.width / this.height);
  }

  /**
   * Smoke and sparks are hidden until first used, and three only builds a program for what it draws: without
   * this, both shaders are compiled in the middle of the player's first drift and first wall hit, a hitch of
   * several dropped frames. Drawing them once through the normal path, black on additive, builds the programs
   * (and the driver's pipeline state) for the render target actually in use.
   */
  private warmUp(on: boolean): void {
    if (this.high) this.smoke.setWarmUp(on);
    this.sparks.setWarmUp(on);
    if (!on) this.warmUpPending = false;
  }

  /** The car is the only lit object; every other surface is unlit with baked shading. */
  private addLights(): void {
    const key = new DirectionalLight(0xdfe6ff, 2.6);
    key.position.set(0.5, 1, 0.35);
    this.scene.add(new AmbientLight(0x9aa6d8, 1.1), key);
  }

  private emitSmoke(car: CarState, params: CarParams): void {
    if (car.rearSlide < SMOKE_SLIDE_THRESHOLD || car.speed < SMOKE_MIN_SPEED) return;
    const intensity = (car.rearSlide - SMOKE_SLIDE_THRESHOLD) / (1 - SMOKE_SLIDE_THRESHOLD);
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    for (let w = 2; w < 4; w++) {
      if (Math.random() > intensity * SMOKE_SPAWN_CHANCE) continue;
      const lx = wheelOffsetX(params, w);
      const lz = wheelOffsetZ(params, w);
      this.smoke.spawn(
        car.x + lx * cos - lz * sin,
        car.z + lx * sin + lz * cos,
        car.vx * SMOKE_DRIFT,
        car.vz * SMOKE_DRIFT,
        intensity,
      );
    }
  }

  private onCollision(hit: CollisionEvent): void {
    const cooldown = this.reducedFlash ? SPARK_COOLDOWN_TICKS_REDUCED : SPARK_COOLDOWN_TICKS;
    if (hit.impact < SPARK_MIN_IMPACT || this.ticksSinceSparks < cooldown) return;
    this.ticksSinceSparks = 0;
    const count = this.reducedFlash ? SPARK_COUNT_REDUCED : Math.min(SPARK_COUNT_MAX, 6 + Math.floor(hit.impact * 1.2));
    this.sparks.burst(hit.x, hit.z, hit.nx, hit.nz, hit.impact, count);
    if (!this.reducedFlash) this.follow.addShake(Math.min(1, hit.impact / SHAKE_IMPACT_REF) * SHAKE_METRES);
  }
}

export function createRenderer(container: HTMLElement, settings: Settings): GameRenderer {
  return new NeonRenderer(container, settings);
}
