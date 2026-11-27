/**
 * Scripted drivers that pin down how the car feels. Each `measure*` function drives one manoeuvre on a huge empty
 * arena and returns numbers; the tests below hold those numbers inside the bands the handling is tuned for.
 */
import { describe, expect, it } from 'vitest';
import type { CarParams, CarState, InputState, World } from '../../src/types';
import { DT } from '../../src/types';
import { clamp } from '../../src/core/fixedMath';
import { Rng } from '../../src/core/rng';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel } from '../helpers/handLevel';

const ARENA = makeOpenLevel(6000);
const SMALL_ARENA = makeOpenLevel(160);

type Driver = (car: CarState, time: number) => Partial<InputState>;
type Observer = (car: CarState, time: number) => void;

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

/** Steps the world for `seconds`, asking `driver` for input before each tick and calling `observe` after it. */
function drive(world: World, seconds: number, driver: Driver, observe?: Observer): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    world.step({ ...IDLE, ...driver(world.car, i * DT) });
    observe?.(world.car, (i + 1) * DT);
  }
}

/** A world whose car is already rolling straight along +x at `speed`. */
function rolling(speed: number, params: CarParams = cloneParams(DEFAULT_CAR_PARAMS)): World {
  const world = createWorld(ARENA, params);
  world.car.vx = speed;
  return world;
}

const HANDBRAKE_TAP = 0.35;

/** Turn in to the right and tap the handbrake, the beginner's way into a drift. */
function handbrakeEntry(world: World, observe?: Observer): void {
  drive(world, HANDBRAKE_TAP, () => ({ steer: 1, handbrake: true }), observe);
}

/**
 * A simple drift-holding driver for a right-hand drift. It countersteers in proportion to the drift angle, steers
 * (and feeds throttle) towards the target angle on top of that, and backs off when the angle is growing fast.
 * Being proportional it settles a little short of the target.
 */
function holdDrift(target: number): Driver {
  let previous = -1;
  return (car) => {
    const angle = Math.abs(car.driftAngle);
    const growth = previous < 0 ? 0 : (angle - previous) / DT;
    previous = angle;
    const error = target - angle;
    return {
      steer: clamp(2 * error - 0.3 * growth - angle / DEFAULT_CAR_PARAMS.maxSteer, -1, 1),
      throttle: clamp(0.7 + 0.8 * error, 0.5, 0.9),
    };
  };
}

function measureStraight() {
  const world = rolling(0);
  let timeTo25 = Infinity;
  drive(
    world,
    45,
    () => ({ throttle: 1 }),
    (car, time) => {
      if (car.speed >= 25 && time < timeTo25) timeTo25 = time;
    },
  );
  return { timeTo25, topSpeed: world.car.speed, headingDrift: Math.abs(world.car.heading), z: Math.abs(world.car.z) };
}

function measureGripCorner() {
  const world = rolling(12);
  let maxDrift = 0;
  let maxRearSlide = 0;
  let minYaw = Infinity;
  let maxYaw = -Infinity;
  drive(
    world,
    5,
    () => ({ steer: 0.5, throttle: 0.25 }),
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
function measureHandbrakeEntry(after: Partial<InputState>) {
  const world = rolling(22);
  let peakDrift = 0;
  const watch: Observer = (car) => {
    peakDrift = Math.max(peakDrift, Math.abs(car.driftAngle));
  };
  handbrakeEntry(world, watch);
  const atRelease = Math.abs(world.car.driftAngle);
  drive(world, 1 - HANDBRAKE_TAP, () => after, watch);
  return { atRelease, peakDrift, speed: world.car.speed };
}

function measurePowerOver() {
  const world = rolling(16);
  let maxRearSlide = 0;
  let maxDrift = 0;
  drive(
    world,
    1.5,
    () => ({ steer: 1, throttle: 1 }),
    (car) => {
      maxRearSlide = Math.max(maxRearSlide, car.rearSlide);
      maxDrift = Math.max(maxDrift, Math.abs(car.driftAngle));
    },
  );
  return { maxRearSlide, maxDrift, speed: world.car.speed };
}

function measureSustainedDrift(target = 0.7, seconds = 6) {
  const world = rolling(22);
  handbrakeEntry(world);
  let held = 0;
  let longestHold = 0;
  let maxDrift = 0;
  let minSpeedWhileHeld = Infinity;
  let minSpeedOfLongest = Infinity;
  drive(world, seconds, holdDrift(target), (car) => {
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

function measureRecovery() {
  const world = rolling(22);
  handbrakeEntry(world);
  drive(world, 2.15, holdDrift(0.85));
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

function measureSpin() {
  const world = rolling(20);
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

/** The car as the game sets it up while the steering-assist setting is on. */
function assistedParams(): CarParams {
  const params = cloneParams(DEFAULT_CAR_PARAMS);
  params.steerAssist = ASSIST_STRENGTH;
  return params;
}

function measureAssist() {
  const world = rolling(22, assistedParams());
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
function measureHeldPowerSlide(steerAssist: number) {
  const params = cloneParams(DEFAULT_CAR_PARAMS);
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
function measureKeyboard(speed: number, seconds: number, keys: (time: number) => Partial<InputState>, assisted = true) {
  const world = rolling(speed, assisted ? assistedParams() : cloneParams(DEFAULT_CAR_PARAMS));
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

/** Mistakes: flooring it in a slide with the wheel straight, and holding full opposite lock for too long. */
function measureMistakes() {
  const floored = rolling(22);
  handbrakeEntry(floored);
  let flooredMaxDrift = 0;
  drive(floored, 4, () => ({ throttle: 1 }), (car) => {
    flooredMaxDrift = Math.max(flooredMaxDrift, Math.abs(car.driftAngle));
  });

  const corrected = rolling(22);
  handbrakeEntry(corrected);
  drive(corrected, 2, holdDrift(0.7));
  const before = corrected.car.driftAngle;
  let swungTo = 0;
  drive(corrected, 2.5, () => ({ steer: -1, throttle: 0.5 }), (car) => {
    if (car.driftAngle * before < 0) swungTo = Math.max(swungTo, Math.abs(car.driftAngle));
  });
  return { flooredMaxDrift, before: Math.abs(before), swungTo };
}

/** Flicking the wheel from side to side at 35 m/s with the throttle pinned. */
function measureSlalom() {
  const world = rolling(35);
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

function isFiniteState(car: CarState): boolean {
  return Object.values(car).every((value) => typeof value !== 'number' || Number.isFinite(value));
}

/** A minute of a driver who mostly keeps the throttle down and changes their mind twice a second. */
function measureRandomDriving(seed: string, seconds = 60) {
  const world = createWorld(SMALL_ARENA);
  const rng = new Rng(seed);
  let held: Partial<InputState> = {};
  let finite = true;
  let maxSpeed = 0;
  let maxYawRate = 0;
  let wallHits = 0;
  let maxOutside = -Infinity;
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
      const { maxX, maxZ } = SMALL_ARENA.bounds;
      maxOutside = Math.max(maxOutside, Math.abs(car.x) - maxX, Math.abs(car.z) - maxZ);
      if (world.lastCollision) wallHits++;
    },
  );
  return { finite, maxSpeed, maxYawRate, wallHits, maxOutside };
}

describe('straight line', () => {
  const m = measureStraight();

  it('reaches 25 m/s in 3.5 to 5.5 s', () => {
    expect(m.timeTo25).toBeGreaterThan(3.5);
    expect(m.timeTo25).toBeLessThan(5.5);
  });

  it('tops out between 38 and 46 m/s', () => {
    expect(m.topSpeed).toBeGreaterThan(38);
    expect(m.topSpeed).toBeLessThan(46);
  });

  it('tracks straight', () => {
    expect(m.headingDrift).toBeLessThan(0.01);
    expect(m.z).toBeLessThan(0.01);
  });
});

describe('grip', () => {
  it('corners without sliding when driven gently', () => {
    const m = measureGripCorner();
    expect(m.maxDrift).toBeLessThan(0.12);
    expect(m.maxRearSlide).toBeLessThan(0.2);
    expect(m.minYaw).toBeGreaterThan(0.2);
    // Steady: the yaw rate settles instead of hunting.
    expect(m.maxYaw - m.minYaw).toBeLessThan(0.25 * m.maxYaw);
  });

  it('wags its tail but does not spin when flicked about at speed', () => {
    const m = measureSlalom();
    expect(m.maxDrift).toBeGreaterThan(0.1);
    expect(m.maxDrift).toBeLessThan(0.5);
    expect(m.speed).toBeGreaterThan(35);
  });
});

describe('drift', () => {
  it('starts with a handbrake tap while turning in', () => {
    const m = measureHandbrakeEntry({ steer: 1, throttle: 0.6 });
    expect(m.peakDrift).toBeGreaterThan(0.45);
    expect(m.peakDrift).toBeLessThan(1.2);
  });

  it('keeps coming round after the tap even with every control released', () => {
    const m = measureHandbrakeEntry({});
    expect(m.peakDrift).toBeGreaterThan(0.45);
    expect(m.peakDrift).toBeLessThan(1.2);
  });

  it('starts with steering and power alone', () => {
    const m = measurePowerOver();
    expect(m.maxRearSlide).toBeGreaterThan(0.5);
    expect(m.maxDrift).toBeGreaterThan(0.3);
  });

  it.each([0.6, 0.7, 0.9])('can be held with countersteer and throttle (driver aiming for %f rad)', (target) => {
    const m = measureSustainedDrift(target);
    expect(m.longestHold).toBeGreaterThan(3);
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.minSpeed).toBeGreaterThan(9);
  });

  it('recovers when the driver lifts off and centres the wheel', () => {
    const m = measureRecovery();
    expect(m.startDrift).toBeGreaterThan(0.6);
    expect(m.startDrift).toBeLessThan(0.85);
    expect(m.settleTime).toBeLessThan(2);
    expect(m.overshoot).toBeLessThan(0.5 * m.startDrift);
    expect(m.lateDrift).toBeLessThan(0.08);
  });

  it('spins when everything is held at once, then calms down', () => {
    const m = measureSpin();
    expect(m.maxDrift).toBeGreaterThan(1.6);
    expect(m.maxYawRate).toBeLessThan(6);
    expect(m.endYawRate).toBeLessThan(0.5);
    expect(m.endSpeed).toBeLessThan(25);
  });

  it('punishes flooring it in a slide and holding opposite lock too long', () => {
    const m = measureMistakes();
    expect(m.flooredMaxDrift).toBeGreaterThan(1.6);
    expect(m.before).toBeGreaterThan(0.35);
    expect(m.swungTo).toBeGreaterThan(1);
  });

  it('does not spin with full steering assist and no manual countersteer', () => {
    const m = measureAssist();
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.maxYawRate).toBeLessThan(6);
  });

  it('is caught by the steering assist when full lock and full throttle are simply held', () => {
    const unaided = measureHeldPowerSlide(0);
    const assisted = measureHeldPowerSlide(ASSIST_STRENGTH);
    expect(unaided.maxDrift).toBeGreaterThan(1.6);
    expect(assisted.maxDrift).toBeGreaterThan(0.3);
    expect(assisted.maxDrift).toBeLessThan(1.2);
    expect(assisted.speed).toBeGreaterThan(20);
  });
});

/**
 * The game ships with the steering assist on, and most players drive it with on/off keys. Everything here runs at
 * ASSIST_STRENGTH, the value the game really applies, with digital inputs only.
 */
describe('keyboard driving with the assist setting on', () => {
  const SPEEDS = [8, 12, 16, 20, 24, 28];

  it('ships the assist at full strength', () => {
    // Anything less leaves the front tyres on their grip peak in a slide: see ASSIST_STRENGTH in src/sim/params.ts.
    expect(ASSIST_STRENGTH).toBe(1);
  });

  it.each(SPEEDS)('does not spin when throttle and full lock are simply held from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 8, () => ({ steer: 1, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.speed).toBeGreaterThan(20);
  });

  it.each(SPEEDS)('straightens up after a corner taken with the throttle held from %d m/s', (speed) => {
    // The novice corner: throttle down throughout, steer for a second and a half, then let go of the steering.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
    expect(m.speed).toBeGreaterThan(25);
  });

  it.each(SPEEDS)('catches a handbrake entry from %d m/s with nothing but the throttle', (speed) => {
    const m = measureKeyboard(speed, 5, (time) => (time < 0.3 ? { steer: 1, handbrake: true } : { throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([12, 16, 20, 24])('holds a real drift after a handbrake entry from %d m/s with the keys held', (speed) => {
    // Being catchable must not mean being dull: the same keys still give a long, deep slide.
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.3 ? { steer: 1, handbrake: true } : { steer: 1, throttle: 1 },
    );
    expect(m.maxDrift).toBeGreaterThan(0.6);
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.drifting).toBeGreaterThan(1.5);
  });

  it.each([12, 16, 20, 24])('survives a late, clumsy stab of opposite lock from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 6, (time) =>
      time < 1.5 ? { steer: 1, throttle: 1 } : time < 1.8 ? { steer: -1, throttle: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([12, 16, 20, 24])('still spins the same held corner from %d m/s with the assist off', (speed) => {
    // The assist is what makes the keys forgiving. Without it the slide has to be caught by hand.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }), false);
    expect(m.maxDrift).toBeGreaterThan(1.6);
  });

  it.each([12, 16, 20, 24])('can be saved from %d m/s with the assist off by lifting off in time', (speed) => {
    const m = measureKeyboard(speed, 6, (time) => (time < 1.5 ? { steer: 1, throttle: 1 } : {}), false);
    expect(m.maxDrift).toBeGreaterThan(0.35);
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });
});

describe('stability', () => {
  it.each(['chaos-1', 'chaos-2', 'chaos-3', 'chaos-4'])('stays finite and bounded under random inputs (%s)', (seed) => {
    const m = measureRandomDriving(seed);
    expect(m.finite).toBe(true);
    expect(m.maxSpeed).toBeLessThan(60);
    expect(m.maxYawRate).toBeLessThan(8);
    expect(m.maxOutside).toBeLessThan(0);
    // The arena is small enough that a minute of this always finds a wall.
    expect(m.wallHits).toBeGreaterThan(0);
  });

  it('stays exactly still at rest', () => {
    const world = rolling(0);
    drive(world, 5, () => IDLE);
    expect(world.car.x).toBe(ARENA.start.x);
    expect(world.car.z).toBe(ARENA.start.z);
    expect(world.car.heading).toBe(ARENA.start.heading);
    expect(world.car.speed).toBe(0);
  });

  it('stays still at rest while the wheel is turned and the handbrake held', () => {
    const world = rolling(0);
    drive(world, 2, () => ({ steer: 1, handbrake: true }));
    expect(world.car.x).toBe(ARENA.start.x);
    expect(world.car.z).toBe(ARENA.start.z);
    expect(world.car.heading).toBe(ARENA.start.heading);
    expect(world.car.steerAngle).toBeCloseTo(DEFAULT_CAR_PARAMS.maxSteer, 9);
  });

  it('coasts to a complete stop', () => {
    const world = rolling(3);
    drive(world, 10, () => IDLE);
    expect(world.car.speed).toBe(0);
    const x = world.car.x;
    drive(world, 1, () => IDLE);
    expect(world.car.x).toBe(x);
  });

  it('comes to a complete stop from a handbrake slide', () => {
    const world = rolling(15);
    drive(world, 5, () => ({ steer: 1, handbrake: true }));
    expect(world.car.speed).toBe(0);
    expect(world.car.yawRate).toBe(0);
    expect(world.car.rearSlide).toBe(0);
  });

  it('brakes to a stop without shaking, then reverses', () => {
    const world = rolling(20);
    let reversedAt = Infinity;
    drive(
      world,
      6,
      () => ({ brake: 1 }),
      (car, time) => {
        if (car.forwardSpeed < -0.1 && time < reversedAt) reversedAt = time;
      },
    );
    expect(reversedAt).toBeGreaterThan(1);
    expect(reversedAt).toBeLessThan(4);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
    expect(world.car.forwardSpeed).toBeGreaterThan(-15);
    expect(Math.abs(world.car.heading)).toBeLessThan(1e-9);
  });

  it('brakes a car that is rolling backwards to a stop, and only then reverses', () => {
    // The aftermath of a spin: rolling backwards with the nose pointing up the road.
    const world = rolling(-12);
    let stoppedAt = Infinity;
    let fastestBackwards = 0;
    drive(
      world,
      2.5,
      () => ({ brake: 1 }),
      (car, time) => {
        fastestBackwards = Math.max(fastestBackwards, -car.forwardSpeed);
        if (car.speed < 0.6 && time < stoppedAt) stoppedAt = time;
      },
    );
    // The pedal never pushes the car further back than it was already going.
    expect(fastestBackwards).toBeLessThanOrEqual(12);
    expect(stoppedAt).toBeLessThan(2);
    expect(world.car.x).toBeGreaterThan(-16);
    drive(world, 3, () => ({ brake: 1 }));
    expect(world.car.reversing).toBe(true);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
  });

  it('brakes just as hard backwards as forwards', () => {
    const stoppingDistance = (speed: number): number => {
      const world = rolling(speed);
      drive(world, 4, (car) => (car.speed > 0.6 ? { brake: 1 } : { handbrake: true }));
      expect(world.car.speed).toBe(0);
      return Math.abs(world.car.x);
    };
    const forwards = stoppingDistance(12);
    const backwards = stoppingDistance(-12);
    expect(backwards).toBeGreaterThan(0.8 * forwards);
    expect(backwards).toBeLessThan(1.25 * forwards);
  });

  it('does not select reverse while the car is still sliding sideways', () => {
    const world = rolling(0);
    world.car.vz = 15;
    let reversedWhileSliding = false;
    drive(
      world,
      6,
      () => ({ brake: 1 }),
      (car) => {
        if (car.reversing && car.speed > 1.5 && car.forwardSpeed > -0.5) reversedWhileSliding = true;
      },
    );
    expect(reversedWhileSliding).toBe(false);
    // Once it has stopped, the held pedal backs it up as usual.
    expect(world.car.reversing).toBe(true);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
  });

  it('keeps reverse selected while the pedal is feathered, and drops it for the throttle', () => {
    const world = rolling(0);
    drive(world, 2, () => ({ brake: 1 }));
    const backing = world.car.forwardSpeed;
    expect(backing).toBeLessThan(-3);
    drive(world, 0.3, () => IDLE);
    expect(world.car.reversing).toBe(true);
    // Pressing again drives on backwards rather than slamming the brakes on.
    drive(world, 0.5, () => ({ brake: 1 }));
    expect(world.car.forwardSpeed).toBeLessThan(backing);
    drive(world, 0.1, () => ({ throttle: 1 }));
    expect(world.car.reversing).toBe(false);
    // Out of reverse and still rolling back, the pedal is a brake again.
    world.car.vx = -8;
    world.car.vz = 0;
    drive(world, 0.2, () => ({ brake: 1 }));
    expect(world.car.forwardSpeed).toBeGreaterThan(-7);
    expect(world.car.reversing).toBe(false);
  });

  it('steers the expected way in reverse', () => {
    const world = rolling(0);
    drive(world, 3, () => ({ brake: 0.6, steer: 1 }));
    // Backing up with the wheels turned right swings the tail right, so the nose turns left.
    expect(world.car.forwardSpeed).toBeLessThan(-1);
    expect(world.car.heading).toBeLessThan(-0.3);
    expect(world.car.z).toBeGreaterThan(0.5);
    expect(world.car.x).toBeLessThan(0);
  });

  it('follows the wheels at walking pace', () => {
    const world = rolling(0);
    let roughest = 0;
    let previousYaw = 0;
    drive(
      world,
      4,
      () => ({ throttle: 0.2, steer: 1 }),
      (car) => {
        roughest = Math.max(roughest, Math.abs(car.yawRate - previousYaw));
        previousYaw = car.yawRate;
      },
    );
    const car = world.car;
    const wheelbase = DEFAULT_CAR_PARAMS.cgToFront + DEFAULT_CAR_PARAMS.cgToRear;
    // Kinematic turn: yaw rate = speed * tan(steer) / wheelbase, within a few percent while the tyres grip.
    const expected = (car.forwardSpeed * Math.tan(car.steerAngle)) / wheelbase;
    expect(car.forwardSpeed).toBeGreaterThan(0.5);
    expect(car.forwardSpeed).toBeLessThan(5);
    expect(car.yawRate).toBeGreaterThan(0.85 * expected);
    expect(car.yawRate).toBeLessThan(1.1 * expected);
    // No tick-to-tick chatter in the yaw rate.
    expect(roughest).toBeLessThan(0.02);
  });

  it.each([NaN, 0, -1, Infinity])('stays finite when any one tuning value is %f', (bad) => {
    for (const key of Object.keys(DEFAULT_CAR_PARAMS) as (keyof CarParams)[]) {
      const params = cloneParams(DEFAULT_CAR_PARAMS);
      params[key] = bad;
      const world = createWorld(SMALL_ARENA, params);
      world.car.vx = 15;
      let finite = true;
      drive(
        world,
        3,
        (_car, time) => ({ steer: time < 1.5 ? 1 : -1, throttle: 1, brake: time > 2.5 ? 1 : 0, handbrake: time > 2 }),
        (car) => {
          finite = finite && isFiniteState(car);
        },
      );
      expect(finite, key).toBe(true);
    }
  });

  it('ignores garbage input', () => {
    const world = rolling(10);
    drive(world, 1, () => ({ steer: NaN, throttle: Infinity, brake: -Infinity }));
    expect(isFiniteState(world.car)).toBe(true);
    expect(world.car.steerAngle).toBe(0);
    expect(world.car.throttle).toBe(1);
    expect(world.car.brake).toBe(0);
  });
});
