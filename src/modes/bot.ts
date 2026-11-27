/**
 * A deterministic driver that follows the road: the driveability gate for generated levels, and the seed of the
 * NPC racers. It grips rather than drifts, because its job is to arrive.
 *
 * Everything about the level is worked out once, in `planLine`: a driving line (the centreline, bent around
 * pillars towards their open side) and a speed for every point of it. Per tick the driver only finds itself on
 * that line, steers at a point further along it (pure pursuit) and holds the planned speed.
 */
import { atan, clamp, cos, lerp, sin, smoothstep } from '../core/fixedMath';
import type { InputState, Level, Prop, RunState, World } from '../types';
import { SIM_HZ } from '../types';

const TOP_SPEED = 30;
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

const STUCK_TICKS = 4 * SIM_HZ;
/** Metres along the road that count as getting somewhere. */
const PROGRESS_STEP = 1;
/** Points searched behind and ahead of the last known position. */
const SEARCH_BACK = 6;
const SEARCH_AHEAD = 24;
/** Further than this from every searched point means the car was moved (respawn): search the whole line. */
const LOST_MARGIN = 8;

interface Line {
  count: number;
  /** Driving line. */
  x: Float64Array;
  z: Float64Array;
  /** Unit direction of travel at each point. */
  tx: Float64Array;
  tz: Float64Array;
  /** Distance along the centreline. */
  dist: Float64Array;
  halfWidth: Float64Array;
  speed: Float64Array;
}

/** Starts the line on the centreline, and works out the direction of travel at each point. */
function readCentreline(level: Level, line: Line): void {
  const path = level.path;
  const last = path.length - 1;
  for (let i = 0; i <= last; i++) {
    line.x[i] = path[i].x;
    line.z[i] = path[i].z;
    line.dist[i] = path[i].dist;
    line.halfWidth[i] = path[i].halfWidth;
    const a = path[Math.max(i - 1, 0)];
    const b = path[Math.min(i + 1, last)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    line.tx[i] = length > 0 ? dx / length : 1;
    line.tz[i] = length > 0 ? dz / length : 0;
  }
}

/** Index of the line point nearest to (x, z) among from..to. */
function nearestOnLine(line: Line, from: number, to: number, x: number, z: number): number {
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
function addDodge(level: Level, line: Line, prop: Prop, offsets: Float64Array): void {
  const at = nearestOnLine(line, 0, line.count - 1, prop.x, prop.z);
  const p = level.path[at];
  const dx = prop.x - p.x;
  const dz = prop.z - p.z;
  const along = p.dist + dx * line.tx[at] + dz * line.tz[at];
  const lateral = dz * line.tx[at] - dx * line.tz[at];
  const offset = dodgeOffset(lateral, prop.radius, p.halfWidth);
  if (offset === 0) return;
  for (let i = 0; i < line.count; i++) {
    const s = line.dist[i] - along;
    if (s < -DODGE_LEAD || s > DODGE_TAIL) continue;
    const share = s < 0 ? smoothstep(-DODGE_LEAD, -DODGE_HOLD, s) : 1 - smoothstep(DODGE_HOLD, DODGE_TAIL, s);
    offsets[i] += offset * share;
  }
}

function layLine(level: Level, line: Line): void {
  const offsets = new Float64Array(line.count);
  for (const prop of level.props) addDodge(level, line, prop, offsets);
  for (let i = 0; i < line.count; i++) {
    const p = level.path[i];
    const reach = Math.max(0, p.halfWidth - WALL_CLEARANCE);
    const offset = clamp(offsets[i], -reach, reach);
    line.x[i] = p.x - line.tz[i] * offset;
    line.z[i] = p.z + line.tx[i] * offset;
  }
}

/** Curvature (1/m) of the circle through three neighbouring points of the driving line. */
function curvatureAt(line: Line, i: number): number {
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
function planSpeeds(line: Line): void {
  const last = line.count - 1;
  const curvature = new Float64Array(line.count);
  for (let i = 0; i <= last; i++) curvature[i] = curvatureAt(line, i);
  for (let i = 0; i <= last; i++) {
    let sharpest = 0;
    const from = Math.max(i - CURVATURE_WINDOW, 0);
    const to = Math.min(i + CURVATURE_WINDOW, last);
    for (let j = from; j <= to; j++) sharpest = Math.max(sharpest, curvature[j]);
    const width = clamp(line.halfWidth[i] / FULL_SPEED_HALF_WIDTH, MIN_WIDTH_FACTOR, 1);
    const cornering = sharpest > 0 ? Math.sqrt((LATERAL_ACCEL * width) / sharpest) : TOP_SPEED;
    line.speed[i] = clamp(cornering, MIN_SPEED, TOP_SPEED * width);
  }
  for (let i = last - 1; i >= 0; i--) {
    const gap = line.dist[i + 1] - line.dist[i];
    const entry = Math.sqrt(line.speed[i + 1] * line.speed[i + 1] + 2 * BRAKE_DECEL * gap);
    if (entry < line.speed[i]) line.speed[i] = entry;
  }
}

function planLine(level: Level): Line {
  const count = level.path.length;
  const line: Line = {
    count,
    x: new Float64Array(count),
    z: new Float64Array(count),
    tx: new Float64Array(count),
    tz: new Float64Array(count),
    dist: new Float64Array(count),
    halfWidth: new Float64Array(count),
    speed: new Float64Array(count),
  };
  readCentreline(level, line);
  layLine(level, line);
  planSpeeds(line);
  return line;
}

function distanceSqTo(line: Line, i: number, x: number, z: number): number {
  const dx = line.x[i] - x;
  const dz = line.z[i] - z;
  return dx * dx + dz * dz;
}

/**
 * The driver for one level. It keeps a little memory between calls (where it was, when it last got somewhere), so
 * use one bot per car and call it once per tick.
 */
export function createBot(level: Level): (world: World, run: RunState) => InputState {
  const line = planLine(level);
  const last = line.count - 1;
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  let index = 0;
  let furthest = 0;
  let progressTick = 0;
  let seenResets = 0;
  let seenTicks = -1;
  let aimX = 0;
  let aimZ = 0;

  function locate(x: number, z: number): void {
    const from = Math.max(index - SEARCH_BACK, 0);
    const to = Math.min(index + SEARCH_AHEAD, last);
    index = nearestOnLine(line, from, to, x, z);
    const reach = line.halfWidth[index] + LOST_MARGIN;
    if (distanceSqTo(line, index, x, z) > reach * reach) index = nearestOnLine(line, 0, last, x, z);
  }

  /** Sets the aim point: the place `ahead` metres further along the line than `progress`. */
  function aimAt(progress: number, ahead: number): void {
    const target = progress + ahead;
    let i = Math.max(index - 1, 0);
    while (i < last && line.dist[i + 1] <= target) i++;
    if (i === last) {
      const beyond = target - line.dist[last];
      aimX = line.x[last] + line.tx[last] * beyond;
      aimZ = line.z[last] + line.tz[last] * beyond;
      return;
    }
    const share = clamp((target - line.dist[i]) / (line.dist[i + 1] - line.dist[i]), 0, 1);
    aimX = lerp(line.x[i], line.x[i + 1], share);
    aimZ = lerp(line.z[i], line.z[i + 1], share);
  }

  /** True when the car has gone nowhere for too long. Respawns and restarts start the clock again. */
  function isStuck(run: RunState, progress: number): boolean {
    const moved = run.resets !== seenResets || run.ticks < seenTicks;
    seenResets = run.resets;
    seenTicks = run.ticks;
    if (moved || progress > furthest + PROGRESS_STEP) {
      furthest = progress;
      progressTick = run.ticks;
      return false;
    }
    if (run.ticks - progressTick < STUCK_TICKS) return false;
    progressTick = run.ticks;
    return true;
  }

  function steerTowardsAim(world: World): void {
    const car = world.car;
    const params = world.params;
    const dx = aimX - car.x;
    const dz = aimZ - car.z;
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

  function holdSpeed(world: World): void {
    const car = world.car;
    const target = Math.min(line.speed[index], line.speed[Math.min(index + 1, last)]);
    const error = target - car.speed;
    if (error < -BRAKE_DEADBAND) {
      if (car.forwardSpeed > BRAKE_MIN_SPEED) input.brake = clamp(-error * BRAKE_GAIN, 0, 1);
    } else if (error > 0) {
      const sliding = Math.abs(car.driftAngle) > SLIDE_ANGLE;
      const limit = sliding ? SLIDE_THROTTLE : 1 - THROTTLE_STEER_CUT * Math.abs(input.steer);
      input.throttle = clamp(error * THROTTLE_GAIN, 0, limit);
    }
  }

  return (world: World, run: RunState): InputState => {
    input.steer = 0;
    input.throttle = 0;
    input.brake = 0;
    input.reset = false;
    if (run.phase !== 'running') return input;

    const car = world.car;
    locate(car.x, car.z);
    const along = (car.x - line.x[index]) * line.tx[index] + (car.z - line.z[index]) * line.tz[index];
    const progress = line.dist[index] + along;
    input.reset = isStuck(run, progress);
    aimAt(progress, Math.min(LOOK_AHEAD_BASE + LOOK_AHEAD_PER_SPEED * car.speed, LOOK_AHEAD_MAX));
    steerTowardsAim(world);
    holdSpeed(world);
    return input;
  };
}
