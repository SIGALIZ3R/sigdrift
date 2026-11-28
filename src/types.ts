/**
 * Shared contracts for DriftNeo. Every module builds against these types.
 *
 * COORDINATES
 * - The simulation is 2.5D: the car drives on road SURFACES at heights. Sim (x, z) maps to three.js (x, ?, z) and the
 *   car's height `y` is three.js Y (+Y up). Roads can climb, descend and pass OVER or UNDER other roads.
 * - Every road surface is at y >= 0. The city floor (buildings, the void between roads) is at TERRAIN_Y below all
 *   roads, so leaving a road over its edge always means a real drop.
 * - Units: metres, seconds, radians, kilograms, newtons.
 * - Heading θ: the car's forward vector is (cos θ, sin θ) in (x, z). Seen from above (camera looking down -Y with
 *   +X to the right and +Z towards the viewer) increasing θ turns the car CLOCKWISE, i.e. to its own RIGHT.
 * - "Right" of a direction (dx, dz) is (-dz, dx). "Left" is (dz, -dx).
 * - A mesh modelled with its nose along +X is posed with `mesh.rotation.y = -heading`.
 * - Steering input +1 = steer right (heading increases when driving forwards).
 *
 * ROAD SURFACE HEIGHT
 * - Each road has a centreline of PathPoints carrying `y`. The surface is level ACROSS the road and varies only
 *   along it: at a point p over a road segment i..i+1, the surface height is the linear interpolation of path[i].y and
 *   path[i+1].y by the projection of p onto that segment, plus any bump of that road (see Bump).
 * - "Which surface is the car on?" Among the road pieces whose footprint (within halfWidth of the centreline) contains
 *   the point, the car stands on the HIGHEST surface whose height is <= car.y + STEP_UP. If there is none, it is over
 *   the city floor (TERRAIN_Y). Where two roads overlap in plan, their surfaces are always >= CROSSING_CLEARANCE apart.
 *
 * DETERMINISM
 * - Everything under src/core, src/sim, src/gen and src/modes is pure TypeScript: no DOM, no three.js, no Date,
 *   no Math.random, and NO Math.sin/cos/tan/atan/atan2/asin/acos/pow/exp/log/hypot. Use src/core/fixedMath.ts.
 *   Math.sqrt, Math.abs, Math.min, Math.max, Math.floor, Math.ceil, Math.round, Math.sign, Math.imul, Math.fround
 *   are exact and allowed. (Accepted exceptions: createFixedLoop in src/core/loop.ts, UTC calendar maths in
 *   src/gen/weeklySeed.ts.)
 * - The simulation advances only in fixed steps of DT.
 */

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;

/** Bump when physics behaviour changes: recorded times and replays are only comparable within one version. */
export const PHYSICS_VERSION = 4;
/** Bump when the generator's output for a given seed would change. */
export const GEN_VERSION = 3;

/** Height of the city floor under every road, m. */
export const TERRAIN_Y = -4;
/** Height of a road barrier above the road surface, m. */
export const WALL_HEIGHT = 0.7;
/** Minimum vertical distance between two road surfaces that overlap in plan (an overpass and the road below), m. */
export const CROSSING_CLEARANCE = 7;
/** Steepest road slope the generators may build (rise over run). */
export const MAX_GRADE = 0.12;
/** A grounded car follows a surface up to this far above its wheels (kerbs, bump faces, joins), m. */
export const STEP_UP = 0.6;

export interface Vec2 {
  x: number;
  z: number;
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
  /**
   * Road surface height at the pose, m. Worlds place the car on the road surface nearest this height (it matters
   * where roads cross). Optional: 0 when absent.
   */
  y?: number;
}

export interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** A road barrier: solid from the road surface (ya at a, yb at b, linear between) up to surface + WALL_HEIGHT. */
export interface Wall extends Segment {
  ya: number;
  yb: number;
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
  /** M key: mute / unmute all sound. */
  toggleMute: boolean;
  /** Menu navigation (arrow keys / WASD / d-pad / left stick flicks) while a menu is open. */
  navUp: boolean;
  navDown: boolean;
  navLeft: boolean;
  navRight: boolean;
  /** Escape / Backspace / gamepad B while a menu is open: go back one screen. */
  back: boolean;
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
  /**
   * 0..1 drift assist. It must HELP HOLD a drift (catch a slide before it becomes a spin, keep the angle the player
   * asks for), never cancel the rotation the player starts. 0 = off.
   */
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
  /** Horizontal |velocity|, m/s. */
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

  // ---- height ----
  /** Height of the car's wheels (three.js Y), m. Equals the surface height while grounded. */
  y: number;
  /** Vertical speed, m/s, positive = up. */
  vy: number;
  /** True while the wheels are off the ground: no tyre forces, no steering, no braking; gravity and drag only. */
  airborne: boolean;
  /** Slope of the surface under the car along its heading (rise over run, + = uphill). 0 while airborne. */
  pitchSlope: number;
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

/** What every simulation world offers, whatever track it runs on. */
export interface SimBase {
  /** Mutable so the tuning panel can edit values live. */
  params: CarParams;
  readonly car: CarState;
  /** Number of steps taken since creation or the last full reset. */
  tick: number;
  /** Hardest collision that happened during the most recent step, or null. */
  lastCollision: CollisionEvent | null;
  /**
   * Distance from the car's collision body to the nearest solid (wall or pillar at the car's own level) after the
   * most recent step, m; Infinity when nothing is within 8 m. Drives the close-to-the-wall scoring.
   */
  readonly wallDistance: number;
  /**
   * True once the car has come to rest on the city floor (it fell off an edge or flew over a barrier). Latched until
   * placeCar. Worlds keep stepping physics normally on the floor.
   */
  readonly offTrack: boolean;
  /**
   * Surface a car at height `fromY` standing at (x, z) would rest on (see ROAD SURFACE HEIGHT), including bumps;
   * TERRAIN_Y when no road is there.
   */
  groundHeight(x: number, z: number, fromY: number): number;
  /** Advance exactly one tick of DT. */
  step(input: InputState): void;
  /** Teleport the car to a pose at rest on the road surface (see Pose.y). Clears offTrack. Does not change `tick`. */
  placeCar(pose: Pose): void;
  /** Flat list of numbers that fully describes dynamic state, for hashing in replay tests. */
  snapshot(): number[];
}

/** The deterministic simulation of one car in one fixed level. Implemented in src/sim/world.ts (createWorld). */
export interface World extends SimBase {
  readonly level: Level;
}

// ---------------------------------------------------------------------------------------------------------------
// Roads (shared by fixed levels and endless chunks)
// ---------------------------------------------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  z: number;
  /** Road surface height at this point, m (>= 0). */
  y: number;
  /** Half the drivable road width at this point, m. */
  halfWidth: number;
  /** Distance along the centreline from the start, m (horizontal distance). */
  dist: number;
}

/** A line across the road. Crossing it in the direction of travel counts. */
export interface Gate extends Segment {
  /** Index into Level.path where this gate sits. */
  pathIndex: number;
  /** Road surface height at the gate: only a car within 3 m of this height crosses it. */
  y: number;
  /** Pose to respawn at for this gate (on the centreline, facing along the road, at rest, with y). */
  respawn: Pose;
}

/** Solid round obstacle standing on the road. */
export interface Prop {
  kind: 'pillar';
  x: number;
  z: number;
  /** Road surface height at its base, m. */
  y: number;
  radius: number;
  height: number;
  /** Index into the render palette's accent colours. */
  hue: number;
}

/** Non-solid scenery standing on the city floor (buildings, towers). Purely cosmetic. */
export interface DecorBlock {
  x: number;
  z: number;
  /** Footprint size along x and z, m. */
  w: number;
  d: number;
  /** Height above TERRAIN_Y, m. */
  h: number;
  hue: number;
}

/** Cosmetic column holding up a raised road, from the city floor to just under the road at `top`. */
export interface Support {
  x: number;
  z: number;
  /** Underside of the road deck, m. */
  top: number;
  radius: number;
}

/**
 * A raised ridge across the whole road, added to that road's surface height. Near the bump:
 *   u = (p - centre) · dir            (metres along the road, relative to the crest)
 *   h = height * 0.5 * (1 + cos(PI * u / halfLength))   for |u| < halfLength, else 0
 * and only where |(p - centre) · right(dir)| <= halfWidth, and only for a road whose surface there is within 1.5 m of
 * `y` (a bump never lifts the road above or below it). Use fixedMath.cos.
 */
export interface Bump {
  x: number;
  z: number;
  /** Road surface height at the crest, without the bump, m. */
  y: number;
  /** Unit vector along the road at the crest (horizontal). */
  dirX: number;
  dirZ: number;
  /** Half the bump's length along the road, m. */
  halfLength: number;
  /** Half its extent across the road, m (a little more than the road's halfWidth, so it spans edge to edge). */
  halfWidth: number;
  /** Crest height above the road, m. */
  height: number;
}

/** The parts every drivable road piece has, whether a whole level or an endless chunk. */
export interface RoadPiece {
  /** Centreline, points 2–4 m apart. */
  path: PathPoint[];
  /** Road edges, same length and indexing as `path` (path[i] offset by halfWidth; height path[i].y). */
  left: Vec2[];
  right: Vec2[];
  /**
   * Whether the edge segment from index i to i+1 has NO barrier (an open drop-off edge, marked by the renderer with
   * hazard paint). Same length as `path`; the last entry is unused. Open edges are where cars fall off.
   */
  leftOpen: boolean[];
  rightOpen: boolean[];
  /** Every barrier: the edges that are not open, plus any closed ends. */
  walls: Wall[];
  props: Prop[];
  bumps: Bump[];
  supports: Support[];
  decor: DecorBlock[];
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number; minY: number; maxY: number };
}

export interface Level extends RoadPiece {
  /** Week id ("2026-W48") or level id ("L1".."L5"). */
  id: string;
  seed: string;
  genVersion: number;
  start: Pose;
  /** Intermediate gates in driving order (the goal is not included). */
  checkpoints: Gate[];
  goal: Gate;
  /** Centreline length, m. */
  length: number;
}

/**
 * How a fixed level is generated. The weekly run uses WEEKLY_OPTIONS from src/gen/levels.ts; each hand-picked level
 * has its own. All values are targets the generator aims for, deterministic per seed.
 */
export interface TrackOptions {
  /** Road length in grid cells, [min, max]. */
  cells: [number, number];
  /** Base half width range, m. */
  halfWidth: [number, number];
  /** 0 (flat) .. 1 (big climbs and drops). */
  elevation: number;
  /** How many times the road should pass over or under itself (0..4). */
  crossings: number;
  /** 0..1 share of raised road (y >= 3) whose edges are open drop-offs instead of barriers. */
  openEdges: number;
  /** Bumps per km. */
  bumpsPerKm: number;
  /** 0..1 how twisty: share of bends, S-bends and hairpins. */
  twist: number;
  /** 0..1 how often a straight widens into a plaza. */
  plazas: number;
  /** Pillars per km. */
  pillarsPerKm: number;
}

export interface LevelDef {
  /** "L1".."L5". */
  id: string;
  name: string;
  /** One short line for the level card. */
  blurb: string;
  /** 1 (easy) .. 5 (hard), shown as pips. */
  difficulty: number;
  seed: string;
  options: TrackOptions;
}

// ---------------------------------------------------------------------------------------------------------------
// Endless track (infinite mode): the road arrives in chunks
// ---------------------------------------------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * One generated stretch of endless road. Chunks are numbered 0, 1, 2 ... and join end to start:
 * chunk[n].path[0] is the same point as chunk[n-1].path[last] (same x, z, y and halfWidth).
 */
export interface TrackChunk extends RoadPiece {
  index: number;
  /** `dist` of the first and last path point. Path `dist` runs along the WHOLE endless road, across chunks. */
  startDist: number;
  endDist: number;
  /** 0 (gentle) .. 1 (brutal): what the generator aimed for in this chunk. For the HUD and tests. */
  intensity: number;
}

/** A deterministic, endless supply of chunks. Implemented in src/gen/endless.ts (createEndlessGenerator). */
export interface EndlessGenerator {
  readonly seed: string;
  readonly difficulty: Difficulty;
  /** Start pose for the car, on chunk 0. */
  readonly start: Pose;
  /** Generates and returns the next chunk (index 0 first). */
  next(): TrackChunk;
}

/**
 * The simulation on an endless track. Implemented in src/sim/endlessWorld.ts (createEndlessWorld).
 * The owner appends chunks ahead of the car and drops old ones behind it.
 */
export interface EndlessWorld extends SimBase {
  /** Live chunks, in index order with no gaps. */
  readonly chunks: readonly TrackChunk[];
  /** Append the next chunk (its index must be last.index + 1, or anything when no chunk is live). */
  addChunk(chunk: TrackChunk): void;
  /**
   * Remove every live chunk with an index below `index`. The entry of the oldest remaining chunk is then closed
   * by a solid cap wall so the car cannot reverse out of the world.
   */
  dropChunksBefore(index: number): void;
  /** Distance along the road of the centreline point nearest to the car, m (the car's progress). */
  readonly trackDist: number;
  /** Index of the chunk the car is currently on. */
  readonly chunkIndex: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring (shared by every mode)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Drift points. Implemented in src/modes/driftScore.ts. Rules (the modes agent owns the exact numbers):
 * - While drifting, points flow straight into `points` every tick: base(speed, drift angle) x proximity bonus x
 *   multiplier. Points are NEVER taken away.
 * - The closer the car is to a wall or pillar while drifting (SimBase.wallDistance), the bigger the proximity bonus
 *   AND the faster the multiplier climbs.
 * - The multiplier builds while the player keeps drifting and linking drifts; it slowly decays after a pause.
 * - Hitting something (a real impact), spinning out, falling off or resetting drops the multiplier back to 1. The
 *   points already earned are kept. After a hit, a fall or a reset nothing scores until the car has recovered (a
 *   wreck sliding along the wall it hit is not drifting).
 */
export interface ScoreState {
  /** Total points this run. Never decreases. */
  points: number;
  /** Current multiplier, 1..MAX. */
  multiplier: number;
  /** Highest multiplier reached this run. */
  peakMultiplier: number;
  /** True while the car counts as drifting this tick. */
  drifting: boolean;
  /** 0..1 how close to a wall the current drift is (1 = brushing it). 0 when not drifting. */
  proximity: number;
  /** Points earned since the multiplier was last reset to 1 (for the HUD's running combo readout). */
  combo: number;
  /** Tick on which the multiplier was last lost, or -1. */
  lastMultiplierLossTick: number;
  /** Tick on which a close-to-the-wall moment last began (proximity rising past 0.5), or -1. */
  lastCloseTick: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Run mode (weekly run and the five levels: drive from start to goal)
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
  /** Where a reset or a fall puts the car. */
  respawn: Pose;
  /** Manual resets (R). */
  resets: number;
  /** Times the car fell off the road (it is put back at the last checkpoint; the clock keeps running). */
  falls: number;
  /** Tick of the most recent fall, or -1. */
  lastFallTick: number;
  /** > 0 while the car is waiting to be put back after a fall (so the player sees the drop). */
  respawnInTicks: number;
  score: ScoreState;
  /** Tick on which a checkpoint was last crossed, or -1. For HUD flashes. */
  lastCheckpointTick: number;
}

/** Implemented in src/modes/run.ts. Pure and deterministic. */
export interface RunMode {
  readonly world: World;
  readonly state: RunState;
  /** Advance one tick: countdown, world step, gates, resets, falls and scoring. */
  step(input: InputState): void;
  /** Back to the start line with a fresh countdown. */
  restart(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Endless mode (infinite road, three crashes, falling off the road is fatal)
// ---------------------------------------------------------------------------------------------------------------

export type EndlessPhase = 'countdown' | 'running' | 'dead';
/** 'offTrack' = fell off the road or flew over a barrier; 'crashes' = used up every crash. */
export type DeathCause = 'offTrack' | 'crashes';

export interface EndlessState {
  phase: EndlessPhase;
  countdownTicks: number;
  /** Ticks elapsed while running. */
  ticks: number;
  difficulty: Difficulty;
  /** Furthest distance reached along the road, m. */
  distance: number;
  /** Crashes so far (wall or pillar hits hard enough to count). */
  crashes: number;
  /** The run ends when crashes reaches this (3). */
  maxCrashes: number;
  /** Tick of the most recent counted crash, or -1. For HUD flashes. */
  lastCrashTick: number;
  deathCause: DeathCause | null;
  /** Intensity (0..1) of the chunk the car is on. */
  intensity: number;
  /** Tick on which the car last left the ground / last landed, or -1. For HUD and audio. */
  lastTakeoffTick: number;
  lastLandingTick: number;
  score: ScoreState;
}

/** Implemented in src/modes/endless.ts (createEndlessMode). Pure and deterministic. Owns chunk streaming. */
export interface EndlessMode {
  readonly world: EndlessWorld;
  readonly state: EndlessState;
  /** Advance one tick: countdown, world step, chunk streaming, crash counting, death, scoring. */
  step(input: InputState): void;
  /** Same seed and difficulty again from the start. */
  restart(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering, settings, storage
// ---------------------------------------------------------------------------------------------------------------

/** What the player is doing: this week's generated run, one of the five fixed levels, or endless. */
export type GameMode = 'weekly' | 'level' | 'endless';

export type Quality = 'low' | 'high';

export interface Settings {
  quality: Quality;
  /** 0..1 master volume. */
  volume: number;
  /** 0..1 background music level, on top of the master volume. */
  musicVolume: number;
  /** Drift assist on or off. */
  assist: boolean;
  /** Tones down bloom pulses, screen shake, flashes and UI glitches. */
  reducedFlash: boolean;
  /** All sound off (the volume setting is kept for when it is switched back on). */
  muted: boolean;
}

export interface RenderFrame {
  /** Car pose interpolated between the previous and current sim tick. */
  pose: Pose;
  /** Latest simulated car state. */
  car: CarState;
  params: CarParams;
  /** Run state (weekly or level), or null in endless mode. */
  run: RunState | null;
  /** Endless mode state, or null otherwise. */
  endless: EndlessState | null;
  /** Car height (CarState.y) interpolated like the pose, m. */
  height: number;
  /** Real seconds since the previous rendered frame. */
  dt: number;
}

/** Implemented in src/render/renderer.ts. Owns the canvas, scene, locked camera and effects. */
export interface GameRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Show a fixed level (weekly or one of the five; removes any endless chunks). */
  setLevel(level: Level): void;
  /** Switch to endless mode: remove the current level and all chunks, ready for addChunk. */
  beginEndless(): void;
  /** Build and show one chunk of endless road. */
  addChunk(chunk: TrackChunk): void;
  /** Remove a chunk and free its GPU resources. Unknown indices are ignored. */
  removeChunk(index: number): void;
  /** Called once per simulation tick so skid marks are laid at sim rate. */
  onSimTick(car: CarState, params: CarParams, collision: CollisionEvent | null): void;
  /** Clear skid marks and smoke (on restart / respawn). */
  clearEffects(): void;
  render(frame: RenderFrame): void;
  resize(width: number, height: number): void;
  applySettings(settings: Settings): void;
  /** Shows the player's car with the look of garage car `id`. */
  setCarStyle(id: string): void;
  dispose(): void;
}

/** One finished weekly or level run. */
export interface RunRecord {
  ticks: number;
  score: number;
  /** ISO date-time the run was set (game.ts stamps it). */
  date: string;
  physicsVersion: number;
}

/** One ended endless run. */
export interface EndlessRecord {
  distance: number;
  score: number;
  ticks: number;
  date: string;
  physicsVersion: number;
}

/** What is stored per weekly run / level: the fastest time and the top five scores. */
export interface RunRecords {
  bestTime: RunRecord | null;
  /** Top five by score, highest first. */
  highScores: RunRecord[];
}

/** What is stored per endless difficulty: the furthest distance and the top five scores. */
export interface EndlessRecords {
  bestDistance: EndlessRecord | null;
  /** Top five by score, highest first. */
  highScores: EndlessRecord[];
}
