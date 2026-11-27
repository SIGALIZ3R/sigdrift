/**
 * Where cars come down. Simulated flights off what the generators build:
 * - a car driving off an open drop-off edge never comes down on another stretch of road (it falls to the city
 *   floor, which counts as a fall), and
 * - a car flying off an endless bump is never carried over the barrier of the bend that follows.
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty, PathPoint, RoadPiece, SimBase, TrackChunk } from '../../src/types';
import { DT, TERRAIN_Y } from '../../src/types';
import { atan2, cos, sin } from '../../src/core/fixedMath';
import { createEndlessGenerator } from '../../src/gen/endless';
import { LEVELS, generateLevelFor } from '../../src/gen/levels';
import { createEndlessWorld } from '../../src/sim/endlessWorld';
import { createWorld } from '../../src/sim/world';

const IDLE = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
/** A landing further along (or back) the road than this from the take-off is on another stretch of road. */
const OTHER_STRETCH = 100;

/** Centreline distance of the road point nearest (x, z) at about height y, or NaN. */
function distAt(pieces: readonly RoadPiece[], x: number, z: number, y: number): number {
  let best = Infinity;
  let dist = NaN;
  for (const piece of pieces) {
    for (const p of piece.path as PathPoint[]) {
      if (Math.abs(p.y - y) > 2.5) continue;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) {
        best = d;
        dist = p.dist;
      }
    }
  }
  return dist;
}

/** Drives off every `stride`-th open edge segment at 30 and 45 degrees, 32 and 40 m/s; returns the far landings. */
function landingsOff(piece: RoadPiece, pieces: readonly RoadPiece[], make: () => SimBase, stride: number): { far: string[]; runs: number } {
  const far: string[] = [];
  let runs = 0;
  const path = piece.path;
  for (const side of [-1, 1]) {
    const open = side < 0 ? piece.leftOpen : piece.rightOpen;
    const edge = side < 0 ? piece.left : piece.right;
    for (let i = 0; i + 1 < path.length; i += stride) {
      if (!open[i]) continue;
      const a = path[i];
      const b = path[i + 1];
      const heading = atan2(b.z - a.z, b.x - a.x);
      const mx = (edge[i].x + edge[i + 1].x) / 2;
      const mz = (edge[i].z + edge[i + 1].z) / 2;
      const ol = Math.hypot(mx - (a.x + b.x) / 2, mz - (a.z + b.z) / 2);
      const ox = (mx - (a.x + b.x) / 2) / ol;
      const oz = (mz - (a.z + b.z) / 2) / ol;
      for (const turn of [Math.PI / 6, Math.PI / 4]) {
        const out = cos(heading + turn) * ox + sin(heading + turn) * oz > 0 ? heading + turn : heading - turn;
        for (const speed of [32, 40]) {
          const world = make();
          world.placeCar({ x: mx - ox * 1.5, z: mz - oz * 1.5, heading: out, y: (a.y + b.y) / 2 });
          world.car.vx = speed * cos(out);
          world.car.vz = speed * sin(out);
          runs++;
          let takeoff = NaN;
          for (let t = 0; t < 5 / DT; t++) {
            world.step(IDLE);
            const car = world.car;
            if (car.airborne && Number.isNaN(takeoff)) takeoff = distAt(pieces, car.x, car.z, car.y);
            if (!car.airborne && !Number.isNaN(takeoff)) {
              if (car.y > TERRAIN_Y + 0.5) {
                const landed = distAt(pieces, car.x, car.z, car.y);
                if (Math.abs(landed - takeoff) > OTHER_STRETCH) far.push(`${takeoff.toFixed(0)} -> ${landed.toFixed(0)}`);
              }
              break;
            }
          }
        }
      }
    }
  }
  return { far, runs };
}

function endlessRun(seed: string, difficulty: Difficulty, count: number): { chunks: TrackChunk[]; start: ReturnType<typeof createEndlessGenerator>['start'] } {
  const generator = createEndlessGenerator(seed, difficulty);
  const chunks: TrackChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push(generator.next());
  return { chunks, start: generator.start };
}

describe('driving off an open edge', () => {
  it('drops the car to the city floor, never onto another stretch of a fixed level', () => {
    let runs = 0;
    for (const def of LEVELS) {
      const level = generateLevelFor(def);
      const result = landingsOff(level, [level], () => createWorld(level), 4);
      expect(result.far, def.id).toEqual([]);
      runs += result.runs;
    }
    expect(runs).toBeGreaterThan(200);
  }, 120_000);

  it('drops the car to the city floor, never onto another live chunk of the endless road', () => {
    let runs = 0;
    for (const difficulty of ['medium', 'hard'] as const) {
      for (const seed of ['flight-0', 'flight-1']) {
        const { chunks, start } = endlessRun(seed, difficulty, 26);
        for (let k = 2; k < 23; k++) {
          // What the mode keeps alive: two chunks behind the car and three ahead.
          const live = chunks.slice(k - 2, k + 4);
          const result = landingsOff(chunks[k], live, () => {
            const world = createEndlessWorld(start);
            for (const c of live) world.addChunk(c);
            return world;
          }, 6);
          expect(result.far, `${seed} ${difficulty} chunk ${k}`).toEqual([]);
          runs += result.runs;
        }
      }
    }
    expect(runs).toBeGreaterThan(200);
  }, 180_000);
});

describe('flying off an endless bump', () => {
  it('never carries a car over the barrier of the next bend', () => {
    let bumps = 0;
    for (const difficulty of ['easy', 'hard'] as const) {
      for (const seed of ['flight-0', 'flight-1']) {
        const { chunks, start } = endlessRun(seed, difficulty, 46);
        for (let k = 1; k < 43; k++) {
          for (const bump of chunks[k].bumps) {
            bumps++;
            for (const speed of [28, 36]) {
              const world = createEndlessWorld(start);
              for (let j = Math.max(0, k - 2); j <= k + 3; j++) world.addChunk(chunks[j]);
              world.placeCar({ x: bump.x - bump.dirX * 25, z: bump.z - bump.dirZ * 25, heading: atan2(bump.dirZ, bump.dirX), y: bump.y });
              world.car.vx = speed * bump.dirX;
              world.car.vz = speed * bump.dirZ;
              let airFor = 0;
              for (let t = 0; t < 4 / DT && !world.offTrack; t++) {
                const before = world.groundHeight(world.car.x, world.car.z, world.car.y) > TERRAIN_Y;
                world.step(IDLE);
                airFor = world.car.airborne ? airFor + DT : 0;
                const after = world.groundHeight(world.car.x, world.car.z, world.car.y) > TERRAIN_Y;
                // Leaving the road's footprint well into a flight: carried over a barrier (driving off an open edge
                // at a bend, hands off, is not what this is about).
                if (before && !after && airFor >= 0.2) {
                  expect.fail(`${seed} ${difficulty} chunk ${k}: flew over the edge at ${speed} m/s, ${airFor.toFixed(2)} s into a jump`);
                }
              }
            }
          }
        }
      }
    }
    expect(bumps).toBeGreaterThan(60);
  }, 180_000);
});
