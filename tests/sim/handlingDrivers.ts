/**
 * Drift-feel harness: scripted KEYBOARD drivers (steer -1 / 0 / +1, throttle on/off, handbrake on/off) with a human
 * reaction lag, driving the bare car (`stepCar`) on flat ground. No world, no walls, no level: the tuning targets in
 * tests/sim/drift.test.ts depend on nothing but src/sim/car.ts, tire.ts and params.ts.
 *
 * Sign conventions (see src/types.ts): heading increases to the right, steer +1 is right. `nose` below is the angle
 * of the car's nose relative to its direction of travel, positive when the nose points right of travel, i.e.
 * `nose = -driftAngle`. A right-hand drift has a positive nose.
 */
import type { CarParams, CarState, InputState } from '../../src/types';
import { DT } from '../../src/types';
import { atan2, clamp, cos, sin, wrapAngle } from '../../src/core/fixedMath';
import { Rng } from '../../src/core/rng';
import { createCarState, stepCar } from '../../src/sim/car';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';

export type Stepper = (car: CarState, params: CarParams, input: InputState, dt: number) => void;

let stepper: Stepper = stepCar;

/** Points the harness at another car implementation (used only to measure a previous version for comparison). */
export function useStepper(next: Stepper | null): void {
  stepper = next ?? stepCar;
}

export interface Keys {
  steer: number;
  throttle: number;
  brake?: number;
  handbrake?: boolean;
}

export type Policy = (car: CarState, time: number) => Keys;
export type Watch = (car: CarState, time: number) => void;

export interface FlatSim {
  car: CarState;
  params: CarParams;
  time: number;
}

export function carParams(assisted: boolean, base: CarParams = DEFAULT_CAR_PARAMS): CarParams {
  const params = cloneParams(base);
  params.steerAssist = assisted ? ASSIST_STRENGTH : 0;
  return params;
}

/** A car rolling straight along +x at `speed` on flat ground. */
export function flat(speed: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS): FlatSim {
  const car = createCarState({ x: 0, z: 0, heading: 0 });
  car.vx = speed;
  car.speed = Math.abs(speed);
  car.forwardSpeed = speed;
  return { car, params: carParams(assisted, base), time: 0 };
}

const INPUT: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

export function stepKeys(sim: FlatSim, keys: Keys): void {
  INPUT.steer = keys.steer;
  INPUT.throttle = keys.throttle;
  INPUT.brake = keys.brake ?? 0;
  INPUT.handbrake = keys.handbrake === true;
  stepper(sim.car, sim.params, INPUT, DT);
  sim.time += DT;
}

/**
 * Drives for `seconds`. The policy looks at the car every tick, but what it decides only reaches the controls `lag`
 * seconds later (a human's reaction time). Open-loop scripts use lag 0.
 */
export function run(sim: FlatSim, seconds: number, policy: Policy, lag = 0, watch?: Watch): void {
  const delay = new Lag(lag);
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    stepKeys(sim, delay.pass(policy(sim.car, sim.time)));
    watch?.(sim.car, sim.time);
  }
}

/** A reaction delay: what goes in comes out `seconds` later (the first decision is held until then). */
export class Lag {
  private readonly queue: Keys[] = [];
  private readonly ticks: number;
  constructor(seconds: number) {
    this.ticks = Math.max(0, Math.round(seconds / DT));
  }
  pass(keys: Keys): Keys {
    this.queue.push(keys);
    return this.queue.length > this.ticks ? this.queue.shift()! : this.queue[0];
  }
}

/** Nose angle relative to travel, positive = nose right of travel (a right-hand drift). */
export function nose(car: CarState): number {
  return -car.driftAngle;
}

/** Travel direction, unwrapped across calls. */
export class TravelTracker {
  angle: number;
  rate = 0;
  constructor(car: CarState) {
    this.angle = car.speed > 0.5 ? atan2(car.vz, car.vx) : car.heading;
  }
  update(car: CarState): void {
    if (car.speed < 0.5) {
      this.rate = 0;
      return;
    }
    const raw = atan2(car.vz, car.vx);
    const delta = wrapAngle(raw - wrapAngle(this.angle));
    this.angle += delta;
    this.rate = delta / DT;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The drift-holding keyboard driver
// ---------------------------------------------------------------------------------------------------------------

export interface DriftDriverOptions {
  /** How far ahead (s) the driver predicts the nose angle from its current rate of change. */
  anticipation: number;
  /** Below `want - band` the driver steers into the drift; above `want + counterBand` it countersteers. */
  band: number;
  counterBand: number;
  /** Nose angle (rad) beyond which the throttle is eased to `liftThrottle`. */
  liftAngle: number;
  liftThrottle: number;
}

export const DRIFT_DRIVER: DriftDriverOptions = { anticipation: 0.22, band: 0.07, counterBand: 0.2, liftAngle: 1.0, liftThrottle: 0 };
/**
 * The same driver, skilled enough for the car without the assist: it looks further ahead, steers into the drift a
 * little earlier, almost never countersteers (released keys let the wheels caster down the road, which is the
 * catch) and keeps its foot in.
 */
export const SKILLED_DRIVER: DriftDriverOptions = { anticipation: 0.4, band: 0.05, counterBand: 0.3, liftAngle: 1.3, liftThrottle: 0 };

/**
 * Keyboard steering towards a wanted nose angle (positive = right-hand drift): steer into the drift when the
 * predicted angle is short of it, countersteer when it is past it, let go in between. Throttle on unless the angle
 * runs well past what is wanted.
 */
export function driftKeys(
  car: CarState,
  noseRate: number,
  want: number,
  options: DriftDriverOptions = DRIFT_DRIVER,
): Keys {
  const now = nose(car);
  const predicted = now + noseRate * options.anticipation;
  const side = want > 0 ? 1 : want < 0 ? -1 : predicted > 0 ? 1 : -1;
  let steer = 0;
  if (predicted < want - options.band) steer = 1;
  else if (predicted > want + options.counterBand) steer = -1;
  const deep = side * predicted > options.liftAngle;
  return { steer, throttle: deep ? options.liftThrottle : 1 };
}

export type Holder = (car: CarState, noseRate: number, want: number) => Keys;

/** The drift-holding driver that suits the car: DRIFT_DRIVER with the assist on, SKILLED_DRIVER with it off. */
export function holder(params: CarParams): Holder {
  const options = params.steerAssist > 0 ? DRIFT_DRIVER : SKILLED_DRIVER;
  return (car, noseRate, want) => driftKeys(car, noseRate, want, options);
}

// ---------------------------------------------------------------------------------------------------------------
// Corner course: straight along +x, a right-hand arc, straight out again
// ---------------------------------------------------------------------------------------------------------------

export interface Corner {
  approach: number;
  radius: number;
  /** Turn angle, rad. */
  turn: number;
  exit: number;
}

export function cornerPoint(c: Corner, along: number, out: { x: number; z: number }): void {
  const arc = c.radius * c.turn;
  if (along <= c.approach) {
    out.x = along;
    out.z = 0;
  } else if (along <= c.approach + arc) {
    const angle = (along - c.approach) / c.radius;
    out.x = c.approach + c.radius * sin(angle);
    out.z = c.radius * (1 - cos(angle));
  } else {
    const past = along - c.approach - arc;
    out.x = c.approach + c.radius * sin(c.turn) + past * cos(c.turn);
    out.z = c.radius * (1 - cos(c.turn)) + past * sin(c.turn);
  }
}

export interface CornerResult {
  spun: boolean;
  maxNose: number;
  /** Largest distance from the course's centreline, m. */
  maxOff: number;
  entrySpeed: number;
  /** Speed when the car is 15 m past the end of the arc. */
  exitSpeed: number;
  minSpeed: number;
  finished: boolean;
  time: number;
}

export interface CornerDriverOptions extends DriftDriverOptions {
  /** Look-ahead time along the road, s (bounded below by `minLook` m). */
  lookTime: number;
  minLook: number;
  /** Wanted nose angle per radian of bearing to the look-ahead point, and its cap. */
  gain: number;
  maxWant: number;
  /** Handbrake tap length (s) at turn-in, 0 for none, and the bearing (rad) that triggers it. */
  handbrakeTap: number;
  handbrakeBearing: number;
  /**
   * Speed management: the driver knows how hard the car can corner in a drift (m/s2) and how hard it brakes, and
   * brakes on the approach (lifts in the corner) when it is faster than sqrt(cornerAccel x radius).
   */
  cornerAccel: number;
  brakeDecel: number;
}

export const CORNER_DRIVER: CornerDriverOptions = {
  ...DRIFT_DRIVER,
  lookTime: 0.55,
  minLook: 9,
  gain: 2.2,
  maxWant: 0.85,
  handbrakeTap: 0,
  handbrakeBearing: 0.25,
  cornerAccel: 11,
  brakeDecel: 9,
};

/**
 * A keyboard driver taking `corner` from `entrySpeed`: it looks down the road, works out how far its direction of
 * travel must still turn, and asks for that much nose angle (drift) from the drift driver. Ends 15 m after the arc.
 */
export function driveCorner(
  corner: Corner,
  entrySpeed: number,
  lag: number,
  assisted = true,
  options: CornerDriverOptions = CORNER_DRIVER,
  base: CarParams = DEFAULT_CAR_PARAMS,
): CornerResult {
  const sim = flat(entrySpeed, assisted, base);
  const travel = new TravelTracker(sim.car);
  const near = { x: 0, z: 0 };
  const target = { x: 0, z: 0 };
  const end = corner.approach + corner.radius * corner.turn;
  let along = 0;
  let spun = false;
  let maxNose = 0;
  let maxOff = 0;
  let exitSpeed = -1;
  let minSpeed = Infinity;
  let tapUntil = -1;
  let tapped = false;
  const progress = (car: CarState): void => {
    for (let i = 0; i < 400; i++) {
      cornerPoint(corner, along, near);
      const here = (car.x - near.x) ** 2 + (car.z - near.z) ** 2;
      cornerPoint(corner, along + 0.2, near);
      if ((car.x - near.x) ** 2 + (car.z - near.z) ** 2 >= here) break;
      along += 0.2;
    }
  };
  const policy: Policy = (car, time) => {
    progress(car);
    const look = Math.max(options.minLook, options.lookTime * car.speed);
    cornerPoint(corner, along + look, target);
    const bearing = wrapAngle(atan2(target.z - car.z, target.x - car.x) - travel.angle);
    const want = clamp(options.gain * bearing, -options.maxWant, options.maxWant);
    const keys = driftKeys(car, car.yawRate - travel.rate, want, options);
    const cornerSpeed = Math.sqrt(options.cornerAccel * corner.radius);
    const toCorner = corner.approach - along;
    if (along < end && car.speed > cornerSpeed) {
      if (toCorner > 0 && car.speed * car.speed - cornerSpeed * cornerSpeed > 2 * options.brakeDecel * (toCorner - 2)) {
        keys.throttle = 0;
        keys.brake = 1;
      } else if (toCorner <= 0 && car.speed > 1.05 * cornerSpeed) keys.throttle = 0;
    }
    if (!tapped && options.handbrakeTap > 0 && bearing > options.handbrakeBearing && car.speed > 12) {
      tapped = true;
      tapUntil = time + options.handbrakeTap;
    }
    if (time < tapUntil) return { steer: 1, throttle: keys.throttle, handbrake: true };
    return keys;
  };
  const delay = new Lag(lag);
  const limit = (end + 15) / Math.max(5, 0.5 * entrySpeed) + 4;
  while (sim.time < limit && along < end + 15) {
    stepKeys(sim, delay.pass(policy(sim.car, sim.time)));
    const car = sim.car;
    travel.update(car);
    const n = Math.abs(car.driftAngle);
    maxNose = Math.max(maxNose, n);
    if (n > SPIN_ANGLE && car.speed > 3) spun = true;
    minSpeed = Math.min(minSpeed, car.speed);
    cornerPoint(corner, along, near);
    if (along > 1) maxOff = Math.max(maxOff, Math.sqrt((car.x - near.x) ** 2 + (car.z - near.z) ** 2));
  }
  if (along >= end + 15) exitSpeed = sim.car.speed;
  return { spun, maxNose, maxOff, entrySpeed, exitSpeed, minSpeed, finished: exitSpeed >= 0, time: sim.time };
}

/** Drift angle (rad) past which a car counts as spun. */
export const SPIN_ANGLE = 1.45;

export { Rng };

// ---------------------------------------------------------------------------------------------------------------
// Measurements for the feel targets (see tests/sim/drift.test.ts)
// ---------------------------------------------------------------------------------------------------------------

/** First time a condition held, or Infinity. */
function firstTime(current: number, time: number, hit: boolean): number {
  return hit && time < current ? time : current;
}

/**
 * (a) Turn-in: throttle held, full right steer held for `steerFor` seconds then released (Infinity = held
 * throughout). Times are from the moment the key goes down.
 */
export function measureTurnIn(
  speed: number,
  steerFor: number,
  assisted = true,
  base: CarParams = DEFAULT_CAR_PARAMS,
  catchAt = Infinity,
  lag = 0,
) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  let caught = false;
  const hold = holder(sim.params);
  let timeTo035 = Infinity;
  let peakYaw = 0;
  let peakNose = 0;
  let travelAt12 = 0;
  let frontSum = 0;
  let rearSum = 0;
  let frontAtCommit = -1;
  let rearAtCommit = -1;
  run(
    sim,
    2,
    (car, time) => {
      if (caught || nose(car) > catchAt) {
        caught = true;
        return hold(car, car.yawRate - travel.rate, 0.7);
      }
      return { steer: time < steerFor ? 1 : 0, throttle: 1 };
    },
    lag,
    (car, time) => {
      travel.update(car);
      const n = nose(car);
      if (time <= 1.2) {
        peakYaw = Math.max(peakYaw, car.yawRate);
        travelAt12 = travel.angle;
      }
      peakNose = Math.max(peakNose, n);
      if (time <= 0.7) {
        frontSum += car.frontSlide;
        rearSum += car.rearSlide;
      }
      if (n > 0.35 && timeTo035 === Infinity) {
        frontAtCommit = car.frontSlide;
        rearAtCommit = car.rearSlide;
      }
      timeTo035 = firstTime(timeTo035, time, n > 0.35);
    },
  );
  return {
    timeTo035,
    peakYaw,
    peakNose,
    travelDeg12: (travelAt12 * 180) / Math.PI,
    meanFront: frontSum / 84,
    meanRear: rearSum / 84,
    frontAtCommit,
    rearAtCommit,
    endSpeed: sim.car.speed,
  };
}

/**
 * (c) Sustained drift: from `speed`, the keyboard drift driver asks for `want` rad of right-hand drift for `seconds`.
 * Reports the longest stretch held inside [lo, hi] and the slowest speed during it.
 */
export function measureSustained(
  speed: number,
  want: number,
  seconds: number,
  lag: number,
  assisted = true,
  lo = 0.5,
  hi = 1.0,
  base: CarParams = DEFAULT_CAR_PARAMS,
  options: DriftDriverOptions = DRIFT_DRIVER,
) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  let held = 0;
  let longest = 0;
  let minSpeedRun = Infinity;
  let minSpeedLongest = Infinity;
  let maxNose = 0;
  let spun = false;
  let sumNose = 0;
  let samples = 0;
  run(
    sim,
    seconds,
    (car) => driftKeys(car, car.yawRate - travel.rate, want, assisted ? options : SKILLED_DRIVER),
    lag,
    (car, time) => {
      travel.update(car);
      const n = nose(car);
      maxNose = Math.max(maxNose, Math.abs(n));
      if (Math.abs(n) > SPIN_ANGLE && car.speed > 3) spun = true;
      if (time > 2) {
        sumNose += n;
        samples++;
      }
      if (n >= lo && n <= hi) {
        held += DT;
        minSpeedRun = Math.min(minSpeedRun, car.speed);
        if (held > longest) {
          longest = held;
          minSpeedLongest = minSpeedRun;
        }
      } else {
        held = 0;
        minSpeedRun = Infinity;
      }
    },
  );
  return { longest, minSpeed: minSpeedLongest, maxNose, spun, meanNose: sumNose / Math.max(1, samples), endSpeed: sim.car.speed };
}

/**
 * (d) Handbrake entry at `speed`: full right steer with the handbrake for `tap` s, then steer + throttle held.
 */
export function measureHandbrakeTap(speed: number, tap = 0.3, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  let caught = false;
  let timeTo06 = Infinity;
  let atRelease = 0;
  let minAfter = Infinity;
  let maxAfter = 0;
  let minSpeed = Infinity;
  let peakNose = 0;
  run(
    sim,
    2,
    (car, time) =>
      time < tap
        ? { steer: 1, throttle: 1, handbrake: true }
        : assisted || !(caught = caught || nose(car) > 0.6)
          ? { steer: 1, throttle: 1 }
          : driftKeys(car, car.yawRate - travel.rate, 0.75, SKILLED_DRIVER),
    0,
    (car, time) => {
      travel.update(car);
      const n = nose(car);
      timeTo06 = firstTime(timeTo06, time, n > 0.6);
      if (time <= tap) atRelease = n;
      else if (time <= tap + 0.6) {
        minAfter = Math.min(minAfter, n);
        maxAfter = Math.max(maxAfter, n);
      }
      if (time <= 1) minSpeed = Math.min(minSpeed, car.speed);
      peakNose = Math.max(peakNose, Math.abs(n));
    },
  );
  return { timeTo06, atRelease, minAfter, maxAfter, speedLoss: 1 - minSpeed / speed, peakNose };
}

/**
 * (e) Switchback: hold a right-hand drift (driver asks for 0.7 rad), then at `switchAt` s steer left with the throttle
 * on until the nose is 0.35 rad the other way, then hold a left-hand drift of 0.7 rad.
 */
export function measureSwitchback(speed: number, switchAt: number, lag: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  let swapped = false;
  let swapTime = Infinity;
  const hold = holder(sim.params);
  let rightPeak = 0;
  let spun = false;
  run(
    sim,
    switchAt + 3,
    (car, time) => {
      const rate = car.yawRate - travel.rate;
      if (time < switchAt) return hold(car, rate, 0.7);
      if (!swapped && nose(car) > -0.35) return { steer: -1, throttle: 1 };
      swapped = true;
      return hold(car, rate, -0.7);
    },
    lag,
    (car, time) => {
      travel.update(car);
      const n = nose(car);
      if (time < switchAt) rightPeak = Math.max(rightPeak, n);
      if (time >= switchAt) swapTime = firstTime(swapTime, time - switchAt, n < -0.35);
      if (Math.abs(n) > SPIN_ANGLE && car.speed > 3) spun = true;
    },
  );
  return { rightPeak, swapTime, spun, endNose: nose(sim.car), endSpeed: sim.car.speed };
}

/** (f) Recovery: build a right-hand drift of about 0.7 rad, then lift off and centre. Time until |nose| < 0.1. */
export function measureRecoveryFrom(speed: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  let start = 0;
  // Hold a drift until it is at about 0.7 rad and steady.
  run(sim, 4, (car) => driftKeys(car, car.yawRate - travel.rate, 0.75), 0, (car) => travel.update(car));
  for (let i = 0; i < 240 && Math.abs(nose(sim.car) - 0.7) > 0.04; i++) {
    stepKeys(sim, driftKeys(sim.car, sim.car.yawRate - travel.rate, 0.7));
    travel.update(sim.car);
  }
  start = nose(sim.car);
  let settle = Infinity;
  let overshoot = 0;
  let late = 0;
  const t0 = sim.time;
  run(sim, 3, () => ({ steer: 0, throttle: 0 }), 0, (car, time) => {
    const n = nose(car);
    if (Math.abs(n) < 0.1 && settle === Infinity) settle = time - t0;
    if (Math.abs(n) >= 0.1) settle = Infinity;
    if (n < 0) overshoot = Math.max(overshoot, -n);
    if (time - t0 > 2) late = Math.max(late, Math.abs(n));
  });
  return { start, settle, overshoot, late, speed: sim.car.speed };
}

/** (f) Keys released mid-drift but the throttle kept on: how long until the car runs straight (< 0.087 rad). */
export function measureKeyRelease(speed: number, throttle: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  const travel = new TravelTracker(sim.car);
  run(sim, 3, (car) => driftKeys(car, car.yawRate - travel.rate, 0.75), 0, (car) => travel.update(car));
  const start = nose(sim.car);
  const t0 = sim.time;
  let settle = Infinity;
  let overshoot = 0;
  run(sim, 3, () => ({ steer: 0, throttle }), 0, (car, time) => {
    const n = nose(car);
    if (Math.abs(n) < 0.087 && settle === Infinity) settle = time - t0;
    if (Math.abs(n) >= 0.087) settle = Infinity;
    if (n < 0) overshoot = Math.max(overshoot, -n);
  });
  return { start, settle, overshoot };
}

/** (f) Everything held at once: full steer, full throttle and the handbrake for `seconds` from `speed`. */
export function measureAllHeld(speed: number, seconds = 2, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  let maxNose = 0;
  let maxYaw = 0;
  run(sim, seconds, () => ({ steer: 1, throttle: 1, handbrake: true }), 0, (car) => {
    maxNose = Math.max(maxNose, Math.abs(nose(car)));
    maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
  });
  run(sim, 3, () => ({ steer: 0, throttle: 0 }), 0, (car) => {
    maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
  });
  return { maxNose, maxYaw, endYaw: Math.abs(sim.car.yawRate), endSpeed: sim.car.speed };
}

/** (f) Gentle analogue steering at `speed`, throttle holding the speed. */
export function measureGentle(speed: number, steer: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, assisted, base);
  let maxNose = 0;
  let maxRear = 0;
  let minYaw = Infinity;
  run(sim, 4, (car) => ({ steer, throttle: car.speed < speed ? 0.5 : 0.15 }), 0, (car, time) => {
    maxNose = Math.max(maxNose, Math.abs(nose(car)));
    maxRear = Math.max(maxRear, car.rearSlide);
    if (time > 1.5) minYaw = Math.min(minYaw, car.yawRate);
  });
  return { maxNose, maxRear, minYaw };
}

/** (h) Straight line from rest with the throttle pinned. */
export function measureLaunchLine(assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(0, assisted, base);
  let timeTo25 = Infinity;
  let maxNose = 0;
  run(sim, 40, () => ({ steer: 0, throttle: 1 }), 0, (car, time) => {
    timeTo25 = firstTime(timeTo25, time, car.speed >= 25);
    maxNose = Math.max(maxNose, Math.abs(nose(car)), Math.abs(car.heading));
  });
  return { timeTo25, top: sim.car.speed, maxNose, z: Math.abs(sim.car.z) };
}

export function measureCoastLoss(speed = 30, seconds = 3, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(speed, true, base);
  run(sim, seconds, () => ({ steer: 0, throttle: 0 }));
  return speed - sim.car.speed;
}

/** (i) A minute of random keyboard driving on open flat ground. */
export function measureRandomKeys(seed: string, seconds = 60, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS) {
  const sim = flat(0, assisted, base);
  const rng = new Rng(seed);
  let held: Keys = { steer: 0, throttle: 0 };
  let finite = true;
  let maxSpeed = 0;
  let maxYaw = 0;
  run(
    sim,
    seconds,
    (_car, time) => {
      if (Math.round(time / DT) % 40 === 0) {
        held = {
          steer: rng.pick([-1, 0, 1]),
          throttle: rng.chance(0.85) ? 1 : 0,
          brake: rng.chance(0.1) ? 1 : 0,
          handbrake: rng.chance(0.12),
        };
      }
      return held;
    },
    0,
    (car) => {
      finite = finite && Object.values(car).every((v) => typeof v !== 'number' || Number.isFinite(v));
      maxSpeed = Math.max(maxSpeed, car.speed);
      maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
    },
  );
  const c = sim.car;
  return { finite, maxSpeed, maxYaw, hash: [c.x, c.z, c.heading, c.vx, c.vz, c.yawRate, c.steerAngle].join(',') };
}

/** Seeded variations for the robustness targets: entry speed within ±spread and a reaction lag of 60..160 ms. */
export function variations(seed: string, count: number, speed: number, spread = 0.15) {
  const rng = new Rng(seed);
  const out: { speed: number; lag: number; extra: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ speed: speed * (1 + rng.range(-spread, spread)), lag: rng.range(0.06, 0.16), extra: rng.next() });
  }
  return out;
}
