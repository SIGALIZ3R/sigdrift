/**
 * Shared contracts for SigDRIFT. Every module builds against these types.
 *
 * COORDINATES
 * - The simulation is 2D on the ground plane. Sim (x, z) maps directly to three.js world (x, 0, z); three's +Y is up.
 * - Units: metres, seconds, radians, kilograms, newtons.
 * - Heading θ: the car's forward vector is (cos θ, sin θ) in (x, z). Seen from above (camera looking down -Y with
 *   +X to the right and +Z towards the viewer) increasing θ turns the car CLOCKWISE, i.e. to its own RIGHT.
 * - "Right" of a direction (dx, dz) is (-dz, dx). "Left" is (dz, -dx).
 * - A mesh modelled with its nose along +X is posed with `mesh.rotation.y = -heading`.
 * - Steering input +1 = steer right (heading increases when driving forwards).
 *
 * DETERMINISM
 * - Everything under src/core, src/sim, src/gen and src/modes is pure TypeScript: no DOM, no three.js, no Date,
 *   no Math.random, and NO Math.sin/cos/tan/atan/atan2/asin/acos/pow/exp/log/hypot. Use src/core/fixedMath.ts.
 *   Math.sqrt, Math.abs, Math.min, Math.max, Math.floor, Math.ceil, Math.round, Math.sign, Math.imul, Math.fround
 *   are exact and allowed.
 * - The simulation advances only in fixed steps of DT.
 */

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;

/** Bump when physics behaviour changes: recorded times and replays are only comparable within one version. */
export const PHYSICS_VERSION = 1;
/** Bump when the generator's output for a given week would change. Old versions stay frozen. */
export const GEN_VERSION = 1;

export interface Vec2 {
  x: number;
  z: number;
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------

/** One simulation tick of player input. Sampled once per tick. */
export interface InputState {
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1. Brakes whichever way the car is rolling; selects reverse once it is (nearly) stopped. */
  brake: number;
  handbrake: boolean;
  /** Held state of the "reset to checkpoint" control. The mode edge-detects it. */
  reset: boolean;
}

/** Non-simulation controls, read once per rendered frame by main.ts. Each is true only on the frame it was pressed. */
export interface MetaInput {
  pause: boolean;
  restart: boolean;
  toggleTuning: boolean;
  confirm: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------------------------------------------

export interface CarParams {
  mass: number;
  /** Yaw inertia, kg·m². */
  inertia: number;
  /** Centre of mass to front axle, m. */
  cgToFront: number;
  /** Centre of mass to rear axle, m. */
  cgToRear: number;
  cgHeight: number;
  /** 0..1 scale on longitudinal weight transfer. */
  weightTransfer: number;
  /** Lateral force per radian of slip, as a multiple of axle load (before saturation). */
  cornerStiffFront: number;
  cornerStiffRear: number;
  /** Peak lateral force as a multiple of axle load. */
  gripFront: number;
  gripRear: number;
  /** Multiplier on rear grip while the handbrake is held (0..1). */
  handbrakeGrip: number;
  /** Fraction of rear grip lost at full throttle (power oversteer), 0..1. */
  powerSlip: number;
  /** How much grip remains once a tyre is sliding well past its peak, relative to peak (0..1). */
  slideGrip: number;
  engineForce: number;
  reverseForce: number;
  brakeForce: number;
  handbrakeForce: number;
  /** Quadratic drag coefficient. */
  drag: number;
  /** Linear rolling resistance coefficient. */
  rollingResistance: number;
  /** Max steering angle at standstill, rad. */
  maxSteer: number;
  /** Max steering angle at and above steerSpeedRef, rad. */
  maxSteerAtSpeed: number;
  /** Speed (m/s) at which steering lock has fallen to maxSteerAtSpeed. */
  steerSpeedRef: number;
  /** How fast the wheels turn towards the input, rad/s. */
  steerRate: number;
  /** How fast the wheels return to centre when the input is released, rad/s. */
  steerReturnRate: number;
  /** Extra yaw damping, 1/s. */
  yawDamping: number;
  /** 0..1 automatic countersteer blended into the steering while sliding. 0 = off. */
  steerAssist: number;
  /** Collision body: the car is treated as circles of this radius along its length, m. */
  collisionRadius: number;
  /** Visual / wheel layout half extents, m. */
  halfLength: number;
  halfWidth: number;
  /** 0..1 bounce off walls. */
  restitution: number;
  /** 0..1 speed lost along a wall while scraping it. */
  wallFriction: number;
}

export interface CarState {
  x: number;
  z: number;
  heading: number;
  /** World-frame velocity, m/s. */
  vx: number;
  vz: number;
  /** rad/s, positive = turning right. */
  yawRate: number;
  /** Current front wheel angle, rad, positive = right. */
  steerAngle: number;
  /**
   * Reverse gear. Selected by the brake pedal once the car has (nearly) stopped; while it is set the pedal drives
   * the car backwards instead of braking. Cleared by the throttle, by rolling forwards, or by a respawn.
   */
  reversing: boolean;

  // ---- derived every tick (do not integrate these; recompute them) ----
  /** |velocity|, m/s. */
  speed: number;
  /** Velocity along the car's nose, m/s (negative when reversing). */
  forwardSpeed: number;
  /** Velocity along the car's right side, m/s. */
  lateralSpeed: number;
  /** Signed angle between heading and travel direction, rad. 0 when stopped or driving straight. */
  driftAngle: number;
  slipFront: number;
  slipRear: number;
  /** 0..1 how hard the rear tyres are sliding (drives skid marks, smoke, squeal). */
  rearSlide: number;
  /** 0..1 how hard the front tyres are sliding. */
  frontSlide: number;
  /** Longitudinal acceleration in the car frame last tick, m/s². */
  accelLong: number;
  /** Inputs as applied this tick (after smoothing/assist), for audio and visuals. */
  throttle: number;
  brake: number;
  handbrake: boolean;
}

export interface CollisionEvent {
  x: number;
  z: number;
  /** Unit normal pointing away from the obstacle, towards the car. */
  nx: number;
  nz: number;
  /** Closing speed along the normal at impact, m/s (>= 0). */
  impact: number;
}

/** The deterministic simulation of one car in one level. Implemented in src/sim/world.ts. */
export interface World {
  readonly level: Level;
  /** Mutable so the tuning panel can edit values live. */
  params: CarParams;
  readonly car: CarState;
  /** Number of steps taken since creation or the last full reset. */
  tick: number;
  /** Hardest collision that happened during the most recent step, or null. */
  lastCollision: CollisionEvent | null;
  /** Advance exactly one tick of DT. */
  step(input: InputState): void;
  /** Teleport the car to a pose at rest (used for start and checkpoint respawn). Does not change `tick`. */
  placeCar(pose: Pose): void;
  /** Flat list of numbers that fully describes dynamic state, for hashing in replay tests. */
  snapshot(): number[];
}

// ---------------------------------------------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  z: number;
  /** Half the drivable road width at this point, m. */
  halfWidth: number;
  /** Distance along the centreline from the start, m. */
  dist: number;
}

/** A line across the road. Crossing it in the direction of travel counts. */
export interface Gate extends Segment {
  /** Index into Level.path where this gate sits. */
  pathIndex: number;
  /** Pose to respawn at for this gate (on the centreline, facing along the road, at rest). */
  respawn: Pose;
}

/** Solid round obstacle standing on the road. */
export interface Prop {
  kind: 'pillar';
  x: number;
  z: number;
  radius: number;
  height: number;
  /** Index into the render palette's accent colours. */
  hue: number;
}

/** Non-solid scenery outside the road (buildings, towers). Purely cosmetic. */
export interface DecorBlock {
  x: number;
  z: number;
  /** Footprint size along x and z, m. */
  w: number;
  d: number;
  h: number;
  hue: number;
}

export interface Level {
  /** Week id, e.g. "2026-W48". */
  id: string;
  seed: string;
  genVersion: number;
  /** Smoothed centreline from start to goal, points roughly 2–4 m apart. */
  path: PathPoint[];
  /** Road edges, same length and indexing as `path`: left[i] / right[i] are path[i] offset by halfWidth. */
  left: Vec2[];
  right: Vec2[];
  /** Every solid boundary: both road edges plus the closed ends behind the start and beyond the goal. */
  walls: Segment[];
  props: Prop[];
  decor: DecorBlock[];
  start: Pose;
  /** Intermediate gates in driving order (the goal is not included). */
  checkpoints: Gate[];
  goal: Gate;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Centreline length, m. */
  length: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Run mode (drive from start to goal)
// ---------------------------------------------------------------------------------------------------------------

export type RunPhase = 'countdown' | 'running' | 'finished';

export interface RunState {
  phase: RunPhase;
  /** Ticks left in the countdown (0 once running). */
  countdownTicks: number;
  /** Ticks elapsed while running. Final time = ticks * DT. */
  ticks: number;
  /** Index of the next checkpoint to cross; equals checkpoints.length when only the goal remains. */
  nextCheckpoint: number;
  checkpointCount: number;
  /** Tick count at which each checkpoint was crossed. */
  splits: number[];
  /** Where a reset puts the car. */
  respawn: Pose;
  resets: number;
  /** Banked drift points. */
  driftScore: number;
  /** Points in the drift chain currently in progress (not yet banked). */
  chainScore: number;
  /** Current chain multiplier, >= 1. */
  multiplier: number;
  /** True while the car counts as drifting this tick. */
  drifting: boolean;
  /** Tick on which a checkpoint was last crossed, or -1. For HUD flashes. */
  lastCheckpointTick: number;
  /** Tick on which the chain was last lost to a wall hit or spin, or -1. */
  lastChainBreakTick: number;
}

/** Implemented in src/modes/run.ts. Pure and deterministic. */
export interface RunMode {
  readonly world: World;
  readonly state: RunState;
  /** Advance one tick: handles countdown, steps the world, gates, resets and drift scoring. */
  step(input: InputState): void;
  /** Back to the start line with a fresh countdown. */
  restart(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering, settings, storage
// ---------------------------------------------------------------------------------------------------------------

export type Quality = 'low' | 'high';

export interface Settings {
  quality: Quality;
  /** 0..1 master volume. */
  volume: number;
  /** Steering assist (auto countersteer) on or off. */
  assist: boolean;
  /** Tones down bloom pulses, screen shake and flashes. */
  reducedFlash: boolean;
}

export interface RenderFrame {
  /** Car pose interpolated between the previous and current sim tick. */
  pose: Pose;
  /** Latest simulated car state. */
  car: CarState;
  params: CarParams;
  run: RunState;
  /** Real seconds since the previous rendered frame. */
  dt: number;
}

/** Implemented in src/render/renderer.ts. Owns the canvas, scene, locked camera and effects. */
export interface GameRenderer {
  readonly canvas: HTMLCanvasElement;
  setLevel(level: Level): void;
  /** Called once per simulation tick so skid marks are laid at sim rate. */
  onSimTick(car: CarState, params: CarParams, collision: CollisionEvent | null): void;
  /** Clear skid marks and smoke (on restart / respawn). */
  clearEffects(): void;
  render(frame: RenderFrame): void;
  resize(width: number, height: number): void;
  applySettings(settings: Settings): void;
  dispose(): void;
}

export interface BestRecord {
  /** Best time in ticks. */
  ticks: number;
  driftScore: number;
  physicsVersion: number;
}
