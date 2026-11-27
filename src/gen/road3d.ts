/**
 * Shared helpers for 2.5D layered roads, used by the fixed-level generator (trackGen.ts) and meant for the endless
 * generator too. Everything here is pure and deterministic (see the DETERMINISM rules in src/types.ts).
 *
 * HEIGHT PROFILES
 * A road's height is a function y(dist) of the distance along its centreline. It is built on a 1 m grid
 * (PROFILE_STEP) as a GRADE function g(dist) that is piecewise linear between grid points, so the height is piecewise
 * quadratic and its slope is continuous: there are no kinks, only crests and dips whose sharpness is limited by
 * `gradeChange` (change of grade per metre). A profile is a chain of two kinds of pieces:
 *   - holds: level road (grade 0);
 *   - ramps: a climb or drop that starts AND ends level. A ramp is the steepest smooth climb that fits the grade limit
 *     at every metre (`steepestRamp`), scaled down to the height change asked for. Scaling keeps every limit.
 * Because every piece starts and ends level, pieces join smoothly in any order, and a ramp never overshoots: the
 * height moves monotonically from one level to the next, so it always stays between them.
 *
 * Typical use (one road, start to finish):
 *   const profile = new HeightProfile(0, 0, limit, limits.gradeChange);
 *   profile.holdTo(24);                                  // level start
 *   wander(profile, rng, 300, 12, style);                // random hills, arriving level at 12 m at dist 300
 *   profile.holdTo(364);                                 // e.g. an overpass held level
 *   const y = profile.heightAt(dist);
 * An endless generator keeps one profile running ahead of the chunks it emits and calls `dropBefore` to forget the
 * part behind the car.
 */

import { PI } from '../core/fixedMath';
import type { Rng } from '../core/rng';
import type { Bump, PathPoint, RoadPiece, Support, Vec2, Wall } from '../types';
import { CROSSING_CLEARANCE, MAX_GRADE, STEP_UP, TERRAIN_Y, WALL_HEIGHT } from '../types';

/** Grid spacing of height profiles, m. Profile distances are rounded to it. */
export const PROFILE_STEP = 1;
/** Road at or above this height counts as raised: it may have open edges and stands on supports. */
export const RAISED_HEIGHT = 3;
/** Steepest grade in a bend and near the start and the goal. */
export const BEND_GRADE = 0.06;
/** Height difference planned between a road and one passing over it: the contract minimum plus a margin. */
export const PLAN_CLEARANCE = CROSSING_CLEARANCE + 0.5;
/** Thickness of a raised road deck: a support's top is this far below the road surface. */
export const DECK_THICKNESS = 0.6;
/** Height a level may climb to at elevation 1, m. */
export const MAX_RISE = 24;

/** Snaps to a 1/1024 m lattice so output serialises and hashes identically everywhere. Adding 0 clears -0. */
export function snap(v: number): number {
  return Math.round(v * 1024) / 1024 + 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Height profiles
// ---------------------------------------------------------------------------------------------------------------

export interface ProfileLimits {
  /** Steepest grade on straight road. */
  maxGrade: number;
  /** Steepest grade in a bend. */
  bendGrade: number;
  /**
   * Largest change of grade per metre. A car crests a hump of curvature c without leaving the ground below
   * sqrt(9.81 / c) m/s: 0.006 keeps it down up to 40 m/s, 0.0105 lifts it briefly above 31 m/s.
   */
  gradeChange: number;
}

/** The limits for an elevation setting from 0 (gentle) to 1 (big climbs and drops). */
export function profileLimits(elevation: number): ProfileLimits {
  const e = elevation < 0 ? 0 : elevation > 1 ? 1 : elevation;
  const maxGrade = Math.min(MAX_GRADE, 0.04 + 0.08 * e);
  return { maxGrade, bendGrade: Math.min(BEND_GRADE, maxGrade), gradeChange: 0.006 + 0.0045 * e };
}

/** Largest |grade| allowed at a distance along the road. Called at grid points only. */
export type GradeLimit = (dist: number) => number;

function gridLimit(limit: GradeLimit, d: number): number {
  // The grade is linear between grid points, so a grid point next to a tighter limit takes that limit too.
  return Math.max(0, Math.min(limit(d - PROFILE_STEP), limit(d), limit(d + PROFILE_STEP)));
}

/**
 * Grade at each grid point of the steepest smooth climb from `from` to `to` that starts and ends level: as steep as
 * the limit allows, and changing grade by at most `gradeChange` per metre. Entry k is the grade at from + k m.
 * Both distances are rounded to the grid.
 */
export function steepestRamp(from: number, to: number, limit: GradeLimit, gradeChange: number): number[] {
  const a = Math.round(from);
  const n = Math.max(0, Math.round(to) - a);
  const ramp: number[] = new Array<number>(n + 1).fill(0);
  const step = gradeChange * PROFILE_STEP;
  for (let k = 1; k < n; k++) ramp[k] = Math.min(gridLimit(limit, a + k), ramp[k - 1] + step);
  for (let k = n - 1; k > 0; k--) ramp[k] = Math.min(ramp[k], ramp[k + 1] + step);
  return ramp;
}

function areaOf(grades: readonly number[]): number {
  let sum = 0;
  for (let k = 1; k < grades.length; k++) sum += (grades[k - 1] + grades[k]) * 0.5 * PROFILE_STEP;
  return sum;
}

/** Largest height change possible between two distances for a road that is level at both. */
export function maxClimb(from: number, to: number, limit: GradeLimit, gradeChange: number): number {
  return areaOf(steepestRamp(from, to, limit, gradeChange));
}

/** A road height profile on the 1 m grid. See the file comment. */
export class HeightProfile {
  /** Distance of the first stored grid point. */
  private originDist: number;
  private readonly grades: number[] = [0];
  private readonly heights: number[];
  readonly limit: GradeLimit;
  readonly gradeChange: number;

  /** A profile that is level at `height` at distance `origin` (rounded to the grid). */
  constructor(origin: number, height: number, limit: GradeLimit, gradeChange: number) {
    this.originDist = Math.round(origin);
    this.heights = [height];
    this.limit = limit;
    this.gradeChange = gradeChange;
  }

  get origin(): number {
    return this.originDist;
  }

  /** Distance where the profile currently ends. It is always level there. */
  get end(): number {
    return this.originDist + (this.grades.length - 1) * PROFILE_STEP;
  }

  get endHeight(): number {
    return this.heights[this.heights.length - 1];
  }

  /** Largest height change a ramp from the current end to `to` could make. */
  climbTo(to: number): number {
    return maxClimb(this.end, to, this.limit, this.gradeChange);
  }

  /** Level road up to `to`. Does nothing when `to` is not beyond the end. */
  holdTo(to: number): void {
    const n = Math.round(to) - this.end;
    const h = this.endHeight;
    for (let k = 0; k < n; k++) {
      this.grades.push(0);
      this.heights.push(h);
    }
  }

  /**
   * A smooth climb or drop from the current end to `to`, arriving level at `height`. Returns false and changes
   * nothing when the change is too big for the distance (see climbTo).
   */
  rampTo(to: number, height: number): boolean {
    const from = this.end;
    const ramp = steepestRamp(from, to, this.limit, this.gradeChange);
    if (ramp.length < 2) return height === this.endHeight;
    const rise = height - this.endHeight;
    const most = areaOf(ramp);
    if (Math.abs(rise) > most * (1 + 1e-12) + 1e-12) return false;
    const scale = most > 0 ? rise / most : 0;
    let h = this.endHeight;
    for (let k = 1; k < ramp.length; k++) {
      const g = ramp[k] * scale;
      h += (ramp[k - 1] * scale + g) * 0.5 * PROFILE_STEP;
      this.grades.push(g);
      this.heights.push(h);
    }
    // Lands exactly on the requested height, whatever the rounding on the way.
    this.heights[this.heights.length - 1] = height;
    return true;
  }

  /** Height at a distance (clamped to the stored range). Exact for the piecewise-linear grade. */
  heightAt(dist: number): number {
    const last = this.grades.length - 1;
    const u = (dist - this.originDist) / PROFILE_STEP;
    if (!(u > 0)) return this.heights[0];
    if (u >= last) return this.heights[last];
    const k = Math.floor(u);
    const t = u - k;
    const g0 = this.grades[k];
    const g1 = this.grades[k + 1];
    return this.heights[k] + PROFILE_STEP * (g0 * t + (g1 - g0) * t * t * 0.5);
  }

  /** Grade (rise over run) at a distance (clamped to the stored range). */
  gradeAt(dist: number): number {
    const last = this.grades.length - 1;
    const u = (dist - this.originDist) / PROFILE_STEP;
    if (!(u > 0)) return this.grades[0];
    if (u >= last) return this.grades[last];
    const k = Math.floor(u);
    const t = u - k;
    return this.grades[k] + (this.grades[k + 1] - this.grades[k]) * t;
  }

  /** Forgets everything before `dist` (rounded down to the grid), for a profile that runs on forever. */
  dropBefore(dist: number): void {
    const drop = Math.min(this.grades.length - 1, Math.max(0, Math.floor((dist - this.originDist) / PROFILE_STEP)));
    if (drop === 0) return;
    this.grades.splice(0, drop);
    this.heights.splice(0, drop);
    this.originDist += drop * PROFILE_STEP;
  }
}

export interface WanderStyle {
  /** Highest the road may go, m (the lowest is 0). */
  maxHeight: number;
  /** Length range of one climb or drop, m. */
  ramp: [number, number];
  /** Length range of the level stretch after it, m. */
  hold: [number, number];
  /** 0..1 how strongly each climb or drop heads for the far end of what is possible (bigger hills). */
  drama: number;
}

/** Share of the steepest climb a planned ramp may use: room for rounding and for the next ramp. */
const PLAN_SAFETY = 0.97;

/**
 * Fills the profile from its end up to `to` with random climbs, drops and level stretches between 0 and
 * style.maxHeight, arriving level at `endHeight` exactly at `to`. Returns false, appending nothing, when even one
 * straight ramp cannot make that height change (check with `profile.climbTo(to)` first).
 */
export function wander(profile: HeightProfile, rng: Rng, to: number, endHeight: number, style: WanderStyle): boolean {
  const goal = Math.round(to);
  if (Math.abs(endHeight - profile.endHeight) > profile.climbTo(goal) * (1 + 1e-12) + 1e-12) return false;
  const minRamp = style.ramp[0];
  for (;;) {
    const s = profile.end;
    const h = profile.endHeight;
    const remaining = goal - s;
    if (remaining < 2 * minRamp + style.hold[0]) break;
    const r = Math.round(rng.range(minRamp, Math.min(style.ramp[1], remaining - minRamp)));
    const hold = Math.max(0, Math.min(Math.round(rng.range(style.hold[0], style.hold[1])), remaining - r - minRamp));
    const far = rng.chance(style.drama);
    const u = rng.next();
    const reach = maxClimb(s, s + r, profile.limit, profile.gradeChange) * PLAN_SAFETY;
    const rest = maxClimb(s + r + hold, goal, profile.limit, profile.gradeChange) * PLAN_SAFETY;
    const lo = Math.max(0, h - reach, endHeight - rest);
    const hi = Math.min(Math.max(style.maxHeight, endHeight), h + reach, endHeight + rest);
    if (lo > hi) break;
    // Measured from where the road is, pulled into the reachable range.
    const from = h < lo ? lo : h > hi ? hi : h;
    let target: number;
    if (!far) target = lo + (hi - lo) * u;
    else if (hi - from >= from - lo) target = from + (hi - from) * (0.5 + 0.5 * u);
    else target = lo + (from - lo) * 0.5 * u;
    if (!profile.rampTo(s + r, target)) break;
    profile.holdTo(s + r + hold);
  }
  if (profile.end >= goal) return profile.endHeight === endHeight;
  return profile.rampTo(goal, endHeight);
}

// ---------------------------------------------------------------------------------------------------------------
// Road index: "which road is here?"
// ---------------------------------------------------------------------------------------------------------------

/** A road centreline segment whose footprint contains a queried point. */
export interface RoadHit {
  /** Which added path (the id `RoadIndex.add` returned). */
  road: number;
  /** Segment from path[index] to path[index + 1]. */
  index: number;
  /** 0..1 position of the projection along the segment. */
  t: number;
  /** Centreline distance (`PathPoint.dist`) at the projection. */
  dist: number;
  /** Distance in plan from the point to the centreline segment. */
  offset: number;
  /** Half width at the projection. */
  halfWidth: number;
  /** Road surface height at the projection (without bumps). */
  y: number;
}

const INDEX_KEY_OFFSET = 1 << 15;
const INDEX_KEY_SPAN = 1 << 16;

/**
 * Spatial index over the centreline segments of one or more paths. A point is "on" a segment when it is within the
 * interpolated half width (plus a margin) of it. Path `dist` values tell different parts of one road apart: two hits
 * whose dist differs by more than a few tens of metres are different stretches of road (a crossing, a hairpin).
 */
export class RoadIndex {
  private readonly paths: (readonly PathPoint[] | null)[] = [];
  private readonly segRoad: number[] = [];
  private readonly segIndex: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly bucketSize: number;
  private readonly maxMargin: number;
  private readonly near: number[] = [];

  /** `maxMargin`: the largest margin any query will pass (segments are bucketed with that much reach). */
  constructor(maxMargin = 24, bucketSize = 16) {
    this.maxMargin = maxMargin;
    this.bucketSize = bucketSize;
  }

  /** Adds a path; returns its road id. */
  add(path: readonly PathPoint[]): number {
    const road = this.paths.length;
    this.paths.push(path);
    const size = this.bucketSize;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const reach = Math.max(a.halfWidth, b.halfWidth) + this.maxMargin;
      const id = this.segRoad.length;
      this.segRoad.push(road);
      this.segIndex.push(i);
      const lastX = Math.floor((Math.max(a.x, b.x) + reach) / size);
      const lastZ = Math.floor((Math.max(a.z, b.z) + reach) / size);
      for (let ix = Math.floor((Math.min(a.x, b.x) - reach) / size); ix <= lastX; ix++) {
        for (let iz = Math.floor((Math.min(a.z, b.z) - reach) / size); iz <= lastZ; iz++) {
          const key = (ix + INDEX_KEY_OFFSET) * INDEX_KEY_SPAN + (iz + INDEX_KEY_OFFSET);
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(id);
          else this.buckets.set(key, [id]);
        }
      }
    }
    return road;
  }

  /** Stops reporting a road (its buckets keep the ids, queries skip them). */
  remove(road: number): void {
    if (road >= 0 && road < this.paths.length) this.paths[road] = null;
  }

  /**
   * Refills `out` with every segment whose footprint, widened by `margin` (<= maxMargin), contains (x, z).
   * Neighbouring segments of one road usually both report the same spot.
   */
  query(x: number, z: number, margin: number, out: RoadHit[]): RoadHit[] {
    out.length = 0;
    const size = this.bucketSize;
    const bucket = this.buckets.get(
      (Math.floor(x / size) + INDEX_KEY_OFFSET) * INDEX_KEY_SPAN + (Math.floor(z / size) + INDEX_KEY_OFFSET),
    );
    if (!bucket) return out;
    for (let k = 0; k < bucket.length; k++) {
      const id = bucket[k];
      const path = this.paths[this.segRoad[id]];
      if (!path) continue;
      const i = this.segIndex[id];
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      let t = lengthSq > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / lengthSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (a.x + dx * t);
      const ez = z - (a.z + dz * t);
      const offset = Math.sqrt(ex * ex + ez * ez);
      const halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
      if (offset > halfWidth + margin) continue;
      out.push({
        road: this.segRoad[id],
        index: i,
        t,
        dist: a.dist + (b.dist - a.dist) * t,
        offset,
        halfWidth,
        y: a.y + (b.y - a.y) * t,
      });
    }
    return out;
  }

  /**
   * The surface a car at height `fromY` standing at (x, z) rests on (ROAD SURFACE HEIGHT in src/types.ts, without
   * bumps): the highest road there whose surface is at most fromY + STEP_UP, else TERRAIN_Y.
   */
  surfaceAt(x: number, z: number, fromY: number): number {
    const hits = this.query(x, z, 0, this.scratchHits);
    let best = TERRAIN_Y;
    for (let k = 0; k < hits.length; k++) {
      const y = hits[k].y;
      if (y <= fromY + STEP_UP && y > best) best = y;
    }
    return best;
  }

  private readonly scratchHits: RoadHit[] = [];

  /** Ids of segments bucketed near (x, z) (for callers that want their own test). */
  candidates(x: number, z: number): readonly number[] {
    this.near.length = 0;
    const size = this.bucketSize;
    const bucket = this.buckets.get(
      (Math.floor(x / size) + INDEX_KEY_OFFSET) * INDEX_KEY_SPAN + (Math.floor(z / size) + INDEX_KEY_OFFSET),
    );
    if (bucket) for (let k = 0; k < bucket.length; k++) this.near.push(bucket[k]);
    return this.near;
  }
}

/** True when some hit is a different stretch of road: more than `gap` metres of centreline away from `dist`. */
export function hitsOtherRoad(hits: readonly RoadHit[], road: number, dist: number, gap: number): boolean {
  for (let k = 0; k < hits.length; k++) {
    if (hits[k].road !== road || Math.abs(hits[k].dist - dist) > gap) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Open edges and walls
// ---------------------------------------------------------------------------------------------------------------

/** Per segment i (path[i] to path[i + 1]): true when the road is raised (>= minHeight) at both ends. */
export function raisedSegments(path: readonly PathPoint[], minHeight = RAISED_HEIGHT): boolean[] {
  const out: boolean[] = new Array<boolean>(path.length).fill(false);
  for (let i = 0; i + 1 < path.length; i++) out[i] = path[i].y >= minHeight && path[i + 1].y >= minHeight;
  return out;
}

/** Probe distances straight out beyond an open edge that must be clear of other road at ANY height, m. */
const OUTWARD_PROBES = [1, 4, 8, 12, 16];
/**
 * Fastest a car leaves an open edge (the redline is about 40 m/s), m/s. With it, how far a car can fly before it has
 * dropped onto a road `dy` metres below the brink: FLIGHT_SPEED * sqrt(2 dy / g).
 */
export const FLIGHT_SPEED = 42;
const FLIGHT_GRAVITY = 9.81;
/** Furthest the landing zone beyond an open edge is searched, m. */
export const FLIGHT_MAX_REACH = 128;
/** Spacing of the probes along each ray of the landing zone, m (well under any road's width). */
const FLIGHT_PROBE_STEP = 4;
/** A road up to this much above the brink still counts as reachable (the car may be lifted by a bump), m. */
const FLIGHT_RISE = 1;
/**
 * Directions of the landing-zone rays, as (forward, outward) shares of a unit vector: a car leaves the brink
 * anywhere from square to it (90 degrees off the road's own direction) down to 15 degrees off it, every 15 degrees.
 * Fixed constants (no trigonometry).
 */
const FLIGHT_RAYS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.25881904510252074, 0.9659258262890683],
  [0.5, 0.8660254037844386],
  [0.7071067811865476, 0.7071067811865476],
  [0.8660254037844386, 0.5],
  [0.9659258262890683, 0.25881904510252074],
];

/**
 * How far (in plan) a car leaving a brink at height `brinkY` at FLIGHT_SPEED, rising at `climb` m/s, flies before it
 * comes down to height `y`, m (0 when it never gets there). Any shorter distance is reachable too, by a slower car.
 */
export function flightReach(brinkY: number, climb: number, y: number): number {
  const vy = Math.max(0, climb);
  const disc = vy * vy + 2 * FLIGHT_GRAVITY * (brinkY + FLIGHT_RISE - y);
  if (disc <= 0) return 0;
  return (FLIGHT_SPEED * (vy + Math.sqrt(disc))) / FLIGHT_GRAVITY;
}

/**
 * Whether a road surface at height `y`, `distance` m (in plan) beyond a brink at height `brinkY`, is within reach of a
 * car flying off that brink at up to FLIGHT_SPEED, rising at `climb` m/s as it leaves.
 */
export function withinFlight(brinkY: number, y: number, distance: number, climb = 0): boolean {
  return distance <= flightReach(brinkY, climb, y);
}

/** The wheels leave a crest once following it would pull down harder than this (as the car model), m/s². */
const BUMP_LAUNCH_ACCEL = 1.15 * FLIGHT_GRAVITY;

/**
 * How a car taking a bump (crest `height`, `halfLength`) at `speed` leaves it: its vertical speed `vy` (m/s) and its
 * height above the plain road `y0` (m) at take-off, on the far side of the ridge where following it would pull down
 * harder than the car model allows. `vy` 0 when it never leaves the ground.
 */
export function bumpLaunch(height: number, halfLength: number, speed = FLIGHT_SPEED): { vy: number; y0: number } {
  const k = PI / halfLength;
  const peakPull = speed * speed * height * 0.5 * k * k;
  if (peakPull <= BUMP_LAUNCH_ACCEL) return { vy: 0, y0: height };
  const c = BUMP_LAUNCH_ACCEL / peakPull;
  return { vy: speed * height * 0.5 * k * Math.sqrt(1 - c * c), y0: height * 0.5 * (1 + c) };
}

/** A bump along a road, by centreline distance of its crest. */
export interface BumpAlong {
  dist: number;
  height: number;
  halfLength: number;
}

/** Each bump of a road with the centreline distance of its crest (projected onto the road at the bump's height). */
export function bumpsAlong(path: readonly PathPoint[], bumps: readonly Bump[]): BumpAlong[] {
  const out: BumpAlong[] = [];
  for (const bump of bumps) {
    let best = Infinity;
    let dist = NaN;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      let t = lengthSq > 0 ? ((bump.x - a.x) * dx + (bump.z - a.z) * dz) / lengthSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.abs(a.y + (b.y - a.y) * t - bump.y) > 1.5) continue;
      const ox = bump.x - (a.x + dx * t);
      const oz = bump.z - (a.z + dz * t);
      const off = ox * ox + oz * oz;
      if (off < best) {
        best = off;
        dist = a.dist + (b.dist - a.dist) * t;
      }
    }
    if (!Number.isNaN(dist)) out.push({ dist, height: bump.height, halfLength: bump.halfLength });
  }
  return out;
}

/**
 * Upward speed a car may carry over an edge at centreline distance `dist`, from the bumps of its road (m/s): one
 * launched by a crest behind it is still climbing or flying when it gets there. Taken as if it left at the brink.
 */
export function bumpClimbAt(bumps: readonly BumpAlong[], dist: number): number {
  let climb = 0;
  for (const b of bumps) {
    const { vy } = bumpLaunch(b.height, b.halfLength);
    if (vy <= 0) continue;
    // A flight from this crest lasts at most this long horizontally (down to a road 0.5 m lower).
    const reach = (FLIGHT_SPEED * (vy + Math.sqrt(vy * vy + FLIGHT_GRAVITY))) / FLIGHT_GRAVITY;
    if (dist >= b.dist - b.halfLength && dist <= b.dist + reach) climb = Math.max(climb, vy);
  }
  return climb;
}

/**
 * True when a car going over edge segment i could come down on (or against) another stretch of road: hits from
 * `query(x, z)` for which `other(hit)` holds, either just beyond the edge at any height (OUTWARD_PROBES), or
 * anywhere in its landing zone (FLIGHT_RAYS out to FLIGHT_MAX_REACH) that a car leaving at FLIGHT_SPEED could
 * reach on the way down (withinFlight). `far` tells `other` which of the two found the hit. Shared by both
 * generators and both validators so they agree.
 */
export function edgeLandsOnOther(
  path: readonly PathPoint[],
  edge: readonly Vec2[],
  i: number,
  query: (x: number, z: number) => readonly RoadHit[],
  other: (hit: RoadHit, far: boolean) => boolean,
  launch = 0,
): boolean {
  const p = path[i];
  const q = path[i + 1];
  for (const share of [0, 0.5, 1]) {
    const ex = edge[i].x + (edge[i + 1].x - edge[i].x) * share;
    const ez = edge[i].z + (edge[i + 1].z - edge[i].z) * share;
    const ox = ex - (p.x + (q.x - p.x) * share);
    const oz = ez - (p.z + (q.z - p.z) * share);
    const len = Math.sqrt(ox * ox + oz * oz);
    if (len === 0) continue;
    for (const out of OUTWARD_PROBES) {
      const hits = query(ex + (ox / len) * out, ez + (oz / len) * out);
      for (let k = 0; k < hits.length; k++) if (other(hits[k], false)) return true;
    }
  }
  // The landing zone, from the middle of the edge segment (segments are 2-4 m long, the probes 4 m apart).
  const ex = (edge[i].x + edge[i + 1].x) / 2;
  const ez = (edge[i].z + edge[i + 1].z) / 2;
  const ox = ex - (p.x + q.x) / 2;
  const oz = ez - (p.z + q.z) / 2;
  const olen = Math.sqrt(ox * ox + oz * oz);
  const fx = q.x - p.x;
  const fz = q.z - p.z;
  const flen = Math.sqrt(fx * fx + fz * fz);
  if (olen === 0 || flen === 0) return false;
  const brinkY = (p.y + q.y) / 2;
  const climb = launchClimb(p, q, flen, launch);
  const furthest = Math.min(FLIGHT_MAX_REACH, flightReach(brinkY, climb, 0));
  for (const [along, outward] of FLIGHT_RAYS) {
    const dx = (fx / flen) * along + (ox / olen) * outward;
    const dz = (fz / flen) * along + (oz / olen) * outward;
    for (let d = FLIGHT_PROBE_STEP; d <= furthest; d += FLIGHT_PROBE_STEP) {
      const hits = query(ex + dx * d, ez + dz * d);
      for (let k = 0; k < hits.length; k++) {
        const hit = hits[k];
        if (withinFlight(brinkY, hit.y, d, climb) && other(hit, true)) return true;
      }
    }
  }
  return false;
}

/** Upward speed of a car leaving segment p..q at FLIGHT_SPEED: the road's own climb plus any bump launch, m/s. */
function launchClimb(p: PathPoint, q: PathPoint, flen: number, launch: number): number {
  return FLIGHT_SPEED * Math.max(0, (q.y - p.y) / flen) + Math.max(0, launch);
}

/**
 * Calls `visit(x, z)` for points covering the landing zone of edge segment i: where a car flying off it could come
 * down on a road at height 0 or above (the worst case for road not built yet). For keeping later road out of it.
 */
export function forEachLandingPoint(
  path: readonly PathPoint[],
  edge: readonly Vec2[],
  i: number,
  visit: (x: number, z: number) => void,
  launch = 0,
): void {
  const p = path[i];
  const q = path[i + 1];
  const ex = (edge[i].x + edge[i + 1].x) / 2;
  const ez = (edge[i].z + edge[i + 1].z) / 2;
  const ox = ex - (p.x + q.x) / 2;
  const oz = ez - (p.z + q.z) / 2;
  const olen = Math.sqrt(ox * ox + oz * oz);
  const fx = q.x - p.x;
  const fz = q.z - p.z;
  const flen = Math.sqrt(fx * fx + fz * fz);
  if (olen === 0 || flen === 0) return;
  const brinkY = (p.y + q.y) / 2;
  const furthest = Math.min(FLIGHT_MAX_REACH, flightReach(brinkY, launchClimb(p, q, flen, launch), 0));
  for (const [along, outward] of FLIGHT_RAYS) {
    const dx = (fx / flen) * along + (ox / olen) * outward;
    const dz = (fz / flen) * along + (oz / olen) * outward;
    for (let d = FLIGHT_PROBE_STEP; d <= furthest; d += FLIGHT_PROBE_STEP) visit(ex + dx * d, ez + dz * d);
  }
}

/**
 * True when a car going over edge segment i (of road `road` in `index`) could come down on, or edge-on against,
 * another stretch of road (more than `gap` m of centreline away): see edgeLandsOnOther. An edge there must keep its
 * barrier.
 */
export function edgeOverOtherRoad(
  index: RoadIndex,
  road: number,
  path: readonly PathPoint[],
  edge: readonly Vec2[],
  i: number,
  gap: number,
  scratch: RoadHit[] = [],
  bumps: readonly BumpAlong[] = [],
): boolean {
  const mid = (path[i].dist + path[i + 1].dist) / 2;
  return edgeLandsOnOther(
    path,
    edge,
    i,
    (x, z) => index.query(x, z, 0, scratch),
    (hit) => hit.road !== road || Math.abs(hit.dist - mid) > gap,
    bumpClimbAt(bumps, mid),
  );
}

export interface OpenEdgeRequest {
  path: readonly PathPoint[];
  /** Per segment: raised at both ends (see raisedSegments). Sets the edge length the share is taken of. */
  raised: readonly boolean[];
  /** Per segment and side: may this edge be open at all? Must already exclude low road and every keep-out zone. */
  allowLeft: readonly boolean[];
  allowRight: readonly boolean[];
  /** Per segment: part of a bend. A bend never has both sides open at once. */
  bend: readonly boolean[];
  /** 0..1 share of the raised edge length (both sides) to open. Best effort. */
  share: number;
  /** Length range of one open stretch, m of centreline. Default [30, 120]. */
  run?: [number, number];
  /** Minimum barrier between two open stretches on the same side, m. Default 20. */
  gap?: number;
}

export interface OpenEdgePlan {
  leftOpen: boolean[];
  rightOpen: boolean[];
  /** Centreline length of open edge, both sides summed, m. */
  openLength: number;
  /** Centreline length of raised edge, both sides summed, m. */
  raisedLength: number;
}

interface Run {
  side: number;
  first: number;
  /** One past the last segment. */
  end: number;
  length: number;
}

/**
 * Picks stretches of edge to leave open (no barrier). Each stretch lies inside the allowed segments, is `run`
 * metres long, keeps `gap` metres of barrier from the next one on the same side, and never faces an open stretch on
 * the other side within a bend. Arrays are as long as the path; the last entry is unused (false).
 */
export function chooseOpenEdges(rng: Rng, request: OpenEdgeRequest): OpenEdgePlan {
  const { path, raised, bend } = request;
  const [minRun, maxRun] = request.run ?? [30, 120];
  const gap = request.gap ?? 20;
  const n = path.length;
  const open = [new Array<boolean>(n).fill(false), new Array<boolean>(n).fill(false)];
  const allow = [request.allowLeft, request.allowRight];
  const segLength = (i: number): number => path[i + 1].dist - path[i].dist;
  let raisedLength = 0;
  for (let i = 0; i + 1 < n; i++) if (raised[i]) raisedLength += 2 * segLength(i);
  const target = Math.max(0, Math.min(1, request.share)) * raisedLength;
  let opened = 0;
  const usable = (side: number, i: number): boolean => {
    if (!allow[side][i] || open[side][i] || (bend[i] && open[1 - side][i])) return false;
    // Keep `gap` metres of barrier to any open stretch on this side.
    for (let k = i - 1; k >= 0 && path[i].dist - path[k + 1].dist < gap; k--) if (open[side][k]) return false;
    for (let k = i + 1; k + 1 < n && path[k].dist - path[i + 1].dist < gap; k++) if (open[side][k]) return false;
    return true;
  };
  for (let attempt = 0; attempt < 60 && opened < target; attempt++) {
    const runs: Run[] = [];
    let total = 0;
    for (let side = 0; side < 2; side++) {
      let first = -1;
      for (let i = 0; i <= n - 1; i++) {
        const ok = i + 1 < n && usable(side, i);
        if (ok && first < 0) first = i;
        if (!ok && first >= 0) {
          const length = path[i].dist - path[first].dist;
          if (length >= minRun) {
            runs.push({ side, first, end: i, length });
            total += length;
          }
          first = -1;
        }
      }
    }
    if (runs.length === 0) break;
    let roll = rng.next() * total;
    let pick = 0;
    while (pick < runs.length - 1 && roll >= runs[pick].length) roll -= runs[pick++].length;
    const run = runs[pick];
    const wanted = Math.min(maxRun, run.length, Math.max(minRun, target - opened + 10));
    // The more edge is wanted, the longer each stretch; it often hugs one end of the room so the rest of the room
    // stays usable for another stretch.
    const length = wanted - rng.next() * (wanted - minRun) * (1 - Math.min(1, request.share * 1.5));
    const where = rng.next();
    const slack = run.length - length;
    const startDist = path[run.first].dist + (where < 0.35 ? 0 : where > 0.65 ? slack : (slack * (where - 0.35)) / 0.3);
    let i = run.first;
    while (i < run.end - 1 && path[i + 1].dist <= startDist) i++;
    const from = path[i].dist;
    for (; i < run.end && path[i].dist - from < length; i++) {
      open[run.side][i] = true;
      opened += segLength(i);
    }
  }
  return { leftOpen: open[0], rightOpen: open[1], openLength: opened, raisedLength };
}

/** A barrier from a to b standing on the road at heights ya and yb. */
export function wallBetween(a: Vec2, b: Vec2, ya: number, yb: number): Wall {
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, ya, yb };
}

/** Appends one wall per edge segment that is not open, left side first, each at the road height at its ends. */
export function emitEdgeWalls(
  path: readonly PathPoint[],
  left: readonly Vec2[],
  right: readonly Vec2[],
  leftOpen: readonly boolean[],
  rightOpen: readonly boolean[],
  out: Wall[],
): void {
  for (let i = 0; i + 1 < path.length; i++) {
    if (!leftOpen[i]) out.push(wallBetween(left[i], left[i + 1], path[i].y, path[i + 1].y));
  }
  for (let i = 0; i + 1 < path.length; i++) {
    if (!rightOpen[i]) out.push(wallBetween(right[i], right[i + 1], path[i].y, path[i + 1].y));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Supports
// ---------------------------------------------------------------------------------------------------------------

export interface SupportOptions {
  /** Distance between columns along the road, [min, max] m. */
  spacing: [number, number];
  /** Columns stand under road at or above this height. Default RAISED_HEIGHT. */
  minHeight?: number;
  /** Column radius range, m. Default [0.9, 1.4]. */
  radius?: [number, number];
  /** Clear ground kept between a column and any other stretch of road in plan, m. Default 1. */
  clearance?: number;
  /** Centreline distance beyond which a hit counts as another stretch of road, m. Default 40. */
  gap?: number;
  /** Only place columns at or after this centreline distance (for chunked roads). */
  fromDist?: number;
}

/**
 * Columns under the raised parts of a road, centred under the centreline about every spacing metres, from the city
 * floor to just under the deck. A column that would stand on, or inside the footprint of, another stretch of road
 * (in plan, plus the clearance) is skipped. `index` must hold `path` as road `road`.
 */
export function placeSupports(
  rng: Rng,
  path: readonly PathPoint[],
  index: RoadIndex,
  road: number,
  options: SupportOptions,
  out: Support[],
): void {
  const minHeight = options.minHeight ?? RAISED_HEIGHT;
  const [minR, maxR] = options.radius ?? [0.9, 1.4];
  const clearance = options.clearance ?? 1;
  const gap = options.gap ?? 40;
  const hits: RoadHit[] = [];
  const last = path.length - 1;
  if (last < 1) return;
  let d = Math.max(path[0].dist, options.fromDist ?? -Infinity) + rng.range(0, options.spacing[1]);
  let i = 0;
  while (d <= path[last].dist) {
    while (i < last - 1 && path[i + 1].dist < d) i++;
    const a = path[i];
    const b = path[i + 1];
    const t = Math.max(0, Math.min(1, (d - a.dist) / (b.dist - a.dist)));
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t;
    const radius = rng.range(minR, maxR);
    if (y >= minHeight) {
      index.query(x, z, radius + clearance, hits);
      if (!hitsOtherRoad(hits, road, d, gap)) {
        out.push({ x: snap(x), z: snap(z), top: snap(y - DECK_THICKNESS), radius: snap(radius) });
      }
    }
    d += rng.range(options.spacing[0], options.spacing[1]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------------

/**
 * Box around everything a road piece holds, rounded outwards to the 1/1024 m lattice: road and edges at their
 * heights, walls up to WALL_HEIGHT above the road, props and bump crests at their tops, and supports and decor from
 * the city floor (TERRAIN_Y) up. minY is TERRAIN_Y whenever the piece has supports or decor.
 */
export function pieceBounds(piece: Omit<RoadPiece, 'bounds' | 'leftOpen' | 'rightOpen'>): RoadPiece['bounds'] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const xz = (x0: number, z0: number, x1: number, z1: number): void => {
    minX = Math.min(minX, x0);
    minZ = Math.min(minZ, z0);
    maxX = Math.max(maxX, x1);
    maxZ = Math.max(maxZ, z1);
  };
  const y = (y0: number, y1: number): void => {
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  };
  piece.path.forEach((p, i) => {
    xz(p.x, p.z, p.x, p.z);
    y(p.y, p.y);
    const l = piece.left[i];
    const r = piece.right[i];
    if (l) xz(l.x, l.z, l.x, l.z);
    if (r) xz(r.x, r.z, r.x, r.z);
  });
  for (const w of piece.walls) {
    xz(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz));
    y(Math.min(w.ya, w.yb), Math.max(w.ya, w.yb) + WALL_HEIGHT);
  }
  for (const p of piece.props) {
    xz(p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius);
    y(p.y, p.y + p.height);
  }
  for (const b of piece.bumps) {
    const reach = Math.sqrt(b.halfLength * b.halfLength + b.halfWidth * b.halfWidth);
    xz(b.x - reach, b.z - reach, b.x + reach, b.z + reach);
    y(b.y, b.y + b.height);
  }
  for (const s of piece.supports) {
    xz(s.x - s.radius, s.z - s.radius, s.x + s.radius, s.z + s.radius);
    y(TERRAIN_Y, s.top);
  }
  for (const d of piece.decor) {
    xz(d.x - d.w / 2, d.z - d.d / 2, d.x + d.w / 2, d.z + d.d / 2);
    y(TERRAIN_Y, TERRAIN_Y + d.h);
  }
  const down = (v: number): number => Math.floor(v * 1024) / 1024 + 0;
  const up = (v: number): number => Math.ceil(v * 1024) / 1024 + 0;
  return { minX: down(minX), minZ: down(minZ), maxX: up(maxX), maxZ: up(maxZ), minY: down(minY), maxY: up(maxY) };
}
