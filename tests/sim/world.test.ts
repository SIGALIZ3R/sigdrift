import { describe, expect, it } from 'vitest';
import type { CarParams, InputState } from '../../src/types';
import { DT } from '../../src/types';
import { lateralForceCoefficient, peakSlipAngle } from '../../src/sim/tire';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel, makeStraightLevel } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const FULL_THROTTLE: InputState = { ...IDLE, throttle: 1 };

describe('params', () => {
  it('ships frozen defaults and hands out mutable copies', () => {
    expect(Object.isFrozen(DEFAULT_CAR_PARAMS)).toBe(true);
    const copy = cloneParams(DEFAULT_CAR_PARAMS);
    expect(copy).toEqual(DEFAULT_CAR_PARAMS);
    expect(copy).not.toBe(DEFAULT_CAR_PARAMS);
    copy.mass = 1;
    expect(DEFAULT_CAR_PARAMS.mass).not.toBe(1);
  });

  it('has only finite, positive-or-zero values', () => {
    for (const value of Object.values(DEFAULT_CAR_PARAMS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('tyre curve', () => {
  const STIFFNESS = 12;
  const GRIP = 1.4;
  const SLIDE = 0.8;
  const curve = (slip: number) => lateralForceCoefficient(slip, STIFFNESS, GRIP, SLIDE);

  it('is zero at zero slip and exactly odd', () => {
    expect(curve(0)).toBe(0);
    for (const slip of [0.01, 0.1, 0.3, 1, 3]) expect(curve(-slip)).toBe(-curve(slip));
  });

  it('starts with the cornering stiffness as its slope', () => {
    expect(curve(1e-6) / 1e-6).toBeCloseTo(STIFFNESS, 3);
  });

  it('peaks at the grip limit', () => {
    const peak = peakSlipAngle(STIFFNESS, GRIP);
    expect(curve(peak)).toBeCloseTo(GRIP, 12);
    for (let slip = 0; slip <= 3; slip += 0.001) expect(curve(slip)).toBeLessThanOrEqual(GRIP + 1e-12);
  });

  it('rises to the peak, then falls smoothly towards the sliding grip', () => {
    const peak = peakSlipAngle(STIFFNESS, GRIP);
    let previous = 0;
    for (let slip = 0.001; slip <= 3; slip += 0.001) {
      const now = curve(slip);
      if (slip < peak - 0.001) expect(now).toBeGreaterThan(previous);
      if (slip > peak + 0.001) expect(now).toBeLessThan(previous);
      // No jump anywhere, including where the two halves meet.
      expect(Math.abs(now - previous)).toBeLessThan(STIFFNESS * 0.001 + 1e-9);
      previous = now;
    }
    expect(curve(1.5)).toBeGreaterThan(GRIP * SLIDE);
    expect(curve(1.5)).toBeLessThan(GRIP * (SLIDE + 0.03));
  });

  it('returns nothing for a tyre with no grip', () => {
    expect(curve(0.2)).toBeGreaterThan(0);
    expect(lateralForceCoefficient(0.2, STIFFNESS, 0, SLIDE)).toBe(0);
    expect(lateralForceCoefficient(0.2, 0, GRIP, SLIDE)).toBe(0);
  });
});

describe('world', () => {
  const level = makeStraightLevel(200, 8);

  it('starts with the car at rest on the start pad', () => {
    const world = createWorld(level);
    expect(world.level).toBe(level);
    expect(world.tick).toBe(0);
    expect(world.lastCollision).toBeNull();
    expect(world.car).toMatchObject({ ...level.start, vx: 0, vz: 0, yawRate: 0, steerAngle: 0, speed: 0 });
    expect(world.params).toEqual(DEFAULT_CAR_PARAMS);
    expect(Object.isFrozen(world.params)).toBe(false);
  });

  it('counts one tick per step and moves the car', () => {
    const world = createWorld(level);
    for (let i = 0; i < 120; i++) world.step(FULL_THROTTLE);
    expect(world.tick).toBe(120);
    expect(world.car.x).toBeGreaterThan(level.start.x + 2);
    expect(world.car.forwardSpeed).toBeGreaterThan(5);
    expect(world.car.throttle).toBe(1);
    expect(world.car.accelLong).toBeGreaterThan(3);
  });

  it('uses the params object it was given, so live edits take effect', () => {
    const params: CarParams = cloneParams(DEFAULT_CAR_PARAMS);
    const world = createWorld(level, params);
    expect(world.params).toBe(params);
    params.engineForce = 0;
    for (let i = 0; i < 60; i++) world.step(FULL_THROTTLE);
    expect(world.car.speed).toBe(0);
  });

  it('places the car at rest without touching the tick', () => {
    const world = createWorld(level);
    for (let i = 0; i < 300; i++) world.step({ ...FULL_THROTTLE, steer: 0.4 });
    const pose = { x: 50, z: -2, heading: 0.25 };
    world.placeCar(pose);
    expect(world.tick).toBe(300);
    expect(world.lastCollision).toBeNull();
    const fresh = createWorld(level);
    fresh.placeCar(pose);
    expect(world.car).toEqual(fresh.car);
    world.step(IDLE);
    expect(world.car).toMatchObject({ ...pose, speed: 0 });
  });

  it('snapshots the tick and the integrated state as plain finite numbers', () => {
    const world = createWorld(makeOpenLevel(400));
    for (let i = 0; i < 240; i++) world.step({ ...FULL_THROTTLE, steer: 0.5 });
    const snapshot = world.snapshot();
    const car = world.car;
    expect(snapshot[0]).toBe(240);
    for (const value of [car.x, car.z, car.heading, car.vx, car.vz, car.yawRate, car.steerAngle]) {
      expect(snapshot).toContain(value);
    }
    expect(snapshot.every(Number.isFinite)).toBe(true);
    world.step(IDLE);
    expect(world.snapshot()).not.toEqual(snapshot);
  });

  it('takes steps of exactly DT', () => {
    const world = createWorld(makeOpenLevel(400));
    world.car.vx = 12;
    world.step(FULL_THROTTLE);
    expect(world.car.x).toBeCloseTo(world.car.vx * DT, 12);
  });
});
