/**
 * Scripted drivers that pin down how the car feels. Each `measure*` function drives one manoeuvre on open, flat
 * ground (the bare car, `stepCar` with ground height 0: no level, no walls) and returns numbers;
 * tests/sim/handling.test.ts holds those numbers inside the bands the handling is tuned for. Every function takes the
 * car's params, so the same drivers can be pointed at a trial tune. The drift feel targets proper are in
 * tests/sim/drift.test.ts (drivers in handlingDrivers.ts).
 */
import type { CarParams, CarState, InputState, Pose } from '../../src/types';
import { DT } from '../../src/types';
import { HALF_PI, atan2, cos, sin, wrapAngle } from '../../src/core/fixedMath';
import { Rng } from '../../src/core/rng';
import { createCarState, stepCar } from '../../src/sim/car';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { holder } from './handlingDrivers';

/** The bare car on endless flat ground: what the handling scenarios drive. */
export interface FlatWorld {
  params: CarParams;
  readonly car: CarState;
  readonly start: Pose;
  step(input: InputState): void;
}

export function createFlatWorld(params: CarParams, start: Pose = { x: 0, z: 0, heading: 0 }): FlatWorld {
  const car = createCarState(start);
  const world: FlatWorld = {
    params,
    car,
    start,
    step(input) {
      stepCar(car, world.params, input, DT);
    },
  };
  return world;
}

export type Driver = (car: CarState, time: number) => Partial<InputState>;
export type Observer = (car: CarState, time: number) => void;

export const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

/** Steps the world for `seconds`, asking `driver` for input before each tick and calling `observe` after it. */
export function drive(world: FlatWorld, seconds: number, driver: Driver, observe?: Observer): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    world.step({ ...IDLE, ...driver(world.car, i * DT) });
    observe?.(world.car, (i + 1) * DT);
  }
}

/** A world whose car is already rolling straight along +x at `speed`. */
export function rolling(speed: number, base: CarParams = DEFAULT_CAR_PARAMS): FlatWorld {
  const world = createFlatWorld(cloneParams(base));
  world.car.vx = speed;
  return world;
}

/** The car as the game sets it up while the steering-assist setting is on. */
export function assistedParams(base: CarParams = DEFAULT_CAR_PARAMS): CarParams {
  const params = cloneParams(base);
  params.steerAssist = ASSIST_STRENGTH;
  return params;
}

const HANDBRAKE_TAP = 0.35;

/** Turn in to the right and tap the handbrake, the beginner's way into a drift. */
function handbrakeEntry(world: FlatWorld, observe?: Observer): void {
  drive(world, HANDBRAKE_TAP, () => ({ steer: 1, handbrake: true }), observe);
}

/**
 * The keyboard drift-holding driver for a right-hand drift (see handlingDrivers.ts): steer into the drift when the
 * angle is short of `target`, let go when it is there, countersteer only when it is well past. It uses the driver
 * that suits the car: the ordinary one with the assist on, the skilled one with it off.
 */
function holdDrift(target: number, params: CarParams): Driver {
  const travel = { angle: 0, rate: 0, primed: false };
  const hold = holder(params);
  return (car) => {
    const angle = atan2(car.vz, car.vx);
    if (!travel.primed) {
      travel.angle = angle;
      travel.primed = true;
    }
    const delta = wrapAngle(angle - travel.angle);
    travel.angle = angle;
    travel.rate = delta / DT;
    return hold(car, car.yawRate - travel.rate, target);
  };
}

export function measureStraight(base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(0, base);
  let timeTo15 = Infinity;
  let timeTo25 = Infinity;
  drive(
    world,
    45,
    () => ({ throttle: 1 }),
    (car, time) => {
      if (car.speed >= 15 && time < timeTo15) timeTo15 = time;
      if (car.speed >= 25 && time < timeTo25) timeTo25 = time;
    },
  );
  const car = world.car;
  return { timeTo15, timeTo25, topSpeed: car.speed, headingDrift: Math.abs(car.heading), z: Math.abs(car.z) };
}

/**
 * A standing start with the throttle pinned and a clumsy dab of steering just as the car gets going: the worst a
 * launch normally sees. Reports how far the tail steps out and whether the car is running straight again later.
 */
export function measureLaunch(base: CarParams = DEFAULT_CAR_PARAMS, assisted = false) {
  const world = rolling(0, assisted ? assistedParams(base) : base);
  let maxDrift = 0;
  let maxYawRate = 0;
  let lateDrift = 0;
  let lateYawRate = 0;
  drive(
    world,
    4,
    (_car, time) => ({ throttle: 1, steer: time > 0.3 && time < 0.5 ? 1 : 0 }),
    (car, time) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
      if (time > 2) {
        lateDrift = Math.max(lateDrift, Math.abs(car.driftAngle));
        lateYawRate = Math.max(lateYawRate, Math.abs(car.yawRate));
      }
    },
  );
  return { maxDrift, maxYawRate, lateDrift, lateYawRate, speed: world.car.speed, heading: world.car.heading };
}

/** Lifting off at speed and coasting with every control released. */
export function measureCoast(base: CarParams = DEFAULT_CAR_PARAMS, speed = 30, seconds = 3) {
  const world = rolling(speed, base);
  drive(world, seconds, () => IDLE);
  return { lost: speed - world.car.speed };
}

export function measureGripCorner(base: CarParams = DEFAULT_CAR_PARAMS, steer = 0.25, speed = 12) {
  const world = rolling(speed, base);
  let maxDrift = 0;
  let maxRearSlide = 0;
  let minYaw = Infinity;
  let maxYaw = -Infinity;
  drive(
    world,
    5,
    () => ({ steer, throttle: 0.25 }),
    (car, time) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxRearSlide = Math.max(maxRearSlide, car.rearSlide);
      if (time > 2) {
        minYaw = Math.min(minYaw, car.yawRate);
        maxYaw = Math.max(maxYaw, car.yawRate);
      }
    },
  );
  return { maxDrift, maxRearSlide, minYaw, maxYaw, speed: world.car.speed };
}

/** Handbrake tap at 22 m/s, then the handbrake is released while the driver keeps `after` applied. */
export function measureHandbrakeEntry(after: Partial<InputState>, base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(22, base);
  let peakDrift = 0;
  const watch: Observer = (car) => {
    peakDrift = Math.max(peakDrift, Math.abs(car.driftAngle));
  };
  handbrakeEntry(world, watch);
  const atRelease = Math.abs(world.car.driftAngle);
  drive(world, 1 - HANDBRAKE_TAP, () => after, watch);
  return { atRelease, peakDrift, speed: world.car.speed };
}

/**
 * Full lock and full throttle from 16 m/s, no assist: the power-over. Reports how far the tail is out early on
 * (`earlyDrift`, the first 0.8 s) and when the drift angle first passes 0.3 rad (`timeToDrift`).
 */
export function measurePowerOver(base: CarParams = DEFAULT_CAR_PARAMS, speed = 16, seconds = 3) {
  const world = rolling(speed, base);
  let maxRearSlide = 0;
  let maxDrift = 0;
  let earlyDrift = 0;
  let timeToDrift = Infinity;
  drive(
    world,
    seconds,
    () => ({ steer: 1, throttle: 1 }),
    (car, time) => {
      const angle = Math.abs(car.driftAngle);
      maxRearSlide = Math.max(maxRearSlide, car.rearSlide);
      maxDrift = Math.max(maxDrift, angle);
      if (time <= 0.8) earlyDrift = Math.max(earlyDrift, angle);
      if (angle > 0.3 && time < timeToDrift) timeToDrift = time;
    },
  );
  return { maxRearSlide, maxDrift, earlyDrift, timeToDrift, speed: world.car.speed };
}

export function measureSustainedDrift(target = 0.7, seconds = 6, base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(22, base);
  handbrakeEntry(world);
  let held = 0;
  let longestHold = 0;
  let maxDrift = 0;
  let minSpeedWhileHeld = Infinity;
  let minSpeedOfLongest = Infinity;
  drive(world, seconds, holdDrift(target, world.params), (car) => {
    const angle = Math.abs(car.driftAngle);
    maxDrift = Math.max(maxDrift, angle);
    if (angle > 0.35 && angle < 1.2) {
      held += DT;
      minSpeedWhileHeld = Math.min(minSpeedWhileHeld, car.speed);
      if (held > longestHold) {
        longestHold = held;
        minSpeedOfLongest = minSpeedWhileHeld;
      }
    } else {
      held = 0;
      minSpeedWhileHeld = Infinity;
    }
  });
  return { longestHold, maxDrift, minSpeed: minSpeedOfLongest, endSpeed: world.car.speed };
}

/**
 * How much speed a held drift costs. Handbrake entry at 22 m/s, then the drift driver holds `target` for three
 * seconds. `kept` is the speed at the end as a share of the 22 m/s the car arrived with; `meanDrift` is the average
 * drift angle over the last two seconds.
 */
export function measureDriftSpeed(target = 0.65, base: CarParams = DEFAULT_CAR_PARAMS) {
  const entrySpeed = 22;
  const world = rolling(entrySpeed, base);
  handbrakeEntry(world);
  let sum = 0;
  let samples = 0;
  let minSpeed = Infinity;
  drive(world, 3, holdDrift(target, world.params), (car, time) => {
    minSpeed = Math.min(minSpeed, car.speed);
    if (time > 1) {
      sum += Math.abs(car.driftAngle);
      samples++;
    }
  });
  return { kept: world.car.speed / entrySpeed, minKept: minSpeed / entrySpeed, meanDrift: sum / samples };
}

export function measureRecovery(base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(22, base);
  handbrakeEntry(world);
  drive(world, 2.15, holdDrift(0.85, world.params));
  const startDrift = world.car.driftAngle;
  let settleTime = 0;
  let overshoot = 0;
  let lateDrift = 0;
  drive(
    world,
    5,
    () => IDLE,
    (car, time) => {
      const angle = Math.abs(car.driftAngle);
      if (angle >= 0.08) settleTime = time;
      if (car.driftAngle * startDrift < 0) overshoot = Math.max(overshoot, angle);
      if (time > 2) lateDrift = Math.max(lateDrift, angle);
    },
  );
  return { startDrift: Math.abs(startDrift), settleTime, overshoot, lateDrift, speed: world.car.speed };
}

export function measureSpin(base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(20, base);
  let maxDrift = 0;
  let maxYawRate = 0;
  const watch: Observer = (car) => {
    maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
    maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
  };
  drive(world, 3, () => ({ steer: 1, throttle: 1, handbrake: true }), watch);
  drive(world, 3, () => IDLE, watch);
  return { maxDrift, maxYawRate, endSpeed: world.car.speed, endYawRate: Math.abs(world.car.yawRate) };
}

export function measureAssist(base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(22, assistedParams(base));
  handbrakeEntry(world);
  let maxDrift = 0;
  let maxYawRate = 0;
  drive(
    world,
    3,
    () => ({ throttle: 0.7 }),
    (car) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
    },
  );
  return { maxDrift, maxYawRate, endDrift: Math.abs(world.car.driftAngle), endSpeed: world.car.speed };
}

/** Full lock and full throttle held for eight seconds from 16 m/s: the laziest possible keyboard driving. */
export function measureHeldPowerSlide(steerAssist: number, base: CarParams = DEFAULT_CAR_PARAMS) {
  const params = cloneParams(base);
  params.steerAssist = steerAssist;
  const world = rolling(16, params);
  let maxDrift = 0;
  drive(world, 8, () => ({ steer: 1, throttle: 1 }), (car) => {
    maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
  });
  return { maxDrift, speed: world.car.speed };
}

/**
 * A keyboard: every control is fully on or fully off. `keys` returns what is held `time` seconds in. Reports the
 * largest drift angle, the time spent in a usable drift (0.35 to 1.2 rad) and how the car ends up.
 */
export function measureKeyboard(
  speed: number,
  seconds: number,
  keys: (time: number) => Partial<InputState>,
  assisted = true,
  base: CarParams = DEFAULT_CAR_PARAMS,
) {
  const world = rolling(speed, assisted ? assistedParams(base) : base);
  let maxDrift = 0;
  let drifting = 0;
  drive(
    world,
    seconds,
    (_car, time) => keys(time),
    (car) => {
      const angle = Math.abs(car.driftAngle);
      maxDrift = Math.max(maxDrift, angle);
      if (angle > 0.35 && angle < 1.2) drifting += DT;
    },
  );
  return { maxDrift, drifting, endDrift: Math.abs(world.car.driftAngle), speed: world.car.speed };
}

/** A straight along +x, a right-hand arc, then a straight again: where the road is `along` metres from the start. */
function bendPoint(along: number, approach: number, radius: number, turn: number, out: { x: number; z: number }): void {
  const arc = radius * turn;
  if (along <= approach) {
    out.x = along;
    out.z = 0;
  } else if (along <= approach + arc) {
    const angle = (along - approach) / radius;
    out.x = approach + radius * sin(angle);
    out.z = radius * (1 - cos(angle));
  } else {
    const past = along - approach - arc;
    out.x = approach + radius * sin(turn) + past * cos(turn);
    out.z = radius * (1 - cos(turn)) + past * sin(turn);
  }
}

/**
 * A keyboard driver (steer -1 / 0 / +1, throttle held down throughout) taking a right-hand bend drawn on the open
 * arena: 30 m of straight, a 90-degree arc of `radius`, then straight on. The driver looks a fixed distance down
 * the road from wherever the car is and presses the key on that side until the nose points at it.
 *
 * Reports the largest drift angle, how wide of the line the car ran, and how it ends up.
 */
export function measureBend(assisted: boolean, base: CarParams = DEFAULT_CAR_PARAMS, speed = 20, radius = 24) {
  const APPROACH = 30;
  const TURN = HALF_PI;
  const LOOK_AHEAD = 12;
  const DEAD_BAND = 0.05;
  const world = rolling(speed, assisted ? assistedParams(base) : base);
  const target = { x: 0, z: 0 };
  const nearest = { x: 0, z: 0 };
  let along = 0;
  let maxDrift = 0;
  let maxYawRate = 0;
  let widest = 0;
  drive(
    world,
    6,
    (car) => {
      // Progress along the road: move the nearest point forwards while that brings it closer to the car.
      for (let i = 0; i < 200; i++) {
        bendPoint(along, APPROACH, radius, TURN, nearest);
        const here = (car.x - nearest.x) ** 2 + (car.z - nearest.z) ** 2;
        bendPoint(along + 0.25, APPROACH, radius, TURN, nearest);
        if ((car.x - nearest.x) ** 2 + (car.z - nearest.z) ** 2 >= here) break;
        along += 0.25;
      }
      bendPoint(along + LOOK_AHEAD, APPROACH, radius, TURN, target);
      const bearing = wrapAngle(atan2(target.z - car.z, target.x - car.x) - car.heading);
      return { throttle: 1, steer: bearing > DEAD_BAND ? 1 : bearing < -DEAD_BAND ? -1 : 0 };
    },
    (car) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
      bendPoint(along, APPROACH, radius, TURN, nearest);
      widest = Math.max(widest, Math.sqrt((car.x - nearest.x) ** 2 + (car.z - nearest.z) ** 2));
    },
  );
  const car = world.car;
  return { maxDrift, maxYawRate, widest, endDrift: Math.abs(car.driftAngle), speed: car.speed, along };
}

/**
 * Quick left-right-left stabs of full lock at 25 m/s with the throttle pinned, each key held for `hold` seconds,
 * then hands off. The pendulum that a nervous keyboard driver sets up.
 */
export function measureFlicks(hold: number, assisted = true, base: CarParams = DEFAULT_CAR_PARAMS, speed = 25) {
  const world = rolling(speed, assisted ? assistedParams(base) : base);
  let maxDrift = 0;
  let maxYawRate = 0;
  drive(
    world,
    3 * hold + 4,
    (_car, time) => {
      const stab = Math.floor(time / hold);
      return { throttle: 1, steer: stab > 2 ? 0 : stab === 1 ? 1 : -1 };
    },
    (car) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
    },
  );
  return { maxDrift, maxYawRate, endDrift: Math.abs(world.car.driftAngle), speed: world.car.speed };
}

/**
 * Lift-off oversteer: a steady corner near the limit at about 24 m/s with the throttle holding the speed, then the
 * driver snaps the throttle shut and keeps the wheel where it was.
 */
export function measureLiftOff(base: CarParams = DEFAULT_CAR_PARAMS, assisted = false, steer = 0.07) {
  const world = rolling(24, assisted ? assistedParams(base) : base);
  let before = 0;
  drive(
    world,
    3,
    (car) => ({ steer, throttle: car.speed < 24 ? 0.6 : 0.2 }),
    (car, time) => {
      if (time > 2) before = Math.max(before, Math.abs(car.driftAngle));
    },
  );
  let after = 0;
  let maxYawRate = 0;
  drive(world, 3, () => ({ steer }), (car) => {
    after = Math.max(after, Math.abs(car.driftAngle));
    maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
  });
  return { before, after, maxYawRate, speed: world.car.speed };
}

/** Mistakes (no assist): flooring it in a slide with the key still held into it, and holding opposite lock too long. */
export function measureMistakes(base: CarParams = DEFAULT_CAR_PARAMS) {
  const floored = rolling(22, base);
  handbrakeEntry(floored);
  let flooredMaxDrift = 0;
  drive(floored, 4, () => ({ throttle: 1, steer: 1 }), (car) => {
    flooredMaxDrift = Math.max(flooredMaxDrift, Math.abs(car.driftAngle));
  });

  const corrected = rolling(22, base);
  handbrakeEntry(corrected);
  drive(corrected, 2, holdDrift(0.7, corrected.params));
  const before = corrected.car.driftAngle;
  let swungTo = 0;
  drive(corrected, 2.5, () => ({ steer: -1, throttle: 0.5 }), (car) => {
    if (car.driftAngle * before < 0) swungTo = Math.max(swungTo, Math.abs(car.driftAngle));
  });
  return { flooredMaxDrift, before: Math.abs(before), swungTo };
}

/** Flicking the wheel from side to side at 35 m/s with the throttle pinned. */
export function measureSlalom(base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = rolling(35, base);
  let maxDrift = 0;
  let maxYawRate = 0;
  drive(
    world,
    6,
    (_car, time) => ({ steer: Math.floor(time / 0.6) % 2 === 0 ? 0.5 : -0.5, throttle: 1 }),
    (car) => {
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
    },
  );
  return { maxDrift, maxYawRate, speed: world.car.speed };
}

export function isFiniteState(car: CarState): boolean {
  return Object.values(car).every((value) => typeof value !== 'number' || Number.isFinite(value));
}

/** A minute of a driver who mostly keeps the throttle down and changes their mind twice a second. */
export function measureRandomDriving(seed: string, seconds = 60, base: CarParams = DEFAULT_CAR_PARAMS) {
  const world = createFlatWorld(cloneParams(base));
  const rng = new Rng(seed);
  let held: Partial<InputState> = {};
  let finite = true;
  let maxSpeed = 0;
  let maxYawRate = 0;
  let airborne = false;
  drive(
    world,
    seconds,
    (_car, time) => {
      if (Math.round(time / DT) % 60 === 0) {
        const steer = rng.range(-1, 1);
        held = {
          steer: steer * steer * steer,
          throttle: rng.chance(0.9) ? rng.range(0.5, 1) : 0,
          brake: rng.chance(0.1) ? rng.next() : 0,
          handbrake: rng.chance(0.1),
        };
      }
      return held;
    },
    (car) => {
      finite = finite && isFiniteState(car);
      maxSpeed = Math.max(maxSpeed, car.speed);
      maxYawRate = Math.max(maxYawRate, Math.abs(car.yawRate));
      airborne = airborne || car.airborne || car.y !== 0 || car.vy !== 0;
    },
  );
  return { finite, maxSpeed, maxYawRate, airborne };
}
