import { describe, expect, it } from 'vitest';
import type { InputState, Level, Prop, World } from '../../src/types';
import { DT } from '../../src/types';
import { atan2, cos, hypot, sin } from '../../src/core/fixedMath';
import { createCarState } from '../../src/sim/car';
import { buildCollider, resolveCollisions } from '../../src/sim/collision';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel, makeStraightLevel } from '../helpers/handLevel';

const HALF = 100;
const ARENA = makeOpenLevel(2 * HALF);
const RADIUS = DEFAULT_CAR_PARAMS.collisionRadius;
const REACH = DEFAULT_CAR_PARAMS.halfLength - RADIUS;
const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const DEGREES = Math.PI / 180;

/** A world with the car placed at a pose and already moving at `speed` in the direction `travel`. */
function launch(level: Level, x: number, z: number, heading: number, speed: number, travel = heading): World {
  const world = createWorld(level);
  world.placeCar({ x, z, heading });
  world.car.vx = speed * cos(travel);
  world.car.vz = speed * sin(travel);
  return world;
}

/** How far the worst body circle pokes through the arena walls (negative = safely inside). */
function overshoot(world: World): number {
  const car = world.car;
  let worst = -Infinity;
  for (const offset of [-REACH, 0, REACH]) {
    const cx = car.x + offset * cos(car.heading);
    const cz = car.z + offset * sin(car.heading);
    worst = Math.max(worst, Math.abs(cx) + RADIUS - HALF, Math.abs(cz) + RADIUS - HALF);
  }
  return worst;
}

interface CrashReport {
  worstOvershoot: number;
  centreEscaped: boolean;
  hits: number;
  hardestImpact: number;
  speedBeforeFirstHit: number;
  speedAfterFirstHit: number;
  maxYawRate: number;
}

function crash(world: World, seconds: number, input: Partial<InputState> = {}): CrashReport {
  const report: CrashReport = {
    worstOvershoot: -Infinity,
    centreEscaped: false,
    hits: 0,
    hardestImpact: 0,
    speedBeforeFirstHit: 0,
    speedAfterFirstHit: 0,
    maxYawRate: 0,
  };
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    const before = hypot(world.car.vx, world.car.vz);
    world.step({ ...IDLE, ...input });
    const car = world.car;
    report.worstOvershoot = Math.max(report.worstOvershoot, overshoot(world));
    report.centreEscaped = report.centreEscaped || Math.abs(car.x) >= HALF || Math.abs(car.z) >= HALF;
    report.maxYawRate = Math.max(report.maxYawRate, Math.abs(car.yawRate));
    if (world.lastCollision) {
      if (report.hits === 0) {
        report.speedBeforeFirstHit = before;
        report.speedAfterFirstHit = car.speed;
      }
      report.hits++;
      report.hardestImpact = Math.max(report.hardestImpact, world.lastCollision.impact);
    }
  }
  return report;
}

describe('walls', () => {
  const angles: number[] = [];
  for (let degrees = -85; degrees <= 85; degrees += 5) angles.push(degrees);

  it.each(angles)('stop a 45 m/s car arriving %i degrees off head-on', (degrees) => {
    const heading = degrees * DEGREES;
    const report = crash(launch(ARENA, 60, 0, heading, 45), 4, { throttle: 1 });
    expect(report.hits).toBeGreaterThan(0);
    expect(report.centreEscaped).toBe(false);
    expect(report.worstOvershoot).toBeLessThan(0.01);
    expect(report.speedAfterFirstHit).toBeLessThan(report.speedBeforeFirstHit);
    expect(report.maxYawRate).toBeLessThan(7.5);
  });

  it('stop a car sliding in sideways, backwards or spinning', () => {
    for (const heading of [0, 1.2, Math.PI / 2, 2.4, Math.PI, -1.9]) {
      const world = launch(ARENA, 70, 10, heading, 40, 0.2);
      world.car.yawRate = 3;
      const report = crash(world, 3);
      expect(report.hits).toBeGreaterThan(0);
      expect(report.centreEscaped).toBe(false);
      expect(report.worstOvershoot).toBeLessThan(0.01);
    }
  });

  it('hold in the corners', () => {
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const aim of [-0.2, 0, 0.2]) {
        const report = crash(launch(ARENA, 60 * sx, 60 * sz, atan2(sz, sx) + aim, 45), 4, { throttle: 1 });
        expect(report.hits).toBeGreaterThan(0);
        expect(report.centreEscaped).toBe(false);
        expect(report.worstOvershoot).toBeLessThan(0.05);
      }
    }
  });

  it('hold at the hard speed limit, well beyond what the car can reach', () => {
    for (const degrees of [0, 20, 50, 80]) {
      const report = crash(launch(ARENA, 60, 0, degrees * DEGREES, 79), 3, { throttle: 1 });
      expect(report.centreEscaped).toBe(false);
      expect(report.worstOvershoot).toBeLessThan(0.01);
    }
  });

  it('send back a car that jumped clean through in one tick', () => {
    const collider = buildCollider(ARENA);
    const car = createCarState({ x: HALF + 3, z: 0, heading: 0 });
    // 600 m/s: the tick started 5 m back, inside the arena, and ended 3 m outside it.
    car.vx = 600;
    const event = resolveCollisions(car, DEFAULT_CAR_PARAMS, collider);
    expect(event).not.toBeNull();
    expect(event!.nx).toBeCloseTo(-1, 9);
    expect(car.x + REACH + RADIUS).toBeLessThan(HALF + 0.01);
    expect(car.vx).toBeLessThan(0);
  });

  it('report a head-on hit: normal towards the car, impact = closing speed, little bounce', () => {
    const world = launch(ARENA, 90, 5, 0, 30);
    let hit = null;
    let speedBefore = 0;
    for (let i = 0; i < 120 && !hit; i++) {
      speedBefore = world.car.speed || 30;
      world.step(IDLE);
      hit = world.lastCollision;
    }
    expect(hit).not.toBeNull();
    expect(hit!.nx).toBeCloseTo(-1, 6);
    expect(hit!.nz).toBeCloseTo(0, 6);
    expect(hit!.x).toBeCloseTo(HALF, 3);
    expect(hit!.z).toBeCloseTo(5, 3);
    expect(hit!.impact).toBeGreaterThan(speedBefore - 1);
    expect(hit!.impact).toBeLessThanOrEqual(speedBefore + 1e-9);
    expect(world.car.vx).toBeLessThan(0);
    expect(world.car.speed).toBeLessThan(DEFAULT_CAR_PARAMS.restitution * hit!.impact + 0.01);
    expect(world.car.yawRate).toBeCloseTo(0, 6);
  });

  it('turn a glancing nose hit away from the wall', () => {
    // Heading towards the +z wall at 20 degrees: the nose is pushed back towards -z, so heading must decrease.
    const world = launch(ARENA, 0, 96, 20 * DEGREES, 25);
    const report = crash(world, 0.5);
    expect(report.hits).toBeGreaterThan(0);
    expect(world.car.yawRate).toBeLessThan(-0.3);
    expect(report.maxYawRate).toBeLessThan(3);
  });

  it('let a shallow scrape keep most of its speed', () => {
    const world = launch(ARENA, 0, 96, 5 * DEGREES, 30);
    const report = crash(world, 2, { throttle: 1 });
    expect(report.hits).toBeGreaterThan(0);
    expect(report.speedAfterFirstHit).toBeGreaterThan(0.95 * report.speedBeforeFirstHit);
    expect(world.car.speed).toBeGreaterThan(30);
    // It ends up running along the wall rather than bouncing back across the arena.
    expect(Math.abs(world.car.heading)).toBeLessThan(0.2);
  });

  it('cost more speed the squarer the hit', () => {
    const kept = [5, 20, 45, 90].map((degrees) => {
      const report = crash(launch(ARENA, 0, 96, degrees * DEGREES, 30), 1.5);
      return report.speedAfterFirstHit / report.speedBeforeFirstHit;
    });
    expect(kept[0]).toBeGreaterThan(kept[1] + 0.1);
    expect(kept[1]).toBeGreaterThan(kept[2] + 0.1);
    expect(kept[2]).toBeGreaterThan(kept[3] + 0.1);
    expect(kept[3]).toBeLessThan(0.25);
  });

  it('never speed up a car that was not spinning', () => {
    for (let heading = -3; heading <= 3; heading += 0.5) {
      for (let travel = -1.4; travel <= 1.4; travel += 0.35) {
        const report = crash(launch(ARENA, 97.5, 0, heading, 35, travel), 0.6);
        expect(report.hits).toBeGreaterThan(0);
        expect(report.speedAfterFirstHit).toBeLessThanOrEqual(report.speedBeforeFirstHit + 1e-9);
      }
    }
  });

  it('push out a car that starts overlapping one', () => {
    const world = launch(ARENA, HALF - 0.2, 0, Math.PI / 2, 0);
    world.step(IDLE);
    expect(world.lastCollision).not.toBeNull();
    expect(overshoot(world)).toBeLessThan(1e-3);
    expect(world.car.speed).toBe(0);
  });

  it('leave a car alone in open space', () => {
    const world = launch(ARENA, 0, 0, 0.3, 20);
    world.step(IDLE);
    expect(world.lastCollision).toBeNull();
  });

  it('clear the last collision once the car is free again', () => {
    const world = launch(ARENA, 96, 0, 0, 20);
    let sawHit = false;
    for (let i = 0; i < 120; i++) {
      world.step(IDLE);
      sawHit = sawHit || world.lastCollision !== null;
    }
    expect(sawHit).toBe(true);
    expect(world.lastCollision).toBeNull();
  });
});

describe('road edges made of many short walls', () => {
  const HALF_WIDTH = 8;
  const ROAD = makeStraightLevel(600, HALF_WIDTH);

  it('do not snag a car that leans on them', () => {
    const world = launch(ROAD, 10, HALF_WIDTH - RADIUS - 0.05, 0, 30);
    let biggestDrop = 0;
    let contacts = 0;
    for (let i = 0; i < 4 / DT; i++) {
      const before = world.car.speed || 30;
      world.step({ ...IDLE, steer: 0.15, throttle: 1 });
      biggestDrop = Math.max(biggestDrop, before - world.car.speed);
      if (world.lastCollision) contacts++;
      expect(Math.abs(world.car.z)).toBeLessThan(HALF_WIDTH);
    }
    // It crossed dozens of wall joints while pressed against the edge.
    expect(contacts).toBeGreaterThan(50);
    expect(world.car.x).toBeGreaterThan(100);
    expect(biggestDrop).toBeLessThan(1.5);
  });

  it('keep a flat-out car on the road from end to end', () => {
    const world = createWorld(ROAD);
    for (let i = 0; i < 30 / DT; i++) {
      world.step({ ...IDLE, throttle: 1, steer: i % 240 < 120 ? 0.2 : -0.2 });
      expect(Math.abs(world.car.z)).toBeLessThan(HALF_WIDTH);
      expect(world.car.x).toBeGreaterThan(ROAD.bounds.minX);
      expect(world.car.x).toBeLessThan(ROAD.bounds.maxX);
    }
    // It reached the wall beyond the goal.
    expect(world.car.x).toBeGreaterThan(590);
  });
});

describe('a long diagonal wall', () => {
  const level: Level = { ...ARENA, walls: [...ARENA.walls, { ax: -HALF, az: -HALF, bx: HALF, bz: HALF }] };

  it('stops the car anywhere along its length', () => {
    for (const along of [-80, -35, 0, 20, 70]) {
      // Start 15 m off the diagonal on its +x side and drive straight at it.
      const world = launch(level, along + 10.6, along - 10.6, (3 * Math.PI) / 4, 45);
      let hits = 0;
      for (let i = 0; i < 2 / DT; i++) {
        world.step(IDLE);
        if (world.lastCollision) hits++;
        // Still on the side it started from.
        expect(world.car.x - world.car.z).toBeGreaterThan(0);
      }
      expect(hits).toBeGreaterThan(0);
    }
  });
});

describe('pillars', () => {
  const pillar: Prop = { kind: 'pillar', x: 40, z: 0, radius: 1.5, height: 4, hue: 0 };
  const level: Level = { ...ARENA, props: [pillar] };

  function clearance(world: World): number {
    const car = world.car;
    let least = Infinity;
    for (const offset of [-REACH, 0, REACH]) {
      const dx = car.x + offset * cos(car.heading) - pillar.x;
      const dz = car.z + offset * sin(car.heading) - pillar.z;
      least = Math.min(least, hypot(dx, dz) - pillar.radius - RADIUS);
    }
    return least;
  }

  it('stop a head-on car and bounce it back', () => {
    const world = launch(level, 20, 0, 0, 45);
    let hit = null;
    for (let i = 0; i < 2 / DT; i++) {
      world.step(IDLE);
      hit = hit ?? (world.lastCollision ? { ...world.lastCollision } : null);
      expect(clearance(world)).toBeGreaterThan(-0.01);
    }
    expect(hit).not.toBeNull();
    expect(hit!.nx).toBeCloseTo(-1, 6);
    expect(hit!.impact).toBeGreaterThan(30);
    expect(world.car.x).toBeLessThan(pillar.x - pillar.radius);
  });

  it('deflect an off-centre hit to the side it struck on', () => {
    for (const side of [-1, 1]) {
      const world = launch(level, 20, side * 1.4, 0, 30);
      let hit = false;
      for (let i = 0; i < 1.5 / DT; i++) {
        world.step(IDLE);
        hit = hit || world.lastCollision !== null;
        expect(clearance(world)).toBeGreaterThan(-0.01);
      }
      expect(hit).toBe(true);
      // Passed the pillar on its own side, nose knocked outwards.
      expect(world.car.z * side).toBeGreaterThan(1.4);
      expect(world.car.heading * side).toBeGreaterThan(0);
    }
  });

  it('are missed by a car that passes clear of them', () => {
    const world = launch(level, 20, pillar.radius + RADIUS + 0.2, 0, 30);
    for (let i = 0; i < 1.5 / DT; i++) {
      world.step({ ...IDLE, throttle: 1 });
      expect(world.lastCollision).toBeNull();
    }
    expect(world.car.x).toBeGreaterThan(pillar.x + 10);
  });
});
