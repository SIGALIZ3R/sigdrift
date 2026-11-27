/**
 * The car on 2.5D roads: slope gravity, ramps, passing under and over a bridge, falling off open edges and bridges,
 * flying over barriers, the distance to the nearest wall, progress through a crossing on the endless road, and
 * equivalence with the old flat simulation.
 */
import { describe, expect, it } from 'vitest';
import type { CarState, EndlessWorld, InputState, Level, SimBase, TrackChunk, World } from '../../src/types';
import { DT, TERRAIN_Y } from '../../src/types';
import { atan2, wrapAngle } from '../../src/core/fixedMath';
import { hashNumbers } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';
import { createCarState, stepCar } from '../../src/sim/car';
import { buildCollider, resolveCollisions } from '../../src/sim/collision';
import { createEndlessWorld } from '../../src/sim/endlessWorld';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import {
  CROSSING,
  OPEN_EDGE,
  RAMP,
  makeBump,
  makeCrossingChunks,
  makeCrossingLevel,
  makeOpenEdgeLevel,
  makeOpenLevel,
  makeRampLevel,
  makeSlopeLevel,
  makeStraightLevel,
} from '../helpers/handLevel';
import { plantedParams } from '../helpers/testCar';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const RADIUS = DEFAULT_CAR_PARAMS.collisionRadius;

function worldOn(level: Level): World {
  return createWorld(level, plantedParams());
}

/** Places the car and sets it moving at `speed` along its nose. */
function launch(world: SimBase, x: number, z: number, heading: number, speed: number, y?: number): void {
  world.placeCar({ x, z, heading, y });
  world.car.vx = speed * Math.cos(heading);
  world.car.vz = speed * Math.sin(heading);
  // Already moving along the slope it was put on.
  world.car.vy = world.car.pitchSlope * speed;
}

/** Steering that holds a heading and a line across the road (`lateral` is the car's offset from the line). */
function hold(car: CarState, heading: number, lateral: number): number {
  return Math.max(-1, Math.min(1, 2 * wrapAngle(heading - car.heading) - 0.1 * lateral - 0.3 * car.yawRate));
}

describe('slope gravity', () => {
  const GRADE = 0.08;

  it('rolls a car with no throttle back down an 8% grade', () => {
    const world = worldOn(makeSlopeLevel(GRADE));
    world.placeCar({ x: 100, z: 0, heading: 0, y: 8 });
    expect(world.car.y).toBeCloseTo(8, 9);
    expect(world.car.pitchSlope).toBeCloseTo(GRADE, 9);
    let minForward = 0;
    for (let i = 0; i < 3 / DT; i++) {
      world.step(IDLE);
      minForward = Math.min(minForward, world.car.forwardSpeed);
      expect(world.car.airborne).toBe(false);
      expect(world.offTrack).toBe(false);
      expect(world.car.y).toBeCloseTo(GRADE * world.car.x, 4);
    }
    // Gravity along the slope less engine braking: about 0.5 m/s2, so about 2 m in 3 s, backwards.
    expect(world.car.x).toBeLessThan(99);
    expect(world.car.x).toBeGreaterThan(96);
    expect(minForward).toBeLessThan(-1);
    expect(world.car.forwardSpeed).toBeLessThan(-1);
  });

  it('holds a car parked on the slope with the handbrake', () => {
    const world = worldOn(makeSlopeLevel(GRADE));
    for (const heading of [0, Math.PI, Math.PI / 2]) {
      world.placeCar({ x: 100, z: 0, heading, y: 8 });
      for (let i = 0; i < 3 / DT; i++) world.step({ ...IDLE, handbrake: true });
      expect(Math.hypot(world.car.x - 100, world.car.z)).toBeLessThan(0.05);
    }
  });

  it('slows a car going uphill and speeds one up going downhill, smoothly', () => {
    const coast = (level: Level, x: number, heading: number): { speed: number; worstJerk: number } => {
      const world = worldOn(level);
      launch(world, x, 0, heading, 20, level.path[Math.round(x / 2)].y);
      let worstJerk = 0;
      let previous = 20;
      let previousChange = 0;
      for (let i = 0; i < 2 / DT; i++) {
        world.step(IDLE);
        const change = world.car.speed - previous;
        if (i > 2) worstJerk = Math.max(worstJerk, Math.abs(change - previousChange));
        previousChange = change;
        previous = world.car.speed;
        expect(world.car.airborne).toBe(false);
      }
      return { speed: world.car.speed, worstJerk };
    };
    const flat = coast(makeStraightLevel(200, 8), 60, 0);
    const up = coast(makeSlopeLevel(GRADE), 60, 0);
    const down = coast(makeSlopeLevel(GRADE), 160, Math.PI);
    const pull = (9.81 * GRADE) / (1 + GRADE * GRADE);
    // Two seconds of the pull along the slope (a little less or more drag at the other speed aside).
    for (const gained of [flat.speed - up.speed, down.speed - flat.speed]) {
      expect(gained).toBeGreaterThan(0.9 * 2 * pull);
      expect(gained).toBeLessThan(1.1 * 2 * pull);
    }
    expect(up.worstJerk).toBeLessThan(0.01);
    expect(down.worstJerk).toBeLessThan(0.01);
  });

  it('carries a car over the ramp level flat out without leaving the road', () => {
    const world = worldOn(makeRampLevel());
    let peak = 0;
    let steepest = 0;
    for (let i = 0; i < 20 / DT && world.car.x < RAMP.end - 10; i++) {
      world.step({ ...IDLE, throttle: 1, steer: hold(world.car, 0, world.car.z) });
      expect(world.car.airborne).toBe(false);
      expect(world.offTrack).toBe(false);
      expect(world.lastCollision).toBeNull();
      expect(world.car.y).toBeCloseTo(world.groundHeight(world.car.x, world.car.z, world.car.y), 1);
      peak = Math.max(peak, world.car.y);
      steepest = Math.max(steepest, Math.abs(world.car.pitchSlope));
    }
    expect(world.car.x).toBeGreaterThan(RAMP.end - 10);
    expect(peak).toBeCloseTo(RAMP.rise, 2);
    expect(steepest).toBeGreaterThan(0.11);
    expect(world.car.y).toBe(0);
  });
});

describe('a crossing', () => {
  it('lets a car drive under the bridge without touching its walls', () => {
    const level = makeCrossingLevel();
    const world = worldOn(level);
    launch(world, 10, 0, 0, 20);
    let underBridge = 0;
    for (let i = 0; i < 4 / DT && world.car.x < 95; i++) {
      world.step({ ...IDLE, throttle: world.car.speed < 26 ? 1 : 0, steer: hold(world.car, 0, world.car.z) });
      expect(world.lastCollision).toBeNull();
      expect(world.car.y).toBe(0);
      expect(world.offTrack).toBe(false);
      if (Math.abs(world.car.x - CROSSING.crossX) < CROSSING.halfWidth) {
        underBridge++;
        // The bridge's walls are 6 m to either side, but up at 7 m: only the walls of its own road count.
        expect(world.wallDistance).toBeGreaterThan(CROSSING.halfWidth - RADIUS - 0.5);
      }
    }
    expect(underBridge).toBeGreaterThan(20);
    expect(world.car.x).toBeGreaterThan(95);
  });

  it('lets a car drive over the bridge without touching the walls of the road below', () => {
    const world = worldOn(makeCrossingLevel());
    launch(world, CROSSING.crossX, 25, -Math.PI / 2, 20, CROSSING.height);
    expect(world.car.y).toBeCloseTo(CROSSING.height, 9);
    for (let i = 0; i < 2.5 / DT; i++) {
      world.step({ ...IDLE, throttle: world.car.speed < 25 ? 1 : 0, steer: hold(world.car, -Math.PI / 2, CROSSING.crossX - world.car.x) });
      expect(world.lastCollision).toBeNull();
      expect(world.car.y).toBeCloseTo(CROSSING.height, 9);
      expect(world.car.airborne).toBe(false);
      if (Math.abs(world.car.z) < 8) expect(world.wallDistance).toBeGreaterThan(CROSSING.halfWidth - RADIUS - 0.5);
    }
    expect(world.car.z).toBeLessThan(-30);
  });

  it('drops a car that drives off the open side of the bridge onto the road below, which is not off the track', () => {
    const world = worldOn(makeCrossingLevel(true));
    launch(world, CROSSING.crossX, 0, Math.PI, 8, CROSSING.height);
    let flew = 0;
    let landedAt = -1;
    for (let i = 0; i < 4 / DT; i++) {
      const was = world.car.airborne;
      world.step(IDLE);
      if (world.car.airborne) flew++;
      if (was && !world.car.airborne && landedAt < 0) landedAt = i;
      expect(world.offTrack).toBe(false);
    }
    expect(flew * DT).toBeGreaterThan(1);
    expect(landedAt).toBeGreaterThan(0);
    expect(world.car.y).toBe(0);
    expect(world.car.x).toBeLessThan(CROSSING.crossX - CROSSING.halfWidth - 2);
    expect(Math.abs(world.car.z)).toBeLessThan(CROSSING.halfWidth);
    // And it can drive on along the lower road.
    for (let i = 0; i < 1 / DT; i++) world.step({ ...IDLE, throttle: 0.5 });
    expect(world.offTrack).toBe(false);
  });
});

describe('falling off', () => {
  it('latches offTrack when a car drives off an open edge and comes to rest on the city floor', () => {
    const world = worldOn(makeOpenEdgeLevel());
    launch(world, OPEN_EDGE.openFrom + 10, 0, 0.35, 18, OPEN_EDGE.height);
    let airborneAt = -1;
    let offAt = -1;
    for (let i = 0; i < 4 / DT && offAt < 0; i++) {
      world.step(IDLE);
      if (world.car.airborne && airborneAt < 0) {
        airborneAt = i;
        // It left over the edge, not before.
        expect(world.car.z).toBeGreaterThan(OPEN_EDGE.halfWidth);
      }
      if (world.offTrack) offAt = i;
      else expect(world.car.y).toBeGreaterThan(TERRAIN_Y);
    }
    expect(airborneAt).toBeGreaterThan(0);
    expect(offAt).toBeGreaterThan(airborneAt + 0.8 / DT);
    expect(world.car.y).toBe(TERRAIN_Y);
    expect(world.car.airborne).toBe(false);
    // Latched while the car goes on stepping, cleared by placing it.
    for (let i = 0; i < 60; i++) world.step({ ...IDLE, throttle: 1 });
    expect(world.offTrack).toBe(true);
    world.placeCar(world.level.checkpoints[0].respawn);
    expect(world.offTrack).toBe(false);
    expect(world.car.y).toBe(world.level.checkpoints[0].y);
    world.step(IDLE);
    expect(world.offTrack).toBe(false);
  });

  it('never flags a car that drives the open-edged stretch down the middle, or weaves to within a metre of the edge', () => {
    for (const weave of [0, OPEN_EDGE.halfWidth - 1 - RADIUS]) {
      const world = worldOn(makeOpenEdgeLevel());
      launch(world, 5, 0, 0, 10);
      for (let i = 0; i < 25 / DT && world.car.x < OPEN_EDGE.end - 10; i++) {
        const line = Math.sin(world.car.x / 12) * weave;
        world.step({ ...IDLE, throttle: world.car.speed < 15 ? 1 : 0, steer: hold(world.car, 0, world.car.z - line) });
        expect(world.offTrack).toBe(false);
        expect(world.car.airborne).toBe(false);
      }
      expect(world.car.x).toBeGreaterThan(OPEN_EDGE.end - 10);
    }
  });

  it('lets a car fly over a barrier on a jump, and that ends on the floor', () => {
    const level = { ...makeStraightLevel(200, 8), bumps: [makeBump(60, 0, 0, 8, 0.8, 10)] };
    const world = worldOn(level);
    launch(world, 40, -6, 0.45, 38);
    let crossedInTheAir = false;
    for (let i = 0; i < 3 / DT && !world.offTrack; i++) {
      world.step(IDLE);
      if (world.car.airborne) {
        expect(world.lastCollision).toBeNull();
        if (world.car.z > 8 + RADIUS) crossedInTheAir = true;
      }
    }
    expect(crossedInTheAir).toBe(true);
    expect(world.offTrack).toBe(true);
    expect(world.car.y).toBe(TERRAIN_Y);
  });
});

describe('wallDistance', () => {
  it('measures from the body to the nearest wall or pillar at the car level, and is Infinity in open space', () => {
    const level: Level = {
      ...makeStraightLevel(200, 8),
      props: [
        { kind: 'pillar', x: 120, z: 0, y: 0, radius: 1, height: 4, hue: 0 },
        // A pillar standing on a road 7 m up (a bridge deck): not at the car's level.
        { kind: 'pillar', x: 80, z: 0, y: 7, radius: 1, height: 4, hue: 0 },
      ],
    };
    const world = worldOn(level);
    world.placeCar({ x: 50, z: 0, heading: 0 });
    expect(world.wallDistance).toBeCloseTo(8 - RADIUS, 9);
    world.placeCar({ x: 50, z: 5, heading: 0 });
    expect(world.wallDistance).toBeCloseTo(3 - RADIUS, 9);
    world.placeCar({ x: 50, z: 5, heading: Math.PI / 2 });
    expect(world.wallDistance).toBeCloseTo(3 - (DEFAULT_CAR_PARAMS.halfLength - RADIUS) - RADIUS, 9);
    world.placeCar({ x: 80, z: 0, heading: 0 });
    expect(world.wallDistance).toBeCloseTo(8 - RADIUS, 9);
    const reach = DEFAULT_CAR_PARAMS.halfLength - RADIUS;
    world.placeCar({ x: 120 - 1 - reach - RADIUS - 2, z: 0, heading: 0 });
    expect(world.wallDistance).toBeCloseTo(2, 9);
    // Touching is 0, never negative.
    world.placeCar({ x: 50, z: 8 - RADIUS, heading: 0 });
    expect(world.wallDistance).toBeCloseTo(0, 9);

    const open = worldOn(makeOpenLevel(400));
    open.placeCar({ x: 0, z: 0, heading: 0.3 });
    expect(open.wallDistance).toBe(Infinity);
    open.placeCar({ x: 200 - RADIUS - 7.5, z: 0, heading: Math.PI / 2 });
    expect(open.wallDistance).toBeCloseTo(7.5, 9);
    open.step(IDLE);
    expect(open.wallDistance).toBeCloseTo(7.5, 9);
  });
});

/** A follower along the centreline of chunks (by progress), `lookAhead` metres ahead. */
function follower(chunks: TrackChunk[], lookAhead: number) {
  const points = chunks.flatMap((chunk, i) => (i === 0 ? chunk.path : chunk.path.slice(1)));
  return (world: EndlessWorld): number => {
    const goal = world.trackDist + lookAhead;
    let at = 0;
    while (at < points.length - 2 && points[at + 1].dist < goal) at++;
    const a = points[at];
    const b = points[at + 1];
    const share = Math.min(1, Math.max(0, (goal - a.dist) / (b.dist - a.dist)));
    const targetX = a.x + (b.x - a.x) * share;
    const targetZ = a.z + (b.z - a.z) * share;
    const bearing = wrapAngle(atan2(targetZ - world.car.z, targetX - world.car.x) - world.car.heading);
    return Math.max(-1, Math.min(1, 2.5 * bearing - 0.2 * world.car.yawRate));
  };
}

describe('endless progress through a crossing', () => {
  it('follows the car over its own road, never jumping to the stretch below', () => {
    const chunks = makeCrossingChunks();
    const world = createEndlessWorld({ x: 0, z: 0, heading: 0 }, plantedParams());
    for (const chunk of chunks) world.addChunk(chunk);
    const steer = follower(chunks, 10);
    const total = chunks[chunks.length - 1].endDist;
    let previous = 0;
    let previousChunk = 0;
    let overTheCrossing = 0;
    for (let i = 0; i < 40 / DT && world.trackDist < total - 20; i++) {
      world.step({ ...IDLE, steer: steer(world), throttle: world.car.speed < 18 ? 1 : 0 });
      expect(world.offTrack).toBe(false);
      expect(world.car.airborne).toBe(false);
      expect(world.lastCollision).toBeNull();
      expect(world.trackDist).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(world.trackDist - previous).toBeLessThan(0.5);
      expect(world.chunkIndex - previousChunk).toBeGreaterThanOrEqual(0);
      expect(world.chunkIndex - previousChunk).toBeLessThanOrEqual(1);
      if (Math.abs(world.car.z) < CROSSING.halfWidth && Math.abs(world.car.x - CROSSING.crossX) < CROSSING.halfWidth && world.chunkIndex >= 2) {
        overTheCrossing++;
        expect(world.car.y).toBeCloseTo(CROSSING.height, 6);
        expect(world.chunkIndex).toBe(3);
      }
      previous = world.trackDist;
      previousChunk = world.chunkIndex;
    }
    expect(world.trackDist).toBeGreaterThan(total - 20);
    expect(overTheCrossing).toBeGreaterThan(20);
  });

  it('places the tracker on the layer the car is put on', () => {
    const chunks = makeCrossingChunks();
    const world = createEndlessWorld({ x: 0, z: 0, heading: 0 }, plantedParams());
    for (const chunk of chunks) world.addChunk(chunk);
    world.placeCar({ x: CROSSING.crossX, z: 0, heading: 0, y: 0 });
    expect(world.chunkIndex).toBe(0);
    expect(world.trackDist).toBeCloseTo(CROSSING.crossX, 6);
    expect(world.car.y).toBe(0);
    world.placeCar({ x: CROSSING.crossX, z: 0, heading: -Math.PI / 2, y: CROSSING.height });
    expect(world.chunkIndex).toBe(3);
    expect(world.trackDist).toBeGreaterThan(chunks[3].startDist);
    expect(world.car.y).toBeCloseTo(CROSSING.height, 9);
  });

  it('moves the tracker to the road below when the car falls onto it, which is not off the track', () => {
    const chunks = makeCrossingChunks(true);
    const world = createEndlessWorld({ x: 0, z: 0, heading: 0 }, plantedParams());
    for (const chunk of chunks) world.addChunk(chunk);
    launch(world, CROSSING.crossX, 0, Math.PI, 8, CROSSING.height);
    expect(world.chunkIndex).toBe(3);
    for (let i = 0; i < 3 / DT; i++) {
      world.step(IDLE);
      expect(world.offTrack).toBe(false);
      if (world.car.airborne) expect(world.chunkIndex).toBe(3);
    }
    expect(world.car.y).toBe(0);
    expect(world.chunkIndex).toBe(0);
    expect(world.trackDist).toBeCloseTo(Math.max(0, world.car.x), 6);
  });

  it('ends the run when the car falls off the bridge where there is no road below', () => {
    const chunks = makeCrossingChunks(true);
    const world = createEndlessWorld({ x: 0, z: 0, heading: 0 }, plantedParams());
    for (const chunk of chunks) world.addChunk(chunk);
    // Off the open stretch heading south-east, beyond the edge of the road below.
    launch(world, CROSSING.crossX, -10, 0.2, 10, CROSSING.height);
    for (let i = 0; i < 4 / DT && !world.offTrack; i++) world.step(IDLE);
    expect(world.offTrack).toBe(true);
    expect(world.car.y).toBe(TERRAIN_Y);
  });
});

describe('determinism', () => {
  function run(level: Level, seed: string): { hash: string; flights: number; contacts: number } {
    const world = worldOn(level);
    const rng = new Rng(seed);
    let held = IDLE;
    let flights = 0;
    let contacts = 0;
    let was = false;
    for (let i = 0; i < 40 / DT; i++) {
      if (i % 40 === 0) {
        held = { steer: rng.range(-1, 1), throttle: rng.chance(0.85) ? 1 : 0, brake: rng.chance(0.1) ? 1 : 0, handbrake: rng.chance(0.15), reset: false };
      }
      if (world.offTrack || i % 1200 === 0) world.placeCar(level.checkpoints[0].respawn);
      world.step(held);
      if (world.car.airborne && !was) flights++;
      was = world.car.airborne;
      if (world.lastCollision) contacts++;
    }
    return { hash: hashNumbers(world.snapshot()), flights, contacts };
  }

  it('gives the same hash for the same inputs on layered roads', () => {
    for (const level of [makeCrossingLevel(true), makeOpenEdgeLevel(), makeRampLevel()]) {
      const first = run(level, 'layers');
      expect(run(level, 'layers')).toEqual(first);
      expect(first.contacts).toBeGreaterThan(10);
      expect(run(level, 'other').hash).not.toBe(first.hash);
    }
  });
});

describe('a flat level at y = 0', () => {
  /** The flat simulation as it was before roads had heights: the car step on flat ground, then the walls. */
  function reference(level: Level, params = cloneParams(DEFAULT_CAR_PARAMS)) {
    const car = createCarState(level.start);
    const collider = buildCollider(level);
    return {
      car,
      step(input: InputState) {
        stepCar(car, params, input, DT);
        return resolveCollisions(car, params, collider);
      },
    };
  }

  it.each([
    ['a straight road', makeStraightLevel(300, 8)],
    ['an arena with pillars', { ...makeOpenLevel(160), props: [{ kind: 'pillar' as const, x: 30, z: 6, y: 0, radius: 1.5, height: 4, hue: 0 }] }],
  ])('behaves exactly like the flat simulation, with whatever handling the car has (%s)', (_name, level) => {
    const world = createWorld(level);
    const flat = reference(level);
    const rng = new Rng('flat');
    let held = IDLE;
    let contacts = 0;
    for (let i = 0; i < 40 / DT; i++) {
      if (i % 45 === 0) {
        held = { steer: rng.range(-1, 1), throttle: rng.chance(0.85) ? rng.next() : 0, brake: rng.chance(0.15) ? rng.next() : 0, handbrake: rng.chance(0.15), reset: false };
      }
      if (world.car.x > 250) {
        world.placeCar(level.start);
        flat.car.x = level.start.x;
        Object.assign(flat.car, createCarState(level.start));
      }
      world.step(held);
      const hit = flat.step(held);
      expect(world.car.pitchSlope).toBe(0);
      expect({ ...world.car, pitchSlope: 0 }).toEqual({ ...flat.car, pitchSlope: 0 });
      expect(world.lastCollision).toEqual(hit);
      expect(world.offTrack).toBe(false);
      if (hit) contacts++;
    }
    expect(contacts).toBeGreaterThan(50);
  });
});

describe('speed', () => {
  it('steps a world on a layered level quickly', () => {
    const world = worldOn(makeCrossingLevel(true));
    const rng = new Rng('speed');
    const inputs: InputState[] = [];
    for (let i = 0; i < 64; i++) inputs.push({ steer: rng.range(-1, 1), throttle: 1, brake: 0, handbrake: rng.chance(0.2), reset: false });
    const run = (ticks: number): number => {
      const start = performance.now();
      for (let i = 0; i < ticks; i++) {
        if (world.offTrack || i % 2000 === 0) world.placeCar(world.level.start);
        world.step(inputs[(i >> 5) & 63]);
      }
      return ((performance.now() - start) * 1000) / ticks;
    };
    run(20000);
    const micros = Math.min(run(60000), run(60000));
    console.log(`world.step: ${micros.toFixed(2)} us per tick`);
    expect(micros).toBeLessThan(40);
  });
});
