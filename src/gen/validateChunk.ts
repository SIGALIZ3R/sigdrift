/**
 * The safety net for the endless road. Every promise the chunk generator makes is checked again here from the
 * finished chunks alone, without knowing how they were built.
 *
 * The endless road is 2.5D like the fixed levels: it climbs and drops, passes OVER and UNDER earlier stretches of
 * itself, and some raised edges are open drops. It is also unbounded: the generator only remembers the last
 * CHUNK_RULES.memory chunks, and road older than that may be built over freely (the mode keeps far fewer chunks
 * alive). So every rule that relates two stretches of road is checked within that window only.
 *
 * `validateChunk(chunk, previous, earlier)` judges one chunk, how it meets the chunk before it, and how it relates to
 * the chunks before that (`earlier`, oldest first, up to memory - 1 of them). `validateChunkSequence` runs it over a
 * whole run with the right window for every chunk, then checks the spacing rules that span the whole run.
 */

import { lerp, sin, smoothstep } from '../core/fixedMath';
import type { Bump, DecorBlock, PathPoint, Prop, Segment, TrackChunk, ValidationResult, Vec2, Wall } from '../types';
import { CROSSING_CLEARANCE, MAX_GRADE, TERRAIN_Y, WALL_HEIGHT } from '../types';
import {
  BEND_GRADE,
  DECK_THICKNESS,
  FLIGHT_MAX_REACH,
  RAISED_HEIGHT,
  RoadIndex,
  bumpClimbAt,
  bumpLaunch,
  bumpsAlong,
  edgeLandsOnOther,
} from './road3d';
import type { BumpAlong, RoadHit } from './road3d';
import { RULES, Report, SpatialHash, WallIndex, distPointSegment, fmt, segmentsTouch } from './validate';

/** What a chunk promises on top of the fixed levels' RULES. The generator aims inside these limits. */
export const CHUNK_RULES = {
  /** Slightly below the generator's 7.5 m floor: rounding to the lattice may shave a little off. */
  minHalfWidth: 7.4,
  /** No wall may stand this close to the start pose. */
  startWallClearance: 6,
  /** The run opens with this much straight, level road. */
  startStraight: 60,
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
  /** The road under and this far either side of a ridge (beyond its half length) is nearly level. */
  bumpLevelReach: 10,
  bumpMaxGrade: 0.035,
  /**
   * Least centreline distance between a crest and an open edge on a gentle road: a car that lands crooked must not
   * land beside a drop. It fades to nothing as the intensity rises to `bumpOpenFadeEnd`.
   */
  bumpOpenGentle: 40,
  bumpOpenFadeEnd: 0.75,
  // ---- the memory window ----
  /** A chunk must keep clear of (or properly cross) the road of this many chunks before it. */
  memory: 10,
  /** Two chunks this many indices apart or fewer can be alive in the world at the same time. */
  liveWindow: 5,
  // ---- heights ----
  /** Highest road surface, m. */
  maxHeight: 40,
  // ---- crossings ----
  /** None of these may be this close (centreline) to the heart of a crossing: bumps, pillars, open edges. */
  crossingKeepOut: 18,
  /** Widest road a crossing may be built on (no crossing in a plaza). */
  crossingMaxHalfWidth: 13.5,
  // ---- open edges ----
  openMinRun: 25,
  openMaxRun: 125,
  /** Open edges keep this far (centreline) from both ends of their chunk, so a stretch never spans a join. */
  openJoinClearance: 10,
  openPropClearance: 20,
  /** Open edges only on road at most this wide: a car going over one lands clear of every other road. */
  openMaxHalfWidth: 12.75,
  /** Below this intensity open edges are on straights only. */
  openBendIntensity: 0.5,
  // ---- supports ----
  supportClearance: 1,
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

/** Fastest a car is assumed to take a bump, m/s (about the redline). */
export const BUMP_FLIGHT_SPEED = 40;
const BUMP_GRAVITY = 9.81;
/** A flying car this far or more below the barrier top is stopped by the barrier, not carried over it, m. */
const BUMP_BARRIER_MARGIN = 0.15;

/**
 * Straight road a bump of this height and half length needs AHEAD of its crest, m, so a car taking it at up to
 * BUMP_FLIGHT_SPEED can never be carried over the barrier of the bend that follows: by the time it reaches the bend
 * it has either landed or is lower than WALL_HEIGHT - BUMP_BARRIER_MARGIN above the road (then the barrier stops it).
 *
 * The car leaves the ridge on its far side, where following it would pull down harder than the car model's launch
 * limit; its vertical speed then is the road's (speed x slope there) and it flies a parabola. Measured from the
 * take-off point, which lies before the crest, so the answer is on the safe side. 0 when the car never gets that
 * high.
 */
export function bumpLandingRoom(height: number, halfLength: number, speed = BUMP_FLIGHT_SPEED): number {
  const { vy, y0 } = bumpLaunch(height, halfLength, speed);
  if (vy <= 0) return 0;
  const limit = WALL_HEIGHT - BUMP_BARRIER_MARGIN;
  const apex = y0 + (vy * vy) / (2 * BUMP_GRAVITY);
  if (apex <= limit) return 0;
  // Later of the two moments the flight passes `limit`: from then on it is lower.
  const t = (vy + Math.sqrt(vy * vy + 2 * BUMP_GRAVITY * (y0 - limit))) / BUMP_GRAVITY;
  return speed * t;
}

/** Least centreline distance between a crest and an open edge segment, m, for a chunk of the given intensity. */
export function minBumpToOpenEdge(intensity: number): number {
  const fade = smoothstep(CHUNK_RULES.gentleIntensity, CHUNK_RULES.bumpOpenFadeEnd, intensity);
  return lerp(CHUNK_RULES.bumpOpenGentle, 0, fade);
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
/** Sine of the turn at a path vertex above which a grade counts as "in a bend" (as the level validator). */
const GRADE_BEND_SINE = 1e-3;
const STRAIGHT_PROBE = 3;
const STRAIGHT_TOLERANCE = 0.02;
/** Travelled distance and the straight-line step between samples agree to this, m. */
const DIST_STEP_SLACK = 0.1;
/** Measured positions along the road come from rounded coordinates. */
const ALONG_SLACK = 0.02;
const ON_CENTRELINE_SLACK = 0.05;
const MAX_PROP_RADIUS = 3;
/** Room for lattice rounding on grades. */
const GRADE_SLACK = 0.002;
/** Two roads closer in height than this are on the same level. */
const SAME_LEVEL = 2;
/** A thing "stands on" the road when its base is within this of the surface. */
const ON_SURFACE = 0.05;

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
  if (!Array.isArray(chunk.leftOpen) || !Array.isArray(chunk.rightOpen)) {
    report.add('open-edge arrays missing', 'leftOpen / rightOpen');
  } else if (chunk.leftOpen.length !== n || chunk.rightOpen.length !== n) {
    report.add(
      'open-edge arrays differ from path',
      `path ${n}, leftOpen ${chunk.leftOpen.length}, rightOpen ${chunk.rightOpen.length}`,
    );
  }
  if (!Number.isInteger(chunk.index) || chunk.index < 0) report.add('bad chunk index', `${chunk.index}`);
}

function checkNumbers(chunk: TrackChunk, report: Report): void {
  const check = (v: number, group: string, index: number): void => {
    if (!Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) report.add('bad number', `${group}[${index}] has ${v}`);
  };
  const all = (values: readonly number[], group: string, index: number): void => {
    for (const v of values) check(v, group, index);
  };
  chunk.path.forEach((p, i) => all([p.x, p.z, p.y, p.halfWidth, p.dist], 'path', i));
  chunk.left.forEach((p, i) => all([p.x, p.z], 'left', i));
  chunk.right.forEach((p, i) => all([p.x, p.z], 'right', i));
  chunk.walls.forEach((w, i) => all([w.ax, w.az, w.bx, w.bz, w.ya, w.yb], 'walls', i));
  chunk.props.forEach((p, i) => all([p.x, p.z, p.y, p.radius, p.height, p.hue], 'props', i));
  chunk.decor.forEach((b, i) => all([b.x, b.z, b.w, b.d, b.h, b.hue], 'decor', i));
  chunk.bumps.forEach((b, i) => all([b.x, b.z, b.y, b.dirX, b.dirZ, b.halfLength, b.halfWidth, b.height], 'bumps', i));
  (chunk.supports ?? []).forEach((s, i) => all([s.x, s.z, s.top, s.radius], 'supports', i));
  all([chunk.startDist, chunk.endDist, chunk.intensity], 'chunk', 0);
  const b = chunk.bounds;
  all([b.minX, b.minZ, b.maxX, b.maxZ, b.minY, b.maxY], 'bounds', 0);
}

/** True when the chunk is well-formed enough for the geometric checks, which index arrays in step. */
function isSane(chunk: TrackChunk): boolean {
  const report = new Report();
  checkShape(chunk, report);
  if (report.clean) checkNumbers(chunk, report);
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
    if (p.y < -EPS) report.add('road below the city', `path[${i}] at height ${fmt(p.y)} m`);
    if (p.y > CHUNK_RULES.maxHeight) report.add('road too high', `path[${i}] at height ${fmt(p.y)} m`);
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
  if (chunk.startDist !== path[0].dist) {
    report.add('startDist differs from first dist', `${chunk.startDist} vs ${path[0].dist}`);
  }
  if (chunk.endDist !== path[path.length - 1].dist) {
    report.add('endDist differs from final dist', `${chunk.endDist} vs ${path[path.length - 1].dist}`);
  }
  if (chunk.index === 0 && chunk.startDist !== 0) report.add('first chunk does not start at 0', `${chunk.startDist}`);
  if (chunk.intensity < 0 || chunk.intensity > 1) report.add('intensity outside 0..1', `${chunk.intensity}`);
}

/** The chunk must begin exactly where the previous one ended: same point, height, width and edges. */
function checkJoin(chunk: TrackChunk, previous: TrackChunk, report: Report): void {
  if (chunk.index !== previous.index + 1) {
    report.add('chunks out of order', `${chunk.index} follows ${previous.index}`);
  }
  const last = previous.path.length - 1;
  const a = previous.path[last];
  const b = chunk.path[0];
  if (a.x !== b.x || a.z !== b.z) {
    report.add('join broken', `starts at (${b.x}, ${b.z}), previous chunk ends at (${a.x}, ${a.z})`);
  }
  if (a.y !== b.y) report.add('join changes height', `${b.y} after ${a.y}`);
  if (a.halfWidth !== b.halfWidth) report.add('join changes width', `${b.halfWidth} after ${a.halfWidth}`);
  if (a.dist !== b.dist || previous.endDist !== chunk.startDist) {
    report.add('join breaks dist', `${b.dist} after ${a.dist}`);
  }
  const edgesMeet =
    previous.left[last].x === chunk.left[0].x &&
    previous.left[last].z === chunk.left[0].z &&
    previous.right[last].x === chunk.right[0].x &&
    previous.right[last].z === chunk.right[0].z;
  if (!edgesMeet) report.add('join leaves a gap in the walls', `between chunks ${previous.index} and ${chunk.index}`);
}

/** Per vertex of a road: the road turns there. */
function bendVertices(path: readonly PathPoint[], sine: number): boolean[] {
  const out: boolean[] = new Array<boolean>(path.length).fill(false);
  for (let i = 1; i + 1 < path.length; i++) {
    const ax = path[i].x - path[i - 1].x;
    const az = path[i].z - path[i - 1].z;
    const bx = path[i + 1].x - path[i].x;
    const bz = path[i + 1].z - path[i].z;
    const scale = Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
    out[i] = scale > 0 && Math.abs(ax * bz - az * bx) > sine * scale;
  }
  return out;
}

/**
 * Grades, grade in bends and crest sharpness over the chunk and across its join (both sides of a join are part of
 * one smooth profile). The first chunk opens with level, straight road.
 */
function checkHeights(chunk: TrackChunk, road: Road, report: Report): void {
  const path = road.path;
  const bend = bendVertices(path, GRADE_BEND_SINE);
  let previous = NaN;
  for (let i = Math.max(1, road.offset - 1); i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const run = b.dist - a.dist;
    if (!(run > 0)) continue;
    const grade = (b.y - a.y) / run;
    const own = i > road.offset;
    if (own) {
      const steep = Math.abs(grade);
      if (steep > MAX_GRADE + GRADE_SLACK) report.add('road too steep', `path[${i - road.offset}] grade ${fmt(grade * 100)}%`);
      if (bend[i - 1] && bend[i] && steep > BEND_GRADE + GRADE_SLACK) {
        report.add('road too steep in a bend', `path[${i - road.offset}] grade ${fmt(grade * 100)}%`);
      }
    }
    if (i >= 2 && !Number.isNaN(previous) && i - 1 >= road.offset) {
      const change = Math.abs(grade - previous) / ((b.dist - path[i - 2].dist) / 2);
      if (change > RULES.maxGradeChange) {
        report.add('grade changes too sharply', `at path[${i - 1 - road.offset}] by ${fmt(change * 1000)} per mille per metre`);
      }
    }
    previous = grade;
  }
  if (chunk.index !== 0) return;
  const first = chunk.path[0];
  let last = 0;
  for (let i = 0; i < chunk.path.length && chunk.path[i].dist <= CHUNK_RULES.startStraight; i++) {
    if (Math.abs(chunk.path[i].y - first.y) > 1e-9) report.add('start is not level', `path[${i}]`);
    last = i;
  }
  const end = chunk.path[last + 1 < chunk.path.length ? last + 1 : last];
  for (let i = 1; i <= last; i++) {
    const p = chunk.path[i];
    if (distPointSegment(p.x, p.z, first.x, first.z, end.x, end.z) > STRAIGHT_TOLERANCE) {
      report.add('start is not straight', `path[${i}]`);
      break;
    }
  }
}

/** Each edge point must sit one half width to its own side of the centreline. */
function checkEdgeOffsets(chunk: TrackChunk, road: Road, report: Report): void {
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
    // At a join the edges are offset along the exact exit direction, which a chord across an S-bend misses by
    // half a sample's turn.
    const atJoin = (i === 0 && chunk.index > 0) || i === chunk.path.length - 1;
    const slack = atJoin ? OPEN_END_OFFSET_SLACK : EDGE_OFFSET_SLACK;
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

function insertSegments(hash: SpatialHash, segments: readonly Segment[], first = 0): void {
  for (let i = first; i < segments.length; i++) {
    const s = segments[i];
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.az, s.bz), Math.max(s.ax, s.bx), Math.max(s.az, s.bz));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Context: the chunk and the road it must respect
// ---------------------------------------------------------------------------------------------------------------

/** The chunk being judged plus the chunks before it within the memory window (oldest first, chunk last). */
interface Context {
  chunk: TrackChunk;
  previous: TrackChunk | null;
  /** Every chunk, oldest first; the judged chunk is last. */
  all: readonly TrackChunk[];
  index: RoadIndex;
  /** Road id in `index` -> position in `all`. */
  hits: RoadHit[];
  /** Where this chunk passes over or under another stretch of road: centreline dist on each road. */
  hearts: { own: number; other: number; chunk: TrackChunk }[];
  /** Bumps of each chunk along its road (for the flights off its open edges), filled on demand. */
  bumpsOf: Map<TrackChunk, BumpAlong[]>;
}

function makeContext(chunk: TrackChunk, previous: TrackChunk | null, earlier: readonly TrackChunk[]): Context {
  const all: TrackChunk[] = [];
  for (const c of earlier) if (c.index >= chunk.index - CHUNK_RULES.memory && c.index < chunk.index - 1) all.push(c);
  if (previous) all.push(previous);
  all.push(chunk);
  const index = new RoadIndex(4, 16);
  for (const c of all) index.add(c.path);
  return { chunk, previous, all, index, hits: [], hearts: [], bumpsOf: new Map() };
}

/** True when a hit on any road of the context is a different stretch than centreline distance `dist`. */
function otherStretch(hits: readonly RoadHit[], dist: number): boolean {
  for (let k = 0; k < hits.length; k++) if (Math.abs(hits[k].dist - dist) > RULES.overlapPathGap) return true;
  return false;
}

/** Path points of the context in one array, tagged with their chunk. */
interface Sample {
  p: PathPoint;
  chunk: number;
  /** Index in its chunk's path. */
  i: number;
}

function directionAt(path: readonly PathPoint[], i: number): Vec2 {
  const a = path[Math.max(0, i - 1)];
  const b = path[Math.min(path.length - 1, i + 1)];
  const len = distance(a.x, a.z, b.x, b.z);
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/**
 * The chunk's road must not meet any road of the window at the same level, and where it passes over or under one
 * the two surfaces are at least CROSSING_CLEARANCE apart. Records the hearts of the crossings (one road's
 * centreline within the other's half width) and checks they are square, on straights and not in a plaza.
 */
function checkRoadOverlap(ctx: Context, report: Report): void {
  const samples: Sample[] = [];
  let widest = 0;
  ctx.all.forEach((c, n) => {
    c.path.forEach((p, i) => {
      // The repeated join point belongs to the earlier chunk.
      if (i === 0 && n > 0 && ctx.all[n - 1].index === c.index - 1) return;
      samples.push({ p, chunk: n, i });
      widest = Math.max(widest, p.halfWidth);
    });
  });
  const hash = new SpatialHash(Math.max(16, 2 * widest + RULES.overlapMargin));
  samples.forEach((s, k) => hash.insert(k, s.p.x, s.p.z, s.p.x, s.p.z));
  const own = ctx.all.length - 1;
  const near: number[] = [];
  const reported = new Set<string>();
  const bendCache = new Map<number, boolean[]>();
  const bendsOf = (n: number): boolean[] => {
    let b = bendCache.get(n);
    if (!b) {
      b = bendVertices(ctx.all[n].path, GRADE_BEND_SINE);
      bendCache.set(n, b);
    }
    return b;
  };
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    if (s.chunk !== own) continue;
    const p = s.p;
    const reach = p.halfWidth + widest + RULES.overlapMargin;
    hash.collect(p.x - reach, p.z - reach, p.x + reach, p.z + reach, near);
    for (let m = 0; m < near.length; m++) {
      const other = samples[near[m]];
      const q = other.p;
      if (Math.abs(q.dist - p.dist) <= RULES.overlapPathGap) continue;
      if (other.chunk === own && near[m] < k) continue;
      const touching = p.halfWidth + q.halfWidth;
      const apart = distance(p.x, p.z, q.x, q.z);
      if (apart > touching + RULES.overlapMargin) continue;
      const dy = Math.abs(p.y - q.y);
      const where = `points at ${fmt(p.dist)} m and ${fmt(q.dist)} m are ${fmt(apart)} m apart and ${fmt(dy)} m apart in height`;
      if (dy < CROSSING_CLEARANCE - EPS) {
        const rule = dy < SAME_LEVEL ? 'road runs into itself' : 'crossing too low';
        const key = `${rule}|${Math.round(p.dist)}|${Math.round(q.dist)}`;
        if (!reported.has(key)) {
          reported.add(key);
          report.add(rule, `${where}, need ${dy < SAME_LEVEL ? fmt(touching + RULES.overlapMargin) + ' m apart' : CROSSING_CLEARANCE + ' m'}`);
        }
        continue;
      }
      if (apart > Math.max(p.halfWidth, q.halfWidth)) continue;
      // The heart of a crossing.
      const otherChunk = ctx.all[other.chunk];
      ctx.hearts.push({ own: p.dist, other: q.dist, chunk: otherChunk });
      if (bendsOf(own)[s.i] || bendsOf(other.chunk)[other.i]) report.add('crossing in a bend', where);
      if (Math.max(p.halfWidth, q.halfWidth) > CHUNK_RULES.crossingMaxHalfWidth) report.add('crossing in a plaza', where);
      const a = directionAt(ctx.chunk.path, s.i);
      const b = directionAt(otherChunk.path, other.i);
      if (Math.abs(a.x * b.x + a.z * b.z) > 0.1) report.add('crossing not square', where);
    }
  }
}

/** Road edges may only cross in plan where one road passes well above the other. */
function checkEdgeCrossings(ctx: Context, report: Report): void {
  interface EdgeSeg extends Segment {
    lo: number;
    hi: number;
    chunk: number;
    i: number;
    side: string;
  }
  const segments: EdgeSeg[] = [];
  ctx.all.forEach((c, n) => {
    for (const [edge, side] of [
      [c.left, 'left'],
      [c.right, 'right'],
    ] as const) {
      for (let i = 0; i + 1 < edge.length; i++) {
        const lo = Math.min(c.path[i].y, c.path[i + 1].y);
        const hi = Math.max(c.path[i].y, c.path[i + 1].y);
        segments.push({ ax: edge[i].x, az: edge[i].z, bx: edge[i + 1].x, bz: edge[i + 1].z, lo, hi, chunk: n, i, side });
      }
    }
  });
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, segments);
  const own = ctx.all.length - 1;
  const near: number[] = [];
  const reported = new Set<number>();
  const joinedTo = (a: EdgeSeg, b: EdgeSeg): boolean =>
    (a.ax === b.bx && a.az === b.bz) || (a.bx === b.ax && a.bz === b.az) || (a.ax === b.ax && a.az === b.az) || (a.bx === b.bx && a.bz === b.bz);
  for (let s = 0; s < segments.length; s++) {
    const a = segments[s];
    if (a.chunk !== own) continue;
    hash.collect(Math.min(a.ax, a.bx), Math.min(a.az, a.bz), Math.max(a.ax, a.bx), Math.max(a.az, a.bz), near);
    for (let k = 0; k < near.length; k++) {
      const t = near[k];
      const b = segments[t];
      if (t === s || (b.chunk === own && t < s) || joinedTo(a, b) || !segmentsTouch(a, b)) continue;
      const apart = Math.max(b.lo - a.hi, a.lo - b.hi);
      if (apart >= CROSSING_CLEARANCE - 0.5) continue;
      const pair = Math.min(s, t) * segments.length + Math.max(s, t);
      if (reported.has(pair)) continue;
      reported.add(pair);
      report.add('road edges intersect', `${a.side}[${a.i}] and ${b.side}[${b.i}] of chunk ${ctx.all[b.chunk].index}`);
    }
  }
}

function nearHeart(dists: readonly number[], d0: number, d1: number, clearance: number): boolean {
  for (const c of dists) if (d1 > c - clearance && d0 < c + clearance) return true;
  return false;
}

/** Crossing hearts on a given chunk's road (as the judged chunk or as the road it passes over or under). */
function heartsOn(ctx: Context, chunk: TrackChunk): number[] {
  const out: number[] = [];
  for (const h of ctx.hearts) {
    if (chunk === ctx.chunk) out.push(h.own);
    if (h.chunk === chunk) out.push(h.other);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Walls and open edges
// ---------------------------------------------------------------------------------------------------------------

function sameSegment(w: Segment, a: Vec2, b: Vec2): boolean {
  return (w.ax === a.x && w.az === a.z && w.bx === b.x && w.bz === b.z) || (w.ax === b.x && w.az === b.z && w.bx === a.x && w.bz === a.z);
}

/**
 * Every edge segment that is not open has exactly its own barrier at the road's height, and every open one has
 * none. Returns the walls that are not part of an edge: the cap behind the start in the first chunk, else nothing.
 */
function checkWallsFollowEdges(chunk: TrackChunk, report: Report): Wall[] {
  const walls = chunk.walls;
  const hash = new SpatialHash(EDGE_BUCKET);
  insertSegments(hash, walls);
  const near: number[] = [];
  const taken = new Array<boolean>(walls.length).fill(false);
  const check = (edge: readonly Vec2[], open: readonly boolean[], name: string): void => {
    for (let i = 0; i + 1 < edge.length; i++) {
      const a = edge[i];
      const b = edge[i + 1];
      hash.collect(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z), near);
      let found = -1;
      for (let k = 0; k < near.length && found < 0; k++) {
        if (!taken[near[k]] && sameSegment(walls[near[k]], a, b)) found = near[k];
      }
      if (open[i]) {
        if (found >= 0) report.add('open edge has a wall', `${name}[${i}] to ${name}[${i + 1}]`);
        continue;
      }
      if (found < 0) {
        report.add('road edge has no wall', `${name}[${i}] to ${name}[${i + 1}]`);
        continue;
      }
      taken[found] = true;
      const w = walls[found];
      const forward = w.ax === a.x && w.az === a.z;
      const ya = forward ? w.ya : w.yb;
      const yb = forward ? w.yb : w.ya;
      if (Math.abs(ya - chunk.path[i].y) > EPS || Math.abs(yb - chunk.path[i + 1].y) > EPS) {
        report.add('wall height differs from the road', `${name}[${i}]`);
      }
    }
  };
  check(chunk.left, chunk.leftOpen, 'left');
  check(chunk.right, chunk.rightOpen, 'right');
  return walls.filter((_, i) => !taken[i]);
}

/** The first chunk is closed behind the start by a chain of walls from one edge to the other, at the start's height. */
function checkStartCap(chunk: TrackChunk, cap: readonly Wall[], report: Report): void {
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
  for (const w of cap) {
    if (Math.abs(w.ya - start.y) > EPS || Math.abs(w.yb - start.y) > EPS) {
      report.add('wall behind the start is not at the road height', `${fmt(w.ya)} vs ${fmt(start.y)}`);
    }
  }
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
 * True when a car going over edge segment i of a chunk could come down on another stretch of road of the context
 * (the same landing zone the generator keeps clear: road3d.edgeLandsOnOther).
 */
function edgeOverOtherRoad(ctx: Context, chunk: TrackChunk, edge: readonly Vec2[], i: number): boolean {
  const mid = (chunk.path[i].dist + chunk.path[i + 1].dist) / 2;
  let along = ctx.bumpsOf.get(chunk);
  if (!along) {
    along = bumpsAlong(chunk.path, chunk.bumps);
    ctx.bumpsOf.set(chunk, along);
  }
  return edgeLandsOnOther(
    chunk.path,
    edge,
    i,
    (x, z) => ctx.index.query(x, z, 0, ctx.hits),
    // Roads that are never loaded together with this chunk cannot be landed on: only live ones count out there.
    (hit, far) =>
      Math.abs(hit.dist - mid) > RULES.overlapPathGap &&
      (!far || Math.abs(ctx.all[hit.road].index - chunk.index) <= CHUNK_RULES.liveWindow),
    bumpClimbAt(along, mid),
  );
}

/** Open stretches of the judged chunk: raised, single-sided in bends, inside the chunk, clear of crossings and roads. */
function checkOpenEdges(ctx: Context, report: Report): void {
  const chunk = ctx.chunk;
  const { path } = chunk;
  const n = path.length;
  const bend = bendVertices(path, BEND_SINE);
  const hearts = heartsOn(ctx, chunk);
  let any = false;
  const sides: [readonly Vec2[], readonly boolean[], readonly boolean[], string][] = [
    [chunk.left, chunk.leftOpen, chunk.rightOpen, 'left'],
    [chunk.right, chunk.rightOpen, chunk.leftOpen, 'right'],
  ];
  for (const [edge, open, other, name] of sides) {
    let runStart = -1;
    for (let i = 0; i + 1 < n; i++) {
      if (open[i]) {
        any = true;
        const a = path[i];
        const b = path[i + 1];
        const label = `${name}[${i}]`;
        const bent = bend[i] || bend[i + 1];
        if (a.y < RAISED_HEIGHT - EPS || b.y < RAISED_HEIGHT - EPS) report.add('open edge on low road', label);
        if (Math.max(a.halfWidth, b.halfWidth) > CHUNK_RULES.openMaxHalfWidth) report.add('open edge on wide road', label);
        if (bent && other[i]) report.add('open on both sides in a bend', label);
        if (bent && chunk.intensity < CHUNK_RULES.openBendIntensity) report.add('open edge in a bend on a gentle road', label);
        const clearance = CHUNK_RULES.openJoinClearance;
        if (a.dist < chunk.startDist + clearance - ALONG_SLACK || b.dist > chunk.endDist - clearance + ALONG_SLACK) {
          report.add('open edge too close to a chunk join', label);
        }
        if (nearHeart(hearts, a.dist, b.dist, CHUNK_RULES.crossingKeepOut)) report.add('open edge at a crossing', label);
        if (edgeOverOtherRoad(ctx, chunk, edge, i)) report.add('open edge above another road', label);
        if (runStart < 0) runStart = i;
      }
      const ends = runStart >= 0 && (!open[i] || i + 2 === n);
      if (ends) {
        const stop = open[i] ? i + 1 : i;
        const run = path[stop].dist - path[runStart].dist;
        if (run < CHUNK_RULES.openMinRun - EPS) report.add('open stretch too short', `${name}[${runStart}] runs ${fmt(run)} m`);
        if (run > CHUNK_RULES.openMaxRun + EPS) report.add('open stretch too long', `${name}[${runStart}] runs ${fmt(run)} m`);
        runStart = -1;
      }
    }
  }
  if (chunk.index === 0 && any) report.add('open edges in the first chunk', 'the warm-up has barriers all round');
  // Open edges of earlier chunks must not drop onto this chunk's road, nor sit at its crossings.
  for (const c of ctx.all) {
    if (c === chunk) continue;
    const others = heartsOn(ctx, c);
    for (const [edge, open, name] of [
      [c.left, c.leftOpen, 'left'],
      [c.right, c.rightOpen, 'right'],
    ] as const) {
      for (let i = 0; i + 1 < c.path.length; i++) {
        if (!open[i]) continue;
        const label = `${name}[${i}] of chunk ${c.index}`;
        if (nearHeart(others, c.path[i].dist, c.path[i + 1].dist, CHUNK_RULES.crossingKeepOut)) {
          report.add('open edge at a crossing', label);
        }
        const e = edge[i];
        const b = chunk.bounds;
        const reach = FLIGHT_MAX_REACH + 4;
        if (e.x < b.minX - reach || e.x > b.maxX + reach || e.z < b.minZ - reach || e.z > b.maxZ + reach) continue;
        if (edgeOverOtherRoad(ctx, c, edge, i)) report.add('open edge above another road', label);
      }
    }
  }
}

/** True when an open edge segment of `chunk` lies within `reach` of centreline distance `dist`. */
function openNear(chunk: TrackChunk, dist: number, reach: number): boolean {
  const path = chunk.path;
  for (let i = 0; i + 1 < path.length; i++) {
    if (!chunk.leftOpen[i] && !chunk.rightOpen[i]) continue;
    if (path[i + 1].dist > dist - reach && path[i].dist < dist + reach) return true;
  }
  return false;
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
  /** Surface height at the projection (without bumps). */
  y: number;
}

/** The nearest centreline point of a chunk to (x, z) among segments whose surface is within `tolerance` of `y`. */
function projectOnPath(path: readonly PathPoint[], x: number, z: number, y = NaN, tolerance = Infinity): Projection {
  const best: Projection = { segment: 0, dist: path[0].dist, offset: Infinity, y: path[0].y };
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / lengthSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const surface = a.y + (b.y - a.y) * t;
    if (!Number.isNaN(y) && Math.abs(surface - y) > tolerance) continue;
    const offset = distance(x, z, a.x + dx * t, a.z + dz * t);
    if (offset < best.offset) {
      best.segment = i;
      best.dist = a.dist + (b.dist - a.dist) * t;
      best.offset = offset;
      best.y = surface;
    }
  }
  return best;
}

/** `dist` of every road sample where the road changes direction, in driving order. */
function bendDists(road: Road): number[] {
  const path = road.path;
  const bend = bendVertices(path, BEND_SINE);
  const out: number[] = [];
  for (let i = 0; i < path.length; i++) if (bend[i]) out.push(path[i].dist);
  return out;
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

function checkSpacing(dists: number[], needed: number, rule: string, report: Report): void {
  const sorted = dists.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap < needed - ALONG_SLACK) report.add(rule, `${fmt(gap)} m apart along the road, need ${needed}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

function propDists(chunk: TrackChunk): number[] {
  return chunk.props.map((prop) => projectOnPath(chunk.path, prop.x, prop.z, prop.y, SAME_LEVEL).dist);
}

function checkProp(ctx: Context, prop: Prop, label: string, hearts: readonly number[], report: Report): number {
  const chunk = ctx.chunk;
  const at = projectOnPath(chunk.path, prop.x, prop.z, prop.y, SAME_LEVEL);
  if (prop.kind !== 'pillar') report.add('unknown prop kind', `${label} is "${String(prop.kind)}"`);
  if (!(prop.radius > 0) || prop.radius > MAX_PROP_RADIUS || !(prop.height > 0)) {
    report.add('prop has a bad size', `${label} radius ${fmt(prop.radius)}, height ${fmt(prop.height)}`);
  }
  const a = chunk.path[at.segment];
  const b = chunk.path[at.segment + 1];
  const share = b.dist > a.dist ? (at.dist - a.dist) / (b.dist - a.dist) : 0;
  const halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * share;
  if (!(at.offset + prop.radius <= halfWidth + EPS) || Math.abs(at.y - prop.y) > ON_SURFACE) {
    report.add('prop is not inside the road', label);
    return at.dist;
  }
  const toLeft = distToPolyline(chunk.left, prop.x, prop.z);
  const toRight = distToPolyline(chunk.right, prop.x, prop.z);
  const corridor = Math.max(toLeft, toRight) - prop.radius;
  if (corridor < RULES.propCorridor - EPS) {
    report.add('prop blocks the road', `${label} leaves ${fmt(corridor)} m on its widest side, need 7.5`);
  }
  const nearest = at.dist - a.dist < b.dist - at.dist ? 0 : 1;
  if (!isStraightAround(chunk.path, at.segment + nearest)) report.add('prop in a bend', label);
  if (at.dist < CHUNK_RULES.propStartClearance) {
    report.add('prop too close to the start', `${label} at ${fmt(at.dist)} m, need 60`);
  }
  const toJoin = Math.min(at.dist - chunk.startDist, chunk.endDist - at.dist);
  if (toJoin < CHUNK_RULES.propJoinClearance - ALONG_SLACK) {
    report.add('prop too close to a chunk join', `${label} is ${fmt(toJoin)} m from it, need 20`);
  }
  if (openNear(chunk, at.dist, CHUNK_RULES.openPropClearance) || (ctx.previous && openNear(ctx.previous, at.dist, CHUNK_RULES.openPropClearance))) {
    report.add('prop beside an open edge', label);
  }
  if (nearHeart(hearts, at.dist, at.dist, CHUNK_RULES.crossingKeepOut)) report.add('prop too close to a crossing', label);
  return at.dist;
}

function checkProps(ctx: Context, report: Report): void {
  const chunk = ctx.chunk;
  if (chunk.index === 0 && chunk.props.length > 0) report.add('props in the first chunk', `${chunk.props.length} of them`);
  const hearts = heartsOn(ctx, chunk);
  const dists = chunk.props.map((prop, i) => checkProp(ctx, prop, `props[${i}]`, hearts, report));
  if (ctx.previous) dists.push(...propDists(ctx.previous));
  checkSpacing(dists, RULES.propSpacing, 'props too close together', report);
  // Pillars of earlier road must not stand at a crossing this chunk makes with it.
  for (const c of ctx.all) {
    if (c === chunk || c.props.length === 0) continue;
    const others = heartsOn(ctx, c);
    if (others.length === 0) continue;
    propDists(c).forEach((d, i) => {
      if (nearHeart(others, d, d, CHUNK_RULES.crossingKeepOut)) report.add('prop too close to a crossing', `props[${i}] of chunk ${c.index}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------------------------------------------

function bumpDists(chunk: TrackChunk): number[] {
  return chunk.bumps.map((bump) => projectOnPath(chunk.path, bump.x, bump.z, bump.y, SAME_LEVEL).dist);
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
  // Ahead also room for the flight: a car must never be carried over the barrier of the bend that follows.
  const neededAhead = Math.max(minBumpBeforeBend(chunk.intensity), bump.halfLength, bumpLandingRoom(bump.height, bump.halfLength));
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

/** The ridge must reach both walls, on road that is neither a plaza nor changing width quickly, and nearly level. */
function checkBumpSpan(chunk: TrackChunk, road: Road, bump: Bump, at: Projection, label: string, report: Report): void {
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
  const reach = bump.halfLength + CHUNK_RULES.bumpLevelReach;
  const path = road.path;
  for (let i = 1; i < path.length; i++) {
    if (path[i].dist < at.dist - reach || path[i - 1].dist > at.dist + reach) continue;
    const grade = (path[i].y - path[i - 1].y) / (path[i].dist - path[i - 1].dist);
    if (Math.abs(grade) > CHUNK_RULES.bumpMaxGrade) {
      report.add('bump on a slope', `${label} sits on a ${fmt(grade * 100)}% grade`);
      break;
    }
  }
}

function checkBumpsClearOfProps(bumps: readonly Bump[], props: readonly Prop[], report: Report): void {
  for (let i = 0; i < bumps.length; i++) {
    for (let k = 0; k < props.length; k++) {
      if (Math.abs(bumps[i].y - props[k].y) > SAME_LEVEL) continue;
      const apart = distance(bumps[i].x, bumps[i].z, props[k].x, props[k].z);
      if (apart < CHUNK_RULES.bumpPropClearance) {
        report.add('bump too close to a pillar', `${fmt(apart)} m apart, need 15`);
      }
    }
  }
}

function checkBumps(ctx: Context, road: Road, report: Report): void {
  const chunk = ctx.chunk;
  const previous = ctx.previous;
  if (chunk.index === 0 && chunk.bumps.length > 0) report.add('bumps in the first chunk', `${chunk.bumps.length} of them`);
  const bends = bendDists(road);
  const hearts = heartsOn(ctx, chunk);
  const openReach = minBumpToOpenEdge(chunk.intensity);
  const dists: number[] = [];
  chunk.bumps.forEach((bump, i) => {
    const label = `bumps[${i}]`;
    const at = projectOnPath(chunk.path, bump.x, bump.z, bump.y, SAME_LEVEL);
    dists.push(at.dist);
    checkBumpSize(bump, label, report);
    if (at.offset > ON_CENTRELINE_SLACK || Math.abs(at.y - bump.y) > ON_SURFACE) {
      report.add('bump is not centred on the road', `${label} is ${fmt(at.offset)} m off the centreline`);
      return;
    }
    checkBumpOnStraight(chunk, bump, at, bends, label, report);
    checkBumpSpan(chunk, road, bump, at, label, report);
    if (nearHeart(hearts, at.dist, at.dist, CHUNK_RULES.crossingKeepOut)) report.add('bump too close to a crossing', label);
    if (openReach > 0 && (openNear(chunk, at.dist, openReach) || (previous && openNear(previous, at.dist, openReach)))) {
      report.add('bump too close to an open edge', `${label} needs ${fmt(openReach)} m`);
    }
  });
  if (previous) dists.push(...bumpDists(previous));
  checkSpacing(dists, CHUNK_RULES.bumpSpacing, 'bumps too close together', report);
  checkBumpsClearOfProps(chunk.bumps, chunk.props, report);
  if (previous) {
    checkBumpsClearOfProps(chunk.bumps, previous.props, report);
    checkBumpsClearOfProps(previous.bumps, chunk.props, report);
  }
  // Bumps of earlier road must not sit at a crossing this chunk makes with it.
  for (const c of ctx.all) {
    if (c === chunk || c.bumps.length === 0) continue;
    const others = heartsOn(ctx, c);
    if (others.length === 0) continue;
    bumpDists(c).forEach((d, i) => {
      if (nearHeart(others, d, d, CHUNK_RULES.crossingKeepOut)) report.add('bump too close to a crossing', `bumps[${i}] of chunk ${c.index}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Supports
// ---------------------------------------------------------------------------------------------------------------

/**
 * Columns hold up the chunk's own raised road from the city floor, and no column of the window stands on, or in the
 * footprint of, another stretch of road.
 */
function checkSupports(ctx: Context, report: Report): void {
  const chunk = ctx.chunk;
  const own = new RoadIndex(4, 16);
  own.add(chunk.path);
  const hits: RoadHit[] = [];
  chunk.supports.forEach((s, i) => {
    const label = `supports[${i}]`;
    if (!(s.radius > 0) || s.radius > 3) report.add('support radius out of range', label);
    if (s.top < TERRAIN_Y + 0.5) report.add('support too short', label);
    const deck = s.top + DECK_THICKNESS;
    own.query(s.x, s.z, 0, hits);
    let holder: RoadHit | null = null;
    for (const hit of hits) if (hit.offset <= hit.halfWidth && Math.abs(hit.y - deck) <= ON_SURFACE) holder = hit;
    if (!holder) {
      report.add('support holds up nothing', label);
      return;
    }
    ctx.index.query(s.x, s.z, s.radius + CHUNK_RULES.supportClearance, ctx.hits);
    if (otherStretch(ctx.hits, holder.dist)) report.add('support stands on a road', label);
  });
  // Columns of earlier chunks must not stand in this chunk's road (a later road crossing under them).
  const b = chunk.bounds;
  for (const c of ctx.all) {
    if (c === chunk) continue;
    const theirs = new RoadIndex(4, 16);
    theirs.add(c.path);
    c.supports.forEach((s, i) => {
      if (s.x < b.minX - 4 || s.x > b.maxX + 4 || s.z < b.minZ - 4 || s.z > b.maxZ + 4) return;
      const deck = s.top + DECK_THICKNESS;
      let holder = NaN;
      for (const hit of theirs.query(s.x, s.z, 0, hits)) if (Math.abs(hit.y - deck) <= ON_SURFACE) holder = hit.dist;
      if (Number.isNaN(holder)) return;
      if (otherStretch(own.query(s.x, s.z, s.radius + CHUNK_RULES.supportClearance, hits), holder)) {
        report.add('support stands on a road', `supports[${i}] of chunk ${c.index} is in the road`);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------------------------------------------

interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One chunk's road as the scenery sees it: every edge (open or not), any closed end, and lines across its ends. */
interface RoadSide {
  index: number;
  edges: WallIndex;
  box: Box;
  road: RoadIndex;
}

function roadSideOf(chunk: TrackChunk): RoadSide {
  const outline: Segment[] = [...chunk.walls];
  polylineSegments(chunk.left, outline);
  polylineSegments(chunk.right, outline);
  const last = chunk.path.length - 1;
  for (const i of [0, last]) outline.push({ ax: chunk.left[i].x, az: chunk.left[i].z, bx: chunk.right[i].x, bz: chunk.right[i].z });
  const box: Box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const s of outline) {
    box.minX = Math.min(box.minX, s.ax, s.bx);
    box.minZ = Math.min(box.minZ, s.az, s.bz);
    box.maxX = Math.max(box.maxX, s.ax, s.bx);
    box.maxZ = Math.max(box.maxZ, s.az, s.bz);
  }
  const road = new RoadIndex(0, 24);
  road.add(chunk.path);
  return { index: chunk.index, edges: new WallIndex(outline), box, road };
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

const roadHits: RoadHit[] = [];

/**
 * A block near a road hides the car from the fixed camera, so its height is tied to its distance from the road's
 * edges; and no block stands on (or under) a road.
 */
function checkBlockClearOfRoad(block: DecorBlock, label: string, side: RoadSide, report: Report): void {
  const needed = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
  const minX = block.x - block.w / 2;
  const minZ = block.z - block.d / 2;
  const box = side.box;
  if (minX > box.maxX + needed || minZ > box.maxZ + needed || minX + block.w < box.minX - needed || minZ + block.d < box.minZ - needed) {
    return;
  }
  const clearance = side.edges.clearance(minX, minZ, minX + block.w, minZ + block.d, needed + 1);
  if (clearance < needed - EPS) {
    report.add(
      'decor too tall or too close to the road',
      `${label} is ${fmt(block.h)} m tall, ${fmt(clearance)} m from the road of chunk ${side.index}, needs ${fmt(needed)} m`,
    );
  }
  if (side.road.query(block.x, block.z, 0, roadHits).length > 0) report.add('decor stands on the road', `${label} on chunk ${side.index}`);
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

/**
 * Scenery of the chunk against the road of every chunk that can be alive with it, scenery of those chunks against
 * this chunk's road, and blocks against blocks.
 */
function checkDecor(ctx: Context, report: Report): void {
  const chunk = ctx.chunk;
  const live = ctx.all.filter((c) => chunk.index - c.index <= CHUNK_RULES.liveWindow);
  const own = roadSideOf(chunk);
  const sides = live.map((c) => (c === chunk ? own : roadSideOf(c)));
  chunk.decor.forEach((block, i) => {
    const label = `decor[${i}]`;
    checkBlockShape(block, label, report);
    for (const side of sides) checkBlockClearOfRoad(block, label, side, report);
  });
  const blocks: LabelledBlock[] = [];
  for (const c of live) {
    if (c === chunk) continue;
    c.decor.forEach((block, i) => {
      const label = `decor[${i}] of chunk ${c.index}`;
      blocks.push({ block, label });
      // Scenery laid down earlier must not end up beside, under or on the road that arrives after it.
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
  const check = (minX: number, minZ: number, maxX: number, maxZ: number, minY: number, maxY: number, label: string): void => {
    const outside =
      minX < b.minX - EPS || minZ < b.minZ - EPS || maxX > b.maxX + EPS || maxZ > b.maxZ + EPS || minY < b.minY - EPS || maxY > b.maxY + EPS;
    if (outside) report.add('bounds do not contain everything', label);
  };
  chunk.path.forEach((p, i) => check(p.x, p.z, p.x, p.z, p.y, p.y, `path[${i}]`));
  chunk.left.forEach((p, i) => check(p.x, p.z, p.x, p.z, chunk.path[i].y, chunk.path[i].y, `left[${i}]`));
  chunk.right.forEach((p, i) => check(p.x, p.z, p.x, p.z, chunk.path[i].y, chunk.path[i].y, `right[${i}]`));
  chunk.walls.forEach((w, i) => {
    const lo = Math.min(w.ya, w.yb);
    const hi = Math.max(w.ya, w.yb) + WALL_HEIGHT;
    check(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz), lo, hi, `walls[${i}]`);
  });
  chunk.props.forEach((p, i) =>
    check(p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius, p.y, p.y + p.height, `props[${i}]`),
  );
  chunk.supports.forEach((s, i) =>
    check(s.x - s.radius, s.z - s.radius, s.x + s.radius, s.z + s.radius, TERRAIN_Y, s.top, `supports[${i}]`),
  );
  chunk.decor.forEach((d, i) =>
    check(d.x - d.w / 2, d.z - d.d / 2, d.x + d.w / 2, d.z + d.d / 2, TERRAIN_Y, TERRAIN_Y + d.h, `decor[${i}]`),
  );
  chunk.bumps.forEach((bump, i) => {
    // The ridge is a rectangle turned to the road; its corners are its extremes.
    const reachX = Math.abs(bump.dirX) * bump.halfLength + Math.abs(bump.dirZ) * bump.halfWidth;
    const reachZ = Math.abs(bump.dirZ) * bump.halfLength + Math.abs(bump.dirX) * bump.halfWidth;
    check(bump.x - reachX, bump.z - reachZ, bump.x + reachX, bump.z + reachZ, bump.y, bump.y + bump.height, `bumps[${i}]`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// One chunk
// ---------------------------------------------------------------------------------------------------------------

/**
 * Returns every broken rule of one chunk as a readable sentence. Pass the chunk before it to also check the join
 * and everything the two chunks must keep clear of in each other (null for a chunk judged on its own), and the
 * chunks before that (oldest first, any beyond the memory window are ignored) to check crossings, open edges,
 * supports and scenery against them too.
 */
export function validateChunk(
  chunk: TrackChunk,
  previous: TrackChunk | null,
  earlier: readonly TrackChunk[] = [],
): ValidationResult {
  const report = new Report();
  checkShape(chunk, report);
  if (report.clean) checkNumbers(chunk, report);
  // The geometric checks index arrays in step and walk spatial grids, so they need sane input.
  if (!report.clean) return report.result();
  const before = previous && isSane(previous) ? previous : null;
  checkPath(chunk, report);
  if (before) checkJoin(chunk, before, report);
  const road = joinedRoad(chunk, before);
  checkHeights(chunk, road, report);
  checkEdgeOffsets(chunk, road, report);
  const ctx = makeContext(chunk, before, earlier.filter(isSane));
  checkRoadOverlap(ctx, report);
  checkEdgeCrossings(ctx, report);
  checkWalls(chunk, report);
  checkOpenEdges(ctx, report);
  checkProps(ctx, report);
  checkBumps(ctx, road, report);
  checkSupports(ctx, report);
  checkDecor(ctx, report);
  checkBounds(chunk, report);
  return report.result();
}

// ---------------------------------------------------------------------------------------------------------------
// A run of chunks
// ---------------------------------------------------------------------------------------------------------------

function checkAllFeatures(chunks: readonly TrackChunk[], report: Report): void {
  const bumpAt: number[] = [];
  const propAt: number[] = [];
  for (const chunk of chunks) {
    bumpAt.push(...bumpDists(chunk));
    propAt.push(...propDists(chunk));
  }
  checkSpacing(bumpAt, CHUNK_RULES.bumpSpacing, 'bumps too close together', report);
  checkSpacing(propAt, RULES.propSpacing, 'props too close together', report);
}

/**
 * Validates every chunk of a run in driving order, each against the one before it and the memory window before
 * that, and then the spacing rules that span the whole run. Per-chunk failures are prefixed with the chunk's index.
 */
export function validateChunkSequence(chunks: readonly TrackChunk[]): ValidationResult {
  const errors: string[] = [];
  let sane = true;
  chunks.forEach((chunk, n) => {
    const from = Math.max(0, n - CHUNK_RULES.memory);
    const verdict = validateChunk(chunk, n > 0 ? chunks[n - 1] : null, chunks.slice(from, Math.max(from, n - 1)));
    for (const error of verdict.errors) errors.push(`chunk ${chunk.index}: ${error}`);
    sane = sane && isSane(chunk);
  });
  if (sane && chunks.length > 1) {
    const report = new Report();
    checkAllFeatures(chunks, report);
    for (const error of report.result().errors) errors.push(`run: ${error}`);
  }
  return { ok: errors.length === 0, errors };
}
