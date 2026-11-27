import { AmbientLight, Color, DirectionalLight, Scene, WebGLRenderer } from 'three';
import { TERRAIN_Y } from '../types';
import type {
  CarParams,
  CarState,
  CollisionEvent,
  GameRenderer,
  Level,
  RenderFrame,
  ScoreState,
  Settings,
  TrackChunk,
} from '../types';
import { createFollowCamera } from './camera';
import { WHEEL_COUNT, createCarVisual, wheelOffsetX, wheelOffsetZ } from './carMesh';
import { createEndlessVisual } from './endlessMesh';
import { buildLevelVisual } from './levelMesh';
import type { LevelVisual } from './levelMesh';
import { createScreenOverlay } from './overlay';
import { BACKGROUND, proximityTint } from './palette';
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

// Going over an edge: a red flash, and streaks rushing up the screen while the car drops.
const FALL_FLASH_DECAY = 2.2;
/** The car counts as dropping once it is this far below the road it was last on, falling at least this fast. */
const FALL_DEPTH = 1;
const FALL_SPEED = 2;
const FALL_STREAK_RISE = 10;
const FALL_STREAK_DECAY = 2.5;
/**
 * The view follows the road the car is on, not the car: once the car drops off the road it sinks only this far
 * after it, so the drop reads as a drop and the camera never dives into the city floor, m.
 */
const FALL_CAMERA_LAG = 2.5;

// Drifting close to a wall: sparks streaming off the side of the car nearest the wall.
/** Proximity (0..1) above which the sparks start. */
const PROXIMITY_MIN = 0.5;
/** Sparks per second at the threshold and when brushing the wall. */
const PROXIMITY_RATE_MIN = 18;
const PROXIMITY_RATE_MAX = 110;
const PROXIMITY_RATE_REDUCED = 0.3;
const PROXIMITY_MAX_PER_FRAME = 10;

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
  /** The endless road. Empty and hidden while a fixed level is on show. */
  private readonly track = createEndlessVisual(this.shared);
  /** Every road on show (level or chunks): how high the road is under any point. */
  private readonly surface = this.shared.surface;
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
  /** Red flash for going over an edge, 1 at the moment it is counted and fading to 0. */
  private fallFlash = 0;
  /** Strength of the falling streaks, eased. */
  private fallStreaks = 0;
  private seenFallTick = -1;
  /** Height of the road the car was last on: what the camera follows. NaN until the first frame. */
  private trackY = Number.NaN;
  /** Height of the car on the last sim tick, for the effects laid at sim rate. */
  private simCarY = 0;
  /** Proximity sparks owed but not yet thrown (fractions carry over between frames). */
  private proximityDue = 0;
  private readonly proximityColor = new Color();
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
    this.simCarY = car.y || 0;
    if (airborne) this.airVy = car.vy || 0;
    else if (this.wasAirborne) this.onLanding(car, params);
    this.wasAirborne = airborne;

    this.skid.lay(car, params, this.surface);
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
    this.proximityDue = 0;
  }

  render(frame: RenderFrame): void {
    const dt = frame.dt;
    this.time += dt;
    const endless = frame.endless ?? null;
    const dead = endless !== null && endless.phase === 'dead';
    const trackY = this.followTrack(frame);
    this.updateFeedback(frame, dead, trackY, dt);
    const calm = this.reducedFlash;
    const flash = Math.max(this.flash, this.fallFlash) * (calm ? CRASH_REDUCED : 1);
    const { pose } = frame;
    const carY = frame.height || 0;

    this.car.update(frame, this.surface, this.flash * (calm ? CRASH_REDUCED : 1));
    if (frame.run) this.level?.update(frame.run, this.time, calm);
    this.track.update(pose.x, pose.z);
    // The car must never vanish behind a bridge, a raised stretch of road or a building.
    this.shared.fader.update(pose.x, carY, pose.z, dt);
    this.shared.sinker.update(pose.x, carY, pose.z, dt);
    // The view follows the road the car is on: a jump or a drop moves the car on screen, not the camera.
    this.follow.update(pose, frame.car, dt, !dead, trackY);
    const score = frame.run ? frame.run.score : endless ? endless.score : null;
    if (score) this.emitProximitySparks(frame, score, dt);
    this.overlay.update(
      this.follow.camera,
      flash * CRASH_VIGNETTE,
      this.dim * (calm ? DEAD_DIM_REDUCED : DEAD_DIM),
      this.fallStreaks,
      dt,
      calm,
    );
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
    this.seenFallTick = -1;
    this.wasDead = false;
    this.dim = 0;
    this.fallFlash = 0;
    this.fallStreaks = 0;
    this.trackY = Number.NaN;
  }

  /**
   * Height the camera follows: the road the car is on. While the car is in the air above it (a jump) the view
   * holds; once the car drops below it (off an edge) the view sinks only FALL_CAMERA_LAG after it.
   */
  private followTrack(frame: RenderFrame): number {
    const h = frame.height || 0;
    if (!Number.isFinite(this.trackY)) this.trackY = Math.max(h, 0);
    const onRoad = frame.car.airborne !== true && h > TERRAIN_Y + 0.5;
    if (onRoad) {
      this.trackY = h;
      return h;
    }
    return h >= this.trackY ? this.trackY : Math.max(h, this.trackY - FALL_CAMERA_LAG);
  }

  /** Advances the crash and fall flashes, the falling streaks and the end-of-run dimming. */
  private updateFeedback(frame: RenderFrame, dead: boolean, trackY: number, dt: number): void {
    const endless = frame.endless ?? null;
    const run = frame.run ?? null;
    const crashTick = endless ? endless.lastCrashTick : -1;
    if (crashTick !== this.seenCrashTick) {
      // Going back to -1 is a restart, not a crash.
      if (crashTick >= 0) this.flash = 1;
      this.seenCrashTick = crashTick;
    }
    const fallTick = run ? run.lastFallTick : -1;
    if (fallTick !== this.seenFallTick) {
      if (fallTick >= 0) this.fallFlash = 1;
      this.seenFallTick = fallTick;
    }
    if (dead && !this.wasDead) {
      this.flash = Math.max(this.flash, DEATH_FLASH);
      if (endless && endless.deathCause === 'offTrack') this.fallFlash = 1;
    }
    this.wasDead = dead;

    this.flash *= Math.exp(-CRASH_FLASH_DECAY * dt);
    if (this.flash < FEEDBACK_EPSILON) this.flash = 0;
    this.fallFlash *= Math.exp(-FALL_FLASH_DECAY * dt);
    if (this.fallFlash < FEEDBACK_EPSILON) this.fallFlash = 0;

    // Streaks while the car is visibly dropping below the road, and for a moment after a counted fall.
    const car = frame.car;
    const h = frame.height || 0;
    const dropping =
      (car.airborne === true && h < this.trackY - FALL_DEPTH && (car.vy || 0) < -FALL_SPEED) ||
      (run !== null && run.respawnInTicks > 0 && h < trackY - FALL_DEPTH);
    const streakTarget = Math.max(dropping ? 1 : 0, this.fallFlash * 0.8);
    const rate = streakTarget > this.fallStreaks ? FALL_STREAK_RISE : FALL_STREAK_DECAY;
    this.fallStreaks += (streakTarget - this.fallStreaks) * (1 - Math.exp(-rate * dt));
    if (this.fallStreaks < FEEDBACK_EPSILON) this.fallStreaks = 0;

    const target = dead ? 1 : 0;
    this.dim += (target - this.dim) * (1 - Math.exp(-(dead ? DEAD_RATE : REVIVE_RATE) * dt));
    if (!dead && this.dim < FEEDBACK_EPSILON) this.dim = 0;
  }

  /**
   * The reward for drifting close to a wall: sparks streaming off the side of the car nearest the road edge, more
   * of them the closer it is, tinted cyan to magenta to amber as the multiplier climbs.
   */
  private emitProximitySparks(frame: RenderFrame, score: ScoreState, dt: number): void {
    const car = frame.car;
    if (!score.drifting || !(score.proximity > PROXIMITY_MIN) || car.airborne === true || !(dt > 0)) {
      this.proximityDue = 0;
      return;
    }
    const closeness = Math.min(1, (score.proximity - PROXIMITY_MIN) / (1 - PROXIMITY_MIN));
    const rate =
      (PROXIMITY_RATE_MIN + (PROXIMITY_RATE_MAX - PROXIMITY_RATE_MIN) * closeness) *
      (this.reducedFlash ? PROXIMITY_RATE_REDUCED : 1);
    this.proximityDue = Math.min(PROXIMITY_MAX_PER_FRAME, this.proximityDue + rate * dt);
    if (this.proximityDue < 1) return;

    const { pose, params } = frame;
    const carY = frame.height || 0;
    const surface = this.surface;
    surface.heightAt(pose.x, pose.z, carY);
    const road = surface.hit;
    if (!road) return;
    // Towards the nearer road edge, where the walls are: the road's right is (-dirZ, dirX).
    const side = road.lateral >= 0 ? 1 : -1;
    const nx = -road.dirZ * side;
    const nz = road.dirX * side;
    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);
    const color = proximityTint(score.multiplier, this.proximityColor);
    while (this.proximityDue >= 1) {
      this.proximityDue -= 1;
      // Cosmetic only, so Math.random is fine. Mostly from the rear half, where the tail swings out.
      const along = -params.cgToRear + Math.random() * (params.cgToRear + params.cgToFront * 0.5);
      const out = params.halfWidth * 0.95;
      const x = pose.x + cos * along + nx * out;
      const z = pose.z + sin * along + nz * out;
      const push = 1.5 + Math.random() * 3.5;
      this.sparks.emit(
        x,
        carY + 0.2 + Math.random() * 0.4,
        z,
        -car.vx * 0.3 + nx * push + (Math.random() - 0.5) * 2,
        1.2 + Math.random() * 3.2,
        -car.vz * 0.3 + nz * push + (Math.random() - 0.5) * 2,
        0.22 + Math.random() * 0.3,
        carY + 0.04,
        color,
      );
    }
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
        this.surface.heightAt(car.x, car.z, car.y || 0),
      );
    }
  }

  /** The tick the wheels come back down: dust thrown out from each tyre, sparks from under the sills, a kick. */
  private onLanding(car: CarState, params: CarParams): void {
    const impact = Math.min(1, Math.abs(this.airVy) / LANDING_VY_REF);
    if (impact < LANDING_MIN) return;
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    const groundY = this.surface.heightAt(car.x, car.z, car.y || 0);

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
    this.sparks.burst(hit.x, hit.z, hit.nx, hit.nz, hit.impact, count, this.surface.heightAt(hit.x, hit.z, this.simCarY));
    if (!this.reducedFlash) this.follow.addShake(Math.min(1, hit.impact / SHAKE_IMPACT_REF) * SHAKE_METRES);
  }
}

export function createRenderer(container: HTMLElement, settings: Settings): GameRenderer {
  return new NeonRenderer(container, settings);
}
