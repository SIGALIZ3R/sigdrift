/**
 * The driving line that the bots follow, and the hands and feet that follow it. Shared by the weekly bot (one line
 * for the whole level, planned once) and the endless bot (one line over the live chunks, planned again whenever
 * the road grows).
 *
 * A line is planned in four steps:
 *   1. `clearLine`, then `appendPiece` (or `appendPath`) for every stretch of road;
 *   2. `beginPlan`, which works out the direction of travel at each point;
 *   3. any number of `addDodge` (a pillar to pass on its open side), `addBumpCare` (a bump to cross with the wheels
 *      down) and `capSpeed` (a stretch to take slowly);
 *   4. `layLine` and `planSpeeds`.
 * Per tick a `LineFollower` only finds the car on that line, steers at a point further along it (pure pursuit) and
 * holds the planned speed. Nothing here allocates once the line has its arrays.
 *
 * Roads are 2.5D. The line keeps each point's road height, so that:
 * - where the road passes over or under itself, the car is only ever found on the stretch at its own height;
 * - the speeds respect the hills: crests are taken slowly enough that the wheels stay down (CREST_UNLOADING), and
 *   the braking for a bend counts on less deceleration downhill and more uphill;
 * - open edges (no barrier, a drop to the city floor) are given room: dodges never take the line within
 *   OPEN_EDGE_CLEARANCE of one, bends near one are taken with less sideways grip in hand, and crests near one with
 *   more weight on the tyres.
 */
import { PI, atan, clamp, cos, lerp, sin, smoothstep } from '../core/fixedMath';
import { GRAVITY } from '../sim/car';
import type { Bump, CarParams, CarState, InputState, PathPoint, Prop, RoadPiece } from '../types';
import { CROSSING_CLEARANCE } from '../types';

export const TOP_SPEED = 30;
const MIN_SPEED = 6;
/** Sideways acceleration the plan allows itself in a bend, m/s². Well inside what the tyres can give. */
const LATERAL_ACCEL = 7;
/** Deceleration the plan counts on when slowing for a bend, m/s². The brakes manage about twice this. */
const BRAKE_DECEL = 6;
/** Roads narrower than this are taken slower, in proportion. */
const FULL_SPEED_HALF_WIDTH = 10;
const MIN_WIDTH_FACTOR = 0.7;
/** The plan reads the sharpest curvature this many points either side, which rounds off sampling noise. */
const CURVATURE_WINDOW = 2;

/** Gap the driving line keeps between the car's centre and a pillar's surface, and to a wall. */
const PILLAR_CLEARANCE = 3.5;
const WALL_CLEARANCE = 2.5;
/** Gap the driving line keeps between the car's centre and an open edge. */
const OPEN_EDGE_CLEARANCE = 4.5;
/** Bends within this many metres of an open edge are taken with this share of LATERAL_ACCEL. */
const OPEN_EDGE_REACH = 25;
const OPEN_EDGE_GRIP = 0.75;
/**
 * Over a crest the plan lets the ground fall away from under the car with at most this share of gravity, which
 * leaves a fifth of the car's weight on its tyres (the car takes off at about 1.15 g). Near an open edge, less.
 */
export const CREST_UNLOADING = 0.8;
const OPEN_EDGE_CREST_UNLOADING = 0.55;
/** Vertical curvature is read over this many metres either side of a point (path points are 2-4 m apart). */
const CREST_SPAN = 6;
/** Least braking the plan counts on, however steep the descent, m/s². */
const MIN_BRAKE_DECEL = 2;
/** A bump's speed is reached this far before its ridge begins, m. */
const BUMP_LEAD = 3;
/** A line point is at the car's level when within this of the car's wheels, m. */
const HEIGHT_MATCH = CROSSING_CLEARANCE / 2;
/** Penalty (m²) for a line point not at the car's level, so that one which is always wins. */
const OFF_LEVEL = 1e12;
/** The line starts to move over this far before a pillar, holds its offset this far around it, and returns. */
const DODGE_LEAD = 45;
const DODGE_HOLD = 6;
const DODGE_TAIL = 40;

const LOOK_AHEAD_BASE = 5;
const LOOK_AHEAD_PER_SPEED = 0.35;
const LOOK_AHEAD_MAX = 16;

const THROTTLE_GAIN = 0.6;
const BRAKE_GAIN = 0.4;
/** Speed over the plan that is tolerated before the brakes come on. */
const BRAKE_DEADBAND = 0.5;
/** Below this forward speed the brake pedal would select reverse, so the driver stays off it. */
const BRAKE_MIN_SPEED = 2;
/** Throttle given up at full steering lock, so that power never breaks the rear loose in a bend. */
const THROTTLE_STEER_CUT = 0.55;
const SLIDE_ANGLE = 0.15;
const SLIDE_THROTTLE = 0.25;

/** Points searched behind and ahead of the last known position. */
const SEARCH_BACK = 6;
const SEARCH_AHEAD = 24;
/** Further than this from every searched point means the car was moved (respawn): search the whole line. */
const LOST_MARGIN = 8;

export interface DriveLine {
  /** Points in use; the arrays may be longer. */
  count: number;
  /** Driving line. Between `beginPlan` and `layLine` it is still the centreline. */
  x: Float64Array;
  z: Float64Array;
  /** Unit direction of travel at each point. */
  tx: Float64Array;
  tz: Float64Array;
  /** Distance along the centreline. */
  dist: Float64Array;
  /** Road surface height. */
  y: Float64Array;
  halfWidth: Float64Array;
  /** Open edges of the segment from this point to the next: bit 0 left, bit 1 right. */
  open: Uint8Array;
  speed: Float64Array;
  /** Planning scratch: sideways offset of the line from the centreline, speed limit, curvature. */
  offset: Float64Array;
  cap: Float64Array;
  curvature: Float64Array;
}

function allocate(line: DriveLine, capacity: number): void {
  const keep = line.count;
  const grow = (old: Float64Array): Float64Array => {
    const next = new Float64Array(capacity);
    next.set(old.subarray(0, keep));
    return next;
  };
  line.x = grow(line.x);
  line.z = grow(line.z);
  line.tx = grow(line.tx);
  line.tz = grow(line.tz);
  line.dist = grow(line.dist);
  line.y = grow(line.y);
  line.halfWidth = grow(line.halfWidth);
  const open = new Uint8Array(capacity);
  open.set(line.open.subarray(0, keep));
  line.open = open;
  line.speed = grow(line.speed);
  line.offset = grow(line.offset);
  line.cap = grow(line.cap);
  line.curvature = grow(line.curvature);
}

/** An empty line with room for `capacity` points. It grows by itself if more are appended. */
export function createDriveLine(capacity: number): DriveLine {
  const none = new Float64Array(0);
  const line: DriveLine = {
    count: 0,
    x: none,
    z: none,
    tx: none,
    tz: none,
    dist: none,
    y: none,
    halfWidth: none,
    open: new Uint8Array(0),
    speed: none,
    offset: none,
    cap: none,
    curvature: none,
  };
  allocate(line, Math.max(capacity, 2));
  return line;
}

export function clearLine(line: DriveLine): void {
  line.count = 0;
}

/**
 * Appends `path[from..]` to the centreline, with no open edges. Pass 1 for a chunk whose first point repeats the
 * previous chunk's last.
 */
export function appendPath(line: DriveLine, path: readonly PathPoint[], from = 0): void {
  const needed = line.count + path.length - from;
  if (needed > line.x.length) allocate(line, Math.max(needed, 2 * line.x.length));
  let at = line.count;
  for (let i = from; i < path.length; i++) {
    const p = path[i];
    line.x[at] = p.x;
    line.z[at] = p.z;
    line.dist[at] = p.dist;
    line.y[at] = p.y ?? 0;
    line.halfWidth[at] = p.halfWidth;
    line.open[at] = 0;
    at++;
  }
  line.count = at;
}

/** Appends a road piece's centreline from `from` on, with its open edges. */
export function appendPiece(line: DriveLine, piece: RoadPiece, from = 0): void {
  const start = line.count;
  appendPath(line, piece.path, from);
  const left = piece.leftOpen;
  const right = piece.rightOpen;
  if (left === undefined || right === undefined) return;
  for (let i = from; i < piece.path.length; i++) {
    line.open[start + i - from] = (left[i] === true ? 1 : 0) | (right[i] === true ? 2 : 0);
  }
}

/** Works out the direction of travel at each centreline point, and forgets earlier dodges and speed caps. */
export function beginPlan(line: DriveLine): void {
  const last = line.count - 1;
  for (let i = 0; i <= last; i++) {
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, last);
    const dx = line.x[b] - line.x[a];
    const dz = line.z[b] - line.z[a];
    const length = Math.sqrt(dx * dx + dz * dz);
    line.tx[i] = length > 0 ? dx / length : 1;
    line.tz[i] = length > 0 ? dz / length : 0;
    line.offset[i] = 0;
    line.cap[i] = Infinity;
  }
}

/**
 * Index of the line point nearest to (x, z) among from..to, preferring points within HEIGHT_MATCH of `y` (pass NaN
 * to ignore heights): where the road crosses itself, the stretch at the car's own level.
 */
function nearestOnLine(line: DriveLine, from: number, to: number, x: number, z: number, y: number): number {
  let best = from;
  let bestSq = Infinity;
  const level = y === y;
  for (let i = from; i <= to; i++) {
    const dx = line.x[i] - x;
    const dz = line.z[i] - z;
    let sq = dx * dx + dz * dz;
    if (level && !(Math.abs(line.y[i] - y) <= HEIGHT_MATCH)) sq += OFF_LEVEL;
    if (sq < bestSq) {
      bestSq = sq;
      best = i;
    }
  }
  return best;
}

/**
 * Distance along the road of the point (x, z), measured at the nearest centreline point. Only meaningful between
 * `beginPlan` and `layLine`, while the line is still the centreline.
 */
export function stationOf(line: DriveLine, x: number, z: number, y = NaN): number {
  const at = nearestOnLine(line, 0, line.count - 1, x, z, y);
  return line.dist[at] + (x - line.x[at]) * line.tx[at] + (z - line.z[at]) * line.tz[at];
}

/**
 * How far to the right of the centreline (negative: left) the line should pass a pillar. It takes the side with
 * more room, and moves over no further than it must.
 */
function dodgeOffset(lateral: number, radius: number, halfWidth: number): number {
  const rightEdge = lateral + radius;
  const leftEdge = lateral - radius;
  if (halfWidth - rightEdge >= halfWidth + leftEdge) {
    return Math.max(0, Math.min(rightEdge + PILLAR_CLEARANCE, (rightEdge + halfWidth) / 2));
  }
  return Math.min(0, Math.max(leftEdge - PILLAR_CLEARANCE, (leftEdge - halfWidth) / 2));
}

/** Adds one pillar's sidestep to the per-point offsets: eased in before it, held past it, eased out after. */
export function addDodge(line: DriveLine, prop: Prop): void {
  const at = nearestOnLine(line, 0, line.count - 1, prop.x, prop.z, prop.y ?? NaN);
  const dx = prop.x - line.x[at];
  const dz = prop.z - line.z[at];
  const along = line.dist[at] + dx * line.tx[at] + dz * line.tz[at];
  const lateral = dz * line.tx[at] - dx * line.tz[at];
  const offset = dodgeOffset(lateral, prop.radius, line.halfWidth[at]);
  if (offset === 0) return;
  for (let i = 0; i < line.count; i++) {
    const s = line.dist[i] - along;
    if (s < -DODGE_LEAD || s > DODGE_TAIL) continue;
    const share = s < 0 ? smoothstep(-DODGE_LEAD, -DODGE_HOLD, s) : 1 - smoothstep(DODGE_HOLD, DODGE_TAIL, s);
    line.offset[i] += offset * share;
  }
}

/** The plan will not exceed `speed` anywhere between the two distances along the road, and brakes in time for it. */
export function capSpeed(line: DriveLine, fromDist: number, toDist: number, speed: number): void {
  for (let i = 0; i < line.count; i++) {
    const d = line.dist[i];
    if (d >= fromDist && d <= toDist && speed < line.cap[i]) line.cap[i] = speed;
  }
}

/**
 * Fastest a car can cross a bump with its wheels pressed to the ground by at least (1 - unloading) of its weight.
 * The ridge is a raised cosine, sharpest at the crest: there the ground falls away at
 * speed² x height x (PI / halfLength)² / 2.
 */
export function bumpSpeed(bump: Bump, unloading: number = CREST_UNLOADING): number {
  if (!(bump.height > 0)) return Infinity;
  return (bump.halfLength / PI) * Math.sqrt((2 * unloading * GRAVITY) / bump.height);
}

/** The plan crosses `bump` no faster than bumpSpeed, reached BUMP_LEAD metres before its ridge begins. */
export function addBumpCare(line: DriveLine, bump: Bump): void {
  const crest = stationOf(line, bump.x, bump.z, bump.y ?? NaN);
  capSpeed(line, crest - bump.halfLength - BUMP_LEAD, crest + bump.halfLength, bumpSpeed(bump));
}

/** Whether an open edge is within OPEN_EDGE_REACH metres along the road of point i. */
function nearOpenEdge(line: DriveLine, i: number): boolean {
  const d = line.dist[i];
  for (let j = i; j >= 0 && line.dist[j] >= d - OPEN_EDGE_REACH; j--) if (line.open[j] !== 0) return true;
  for (let j = i + 1; j < line.count && line.dist[j] <= d + OPEN_EDGE_REACH; j++) if (line.open[j] !== 0) return true;
  return false;
}

/**
 * Moves the line off the centreline by the dodges collected so far, never closer to a wall than it should be, nor
 * to an open edge.
 */
export function layLine(line: DriveLine): void {
  for (let i = 0; i < line.count; i++) {
    const open = line.open[i] | (i > 0 ? line.open[i - 1] : 0);
    const half = line.halfWidth[i];
    const leftReach = Math.max(0, half - ((open & 1) !== 0 ? OPEN_EDGE_CLEARANCE : WALL_CLEARANCE));
    const rightReach = Math.max(0, half - ((open & 2) !== 0 ? OPEN_EDGE_CLEARANCE : WALL_CLEARANCE));
    const offset = clamp(line.offset[i], -leftReach, rightReach);
    line.x[i] = line.x[i] - line.tz[i] * offset;
    line.z[i] = line.z[i] + line.tx[i] * offset;
  }
}

/** Curvature (1/m) of the circle through three neighbouring points of the driving line. */
function curvatureAt(line: DriveLine, i: number): number {
  if (i <= 0 || i >= line.count - 1) return 0;
  const ax = line.x[i] - line.x[i - 1];
  const az = line.z[i] - line.z[i - 1];
  const bx = line.x[i + 1] - line.x[i];
  const bz = line.z[i + 1] - line.z[i];
  const cx = ax + bx;
  const cz = az + bz;
  const product = Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz) * (cx * cx + cz * cz));
  return product > 0 ? (2 * Math.abs(ax * bz - az * bx)) / product : 0;
}

/** Index of the last point at least `span` metres before point i along the road (or 0). */
function pointBefore(line: DriveLine, i: number, span: number): number {
  const d = line.dist[i] - span;
  let j = i;
  while (j > 0 && line.dist[j] > d) j--;
  return j;
}

/** Index of the first point at least `span` metres after point i along the road (or the last). */
function pointAfter(line: DriveLine, i: number, span: number): number {
  const d = line.dist[i] + span;
  let j = i;
  while (j < line.count - 1 && line.dist[j] < d) j++;
  return j;
}

/**
 * How sharply the road falls away over a crest at point i (1/m; 0 in a dip or on an even grade): the change of
 * grade from the CREST_SPAN metres before it to the CREST_SPAN metres after it, per metre.
 */
function crestCurvature(line: DriveLine, i: number): number {
  const a = pointBefore(line, i, CREST_SPAN);
  const b = pointAfter(line, i, CREST_SPAN);
  const runIn = line.dist[i] - line.dist[a];
  const runOut = line.dist[b] - line.dist[i];
  if (!(runIn > 0 && runOut > 0)) return 0;
  const gradeIn = (line.y[i] - line.y[a]) / runIn;
  const gradeOut = (line.y[b] - line.y[i]) / runOut;
  const fall = gradeIn - gradeOut;
  return fall > 0 ? fall / (0.5 * (runIn + runOut)) : 0;
}

/**
 * The fastest each point may be taken (bends, width, crests, open edges, caps), then a backwards sweep so the car
 * is already slow when a bend arrives, braking less hard downhill.
 */
export function planSpeeds(line: DriveLine): void {
  const last = line.count - 1;
  const curvature = line.curvature;
  for (let i = 0; i <= last; i++) curvature[i] = curvatureAt(line, i);
  for (let i = 0; i <= last; i++) {
    let sharpest = 0;
    const from = Math.max(i - CURVATURE_WINDOW, 0);
    const to = Math.min(i + CURVATURE_WINDOW, last);
    for (let j = from; j <= to; j++) sharpest = Math.max(sharpest, curvature[j]);
    const width = clamp(line.halfWidth[i] / FULL_SPEED_HALF_WIDTH, MIN_WIDTH_FACTOR, 1);
    const exposed = nearOpenEdge(line, i);
    const grip = LATERAL_ACCEL * width * (exposed ? OPEN_EDGE_GRIP : 1);
    const cornering = sharpest > 0 ? Math.sqrt(grip / sharpest) : TOP_SPEED;
    let speed = Math.min(clamp(cornering, MIN_SPEED, TOP_SPEED * width), line.cap[i]);
    const crest = crestCurvature(line, i);
    if (crest > 0) {
      const unloading = exposed ? OPEN_EDGE_CREST_UNLOADING : CREST_UNLOADING;
      speed = Math.min(speed, Math.max(MIN_SPEED, Math.sqrt((unloading * GRAVITY) / crest)));
    }
    line.speed[i] = speed;
  }
  for (let i = last - 1; i >= 0; i--) {
    const gap = line.dist[i + 1] - line.dist[i];
    // Uphill (rise > 0) gravity helps the brakes; downhill it works against them.
    const grade = gap > 0 ? (line.y[i + 1] - line.y[i]) / gap : 0;
    const decel = Math.max(MIN_BRAKE_DECEL, BRAKE_DECEL + GRAVITY * grade);
    const entry = Math.sqrt(line.speed[i + 1] * line.speed[i + 1] + 2 * decel * gap);
    if (entry < line.speed[i]) line.speed[i] = entry;
  }
}

/** Replaces the planned speeds with one speed everywhere: a driver who steers with care and never lifts. */
export function holdSpeedEverywhere(line: DriveLine, speed: number): void {
  for (let i = 0; i < line.count; i++) line.speed[i] = speed;
}

/**
 * Drives one car along one line. It remembers where on the line the car was, so use one per car and call `drive`
 * once per tick.
 */
export class LineFollower {
  /** Line point nearest the car when `drive` last ran. */
  index = 0;
  private readonly line: DriveLine;
  private aimX = 0;
  private aimZ = 0;

  constructor(line: DriveLine) {
    this.line = line;
  }

  /** After the line was planned again: puts the follower at the point `dist` metres along the road. */
  seat(dist: number): void {
    const line = this.line;
    const last = line.count - 1;
    let i = 0;
    while (i < last && line.dist[i] < dist) i++;
    this.index = i;
  }

  /**
   * Sets `input.steer`, `input.throttle` and `input.brake` (which the caller has zeroed) to follow the line, and
   * returns the car's progress: its distance along the road, measured on the driving line.
   */
  drive(car: CarState, params: CarParams, input: InputState): number {
    const line = this.line;
    this.locate(car.x, car.z, car.y);
    const index = this.index;
    const along = (car.x - line.x[index]) * line.tx[index] + (car.z - line.z[index]) * line.tz[index];
    const progress = line.dist[index] + along;
    this.aimAt(progress, Math.min(LOOK_AHEAD_BASE + LOOK_AHEAD_PER_SPEED * car.speed, LOOK_AHEAD_MAX));
    this.steerTowardsAim(car, params, input);
    this.holdSpeed(car, input);
    return progress;
  }

  private distanceSqTo(i: number, x: number, z: number): number {
    const dx = this.line.x[i] - x;
    const dz = this.line.z[i] - z;
    return dx * dx + dz * dz;
  }

  /**
   * Finds the car on the line near where it was; anywhere on the line, at the car's level, when it is not near
   * there (it was moved). Heights keep it on its own stretch where the road crosses itself.
   */
  private locate(x: number, z: number, y: number): void {
    const line = this.line;
    const last = line.count - 1;
    const from = Math.max(Math.min(this.index, last) - SEARCH_BACK, 0);
    const to = Math.min(this.index + SEARCH_AHEAD, last);
    this.index = nearestOnLine(line, from, to, x, z, y);
    const reach = line.halfWidth[this.index] + LOST_MARGIN;
    const lost = this.distanceSqTo(this.index, x, z) > reach * reach || !(Math.abs(line.y[this.index] - y) <= HEIGHT_MATCH);
    if (lost) this.index = nearestOnLine(line, 0, last, x, z, y);
  }

  /** Sets the aim point: the place `ahead` metres further along the line than `progress`. */
  private aimAt(progress: number, ahead: number): void {
    const line = this.line;
    const last = line.count - 1;
    const target = progress + ahead;
    let i = Math.max(this.index - 1, 0);
    while (i < last && line.dist[i + 1] <= target) i++;
    if (i === last) {
      const beyond = target - line.dist[last];
      this.aimX = line.x[last] + line.tx[last] * beyond;
      this.aimZ = line.z[last] + line.tz[last] * beyond;
      return;
    }
    const share = clamp((target - line.dist[i]) / (line.dist[i + 1] - line.dist[i]), 0, 1);
    this.aimX = lerp(line.x[i], line.x[i + 1], share);
    this.aimZ = lerp(line.z[i], line.z[i + 1], share);
  }

  private steerTowardsAim(car: CarState, params: CarParams, input: InputState): void {
    const dx = this.aimX - car.x;
    const dz = this.aimZ - car.z;
    const cosH = cos(car.heading);
    const sinH = sin(car.heading);
    const side = dz * cosH - dx * sinH;
    const distSq = dx * dx + dz * dz;
    // Pure pursuit: the arc through the car and the aim point, tangent to the car's heading.
    const arc = distSq > 0 ? (2 * side) / distSq : 0;
    const wheelAngle = atan((params.cgToFront + params.cgToRear) * arc);
    const speedShare = params.steerSpeedRef > 0 ? clamp(car.speed / params.steerSpeedRef, 0, 1) : 1;
    const lock = lerp(params.maxSteer, params.maxSteerAtSpeed, speedShare);
    input.steer = lock > 0 ? clamp(wheelAngle / lock, -1, 1) : 0;
  }

  private holdSpeed(car: CarState, input: InputState): void {
    const line = this.line;
    const index = this.index;
    const target = Math.min(line.speed[index], line.speed[Math.min(index + 1, line.count - 1)]);
    const error = target - car.speed;
    if (error < -BRAKE_DEADBAND) {
      if (car.forwardSpeed > BRAKE_MIN_SPEED) input.brake = clamp(-error * BRAKE_GAIN, 0, 1);
    } else if (error > 0) {
      const sliding = Math.abs(car.driftAngle) > SLIDE_ANGLE;
      const limit = sliding ? SLIDE_THROTTLE : 1 - THROTTLE_STEER_CUT * Math.abs(input.steer);
      input.throttle = clamp(error * THROTTLE_GAIN, 0, limit);
    }
  }
}
