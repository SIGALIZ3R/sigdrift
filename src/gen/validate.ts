/**
 * The safety net for generated levels: every rule the generator promises is checked again here from the finished
 * level alone, without knowing how it was built. Also holds the small geometry toolkit both sides share.
 */

import type { DecorBlock, Gate, Level, Pose, Prop, Segment, ValidationResult, Vec2 } from '../types';

/** The promises a level makes to the car, the camera and the player. The generator aims inside these limits. */
export const RULES = {
  minHalfWidth: 7.5,
  minPathStep: 1,
  maxPathStep: 5,
  minLength: 600,
  maxLength: 1300,
  /** Path points further apart than this along the road must also be apart in space ... */
  overlapPathGap: 40,
  /** ... by the sum of their half widths plus this margin. */
  overlapMargin: 3,
  startWallClearance: 6,
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
} as const;

const EPS = 1e-6;
/** Rounding to 1/1024 m moves an emitted half width by at most this much. */
const WIDTH_SLACK = 0.1;
/** Loose enough for any reasonable tangent estimate, tight enough to catch a misplaced or swapped edge point. */
const EDGE_OFFSET_SLACK = 0.5;
const WALL_JOIN_TOLERANCE = 1e-6;
/** Anything further out is a broken level, and would make the spatial hashes loop over millions of buckets. */
const MAX_COORDINATE = 100_000;
const EDGE_BUCKET = 16;
const WALL_BUCKET = 24;
const BLOCK_BUCKET = 24;
/** Path points this far either side of a pillar must be in line for the pillar to count as on a straight. */
const STRAIGHT_PROBE = 3;
const STRAIGHT_TOLERANCE = 0.02;

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
class Report {
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

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
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
  };
  const checkGate = (gate: Gate, group: string, index: number): void => {
    check(gate.ax, group, index);
    check(gate.az, group, index);
    check(gate.bx, group, index);
    check(gate.bz, group, index);
    check(gate.pathIndex, group, index);
    checkPose(gate.respawn, group, index);
  };
  level.path.forEach((p, i) => {
    check(p.x, 'path', i);
    check(p.z, 'path', i);
    check(p.halfWidth, 'path', i);
    check(p.dist, 'path', i);
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
    check(w.ax, 'walls', i);
    check(w.az, 'walls', i);
    check(w.bx, 'walls', i);
    check(w.bz, 'walls', i);
  });
  level.props.forEach((p, i) => {
    check(p.x, 'props', i);
    check(p.z, 'props', i);
    check(p.radius, 'props', i);
    check(p.height, 'props', i);
    check(p.hue, 'props', i);
  });
  level.decor.forEach((b, i) => {
    check(b.x, 'decor', i);
    check(b.z, 'decor', i);
    check(b.w, 'decor', i);
    check(b.d, 'decor', i);
    check(b.h, 'decor', i);
    check(b.hue, 'decor', i);
  });
  checkPose(level.start, 'start', 0);
  level.checkpoints.forEach((gate, i) => checkGate(gate, 'checkpoints', i));
  checkGate(level.goal, 'goal', 0);
  check(level.bounds.minX, 'bounds', 0);
  check(level.bounds.minZ, 'bounds', 1);
  check(level.bounds.maxX, 'bounds', 2);
  check(level.bounds.maxZ, 'bounds', 3);
  check(level.length, 'length', 0);
}

function checkPath(level: Level, report: Report): void {
  const path = level.path;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.halfWidth < RULES.minHalfWidth - WIDTH_SLACK) {
      report.add('road too narrow', `path[${i}] half width ${fmt(p.halfWidth)} m`);
    }
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
    report.add('length outside 600..1300 m', `${fmt(level.length)} m`);
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

function checkEdgeCrossings(level: Level, report: Report): void {
  const perSide = level.path.length - 1;
  const segments: Segment[] = [];
  polylineSegments(level.left, segments);
  polylineSegments(level.right, segments);
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, segments);
  const near: number[] = [];
  const name = (index: number): string => (index < perSide ? `left[${index}]` : `right[${index - perSide}]`);
  const reported = new Set<number>();
  for (let s = 0; s < segments.length; s++) {
    const a = segments[s];
    hash.collect(Math.min(a.ax, a.bx), Math.min(a.az, a.bz), Math.max(a.ax, a.bx), Math.max(a.az, a.bz), near);
    for (let k = 0; k < near.length; k++) {
      const t = near[k];
      const neighbours = t === s + 1 && t !== perSide;
      if (t <= s || neighbours || !segmentsTouch(a, segments[t])) continue;
      const pair = s * segments.length + t;
      if (reported.has(pair)) continue;
      reported.add(pair);
      report.add('road edges intersect', `${name(s)} and ${name(t)}`);
    }
  }
}

/** Catches a road that doubles back onto itself even where the edge polylines do not quite cross. */
function checkRoadOverlap(level: Level, report: Report): void {
  const path = level.path;
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
      if (j <= i || q.dist - p.dist <= RULES.overlapPathGap) continue;
      const needed = p.halfWidth + q.halfWidth + RULES.overlapMargin;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dx * dx + dz * dz <= needed * needed) {
        const apart = Math.sqrt(dx * dx + dz * dz);
        report.add('road runs into itself', `path[${i}] and path[${j}] are ${fmt(apart)} m apart, need ${fmt(needed)}`);
      }
    }
  }
}

/** Groups wall endpoints that coincide. Endpoint 2s is the a end of wall s, 2s + 1 its b end. */
function joinEndpoints(walls: readonly Segment[]): { node: number[]; degree: number[] } {
  const count = walls.length * 2;
  const xs: number[] = [];
  const zs: number[] = [];
  for (const w of walls) {
    xs.push(w.ax, w.bx);
    zs.push(w.az, w.bz);
  }
  const order = xs.map((_, e) => e).sort((e, f) => xs[e] - xs[f] || zs[e] - zs[f]);
  const node: number[] = new Array<number>(count).fill(-1);
  const degree: number[] = [];
  for (let k = 0; k < count; k++) {
    const e = order[k];
    if (node[e] >= 0) continue;
    node[e] = degree.length;
    degree.push(1);
    for (let m = k + 1; m < count && xs[order[m]] - xs[e] <= WALL_JOIN_TOLERANCE; m++) {
      const f = order[m];
      if (node[f] < 0 && Math.abs(zs[f] - zs[e]) <= WALL_JOIN_TOLERANCE) {
        node[f] = node[e];
        degree[node[e]]++;
      }
    }
  }
  return { node, degree };
}

/** Number of walls reached by walking from wall 0 through shared endpoints. Assumes every node has degree 2. */
function wallsInFirstLoop(walls: readonly Segment[], node: readonly number[], nodeCount: number): number {
  const ends: number[] = new Array<number>(nodeCount * 2).fill(-1);
  for (let e = 0; e < node.length; e++) ends[node[e] * 2 + (ends[node[e] * 2] < 0 ? 0 : 1)] = e;
  let visited = 0;
  let endpoint = 0;
  do {
    visited++;
    const far = endpoint ^ 1;
    const pair = node[far] * 2;
    endpoint = ends[pair] === far ? ends[pair + 1] : ends[pair];
  } while (endpoint >> 1 !== 0 && visited <= walls.length);
  return visited;
}

function checkWallLoop(level: Level, report: Report): boolean {
  const walls = level.walls;
  const { node, degree } = joinEndpoints(walls);
  let closed = true;
  for (let s = 0; s < walls.length; s++) {
    if (node[2 * s] === node[2 * s + 1]) {
      report.add('wall has no length', `walls[${s}]`);
      closed = false;
    }
    for (let end = 0; end < 2; end++) {
      const shared = degree[node[2 * s + end]];
      if (shared === 2) continue;
      const w = walls[s];
      const at = end === 0 ? `(${fmt(w.ax)}, ${fmt(w.az)})` : `(${fmt(w.bx)}, ${fmt(w.bz)})`;
      report.add('walls are not a closed loop', `walls[${s}] end at ${at} is shared by ${shared} segments, need 2`);
      closed = false;
    }
  }
  if (!closed) return false;
  const reached = wallsInFirstLoop(walls, node, degree.length);
  if (reached !== walls.length) {
    report.add('walls form more than one loop', `${reached} of ${walls.length} segments are connected to walls[0]`);
    return false;
  }
  return true;
}

function nearestWall(walls: readonly Segment[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const d = distPointSegment(x, z, w.ax, w.az, w.bx, w.bz);
    if (d < best) best = d;
  }
  return best;
}

function checkStart(level: Level, report: Report): void {
  const { x, z } = level.start;
  if (!insideWalls(level.walls, x, z)) {
    report.add('start is outside the road', `(${fmt(x)}, ${fmt(z)})`);
    return;
  }
  const room = nearestWall(level.walls, x, z);
  if (room < RULES.startWallClearance) report.add('start too close to a wall', `${fmt(room)} m, need 6`);
}

function checkGates(level: Level, report: Report): void {
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
    if (!insideWalls(level.walls, gate.respawn.x, gate.respawn.z)) {
      report.add('respawn is off the road', `${label} at (${fmt(gate.respawn.x)}, ${fmt(gate.respawn.z)})`);
    }
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

function nearestPathIndex(level: Level, x: number, z: number): number {
  let best = 0;
  let bestSq = Infinity;
  for (let i = 0; i < level.path.length; i++) {
    const dx = level.path[i].x - x;
    const dz = level.path[i].z - z;
    const sq = dx * dx + dz * dz;
    if (sq < bestSq) {
      bestSq = sq;
      best = i;
    }
  }
  return best;
}

function distToPolyline(points: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = distPointSegment(x, z, points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
    if (d < best) best = d;
  }
  return best;
}

function isStraightAround(level: Level, index: number): boolean {
  const path = level.path;
  const from = Math.max(index - STRAIGHT_PROBE, 0);
  const to = Math.min(index + STRAIGHT_PROBE, path.length - 1);
  const a = path[from];
  const b = path[to];
  for (let i = from + 1; i < to; i++) {
    if (distPointSegment(path[i].x, path[i].z, a.x, a.z, b.x, b.z) > STRAIGHT_TOLERANCE) return false;
  }
  return true;
}

function checkPropPlacement(level: Level, prop: Prop, label: string, pathIndex: number, report: Report): void {
  if (!insideWalls(level.walls, prop.x, prop.z) || nearestWall(level.walls, prop.x, prop.z) < prop.radius) {
    report.add('prop is not inside the road', label);
    return;
  }
  const toLeft = distToPolyline(level.left, prop.x, prop.z);
  const toRight = distToPolyline(level.right, prop.x, prop.z);
  const corridor = Math.max(toLeft, toRight) - prop.radius;
  if (corridor < RULES.propCorridor - EPS) {
    report.add('prop blocks the road', `${label} leaves ${fmt(corridor)} m on its widest side, need 7.5`);
  }
  if (!isStraightAround(level, pathIndex)) report.add('prop in a corner', label);
  if (level.path[pathIndex].dist < RULES.propStartClearance) {
    report.add('prop too close to the start', `${label} at ${fmt(level.path[pathIndex].dist)} m, need 50`);
  }
  for (const gate of [...level.checkpoints, level.goal]) {
    const room = distPointSegment(prop.x, prop.z, gate.ax, gate.az, gate.bx, gate.bz) - prop.radius;
    if (room < RULES.propGateClearance - EPS) {
      report.add('prop too close to a gate', `${label} is ${fmt(room)} m from the gate at path[${gate.pathIndex}]`);
    }
  }
}

function checkProps(level: Level, report: Report): void {
  const along: number[] = [];
  level.props.forEach((prop, i) => {
    const pathIndex = nearestPathIndex(level, prop.x, prop.z);
    along.push(level.path[pathIndex].dist);
    checkPropPlacement(level, prop, `props[${i}]`, pathIndex, report);
  });
  along.sort((a, b) => a - b);
  for (let i = 1; i < along.length; i++) {
    if (along[i] - along[i - 1] < RULES.propSpacing) {
      report.add('props too close together', `${fmt(along[i] - along[i - 1])} m apart along the path, need 40`);
    }
  }
}

function checkDecorBlock(block: DecorBlock, label: string, level: Level, walls: WallIndex, report: Report): void {
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
  const clearance = walls.clearance(minX, minZ, minX + block.w, minZ + block.d, needed + 1);
  if (clearance < needed - EPS) {
    report.add(
      'decor too tall or too close to the road',
      `${label} is ${fmt(block.h)} m tall, ${fmt(clearance)} m from the road, needs ${fmt(needed)} m`,
    );
  }
  if (insideWalls(level.walls, block.x, block.z)) report.add('decor stands on the road', label);
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

function checkDecor(level: Level, report: Report): void {
  const walls = new WallIndex(level.walls);
  level.decor.forEach((block, i) => checkDecorBlock(block, `decor[${i}]`, level, walls, report));
  checkDecorOverlap(level.decor, report);
}

function checkBounds(level: Level, report: Report): void {
  const b = level.bounds;
  const check = (minX: number, minZ: number, maxX: number, maxZ: number, label: string): void => {
    if (minX < b.minX - EPS || minZ < b.minZ - EPS || maxX > b.maxX + EPS || maxZ > b.maxZ + EPS) {
      report.add('bounds do not contain everything', label);
    }
  };
  level.path.forEach((p, i) => check(p.x, p.z, p.x, p.z, `path[${i}]`));
  level.walls.forEach((w, i) => {
    check(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz), `walls[${i}]`);
  });
  level.props.forEach((p, i) => check(p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius, `props[${i}]`));
  level.decor.forEach((d, i) => check(d.x - d.w / 2, d.z - d.d / 2, d.x + d.w / 2, d.z + d.d / 2, `decor[${i}]`));
}

/** Returns every broken rule as a readable sentence. A level that passes is safe to drive and to render. */
export function validateLevel(level: Level): ValidationResult {
  const report = new Report();
  checkShape(level, report);
  checkNumbers(level, report);
  // The geometric checks index arrays in step and walk spatial grids, so they need sane input.
  if (!report.clean) return report.result();
  checkPath(level, report);
  checkEdgeOffsets(level, report);
  checkEdgeCrossings(level, report);
  checkRoadOverlap(level, report);
  // Inside/outside tests are meaningless against an open boundary.
  if (checkWallLoop(level, report)) {
    checkStart(level, report);
    checkGates(level, report);
    checkProps(level, report);
    checkDecor(level, report);
  }
  checkBounds(level, report);
  return report.result();
}
