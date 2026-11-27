import { AmbientLight, Color, DirectionalLight, Scene, WebGLRenderer } from 'three';
import type {
  CarParams,
  CarState,
  CollisionEvent,
  EndlessState,
  GameRenderer,
  Level,
  RenderFrame,
  Settings,
  TrackChunk,
} from '../types';
import { createFollowCamera } from './camera';
import { WHEEL_COUNT, createCarVisual, wheelOffsetX, wheelOffsetZ } from './carMesh';
import { createEndlessVisual } from './endlessMesh';
import { buildLevelVisual } from './levelMesh';
import type { LevelVisual } from './levelMesh';
import { createScreenOverlay } from './overlay';
import { BACKGROUND } from './palette';
import { createPost } from './post';
import type { PostFx } from './post';
import { ResolutionWatchdog, budgetPixelRatio } from './quality';
import { createTrackShared } from './roadPiece';
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

// Landing after a jump: dust from the tyres, a few sparks from under the car and a small kick of the camera.
/** A landing at this vertical speed, m/s, gets the full effect. */
const LANDING_VY_REF = 9;
/** Slower touchdowns than this share of it are not worth marking. */
const LANDING_MIN = 0.08;
const LANDING_PUFFS_MIN = 4;
const LANDING_PUFFS_EXTRA = 9;
const LANDING_PUFF_SPEED = 3.2;
const LANDING_SPARKS_MIN = 3;
const LANDING_SPARKS_EXTRA = 7;
const LANDING_KICK_MIN = 0.1;
const LANDING_KICK_EXTRA = 0.28;

// A counted crash: the car and the edges of the screen flash red, then fade.
const CRASH_FLASH_DECAY = 5;
/** Strength of the red at the edges of the screen at the peak of the flash. */
const CRASH_VIGNETTE = 0.8;
/** With reduced flashes on, everything about the flash is scaled by this. */
const CRASH_REDUCED = 0.3;
/** Dying without a crash (landing off the road) still gets a flash, a little weaker. */
const DEATH_FLASH = 0.8;

// A run that is over: the picture dims and loses colour, slowly enough not to be a flash itself.
const DEAD_DIM = 0.3;
const DEAD_DIM_REDUCED = 0.18;
const DEAD_SATURATION = -0.6;
const DEAD_SATURATION_REDUCED = -0.3;
const DEAD_RATE = 3;
const REVIVE_RATE = 9;
/** Below this the flash and the dimming count as finished and cost nothing more. */
const FEEDBACK_EPSILON = 0.004;

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
  private readonly overlay = createScreenOverlay();
  /** Materials shared by the weekly level and every chunk of endless road. */
  private readonly shared = createTrackShared();
  /** The endless road. Empty and hidden while a weekly level is on show; also the height of the ground. */
  private readonly track = createEndlessVisual(this.shared);
  private level: LevelVisual | null = null;
  private post: PostFx | null = null;

  private high = false;
  private reducedFlash = false;
  private width = 1;
  private height = 1;
  private time = 0;
  private ticksSinceSparks = SPARK_COOLDOWN_TICKS_REDUCED;
  private wasAirborne = false;
  /** Vertical speed on the last tick the car was in the air: how hard it then lands. */
  private airVy = 0;
  /** Crash flash, 1 at the moment of impact and fading to 0. */
  private flash = 0;
  private seenCrashTick = -1;
  private wasDead = false;
  /** 0..1, how far the picture has dimmed for a run that is over. */
  private dim = 0;
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
    this.scene.add(this.track.group, this.car.group, this.skid.mesh, this.smoke.mesh, this.sparks.points);
    this.scene.add(this.overlay.group);

    this.width = container.clientWidth || window.innerWidth;
    this.height = container.clientHeight || window.innerHeight;
    this.applySettings(settings);
  }

  setLevel(level: Level): void {
    this.track.clear();
    this.level?.dispose();
    this.level = buildLevelVisual(level, this.shared);
    this.scene.add(this.level.group);
    this.resetView();
  }

  beginEndless(): void {
    this.level?.dispose();
    this.level = null;
    this.track.clear();
    this.track.begin();
    this.resetView();
  }

  addChunk(chunk: TrackChunk): void {
    // Chunks and a weekly level never share the scene, whatever order the calls come in.
    if (this.level) this.beginEndless();
    this.track.begin();
    this.track.addChunk(chunk);
  }

  removeChunk(index: number): void {
    this.track.removeChunk(index);
  }

  onSimTick(car: CarState, params: CarParams, collision: CollisionEvent | null): void {
    const airborne = car.airborne === true;
    if (airborne) this.airVy = car.vy || 0;
    else if (this.wasAirborne) this.onLanding(car, params);
    this.wasAirborne = airborne;

    this.skid.lay(car, params, this.track);
    if (this.high && !airborne) this.emitSmoke(car, params);
    this.ticksSinceSparks++;
    if (collision) this.onCollision(collision);
  }

  clearEffects(): void {
    this.skid.clear();
    this.smoke.clear();
    this.sparks.clear();
    this.wasAirborne = false;
    this.flash = 0;
  }

  render(frame: RenderFrame): void {
    const dt = frame.dt;
    this.time += dt;
    const endless = frame.endless ?? null;
    const dead = endless !== null && endless.phase === 'dead';
    this.updateFeedback(endless, dead, dt);
    const calm = this.reducedFlash;
    const flash = this.flash * (calm ? CRASH_REDUCED : 1);

    this.car.update(frame, this.track, flash);
    if (frame.run) this.level?.update(frame.run, this.time, calm);
    this.track.update(frame.pose.x, frame.pose.z);
    // A car that flies off the road must not vanish behind the scenery, nor lie wrecked inside it unseen.
    const offRoad = endless !== null && endless.deathCause === 'offTrack';
    this.track.seeThrough(frame.pose.x, frame.height, frame.pose.z, frame.car.airborne === true || offRoad, dt);
    // Ground plane only: a jump moves the car up the screen, never the camera. No look-ahead once the run is over.
    this.follow.update(frame.pose, frame.car, dt, !dead);
    this.overlay.update(this.follow.camera, flash * CRASH_VIGNETTE, this.dim * (calm ? DEAD_DIM_REDUCED : DEAD_DIM));
    this.post?.setSaturation(this.dim * (calm ? DEAD_SATURATION_REDUCED : DEAD_SATURATION));
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
    this.track.dispose();
    this.shared.dispose();
    this.overlay.dispose();
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
    this.overlay.setWarmUp(on);
    if (!on) this.warmUpPending = false;
  }

  /** Common to a new level and a new endless run: nothing left over from what was on screen before. */
  private resetView(): void {
    this.clearEffects();
    this.follow.snap();
    this.warmUpPending = true;
    this.seenCrashTick = -1;
    this.wasDead = false;
    this.dim = 0;
  }

  /** Advances the crash flash and the end-of-run dimming from the endless state (null in a weekly run). */
  private updateFeedback(endless: EndlessState | null, dead: boolean, dt: number): void {
    const crashTick = endless ? endless.lastCrashTick : -1;
    if (crashTick !== this.seenCrashTick) {
      // Going back to -1 is a restart, not a crash.
      if (crashTick >= 0) this.flash = 1;
      this.seenCrashTick = crashTick;
    }
    if (dead && !this.wasDead) this.flash = Math.max(this.flash, DEATH_FLASH);
    this.wasDead = dead;

    this.flash *= Math.exp(-CRASH_FLASH_DECAY * dt);
    if (this.flash < FEEDBACK_EPSILON) this.flash = 0;
    const target = dead ? 1 : 0;
    this.dim += (target - this.dim) * (1 - Math.exp(-(dead ? DEAD_RATE : REVIVE_RATE) * dt));
    if (!dead && this.dim < FEEDBACK_EPSILON) this.dim = 0;
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
        this.track.heightAt(car.x, car.z),
      );
    }
  }

  /** The tick the wheels come back down: dust thrown out from each tyre, sparks from under the sills, a kick. */
  private onLanding(car: CarState, params: CarParams): void {
    const impact = Math.min(1, Math.abs(this.airVy) / LANDING_VY_REF);
    if (impact < LANDING_MIN) return;
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    const groundY = this.track.heightAt(car.x, car.z);

    const puffs = LANDING_PUFFS_MIN + Math.round(impact * LANDING_PUFFS_EXTRA);
    for (let i = 0; i < puffs; i++) {
      const wheel = i % WHEEL_COUNT;
      const lx = wheelOffsetX(params, wheel);
      const lz = wheelOffsetZ(params, wheel);
      // Outwards from the middle of the car, in world axes.
      const ox = lx * cos - lz * sin;
      const oz = lx * sin + lz * cos;
      const speed = (LANDING_PUFF_SPEED * (0.5 + Math.random())) / (Math.sqrt(ox * ox + oz * oz) || 1);
      this.smoke.spawn(
        car.x + ox,
        car.z + oz,
        car.vx * SMOKE_DRIFT + ox * speed,
        car.vz * SMOKE_DRIFT + oz * speed,
        0.5 + 0.5 * impact,
        groundY,
      );
    }
    if (this.reducedFlash) return;
    const sparks = LANDING_SPARKS_MIN + Math.round(impact * LANDING_SPARKS_EXTRA);
    const force = 4 + impact * 8;
    // One burst to each side: the car's right is (-sin, cos).
    this.sparks.burst(car.x, car.z, -sin, cos, force, sparks, groundY);
    this.sparks.burst(car.x, car.z, sin, -cos, force, sparks, groundY);
    this.follow.addShake(LANDING_KICK_MIN + impact * LANDING_KICK_EXTRA);
  }

  private onCollision(hit: CollisionEvent): void {
    const cooldown = this.reducedFlash ? SPARK_COOLDOWN_TICKS_REDUCED : SPARK_COOLDOWN_TICKS;
    if (hit.impact < SPARK_MIN_IMPACT || this.ticksSinceSparks < cooldown) return;
    this.ticksSinceSparks = 0;
    const count = this.reducedFlash ? SPARK_COUNT_REDUCED : Math.min(SPARK_COUNT_MAX, 6 + Math.floor(hit.impact * 1.2));
    this.sparks.burst(hit.x, hit.z, hit.nx, hit.nz, hit.impact, count, this.track.heightAt(hit.x, hit.z));
    if (!this.reducedFlash) this.follow.addShake(Math.min(1, hit.impact / SHAKE_IMPACT_REF) * SHAKE_METRES);
  }
}

export function createRenderer(container: HTMLElement, settings: Settings): GameRenderer {
  return new NeonRenderer(container, settings);
}
