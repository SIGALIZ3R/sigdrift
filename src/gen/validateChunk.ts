/**
 * The safety net for the endless road. Every promise the chunk generator makes is checked again here from the
 * finished chunks alone, without knowing how they were built.
 *
 * `validateChunk` judges one chunk and how it meets the chunk before it. `validateChunkSequence` does that for
 * every chunk and then checks the rules that reach further than one join: roads, scenery, bumps and pillars of
 * chunks that are not neighbours must still keep clear of each other.
 */

import { lerp, sin, smoothstep } from '../core/fixedMath';
import type { Bump, DecorBlock, PathPoint, Prop, Segment, TrackChunk, ValidationResult, Vec2 } from '../types';
import { RULES, Report, SpatialHash, WallIndex, distPointSegment, fmt, insideWalls, segmentsTouch } from './validate';

/** What a chunk promises on top of the weekly level's RULES. The generator aims inside these limits. */
export const CHUNK_RULES = {
  /** Slightly below the generator's 7.5 m floor: rounding to the lattice may shave a little off. */
  minHalfWidth: 7.4,
  /** No wall may stand this close to the start pose. */
  startWallClearance: 6,
  propJoinClearance: 20,
  propStartClearance: 60,
  bumpSpacing: 60,
  bumpJoinClearance: 15,
  bumpPropClearance: 15,
  bumpMinHeight: 0.35,
  bumpMaxHeight: 0.8,
  bumpMinHalfLength: 5,
  bumpMaxHalfLength: 7,
  /** Straight road required either side of a crest on a gentle road ... */
  bumpBendGapGentle: 16,
  /** ... and at full intensity, where a bump may sit right before a bend. */
  bumpBendGapHarsh: 6,
  /** Below this intensity the road counts as gentle. */
  gentleIntensity: 0.3,
  /**
   * Straight road required AFTER a crest, before the next bend, on a gentle road. A car that takes an easy bump
   * at 30 m/s lands 20 to 30 m beyond the crest, and can neither brake nor steer on the way: this leaves it room
   * to come down and still slow for the bend. The requirement shrinks to the ordinary gap as the intensity rises
   * from `gentleIntensity` to `bumpLandingFadeEnd`.
   */
  bumpLandingGentle: 45,
  bumpLandingFadeEnd: 0.45,
  /** How far a bump's direction may be off the road's, rad. */
  bumpAlignment: 0.05,
  /** A bump sits on plain road: never on a plaza, and never where the road is changing width quickly. */
  bumpMaxRoadHalfWidth: 13,
  bumpMaxWidthChange: 2.5,
  /** The ridge spans wall to wall but does not reach far beyond the walls. */
  bumpMaxOverhang: 3,
} as const;

/** Least straight road between a bump's crest and a bend, m, for a chunk of the given intensity. */
export function minBumpToBend(intensity: number): number {
  const harshness = smoothstep(CHUNK_RULES.gentleIntensity, 1, intensity);
  return lerp(CHUNK_RULES.bumpBendGapGentle, CHUNK_RULES.bumpBendGapHarsh, harshness);
}

/**
 * Least straight road between a bump's crest and the next bend AHEAD of it, m: `minBumpToBend`, plus landing room
 * while the road is gentle (see `bumpLandingGentle`). From `bumpLandingFadeEnd` up it is exactly `minBumpToBend`.
 */
export function minBumpBeforeBend(intensity: number): number {
  const ordinary = minBumpToBend(intensity);
  const fade = smoothstep(CHUNK_RULES.gentleIntensity, CHUNK_RULES.bumpLandingFadeEnd, intensity);
  return fade >= 1 ? ordinary : lerp(CHUNK_RULES.bumpLandingGentle, ordinary, fade);
}

const EPS = 1e-6;
/** Rounding to the 1/1024 m lattice moves an emitted value by at most half a step. */
const SNAP = 1 / 1024;
/**
 * Anything larger is a broken chunk. The road has no end, so the limit is far beyond any run that could be driven,
 * and still small enough that the 1/1024 m lattice is exact.
 */
const MAX_COORDINATE = 1e9;
const EDGE_OFFSET_SLACK = 0.5;
/** With no neighbour to measure the tangent from, the first point of a chunk may sit at the start of a bend. */
const OPEN_END_OFFSET_SLACK = 1;
const EDGE_BUCKET = 16;
const BLOCK_BUCKET = 24;
/** A road sample turns by this much (sine of the angle) or more only inside a bend. */
const BEND_SINE = 0.01;
const STRAIGHT_PROBE = 3;
const STRAIGHT_TOLERANCE = 0.02;
/** Travelled distance and the straight-line step between samples agree to this, m. */
const DIST_STEP_SLACK = 0.1;
/** Measured positions along the road come from rounded coordinates. */
const ALONG_SLACK = 0.02;
const ON_CENTRELINE_SLACK = 0.05;
const MAX_PROP_RADIUS = 3;

const ALIGNMENT_SINE = sin(CHUNK_RULES.bumpAlignment);

// ---------------------------------------------------------------------------------------------------------------
// Shape and numbers
// ---------------------------------------------------------------------------------------------------------------

function checkShape(chunk: TrackChunk, report: Report): void {
  const n = chunk.path.length;
  if (n < 2) report.add('path too short', `${n} points`);
  if (chunk.left.length !== n || chunk.right.length !== n) {
    report.add('edge arrays differ from path', `path ${n}, left ${chunk.left.length}, right ${chunk.right.length}`);
  }
  if (!Number.isInteger(chunk.index) || chunk.index < 0) report.add('bad chunk index', `${chunk.index}`);
}

function checkNumbers(chunk: TrackChunk, report: Report): void {
  const check = (v: number, group: string, index: number): void => {
    if (!Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) report.add('bad number', `${group}[${index}] has ${v}`);
  };
  chunk.path.forEach((p, i) => {
    check(p.x, 'path', i);
    check(p.z, 'path', i);
    check(p.halfWidth, 'path', i);
    check(p.dist, 'path', i);
  });
  chunk.left.forEach((p, i) => {
    check(p.x, 'left', i);
    check(p.z, 'left', i);
  });
  chunk.right.forEach((p, i) => {
    check(p.x, 'right', i);
    check(p.z, 'right', i);
  });
  chunk.walls.forEach((w, i) => {
    check(w.ax, 'walls', i);
    check(w.az, 'walls', i);
    check(w.bx, 'walls', i);
    check(w.bz, 'walls', i);
  });
  chunk.props.forEach((p, i) => {
    check(p.x, 'props', i);
    check(p.z, 'props', i);
    check(p.radius, 'props', i);
    check(p.height, 'props', i);
    check(p.hue, 'props', i);
  });
  chunk.decor.forEach((b, i) => {
    check(b.x, 'decor', i);
    check(b.z, 'decor', i);
    check(b.w, 'decor', i);
    check(b.d, 'decor', i);
    check(b.h, 'decor', i);
    check(b.hue, 'decor', i);
  });
  chunk.bumps.forEach((b, i) => {
    check(b.x, 'bumps', i);
    check(b.z, 'bumps', i);
    check(b.dirX, 'bumps', i);
    check(b.dirZ, 'bumps', i);
    check(b.halfLength, 'bumps', i);
    check(b.halfWidth, 'bumps', i);
    check(b.height, 'bumps', i);
  });
  check(chunk.startDist, 'startDist', 0);
  check(chunk.endDist, 'endDist', 0);
  check(chunk.intensity, 'intensity', 0);
  check(chunk.bounds.minX, 'bounds', 0);
  check(chunk.bounds.minZ, 'bounds', 1);
  check(chunk.bounds.maxX, 'bounds', 2);
  check(chunk.bounds.maxZ, 'bounds', 3);
}

/** True when the chunk is well-formed enough for the geometric checks, which index arrays in step. */
function isSane(chunk: TrackChunk): boolean {
  const report = new Report();
  checkShape(chunk, report);
  checkNumbers(chunk, report);
  return report.clean;
}

// ---------------------------------------------------------------------------------------------------------------
// The road
// ---------------------------------------------------------------------------------------------------------------

/** A chunk's road, with the previous chunk's road in front of it when there is one. */
interface Road {
  path: readonly PathPoint[];
  left: readonly Vec2[];
  right: readonly Vec2[];
  /** Index in these arrays of the chunk's own first point. */
  offset: number;
}

function sameNumber(a: number, b: number): boolean {
  return a === b;
}

function joinedRoad(chunk: TrackChunk, previous: TrackChunk | null): Road {
  if (!previous) return { path: chunk.path, left: chunk.left, right: chunk.right, offset: 0 };
  return {
    path: previous.path.concat(chunk.path.slice(1)),
    left: previous.left.concat(chunk.left.slice(1)),
    right: previous.right.concat(chunk.right.slice(1)),
    offset: previous.path.length - 1,
  };
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
}

function checkPath(chunk: TrackChunk, report: Report): void {
  const path = chunk.path;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.halfWidth < CHUNK_RULES.minHalfWidth) {
      report.add('road too narrow', `path[${i}] half width ${fmt(p.halfWidth)} m`);
    }
    if (i === 0) continue;
    const prev = path[i - 1];
    const step = distance(prev.x, prev.z, p.x, p.z);
    if (step < RULES.minPathStep || step > RULES.maxPathStep) {
      report.add('path spacing outside 1..5 m', `path[${i - 1}] to path[${i}] is ${fmt(step)} m`);
    }
    if (!(p.dist > prev.dist)) report.add('path dist not increasing', `path[${i}]`);
    else if (Math.abs(p.dist - prev.dist - step) > DIST_STEP_SLACK) {
      report.add('path dist jumps', `path[${i}] is ${fmt(p.dist - prev.dist)} m on after a ${fmt(step)} m step`);
    }
  }
  if (!sameNumber(chunk.startDist, path[0].dist)) {
    report.add('startDist differs from first dist', `${chunk.startDist} vs ${path[0].dist}`);
  }
  if (!sameNumber(chunk.endDist, path[path.length - 1].dist)) {
    report.add('endDist differs from final dist', `${chunk.endDist} vs ${path[path.length - 1].dist}`);
  }
  if (chunk.index === 0 && chunk.startDist !== 0) report.add('first chunk does not start at 0', `${chunk.startDist}`);
  if (chunk.intensity < 0 || chunk.intensity > 1) report.add('intensity outside 0..1', `${chunk.intensity}`);
}

/** The chunk must begin exactly where the previous one ended: same point, same width, same edges. */
function checkJoin(chunk: TrackChunk, previous: TrackChunk, report: Report): void {
  if (chunk.index !== previous.index + 1) {
    report.add('chunks out of order', `${chunk.index} follows ${previous.index}`);
  }
  const last = previous.path.length - 1;
  const a = previous.path[last];
  const b = chunk.path[0];
  if (!sameNumber(a.x, b.x) || !sameNumber(a.z, b.z)) {
    report.add('join broken', `starts at (${b.x}, ${b.z}), previous chunk ends at (${a.x}, ${a.z})`);
  }
  if (!sameNumber(a.halfWidth, b.halfWidth)) {
    report.add('join changes width', `${b.halfWidth} after ${a.halfWidth}`);
  }
  if (!sameNumber(a.dist, b.dist) || !sameNumber(previous.endDist, chunk.startDist)) {
    report.add('join breaks dist', `${b.dist} after ${a.dist}`);
  }
  const edgesMeet =
    sameNumber(previous.left[last].x, chunk.left[0].x) &&
    sameNumber(previous.left[last].z, chunk.left[0].z) &&
    sameNumber(previous.right[last].x, chunk.right[0].x) &&
    sameNumber(previous.right[last].z, chunk.right[0].z);
  if (!edgesMeet) report.add('join leaves a gap in the walls', `between chunks ${previous.index} and ${chunk.index}`);
}

/** Each edge point must sit one half width to its own side of the centreline. */
function checkEdgeOffsets(chunk: TrackChunk, road: Road, joined: boolean, report: Report): void {
  const last = road.path.length - 1;
  for (let i = 0; i < chunk.path.length; i++) {
    const at = road.offset + i;
    const a = road.path[at > 0 ? at - 1 : 0];
    const b = road.path[at < last ? at + 1 : last];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const length = Math.sqrt(tx * tx + tz * tz);
    if (length === 0) continue;
    const p = chunk.path[i];
    // Right of the travel direction (tx, tz) is (-tz, tx).
    const rx = (-tz / length) * p.halfWidth;
    const rz = (tx / length) * p.halfWidth;
    const offLeft = distance(chunk.left[i].x, chunk.left[i].z, p.x - rx, p.z - rz);
    const offRight = distance(chunk.right[i].x, chunk.right[i].z, p.x + rx, p.z + rz);
    const slack = i === 0 && !joined && chunk.index > 0 ? OPEN_END_OFFSET_SLACK : EDGE_OFFSET_SLACK;
    if (offLeft > slack || offRight > slack) {
      report.add('edge not offset by half width', `index ${i} is off by ${fmt(Math.max(offLeft, offRight))} m`);
    }
  }
}

function polylineSegments(points: readonly Vec2[], into: Segment[]): void {
  for (let i = 0; i + 1 < points.length; i++) {
    into.push({ ax: points[i].x, az: points[i].z, bx: points[i + 1].x, bz: points[i + 1].z });
  }
}

function insertSegments(hash: SpatialHash, segments: readonly Segment[]): void {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.az, s.bz), Math.max(s.ax, s.bx), Math.max(s.az, s.bz));
  }
}

/** No stretch of either edge may touch another, apart from neighbours meeting end to end. */
function checkEdgeCrossings(road: Road, report: Report): void {
  const perSide = road.path.length - 1;
  const segments: Segment[] = [];
  polylineSegments(road.left, segments);
  polylineSegments(road.right, segments);
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, segments);
  const near: number[] = [];
  const own = (index: number): boolean => index % perSide >= road.offset;
  const name = (index: number): string => (index < perSide ? `left[${index}]` : `right[${index - perSide}]`);
  const reported = new Set<number>();
  for (let s = 0; s < segments.length; s++) {
    const a = segments[s];
    hash.collect(Math.min(a.ax, a.bx), Math.min(a.az, a.bz), Math.max(a.ax, a.bx), Math.max(a.az, a.bz), near);
    for (let k = 0; k < near.length; k++) {
      const t = near[k];
      const neighbours = t === s + 1 && t !== perSide;
      if (t <= s || neighbours || !(own(s) || own(t)) || !segmentsTouch(a, segments[t])) continue;
      const pair = s * segments.length + t;
      if (reported.has(pair)) continue;
      reported.add(pair);
      report.add('road edges intersect', `${name(s)} and ${name(t)}`);
    }
  }
}

/** Catches a road that folds back onto itself even where the edge polylines do not quite cross. */
function checkRoadOverlap(path: readonly PathPoint[], offset: number, report: Report): void {
  let widest = 0;
  for (let i = 0; i < path.length; i++) widest = Math.max(widest, path[i].halfWidth);
  const hash = new SpatialHash(Math.max(16, 2 * widest + RULES.overlapMargin));
  for (let i = 0; i < path.length; i++) hash.insert(i, path[i].x, path[i].z, path[i].x, path[i].z);
  const near: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const reach = p.halfWidth + widest + RULES.overlapMargin;
    hash.collect(p.x - reach, p.z - reach, p.x + reach, p.z + reach, near);
    for (let k = 0; k < near.length; k++) {
      const j = near[k];
      const q = path[j];
      if (j <= i || j < offset || q.dist - p.dist <= RULES.overlapPathGap) continue;
      const needed = p.halfWidth + q.halfWidth + RULES.overlapMargin;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dx * dx + dz * dz <= needed * needed) {
        const apart = Math.sqrt(dx * dx + dz * dz);
        report.add(
          'road runs into itself',
          `points at ${fmt(p.dist)} m and ${fmt(q.dist)} m are ${fmt(apart)} m apart, need ${fmt(needed)}`,
        );
      }
    }
  }
}

function sameSegment(w: Segment, a: Vec2, b: Vec2): boolean {
  const close = (ax: number, az: number, bx: number, bz: number): boolean =>
    Math.abs(ax - bx) <= EPS && Math.abs(az - bz) <= EPS;
  return (
    (close(w.ax, w.az, a.x, a.z) && close(w.bx, w.bz, b.x, b.z)) ||
    (close(w.ax, w.az, b.x, b.z) && close(w.bx, w.bz, a.x, a.z))
  );
}

/**
 * Every stretch of both edges must be a wall, so the boundary has no holes. Returns the walls that are not part
 * of an edge: the cap behind the start in the first chunk, and nothing anywhere else.
 */
function checkWallsFollowEdges(chunk: TrackChunk, report: Report): Segment[] {
  const walls = chunk.walls;
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, walls);
  const near: number[] = [];
  const taken = new Array<boolean>(walls.length).fill(false);
  const check = (edge: readonly Vec2[], name: string): void => {
    for (let i = 0; i + 1 < edge.length; i++) {
      const a = edge[i];
      const b = edge[i + 1];
      hash.collect(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z), near);
      let found = false;
      for (let k = 0; k < near.length && !found; k++) {
        if (taken[near[k]] || !sameSegment(walls[near[k]], a, b)) continue;
        taken[near[k]] = true;
        found = true;
      }
      if (!found) report.add('road edge has no wall', `${name}[${i}] to ${name}[${i + 1}]`);
    }
  };
  check(chunk.left, 'left');
  check(chunk.right, 'right');
  return walls.filter((_, i) => !taken[i]);
}

/** The first chunk is closed behind the start by a chain of walls from one edge to the other. */
function checkStartCap(chunk: TrackChunk, cap: readonly Segment[], report: Report): void {
  if (cap.length === 0) {
    report.add('no wall behind the start', 'the first chunk is open at the back');
    return;
  }
  const used = new Array<boolean>(cap.length).fill(false);
  const goal = chunk.right[0];
  let x = chunk.left[0].x;
  let z = chunk.left[0].z;
  for (let step = 0; step < cap.length; step++) {
    let next = -1;
    for (let i = 0; i < cap.length && next < 0; i++) {
      if (used[i]) continue;
      const w = cap[i];
      const fromA = Math.abs(w.ax - x) <= EPS && Math.abs(w.az - z) <= EPS;
      const fromB = Math.abs(w.bx - x) <= EPS && Math.abs(w.bz - z) <= EPS;
      if (!fromA && !fromB) continue;
      next = i;
      x = fromA ? w.bx : w.ax;
      z = fromA ? w.bz : w.az;
    }
    if (next < 0) break;
    used[next] = true;
  }
  const closed = Math.abs(x - goal.x) <= EPS && Math.abs(z - goal.z) <= EPS && used.every((u) => u);
  if (!closed) report.add('wall behind the start is not closed', `${cap.length} segments do not join the two edges`);
  const start = chunk.path[0];
  for (let i = 0; i < chunk.walls.length; i++) {
    const w = chunk.walls[i];
    const room = distPointSegment(start.x, start.z, w.ax, w.az, w.bx, w.bz);
    if (room < CHUNK_RULES.startWallClearance) {
      report.add('start too close to a wall', `walls[${i}] is ${fmt(room)} m away, need 6`);
    }
  }
}

function checkWalls(chunk: TrackChunk, report: Report): void {
  const spare = checkWallsFollowEdges(chunk, report);
  if (chunk.index === 0) checkStartCap(chunk, spare, report);
  else if (spare.length > 0) report.add('walls that are not road edges', `${spare.length} segments`);
}

/**
 * The chunk's road as a closed outline for inside tests: its walls plus a line across each open end. The first
 * chunk's back end is already closed by its cap.
 */
function outlineOf(chunk: TrackChunk): Segment[] {
  const outline = chunk.walls.slice();
  const last = chunk.path.length - 1;
  const across = (i: number): Segment => ({
    ax: chunk.left[i].x,
    az: chunk.left[i].z,
    bx: chunk.right[i].x,
    bz: chunk.right[i].z,
  });
  outline.push(across(last));
  if (chunk.index > 0) outline.push(across(0));
  return outline;
}

interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function roadBox(chunk: TrackChunk): Box {
  const box: Box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const w of chunk.walls) {
    box.minX = Math.min(box.minX, w.ax, w.bx);
    box.minZ = Math.min(box.minZ, w.az, w.bz);
    box.maxX = Math.max(box.maxX, w.ax, w.bx);
    box.maxZ = Math.max(box.maxZ, w.az, w.bz);
  }
  return box;
}

// ---------------------------------------------------------------------------------------------------------------
// Positions along the road
// ---------------------------------------------------------------------------------------------------------------

interface Projection {
  /** Index of the path segment the point is nearest to. */
  segment: number;
  /** Distance along the whole road, m. */
  dist: number;
  /** Distance from the centreline, m. */
  offset: number;
}

function projectOnPath(path: readonly PathPoint[], x: number, z: number): Projection {
  const best: Projection = { segment: 0, dist: path[0].dist, offset: Infinity };
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / lengthSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const offset = distance(x, z, a.x + dx * t, a.z + dz * t);
    if (offset < best.offset) {
      best.segment = i;
      best.dist = a.dist + (b.dist - a.dist) * t;
      best.offset = offset;
    }
  }
  return best;
}

/** `dist` of every road sample where the road changes direction, in driving order. */
function bendDists(road: Road): number[] {
  const path = road.path;
  const bends: number[] = [];
  for (let i = 1; i + 1 < path.length; i++) {
    const ax = path[i].x - path[i - 1].x;
    const az = path[i].z - path[i - 1].z;
    const bx = path[i + 1].x - path[i].x;
    const bz = path[i + 1].z - path[i].z;
    const cross = ax * bz - az * bx;
    const scale = Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
    if (scale > 0 && Math.abs(cross) > BEND_SINE * scale) bends.push(path[i].dist);
  }
  return bends;
}

function isStraightAround(path: readonly PathPoint[], index: number): boolean {
  const from = Math.max(index - STRAIGHT_PROBE, 0);
  const to = Math.min(index + STRAIGHT_PROBE, path.length - 1);
  const a = path[from];
  const b = path[to];
  for (let i = from + 1; i < to; i++) {
    if (distPointSegment(path[i].x, path[i].z, a.x, a.z, b.x, b.z) > STRAIGHT_TOLERANCE) return false;
  }
  return true;
}

function distToPolyline(points: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = distPointSegment(x, z, points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

function checkProp(chunk: TrackChunk, outline: readonly Segment[], prop: Prop, label: string, report: Report): number {
  const at = projectOnPath(chunk.path, prop.x, prop.z);
  if (prop.kind !== 'pillar') report.add('unknown prop kind', `${label} is "${String(prop.kind)}"`);
  if (!(prop.radius > 0) || prop.radius > MAX_PROP_RADIUS || !(prop.height > 0)) {
    report.add('prop has a bad size', `${label} radius ${fmt(prop.radius)}, height ${fmt(prop.height)}`);
  }
  const toLeft = distToPolyline(chunk.left, prop.x, prop.z);
  const toRight = distToPolyline(chunk.right, prop.x, prop.z);
  if (!insideWalls(outline, prop.x, prop.z) || Math.min(toLeft, toRight) < prop.radius) {
    report.add('prop is not inside the road', label);
    return at.dist;
  }
  const corridor = Math.max(toLeft, toRight) - prop.radius;
  if (corridor < RULES.propCorridor - EPS) {
    report.add('prop blocks the road', `${label} leaves ${fmt(corridor)} m on its widest side, need 7.5`);
  }
  const nearest = at.dist - chunk.path[at.segment].dist < chunk.path[at.segment + 1].dist - at.dist ? 0 : 1;
  if (!isStraightAround(chunk.path, at.segment + nearest)) report.add('prop in a bend', label);
  if (at.dist < CHUNK_RULES.propStartClearance) {
    report.add('prop too close to the start', `${label} at ${fmt(at.dist)} m, need 60`);
  }
  const toJoin = Math.min(at.dist - chunk.startDist, chunk.endDist - at.dist);
  if (toJoin < CHUNK_RULES.propJoinClearance - ALONG_SLACK) {
    report.add('prop too close to a chunk join', `${label} is ${fmt(toJoin)} m from it, need 20`);
  }
  return at.dist;
}

function checkSpacing(dists: number[], needed: number, rule: string, report: Report): void {
  const sorted = dists.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap < needed - ALONG_SLACK) report.add(rule, `${fmt(gap)} m apart along the road, need ${needed}`);
  }
}

function propDists(chunk: TrackChunk): number[] {
  return chunk.props.map((prop) => projectOnPath(chunk.path, prop.x, prop.z).dist);
}

function checkProps(chunk: TrackChunk, previous: TrackChunk | null, outline: readonly Segment[], report: Report): void {
  if (chunk.index === 0 && chunk.props.length > 0) {
    report.add('props in the first chunk', `${chunk.props.length} of them`);
  }
  const dists = chunk.props.map((prop, i) => checkProp(chunk, outline, prop, `props[${i}]`, report));
  if (previous) dists.push(...propDists(previous));
  checkSpacing(dists, RULES.propSpacing, 'props too close together', report);
}

// ---------------------------------------------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------------------------------------------

function bumpDists(chunk: TrackChunk): number[] {
  return chunk.bumps.map((bump) => projectOnPath(chunk.path, bump.x, bump.z).dist);
}

function checkBumpSize(bump: Bump, label: string, report: Report): void {
  if (bump.height < CHUNK_RULES.bumpMinHeight - SNAP || bump.height > CHUNK_RULES.bumpMaxHeight + SNAP) {
    report.add('bump height outside 0.35..0.8 m', `${label} is ${fmt(bump.height)} m`);
  }
  const length = bump.halfLength;
  if (length < CHUNK_RULES.bumpMinHalfLength - SNAP || length > CHUNK_RULES.bumpMaxHalfLength + SNAP) {
    report.add('bump half length outside 5..7 m', `${label} is ${fmt(length)} m`);
  }
  if (Math.abs(bump.dirX * bump.dirX + bump.dirZ * bump.dirZ - 1) > EPS) {
    report.add('bump direction is not a unit vector', `${label} has (${bump.dirX}, ${bump.dirZ})`);
  }
}

/**
 * Straight road is needed under the whole ridge, and either side of it for as long as the chunk's intensity asks:
 * more ahead of the crest than behind it on a gentle road, where the car needs room to land before the next bend.
 */
function checkBumpOnStraight(
  chunk: TrackChunk,
  bump: Bump,
  at: Projection,
  bends: readonly number[],
  label: string,
  report: Report,
): void {
  const a = chunk.path[at.segment];
  const b = chunk.path[at.segment + 1];
  const length = distance(a.x, a.z, b.x, b.z);
  const along = ((b.x - a.x) * bump.dirX + (b.z - a.z) * bump.dirZ) / length;
  const across = ((b.x - a.x) * bump.dirZ - (b.z - a.z) * bump.dirX) / length;
  if (along <= 0 || Math.abs(across) > ALIGNMENT_SINE) report.add('bump is not square to the road', label);
  const neededBehind = Math.max(minBumpToBend(chunk.intensity), bump.halfLength);
  const neededAhead = Math.max(minBumpBeforeBend(chunk.intensity), bump.halfLength);
  let behind = Infinity;
  let ahead = Infinity;
  for (let i = 0; i < bends.length; i++) {
    const gap = bends[i] - at.dist;
    if (gap >= 0) ahead = Math.min(ahead, gap);
    else behind = Math.min(behind, -gap);
  }
  if (behind < neededBehind - ALONG_SLACK) {
    report.add('bump too close to a bend', `${label} has ${fmt(behind)} m of straight before it, needs ${fmt(neededBehind)}`);
  }
  if (ahead < neededAhead - ALONG_SLACK) {
    report.add('bump too close to a bend', `${label} has ${fmt(ahead)} m of straight after it, needs ${fmt(neededAhead)}`);
  }
  // The next chunk may open with a bend, so the open end counts as one.
  const toEnd = chunk.endDist - at.dist;
  const toStart = at.dist - chunk.startDist;
  const tooLate = toEnd < Math.max(CHUNK_RULES.bumpJoinClearance, neededAhead) - ALONG_SLACK;
  if (tooLate || toStart < CHUNK_RULES.bumpJoinClearance - ALONG_SLACK) {
    report.add('bump too close to a chunk join', `${label} is ${fmt(Math.min(toEnd, toStart))} m from it`);
  }
}

/** The ridge must reach both walls, on road that is neither a plaza nor changing width quickly. */
function checkBumpSpan(chunk: TrackChunk, bump: Bump, at: Projection, label: string, report: Report): void {
  const a = chunk.path[at.segment];
  const b = chunk.path[at.segment + 1];
  const share = b.dist > a.dist ? (at.dist - a.dist) / (b.dist - a.dist) : 0;
  const atCrest = a.halfWidth + (b.halfWidth - a.halfWidth) * share;
  let narrowest = atCrest;
  let widest = atCrest;
  for (let i = 0; i < chunk.path.length; i++) {
    const p = chunk.path[i];
    if (Math.abs(p.dist - at.dist) > bump.halfLength) continue;
    narrowest = Math.min(narrowest, p.halfWidth);
    widest = Math.max(widest, p.halfWidth);
  }
  if (bump.halfWidth < widest - EPS) {
    report.add('bump does not span the road', `${label} reaches ${fmt(bump.halfWidth)} m, the road ${fmt(widest)} m`);
  }
  if (bump.halfWidth > atCrest + CHUNK_RULES.bumpMaxOverhang) {
    report.add('bump is far wider than the road', `${label} reaches ${fmt(bump.halfWidth)} m of ${fmt(atCrest)} m`);
  }
  if (widest > CHUNK_RULES.bumpMaxRoadHalfWidth || widest - narrowest > CHUNK_RULES.bumpMaxWidthChange) {
    report.add('bump on a plaza or a width change', `${label} lies on road ${fmt(narrowest)}..${fmt(widest)} m wide`);
  }
}

function checkBumpsClearOfProps(bumps: readonly Bump[], props: readonly Prop[], report: Report): void {
  for (let i = 0; i < bumps.length; i++) {
    for (let k = 0; k < props.length; k++) {
      const apart = distance(bumps[i].x, bumps[i].z, props[k].x, props[k].z);
      if (apart < CHUNK_RULES.bumpPropClearance) {
        report.add('bump too close to a pillar', `${fmt(apart)} m apart, need 15`);
      }
    }
  }
}

function checkBumps(chunk: TrackChunk, previous: TrackChunk | null, road: Road, report: Report): void {
  if (chunk.index === 0 && chunk.bumps.length > 0) {
    report.add('bumps in the first chunk', `${chunk.bumps.length} of them`);
  }
  const bends = bendDists(road);
  const dists: number[] = [];
  chunk.bumps.forEach((bump, i) => {
    const label = `bumps[${i}]`;
    const at = projectOnPath(chunk.path, bump.x, bump.z);
    dists.push(at.dist);
    checkBumpSize(bump, label, report);
    if (at.offset > ON_CENTRELINE_SLACK) {
      report.add('bump is not centred on the road', `${label} is ${fmt(at.offset)} m off the centreline`);
      return;
    }
    checkBumpOnStraight(chunk, bump, at, bends, label, report);
    checkBumpSpan(chunk, bump, at, label, report);
  });
  if (previous) dists.push(...bumpDists(previous));
  checkSpacing(dists, CHUNK_RULES.bumpSpacing, 'bumps too close together', report);
  checkBumpsClearOfProps(chunk.bumps, chunk.props, report);
  if (previous) {
    checkBumpsClearOfProps(chunk.bumps, previous.props, report);
    checkBumpsClearOfProps(previous.bumps, chunk.props, report);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------------------------------------------

/** One chunk's road as the scenery sees it. */
interface RoadSide {
  walls: WallIndex;
  outline: Segment[];
  box: Box;
}

function roadSideOf(chunk: TrackChunk): RoadSide {
  return { walls: new WallIndex(chunk.walls), outline: outlineOf(chunk), box: roadBox(chunk) };
}

function checkBlockShape(block: DecorBlock, label: string, report: Report): void {
  const sizeOk = (v: number): boolean => v >= RULES.decorMinSize && v <= RULES.decorMaxSize;
  if (!sizeOk(block.w) || !sizeOk(block.d)) report.add('decor footprint outside 6..22 m', label);
  if (!Number.isInteger(block.hue) || block.hue < 0 || block.hue >= RULES.decorHues) {
    report.add('decor hue outside 0..5', label);
  }
  if (block.h < RULES.decorMinHeight || block.h > RULES.decorMaxHeight) {
    report.add('decor height outside 3..70 m', `${label} is ${fmt(block.h)} m tall`);
  }
}

/** A block near a road hides the car from the fixed camera, so its height is tied to its distance from the walls. */
function checkBlockClearOfRoad(block: DecorBlock, label: string, road: RoadSide, report: Report): void {
  const needed = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
  const minX = block.x - block.w / 2;
  const minZ = block.z - block.d / 2;
  const clearance = road.walls.clearance(minX, minZ, minX + block.w, minZ + block.d, needed + 1);
  if (clearance < needed - EPS) {
    report.add(
      'decor too tall or too close to the road',
      `${label} is ${fmt(block.h)} m tall, ${fmt(clearance)} m from the road, needs ${fmt(needed)} m`,
    );
  }
  const box = road.box;
  const inBox = block.x >= box.minX && block.x <= box.maxX && block.z >= box.minZ && block.z <= box.maxZ;
  if (inBox && insideWalls(road.outline, block.x, block.z)) report.add('decor stands on the road', label);
}

interface LabelledBlock {
  block: DecorBlock;
  label: string;
}

function checkDecorOverlap(blocks: readonly LabelledBlock[], firstOwn: number, report: Report): void {
  const hash = new SpatialHash(BLOCK_BUCKET);
  const near: number[] = [];
  const reported = new Set<number>();
  blocks.forEach(({ block: b, label }, i) => {
    const minX = b.x - b.w / 2;
    const minZ = b.z - b.d / 2;
    hash.collect(minX, minZ, minX + b.w, minZ + b.d, near);
    for (let k = 0; k < near.length; k++) {
      const other = near[k];
      const o = blocks[other].block;
      const apartX = Math.abs(o.x - b.x) - (o.w + b.w) / 2;
      const apartZ = Math.abs(o.z - b.z) - (o.d + b.d) / 2;
      if (apartX >= -EPS || apartZ >= -EPS || i < firstOwn || reported.has(other * blocks.length + i)) continue;
      reported.add(other * blocks.length + i);
      report.add('decor blocks overlap', `${blocks[other].label} and ${label}`);
    }
    hash.insert(i, minX, minZ, minX + b.w, minZ + b.d);
  });
}

function checkDecor(chunk: TrackChunk, previous: TrackChunk | null, own: RoadSide, report: Report): void {
  const before = previous ? roadSideOf(previous) : null;
  chunk.decor.forEach((block, i) => {
    const label = `decor[${i}]`;
    checkBlockShape(block, label, report);
    checkBlockClearOfRoad(block, label, own, report);
    if (before) checkBlockClearOfRoad(block, label, before, report);
  });
  const blocks: LabelledBlock[] = [];
  if (previous) {
    previous.decor.forEach((block, i) => {
      const label = `decor[${i}] of chunk ${previous.index}`;
      blocks.push({ block, label });
      // Scenery laid down earlier must not end up beside, or on, the road that arrives after it.
      checkBlockClearOfRoad(block, label, own, report);
    });
  }
  const firstOwn = blocks.length;
  chunk.decor.forEach((block, i) => blocks.push({ block, label: `decor[${i}]` }));
  checkDecorOverlap(blocks, firstOwn, report);
}

// ---------------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------------

function checkBounds(chunk: TrackChunk, report: Report): void {
  const b = chunk.bounds;
  const check = (minX: number, minZ: number, maxX: number, maxZ: number, label: string): void => {
    if (minX < b.minX - EPS || minZ < b.minZ - EPS || maxX > b.maxX + EPS || maxZ > b.maxZ + EPS) {
      report.add('bounds do not contain everything', label);
    }
  };
  chunk.path.forEach((p, i) => check(p.x, p.z, p.x, p.z, `path[${i}]`));
  chunk.left.forEach((p, i) => check(p.x, p.z, p.x, p.z, `left[${i}]`));
  chunk.right.forEach((p, i) => check(p.x, p.z, p.x, p.z, `right[${i}]`));
  chunk.walls.forEach((w, i) => {
    check(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz), `walls[${i}]`);
  });
  chunk.props.forEach((p, i) => check(p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius, `props[${i}]`));
  chunk.decor.forEach((d, i) => check(d.x - d.w / 2, d.z - d.d / 2, d.x + d.w / 2, d.z + d.d / 2, `decor[${i}]`));
  chunk.bumps.forEach((bump, i) => {
    // The ridge is a rectangle turned to the road; its corners are its extremes.
    const reachX = Math.abs(bump.dirX) * bump.halfLength + Math.abs(bump.dirZ) * bump.halfWidth;
    const reachZ = Math.abs(bump.dirZ) * bump.halfLength + Math.abs(bump.dirX) * bump.halfWidth;
    check(bump.x - reachX, bump.z - reachZ, bump.x + reachX, bump.z + reachZ, `bumps[${i}]`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// One chunk
// ---------------------------------------------------------------------------------------------------------------

/**
 * Returns every broken rule of one chunk as a readable sentence. Pass the chunk before it to also check the join
 * and everything the two chunks must keep clear of in each other; pass null for a chunk judged on its own.
 */
export function validateChunk(chunk: TrackChunk, previous: TrackChunk | null): ValidationResult {
  const report = new Report();
  checkShape(chunk, report);
  checkNumbers(chunk, report);
  // The geometric checks index arrays in step and walk spatial grids, so they need sane input.
  if (!report.clean) return report.result();
  const before = previous && isSane(previous) ? previous : null;
  checkPath(chunk, report);
  if (before) checkJoin(chunk, before, report);
  const road = joinedRoad(chunk, before);
  checkEdgeOffsets(chunk, road, before !== null, report);
  checkEdgeCrossings(road, report);
  checkRoadOverlap(road.path, road.offset, report);
  checkWalls(chunk, report);
  const own = roadSideOf(chunk);
  checkProps(chunk, before, own.outline, report);
  checkBumps(chunk, before, road, report);
  checkDecor(chunk, before, own, report);
  checkBounds(chunk, report);
  return report.result();
}

// ---------------------------------------------------------------------------------------------------------------
// A run of chunks
// ---------------------------------------------------------------------------------------------------------------

/** The whole run as one road. Chunks that do not join are still laid end to end; their own check reports the gap. */
function wholeRoad(chunks: readonly TrackChunk[]): Road {
  const path: PathPoint[] = [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  chunks.forEach((chunk, n) => {
    const from = n === 0 ? 0 : 1;
    for (let i = from; i < chunk.path.length; i++) {
      path.push(chunk.path[i]);
      left.push(chunk.left[i]);
      right.push(chunk.right[i]);
    }
  });
  return { path, left, right, offset: 0 };
}

/** Scenery of every chunk against the road of every chunk, and against all other scenery. */
function checkAllDecor(chunks: readonly TrackChunk[], report: Report): void {
  const sides = chunks.map(roadSideOf);
  const blocks: LabelledBlock[] = [];
  chunks.forEach((chunk) => {
    chunk.decor.forEach((block, i) => {
      const label = `decor[${i}] of chunk ${chunk.index}`;
      blocks.push({ block, label });
      const reach = block.h / RULES.decorHeightPerClearance + RULES.decorMaxSize;
      for (const side of sides) {
        const box = side.box;
        const farInX = block.x < box.minX - reach || block.x > box.maxX + reach;
        const farInZ = block.z < box.minZ - reach || block.z > box.maxZ + reach;
        if (!farInX && !farInZ) checkBlockClearOfRoad(block, label, side, report);
      }
    });
  });
  checkDecorOverlap(blocks, 0, report);
}

function checkAllFeatures(chunks: readonly TrackChunk[], report: Report): void {
  const bumps: Bump[] = [];
  const props: Prop[] = [];
  const bumpAt: number[] = [];
  const propAt: number[] = [];
  for (const chunk of chunks) {
    bumps.push(...chunk.bumps);
    props.push(...chunk.props);
    bumpAt.push(...bumpDists(chunk));
    propAt.push(...propDists(chunk));
  }
  checkSpacing(bumpAt, CHUNK_RULES.bumpSpacing, 'bumps too close together', report);
  checkSpacing(propAt, RULES.propSpacing, 'props too close together', report);
  checkBumpsClearOfProps(bumps, props, report);
}

/**
 * Validates every chunk of a run in driving order, each against the one before it, and then the rules that span
 * the whole run: the road never meets itself anywhere, and no chunk's scenery crowds any other chunk's road.
 * Per-chunk failures are prefixed with the chunk's index.
 */
export function validateChunkSequence(chunks: readonly TrackChunk[]): ValidationResult {
  const errors: string[] = [];
  let sane = true;
  chunks.forEach((chunk, n) => {
    const verdict = validateChunk(chunk, n > 0 ? chunks[n - 1] : null);
    for (const error of verdict.errors) errors.push(`chunk ${chunk.index}: ${error}`);
    sane = sane && isSane(chunk);
  });
  if (sane && chunks.length > 1) {
    const report = new Report();
    const road = wholeRoad(chunks);
    checkEdgeCrossings(road, report);
    checkRoadOverlap(road.path, 0, report);
    checkAllDecor(chunks, report);
    checkAllFeatures(chunks, report);
    for (const error of report.result().errors) errors.push(`run: ${error}`);
  }
  return { ok: errors.length === 0, errors };
}
