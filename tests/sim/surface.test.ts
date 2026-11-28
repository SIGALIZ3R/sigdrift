/**
 * Road surfaces in 2.5D: heights, slopes, bumps, which layer a crossing answers with, the floor everywhere else, and
 * how fast a query is.
 */
import { describe, expect, it, inject } from 'vitest';
import type { Level } from '../../src/types';
import { STEP_UP, TERRAIN_Y } from '../../src/types';
import { FOOTPRINT_MARGIN, addPiece, createSurfaceIndex, nearestSurface, removePiece, surfaceAt, surfaceEmpty, surfaceStats } from '../../src/sim/surface';
import type { SurfaceIndex } from '../../src/sim/surface';
import {
  CROSSING,
  RAMP,
  makeBump,
  makeChunkRoad,
  makeCrossingLevel,
  makeOpenLevel,
  makeRampLevel,
  makeShapedLevel,
  makeStraightChunk,
} from '../helpers/handLevel';

function indexOf(level: Level): SurfaceIndex {
  const index = createSurfaceIndex();
  addPiece(index, 0, level);
  return index;
}

/** Copies the fields of the reused hit object. */
function at(index: SurfaceIndex, x: number, z: number, fromY: number) {
  const hit = surfaceAt(index, x, z, fromY);
  return { ...hit };
}

describe('a ramp', () => {
  const index = indexOf(makeRampLevel());
  const climb = RAMP.climbTo - RAMP.climbFrom;

  it('is flat at the bottom and on top, and half way up half way along the climb', () => {
    expect(at(index, 20, 0, 0)).toMatchObject({ y: 0, onRoad: true, slopeX: 0, slopeZ: 0, owner: 0 });
    expect(at(index, 160, 3, 8).y).toBeCloseTo(RAMP.rise, 9);
    expect(at(index, 160, 3, 8).slopeX).toBeCloseTo(0, 9);
    const middle = at(index, RAMP.climbFrom + climb / 2, -2, 4);
    expect(middle.y).toBeCloseTo(RAMP.rise / 2, 6);
    // Smoothstep: steepest in the middle, 1.5 x rise / length.
    expect(middle.slopeX).toBeCloseTo((1.5 * RAMP.rise) / climb, 3);
    expect(middle.slopeZ).toBeCloseTo(0, 9);
    const down = at(index, RAMP.topTo + (RAMP.descendTo - RAMP.topTo) / 2, 0, 4);
    expect(down.slopeX).toBeCloseTo((-1.5 * RAMP.rise) / climb, 3);
  });

  it('is level across the road, out to the edge and the margin beyond it', () => {
    const x = RAMP.climbFrom + 30;
    const centre = at(index, x, 0, 8).y;
    for (const z of [-RAMP.halfWidth - FOOTPRINT_MARGIN + 0.01, -5, 3, RAMP.halfWidth + FOOTPRINT_MARGIN - 0.01]) {
      expect(at(index, x, z, 8)).toMatchObject({ y: centre, onRoad: true });
    }
    for (const z of [-RAMP.halfWidth - FOOTPRINT_MARGIN - 0.01, RAMP.halfWidth + FOOTPRINT_MARGIN + 0.01, 30]) {
      expect(at(index, x, z, 8)).toMatchObject({ y: TERRAIN_Y, onRoad: false, slopeX: 0, owner: -1, pathIndex: -1 });
    }
  });

  it('is linear between path points', () => {
    const level = makeRampLevel();
    const i = 50;
    const a = level.path[i];
    const b = level.path[i + 1];
    for (const t of [0.1, 0.5, 0.9]) {
      const hit = at(index, a.x + (b.x - a.x) * t, 1, 10);
      expect(hit.y).toBeCloseTo(a.y + (b.y - a.y) * t, 9);
      expect(hit.pathIndex).toBe(i);
      expect(hit.slopeX).toBeCloseTo((b.y - a.y) / (b.x - a.x), 9);
    }
  });

  it('cannot be climbed onto from far below: only up to STEP_UP above the wheels', () => {
    const x = RAMP.climbFrom + climb / 2;
    expect(at(index, x, 0, 4 - STEP_UP + 0.01).y).toBeCloseTo(4, 6);
    expect(at(index, x, 0, 4 - STEP_UP - 0.2).y).toBe(TERRAIN_Y);
    // From above it is always found (the car falls onto it).
    expect(at(index, x, 0, 100).y).toBeCloseTo(4, 6);
  });

  it('covers the run-off past its closed ends only when asked to', () => {
    expect(at(index, -3, 0, 0).y).toBe(TERRAIN_Y);
    const extended = createSurfaceIndex();
    addPiece(extended, 0, makeRampLevel(), { extendStart: 6, extendEnd: 6 });
    expect(at(extended, -3, 7, 0)).toMatchObject({ y: 0, onRoad: true, pathIndex: 0 });
    expect(at(extended, -6.5, 0, 0).y).toBe(TERRAIN_Y);
    expect(at(extended, RAMP.end + 5, -7, 0)).toMatchObject({ y: 0, onRoad: true });
  });
});

describe('a crossing', () => {
  const level = makeCrossingLevel();
  const index = indexOf(level);
  const x = CROSSING.crossX;

  it('answers with the layer the wheels are at', () => {
    const below = at(index, x + 1, 1, 0);
    const above = at(index, x, 1, CROSSING.height);
    expect(below).toMatchObject({ y: 0, onRoad: true, owner: 0 });
    expect(above.y).toBeCloseTo(CROSSING.height, 9);
    expect(above.onRoad).toBe(true);
    // Two stretches of the same piece: the lower is early in the path, the bridge late.
    expect(below.pathIndex).toBe(Math.floor((x + 1) / 2));
    expect(above.pathIndex).toBeGreaterThan(100);
    // Anywhere between the two layers it is the lower road; well under it, the floor.
    expect(at(index, x, 1, 3).y).toBe(0);
    expect(at(index, x, 1, 6).y).toBe(0);
    expect(at(index, x, 1, CROSSING.height - STEP_UP + 0.01).y).toBeCloseTo(CROSSING.height, 9);
    expect(at(index, x, 1, -2).y).toBe(TERRAIN_Y);
    // Off the lower road but under the bridge: only the bridge (from above) or the floor.
    expect(at(index, x, -20, 0).y).toBe(TERRAIN_Y);
    expect(at(index, x, -20, 9).y).toBeCloseTo(CROSSING.height, 9);
  });

  it('places by nearest height', () => {
    expect(nearestSurface(index, x, 0, 0).y).toBe(0);
    expect(nearestSurface(index, x, 0, 2).y).toBe(0);
    expect(nearestSurface(index, x, 0, 5).y).toBeCloseTo(CROSSING.height, 9);
    expect(nearestSurface(index, x, 0, 50).y).toBeCloseTo(CROSSING.height, 9);
    expect(nearestSurface(index, x, 0, -10).y).toBe(0);
    expect(nearestSurface(index, -100, -100, 0)).toMatchObject({ y: TERRAIN_Y, onRoad: false });
  });

  it('puts a bump only on the road it belongs to', () => {
    const lower = { ...level, bumps: [makeBump(x, 0, 0, CROSSING.halfWidth, 0.5, 12, 0)] };
    const lowerIndex = indexOf(lower);
    expect(at(lowerIndex, x, 0, 0).y).toBeCloseTo(0.5, 9);
    expect(at(lowerIndex, x + 3, 0, 0).y).toBeCloseTo(0.25, 9);
    expect(at(lowerIndex, x + 3, 0, 0).slopeX).toBeCloseTo((-0.5 * 0.5 * Math.PI * Math.sin(Math.PI / 2)) / 6, 6);
    expect(at(lowerIndex, x, 0, CROSSING.height).y).toBeCloseTo(CROSSING.height, 9);

    const bridge = { ...level, bumps: [makeBump(x, 0, -Math.PI / 2, CROSSING.halfWidth, 0.5, 12, CROSSING.height)] };
    const bridgeIndex = indexOf(bridge);
    expect(at(bridgeIndex, x, 0, CROSSING.height).y).toBeCloseTo(CROSSING.height + 0.5, 6);
    expect(at(bridgeIndex, x, 0, 0).y).toBe(0);
  });
});

describe('footprints', () => {
  it('fill the outside of a bend right out to the edge, and no further', () => {
    const index = createSurfaceIndex();
    const chunks = makeChunkRoad([{ length: 20 }, { length: 60, turn: 2.4 }, { length: 20 }], 8);
    chunks.forEach((chunk) => addPiece(index, chunk.index, chunk));
    const bend = chunks[1];
    let checked = 0;
    for (let i = 0; i < bend.path.length - 1; i++) {
      for (const t of [0, 0.25, 0.5, 0.75]) {
        // Along the outer (left, for a right-hand bend) edge, a little inside and a little outside it.
        const ex = bend.left[i].x + (bend.left[i + 1].x - bend.left[i].x) * t;
        const ez = bend.left[i].z + (bend.left[i + 1].z - bend.left[i].z) * t;
        const cx = bend.path[i].x + (bend.path[i + 1].x - bend.path[i].x) * t;
        const cz = bend.path[i].z + (bend.path[i + 1].z - bend.path[i].z) * t;
        const len = Math.hypot(ex - cx, ez - cz);
        const ux = (ex - cx) / len;
        const uz = (ez - cz) / len;
        expect(surfaceAt(index, ex - ux * 0.1, ez - uz * 0.1, 0).onRoad).toBe(true);
        expect(surfaceAt(index, ex + ux * (FOOTPRINT_MARGIN + 0.1), ez + uz * (FOOTPRINT_MARGIN + 0.1), 0).onRoad).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('do not bulge past the walls of a narrow road where it widens into a plaza', () => {
    const index = createSurfaceIndex();
    const chunks = makeChunkRoad([{ length: 60 }, { length: 12, endHalfWidth: 17 }, { length: 60 }], 9);
    chunks.forEach((chunk) => addPiece(index, chunk.index, chunk));
    // Two metres before the taper starts, 12 m out: inside a disc of radius 17 round the plaza's first point.
    expect(surfaceAt(index, 58, 12, 0).onRoad).toBe(false);
    expect(surfaceAt(index, 58, 9.1, 0).onRoad).toBe(true);
    expect(surfaceAt(index, 80, 16.9, 0).onRoad).toBe(true);
  });

  it('come and go with their owner', () => {
    const index = createSurfaceIndex();
    expect(surfaceEmpty(index)).toBe(true);
    addPiece(index, 0, makeStraightChunk(0, 0, 100, 8));
    addPiece(index, 1, makeStraightChunk(1, 100, 100, 8, [makeBump(150, 0, 0, 8)]));
    expect(surfaceStats(index)).toMatchObject({ segments: 100, bumps: 1, owners: 2 });
    expect(at(index, 151, 0, 0)).toMatchObject({ owner: 1, pathIndex: 25 });
    expect(at(index, 150, 0, 0).y).toBeCloseTo(0.5, 9);
    expect(at(index, 51, 0, 0)).toMatchObject({ y: 0, owner: 0, pathIndex: 25 });
    removePiece(index, 1);
    expect(at(index, 150, 0, 0).y).toBe(TERRAIN_Y);
    expect(at(index, 50, 0, 0).y).toBe(0);
    removePiece(index, 7);
    removePiece(index, 0);
    expect(surfaceEmpty(index)).toBe(true);
    expect(surfaceStats(index)).toEqual({ segments: 0, bumps: 0, cells: 0, owners: 0, big: 0 });
    // Slots are reused without bringing anything back.
    addPiece(index, 3, makeStraightChunk(3, 300, 100, 8));
    expect(at(index, 150, 0, 0).y).toBe(TERRAIN_Y);
    expect(at(index, 350, 0, 0)).toMatchObject({ y: 0, owner: 3 });
  });

  it('cover a whole huge arena with a few big segments', () => {
    const index = createSurfaceIndex();
    // The world extends the last segment to the wall 6 m beyond the goal (see runoffPast).
    addPiece(index, 0, makeOpenLevel(6000), { extendEnd: 6 });
    expect(surfaceStats(index).big).toBe(3);
    for (const [x, z] of [[0, 0], [-2999, -2999], [2999, 2999], [2999, -2999], [-2999, 2999]]) {
      expect(at(index, x, z, 0)).toMatchObject({ y: 0, onRoad: true });
    }
  });

  it('survive nonsense', () => {
    const index = indexOf(makeRampLevel());
    for (const [x, z, y] of [[NaN, 0, 0], [0, Infinity, 0], [20, 0, NaN], [1e12, 0, 0]]) {
      expect(at(index, x, z, y)).toMatchObject({ y: TERRAIN_Y, onRoad: false });
    }
  });
});

describe('speed', () => {
  it.skipIf(inject('coverage'))('answers a query on a big level in well under 2 microseconds', () => {
    // About 3 km of twisting, climbing road, 1500 path points, crossing over itself here and there.
    const shapes = [];
    for (let i = 0; i < 60; i++) shapes.push({ length: 50, turn: ((i * 7) % 5) * 0.4 - 0.8, rise: i % 4 === 1 ? 4 : i % 4 === 3 ? -4 : 0 });
    const level = makeShapedLevel('big', shapes, 9);
    const index = indexOf(level);
    const points: number[] = [];
    for (let i = 0; i < 4096; i++) {
      const p = level.path[(i * 37) % level.path.length];
      points.push(p.x + ((i % 13) - 6), p.z + ((i % 7) - 3), p.y);
    }
    let sink = 0;
    const run = (count: number): number => {
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const k = (i & 4095) * 3;
        sink += surfaceAt(index, points[k], points[k + 1], points[k + 2]).y;
      }
      return ((performance.now() - start) * 1000) / count;
    };
    run(200000);
    const micros = Math.min(run(500000), run(500000));
    console.log(`surfaceAt: ${micros.toFixed(3)} us per query on ${level.path.length} path points`);
    expect(Number.isFinite(sink)).toBe(true);
    expect(micros).toBeLessThan(2);
  });
});

describe('a climbing bend', () => {
  // A quarter circle of radius 30 m in 3 m steps, climbing at 12% the whole way, 10 m half width.
  const RADIUS = 30;
  const HALF = 10;
  const GRADE = 0.12;
  const points: { x: number; z: number; y: number; halfWidth: number; dist: number }[] = [];
  const left: { x: number; z: number }[] = [];
  const right: { x: number; z: number }[] = [];
  const steps = Math.round((Math.PI / 2) * RADIUS / 3);
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    const dist = a * RADIUS;
    // Centre of the bend at the origin; the road runs anticlockwise, so its left side is the inside.
    const x = RADIUS * Math.cos(a);
    const z = RADIUS * Math.sin(a);
    points.push({ x, z, y: dist * GRADE, halfWidth: HALF, dist });
    // Edge points on the joint lines (the bisectors), as the generators lay them out.
    const miter = 1 / Math.cos(Math.PI / 4 / steps);
    const out = k === 0 || k === steps ? 1 : miter;
    left.push({ x: (RADIUS - HALF * out) * Math.cos(a), z: (RADIUS - HALF * out) * Math.sin(a) });
    right.push({ x: (RADIUS + HALF * out) * Math.cos(a), z: (RADIUS + HALF * out) * Math.sin(a) });
  }
  const piece = { path: points, left, right, bumps: [] } as unknown as Level;
  const index = indexOf(piece);

  it('has no step anywhere across it: a car crossing a joint on the inside is not kicked up', () => {
    // Walk arcs across the whole width and look for a jump: a change in the climb between neighbouring samples far
    // bigger than the climb itself bends by.
    const STEP = 0.001;
    let worst = 0;
    for (let r = RADIUS - HALF + 0.3; r <= RADIUS + HALF - 0.3; r += 0.7) {
      let previous = NaN;
      let previousRise = NaN;
      for (let a = 0.05; a <= Math.PI / 2 - 0.05; a += STEP) {
        const hit = at(index, r * Math.cos(a), r * Math.sin(a), 100);
        expect(hit.onRoad).toBe(true);
        if (previous === previous) {
          const rise = hit.y - previous;
          if (previousRise === previousRise) worst = Math.max(worst, Math.abs(rise - previousRise));
          previousRise = rise;
        }
        previous = hit.y;
      }
    }
    // Each sample climbs about 3.6 mm. A plain projection steps by up to GRADE x half width x tan(half the joint
    // angle) at a joint on the inside (well over a centimetre here); along joint lines only the slope bends.
    expect(worst).toBeLessThan(1e-3);
  });
});
