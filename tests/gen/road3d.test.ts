import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import {
  DECK_THICKNESS,
  HeightProfile,
  PROFILE_STEP,
  RoadIndex,
  bumpClimbAt,
  bumpLaunch,
  chooseOpenEdges,
  edgeOverOtherRoad,
  flightReach,
  emitEdgeWalls,
  maxClimb,
  pieceBounds,
  placeSupports,
  profileLimits,
  raisedSegments,
  steepestRamp,
  wander,
  withinFlight,
} from '../../src/gen/road3d';
import type { GradeLimit } from '../../src/gen/road3d';
import type { PathPoint, Support, Vec2, Wall } from '../../src/types';
import { MAX_GRADE, STEP_UP, TERRAIN_Y, WALL_HEIGHT } from '../../src/types';

const flatLimit = (grade: number): GradeLimit => () => grade;

/** A straight road along +x (or along +z with `alongZ`), points every `step` m, heights from `y(dist)`. */
function straightPath(
  length: number,
  halfWidth: number,
  y: (d: number) => number,
  opts: { step?: number; x0?: number; z0?: number; alongZ?: boolean; dist0?: number } = {},
): PathPoint[] {
  const step = opts.step ?? 3;
  const path: PathPoint[] = [];
  for (let d = 0; d <= length + 1e-9; d += step) {
    const x = (opts.x0 ?? 0) + (opts.alongZ ? 0 : d);
    const z = (opts.z0 ?? 0) + (opts.alongZ ? d : 0);
    path.push({ x, z, y: y(d), halfWidth, dist: (opts.dist0 ?? 0) + d });
  }
  return path;
}

function edges(path: PathPoint[], alongZ = false): { left: Vec2[]; right: Vec2[] } {
  // Along +x right is +z; along +z right is -x.
  return {
    left: path.map((p) => (alongZ ? { x: p.x + p.halfWidth, z: p.z } : { x: p.x, z: p.z - p.halfWidth })),
    right: path.map((p) => (alongZ ? { x: p.x - p.halfWidth, z: p.z } : { x: p.x, z: p.z + p.halfWidth })),
  };
}

/** Samples a profile every metre and returns its largest |grade| and |change of grade per metre|. */
function measure(profile: HeightProfile, from: number, to: number): { grade: number; change: number } {
  let grade = 0;
  let change = 0;
  let previous = profile.gradeAt(from);
  for (let d = from; d <= to; d += 0.25) {
    const g = (profile.heightAt(d + 0.25) - profile.heightAt(d)) / 0.25;
    grade = Math.max(grade, Math.abs(g));
    const now = profile.gradeAt(d);
    change = Math.max(change, Math.abs(now - previous) / 0.25);
    previous = now;
  }
  return { grade, change };
}

describe('profile limits', () => {
  it('get steeper and sharper with elevation, within the contract', () => {
    const low = profileLimits(0);
    const high = profileLimits(1);
    expect(high.maxGrade).toBeCloseTo(MAX_GRADE, 12);
    expect(low.maxGrade).toBeLessThan(high.maxGrade);
    expect(high.bendGrade).toBe(0.06);
    expect(low.gradeChange).toBeLessThan(high.gradeChange);
    // A car cresting at 31 m/s stays down on the sharpest crest.
    expect(31 * 31 * high.gradeChange).toBeLessThan(9.81 * 1.05);
    expect(profileLimits(-1)).toEqual(low);
    expect(profileLimits(7)).toEqual(high);
  });
});

describe('steepestRamp', () => {
  it('starts and ends level and keeps every limit', () => {
    const limit: GradeLimit = (d) => (d > 40 && d < 60 ? 0.05 : 0.1);
    const ramp = steepestRamp(0, 120, limit, 0.008);
    expect(ramp).toHaveLength(121);
    expect(ramp[0]).toBe(0);
    expect(ramp[120]).toBe(0);
    for (let k = 1; k < ramp.length; k++) {
      expect(Math.abs(ramp[k] - ramp[k - 1])).toBeLessThanOrEqual(0.008 + 1e-12);
      expect(ramp[k]).toBeLessThanOrEqual(limit(k) + 1e-12);
    }
    // Neighbours of the tighter stretch take its limit too, since the grade is linear between grid points.
    expect(ramp[40]).toBeLessThanOrEqual(0.05);
    expect(Math.max(...ramp)).toBeCloseTo(0.1, 12);
  });

  it('gives the height a ramp can climb', () => {
    // 100 m at 0.1 with 12.5 m of ramp-in and ramp-out at 0.008 per metre.
    expect(maxClimb(0, 100, flatLimit(0.1), 0.008)).toBeCloseTo(0.1 * (100 - 12.5), 2);
    expect(maxClimb(0, 10, flatLimit(0.1), 0.008)).toBeCloseTo(0.2, 2);
    expect(maxClimb(5, 5, flatLimit(0.1), 0.008)).toBe(0);
  });
});

describe('HeightProfile', () => {
  it('holds and ramps smoothly to exact heights', () => {
    const profile = new HeightProfile(0, 0, flatLimit(0.12), 0.01);
    profile.holdTo(20);
    expect(profile.end).toBe(20);
    expect(profile.rampTo(120, 8)).toBe(true);
    profile.holdTo(150);
    expect(profile.rampTo(260, 2.5)).toBe(true);
    expect(profile.end).toBe(260);
    expect(profile.endHeight).toBe(2.5);
    expect(profile.heightAt(10)).toBe(0);
    expect(profile.heightAt(120)).toBe(8);
    expect(profile.heightAt(140)).toBe(8);
    expect(profile.heightAt(1000)).toBe(2.5);
    const { grade, change } = measure(profile, 0, 260);
    expect(grade).toBeLessThanOrEqual(0.12 + 1e-9);
    expect(change).toBeLessThanOrEqual(0.01 + 1e-9);
    // Monotonic on each ramp: a ramp never overshoots.
    for (let d = 20; d < 120; d += 0.5) expect(profile.heightAt(d + 0.5)).toBeGreaterThanOrEqual(profile.heightAt(d));
    for (let d = 150; d < 260; d += 0.5) expect(profile.heightAt(d + 0.5)).toBeLessThanOrEqual(profile.heightAt(d));
  });

  it('is continuous in height and grade between grid points', () => {
    const profile = new HeightProfile(0, 3, flatLimit(0.1), 0.008);
    profile.rampTo(80, 9);
    for (let d = 0; d < 80; d += 0.37) {
      const ahead = profile.heightAt(d + 1e-6);
      expect(Math.abs(ahead - profile.heightAt(d))).toBeLessThan(1e-6);
      const slope = (profile.heightAt(d + 1e-4) - profile.heightAt(d - 1e-4)) / 2e-4;
      if (d > 0.01) expect(slope).toBeCloseTo(profile.gradeAt(d), 4);
    }
  });

  it('refuses a ramp that is too steep and changes nothing', () => {
    const profile = new HeightProfile(10, 5, flatLimit(0.06), 0.006);
    const most = profile.climbTo(60);
    expect(profile.rampTo(60, 5 + most + 0.01)).toBe(false);
    expect(profile.end).toBe(10);
    expect(profile.rampTo(60, 5 - most)).toBe(true);
    expect(profile.endHeight).toBeCloseTo(5 - most, 12);
  });

  it('forgets the past without moving what is left', () => {
    const profile = new HeightProfile(0, 0, flatLimit(0.12), 0.01);
    profile.rampTo(100, 6);
    profile.rampTo(200, 1);
    const before = [120, 150, 199.5].map((d) => profile.heightAt(d));
    profile.dropBefore(110.7);
    expect(profile.origin).toBe(110);
    expect([120, 150, 199.5].map((d) => profile.heightAt(d))).toEqual(before);
    expect(profile.end).toBe(200);
  });

  it('uses a 1 m grid', () => {
    expect(PROFILE_STEP).toBe(1);
  });
});

describe('wander', () => {
  const style = { maxHeight: 20, ramp: [40, 140] as [number, number], hold: [0, 40] as [number, number], drama: 0.7 };

  it('arrives level at the asked height, stays in range and keeps the limits', () => {
    for (let i = 0; i < 40; i++) {
      const rng = new Rng(`wander-${i}`);
      const limits = profileLimits(1);
      const limit: GradeLimit = (d) => (Math.floor(d / 100) % 2 === 1 ? limits.bendGrade : limits.maxGrade);
      const profile = new HeightProfile(0, 4, limit, limits.gradeChange);
      const target = rng.range(0, 20);
      expect(wander(profile, rng, 900, target, style)).toBe(true);
      expect(profile.end).toBe(900);
      expect(profile.endHeight).toBe(target);
      let low = Infinity;
      let high = -Infinity;
      for (let d = 0; d <= 900; d += 0.5) {
        low = Math.min(low, profile.heightAt(d));
        high = Math.max(high, profile.heightAt(d));
        const lim = Math.min(limit(Math.floor(d)), limit(Math.ceil(d)));
        expect(Math.abs(profile.gradeAt(d))).toBeLessThanOrEqual(lim + 1e-9);
      }
      expect(low).toBeGreaterThanOrEqual(-1e-9);
      expect(high).toBeLessThanOrEqual(20 + 1e-9);
      expect(measure(profile, 0, 900).change).toBeLessThanOrEqual(limits.gradeChange + 1e-9);
    }
  });

  it('keeps the road level apart from one clean ramp: no rolling hills', () => {
    const limits = profileLimits(1);
    // One ramp per change of height: up (or down) once, never back, with level road either side.
    for (let i = 0; i < 30; i++) {
      const rng = new Rng(`ramp-${i}`);
      const start = rng.range(0, 6);
      const target = rng.range(0, 20);
      const profile = new HeightProfile(0, start, flatLimit(limits.maxGrade), limits.gradeChange);
      expect(wander(profile, rng, 1200, target, style)).toBe(true);
      expect(profile.endHeight).toBe(target);
      let rising = 0;
      let falling = 0;
      let level = 0;
      for (let d = 0; d <= 1200; d += 1) {
        const g = profile.gradeAt(d);
        if (g > 1e-9) rising++;
        else if (g < -1e-9) falling++;
        else level++;
      }
      // Only ever one way.
      expect(Math.min(rising, falling), `ramp-${i}`).toBe(0);
      // And short: the shortest ramp that makes the change, so most of the stretch is level.
      expect(level, `ramp-${i}`).toBeGreaterThan(1200 * 0.6);
      // Heights stay between the two ends.
      for (let d = 0; d <= 1200; d += 10) {
        const h = profile.heightAt(d);
        expect(h).toBeGreaterThanOrEqual(Math.min(start, target) - 1e-9);
        expect(h).toBeLessThanOrEqual(Math.max(start, target) + 1e-9);
      }
    }
  });

  it('holds the road level all the way when the height does not change', () => {
    const limits = profileLimits(1);
    const profile = new HeightProfile(0, 7, flatLimit(limits.maxGrade), limits.gradeChange);
    expect(wander(profile, new Rng('flat'), 800, 7, style)).toBe(true);
    for (let d = 0; d <= 800; d += 5) expect(profile.heightAt(d)).toBe(7);
  });

  it('is deterministic and refuses the impossible', () => {
    const run = (): number[] => {
      const profile = new HeightProfile(0, 0, flatLimit(0.1), 0.008);
      wander(profile, new Rng('same'), 500, 3, style);
      return Array.from({ length: 50 }, (_, k) => profile.heightAt(k * 10));
    };
    expect(run()).toEqual(run());
    const profile = new HeightProfile(0, 0, flatLimit(0.05), 0.008);
    expect(wander(profile, new Rng('x'), 100, 50, style)).toBe(false);
    expect(profile.end).toBe(0);
  });
});

describe('RoadIndex', () => {
  const low = straightPath(120, 8, () => 0);
  const high = straightPath(120, 8, () => 9, { x0: 60, z0: -60, alongZ: true, dist0: 500 });

  it('finds the roads whose footprint holds a point, with height and distance', () => {
    const index = new RoadIndex();
    expect(index.add(low)).toBe(0);
    expect(index.add(high)).toBe(1);
    const hits = index.query(60, 0, 0, []);
    expect(new Set(hits.map((h) => h.road))).toEqual(new Set([0, 1]));
    // Neighbouring segments report the spot too; the nearest is the one straight across.
    const onHigh = hits.filter((h) => h.road === 1).sort((a, b) => a.offset - b.offset)[0];
    expect(onHigh?.y).toBe(9);
    expect(onHigh?.dist).toBeCloseTo(560, 9);
    const roads = (x: number, z: number, margin: number): number[] => [
      ...new Set(index.query(x, z, margin, []).map((h) => h.road)),
    ];
    expect(roads(31, 7.9, 0)).toEqual([0]);
    expect(roads(31, 8.5, 0)).toEqual([]);
    expect(roads(31, 8.5, 1)).toEqual([0]);
  });

  it('answers which surface a car stands on', () => {
    const index = new RoadIndex();
    index.add(low);
    index.add(high);
    expect(index.surfaceAt(60, 0, 0)).toBe(0);
    expect(index.surfaceAt(60, 0, 9 - STEP_UP)).toBe(9);
    expect(index.surfaceAt(60, 0, 20)).toBe(9);
    expect(index.surfaceAt(60, 30, 5)).toBe(TERRAIN_Y);
    index.remove(1);
    expect(index.surfaceAt(60, 0, 20)).toBe(0);
  });
});

describe('open edges', () => {
  const path = straightPath(600, 9, (d) => (d < 60 ? 0 : 6));

  it('marks raised segments', () => {
    const raised = raisedSegments(path);
    expect(raised[0]).toBe(false);
    expect(raised[25]).toBe(true);
    expect(raised[path.length - 1]).toBe(false);
  });

  it('opens stretches of 30..120 m inside what is allowed, apart from each other', () => {
    const raised = raisedSegments(path);
    const allowLeft = raised.map((r, i) => r && (i < 100 || i > 130));
    const allowRight = [...raised];
    const bend = path.map((_, i) => i >= 150 && i < 170);
    for (const share of [0.1, 0.4, 0.9]) {
      const plan = chooseOpenEdges(new Rng(`open-${share}`), { path, raised, allowLeft, allowRight, bend, share });
      expect(plan.raisedLength).toBeCloseTo(2 * (600 - 60), 6);
      let open = 0;
      for (const [side, allow] of [
        [plan.leftOpen, allowLeft],
        [plan.rightOpen, allowRight],
      ]) {
        let start = -1;
        let lastEnd = -Infinity;
        for (let i = 0; i < path.length; i++) {
          if (side[i]) {
            expect(allow[i]).toBe(true);
            open += 3;
            if (start < 0) {
              start = i;
              expect(path[i].dist - lastEnd).toBeGreaterThanOrEqual(20);
            }
          } else if (start >= 0) {
            const run = path[i].dist - path[start].dist;
            expect(run).toBeGreaterThanOrEqual(30);
            expect(run).toBeLessThanOrEqual(123);
            lastEnd = path[i].dist;
            start = -1;
          }
        }
      }
      for (let i = 0; i < path.length; i++) if (bend[i]) expect(plan.leftOpen[i] && plan.rightOpen[i]).toBe(false);
      expect(open).toBeCloseTo(plan.openLength, 6);
      expect(plan.openLength).toBeGreaterThanOrEqual(Math.min(0.75 * share, 0.6) * plan.raisedLength);
    }
  });

  it('emits walls only where an edge is closed, at the road height', () => {
    const { left, right } = edges(path);
    const leftOpen = path.map((_, i) => i >= 40 && i < 60);
    const rightOpen = path.map(() => false);
    const walls: Wall[] = [];
    emitEdgeWalls(path, left, right, leftOpen, rightOpen, walls);
    expect(walls).toHaveLength(2 * (path.length - 1) - 20);
    for (const w of walls) {
      expect(w.ya).toBe(w.ax < 60 ? 0 : 6);
      expect(Math.abs(w.az)).toBe(9);
    }
  });

  it('keeps the barrier where another road lies beyond the edge', () => {
    const index = new RoadIndex();
    const main = straightPath(200, 8, () => 10);
    const other = straightPath(120, 8, () => 0, { x0: 100, z0: 14, alongZ: true, dist0: 900 });
    index.add(main);
    index.add(other);
    const { left, right } = edges(main);
    // The other road runs from z = 14 to 134 at x = 100 (right of the main road, which is +z).
    const at = main.findIndex((p) => p.x === 99);
    expect(edgeOverOtherRoad(index, 0, main, right, at, 40)).toBe(true);
    expect(edgeOverOtherRoad(index, 0, main, left, at, 40)).toBe(false);
    expect(edgeOverOtherRoad(index, 0, main, right, 5, 40)).toBe(false);
  });

  it('keeps the barrier where a car flying off the edge could land on a lower road well beyond 16 m', () => {
    // A deck at y = 12 and a parallel road at y = 0 in the next cell, 30 m from the deck's right edge.
    const main = straightPath(300, 8, () => 12);
    const { left, right } = edges(main);
    const at = main.findIndex((p) => p.x === 150);
    for (const [gap, lands] of [
      [30, true],
      [55, true],
      [90, false],
    ] as const) {
      const index = new RoadIndex();
      index.add(main);
      index.add(straightPath(300, 8, () => 0, { z0: 8 + gap + 8, dist0: 2000 }));
      expect(edgeOverOtherRoad(index, 0, main, right, at, 40), `gap ${gap}`).toBe(lands);
      expect(edgeOverOtherRoad(index, 0, main, left, at, 40)).toBe(false);
    }
    // A road higher than the brink beyond 16 m cannot be landed on.
    const index = new RoadIndex();
    index.add(main);
    index.add(straightPath(300, 8, () => 20, { z0: 8 + 30 + 8, dist0: 2000 }));
    expect(edgeOverOtherRoad(index, 0, main, right, at, 40)).toBe(false);
  });

  it('also looks ahead along the road, where a car leaving at a shallow angle comes down', () => {
    // A lower road crossing the main road's line 50 m ahead and 25 m out to its right: nothing square to the edge.
    const main = straightPath(300, 8, () => 12);
    const { right } = edges(main);
    const at = main.findIndex((p) => p.x === 150);
    const index = new RoadIndex();
    index.add(main);
    index.add(straightPath(60, 6, () => 0, { x0: 200, z0: 30, alongZ: true, dist0: 2000 }));
    expect(edgeOverOtherRoad(index, 0, main, right, at, 40)).toBe(true);
  });

  it('reaches further where the road climbs or a bump launches the car', () => {
    expect(flightReach(10, 0, 0)).toBeCloseTo(42 * Math.sqrt((2 * 11) / 9.81), 9);
    expect(flightReach(10, 5, 0)).toBeGreaterThan(flightReach(10, 0, 0) + 20);
    expect(flightReach(10, 0, 12)).toBe(0);
    expect(withinFlight(10, 0, 60)).toBe(true);
    expect(withinFlight(10, 0, 70)).toBe(false);
    // A launch from a crest counts from the bump to well past it, not before it.
    const bumps = [{ dist: 100, height: 0.8, halfLength: 5 }];
    expect(bumpLaunch(0.8, 5).vy).toBeGreaterThan(8);
    expect(bumpLaunch(0.2, 7, 10).vy).toBe(0);
    expect(bumpClimbAt(bumps, 80)).toBe(0);
    expect(bumpClimbAt(bumps, 130)).toBeCloseTo(bumpLaunch(0.8, 5).vy, 9);
    const main = straightPath(300, 8, () => 8);
    const { right } = edges(main);
    const at = main.findIndex((p) => p.x === 150);
    const index = new RoadIndex();
    index.add(main);
    index.add(straightPath(300, 8, () => 0, { z0: 8 + 80 + 8, dist0: 2000 }));
    expect(edgeOverOtherRoad(index, 0, main, right, at, 40)).toBe(false);
    expect(edgeOverOtherRoad(index, 0, main, right, at, 40, [], [{ dist: 140, height: 0.8, halfLength: 5 }])).toBe(true);
  });
});

describe('supports', () => {
  it('stand under raised road only, clear of other roads', () => {
    const main = straightPath(300, 8, (d) => (d < 100 ? 0 : 12));
    const below = straightPath(100, 8, () => 0, { x0: 200, z0: -50, alongZ: true, dist0: 2000 });
    const index = new RoadIndex();
    index.add(main);
    index.add(below);
    const out: Support[] = [];
    placeSupports(new Rng('cols'), main, index, 0, { spacing: [18, 24] }, out);
    expect(out.length).toBeGreaterThanOrEqual(7);
    for (const s of out) {
      expect(s.x).toBeGreaterThanOrEqual(100);
      expect(s.top).toBeCloseTo(12 - DECK_THICKNESS, 2);
      // Never on the crossing road (x 192..208) nor within a metre of it.
      expect(Math.abs(s.x - 200)).toBeGreaterThan(8 + s.radius + 1 - 1e-9);
    }
    for (let k = 1; k < out.length; k++) {
      const gap = out[k].x - out[k - 1].x;
      if (out[k - 1].x < 190 || out[k].x > 210) continue;
      expect(gap).toBeGreaterThanOrEqual(18 - 1e-9);
    }
  });
});

describe('pieceBounds', () => {
  it('holds everything, from the city floor up to the tallest thing', () => {
    const path = straightPath(30, 8, () => 5);
    const { left, right } = edges(path);
    const walls: Wall[] = [{ ax: 0, az: -8, bx: 30, bz: -8, ya: 5, yb: 5 }];
    const bounds = pieceBounds({
      path,
      left,
      right,
      walls,
      props: [{ kind: 'pillar', x: 10, z: 0, y: 5, radius: 1, height: 7, hue: 0 }],
      bumps: [],
      supports: [{ x: 15, z: 0, top: 4.4, radius: 1 }],
      decor: [{ x: 50, z: 0, w: 10, d: 10, h: 30, hue: 0 }],
    });
    expect(bounds).toEqual({ minX: 0, minZ: -8, maxX: 55, maxZ: 8, minY: TERRAIN_Y, maxY: TERRAIN_Y + 30 });
    const bare = pieceBounds({ path, left, right, walls, props: [], bumps: [], supports: [], decor: [] });
    expect(bare.minY).toBe(5);
    // Rounded outwards to the lattice.
    expect(bare.maxY).toBeGreaterThanOrEqual(5 + WALL_HEIGHT);
    expect(bare.maxY).toBeLessThan(5 + WALL_HEIGHT + 0.001);
  });
});
