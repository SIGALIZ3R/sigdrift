/**
 * The endless world: chunks coming and going, progress along the road, and the difference between driving inside
 * the walls (never off the track) and coming down outside them (always off the track).
 */
import { describe, expect, it } from 'vitest';
import type { EndlessWorld, InputState, TrackChunk } from '../../src/types';
import { DT, TERRAIN_Y } from '../../src/types';
import { atan2, wrapAngle } from '../../src/core/fixedMath';
import { hashNumbers } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';
import { createEndlessWorld } from '../../src/sim/endlessWorld';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import type { ChunkShape } from '../helpers/handLevel';
import { makeBump, makeChunkRoad, makeStraightChunk, makeStraightLevel } from '../helpers/handLevel';
import { plantedParams } from '../helpers/testCar';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const ORIGIN = { x: 0, z: 0, heading: 0 };
const RADIUS = DEFAULT_CAR_PARAMS.collisionRadius;

function worldOf(chunks: TrackChunk[]): EndlessWorld {
  const world = createEndlessWorld(ORIGIN, plantedParams());
  for (const chunk of chunks) world.addChunk(chunk);
  return world;
}

function straightChunks(count: number, lengthEach: number, halfWidth: number): TrackChunk[] {
  const chunks: TrackChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push(makeStraightChunk(i, i * lengthEach, lengthEach, halfWidth));
  return chunks;
}

/** Sends the car off from a pose already moving at `speed` along its nose. */
function launch(world: EndlessWorld, x: number, z: number, heading: number, speed: number): void {
  world.placeCar({ x, z, heading });
  world.car.vx = speed * Math.cos(heading);
  world.car.vz = speed * Math.sin(heading);
}

/** Six joined chunks: straights, bends both ways, a plaza that doubles the width and narrows again. */
const SIX_CHUNKS: ChunkShape[] = [
  { length: 80 },
  { length: 70, turn: 1.2 },
  { length: 60, endHalfWidth: 16 },
  { length: 80, turn: -1.5, endHalfWidth: 8 },
  { length: 50, turn: -0.6 },
  { length: 90, turn: 0.9, endHalfWidth: 6 },
];

/**
 * Steers at a point on the centreline some way ahead of the car's progress, `aside` metres to the right of it.
 * Good enough to lap any hand-built road; with a large `aside` it grinds along the wall instead.
 */
function follower(chunks: TrackChunk[], lookAhead: number, aside = 0) {
  const points = chunks.flatMap((chunk, i) => (i === 0 ? chunk.path : chunk.path.slice(1)));
  return (world: EndlessWorld): number => {
    const goal = world.trackDist + lookAhead;
    let at = 0;
    while (at < points.length - 2 && points[at + 1].dist < goal) at++;
    const a = points[at];
    const b = points[at + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const share = Math.min(1, Math.max(0, (goal - a.dist) / (b.dist - a.dist)));
    const targetX = a.x + (b.x - a.x) * share - ((b.z - a.z) / length) * aside;
    const targetZ = a.z + (b.z - a.z) * share + ((b.x - a.x) / length) * aside;
    const bearing = wrapAngle(atan2(targetZ - world.car.z, targetX - world.car.x) - world.car.heading);
    return Math.max(-1, Math.min(1, 2.5 * bearing));
  };
}

describe('a flat endless road', () => {
  it('drives exactly like a fixed level with the same walls', () => {
    const level = makeStraightLevel(300, 8);
    const fixed = createWorld(level, plantedParams());
    const endless = worldOf(straightChunks(3, 100, 8));
    const rng = new Rng('equivalence');
    let held = IDLE;
    let contacts = 0;
    for (let i = 0; i < 60 / DT; i++) {
      if (i % 45 === 0) {
        held = {
          steer: rng.range(-1, 1),
          throttle: rng.chance(0.85) ? rng.next() : 0,
          brake: rng.chance(0.15) ? rng.next() : 0,
          handbrake: rng.chance(0.15),
          reset: false,
        };
      }
      // The level is closed beyond 300 m and the chunks are not: turn back before that matters.
      if (fixed.car.x > 250) {
        fixed.placeCar(level.start);
        endless.placeCar(level.start);
      }
      fixed.step(held);
      endless.step(held);
      expect(endless.car).toEqual(fixed.car);
      expect(endless.lastCollision).toEqual(fixed.lastCollision);
      if (fixed.lastCollision) contacts++;
      expect(endless.offTrack).toBe(false);
    }
    // Both ran into the walls plenty, including the one behind the start.
    expect(contacts).toBeGreaterThan(100);
    expect(endless.snapshot().slice(0, fixed.snapshot().length)).toEqual(fixed.snapshot());
    expect(endless.car.y).toBe(0);
    expect(endless.car.vy).toBe(0);
    expect(endless.car.airborne).toBe(false);
  });

  it('starts at rest on the start pose with nothing live, and snapshots tick, car, flight and progress', () => {
    const params = cloneParams(DEFAULT_CAR_PARAMS);
    const world = createEndlessWorld({ x: 3, z: -1, heading: 0.2 }, params);
    expect(world.params).toBe(params);
    expect(world.chunks).toHaveLength(0);
    expect(world.car).toMatchObject({ x: 3, z: -1, heading: 0.2, speed: 0, y: 0, vy: 0, airborne: false });
    expect(world.offTrack).toBe(false);
    expect(world.groundHeight(3, -1, 0)).toBe(TERRAIN_Y);
    // With no road there is nothing to be off: stepping is harmless.
    world.step({ ...IDLE, throttle: 1 });
    expect(world.offTrack).toBe(false);
    expect(world.tick).toBe(1);

    for (const chunk of straightChunks(2, 100, 8)) world.addChunk(chunk);
    for (let i = 0; i < 240; i++) world.step({ ...IDLE, throttle: 1, steer: 0.3 });
    const snapshot = world.snapshot();
    const car = world.car;
    expect(snapshot[0]).toBe(241);
    for (const value of [car.x, car.z, car.heading, car.vx, car.vz, car.yawRate, car.steerAngle, world.trackDist]) {
      expect(snapshot).toContain(value);
    }
    // ... height, vertical speed, airborne, off the track, progress.
    expect(snapshot.slice(-5)).toEqual([car.y, car.vy, 0, 0, world.trackDist]);
    expect(snapshot.every(Number.isFinite)).toBe(true);
  });

  it('refuses a chunk that does not follow the last one', () => {
    const world = worldOf(straightChunks(2, 100, 8));
    expect(() => world.addChunk(makeStraightChunk(3, 300, 100, 8))).toThrow();
    expect(() => world.addChunk(makeStraightChunk(1, 100, 100, 8))).toThrow();
    world.addChunk(makeStraightChunk(2, 200, 100, 8));
    expect(world.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    // Once everything has been dropped any index may start the road again.
    world.dropChunksBefore(99);
    expect(world.chunks).toHaveLength(0);
    world.addChunk(makeStraightChunk(7, 700, 100, 8));
    expect(world.chunks.map((chunk) => chunk.index)).toEqual([7]);
  });
});

describe('progress along the road', () => {
  it('rises steadily through six joined chunks without ever leaving the track', () => {
    const chunks = makeChunkRoad(SIX_CHUNKS);
    const world = worldOf(chunks);
    const steer = follower(chunks, 14);
    const total = chunks[5].endDist;
    let previous = world.trackDist;
    let previousChunk = 0;
    let finished = false;
    for (let i = 0; i < 60 / DT && !finished; i++) {
      world.step({ ...IDLE, steer: steer(world), throttle: world.car.speed < 22 ? 1 : 0 });
      expect(world.offTrack).toBe(false);
      expect(world.car.airborne).toBe(false);
      expect(world.trackDist).toBeGreaterThanOrEqual(previous);
      expect(world.chunkIndex).toBeGreaterThanOrEqual(previousChunk);
      expect(world.chunkIndex - previousChunk).toBeLessThanOrEqual(1);
      previous = world.trackDist;
      previousChunk = world.chunkIndex;
      finished = world.trackDist > total - 10;
    }
    expect(finished).toBe(true);
    expect(world.chunkIndex).toBe(5);
    expect(world.lastCollision).toBeNull();
  });

  it('measures distance along the centreline, whichever side of the road the car is on', () => {
    const world = worldOf(straightChunks(3, 100, 8));
    for (const z of [-6, 0, 6]) {
      world.placeCar({ x: 137.5, z, heading: 0 });
      expect(world.trackDist).toBeCloseTo(137.5, 9);
      expect(world.chunkIndex).toBe(1);
      expect(world.offTrack).toBe(false);
    }
    world.placeCar({ x: 250, z: 2, heading: 1 });
    expect(world.trackDist).toBeCloseTo(250, 9);
    expect(world.chunkIndex).toBe(2);
  });

  it.each([7, -7])('stays on the track while grinding along a wall through every bend and the plaza (%i m aside)', (aside) => {
    const chunks = makeChunkRoad(SIX_CHUNKS);
    const world = worldOf(chunks);
    // Aiming beyond the road's edge keeps the car pressed against the wall on that side, at a shallow angle.
    const steer = follower(chunks, 12, aside * 1.6);
    const total = chunks[5].endDist;
    let contacts = 0;
    let finished = false;
    let stalled = 0;
    const points = chunks.flatMap((chunk, i) => (i === 0 ? chunk.path : chunk.path.slice(1)));
    for (let i = 0; i < 90 / DT && !finished; i++) {
      // Slow enough that the car scrapes round rather than spinning on the wall (the handling has its own tests).
      world.step({ ...IDLE, steer: steer(world), throttle: world.car.speed < 12 ? 1 : 0 });
      expect(world.offTrack).toBe(false);
      if (world.lastCollision) contacts++;
      finished = world.trackDist > total - 10;
      // Spun and stalled against the wall: put it back on the road a little further on and carry on grinding.
      stalled = world.car.speed < 1 ? stalled + 1 : 0;
      if (stalled > 1.5 / DT) {
        stalled = 0;
        const at = points.findIndex((p) => p.dist > world.trackDist + 6);
        const a = points[at];
        const b = points[at + 1];
        world.placeCar({ x: a.x, z: a.z, heading: Math.atan2(b.z - a.z, b.x - a.x) });
      }
    }
    expect(finished).toBe(true);
    expect(contacts).toBeGreaterThan(300);
  });

  it('stays on the track under a minute of random thrashing between the walls', () => {
    const chunks = makeChunkRoad([...SIX_CHUNKS, { length: 60, turn: 2.2 }, { length: 60, turn: -2.2 }]);
    for (const seed of ['thrash-1', 'thrash-2', 'thrash-3']) {
      const world = worldOf(chunks);
      const rng = new Rng(seed);
      const total = chunks[chunks.length - 1].endDist;
      let held = IDLE;
      let contacts = 0;
      for (let i = 0; i < 60 / DT; i++) {
        if (i % 50 === 0) {
          const steer = rng.range(-1, 1);
          held = { ...IDLE, steer, throttle: rng.chance(0.9) ? 1 : 0, brake: rng.chance(0.1) ? 1 : 0, handbrake: rng.chance(0.1) };
        }
        // The far end of the last chunk is open: go back to the start before reaching it.
        if (world.trackDist > total - 40) world.placeCar(ORIGIN);
        world.step(held);
        expect(world.offTrack).toBe(false);
        expect(world.car.airborne).toBe(false);
        if (world.lastCollision) contacts++;
      }
      expect(contacts).toBeGreaterThan(50);
    }
  });

  it('is not fooled by the wall behind the start', () => {
    const world = worldOf(straightChunks(2, 100, 8));
    let contacts = 0;
    for (let i = 0; i < 8 / DT; i++) {
      world.step({ ...IDLE, brake: 1, steer: i % 240 < 120 ? 0.4 : -0.4 });
      expect(world.offTrack).toBe(false);
      if (world.lastCollision) contacts++;
    }
    // It backed 6 m past the first path point into the closing wall and is still on the road.
    expect(contacts).toBeGreaterThan(0);
    expect(world.car.x).toBeLessThan(-2);
    expect(world.car.x).toBeGreaterThan(-6);
    expect(world.trackDist).toBe(0);
    expect(world.chunkIndex).toBe(0);
  });
});

describe('dropping chunks', () => {
  it('forgets them: no walls, no bumps, and the live list starts at the new oldest chunk', () => {
    const chunks = straightChunks(4, 100, 8);
    chunks[0].bumps.push(makeBump(50, 0, 0, 8));
    chunks[2].bumps.push(makeBump(250, 0, 0, 8));
    const world = worldOf(chunks);
    expect(world.groundHeight(50, 0, 0)).toBeCloseTo(0.5, 9);
    expect(world.groundHeight(250, 3, 0)).toBeCloseTo(0.5, 9);

    world.dropChunksBefore(2);
    expect(world.chunks.map((chunk) => chunk.index)).toEqual([2, 3]);
    expect(world.groundHeight(50, 0, 0)).toBe(TERRAIN_Y);
    expect(world.groundHeight(250, 3, 0)).toBeCloseTo(0.5, 9);
    world.dropChunksBefore(1);
    expect(world.chunks.map((chunk) => chunk.index)).toEqual([2, 3]);

    // Where chunk 1's side wall used to be there is nothing left to hit: a car out there crosses the old line.
    launch(world, 150, 5, Math.PI / 2, 20);
    for (let i = 0; i < 60; i++) {
      world.step(IDLE);
      expect(world.lastCollision).toBeNull();
    }
    expect(world.car.z).toBeGreaterThan(12);
    // The same crossing where the road is still live is stopped by the wall.
    launch(world, 250, 5, Math.PI / 2, 20);
    let contacts = 0;
    for (let i = 0; i < 60; i++) {
      world.step(IDLE);
      if (world.lastCollision) contacts++;
    }
    expect(contacts).toBeGreaterThan(0);
    expect(world.car.z).toBeLessThan(8);
  });

  it('closes the entry of the oldest chunk with a wall the car cannot back through', () => {
    const world = worldOf(straightChunks(4, 100, 8));
    world.placeCar({ x: 230, z: 0, heading: 0 });
    world.dropChunksBefore(2);
    for (const z of [-6.5, -2, 0, 3, 6.5]) {
      launch(world, 215, z, 0, -30);
      let hardest = 0;
      for (let i = 0; i < 3 / DT; i++) {
        world.step({ ...IDLE, brake: 1 });
        if (world.lastCollision) hardest = Math.max(hardest, world.lastCollision.impact);
        expect(world.car.x - DEFAULT_CAR_PARAMS.halfLength).toBeGreaterThan(200 - 0.01);
        expect(world.offTrack).toBe(false);
      }
      expect(hardest).toBeGreaterThan(15);
      expect(world.chunkIndex).toBe(2);
      expect(world.trackDist).toBeGreaterThanOrEqual(200);
    }
  });

  it('moves the closing wall along as more chunks go, leaving no wall where it used to be', () => {
    const world = worldOf(straightChunks(5, 100, 8));
    world.placeCar({ x: 350, z: 0, heading: 0 });
    world.dropChunksBefore(1);
    world.dropChunksBefore(3);
    // Driving forwards across x = 100 and x = 200 on what is left of nothing: no cap, no walls.
    launch(world, 80, 0, 0, 30);
    for (let i = 0; i < 8 / DT && world.car.x < 290; i++) {
      world.step({ ...IDLE, throttle: 1 });
      expect(world.lastCollision).toBeNull();
    }
    expect(world.car.x).toBeGreaterThan(250);
    // The cap is at x = 300 now, and solid from the inside.
    launch(world, 320, 0, 0, -25);
    let contacts = 0;
    for (let i = 0; i < 2 / DT; i++) {
      world.step(IDLE);
      if (world.lastCollision) contacts++;
      expect(world.car.x - DEFAULT_CAR_PARAMS.halfLength).toBeGreaterThan(300 - 0.01);
    }
    expect(contacts).toBeGreaterThan(0);
  });

  it('keeps following the car when the chunks behind it are dropped as it drives', () => {
    const world = worldOf(straightChunks(3, 100, 8));
    let next = 3;
    let previous = 0;
    for (let i = 0; i < 40 / DT; i++) {
      const car = world.car;
      const weave = i % 400 < 200 ? 0.05 : -0.05;
      world.step({ ...IDLE, throttle: 1, steer: Math.max(-1, Math.min(1, weave - 2 * car.heading - 0.05 * car.z - 0.3 * car.yawRate)) });
      // Stream like the mode does: two chunks ahead, one behind.
      while (world.chunks[world.chunks.length - 1].index < world.chunkIndex + 2) {
        world.addChunk(makeStraightChunk(next, next * 100, 100, 8));
        next++;
      }
      world.dropChunksBefore(world.chunkIndex - 1);
      expect(world.chunks.length).toBeLessThanOrEqual(4);
      expect(world.offTrack).toBe(false);
      expect(world.trackDist).toBeGreaterThanOrEqual(previous);
      expect(world.trackDist).toBeCloseTo(Math.max(0, world.car.x), 6);
      expect(world.chunkIndex).toBe(Math.max(0, Math.floor(world.car.x / 100)));
      previous = world.trackDist;
    }
    expect(world.trackDist).toBeGreaterThan(1200);
    expect(next).toBeGreaterThan(12);
  });
});

describe('leaving the road', () => {
  it('is fatal when a jump taken diagonally carries the car over the wall', () => {
    const world = createEndlessWorld(ORIGIN, plantedParams());
    world.addChunk(makeStraightChunk(0, 0, 100, 8, [makeBump(60, 0, 0, 8)]));
    world.addChunk(makeStraightChunk(1, 100, 100, 8));
    launch(world, 40, -6, 0.45, 38);
    let flew = 0;
    let landedAt = -1;
    let offAt = -1;
    let crossedInTheAir = false;
    for (let i = 0; i < 2 / DT; i++) {
      const wasAirborne = world.car.airborne;
      world.step(IDLE);
      const car = world.car;
      if (car.airborne) {
        flew++;
        // Over the wall, not through it, and not yet off the track: it has not come down.
        expect(world.lastCollision).toBeNull();
        expect(world.offTrack).toBe(false);
        if (car.z > 8 + RADIUS) crossedInTheAir = true;
      }
      if (wasAirborne && !car.airborne && landedAt < 0) landedAt = i;
      if (world.offTrack && offAt < 0) offAt = i;
    }
    expect(flew).toBeGreaterThan(60);
    expect(crossedInTheAir).toBe(true);
    expect(landedAt).toBeGreaterThan(0);
    expect(offAt).toBe(landedAt);
    expect(world.car.z).toBeGreaterThan(12);
    // Latched: it stays off however long the run goes on, until the car is placed again.
    expect(world.offTrack).toBe(true);
    world.placeCar({ x: 20, z: 0, heading: 0 });
    expect(world.offTrack).toBe(false);
    expect(world.car.airborne).toBe(false);
    expect(world.lastCollision).toBeNull();
    world.step(IDLE);
    expect(world.offTrack).toBe(false);
  });

  it('is not triggered by a jump that comes down on the road', () => {
    const world = createEndlessWorld(ORIGIN, plantedParams());
    world.addChunk(makeStraightChunk(0, 0, 100, 8, [makeBump(60, 0, 0, 8)]));
    world.addChunk(makeStraightChunk(1, 100, 100, 8));
    world.addChunk(makeStraightChunk(2, 200, 100, 8));
    for (const [z, heading] of [[0, 0], [-4, 0.1], [5, -0.12]]) {
      launch(world, 30, z, heading, 36);
      let flew = 0;
      let previous = world.trackDist;
      for (let i = 0; i < 2.5 / DT; i++) {
        world.step({ ...IDLE, steer: world.car.airborne ? 0 : -2 * world.car.heading });
        if (world.car.airborne) flew++;
        expect(world.offTrack).toBe(false);
        // Progress carries on through the air.
        expect(world.trackDist).toBeGreaterThanOrEqual(previous);
        previous = world.trackDist;
      }
      expect(flew).toBeGreaterThan(80);
      expect(world.car.airborne).toBe(false);
      expect(world.chunkIndex).toBeGreaterThanOrEqual(1);
    }
  });

  it('hits the wall as usual when it is not high enough to clear it', () => {
    const world = createEndlessWorld(ORIGIN, plantedParams());
    world.addChunk(makeStraightChunk(0, 0, 100, 8, [makeBump(60, 0, 0, 8)]));
    world.addChunk(makeStraightChunk(1, 100, 100, 8));
    // Slow enough that the hop is a few centimetres: the car reaches the wall low.
    launch(world, 44, 0, 0.6, 16);
    let hitWhileAirborne = false;
    let contacts = 0;
    for (let i = 0; i < 3 / DT; i++) {
      world.step(IDLE);
      if (world.lastCollision) {
        contacts++;
        hitWhileAirborne = hitWhileAirborne || world.car.airborne;
      }
      expect(world.offTrack).toBe(false);
      expect(Math.abs(world.car.z)).toBeLessThan(8);
    }
    expect(contacts).toBeGreaterThan(0);
    expect(world.car.airborne).toBe(false);
    expect(hitWhileAirborne || contacts > 0).toBe(true);
  });

  it('always hits pillars, however high the car is flying', () => {
    const build = (pillar: boolean): EndlessWorld => {
      const world = createEndlessWorld(ORIGIN, plantedParams());
      const chunk = makeStraightChunk(0, 0, 200, 8, [makeBump(60, 0, 0, 8)]);
      if (pillar) chunk.props.push({ kind: 'pillar', x: 78, z: 0, y: 0, radius: 1.2, height: 5, hue: 0 });
      world.addChunk(chunk);
      launch(world, 30, 0, 0, 36);
      return world;
    };
    const blocked = build(true);
    const clear = build(false);
    let hitHeight = -1;
    for (let i = 0; i < 2 / DT; i++) {
      blocked.step(IDLE);
      clear.step(IDLE);
      if (blocked.lastCollision && hitHeight < 0) {
        hitHeight = blocked.car.y;
        expect(blocked.car.airborne).toBe(true);
      }
    }
    // It met the pillar in mid-air, well above wall height, and was stopped; without the pillar it flies on.
    expect(hitHeight).toBeGreaterThan(0.8);
    expect(blocked.car.x).toBeLessThan(78);
    expect(clear.car.x).toBeGreaterThan(95);
  });

  it('is legal when the car comes down on another stretch of road, and the progress moves there', () => {
    // A hairpin: out along +x, round to the right, back along -x 22 m to the side. A bump on the way out.
    const chunks = makeChunkRoad([{ length: 80, bumpsAt: [40] }, { length: 11 * Math.PI, turn: Math.PI }, { length: 80 }], 6);
    chunks[0].bumps[0].height = 0.65;
    const world = worldOf(chunks);
    launch(world, 33, -4, 0.5, 40);
    let takeoff = -1;
    let landed = false;
    let landing = { chunk: -1, dist: 0, z: 0 };
    for (let i = 0; i < 1.6 / DT && !landed; i++) {
      const wasAirborne = world.car.airborne;
      world.step(IDLE);
      expect(world.offTrack).toBe(false);
      if (world.car.airborne) expect(world.lastCollision).toBeNull();
      if (world.car.airborne && takeoff < 0) takeoff = world.trackDist;
      if (wasAirborne && !world.car.airborne) {
        landed = true;
        landing = { chunk: world.chunkIndex, dist: world.trackDist, z: world.car.z };
      }
    }
    expect(landed).toBe(true);
    // It took off half way down the first straight and came down on the way back, beyond the hairpin.
    expect(takeoff).toBeGreaterThan(30);
    expect(takeoff).toBeLessThan(45);
    expect(landing.z).toBeGreaterThan(16);
    expect(landing.z).toBeLessThan(28);
    expect(landing.chunk).toBeGreaterThanOrEqual(1);
    expect(landing.dist).toBeGreaterThan(100);
    expect(world.offTrack).toBe(false);
  });

  it('is fatal when the same hop falls short, into the gap between the two stretches', () => {
    const chunks = makeChunkRoad([{ length: 80, bumpsAt: [40] }, { length: 13 * Math.PI, turn: Math.PI }, { length: 80 }], 6);
    const world = worldOf(chunks);
    launch(world, 33, -4, 0.5, 40);
    for (let i = 0; i < 3 / DT && !world.offTrack; i++) world.step(IDLE);
    expect(world.offTrack).toBe(true);
    expect(world.car.y).toBe(TERRAIN_Y);
    expect(world.car.airborne).toBe(false);
    expect(world.car.z).toBeGreaterThan(6);
    expect(world.car.z).toBeLessThan(20);
  });
});

/** Where the three body circles are across a road that runs along +x: the z of the rear, middle and front one. */
function bodyAcross(world: EndlessWorld): number[] {
  const reach = world.params.halfLength - world.params.collisionRadius;
  const along = Math.sin(world.car.heading) * reach;
  return [world.car.z - along, world.car.z, world.car.z + along];
}

describe('coming back down to the walls', () => {
  const HALF = 8;

  function bumpStraight(height: number, length: number): EndlessWorld {
    const world = createEndlessWorld(ORIGIN, plantedParams());
    world.addChunk(makeStraightChunk(0, 0, 100, HALF, [makeBump(60, 0, 0, HALF, height, length)]));
    world.addChunk(makeStraightChunk(1, 100, 100, HALF));
    world.addChunk(makeStraightChunk(2, 200, 400, HALF));
    return world;
  }

  /**
   * Flies the car over the bump with no hands on the controls, then tries to drive on. Whenever the walls are solid
   * for it the whole body must be on one side of each of them, and at the end it is either off the track or free.
   */
  function flyAndDriveOn(world: EndlessWorld): { off: boolean; flew: number; movedOn: number } {
    let flew = 0;
    const settle = (ticks: number, input: InputState): void => {
      for (let i = 0; i < ticks && !world.offTrack; i++) {
        world.step(input);
        if (world.car.airborne) flew++;
        // Low enough to touch a wall: no circle may be across one from the others.
        if (world.car.y - world.groundHeight(world.car.x, world.car.z, 0) < 0.5) {
          const [rear, middle, front] = bodyAcross(world);
          const side = (z: number): number => (z > HALF ? 1 : z < -HALF ? -1 : 0);
          if (side(rear) !== side(middle) || side(front) !== side(middle)) {
            expect.fail(`straddling the wall at x=${world.car.x.toFixed(1)}: ${rear}, ${middle}, ${front}`);
          }
        }
      }
    };
    settle(5 / DT, IDLE);
    if (world.offTrack) return { off: true, flew, movedOn: 0 };
    // Still in the run: then the car is inside the walls and can be driven away down the road.
    for (const z of bodyAcross(world)) expect(Math.abs(z)).toBeLessThan(HALF);
    // Wherever it is pointing: a pinned car cannot move at all, a free one gets clean away.
    const fromX = world.car.x;
    const fromZ = world.car.z;
    let movedOn = 0;
    // Drive towards +x down the middle; nose against a wall, back off it first (a three-point turn).
    let reversing = 0;
    let stuck = 0;
    for (let i = 0; i < 6 / DT && !world.offTrack; i++) {
      const car = world.car;
      const turn = wrapAngle(-car.heading);
      // Facing back down the road, turn the way that swings the nose away from the nearer wall.
      const steer =
        Math.abs(turn) > 2.5 ? (car.z > 0 ? 1 : -1) : Math.max(-1, Math.min(1, 2 * turn - (Math.abs(turn) < 1 ? 0.2 * car.z : 0)));
      if (reversing > 0) {
        reversing--;
        settle(1, { ...IDLE, brake: 1, steer: -steer });
      } else {
        settle(1, { ...IDLE, throttle: 0.6, steer });
        stuck = car.speed < 1 ? stuck + 1 : 0;
        if (stuck > 30) {
          reversing = 150;
          stuck = 0;
        }
      }
      movedOn = Math.max(movedOn, Math.hypot(car.x - fromX, car.z - fromZ));
    }
    return { off: world.offTrack, flew, movedOn };
  }

  it('does not leave a car that clipped the wall and turned in the air pinned across it', () => {
    // It scrapes the wall on the way up, which kicks it into a spin; its tail swings out over the wall in the air.
    const world = bumpStraight(0.5, 12);
    launch(world, 60 - 20 * Math.cos(0.2), 3, 0.2, 36);
    const result = flyAndDriveOn(world);
    expect(result.flew).toBeGreaterThan(30);
    expect(result.off).toBe(false);
    // A pinned car cannot move at all; a free one gets away (how far depends on the handling).
    expect(result.movedOn).toBeGreaterThan(4);
  });

  it('brings the car down whole on one side of the wall, whatever the approach', () => {
    let died = 0;
    let droveOn = 0;
    for (const [height, length] of [[0.4, 10], [0.5, 12], [0.8, 10], [0.65, 14]]) {
      for (let speed = 22; speed <= 44; speed += 3) {
        for (let heading = 0.08; heading <= 0.33; heading += 0.04) {
          for (const z of [0, 3, 5]) {
            const world = bumpStraight(height, length);
            launch(world, 60 - 20 * Math.cos(heading), z, heading, speed);
            const result = flyAndDriveOn(world);
            if (result.off) died++;
            else {
              // Never stuck: a car that is still in the run gets away from where it came down.
              expect(result.movedOn, `h${height} l${length} v${speed} a${heading.toFixed(2)} z${z}`).toBeGreaterThan(4);
              droveOn++;
            }
          }
        }
      }
    }
    expect(died).toBeGreaterThan(100);
    expect(droveOn).toBeGreaterThan(100);
    // About 2 s alone; the default 5 s is too tight when the whole suite runs in parallel.
  }, 30_000);

  it('launches a car that is rubbing the wall just as it would in the middle of the road', () => {
    const fly = (z: number, steer: number): { air: number; peak: number; contacts: number; hardest: number } => {
      const world = bumpStraight(0.8, 10);
      launch(world, 30, z, 0, 30);
      let air = 0;
      let peak = 0;
      let contacts = 0;
      let hardest = 0;
      for (let i = 0; i < 3 / DT && !world.offTrack; i++) {
        const onBump = world.car.x > 54 && world.car.x < 66;
        world.step({ ...IDLE, steer, throttle: world.car.speed < 30 ? 1 : 0 });
        if (world.car.airborne) air++;
        peak = Math.max(peak, world.car.y - world.groundHeight(world.car.x, world.car.z, 0));
        if (world.lastCollision && onBump) contacts++;
        if (world.lastCollision) hardest = Math.max(hardest, world.lastCollision.impact);
      }
      return { air: air * DT, peak, contacts, hardest };
    };
    const middle = fly(0, 0);
    expect(middle.contacts).toBe(0);
    expect(middle.air).toBeGreaterThan(1.2);
    expect(middle.peak).toBeGreaterThan(2.5);
    for (const steer of [0.3, 1]) {
      const rubbing = fly(HALF - RADIUS - 0.05, steer);
      // It was leaning on the wall up the ramp, never hard enough to count as a crash...
      expect(rubbing.contacts).toBeGreaterThan(5);
      expect(rubbing.hardest).toBeLessThan(4);
      // ...and the crest still threw it.
      expect(rubbing.air).toBeGreaterThan(0.7 * middle.air);
      expect(rubbing.peak).toBeGreaterThan(0.7 * middle.peak);
    }
  });
});

describe('landing beside a widening of the road', () => {
  // Along +x: 60 m at half width 9 with a bump, a steep 12 m taper out to a plaza of half width 17, then the plaza.
  const NARROW = 9;
  const WIDE = 17;
  const TAPER_FROM = 60;
  const TAPER_TO = 72;

  function plazaRoad(): TrackChunk[] {
    return makeChunkRoad(
      [{ length: TAPER_FROM, bumpsAt: [36] }, { length: TAPER_TO - TAPER_FROM, endHalfWidth: WIDE }, { length: 120 }, { length: 200 }],
      NARROW,
    );
  }

  /** Half width of the road at x: the walls are straight lines between these. */
  function halfWidthAt(x: number): number {
    const share = Math.max(0, Math.min(1, (x - TAPER_FROM) / (TAPER_TO - TAPER_FROM)));
    return NARROW + (WIDE - NARROW) * share;
  }

  it('never has road outside the walls beside the widening: a car coming down there falls to the floor', () => {
    let outsideFalls = 0;
    let besideThePlaza = 0;
    let insideLandings = 0;
    for (let speed = 26; speed <= 44; speed += 3) {
      for (let heading = 0.04; heading <= 0.4; heading += 0.02) {
        for (const z of [0, 3, 5.7]) {
          const road = plazaRoad();
          road[0].bumps[0].height = 0.6;
          const world = worldOf(road);
          launch(world, 26, z, heading, speed);
          let previous = world.trackDist;
          let wasAirborne = false;
          let beside = false;
          for (let i = 0; i < 4 / DT && !world.offTrack; i++) {
            world.step(IDLE);
            const car = world.car;
            // The car covers under 0.4 m a tick, and its progress moves no faster, in the air or on landing. (A wall
            // it comes down across may shove it most of its own length, and its progress with it.)
            const most = world.lastCollision ? 3 : 0.5;
            if (!(Math.abs(world.trackDist - previous) < most)) {
              expect.fail(`progress jumped ${world.trackDist - previous} m at x=${car.x.toFixed(1)} (v${speed} a${heading.toFixed(2)} z${z})`);
            }
            previous = world.trackDist;
            const beyond = Math.abs(car.z) - halfWidthAt(car.x);
            // Inside the disc of the plaza's first point, but outside the walls that lead up to it.
            if (beyond > 0.3 && car.x > TAPER_FROM - 8 && car.x < TAPER_TO && Math.abs(car.z) < WIDE + 0.5) beside = true;
            // Standing at road height means standing on the road: never beyond its edge.
            if (!car.airborne && car.y > -1 && beyond > 0.25 + 1e-6) {
              expect.fail(`on the ground ${beyond.toFixed(2)} m outside the road at x=${car.x.toFixed(1)} (v${speed} a${heading.toFixed(2)} z${z})`);
            }
            if (wasAirborne && !car.airborne && car.y > -1) insideLandings++;
            wasAirborne = car.airborne;
          }
          if (world.offTrack) {
            outsideFalls++;
            if (beside) besideThePlaza++;
            expect(world.car.y).toBe(TERRAIN_Y);
          }
        }
      }
    }
    expect(outsideFalls).toBeGreaterThan(50);
    expect(besideThePlaza).toBeGreaterThan(3);
    expect(insideLandings).toBeGreaterThan(50);
  });
});

describe('determinism', () => {
  /** A minute on a bumpy, bendy road, streaming chunks, restarting whenever the run would have ended. */
  function run(seed: string): { hash: string; flights: number; contacts: number; restarts: number; distance: number } {
    const shapes: ChunkShape[] = [];
    const rng = new Rng('road');
    for (let i = 0; i < 40; i++) {
      shapes.push({ length: 70, turn: i % 3 === 0 ? 0 : rng.range(-0.6, 0.6), bumpsAt: i % 2 === 1 ? [35] : [] });
    }
    const chunks = makeChunkRoad(shapes, 9);
    const world = createEndlessWorld(ORIGIN, plantedParams());
    let next = 0;
    const stream = (): void => {
      while (next < chunks.length && (world.chunks.length === 0 || next <= world.chunkIndex + 2)) world.addChunk(chunks[next++]);
      world.dropChunksBefore(world.chunkIndex - 1);
    };
    stream();
    const steer = follower(chunks, 16);
    const noise = new Rng(seed);
    let wobble = 0;
    let flights = 0;
    let contacts = 0;
    let restarts = 0;
    let distance = 0;
    let wasAirborne = false;
    let stalled = 0;
    for (let i = 0; i < 60 / DT; i++) {
      if (i % 30 === 0) wobble = noise.range(-0.3, 0.3);
      const input = { ...IDLE, steer: Math.max(-1, Math.min(1, steer(world) + wobble)), throttle: world.car.speed < 32 ? 1 : 0 };
      world.step(input);
      stream();
      if (world.car.airborne && !wasAirborne) flights++;
      wasAirborne = world.car.airborne;
      if (world.lastCollision) contacts++;
      distance = Math.max(distance, world.trackDist);
      // A car that spun and stalled against a wall is put back too (the handling has its own tests).
      stalled = world.car.speed < 1 ? stalled + 1 : 0;
      if (world.offTrack || world.chunkIndex >= chunks.length - 2 || stalled > 2 / DT) {
        stalled = 0;
        restarts++;
        const chunk = world.chunks[0];
        const a = chunk.path[4];
        const b = chunk.path[5];
        world.placeCar({ x: a.x, z: a.z, heading: Math.atan2(b.z - a.z, b.x - a.x) });
      }
    }
    return { hash: hashNumbers(world.snapshot()), flights, contacts, restarts, distance };
  }

  it('gives the same state hash for the same inputs, through jumps, crashes and chunk streaming', () => {
    const first = run('endless-a');
    const second = run('endless-a');
    expect(second).toEqual(first);
    // The run is only a meaningful check if it flew, hit things and went somewhere.
    expect(first.flights).toBeGreaterThan(3);
    expect(first.contacts + first.restarts).toBeGreaterThan(0);
    expect(first.distance).toBeGreaterThan(600);
    expect(run('endless-b').hash).not.toBe(first.hash);
  });
});

describe('progress while flying off an open-edged descent', () => {
  // 60 m flat at y = 40, a 240 m open-edged descent of 36 m, 200 m flat: straight along +x, so station = x.
  const shapes: ChunkShape[] = [
    { length: 60 },
    { length: 240, rise: -36, openLeft: true, openRight: true },
    { length: 200 },
  ];
  const launches: [number, number][] = [
    [0.5, 25],
    [0.3, 30],
    [0.2, 40],
    [0.15, 50],
  ];
  for (const [heading, speed] of launches) {
    it(`never runs ahead of the car's real station (heading ${heading}, ${speed} m/s)`, () => {
      const chunks = makeChunkRoad(shapes, 8, { x: 0, z: 0, heading: 0, y: 40 });
      const world = createEndlessWorld({ x: 0, z: 0, heading: 0, y: 40 }, plantedParams());
      for (const chunk of chunks) world.addChunk(chunk);
      world.placeCar({ x: 140, z: 0, heading, y: world.groundHeight(140, 0, 40) });
      world.car.vx = speed * Math.cos(heading);
      world.car.vz = speed * Math.sin(heading);
      let furthestX = world.car.x;
      let wasAirborne = false;
      for (let i = 0; i < 8 / DT; i++) {
        world.step(IDLE);
        furthestX = Math.max(furthestX, world.car.x);
        if (world.car.airborne) wasAirborne = true;
        // The centreline point nearest a car on this straight road is at its x; allow the start runoff of a metre.
        expect(world.trackDist).toBeLessThanOrEqual(furthestX + 1);
      }
      expect(wasAirborne).toBe(true);
    });
  }
});
