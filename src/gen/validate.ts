/**
 * The safety net for generated levels: every rule the generator promises is checked again here from the finished
 * level alone, without knowing how it was built. Also holds the small geometry toolkit the generators share.
 *
 * Levels are 2.5D: roads climb and drop, pass over and under each other, and some raised edges are open drops. So
 * "is this on the road" is answered from the road footprint and heights (RoadIndex), never from a closed wall loop.
 */

import { cos, sin } from '../core/fixedMath';
import type { DecorBlock, Gate, Level, Pose, Prop, Segment, ValidationResult, Vec2, Wall } from '../types';
import { CROSSING_CLEARANCE, MAX_GRADE, TERRAIN_Y, WALL_HEIGHT } from '../types';
import { BEND_GRADE, DECK_THICKNESS, RAISED_HEIGHT, RoadIndex, bumpsAlong, edgeOverOtherRoad } from './road3d';
import type { RoadHit } from './road3d';

/** The promises a level makes to the car, the camera and the player. The generator aims inside these limits. */
export const RULES = {
  minHalfWidth: 7.5,
  minPathStep: 1,
  maxPathStep: 5,
  minLength: 600,
  maxLength: 1400,
  /** Path points further apart than this along the road must also be apart in space ... */
  overlapPathGap: 40,
  /** ... by the sum of their half widths plus this margin, unless one passes CROSSING_CLEARANCE over the other. */
  overlapMargin: 3,
  startWallClearance: 6,
  /** How far the closed end behind the start reaches back, m. */
  startCap: 14,
  /**
   * Clear road straight on beyond the goal line. A car crossing the line at top speed (about 42 m/s) brakes to a
   * stop in just under 59 m, nose included.
   */
  goalRunOff: 60,
  /** How far the walled run-off beyond the goal reaches, m: the run-off plus room for the nose of the car. */
  goalCap: 64,
  checkpointEndClearance: 60,
  /** Free width required on at least one side of every pillar. */
  propCorridor: 7.5,
  propSpacing: 40,
  propStartClearance: 50,
  propGateClearance: 12,
  /** A block this close to the road hides the car from the fixed camera, so height is tied to clearance. */
  decorMinClearance: 4,
  decorHeightPerClearance: 0.9,
  decorMinHeight: 3,
  decorMaxHeight: 70,
  decorMinSize: 6,
  decorMaxSize: 22,
  decorHues: 6,
  // ---- heights ----
  maxGrade: MAX_GRADE,
  bendGrade: BEND_GRADE,
  /** Grades near the start and the goal ... */
  endGrade: BEND_GRADE,
  /** ... within this distance of them, m. */
  gentleEnd: 50,
  /** The first and last this many metres are level. */
  levelEnd: 20,
  /** Largest change of grade per metre (crest and dip sharpness). */
  maxGradeChange: 0.0125,
  /**
   * None of these may be this close (centreline) to the heart of a crossing, where one road's centreline is within
   * the other's half width: the start, the goal, gates, bumps, pillars, open edges.
   */
  crossingKeepOut: 30,
  /** Widest road a crossing may be built on (no crossing in a plaza). */
  crossingMaxHalfWidth: 13.5,
  // ---- open edges ----
  raisedHeight: RAISED_HEIGHT,
  openMinRun: 25,
  openMaxRun: 125,
  openGateClearance: 40,
  openCrossingClearance: 30,
  openPropClearance: 30,
  // ---- bumps ----
  bumpMinHeight: 0.2,
  bumpMaxHeight: 1.2,
  bumpMinHalfLength: 3,
  bumpMaxHalfLength: 10,
  bumpMaxOverhang: 3.5,
  bumpMaxGrade: 0.035,
  bumpEndClearance: 50,
  bumpGateClearance: 30,
  bumpPropClearance: 30,
  bumpSpacing: 40,
  /** Straight road required either side of a bump beyond its own length, m. */
  bumpStraight: 10,
  // ---- supports ----
  supportClearance: 1,
} as const;

const EPS = 1e-6;
/** Rounding to 1/1024 m moves an emitted half width by at most this much. */
const WIDTH_SLACK = 0.1;
/** Room for lattice rounding on grades. */
const GRADE_SLACK = 0.002;
/** Loose enough for any reasonable tangent estimate, tight enough to catch a misplaced or swapped edge point. */
const EDGE_OFFSET_SLACK = 0.5;
const WALL_JOIN_TOLERANCE = 1e-6;
/** Anything further out is a broken level, and would make the spatial hashes loop over millions of buckets. */
const MAX_COORDINATE = 100_000;
const EDGE_BUCKET = 16;
const WALL_BUCKET = 24;
const BLOCK_BUCKET = 24;
/** The outer run-off rays run this far inside the road edges, about where the side of a car can get to. */
const RUN_OFF_EDGE_INSET = 1;
/** Path points this far either side of a pillar must be in line for the pillar to count as on a straight. */
const STRAIGHT_PROBE = 3;
const STRAIGHT_TOLERANCE = 0.02;
/** Two roads closer in height than this are on the same level. */
const SAME_LEVEL = 2;
/** A thing "stands on" the road when its base is within this of the surface. */
const ON_SURFACE = 0.05;
/** Sine of the turn at a path vertex above which it is part of a bend. */
const BEND_SINE = 1e-3;

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
}

export function distPointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  let t = lengthSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + dx * t);
  const ez = pz - (az + dz * t);
  return Math.sqrt(ex * ex + ez * ez);
}

function distPointBox(px: number, pz: number, minX: number, minZ: number, maxX: number, maxZ: number): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** True when the parameter range of a segment inside one slab [lo, hi] is empty; otherwise narrows `range`. */
function clipSlab(origin: number, delta: number, lo: number, hi: number, range: [number, number]): boolean {
  if (delta === 0) return origin < lo || origin > hi;
  let near = (lo - origin) / delta;
  let far = (hi - origin) / delta;
  if (near > far) {
    const swapped = near;
    near = far;
    far = swapped;
  }
  if (near > range[0]) range[0] = near;
  if (far < range[1]) range[1] = far;
  return range[0] > range[1];
}

const clipRange: [number, number] = [0, 1];

function segmentHitsBox(s: Segment, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  clipRange[0] = 0;
  clipRange[1] = 1;
  if (clipSlab(s.ax, s.bx - s.ax, minX, maxX, clipRange)) return false;
  return !clipSlab(s.az, s.bz - s.az, minZ, maxZ, clipRange);
}

/** Distance between a segment and a filled axis-aligned box; 0 when they touch. */
export function distSegmentBox(s: Segment, minX: number, minZ: number, maxX: number, maxZ: number): number {
  if (segmentHitsBox(s, minX, minZ, maxX, maxZ)) return 0;
  // Two convex shapes that do not touch are closest at a corner of one of them.
  return Math.min(
    distPointBox(s.ax, s.az, minX, minZ, maxX, maxZ),
    distPointBox(s.bx, s.bz, minX, minZ, maxX, maxZ),
    distPointSegment(minX, minZ, s.ax, s.az, s.bx, s.bz),
    distPointSegment(maxX, minZ, s.ax, s.az, s.bx, s.bz),
    distPointSegment(minX, maxZ, s.ax, s.az, s.bx, s.bz),
    distPointSegment(maxX, maxZ, s.ax, s.az, s.bx, s.bz),
  );
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function withinSpan(s: Segment, px: number, pz: number): boolean {
  return (
    px >= Math.min(s.ax, s.bx) && px <= Math.max(s.ax, s.bx) && pz >= Math.min(s.az, s.bz) && pz <= Math.max(s.az, s.bz)
  );
}

/** True when two segments cross, overlap or merely touch. */
export function segmentsTouch(p: Segment, q: Segment): boolean {
  const d1 = orient(q.ax, q.az, q.bx, q.bz, p.ax, p.az);
  const d2 = orient(q.ax, q.az, q.bx, q.bz, p.bx, p.bz);
  const d3 = orient(p.ax, p.az, p.bx, p.bz, q.ax, q.az);
  const d4 = orient(p.ax, p.az, p.bx, p.bz, q.bx, q.bz);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    (d1 === 0 && withinSpan(q, p.ax, p.az)) ||
    (d2 === 0 && withinSpan(q, p.bx, p.bz)) ||
    (d3 === 0 && withinSpan(p, q.ax, q.az)) ||
    (d4 === 0 && withinSpan(p, q.bx, q.bz))
  );
}

/** Even-odd test against a closed wall loop: counts walls crossed by a ray towards +x. */
export function insideWalls(walls: readonly Segment[], px: number, pz: number): boolean {
  let inside = false;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (w.az > pz === w.bz > pz) continue;
    if (px < w.ax + ((pz - w.az) / (w.bz - w.az)) * (w.bx - w.ax)) inside = !inside;
  }
  return inside;
}

/** True when (x, z) lies inside the convex quad a-b-c-d (either winding). */
export function insideQuad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, x: number, z: number): boolean {
  const corners = [a, b, c, d];
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const p = corners[k];
    const q = corners[(k + 1) & 3];
    const cross = (q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

const KEY_OFFSET = 1 << 15;
const KEY_SPAN = 1 << 16;

/** Uniform grid of buckets holding integer ids by bounding box. */
export class SpatialHash {
  private readonly buckets = new Map<number, number[]>();
  private readonly bucketSize: number;

  constructor(bucketSize: number) {
    this.bucketSize = bucketSize;
  }

  insert(id: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const size = this.bucketSize;
    const lastX = Math.floor(maxX / size);
    const lastZ = Math.floor(maxZ / size);
    for (let ix = Math.floor(minX / size); ix <= lastX; ix++) {
      for (let iz = Math.floor(minZ / size); iz <= lastZ; iz++) {
        const key = (ix + KEY_OFFSET) * KEY_SPAN + (iz + KEY_OFFSET);
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(id);
        else this.buckets.set(key, [id]);
      }
    }
  }

  /**
   * Refills `out` with the ids of every bucket the box touches. An id whose own box spans several buckets
   * appears once per bucket.
   */
  collect(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const size = this.bucketSize;
    const lastX = Math.floor(maxX / size);
    const lastZ = Math.floor(maxZ / size);
    for (let ix = Math.floor(minX / size); ix <= lastX; ix++) {
      for (let iz = Math.floor(minZ / size); iz <= lastZ; iz++) {
        const bucket = this.buckets.get((ix + KEY_OFFSET) * KEY_SPAN + (iz + KEY_OFFSET));
        if (bucket) for (let k = 0; k < bucket.length; k++) out.push(bucket[k]);
      }
    }
    return out;
  }
}

function insertSegments(hash: SpatialHash, segments: readonly Segment[]): void {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.az, s.bz), Math.max(s.ax, s.bx), Math.max(s.az, s.bz));
  }
}

/** Answers "how far is this box from the nearest wall" without scanning every wall. */
export class WallIndex {
  private readonly walls: readonly Segment[];
  private readonly hash = new SpatialHash(WALL_BUCKET);
  private readonly scratch: number[] = [];

  constructor(walls: readonly Segment[]) {
    this.walls = walls;
    insertSegments(this.hash, walls);
  }

  /** Distance from the box to the nearest wall, or `limit` when no wall is that close. */
  clearance(minX: number, minZ: number, maxX: number, maxZ: number, limit: number): number {
    const near = this.hash.collect(minX - limit, minZ - limit, maxX + limit, maxZ + limit, this.scratch);
    let best = limit;
    for (let k = 0; k < near.length; k++) {
      const d = distSegmentBox(this.walls[near[k]], minX, minZ, maxX, maxZ);
      if (d < best) best = d;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------------

/** Collects failures per rule: the first offender is spelled out, the rest are counted. */
export class Report {
  private readonly first = new Map<string, string>();
  private readonly extra = new Map<string, number>();

  add(rule: string, detail: string): void {
    if (this.first.has(rule)) this.extra.set(rule, (this.extra.get(rule) ?? 0) + 1);
    else this.first.set(rule, detail);
  }

  get clean(): boolean {
    return this.first.size === 0;
  }

  result(): ValidationResult {
    const errors: string[] = [];
    for (const [rule, detail] of this.first) {
      const more = this.extra.get(rule);
      errors.push(more ? `${rule}: ${detail} (and ${more} more)` : `${rule}: ${detail}`);
    }
    return { ok: errors.length === 0, errors };
  }
}

export function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared facts about a level, worked out once
// ---------------------------------------------------------------------------------------------------------------

interface Facts {
  level: Level;
  index: RoadIndex;
  /** Per path vertex: part of a bend (the road turns there). */
  bendVertex: boolean[];
  /** Per segment i..i+1: both ends are bend vertices. */
  bendSegment: boolean[];
  /** Centreline distances of the path points at the heart of every place the road passes over or under itself. */
  crossingDists: number[];
  hits: RoadHit[];
}

function makeFacts(level: Level): Facts {
  const path = level.path;
  const n = path.length;
  const bendVertex: boolean[] = new Array<boolean>(n).fill(false);
  for (let i = 1; i + 1 < n; i++) {
    const ax = path[i].x - path[i - 1].x;
    const az = path[i].z - path[i - 1].z;
    const bx = path[i + 1].x - path[i].x;
    const bz = path[i + 1].z - path[i].z;
    const lengths = Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
    bendVertex[i] = lengths > 0 && Math.abs(ax * bz - az * bx) / lengths > BEND_SINE;
  }
  const bendSegment: boolean[] = new Array<boolean>(n).fill(false);
  for (let i = 0; i + 1 < n; i++) bendSegment[i] = bendVertex[i] && bendVertex[i + 1];
  const index = new RoadIndex();
  index.add(path);
  return { level, index, bendVertex, bendSegment, crossingDists: [], hits: [] };
}

/** The hit on a road surface within `tolerance` of height `y` nearest the centreline at (x, z), or null. */
function hitAtLevel(facts: Facts, x: number, z: number, y: number, tolerance: number, margin = 0): RoadHit | null {
  const hits = facts.index.query(x, z, margin, facts.hits);
  let best: RoadHit | null = null;
  for (let k = 0; k < hits.length; k++) {
    if (Math.abs(hits[k].y - y) > tolerance) continue;
    if (!best || hits[k].offset < best.offset) best = hits[k];
  }
  return best ? { ...best } : null;
}

function nearCrossing(facts: Facts, dist: number, clearance: number): number {
  let best = Infinity;
  for (const c of facts.crossingDists) best = Math.min(best, Math.abs(c - dist));
  return best < clearance ? best : -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

function checkShape(level: Level, report: Report): void {
  const n = level.path.length;
  if (n < 2) report.add('path too short', `${n} points`);
  if (level.left.length !== n || level.right.length !== n) {
    report.add('edge arrays differ from path', `path ${n}, left ${level.left.length}, right ${level.right.length}`);
  }
  if (level.leftOpen.length !== n || level.rightOpen.length !== n) {
    report.add(
      'open-edge arrays differ from path',
      `path ${n}, leftOpen ${level.leftOpen.length}, rightOpen ${level.rightOpen.length}`,
    );
  }
  if (level.walls.length < 3) report.add('too few walls', `${level.walls.length} segments`);
}

function checkNumbers(level: Level, report: Report): void {
  const check = (v: number, group: string, index: number): void => {
    if (!Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) report.add('bad number', `${group}[${index}] has ${v}`);
  };
  const checkPose = (pose: Pose, group: string, index: number): void => {
    check(pose.x, group, index);
    check(pose.z, group, index);
    check(pose.heading, group, index);
    check(pose.y ?? 0, group, index);
  };
  const checkGate = (gate: Gate, group: string, index: number): void => {
    for (const v of [gate.ax, gate.az, gate.bx, gate.bz, gate.pathIndex, gate.y]) check(v, group, index);
    checkPose(gate.respawn, group, index);
  };
  level.path.forEach((p, i) => {
    for (const v of [p.x, p.z, p.y, p.halfWidth, p.dist]) check(v, 'path', i);
  });
  level.left.forEach((p, i) => {
    check(p.x, 'left', i);
    check(p.z, 'left', i);
  });
  level.right.forEach((p, i) => {
    check(p.x, 'right', i);
    check(p.z, 'right', i);
  });
  level.walls.forEach((w, i) => {
    for (const v of [w.ax, w.az, w.bx, w.bz, w.ya, w.yb]) check(v, 'walls', i);
  });
  level.props.forEach((p, i) => {
    for (const v of [p.x, p.z, p.y, p.radius, p.height, p.hue]) check(v, 'props', i);
  });
  level.bumps.forEach((b, i) => {
    for (const v of [b.x, b.z, b.y, b.dirX, b.dirZ, b.halfLength, b.halfWidth, b.height]) check(v, 'bumps', i);
  });
  level.supports.forEach((s, i) => {
    for (const v of [s.x, s.z, s.top, s.radius]) check(v, 'supports', i);
  });
  level.decor.forEach((b, i) => {
    for (const v of [b.x, b.z, b.w, b.d, b.h, b.hue]) check(v, 'decor', i);
  });
  checkPose(level.start, 'start', 0);
  level.checkpoints.forEach((gate, i) => checkGate(gate, 'checkpoints', i));
  checkGate(level.goal, 'goal', 0);
  const b = level.bounds;
  [b.minX, b.minZ, b.maxX, b.maxZ, b.minY, b.maxY].forEach((v, i) => check(v, 'bounds', i));
  check(level.length, 'length', 0);
}

function checkPath(level: Level, report: Report): void {
  const path = level.path;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.halfWidth < RULES.minHalfWidth - WIDTH_SLACK) {
      report.add('road too narrow', `path[${i}] half width ${fmt(p.halfWidth)} m`);
    }
    if (p.y < -EPS) report.add('road below the city', `path[${i}] at height ${fmt(p.y)} m`);
    if (i === 0) continue;
    const prev = path[i - 1];
    const step = distance(prev.x, prev.z, p.x, p.z);
    if (step < RULES.minPathStep || step > RULES.maxPathStep) {
      report.add('path spacing outside 1..5 m', `path[${i - 1}] to path[${i}] is ${fmt(step)} m`);
    }
    if (!(p.dist > prev.dist)) report.add('path dist not increasing', `path[${i}]`);
  }
  const travelled = path[path.length - 1].dist;
  if (Math.abs(level.length - travelled) > EPS) {
    report.add('length differs from final dist', `${fmt(level.length)} vs ${fmt(travelled)}`);
  }
  if (level.length < RULES.minLength || level.length > RULES.maxLength) {
    report.add(`length outside ${RULES.minLength}..${RULES.maxLength} m`, `${fmt(level.length)} m`);
  }
}

/** Grades, crest sharpness and the level ends. */
function checkHeights(facts: Facts, report: Report): void {
  const { path, length } = facts.level;
  const first = path[0];
  const last = path[path.length - 1];
  let previous = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const run = b.dist - a.dist;
    if (!(run > 0)) continue;
    const grade = (b.y - a.y) / run;
    const steep = Math.abs(grade);
    if (steep > RULES.maxGrade + GRADE_SLACK) report.add('road too steep', `path[${i}] grade ${fmt(grade * 100)}%`);
    if (facts.bendSegment[i - 1] && steep > RULES.bendGrade + GRADE_SLACK) {
      report.add('road too steep in a bend', `path[${i}] grade ${fmt(grade * 100)}%`);
    }
    if ((b.dist <= RULES.gentleEnd || a.dist >= length - RULES.gentleEnd) && steep > RULES.endGrade + GRADE_SLACK) {
      report.add('road too steep near the start or goal', `path[${i}] grade ${fmt(grade * 100)}%`);
    }
    if (i >= 2) {
      const change = Math.abs(grade - previous) / ((b.dist - path[i - 2].dist) / 2);
      if (change > RULES.maxGradeChange) {
        report.add('grade changes too sharply', `at path[${i - 1}] by ${fmt(change * 1000)} per mille per metre`);
      }
    }
    previous = grade;
  }
  for (const p of path) {
    if (p.dist <= RULES.levelEnd && Math.abs(p.y - first.y) > 1e-3) report.add('start is not level', fmt(p.dist));
    if (length - p.dist <= RULES.levelEnd && Math.abs(p.y - last.y) > 1e-3) report.add('goal is not level', fmt(p.dist));
  }
}

/** Each edge point must sit one half width to its own side of the centreline. */
function checkEdgeOffsets(level: Level, report: Report): void {
  const { path, left, right } = level;
  const last = path.length - 1;
  for (let i = 0; i <= last; i++) {
    const a = path[i > 0 ? i - 1 : 0];
    const b = path[i < last ? i + 1 : last];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const length = Math.sqrt(tx * tx + tz * tz);
    if (length === 0) continue;
    const p = path[i];
    // Right of the travel direction (tx, tz) is (-tz, tx).
    const rx = (-tz / length) * p.halfWidth;
    const rz = (tx / length) * p.halfWidth;
    const offLeft = distance(left[i].x, left[i].z, p.x - rx, p.z - rz);
    const offRight = distance(right[i].x, right[i].z, p.x + rx, p.z + rz);
    if (offLeft > EDGE_OFFSET_SLACK || offRight > EDGE_OFFSET_SLACK) {
      report.add('edge not offset by half width', `index ${i} is off by ${fmt(Math.max(offLeft, offRight))} m`);
    }
  }
}

function polylineSegments(points: readonly Vec2[], into: Segment[]): void {
  for (let i = 0; i + 1 < points.length; i++) {
    into.push({ ax: points[i].x, az: points[i].z, bx: points[i + 1].x, bz: points[i + 1].z });
  }
}

/** Road edges may only cross in plan where one road passes well above the other. */
function checkEdgeCrossings(level: Level, report: Report): void {
  const path = level.path;
  const perSide = path.length - 1;
  const segments: Segment[] = [];
  polylineSegments(level.left, segments);
  polylineSegments(level.right, segments);
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, segments);
  const near: number[] = [];
  const name = (index: number): string => (index < perSide ? `left[${index}]` : `right[${index - perSide}]`);
  const lowY = (s: number): number => Math.min(path[s % perSide].y, path[(s % perSide) + 1].y);
  const highY = (s: number): number => Math.max(path[s % perSide].y, path[(s % perSide) + 1].y);
  const reported = new Set<number>();
  for (let s = 0; s < segments.length; s++) {
    const a = segments[s];
    hash.collect(Math.min(a.ax, a.bx), Math.min(a.az, a.bz), Math.max(a.ax, a.bx), Math.max(a.az, a.bz), near);
    for (let k = 0; k < near.length; k++) {
      const t = near[k];
      const neighbours = t === s + 1 && t !== perSide;
      if (t <= s || neighbours || !segmentsTouch(a, segments[t])) continue;
      const apart = Math.max(lowY(t) - highY(s), lowY(s) - highY(t));
      if (apart >= CROSSING_CLEARANCE - 0.5) continue;
      const pair = s * segments.length + t;
      if (reported.has(pair)) continue;
      reported.add(pair);
      report.add('road edges intersect', `${name(s)} and ${name(t)}`);
    }
  }
}

function isStraightAround(level: Level, index: number, probe = STRAIGHT_PROBE): boolean {
  const path = level.path;
  const from = Math.max(index - probe, 0);
  const to = Math.min(index + probe, path.length - 1);
  const a = path[from];
  const b = path[to];
  for (let i = from + 1; i < to; i++) {
    if (distPointSegment(path[i].x, path[i].z, a.x, a.z, b.x, b.z) > STRAIGHT_TOLERANCE) return false;
  }
  return true;
}

function directionAt(level: Level, i: number): Vec2 {
  const path = level.path;
  const a = path[Math.max(0, i - 1)];
  const b = path[Math.min(path.length - 1, i + 1)];
  const len = distance(a.x, a.z, b.x, b.z);
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/**
 * A road that doubles back onto itself, or two stretches too close at the same level, or a crossing whose
 * overpass is too low. Records where the road properly passes over or under itself in `facts.crossingDists` and
 * checks those crossings are square, on straights and not in a plaza.
 */
function checkRoadOverlap(facts: Facts, report: Report): void {
  const level = facts.level;
  const path = level.path;
  let widest = 0;
  for (let i = 0; i < path.length; i++) widest = Math.max(widest, path[i].halfWidth);
  const hash = new SpatialHash(Math.max(16, 2 * widest + RULES.overlapMargin));
  for (let i = 0; i < path.length; i++) hash.insert(i, path[i].x, path[i].z, path[i].x, path[i].z);
  const near: number[] = [];
  const crossing = new Set<number>();
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const reach = p.halfWidth + widest + RULES.overlapMargin;
    hash.collect(p.x - reach, p.z - reach, p.x + reach, p.z + reach, near);
    for (let k = 0; k < near.length; k++) {
      const j = near[k];
      const q = path[j];
      if (j <= i || q.dist - p.dist <= RULES.overlapPathGap) continue;
      const touching = p.halfWidth + q.halfWidth;
      const apart = distance(p.x, p.z, q.x, q.z);
      if (apart > touching + RULES.overlapMargin) continue;
      const dy = Math.abs(p.y - q.y);
      if (dy >= CROSSING_CLEARANCE - EPS) {
        if (apart < touching) {
          crossing.add(i);
          crossing.add(j);
        }
        continue;
      }
      const where = `path[${i}] and path[${j}] are ${fmt(apart)} m apart and ${fmt(dy)} m apart in height`;
      if (dy < SAME_LEVEL) report.add('road runs into itself', `${where}, need ${fmt(touching + RULES.overlapMargin)}`);
      else report.add('crossing too low', `${where}, need ${CROSSING_CLEARANCE} m`);
    }
  }
  // The heart of each crossing, where one road's centre is within the other's half width: straight on both roads,
  // at right angles, and not in a plaza. Keep-out distances are measured from here.
  const heart = new Set<number>();
  for (const i of crossing) {
    for (const j of crossing) {
      if (j <= i || path[j].dist - path[i].dist <= RULES.overlapPathGap) continue;
      if (distance(path[i].x, path[i].z, path[j].x, path[j].z) > Math.max(path[i].halfWidth, path[j].halfWidth)) {
        continue;
      }
      heart.add(i);
      heart.add(j);
      for (const k of [i, j]) {
        if (facts.bendVertex[k] || path[k].halfWidth > RULES.crossingMaxHalfWidth) {
          report.add('crossing in a bend or plaza', `path[${k}]`);
        }
      }
      const a = directionAt(level, i);
      const b = directionAt(level, j);
      if (Math.abs(a.x * b.x + a.z * b.z) > 0.1) report.add('crossing not square', `path[${i}] and path[${j}]`);
    }
  }
  for (const i of heart) facts.crossingDists.push(path[i].dist);
  facts.crossingDists.sort((a, b) => a - b);
}

function wallKey(ax: number, az: number, bx: number, bz: number): string {
  return `${ax},${az},${bx},${bz}`;
}

/**
 * Every edge segment that is not open has exactly its own barrier at the road's height, every open one has none,
 * and every other wall is part of the closed end behind the start or the walled run-off beyond the goal, both of
 * which join the left edge to the right edge.
 */
function checkWalls(level: Level, report: Report): void {
  const { path, walls } = level;
  const n = path.length;
  const byEnds = new Map<string, number>();
  walls.forEach((w, i) => {
    if (Math.abs(w.ax - w.bx) <= WALL_JOIN_TOLERANCE && Math.abs(w.az - w.bz) <= WALL_JOIN_TOLERANCE) {
      report.add('wall has no length', `walls[${i}]`);
    }
    byEnds.set(wallKey(w.ax, w.az, w.bx, w.bz), i);
    byEnds.set(wallKey(w.bx, w.bz, w.ax, w.az), i);
  });
  const owned: boolean[] = new Array<boolean>(walls.length).fill(false);
  const sides: [readonly Vec2[], readonly boolean[], string][] = [
    [level.left, level.leftOpen, 'left'],
    [level.right, level.rightOpen, 'right'],
  ];
  for (const [edge, open, name] of sides) {
    for (let i = 0; i + 1 < n; i++) {
      const a = edge[i];
      const b = edge[i + 1];
      const found = byEnds.get(wallKey(a.x, a.z, b.x, b.z));
      if (open[i]) {
        if (found !== undefined) report.add('open edge has a wall', `${name}[${i}] to ${name}[${i + 1}]`);
        continue;
      }
      if (found === undefined) {
        report.add('road edge has no wall', `${name}[${i}] to ${name}[${i + 1}]`);
        continue;
      }
      owned[found] = true;
      const w = walls[found];
      const forward = w.ax === a.x && w.az === a.z;
      const ya = forward ? w.ya : w.yb;
      const yb = forward ? w.yb : w.ya;
      if (Math.abs(ya - path[i].y) > EPS || Math.abs(yb - path[i + 1].y) > EPS) {
        report.add('wall height differs from the road', `walls[${found}] on ${name}[${i}]`);
      }
    }
  }
  // The remaining walls close the two ends.
  const ends = [
    { at: path[0], reach: RULES.startCap + path[0].halfWidth + 1, from: level.left[0], to: level.right[0], name: 'start' },
    {
      at: path[n - 1],
      reach: RULES.goalCap + path[n - 1].halfWidth + 1,
      from: level.left[n - 1],
      to: level.right[n - 1],
      name: 'goal',
    },
  ];
  const capOf: number[] = new Array<number>(walls.length).fill(-1);
  walls.forEach((w, i) => {
    if (owned[i]) return;
    for (let e = 0; e < 2 && capOf[i] < 0; e++) {
      const { at, reach } = ends[e];
      const near = distance(w.ax, w.az, at.x, at.z) <= reach && distance(w.bx, w.bz, at.x, at.z) <= reach;
      if (near && Math.abs(w.ya - at.y) <= EPS && Math.abs(w.yb - at.y) <= EPS) capOf[i] = e;
    }
    if (capOf[i] < 0) report.add('wall belongs to no edge', `walls[${i}]`);
  });
  ends.forEach((end, e) => {
    // Walk the cap walls from the left edge's end point; it must arrive at the right edge's.
    let x = end.from.x;
    let z = end.from.z;
    const used = new Set<number>();
    let arrived = false;
    for (let step = 0; step <= walls.length && !arrived; step++) {
      let next = -1;
      for (let i = 0; i < walls.length && next < 0; i++) {
        if (capOf[i] !== e || used.has(i)) continue;
        const w = walls[i];
        if ((w.ax === x && w.az === z) || (w.bx === x && w.bz === z)) next = i;
      }
      if (next < 0) break;
      used.add(next);
      const w = walls[next];
      if (w.ax === x && w.az === z) {
        x = w.bx;
        z = w.bz;
      } else {
        x = w.ax;
        z = w.az;
      }
      arrived = x === end.to.x && z === end.to.z;
    }
    if (!arrived) report.add(`${end.name} is not closed off`, 'no chain of walls joins its left and right edges');
  });
}

function wallHeights(w: Wall): [number, number] {
  return [Math.min(w.ya, w.yb), Math.max(w.ya, w.yb) + WALL_HEIGHT];
}

/** Walls may only cross in plan where they stand at different heights. */
function checkWallCrossings(level: Level, report: Report): void {
  const walls = level.walls;
  const hash = new SpatialHash(WALL_BUCKET);
  insertSegments(hash, walls);
  const near: number[] = [];
  const reported = new Set<number>();
  const shares = (p: Segment, q: Segment): boolean => {
    const same = (ax: number, az: number, bx: number, bz: number): boolean =>
      Math.abs(ax - bx) <= WALL_JOIN_TOLERANCE && Math.abs(az - bz) <= WALL_JOIN_TOLERANCE;
    return (
      same(p.ax, p.az, q.ax, q.az) ||
      same(p.ax, p.az, q.bx, q.bz) ||
      same(p.bx, p.bz, q.ax, q.az) ||
      same(p.bx, p.bz, q.bx, q.bz)
    );
  };
  for (let s = 0; s < walls.length; s++) {
    const a = walls[s];
    hash.collect(Math.min(a.ax, a.bx), Math.min(a.az, a.bz), Math.max(a.ax, a.bx), Math.max(a.az, a.bz), near);
    const [aLo, aHi] = wallHeights(a);
    for (let k = 0; k < near.length; k++) {
      const t = near[k];
      if (t <= s || reported.has(s * walls.length + t)) continue;
      const [bLo, bHi] = wallHeights(walls[t]);
      if (aLo > bHi || bLo > aHi) continue;
      if (shares(a, walls[t]) || !segmentsTouch(a, walls[t])) continue;
      reported.add(s * walls.length + t);
      report.add('walls intersect', `walls[${s}] and walls[${t}]`);
    }
  }
}

/** No wall may stand across the drivable road at its own height. */
function checkWallsCutRoad(facts: Facts, report: Report): void {
  facts.level.walls.forEach((w, i) => {
    for (const share of [0.25, 0.5, 0.75]) {
      const x = w.ax + (w.bx - w.ax) * share;
      const z = w.az + (w.bz - w.az) * share;
      const y = w.ya + (w.yb - w.ya) * share;
      const hits = facts.index.query(x, z, 0, facts.hits);
      for (let k = 0; k < hits.length; k++) {
        const hit = hits[k];
        // Only beside a segment, not off its rounded ends, where a widening road reaches back over its own edge.
        if (hit.t <= 0 || hit.t >= 1) continue;
        if (hit.offset < hit.halfWidth - EDGE_OFFSET_SLACK && Math.abs(hit.y - y) < SAME_LEVEL) {
          report.add('wall cuts across the road', `walls[${i}] near path[${hit.index}]`);
          return;
        }
      }
    }
  });
}

/** Open stretches: raised, single-sided in bends, away from gates and crossings, over the city floor only. */
function checkOpenEdges(facts: Facts, report: Report): void {
  const level = facts.level;
  const { path, length } = level;
  const n = path.length;
  const gates = [...level.checkpoints, level.goal].map((gate) => path[gate.pathIndex]?.dist ?? 0);
  const sides: [readonly Vec2[], readonly boolean[], readonly boolean[], string][] = [
    [level.left, level.leftOpen, level.rightOpen, 'left'],
    [level.right, level.rightOpen, level.leftOpen, 'right'],
  ];
  const scratch: RoadHit[] = [];
  const bumps = bumpsAlong(path, level.bumps);
  for (const [edge, open, other, name] of sides) {
    let runStart = -1;
    for (let i = 0; i + 1 < n; i++) {
      if (open[i]) {
        const a = path[i];
        const b = path[i + 1];
        const label = `${name}[${i}]`;
        if (a.y < RULES.raisedHeight - EPS || b.y < RULES.raisedHeight - EPS) report.add('open edge on low road', label);
        if (facts.bendSegment[i] && other[i]) report.add('open on both sides in a bend', label);
        if (a.dist < RULES.openGateClearance || b.dist > length - RULES.openGateClearance) {
          report.add('open edge near the start or goal', label);
        }
        for (const g of gates) {
          if (b.dist > g - RULES.openGateClearance && a.dist < g + RULES.openGateClearance) {
            report.add('open edge near a gate', `${label} is within ${RULES.openGateClearance} m of a gate`);
          }
        }
        for (const c of facts.crossingDists) {
          if (b.dist > c - RULES.openCrossingClearance && a.dist < c + RULES.openCrossingClearance) {
            report.add('open edge at a crossing', label);
          }
        }
        if (edgeOverOtherRoad(facts.index, 0, path, edge, i, RULES.overlapPathGap, scratch, bumps)) {
          report.add('open edge above another road', label);
        }
        if (runStart < 0) runStart = i;
      }
      const ends = runStart >= 0 && (!open[i] || i + 2 === n);
      if (ends) {
        const stop = open[i] ? i + 1 : i;
        const run = path[stop].dist - path[runStart].dist;
        if (run < RULES.openMinRun - EPS) report.add('open stretch too short', `${name}[${runStart}] runs ${fmt(run)} m`);
        if (run > RULES.openMaxRun + EPS) report.add('open stretch too long', `${name}[${runStart}] runs ${fmt(run)} m`);
        runStart = -1;
      }
    }
  }
}

function nearestWallAtLevel(walls: readonly Wall[], x: number, z: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const [lo, hi] = wallHeights(w);
    if (lo > y + SAME_LEVEL || hi < y - SAME_LEVEL) continue;
    const d = distPointSegment(x, z, w.ax, w.az, w.bx, w.bz);
    if (d < best) best = d;
  }
  return best;
}

function checkStart(facts: Facts, report: Report): void {
  const { start, path } = facts.level;
  const y = start.y ?? 0;
  if (Math.abs(y - path[0].y) > ON_SURFACE) report.add('start height differs from the road', fmt(y));
  if (!hitAtLevel(facts, start.x, start.z, y, ON_SURFACE)) {
    report.add('start is outside the road', `(${fmt(start.x)}, ${fmt(start.z)})`);
    return;
  }
  const room = nearestWallAtLevel(facts.level.walls, start.x, start.z, y);
  if (room < RULES.startWallClearance) report.add('start too close to a wall', `${fmt(room)} m, need 6`);
  if (nearCrossing(facts, 0, RULES.crossingKeepOut) >= 0) report.add('start too close to a crossing', '');
}

function checkGates(facts: Facts, report: Report): void {
  const level = facts.level;
  const last = level.path.length - 1;
  let previous = 0;
  const checkGate = (gate: Gate, label: string): void => {
    const index = gate.pathIndex;
    if (!Number.isInteger(index) || index < 1 || index > last) {
      report.add('gate pathIndex out of range', `${label} has ${index}`);
      return;
    }
    if (index <= previous) report.add('gates out of order', `${label} at ${index} follows a gate at ${previous}`);
    previous = index;
    const p = level.path[index];
    if (Math.abs(gate.y - p.y) > EPS) report.add('gate height differs from the road', label);
    const y = gate.respawn.y ?? 0;
    if (!hitAtLevel(facts, gate.respawn.x, gate.respawn.z, y, ON_SURFACE)) {
      report.add('respawn is off the road', `${label} at (${fmt(gate.respawn.x)}, ${fmt(gate.respawn.z)})`);
    }
    if (nearCrossing(facts, p.dist, RULES.crossingKeepOut) >= 0) report.add('gate too close to a crossing', label);
  };
  level.checkpoints.forEach((gate, i) => {
    checkGate(gate, `checkpoints[${i}]`);
    const point = level.path[gate.pathIndex];
    if (!point) return;
    const room = Math.min(point.dist, level.length - point.dist);
    if (room < RULES.checkpointEndClearance) {
      report.add('checkpoint too close to start or goal', `checkpoints[${i}] is ${fmt(room)} m away, need 60`);
    }
  });
  checkGate(level.goal, 'goal');
}

/** True when an open edge segment lies within `reach` of centreline distance `dist`. */
function openNear(level: Level, dist: number, reach: number): boolean {
  const path = level.path;
  for (let i = 0; i + 1 < path.length; i++) {
    if (!level.leftOpen[i] && !level.rightOpen[i]) continue;
    if (path[i + 1].dist > dist - reach && path[i].dist < dist + reach) return true;
  }
  return false;
}

function pathIndexOf(hit: RoadHit): number {
  return hit.t > 0.5 ? hit.index + 1 : hit.index;
}

function checkPropPlacement(facts: Facts, prop: Prop, label: string, report: Report): number {
  const level = facts.level;
  const hit = hitAtLevel(facts, prop.x, prop.z, prop.y, SAME_LEVEL);
  if (!hit || Math.abs(hit.y - prop.y) > ON_SURFACE || hit.offset + prop.radius > hit.halfWidth) {
    report.add('prop is not inside the road', label);
    return hit ? hit.dist : NaN;
  }
  const corridor = hit.halfWidth + hit.offset - prop.radius;
  if (corridor < RULES.propCorridor - EPS) {
    report.add('prop blocks the road', `${label} leaves ${fmt(corridor)} m on its widest side, need 7.5`);
  }
  if (!isStraightAround(level, pathIndexOf(hit))) report.add('prop in a corner', label);
  if (hit.dist < RULES.propStartClearance) {
    report.add('prop too close to the start', `${label} at ${fmt(hit.dist)} m, need 50`);
  }
  for (const gate of [...level.checkpoints, level.goal]) {
    if (Math.abs(gate.y - prop.y) > SAME_LEVEL) continue;
    const room = distPointSegment(prop.x, prop.z, gate.ax, gate.az, gate.bx, gate.bz) - prop.radius;
    if (room < RULES.propGateClearance - EPS) {
      report.add('prop too close to a gate', `${label} is ${fmt(room)} m from the gate at path[${gate.pathIndex}]`);
    }
  }
  if (openNear(level, hit.dist, RULES.openPropClearance)) report.add('prop beside an open edge', label);
  if (nearCrossing(facts, hit.dist, RULES.crossingKeepOut) >= 0) report.add('prop too close to a crossing', label);
  return hit.dist;
}

function checkProps(facts: Facts, report: Report): number[] {
  const along: number[] = [];
  facts.level.props.forEach((prop, i) => {
    const dist = checkPropPlacement(facts, prop, `props[${i}]`, report);
    if (!Number.isNaN(dist)) along.push(dist);
  });
  along.sort((a, b) => a - b);
  for (let i = 1; i < along.length; i++) {
    if (along[i] - along[i - 1] < RULES.propSpacing - 3) {
      report.add('props too close together', `${fmt(along[i] - along[i - 1])} m apart along the path, need 40`);
    }
  }
  return along;
}

function checkBumps(facts: Facts, propDists: readonly number[], report: Report): void {
  const level = facts.level;
  const { path, length } = level;
  const gates = [...level.checkpoints, level.goal].map((gate) => path[gate.pathIndex]?.dist ?? 0);
  const placed: number[] = [];
  level.bumps.forEach((bump, b) => {
    const label = `bumps[${b}]`;
    if (bump.height < RULES.bumpMinHeight || bump.height > RULES.bumpMaxHeight) {
      report.add('bump height out of range', `${label} is ${fmt(bump.height)} m`);
    }
    if (bump.halfLength < RULES.bumpMinHalfLength || bump.halfLength > RULES.bumpMaxHalfLength) {
      report.add('bump length out of range', `${label} half length ${fmt(bump.halfLength)} m`);
    }
    const hit = hitAtLevel(facts, bump.x, bump.z, bump.y, SAME_LEVEL);
    if (!hit || Math.abs(hit.y - bump.y) > ON_SURFACE) {
      report.add('bump is not on the road', label);
      return;
    }
    const dir = directionAt(level, pathIndexOf(hit));
    const unit = Math.abs(bump.dirX * bump.dirX + bump.dirZ * bump.dirZ - 1) < 1e-6;
    if (!unit || Math.abs(bump.dirX * dir.z - bump.dirZ * dir.x) > 0.05 || bump.dirX * dir.x + bump.dirZ * dir.z < 0) {
      report.add('bump not square to the road', label);
    }
    // Straight, nearly level road under and around the ridge, and the ridge spans the whole width.
    const reach = bump.halfLength + RULES.bumpStraight;
    let widest = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < path.length; i++) {
      const d = path[i].dist - hit.dist;
      if (d < -reach || d > reach) continue;
      if (first < 0) first = i;
      last = i;
      if (Math.abs(d) <= bump.halfLength + 3) widest = Math.max(widest, path[i].halfWidth);
      if (i > first) {
        const grade = (path[i].y - path[i - 1].y) / (path[i].dist - path[i - 1].dist);
        if (Math.abs(grade) > RULES.bumpMaxGrade) report.add('bump on a slope', label);
      }
    }
    if (first >= 0) {
      const a = path[first];
      const z = path[last];
      for (let i = first + 1; i < last; i++) {
        if (distPointSegment(path[i].x, path[i].z, a.x, a.z, z.x, z.z) > STRAIGHT_TOLERANCE) {
          report.add('bump in a corner', label);
          break;
        }
      }
    }
    if (bump.halfWidth < widest - EPS || bump.halfWidth > widest + RULES.bumpMaxOverhang) {
      report.add('bump does not span the road', `${label} half width ${fmt(bump.halfWidth)} on ${fmt(widest)} m road`);
    }
    if (hit.dist < RULES.bumpEndClearance || length - hit.dist < RULES.bumpEndClearance) {
      report.add('bump too close to the start or goal', label);
    }
    for (const g of gates) {
      if (Math.abs(g - hit.dist) < RULES.bumpGateClearance) report.add('bump too close to a gate', label);
    }
    for (const p of propDists) {
      if (Math.abs(p - hit.dist) < RULES.bumpPropClearance) report.add('bump too close to a pillar', label);
    }
    for (const other of placed) {
      if (Math.abs(other - hit.dist) < RULES.bumpSpacing) report.add('bumps too close together', label);
    }
    if (nearCrossing(facts, hit.dist, RULES.crossingKeepOut) >= 0) report.add('bump too close to a crossing', label);
    placed.push(hit.dist);
  });
}

/** Columns hold up a raised road from the city floor and never stand on, or in the footprint of, another road. */
function checkSupports(facts: Facts, report: Report): void {
  const hits: RoadHit[] = [];
  facts.level.supports.forEach((s, i) => {
    const label = `supports[${i}]`;
    if (s.radius <= 0 || s.radius > 3) report.add('support radius out of range', label);
    if (s.top < TERRAIN_Y + 0.5) report.add('support too short', label);
    const deck = s.top + DECK_THICKNESS;
    facts.index.query(s.x, s.z, s.radius + RULES.supportClearance, hits);
    let holder: RoadHit | null = null;
    for (const hit of hits) {
      if (hit.offset <= hit.halfWidth && Math.abs(hit.y - deck) <= ON_SURFACE) holder = hit;
    }
    if (!holder) {
      report.add('support holds up nothing', label);
      return;
    }
    for (const hit of hits) {
      if (Math.abs(hit.dist - holder.dist) > RULES.overlapPathGap) {
        report.add('support stands on a road', `${label} is inside the road at path[${hit.index}]`);
        return;
      }
    }
  });
}

/** True when (x, z) is on any road in plan, or inside the closed end behind the start or the run-off. */
function onRoadArea(facts: Facts, x: number, z: number): boolean {
  if (facts.index.query(x, z, 0, facts.hits).length > 0) return true;
  const { left, right, start, goal } = facts.level;
  const last = left.length - 1;
  const sx = cos(start.heading) * RULES.startCap;
  const sz = sin(start.heading) * RULES.startCap;
  const gx = cos(goal.respawn.heading) * RULES.goalCap;
  const gz = sin(goal.respawn.heading) * RULES.goalCap;
  const back = (p: Vec2, dx: number, dz: number): Vec2 => ({ x: p.x + dx, z: p.z + dz });
  return (
    insideQuad(left[0], right[0], back(right[0], -sx, -sz), back(left[0], -sx, -sz), x, z) ||
    insideQuad(left[last], right[last], back(right[last], gx, gz), back(left[last], gx, gz), x, z)
  );
}

function checkDecorBlock(block: DecorBlock, label: string, facts: Facts, outline: WallIndex, report: Report): void {
  const sizeOk = (v: number): boolean => v >= RULES.decorMinSize && v <= RULES.decorMaxSize;
  if (!sizeOk(block.w) || !sizeOk(block.d)) report.add('decor footprint outside 6..22 m', label);
  if (!Number.isInteger(block.hue) || block.hue < 0 || block.hue >= RULES.decorHues) {
    report.add('decor hue outside 0..5', label);
  }
  if (block.h < RULES.decorMinHeight || block.h > RULES.decorMaxHeight) {
    report.add('decor height outside 3..70 m', `${label} is ${fmt(block.h)} m tall`);
  }
  const needed = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
  const minX = block.x - block.w / 2;
  const minZ = block.z - block.d / 2;
  const clearance = outline.clearance(minX, minZ, minX + block.w, minZ + block.d, needed + 1);
  if (clearance < needed - EPS) {
    report.add(
      'decor too tall or too close to the road',
      `${label} is ${fmt(block.h)} m tall, ${fmt(clearance)} m from the road, needs ${fmt(needed)} m`,
    );
  }
  if (onRoadArea(facts, block.x, block.z)) report.add('decor stands on the road', label);
}

function checkDecorOverlap(decor: readonly DecorBlock[], report: Report): void {
  const hash = new SpatialHash(BLOCK_BUCKET);
  const near: number[] = [];
  const reported = new Set<number>();
  decor.forEach((b, i) => {
    const minX = b.x - b.w / 2;
    const minZ = b.z - b.d / 2;
    hash.collect(minX, minZ, minX + b.w, minZ + b.d, near);
    for (let k = 0; k < near.length; k++) {
      const o = decor[near[k]];
      const apartX = Math.abs(o.x - b.x) - (o.w + b.w) / 2;
      const apartZ = Math.abs(o.z - b.z) - (o.d + b.d) / 2;
      if (apartX >= -EPS || apartZ >= -EPS || reported.has(near[k] * decor.length + i)) continue;
      reported.add(near[k] * decor.length + i);
      report.add('decor blocks overlap', `decor[${near[k]}] and decor[${i}]`);
    }
    hash.insert(i, minX, minZ, minX + b.w, minZ + b.d);
  });
}

function checkDecor(facts: Facts, report: Report): void {
  const level = facts.level;
  // Clearance is measured from every road edge (open or not) and every wall.
  const outline: Segment[] = [...level.walls];
  polylineSegments(level.left, outline);
  polylineSegments(level.right, outline);
  const index = new WallIndex(outline);
  level.decor.forEach((block, i) => checkDecorBlock(block, `decor[${i}]`, facts, index, report));
  checkDecorOverlap(level.decor, report);
}

/** Distance along the ray from (ox, oz) in the unit direction (dx, dz) to a segment, or Infinity when it misses. */
function rayToSegment(ox: number, oz: number, dx: number, dz: number, s: Segment): number {
  const ex = s.bx - s.ax;
  const ez = s.bz - s.az;
  const denom = dx * ez - dz * ex;
  if (denom === 0) return Infinity;
  const t = ((s.ax - ox) * ez - (s.az - oz) * ex) / denom;
  const u = ((s.ax - ox) * dz - (s.az - oz) * dx) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/**
 * The car brakes itself after the finish and must not meet anything while it does. Three rays leave the goal line
 * the way the road is travelling, down the middle and just inside each edge, and all three must be clear of walls
 * and pillars at the goal's level for the whole run-off distance.
 */
function checkGoalRunOff(level: Level, report: Report): void {
  const goal = level.goal;
  const acrossX = goal.bx - goal.ax;
  const acrossZ = goal.bz - goal.az;
  const width = Math.sqrt(acrossX * acrossX + acrossZ * acrossZ);
  if (width === 0) return;
  const dirX = cos(goal.respawn.heading);
  const dirZ = sin(goal.respawn.heading);
  const reach = RULES.goalRunOff;
  const inset = Math.min(RUN_OFF_EDGE_INSET, width / 2) / width;
  for (const share of [0.5, inset, 1 - inset]) {
    const ox = goal.ax + acrossX * share;
    const oz = goal.az + acrossZ * share;
    let clear = Infinity;
    for (let i = 0; i < level.walls.length; i++) {
      const [lo, hi] = wallHeights(level.walls[i]);
      if (lo > goal.y + SAME_LEVEL || hi < goal.y - SAME_LEVEL) continue;
      const t = rayToSegment(ox, oz, dirX, dirZ, level.walls[i]);
      if (t < clear) clear = t;
    }
    if (clear < reach) {
      report.add('run-off beyond the goal is too short', `a wall ${fmt(clear)} m past the line, need ${reach}`);
    }
    for (let i = 0; i < level.props.length; i++) {
      const prop = level.props[i];
      if (Math.abs(prop.y - goal.y) > SAME_LEVEL) continue;
      const d = distPointSegment(prop.x, prop.z, ox, oz, ox + dirX * reach, oz + dirZ * reach);
      if (d < prop.radius) report.add('run-off beyond the goal is blocked', `props[${i}]`);
    }
  }
}

function checkBounds(level: Level, report: Report): void {
  const b = level.bounds;
  const check = (minX: number, minZ: number, maxX: number, maxZ: number, minY: number, maxY: number, label: string) => {
    const outside =
      minX < b.minX - EPS ||
      minZ < b.minZ - EPS ||
      maxX > b.maxX + EPS ||
      maxZ > b.maxZ + EPS ||
      minY < b.minY - EPS ||
      maxY > b.maxY + EPS;
    if (outside) report.add('bounds do not contain everything', label);
  };
  level.path.forEach((p, i) => check(p.x, p.z, p.x, p.z, p.y, p.y, `path[${i}]`));
  level.walls.forEach((w, i) => {
    const [lo, hi] = wallHeights(w);
    check(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz), lo, hi, `walls[${i}]`);
  });
  level.props.forEach((p, i) =>
    check(p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius, p.y, p.y + p.height, `props[${i}]`),
  );
  level.supports.forEach((s, i) =>
    check(s.x - s.radius, s.z - s.radius, s.x + s.radius, s.z + s.radius, TERRAIN_Y, s.top, `supports[${i}]`),
  );
  level.decor.forEach((d, i) =>
    check(d.x - d.w / 2, d.z - d.d / 2, d.x + d.w / 2, d.z + d.d / 2, TERRAIN_Y, TERRAIN_Y + d.h, `decor[${i}]`),
  );
  level.bumps.forEach((d, i) => check(d.x, d.z, d.x, d.z, d.y, d.y + d.height, `bumps[${i}]`));
}

/**
 * Where a level passes over or under itself: the centreline distances of the path points at the heart of every
 * crossing (on both roads), and how many crossings that makes.
 */
export function findCrossings(level: Level): { dists: number[]; count: number } {
  const facts = makeFacts(level);
  checkRoadOverlap(facts, new Report());
  // Each crossing shows up as one cluster of points on each of its two roads.
  let clusters = 0;
  let previous = -Infinity;
  for (const d of facts.crossingDists) {
    if (d - previous > RULES.overlapPathGap) clusters++;
    previous = d;
  }
  return { dists: facts.crossingDists, count: Math.round(clusters / 2) };
}

/** Returns every broken rule as a readable sentence. A level that passes is safe to drive and to render. */
export function validateLevel(level: Level): ValidationResult {
  const report = new Report();
  checkShape(level, report);
  checkNumbers(level, report);
  // The geometric checks index arrays in step and walk spatial grids, so they need sane input.
  if (!report.clean) return report.result();
  const facts = makeFacts(level);
  checkPath(level, report);
  checkHeights(facts, report);
  checkEdgeOffsets(level, report);
  checkEdgeCrossings(level, report);
  checkRoadOverlap(facts, report);
  checkWalls(level, report);
  checkWallCrossings(level, report);
  checkWallsCutRoad(facts, report);
  checkOpenEdges(facts, report);
  checkStart(facts, report);
  checkGates(facts, report);
  const propDists = checkProps(facts, report);
  checkBumps(facts, propDists, report);
  checkSupports(facts, report);
  checkDecor(facts, report);
  checkGoalRunOff(level, report);
  checkBounds(level, report);
  return report.result();
}
