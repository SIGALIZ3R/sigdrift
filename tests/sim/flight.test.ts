/**
 * Height and flight: the ground formula, the vertical half of the car step, and jumps over bumps on endless road.
 */
import { describe, expect, it } from 'vitest';
import type { Bump, CarState, EndlessWorld, InputState } from '../../src/types';
import { DT } from '../../src/types';
import { hashNumbers } from '../../src/core/hash';
import { GRAVITY, createCarState, stepCar } from '../../src/sim/car';
import { createEndlessWorld } from '../../src/sim/endlessWorld';
import { bumpHeight, groundHeightOf } from '../../src/sim/ground';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import { makeBump, makeStraightChunk } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const HALF_WIDTH = 10;
/** Where the standard bump (0.5 m high, 12 m long) sits on the test road. */
const BUMP_X = 150;

describe('ground height', () => {
  const bump: Bump = { x: 10, z: 5, dirX: 1, dirZ: 0, halfLength: 6, halfWidth: 9, height: 0.5 };

  it('is a raised cosine along the road: full height at the crest, half way down at half length, flat at the ends', () => {
    expect(bumpHeight(bump, 10, 5)).toBeCloseTo(0.5, 12);
    expect(bumpHeight(bump, 13, 5)).toBeCloseTo(0.25, 12);
    expect(bumpHeight(bump, 7, 5)).toBeCloseTo(0.25, 12);
    expect(bumpHeight(bump, 12, 5)).toBeCloseTo(0.5 * 0.5 * (1 + Math.cos((Math.PI * 2) / 6)), 12);
    expect(bumpHeight(bump, 16, 5)).toBe(0);
    expect(bumpHeight(bump, 4, 5)).toBe(0);
    expect(bumpHeight(bump, 15.999, 5)).toBeLessThan(1e-6);
    expect(bumpHeight(bump, 40, 5)).toBe(0);
  });

  it('is the same right across the road and stops dead at its half width', () => {
    expect(bumpHeight(bump, 12, 5 + 9)).toBe(bumpHeight(bump, 12, 5));
    expect(bumpHeight(bump, 12, 5 - 9)).toBe(bumpHeight(bump, 12, 5));
    expect(bumpHeight(bump, 12, 5 + 9.01)).toBe(0);
    expect(bumpHeight(bump, 12, 5 - 9.01)).toBe(0);
  });

  it('follows the bump round when the road is not along x', () => {
    const turned = makeBump(0, 0, Math.PI / 2, 8);
    // The road runs along +z here: 3 m along it is half way down, and x is across it.
    expect(bumpHeight(turned, 0, 3)).toBeCloseTo(0.25, 9);
    expect(bumpHeight(turned, 8.5, 3)).toBeCloseTo(0.25, 9);
    expect(bumpHeight(turned, 9.5, 3)).toBe(0);
    expect(bumpHeight(turned, 3, 7)).toBe(0);
  });

  it('is the highest of overlapping bumps, and 0 where there is none', () => {
    const low: Bump = { ...bump, height: 0.2 };
    const shifted: Bump = { ...bump, x: 13 };
    expect(groundHeightOf([], 10, 5)).toBe(0);
    expect(groundHeightOf([low, bump], 10, 5)).toBeCloseTo(0.5, 12);
    expect(groundHeightOf([bump, shifted], 13, 5)).toBeCloseTo(0.5, 12);
    expect(groundHeightOf([bump, shifted], 100, 5)).toBe(0);
  });
});

describe('the car step on flat ground', () => {
  it('is untouched by the height code: same state with and without a ground argument, never off the ground', () => {
    const plain = createCarState({ x: 0, z: 0, heading: 0.3 });
    const given = createCarState({ x: 0, z: 0, heading: 0.3 });
    for (let i = 0; i < 1500; i++) {
      const input = { ...IDLE, throttle: i % 400 < 300 ? 1 : 0, steer: i % 300 < 150 ? 0.8 : -0.6, handbrake: i % 500 > 440 };
      stepCar(plain, DEFAULT_CAR_PARAMS, input, DT);
      stepCar(given, DEFAULT_CAR_PARAMS, input, DT, 0);
      expect(plain.y).toBe(0);
      expect(plain.vy).toBe(0);
      expect(plain.airborne).toBe(false);
    }
    expect(given).toEqual(plain);
    expect(plain.speed).toBeGreaterThan(5);
  });
});

describe('tyre load over crests and through dips', () => {
  /** Sideways speed scrubbed off in one tick by a car sliding at 20 m/s while the ground asks for `pull` m/s2. */
  function scrub(pull: number): { lost: number; car: CarState } {
    const car = createCarState({ x: 0, z: 0, heading: 0 });
    car.vx = 20;
    car.vz = 6;
    stepCar(car, DEFAULT_CAR_PARAMS, IDLE, DT, pull * DT * DT);
    return { lost: 6 - car.vz, car };
  }

  it('gives less grip over a crest and more in a dip', () => {
    const flat = scrub(0).lost;
    expect(flat).toBeGreaterThan(0.01);
    expect(scrub(-0.5 * GRAVITY).lost / flat).toBeCloseTo(0.5, 2);
    expect(scrub(0.5 * GRAVITY).lost / flat).toBeCloseTo(1.5, 2);
  });

  it('keeps the load between 0.3 and 1.6 of the weight', () => {
    const flat = scrub(0).lost;
    expect(scrub(-0.95 * GRAVITY).lost / flat).toBeCloseTo(0.3, 2);
    expect(scrub(6 * GRAVITY).lost / flat).toBeCloseTo(1.6, 2);
  });

  it('lets go altogether when the ground falls away faster than gravity can follow', () => {
    const gentle = scrub(-1.05 * GRAVITY).car;
    expect(gentle.airborne).toBe(false);
    const steep = scrub(-1.5 * GRAVITY);
    expect(steep.car.airborne).toBe(true);
    // No tyres on the ground: the sideways speed is all still there but for a breath of air drag.
    expect(steep.lost).toBeGreaterThanOrEqual(0);
    expect(steep.lost).toBeLessThan(0.002);
  });
});

/** A long straight road with one standard bump on it. */
function bumpRoad(height = 0.5, length = 12): EndlessWorld {
  const world = createEndlessWorld({ x: 0, z: 0, heading: 0 });
  world.addChunk(makeStraightChunk(0, 0, 100, HALF_WIDTH));
  world.addChunk(makeStraightChunk(1, 100, 100, HALF_WIDTH, [makeBump(BUMP_X, 0, 0, HALF_WIDTH, height, length)]));
  world.addChunk(makeStraightChunk(2, 200, 200, HALF_WIDTH));
  return world;
}

interface Jump {
  airTime: number;
  /** Highest the wheels got above the flat road, and above the ground directly under them. */
  peakHeight: number;
  peakClearance: number;
  flights: number;
  landed: boolean;
  offTrack: boolean;
  finite: boolean;
  speedAfter: number;
}

/** Drives over the bump: placed 60 m before it, already at `speed`, feathering the throttle to hold that speed. */
function jump(world: EndlessWorld, speed: number, seconds = 6): Jump {
  world.placeCar({ x: BUMP_X - 60, z: 0, heading: 0 });
  world.car.vx = speed;
  const report: Jump = {
    airTime: 0,
    peakHeight: 0,
    peakClearance: 0,
    flights: 0,
    landed: false,
    offTrack: false,
    finite: true,
    speedAfter: 0,
  };
  let wasAirborne = false;
  for (let i = 0; i < seconds / DT; i++) {
    world.step({ ...IDLE, throttle: world.car.speed < speed ? 1 : 0 });
    const car = world.car;
    if (car.airborne) {
      report.airTime += DT;
      if (!wasAirborne) report.flights++;
    } else if (wasAirborne) {
      report.landed = true;
    }
    wasAirborne = car.airborne;
    report.peakHeight = Math.max(report.peakHeight, car.y);
    report.peakClearance = Math.max(report.peakClearance, car.y - world.groundHeight(car.x, car.z));
    report.offTrack = report.offTrack || world.offTrack;
    report.finite = report.finite && Object.values(car).every((v) => typeof v !== 'number' || Number.isFinite(v));
  }
  report.speedAfter = world.car.speed;
  return report;
}

describe('jumps over a 0.5 m high, 12 m long bump', () => {
  it('keeps the wheels on the ground at 12 m/s, and the car rides up and over', () => {
    const world = bumpRoad();
    const m = jump(world, 12);
    expect(m.airTime).toBeLessThan(0.15);
    expect(m.peakHeight).toBeGreaterThan(0.45);
    expect(m.peakHeight).toBeLessThan(0.6);
    expect(m.peakClearance).toBeLessThan(0.05);
    expect(world.car.y).toBe(0);
    expect(world.car.vy).toBe(0);
    expect(world.car.x).toBeGreaterThan(BUMP_X + 6);
  });

  it('is a real jump at 30 m/s', () => {
    const world = bumpRoad();
    const m = jump(world, 30);
    expect(m.flights).toBe(1);
    expect(m.airTime).toBeGreaterThan(0.5);
    expect(m.airTime).toBeLessThan(1.1);
    expect(m.peakHeight).toBeGreaterThan(0.6);
    expect(m.peakHeight).toBeLessThan(2);
    expect(m.landed).toBe(true);
    expect(m.offTrack).toBe(false);
    expect(world.car.airborne).toBe(false);
    expect(world.car.y).toBe(0);
    expect(world.car.vy).toBe(0);
  });

  it('is bigger at 42 m/s but still comes down', () => {
    const world = bumpRoad();
    const fast = jump(world, 42);
    const medium = jump(bumpRoad(), 30);
    expect(fast.finite).toBe(true);
    expect(fast.flights).toBe(1);
    expect(fast.landed).toBe(true);
    expect(fast.airTime).toBeGreaterThan(medium.airTime);
    expect(fast.airTime).toBeLessThan(1.6);
    expect(fast.peakHeight).toBeGreaterThan(medium.peakHeight);
    expect(fast.peakHeight).toBeLessThan(3);
    expect(fast.offTrack).toBe(false);
    expect(world.car.airborne).toBe(false);
  });

  it('gets longer and higher with speed, without a gap', () => {
    let previous = 0;
    for (const speed of [16, 20, 24, 28, 32, 36, 40, 44]) {
      const m = jump(bumpRoad(), speed);
      expect(m.finite).toBe(true);
      expect(m.airTime).toBeGreaterThanOrEqual(previous);
      previous = m.airTime;
    }
    expect(previous).toBeGreaterThan(0.9);
  });

  it('takes off with the upward speed the ramp gave it and falls under gravity', () => {
    const world = bumpRoad();
    world.placeCar({ x: BUMP_X - 60, z: 0, heading: 0 });
    world.car.vx = 30;
    let before = 0;
    let takeoff = -1;
    const heights: number[] = [];
    for (let i = 0; i < 4 / DT && heights.length < 30; i++) {
      const vyBefore = world.car.vy;
      world.step(IDLE);
      if (world.car.airborne && takeoff < 0) {
        takeoff = i;
        before = vyBefore;
        // It leaves on the way up the ramp, before the crest.
        expect(world.car.x).toBeLessThan(BUMP_X);
        expect(before).toBeGreaterThan(2);
      }
      if (takeoff >= 0) heights.push(world.car.vy);
    }
    expect(takeoff).toBeGreaterThan(0);
    heights.forEach((vy, n) => expect(vy).toBeCloseTo(before - GRAVITY * DT * (n + 1), 9));
  });

  it('has no tyres in the air: steering, brakes and throttle do nothing to the path, but the wheels still turn', () => {
    const coasting = bumpRoad();
    const fighting = bumpRoad();
    for (const world of [coasting, fighting]) {
      world.placeCar({ x: BUMP_X - 30, z: 0, heading: 0 });
      world.car.vx = 32;
    }
    const mash: InputState = { steer: 1, throttle: 1, brake: 1, handbrake: true, reset: false };
    let compared = 0;
    let speedAtTakeoff = 0;
    for (let i = 0; i < 3 / DT; i++) {
      const flying = coasting.car.airborne;
      if (flying && speedAtTakeoff === 0) speedAtTakeoff = coasting.car.speed;
      coasting.step(IDLE);
      fighting.step(flying ? mash : IDLE);
      if (!coasting.car.airborne || !flying) {
        if (compared > 0) break;
        continue;
      }
      compared++;
      expect(fighting.car.x).toBe(coasting.car.x);
      expect(fighting.car.z).toBe(coasting.car.z);
      expect(fighting.car.y).toBe(coasting.car.y);
      expect(fighting.car.vx).toBe(coasting.car.vx);
      expect(fighting.car.heading).toBe(coasting.car.heading);
      expect(fighting.car.rearSlide).toBe(0);
      expect(fighting.car.frontSlide).toBe(0);
    }
    expect(compared).toBeGreaterThan(60);
    // Air drag is all it lost, and the front wheels are where the stick asked for them when it lands.
    expect(speedAtTakeoff - coasting.car.speed).toBeGreaterThan(0);
    expect(speedAtTakeoff - coasting.car.speed).toBeLessThan(1);
    expect(fighting.car.steerAngle).toBeGreaterThan(0.2);
    expect(coasting.car.steerAngle).toBe(0);
    expect(fighting.car.throttle).toBe(1);
  });

  it('carries its spin through the air, losing only a little', () => {
    const world = bumpRoad();
    world.placeCar({ x: BUMP_X - 12, z: 0, heading: 0 });
    world.car.vx = 34;
    let spinAtTakeoff = 0;
    let headingAtTakeoff = 0;
    let wasAirborne = false;
    for (let i = 0; i < 3 / DT; i++) {
      world.step({ ...IDLE, steer: world.car.airborne ? 0 : 0.6 });
      const car = world.car;
      if (car.airborne && !wasAirborne) {
        spinAtTakeoff = car.yawRate;
        headingAtTakeoff = car.heading;
      }
      if (!car.airborne && wasAirborne) break;
      if (car.airborne) {
        expect(car.yawRate).toBeGreaterThan(0.6 * spinAtTakeoff);
        expect(car.yawRate).toBeLessThanOrEqual(spinAtTakeoff);
      }
      wasAirborne = car.airborne;
    }
    expect(spinAtTakeoff).toBeGreaterThan(0.2);
    expect(world.car.heading - headingAtTakeoff).toBeGreaterThan(0.5 * spinAtTakeoff * 0.6);
  });

  it('is mirror-symmetric and repeatable', () => {
    const run = (side: 1 | -1): EndlessWorld => {
      const world = bumpRoad();
      world.placeCar({ x: BUMP_X - 40, z: 0, heading: 0 });
      world.car.vx = 33;
      for (let i = 0; i < 3 / DT; i++) world.step({ ...IDLE, throttle: 1, steer: i < 100 ? 0.2 * side : 0 });
      return world;
    };
    const right = run(1);
    const left = run(-1);
    const again = run(1);
    expect(hashNumbers(again.snapshot())).toBe(hashNumbers(right.snapshot()));
    expect(left.car.x).toBe(right.car.x);
    expect(left.car.y).toBe(right.car.y);
    expect(left.car.z).toBe(-right.car.z);
    expect(left.car.heading).toBe(-right.car.heading);
    expect(left.car.yawRate).toBe(-right.car.yawRate);
    expect(Math.abs(right.car.z)).toBeGreaterThan(0.5);
  });

  it('scrubs a little speed in a hard landing and none in a soft one', () => {
    const drop = (height: number): number => {
      const car = createCarState({ x: 0, z: 0, heading: 0 });
      car.vx = 25;
      car.y = height;
      car.airborne = true;
      let ticks = 0;
      while (car.airborne && ticks++ < 1000) stepCar(car, DEFAULT_CAR_PARAMS, IDLE, DT, 0);
      expect(car.airborne).toBe(false);
      expect(car.y).toBe(0);
      expect(car.vy).toBe(0);
      // Air drag on the way down is not the landing's doing.
      const drag = (DEFAULT_CAR_PARAMS.drag * 25 * 25 * ticks * DT) / DEFAULT_CAR_PARAMS.mass;
      return (25 - car.speed - drag) / 25;
    };
    expect(Math.abs(drop(0.3))).toBeLessThan(0.002);
    const hard = drop(3);
    expect(hard).toBeGreaterThan(0.03);
    expect(hard).toBeLessThan(0.13);
    expect(drop(30)).toBeLessThan(0.13);
    expect(drop(30)).toBeGreaterThan(hard);
  });
});
