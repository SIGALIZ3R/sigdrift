import { thrustShare } from '../sim/car';
import type { CarParams, CarState } from '../types';

/**
 * The powertrain the engine sound is built on: a small high-revving four-cylinder with a six-speed automatic.
 * It is only ever heard, never felt: the physics has no gears. Everything here is pure (no WebAudio), so the
 * shift logic and the rev behaviour can be unit-tested.
 */

export const IDLE_RPM = 900;
export const REDLINE_RPM = 7500;
/** Fuel cut. Just under the redline, as on a road car. */
export const LIMITER_RPM = 7400;
/** Change up once the road speed takes the current gear past this. */
export const UPSHIFT_RPM = 7150;
/** Change down once the next gear down would sit below this. Well under UPSHIFT_RPM, so shifts never hunt. */
export const DOWNSHIFT_RPM = 5400;

/** Close-ratio six-speed. Each step drops the revs by 38 %, 30 %, 22 %, 18 %, 17 %. */
export const GEAR_RATIOS: readonly number[] = [3.36, 2.09, 1.47, 1.15, 0.94, 0.78];
export const REVERSE_RATIO = 3.2;
export const TOP_GEAR = GEAR_RATIOS.length - 1;
/** `Powertrain.gear` while reverse is selected. */
export const REVERSE_GEAR = -1;

/** Top gear reaches the redline at this multiple of the car's estimated top speed, so it never runs out of revs. */
const TOP_GEAR_MARGIN = 1.08;
const MIN_TOP_SPEED = 25;
const MAX_TOP_SPEED = 70;

/** How long a shift cuts the drive, s. */
export const SHIFT_TIME = 0.09;
/** No further shift for this long after one starts, s. */
const SHIFT_LOCKOUT = 0.26;
const UPSHIFT_TORQUE = 0.1;
const UPSHIFT_GATE = 0.45;
/** A down-change is rev-matched with a blip of throttle, so it keeps some bark. */
const DOWNSHIFT_TORQUE = 0.45;
const DOWNSHIFT_GATE = 0.8;

/** Full-throttle clutch-slip revs with the car standing still. */
const LAUNCH_RPM = 5000;
/** Wheel-side revs at which the clutch stops slipping in first and reverse. */
const CLUTCH_LOCK_RPM = 4200;
/** With the handbrake on the clutch is in: the throttle revs the engine up to this, short of the limiter. */
const HANDBRAKE_REV_RPM = 6900;
/** In the air the unloaded wheels let the engine run up to this, i.e. into the limiter. */
const FREE_REV_RPM = 7900;

/** rpm/s. Unloaded, an engine this small gains and loses revs quickly. */
const FREE_RISE = 14000;
const FREE_FALL = 4200;
/** Clutch in, handbrake on. */
const HANDBRAKE_RISE = 8000;
/** Wheels in the air: the engine has the whole driveline to spin up. */
const AIR_RISE = 5200;
const AIR_FALL = 1400;
/** Clutch locked: the revs are the wheels' revs. Still finite, so a wall hit is a fast fall instead of a step. */
const LOCKED_RATE = 40000;
/** A shift's rev change is never slower than this. */
const MIN_SHIFT_RATE = 6000;

/**
 * Extra driven-wheel speed (m/s) at full throttle and full rear slide: a base plus a share of the car's speed.
 * Enough that a hard slide near the top of a gear reaches the limiter, not so much that every slide does.
 */
const WHEELSPIN_BASE = 1.6;
const WHEELSPIN_PER_SPEED = 0.06;

/** How long the limiter cuts the fuel each time the revs touch it, s. */
const LIMITER_CUT = 0.03;
const LIMITER_FALL = 7000;
/** Within this many rpm of the limiter the revs climb no faster than LIMITER_RISE, which sets the stutter rate. */
const LIMITER_BAND = 260;
const LIMITER_RISE = 6000;
const LIMITER_GATE = 0.4;

export interface DriveInput {
  /** Velocity along the car's nose, m/s. */
  forwardSpeed: number;
  /** |velocity|, m/s. */
  speed: number;
  /** 0..1 pedal driving the engine: the throttle, or the brake pedal while reverse is selected. */
  throttle: number;
  /** 0..1 */
  rearSlide: number;
  handbrake: boolean;
  airborne: boolean;
  reverse: boolean;
  /** Estimated top speed of the car, m/s (see `estimateTopSpeed`). Sets the overall gearing. */
  topSpeed: number;
}

export interface Powertrain {
  /** 0-based forward gear, or REVERSE_GEAR. */
  gear: number;
  rpm: number;
  /** 0..1 how hard the engine is working right now: the throttle, less shift and limiter cuts. Drives the timbre. */
  torque: number;
  /** 0..1 loudness multiplier: below 1 during a shift and while the limiter is cutting. */
  gate: number;
  /** 0..1 clutch engagement. */
  clutch: number;
  /** True while the limiter is cutting fuel. */
  limiting: boolean;
  /** Seconds left of the current shift (0 when not shifting). */
  shiftTimer: number;
  /** +1 while changing up, -1 while changing down, 0 otherwise. */
  shiftDir: number;
  /** Total number of shifts so far. */
  shifts: number;

  // internal
  shiftRate: number;
  lockout: number;
  limiterTimer: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function createPowertrain(): Powertrain {
  return {
    gear: 0,
    rpm: IDLE_RPM,
    torque: 0,
    gate: 1,
    clutch: 0,
    limiting: false,
    shiftTimer: 0,
    shiftDir: 0,
    shifts: 0,
    shiftRate: 0,
    lockout: 0,
    limiterTimer: 0,
  };
}

export function createDriveInput(): DriveInput {
  return {
    forwardSpeed: 0,
    speed: 0,
    throttle: 0,
    rearSlide: 0,
    handbrake: false,
    airborne: false,
    reverse: false,
    topSpeed: MIN_TOP_SPEED,
  };
}

const TOP_SPEED_STEP = 0.25;
let topSpeedForce = Number.NaN;
let topSpeedDrag = Number.NaN;
let topSpeedRolling = Number.NaN;
let topSpeedResult = MIN_TOP_SPEED;

/**
 * The speed at which the car stops gaining: where the physics' full-throttle thrust (`thrustShare`, which already
 * falls away with speed) no longer beats drag and rolling resistance. Kept within a sane range. The answer is
 * remembered until one of the three parameters changes, so calling this every frame costs three comparisons.
 */
export function estimateTopSpeed(params: CarParams): number {
  const force = params.engineForce;
  const drag = params.drag;
  const rolling = params.rollingResistance;
  if (force === topSpeedForce && drag === topSpeedDrag && rolling === topSpeedRolling) return topSpeedResult;
  let top = MAX_TOP_SPEED;
  for (let v = MIN_TOP_SPEED; v <= MAX_TOP_SPEED; v += TOP_SPEED_STEP) {
    if (!(force * thrustShare(v) > (rolling + drag * v) * v)) {
      top = Math.max(MIN_TOP_SPEED, v - TOP_SPEED_STEP);
      break;
    }
  }
  topSpeedForce = force;
  topSpeedDrag = drag;
  topSpeedRolling = rolling;
  topSpeedResult = top;
  return top;
}

/** Engine rpm per m/s of wheel speed in a gear with the given ratio. */
export function rpmPerSpeed(ratio: number, topSpeed: number): number {
  return (ratio * REDLINE_RPM) / (topSpeed * TOP_GEAR_MARGIN * GEAR_RATIOS[TOP_GEAR]);
}

/** Road speed (m/s) at which forward gear `gear` reaches `rpm`. */
export function gearSpeedAt(gear: number, rpm: number, topSpeed: number): number {
  return rpm / rpmPerSpeed(GEAR_RATIOS[gear], topSpeed);
}

/** Fill `out` from the car's state. Non-finite values (never expected) read as zero. */
export function readDrive(car: CarState, params: CarParams, out: DriveInput): DriveInput {
  const reverse = car.reversing === true;
  const pedal = reverse ? car.brake : car.throttle;
  out.forwardSpeed = Number.isFinite(car.forwardSpeed) ? car.forwardSpeed : 0;
  out.speed = Number.isFinite(car.speed) ? car.speed : 0;
  out.throttle = pedal > 0 ? Math.min(pedal, 1) : 0;
  out.rearSlide = car.rearSlide > 0 ? Math.min(car.rearSlide, 1) : 0;
  out.handbrake = car.handbrake === true;
  out.airborne = car.airborne === true;
  out.reverse = reverse;
  out.topSpeed = estimateTopSpeed(params);
  return out;
}

function beginShift(pt: Powertrain, gear: number, wheelSpeed: number, perSpeed: number): void {
  const dir = gear > pt.gear ? 1 : -1;
  pt.gear = gear;
  pt.shiftDir = dir;
  pt.shiftTimer = SHIFT_TIME;
  pt.lockout = SHIFT_LOCKOUT;
  pt.shifts++;
  const landing = Math.max(IDLE_RPM, wheelSpeed * perSpeed * GEAR_RATIOS[gear]);
  pt.shiftRate = Math.max(MIN_SHIFT_RATE, Math.abs(landing - pt.rpm) / SHIFT_TIME);
}

/**
 * Pick the gear for the road speed. Changing up goes one gear at a time; changing down goes straight to the gear
 * that fits (after a wall hit that can be several). Wheelspin does not count: a sliding car holds its gear and
 * runs into the limiter instead, which is what a drift sounds like.
 */
function selectGear(pt: Powertrain, drive: DriveInput, roadSpeed: number, perSpeed: number): void {
  if (drive.reverse) {
    if (pt.gear !== REVERSE_GEAR) {
      pt.gear = REVERSE_GEAR;
      pt.shiftTimer = 0;
      pt.shiftDir = 0;
    }
    return;
  }
  if (pt.gear === REVERSE_GEAR) {
    pt.gear = 0;
    pt.shiftTimer = 0;
    pt.shiftDir = 0;
  }
  // The gearbox holds its gear while the wheels are off the ground: their speed says nothing about the road.
  if (pt.lockout > 0 || drive.airborne) return;

  const gear = pt.gear;
  if (gear < TOP_GEAR && roadSpeed * perSpeed * GEAR_RATIOS[gear] > UPSHIFT_RPM) {
    beginShift(pt, gear + 1, roadSpeed, perSpeed);
    return;
  }
  let target = gear;
  while (target > 0 && roadSpeed * perSpeed * GEAR_RATIOS[target - 1] < DOWNSHIFT_RPM) target--;
  if (target !== gear) beginShift(pt, target, roadSpeed, perSpeed);
}

/**
 * Advance the powertrain by `dt` seconds (any step from a 120 Hz tick to a slow rendered frame). Mutates `pt`.
 */
export function stepPowertrain(pt: Powertrain, drive: DriveInput, dt: number): void {
  if (!(dt > 0)) return;
  const throttle = clamp(drive.throttle, 0, 1);
  const perSpeed = rpmPerSpeed(1, drive.topSpeed);

  if (pt.lockout > 0) pt.lockout = Math.max(0, pt.lockout - dt);

  // Only motion in the selected direction turns the driven wheels the engine's way.
  const roadSpeed = Math.max(0, drive.reverse ? -drive.forwardSpeed : drive.forwardSpeed);
  selectGear(pt, drive, roadSpeed, perSpeed);

  const ratio = pt.gear === REVERSE_GEAR ? REVERSE_RATIO : GEAR_RATIOS[pt.gear];
  const slide = clamp(drive.rearSlide, 0, 1);
  const spin = throttle * slide * slide * (WHEELSPIN_BASE + WHEELSPIN_PER_SPEED * Math.max(0, drive.speed));
  let roadRpm = roadSpeed * perSpeed * ratio;
  // With no gear left to change into, road speed alone never reaches the limiter: the revs just stop climbing.
  if ((pt.gear === TOP_GEAR || pt.gear === REVERSE_GEAR) && roadRpm > UPSHIFT_RPM) roadRpm = UPSHIFT_RPM;
  const wheelRpm = roadRpm + spin * perSpeed * ratio;

  let target: number;
  let rise: number;
  let fall: number;
  let clutch: number;
  if (drive.airborne) {
    // Nothing holds the wheels back: the revs climb for as long as the throttle is held and sink slowly without it.
    clutch = 0;
    const base = Math.max(IDLE_RPM, roadRpm);
    target = base + throttle * Math.max(0, FREE_REV_RPM - base);
    rise = AIR_RISE * throttle + AIR_FALL;
    fall = AIR_FALL;
  } else if (drive.handbrake) {
    clutch = 0;
    target = IDLE_RPM + throttle * (HANDBRAKE_REV_RPM - IDLE_RPM);
    rise = HANDBRAKE_RISE * throttle;
    fall = FREE_FALL;
  } else {
    // First and reverse slip the clutch off the line: revs flare towards LAUNCH_RPM, then settle onto the wheels.
    clutch = pt.gear <= 0 ? clamp(wheelRpm / CLUTCH_LOCK_RPM, 0, 1) : 1;
    const flare = IDLE_RPM + throttle * (LAUNCH_RPM - IDLE_RPM);
    target = Math.max(IDLE_RPM, wheelRpm + Math.max(0, flare - wheelRpm) * (1 - clutch));
    rise = FREE_RISE * throttle + (LOCKED_RATE - FREE_RISE * throttle) * clutch;
    fall = FREE_FALL + (LOCKED_RATE - FREE_FALL) * clutch;
  }

  let torque = throttle;
  let gate = 1;

  if (pt.shiftTimer > 0) {
    pt.shiftTimer = Math.max(0, pt.shiftTimer - dt);
    rise = pt.shiftRate;
    fall = pt.shiftRate;
    if (pt.shiftDir > 0) {
      torque = throttle * UPSHIFT_TORQUE;
      gate = UPSHIFT_GATE;
    } else {
      torque = Math.max(throttle, DOWNSHIFT_TORQUE);
      gate = DOWNSHIFT_GATE;
    }
    if (pt.shiftTimer === 0) pt.shiftDir = 0;
  }

  let rpm = pt.rpm;
  if (pt.limiterTimer > 0) {
    // Fuel cut: the revs sag whatever the throttle is doing, then the engine catches again.
    pt.limiterTimer = Math.max(0, pt.limiterTimer - dt);
    rpm = target >= rpm ? rpm - LIMITER_FALL * dt : Math.max(target, rpm - Math.max(fall, LIMITER_FALL) * dt);
    torque = 0;
    gate = Math.min(gate, LIMITER_GATE);
    pt.limiting = true;
  } else {
    pt.limiting = false;
    if (rpm > LIMITER_RPM - LIMITER_BAND && rise > LIMITER_RISE) rise = LIMITER_RISE;
    if (target > rpm) rpm = Math.min(target, rpm + rise * dt);
    else rpm = Math.max(target, rpm - fall * dt);
    if (rpm >= LIMITER_RPM) {
      rpm = LIMITER_RPM;
      pt.limiterTimer = LIMITER_CUT;
    }
  }

  pt.rpm = clamp(rpm, IDLE_RPM, LIMITER_RPM);
  pt.torque = torque;
  pt.gate = gate;
  pt.clutch = clutch;
}
