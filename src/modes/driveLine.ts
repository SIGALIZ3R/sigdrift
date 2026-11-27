/**
 * The driving line that the bots follow, and the hands and feet that follow it. Shared by the weekly bot (one line
 * for the whole level, planned once) and the endless bot (one line over the live chunks, planned again whenever
 * the road grows).
 *
 * A line is planned in four steps:
 *   1. `clearLine`, then `appendPath` for every stretch of centreline;
 *   2. `beginPlan`, which works out the direction of travel at each point;
 *   3. any number of `addDodge` (a pillar to pass on its open side) and `capSpeed` (a stretch to take slowly);
 *   4. `layLine` and `planSpeeds`.
 * Per tick a `LineFollower` only finds the car on that line, steers at a point further along it (pure pursuit) and
 * holds the planned speed. Nothing here allocates once the line has its arrays.
 */
import { atan, clamp, cos, lerp, sin, smoothstep } from '../core/fixedMath';
import type { CarParams, CarState, InputState, PathPoint, Prop } from '../types';

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
  halfWidth: Float64Array;
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
  line.halfWidth = grow(line.halfWidth);
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
    halfWidth: none,
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

/** Appends `path[from..]` to the centreline. Pass 1 for a chunk whose first point repeats the previous chunk's last. */
export function appendPath(line: DriveLine, path: readonly PathPoint[], from = 0): void {
  const needed = line.count + path.length - from;
  if (needed > line.x.length) allocate(line, Math.max(needed, 2 * line.x.length));
  let at = line.count;
  for (let i = from; i < path.length; i++) {
    const p = path[i];
    line.x[at] = p.x;
    line.z[at] = p.z;
    line.dist[at] = p.dist;
    line.halfWidth[at] = p.halfWidth;
    at++;
  }
  line.count = at;
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

/** Index of the line point nearest to (x, z) among from..to. */
function nearestOnLine(line: DriveLine, from: number, to: number, x: number, z: number): number {
  let best = from;
  let bestSq = Infinity;
  for (let i = from; i <= to; i++) {
    const dx = line.x[i] - x;
    const dz = line.z[i] - z;
    const sq = dx * dx + dz * dz;
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
export function stationOf(line: DriveLine, x: number, z: number): number {
  const at = nearestOnLine(line, 0, line.count - 1, x, z);
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
  const at = nearestOnLine(line, 0, line.count - 1, prop.x, prop.z);
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

/** Moves the line off the centreline by the dodges collected so far, never closer to a wall than it should be. */
export function layLine(line: DriveLine): void {
  for (let i = 0; i < line.count; i++) {
    const reach = Math.max(0, line.halfWidth[i] - WALL_CLEARANCE);
    const offset = clamp(line.offset[i], -reach, reach);
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

/** The fastest each point may be taken, then a backwards sweep so the car is already slow when a bend arrives. */
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
    const cornering = sharpest > 0 ? Math.sqrt((LATERAL_ACCEL * width) / sharpest) : TOP_SPEED;
    line.speed[i] = Math.min(clamp(cornering, MIN_SPEED, TOP_SPEED * width), line.cap[i]);
  }
  for (let i = last - 1; i >= 0; i--) {
    const gap = line.dist[i + 1] - line.dist[i];
    const entry = Math.sqrt(line.speed[i + 1] * line.speed[i + 1] + 2 * BRAKE_DECEL * gap);
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
    this.locate(car.x, car.z);
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

  private locate(x: number, z: number): void {
    const line = this.line;
    const last = line.count - 1;
    const from = Math.max(Math.min(this.index, last) - SEARCH_BACK, 0);
    const to = Math.min(this.index + SEARCH_AHEAD, last);
    this.index = nearestOnLine(line, from, to, x, z);
    const reach = line.halfWidth[this.index] + LOST_MARGIN;
    if (this.distanceSqTo(this.index, x, z) > reach * reach) this.index = nearestOnLine(line, 0, last, x, z);
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
