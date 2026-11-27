/**
 * Endless road generator: the road for infinite mode, handed out a chunk at a time.
 *
 * It uses the weekly generator's grid. Every cell holds a straight or a quarter-circle bend, and the road never
 * leaves the cells it walks through. What makes it endless is one rule about the walk: a chunk never goes west of
 * the column it started in, and it always ends in a column further east than any cell laid so far, heading east.
 * Everything east of that column is untouched ground, so the next chunk can always carry on. The road can never
 * dead-end and can never meet itself, however long it runs.
 *
 * How hard a chunk is comes from one number, its intensity, which grows with distance: narrower road, more bends,
 * more pillars, and more bumps placed closer to the bend that follows them.
 *
 * The layout, widths, bumps, pillars and decor of each chunk draw from their own random streams, so tuning the
 * scenery never moves the road.
 */

import { HALF_PI, clamp, lerp, smoothstep } from '../core/fixedMath';
import { Rng } from '../core/rng';
import type {
  Bump,
  DecorBlock,
  Difficulty,
  EndlessGenerator,
  PathPoint,
  Pose,
  Prop,
  Segment,
  TrackChunk,
  Vec2,
} from '../types';
import { CELL, DIR_X, DIR_Z, centrePillar, proposeBlock, pushCellPoint, sidePillar, snap } from './trackGen';
import type { Cell, Centreline, DecorSite, PillarSpot } from './trackGen';
import { RULES, SpatialHash, WallIndex, insideWalls } from './validate';
import { CHUNK_RULES, minBumpBeforeBend } from './validateChunk';

/** Cells of road in one chunk: between about 235 m (all bends) and 288 m (all straights). */
export const ENDLESS_CHUNK_CELLS = 6;

const LAST = ENDLESS_CHUNK_CELLS - 1;
const HALF_CELL = CELL / 2;
/** Travel directions are numbered clockwise from east, as in the weekly generator. */
const EAST = 0;
const WEST = 2;
const PATH_STEP = 3;
const ARC_LENGTH = HALF_PI * HALF_CELL;
const ARC_STEPS = 13;
/** How far the walk may double back west of the furthest column it has reached. */
const MAX_WEST = 2;

// ---------------------------------------------------------------------------------------------------------------
// Intensity
// ---------------------------------------------------------------------------------------------------------------

const START_INTENSITY: Record<Difficulty, number> = { easy: 0.1, medium: 0.35, hard: 0.6 };
/** +0.1 per kilometre. */
const INTENSITY_PER_METRE = 0.0001;
/** Below this the road is gentle: one bend at a time, and bumps keep well away from bends. */
const GENTLE = CHUNK_RULES.gentleIntensity;

/** How hard the road is `dist` metres into a run: 0 is gentle, 1 is as harsh as it gets. */
export function intensityAt(difficulty: Difficulty, dist: number): number {
  return clamp(START_INTENSITY[difficulty] + Math.max(dist, 0) * INTENSITY_PER_METRE, 0, 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------------------------

/** Chance that a cell following straight road turns, at intensity 0 and 1. */
const TURN_CHANCE_GENTLE = 0.2;
const TURN_CHANCE_HARSH = 0.8;
const HAIRPIN_BIAS = 2.6;

const BASE_HALF_WIDTH_GENTLE = 11.5;
const BASE_HALF_WIDTH_HARSH = 8;
const BASE_HALF_WIDTH_JITTER = 0.3;
const MIN_BASE_HALF_WIDTH = 7.6;
const MAX_CORNER_HALF_WIDTH = 12.5;
const MIN_PLAZA_HALF_WIDTH = 15;
const MAX_PLAZA_HALF_WIDTH = 19;
const PLAZA_CHANCE_GENTLE = 0.26;
const PLAZA_CHANCE_HARSH = 0.3;
const NARROW_CHANCE_GENTLE = 0.04;
const NARROW_CHANCE_HARSH = 0.2;
/** Distance over which the road changes width. A plaza tapers more gently because it changes by more. */
const BLEND = 16;
const PLAZA_BLEND = 20;
/** Either side of a chunk join the road holds the width the two chunks agreed on. */
const JOIN_HOLD = 15;
/** The closed end behind the start. */
const START_CAP = 14;

const BUMPS_PER_CHUNK_GENTLE = 0.2;
const BUMPS_PER_CHUNK_HARSH = 1.3;
const MAX_BUMPS = 2;
/** The validator measures along rounded coordinates, so the generator keeps a little inside every limit. */
const BUMP_SLACK = 0.25;
const BUMP_SPACING = CHUNK_RULES.bumpSpacing + 1;
const BUMP_JOIN_CLEARANCE = CHUNK_RULES.bumpJoinClearance + 1;
/** Straight road before a crest when a bend leads up to it: room to straighten the car out. */
const BUMP_AFTER_BEND = CHUNK_RULES.bumpBendGapGentle + BUMP_SLACK;
/** A crest keeps this far from the next cell so the whole ridge stays in its own cell. */
const BUMP_CELL_MARGIN = 8;
const BUMP_MIN_HEIGHT_GENTLE = 0.35;
const BUMP_MIN_HEIGHT_HARSH = 0.65;
const BUMP_HEIGHT_SPREAD = 0.15;
/** The ridge reaches this far past the road edge at its crest, so it spans wall to wall. */
const BUMP_OVERHANG = 1;

const MAX_PILLARS = 2;
/** Chance of a pillar per suitable cell at intensity 0 and 1. It rises with the square of the intensity. */
const PLAZA_PILLAR_CHANCE_GENTLE = 0.08;
const PLAZA_PILLAR_CHANCE_HARSH = 0.9;
const STRAIGHT_PILLAR_CHANCE_GENTLE = 0.02;
const STRAIGHT_PILLAR_CHANCE_HARSH = 0.85;
const CENTRE_PILLAR_MIN_HALF_WIDTH = 17;
/**
 * How far a pillar may sit from the middle of its cell, which keeps it out of width changes, and in the cells
 * at either end of a chunk keeps it clear of the join.
 */
const PLAZA_PILLAR_REACH = 3;
const STRAIGHT_PILLAR_REACH = 7;
const JOIN_PILLAR_REACH = 3;
/** The validator measures spacing between rounded positions, which can read a little short. */
const PROP_SPACING = RULES.propSpacing + 4;
const PROP_BUMP_CLEARANCE = CHUNK_RULES.bumpPropClearance + 5;
const PROP_HUES = 6;

const DECOR_RINGS = 2;
const OUTER_RING_CHANCE = 0.6;
const DECOR_TARGET_MIN = 40;
const DECOR_TARGET_MAX = 90;
/** Share of the blocks spent on the street front, and how far from the road that front reaches. */
const DECOR_FRONT_SHARE = 0.6;
const DECOR_FRONT_DEPTH = 34;
const DECOR_FRONT_PASSES = 8;
const DECOR_SKYLINE_PASSES = 12;
const DECOR_GAP = 2;
const DECOR_BUCKET = 24;
/** Scenery is checked against the road of this many chunks behind it, and never reaches further back than that. */
const DECOR_MEMORY = 2;

/** The grid has no edge, so cells are keyed over a far wider range than the weekly generator needs. */
const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 1 << 21;

function cellKey(cx: number, cz: number): number {
  return (cx + KEY_OFFSET) * KEY_SPAN + (cz + KEY_OFFSET);
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: a self-avoiding walk that always ends further east than it has ever been
// ---------------------------------------------------------------------------------------------------------------

interface Walk {
  rng: Rng;
  /** Every cell that holds road, from the start of the run. */
  used: Set<number>;
  intensity: number;
  firstChunk: boolean;
  /** Straight cells that ended the previous chunk. */
  straightTail: number;
  cx: number[];
  cz: number[];
  /** out[k] is the travel direction on leaving cell k. Cell 0 is always entered heading east. */
  out: number[];
  /** furthest[k] is the easternmost column among cells 0..k. */
  furthest: number[];
}

function inDirOf(walk: Walk, k: number): number {
  return k === 0 ? EAST : walk.out[k - 1];
}

function isBend(walk: Walk, k: number): boolean {
  return inDirOf(walk, k) !== walk.out[k];
}

/** How many bends in a row lead up to cell k. */
function bendsBefore(walk: Walk, k: number): number {
  let run = 0;
  while (k - 1 - run >= 0 && isBend(walk, k - 1 - run)) run++;
  return run;
}

/** How many straight cells in a row lead up to cell k, counting back into the previous chunk. */
function straightsBefore(walk: Walk, k: number): number {
  let run = 0;
  while (k - 1 - run >= 0 && !isBend(walk, k - 1 - run)) run++;
  return k - 1 - run < 0 ? run + walk.straightTail : run;
}

/** -1 left, 0 straight on, +1 right. */
function turnBetween(from: number, to: number): number {
  const delta = (to - from + 4) & 3;
  return delta === 3 ? -1 : delta;
}

/** How attractive it is to leave cell k in direction `dir`. Shapes the mix of straights, S-bends and hairpins. */
function moveWeight(walk: Walk, k: number, dir: number): number {
  const i = walk.intensity;
  const inDir = inDirOf(walk, k);
  const turnChance = lerp(TURN_CHANCE_GENTLE, TURN_CHANCE_HARSH, i);
  if (dir === inDir) {
    const longStraight = straightsBefore(walk, k) >= (i < 0.5 ? 3 : 2);
    return (1 - turnChance) * (longStraight ? 0.35 : 1);
  }
  const bends = bendsBefore(walk, k);
  let chain = 1;
  if (bends > 0) {
    // A gentle road never puts two bends in consecutive cells.
    if (i < GENTLE) return 0;
    // A second bend the same way makes a hairpin; the other way makes an S-bend. Hairpins are rarer by nature
    // (only a bend that ends up heading east can be followed by one), so a harsh road leans towards them.
    const sameWay = turnBetween(inDir, dir) === turnBetween(inDirOf(walk, k - 1), inDir);
    const shape = sameWay ? lerp(1, HAIRPIN_BIAS, smoothstep(0.5, 1, i)) : 0.9;
    // Longer chains of bends stay rare, so the road breathes between them.
    chain = shape * (bends === 1 ? lerp(0.35, 1.1, smoothstep(GENTLE, 0.8, i)) : 0.3 * smoothstep(0.4, 1, i));
  }
  const heading = dir === EAST ? 1.3 : dir === WEST ? 0.5 : 1;
  return (turnChance / 2) * chain * heading;
}

/** The ways out of cell k that the rules allow, in a weighted random order. */
function moveOptions(walk: Walk, k: number): number[] {
  // The run opens with straight road: a cell and a half of it before anything else may happen.
  if (walk.firstChunk && k < 2) return [EAST];
  const inDir = inDirOf(walk, k);
  const pool: number[] = [];
  const weights: number[] = [];
  for (const dir of [inDir, (inDir + 1) & 3, (inDir + 3) & 3]) {
    const weight = moveWeight(walk, k, dir);
    if (weight <= 0) continue;
    pool.push(dir);
    weights.push(weight);
  }
  const order: number[] = [];
  while (pool.length > 1) {
    let total = 0;
    for (let n = 0; n < weights.length; n++) total += weights[n];
    let pick = 0;
    let roll = walk.rng.next() * total;
    while (pick < pool.length - 1 && roll >= weights[pick]) roll -= weights[pick++];
    order.push(pool[pick]);
    pool.splice(pick, 1);
    weights.splice(pick, 1);
  }
  if (pool.length === 1) order.push(pool[0]);
  return order;
}

/**
 * Depth-first: tries each way out of cell k and backs up when every way is blocked. It cannot fail, because
 * driving straight east from the first cell is always open: nothing has ever been laid east of where a chunk starts.
 */
function extendWalk(walk: Walk, k: number): boolean {
  if (k === LAST) {
    walk.out[k] = EAST;
    return true;
  }
  for (const dir of moveOptions(walk, k)) {
    const cx = walk.cx[k] + DIR_X[dir];
    const cz = walk.cz[k] + DIR_Z[dir];
    if (cx < walk.cx[0] || cx < walk.furthest[k] - MAX_WEST) continue;
    // The last cell is entered heading east and opens a column no road has reached before.
    if (k === LAST - 1 && (dir !== EAST || cx <= walk.furthest[k])) continue;
    const key = cellKey(cx, cz);
    if (walk.used.has(key)) continue;
    walk.out[k] = dir;
    walk.cx[k + 1] = cx;
    walk.cz[k + 1] = cz;
    walk.furthest[k + 1] = Math.max(walk.furthest[k], cx);
    walk.used.add(key);
    if (extendWalk(walk, k + 1)) return true;
    walk.used.delete(key);
  }
  return false;
}

/** The chunk's cells in driving order, measured from the start of the chunk. */
function cellsFromWalk(walk: Walk): Cell[] {
  const cells: Cell[] = [];
  let startDist = 0;
  let firstIndex = 0;
  for (let k = 0; k < ENDLESS_CHUNK_CELLS; k++) {
    const inDir = inDirOf(walk, k);
    const outDir = walk.out[k];
    const corner = inDir !== outDir;
    // The run starts at the centre of its first cell; everywhere else the road runs edge to edge.
    const entryOffset = walk.firstChunk && k === 0 ? 0 : -HALF_CELL;
    const length = corner ? ARC_LENGTH : HALF_CELL - entryOffset;
    const steps = corner ? ARC_STEPS : Math.round(length / PATH_STEP);
    cells.push({
      cx: walk.cx[k],
      cz: walk.cz[k],
      inDir,
      outDir,
      kind: corner ? 'corner' : 'straight',
      midWidth: 0,
      entryOffset,
      exitOffset: HALF_CELL,
      length,
      startDist,
      steps,
      firstIndex,
    });
    startDist += length;
    firstIndex += steps;
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------------------------
// Widths
// ---------------------------------------------------------------------------------------------------------------

interface WidthPlan {
  base: number;
  corner: number;
  /** Half width at the start of the chunk: the base width of the chunk before it. */
  entry: number;
}

/** True when the cells to the left and right of a straight hold no road, so a wide plaza has nothing to crowd. */
function hasOpenSides(cell: Cell, used: Set<number>): boolean {
  const sideX = -DIR_Z[cell.inDir];
  const sideZ = DIR_X[cell.inDir];
  return !used.has(cellKey(cell.cx - sideX, cell.cz - sideZ)) && !used.has(cellKey(cell.cx + sideX, cell.cz + sideZ));
}

function planWidths(
  rng: Rng,
  cells: Cell[],
  used: Set<number>,
  intensity: number,
  entry: number | null,
  firstChunk: boolean,
): WidthPlan {
  const wanted = lerp(BASE_HALF_WIDTH_GENTLE, BASE_HALF_WIDTH_HARSH, intensity);
  const base = Math.max(MIN_BASE_HALF_WIDTH, wanted + rng.range(-BASE_HALF_WIDTH_JITTER, BASE_HALF_WIDTH_JITTER));
  const corner = Math.min(MAX_CORNER_HALF_WIDTH, base + rng.range(0.8, 2.2));
  const plazaChance = lerp(PLAZA_CHANCE_GENTLE, PLAZA_CHANCE_HARSH, intensity);
  const narrowChance = lerp(NARROW_CHANCE_GENTLE, NARROW_CHANCE_HARSH, intensity);
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    cell.midWidth = cell.kind === 'corner' ? corner : base;
    // The cells at both ends stay plain so every join is predictable, and so does the road right after the start.
    if (cell.kind !== 'straight' || k === 0 || k === LAST || (firstChunk && k < 2)) continue;
    const roll = rng.next();
    const size = rng.next();
    // Two plazas in a row are wider than they are far apart, which reads as a road folded onto itself.
    if (roll < plazaChance && hasOpenSides(cell, used) && cells[k - 1].kind !== 'plaza') {
      cell.kind = 'plaza';
      cell.midWidth = lerp(MIN_PLAZA_HALF_WIDTH, MAX_PLAZA_HALF_WIDTH, size);
    } else if (roll > 1 - narrowChance) {
      cell.kind = 'narrow';
      cell.midWidth = Math.max(RULES.minHalfWidth, base - lerp(1.5, 3, size));
    }
  }
  return { base, corner, entry: entry ?? base };
}

/** Half width on the line between two neighbouring cells. Bends keep their full width right up to both ends. */
function joinWidth(cells: readonly Cell[], plan: WidthPlan, before: number, after: number): number {
  if (before < 0) return plan.entry;
  if (after >= cells.length) return plan.base;
  return cells[before].kind === 'corner' || cells[after].kind === 'corner' ? plan.corner : plan.base;
}

/**
 * Half width `s` metres into a cell: its own width in the middle, blended to the shared width at each end. The
 * first and last cells also hold their outer width for JOIN_HOLD metres, so the road is the same on both sides of
 * a join whatever the next chunk turns out to be.
 */
function halfWidthAt(cells: readonly Cell[], plan: WidthPlan, index: number, s: number): number {
  const cell = cells[index];
  const blend = cell.kind === 'plaza' ? PLAZA_BLEND : BLEND;
  const lead = index === 0 ? JOIN_HOLD : 0;
  if (s < lead + blend) {
    return lerp(joinWidth(cells, plan, index - 1, index), cell.midWidth, smoothstep(0, blend, s - lead));
  }
  const tail = index === cells.length - 1 ? JOIN_HOLD : 0;
  const remaining = cell.length - s;
  if (remaining < tail + blend) {
    return lerp(joinWidth(cells, plan, index, index + 1), cell.midWidth, smoothstep(0, blend, remaining - tail));
  }
  return cell.midWidth;
}

// ---------------------------------------------------------------------------------------------------------------
// Road geometry
// ---------------------------------------------------------------------------------------------------------------

/** The centreline, with `dist` measured from the start of the chunk. */
function sampleCentreline(cells: readonly Cell[], plan: WidthPlan): Centreline {
  const line: Centreline = { x: [], z: [], halfWidth: [], dist: [] };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    // A cell's entry point is the previous cell's exit point, already emitted.
    for (let k = i === 0 ? 0 : 1; k <= cell.steps; k++) {
      const t = k / cell.steps;
      pushCellPoint(line, cell, t);
      line.halfWidth.push(halfWidthAt(cells, plan, i, t * cell.length));
      line.dist.push(cell.startDist + t * cell.length);
    }
  }
  return line;
}

interface Road {
  path: PathPoint[];
  left: Vec2[];
  right: Vec2[];
}

/** The last point of a chunk, which the next chunk repeats exactly as its first. */
interface Join {
  point: PathPoint;
  left: Vec2;
  right: Vec2;
}

/**
 * Offsets the centreline to both sides and snaps everything to the lattice. Inside the chunk the normal comes
 * from a central difference, as in the weekly generator. At a join the road is known to head exactly east, and
 * using that keeps the walls of two chunks meeting without a gap whatever follows.
 */
function buildRoad(line: Centreline, startDist: number, join: Join | null): Road {
  const road: Road = { path: [], left: [], right: [] };
  const last = line.x.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i === 0 && join) {
      road.path.push({ ...join.point });
      road.left.push({ ...join.left });
      road.right.push({ ...join.right });
      continue;
    }
    const tx = i === last ? 1 : line.x[i + 1] - line.x[i > 0 ? i - 1 : 0];
    const tz = i === last ? 0 : line.z[i + 1] - line.z[i > 0 ? i - 1 : 0];
    const reach = line.halfWidth[i] / Math.sqrt(tx * tx + tz * tz);
    // Right of the travel direction (tx, tz) is (-tz, tx).
    road.right.push({ x: snap(line.x[i] - tz * reach), z: snap(line.z[i] + tx * reach) });
    road.left.push({ x: snap(line.x[i] + tz * reach), z: snap(line.z[i] - tx * reach) });
    road.path.push({
      x: snap(line.x[i]),
      z: snap(line.z[i]),
      halfWidth: snap(line.halfWidth[i]),
      dist: snap(startDist + line.dist[i]),
    });
  }
  return road;
}

function pushEdge(walls: Segment[], edge: readonly Vec2[]): void {
  for (let i = 0; i + 1 < edge.length; i++) {
    walls.push({ ax: edge[i].x, az: edge[i].z, bx: edge[i + 1].x, bz: edge[i + 1].z });
  }
}

/** Both edges in driving order, and for the first chunk the closed end behind the start. The far end is open. */
function buildWalls(road: Road, firstChunk: boolean): Segment[] {
  const walls: Segment[] = [];
  pushEdge(walls, road.left);
  pushEdge(walls, road.right);
  if (firstChunk) {
    const l = road.left[0];
    const r = road.right[0];
    pushEdge(walls, [l, { x: l.x - START_CAP, z: l.z }, { x: r.x - START_CAP, z: r.z }, r]);
  }
  return walls;
}

/** The chunk's road as a closed outline for inside tests: its walls plus a line across each open end. */
function outlineOf(road: Road, walls: readonly Segment[], firstChunk: boolean): Segment[] {
  const outline = walls.slice();
  const last = road.path.length - 1;
  pushEdge(outline, [road.left[last], road.right[last]]);
  if (!firstChunk) pushEdge(outline, [road.left[0], road.right[0]]);
  return outline;
}

// ---------------------------------------------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------------------------------------------

interface BumpPlan {
  bumps: Bump[];
  /** Position of each crest along the whole road. */
  dists: number[];
  /** Per cell: whether it holds a bump. */
  cells: boolean[];
}

/** The widest the road gets under a ridge of the given half length. */
function widestUnder(cells: readonly Cell[], plan: WidthPlan, index: number, s: number, halfLength: number): number {
  let widest = halfWidthAt(cells, plan, index, s);
  for (let offset = -halfLength; offset <= halfLength; offset += 0.5) {
    widest = Math.max(widest, halfWidthAt(cells, plan, index, s + offset));
  }
  return Math.max(widest, halfWidthAt(cells, plan, index, s + halfLength));
}

/**
 * Picks where in a plain straight cell a crest may go, or null when the cell is unsuitable. A gentle road leaves
 * 45 m of straight after every crest, room to land and still brake for the bend, which rules out the straight
 * that leads into a bend and the last straight of the chunk altogether. As the intensity rises the crest is
 * allowed, and then encouraged, to sit just before the bend that follows: the car lands with the road already
 * turning away under it.
 *
 * It draws the same random numbers whether or not the cell turns out to be suitable.
 */
function bumpSpot(
  rng: Rng,
  cells: readonly Cell[],
  k: number,
  intensity: number,
): { s: number; halfLength: number } | null {
  const cell = cells[k];
  const afterBend = k > 0 && cells[k - 1].kind === 'corner';
  const beforeBend = k < LAST && cells[k + 1].kind === 'corner';
  const toBend = minBumpBeforeBend(intensity) + BUMP_SLACK;
  const lo = afterBend ? BUMP_AFTER_BEND : k === 0 ? BUMP_JOIN_CLEARANCE : BUMP_CELL_MARGIN;
  // The next chunk may open with a bend, so the end of the chunk is treated as one.
  const toEnd = beforeBend ? toBend : k === LAST ? Math.max(BUMP_JOIN_CLEARANCE, toBend) : BUMP_CELL_MARGIN;
  const hi = cell.length - toEnd;
  const daring = rng.chance(smoothstep(GENTLE, 1, intensity));
  const spread = rng.next();
  const wanted = rng.range(CHUNK_RULES.bumpMinHalfLength, CHUNK_RULES.bumpMaxHalfLength);
  if (hi < lo) return null;
  const s = beforeBend && daring ? hi - spread * Math.min(3, hi - lo) : lerp(lo, hi, spread);
  // The whole ridge stays on straight road.
  const halfLength = beforeBend ? Math.min(wanted, cell.length - s - BUMP_SLACK) : wanted;
  return { s, halfLength };
}

function placeBumps(
  rng: Rng,
  cells: readonly Cell[],
  plan: WidthPlan,
  startDist: number,
  intensity: number,
  lastBumpDist: number,
): BumpPlan {
  const out: BumpPlan = { bumps: [], dists: [], cells: cells.map(() => false) };
  const rate = lerp(BUMPS_PER_CHUNK_GENTLE, BUMPS_PER_CHUNK_HARSH, intensity);
  const whole = Math.floor(rate);
  const wanted = Math.min(MAX_BUMPS, whole + (rng.chance(rate - whole) ? 1 : 0));
  const sites: number[] = [];
  for (let k = 0; k < cells.length; k++) if (cells[k].kind === 'straight') sites.push(k);
  rng.shuffle(sites);
  // A harsh road prefers the straights that lead into a bend.
  if (rng.chance(smoothstep(GENTLE, 1, intensity))) {
    const leadsIntoBend = (k: number): number => (k < LAST && cells[k + 1].kind === 'corner' ? 0 : 1);
    sites.sort((a, b) => leadsIntoBend(a) - leadsIntoBend(b));
  }
  for (const k of sites) {
    const cell = cells[k];
    const spot = bumpSpot(rng, cells, k, intensity);
    const height = lerp(BUMP_MIN_HEIGHT_GENTLE, BUMP_MIN_HEIGHT_HARSH, intensity) + rng.range(0, BUMP_HEIGHT_SPREAD);
    if (spot === null || out.bumps.length >= wanted) continue;
    const dist = startDist + cell.startDist + spot.s;
    let clear = dist - lastBumpDist >= BUMP_SPACING;
    for (let n = 0; n < out.dists.length; n++) clear = clear && Math.abs(dist - out.dists[n]) >= BUMP_SPACING;
    if (!clear) continue;
    const dirX = DIR_X[cell.inDir];
    const dirZ = DIR_Z[cell.inDir];
    const along = cell.entryOffset + spot.s;
    const atCrest = halfWidthAt(cells, plan, k, spot.s);
    const widest = widestUnder(cells, plan, k, spot.s, spot.halfLength);
    out.bumps.push({
      x: snap(cell.cx * CELL + dirX * along),
      z: snap(cell.cz * CELL + dirZ * along),
      // A straight cell runs along a grid axis, so its direction is an exact unit vector.
      dirX,
      dirZ,
      halfLength: snap(spot.halfLength),
      halfWidth: snap(Math.max(atCrest + BUMP_OVERHANG, widest + BUMP_SLACK)),
      height: snap(height),
    });
    out.dists.push(dist);
    out.cells[k] = true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

function pillarSpot(
  rng: Rng,
  cells: readonly Cell[],
  plan: WidthPlan,
  k: number,
  intensity: number,
): PillarSpot | null {
  const cell = cells[k];
  const eagerness = intensity * intensity;
  if (cell.kind === 'plaza') {
    if (!rng.chance(lerp(PLAZA_PILLAR_CHANCE_GENTLE, PLAZA_PILLAR_CHANCE_HARSH, eagerness))) return null;
    if (cell.midWidth >= CENTRE_PILLAR_MIN_HALF_WIDTH && rng.chance(0.7)) return centrePillar(rng);
    return sidePillar(rng, cell.midWidth, PLAZA_PILLAR_REACH);
  }
  if (cell.kind !== 'straight') return null;
  if (!rng.chance(lerp(STRAIGHT_PILLAR_CHANCE_GENTLE, STRAIGHT_PILLAR_CHANCE_HARSH, eagerness))) return null;
  // The first cell is still changing from the previous chunk's width to this one's: stand by the narrower.
  if (k === 0) return sidePillar(rng, Math.min(plan.entry, plan.base), JOIN_PILLAR_REACH);
  return sidePillar(rng, cell.midWidth, k === LAST ? JOIN_PILLAR_REACH : STRAIGHT_PILLAR_REACH);
}

function placeProps(
  rng: Rng,
  cells: readonly Cell[],
  plan: WidthPlan,
  startDist: number,
  intensity: number,
  lastPropDist: number,
  bumps: BumpPlan,
): { props: Prop[]; lastDist: number } {
  const props: Prop[] = [];
  let lastDist = lastPropDist;
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    const spot = pillarSpot(rng, cells, plan, k, intensity);
    if (!spot || bumps.cells[k] || props.length >= MAX_PILLARS) continue;
    const dist = startDist + cell.startDist + HALF_CELL + spot.along;
    if (dist - lastDist < PROP_SPACING) continue;
    let clear = true;
    for (let n = 0; n < bumps.dists.length; n++) {
      clear = clear && Math.abs(dist - bumps.dists[n]) >= PROP_BUMP_CLEARANCE;
    }
    if (!clear) continue;
    lastDist = dist;
    const dirX = DIR_X[cell.inDir];
    const dirZ = DIR_Z[cell.inDir];
    props.push({
      kind: 'pillar',
      x: snap(cell.cx * CELL + dirX * spot.along - dirZ * spot.lateral),
      z: snap(cell.cz * CELL + dirZ * spot.along + dirX * spot.lateral),
      radius: snap(spot.radius),
      height: snap(rng.range(3, 7)),
      hue: rng.int(PROP_HUES),
    });
  }
  return { props, lastDist };
}

// ---------------------------------------------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------------------------------------------

/** What scenery needs to know about one chunk's road, and the scenery already standing beside it. */
interface Surroundings {
  walls: WallIndex;
  outline: Segment[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  decor: DecorBlock[];
}

function surroundingsOf(road: Road, walls: Segment[], firstChunk: boolean): Surroundings {
  const around: Surroundings = {
    walls: new WallIndex(walls),
    outline: outlineOf(road, walls, firstChunk),
    minX: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxZ: -Infinity,
    decor: [],
  };
  for (const w of walls) {
    around.minX = Math.min(around.minX, w.ax, w.bx);
    around.minZ = Math.min(around.minZ, w.az, w.bz);
    around.maxX = Math.max(around.maxX, w.ax, w.bx);
    around.maxZ = Math.max(around.maxZ, w.az, w.bz);
  }
  return around;
}

/**
 * Every cell within DECOR_RINGS of the chunk's road, between the two columns scenery may use, in a shuffled order
 * so that a capped count stays evenly spread.
 */
function decorSites(rng: Rng, cells: readonly Cell[]): DecorSite[] {
  const westmost = cells[0].cx - DECOR_MEMORY;
  const eastmost = cells[LAST].cx;
  const known = new Map<number, DecorSite>();
  let frontier: DecorSite[] = cells.map((cell) => ({ cx: cell.cx, cz: cell.cz, ring: 0 }));
  for (const site of frontier) known.set(cellKey(site.cx, site.cz), site);
  for (let ring = 1; ring <= DECOR_RINGS; ring++) {
    const next: DecorSite[] = [];
    for (const site of frontier) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = cellKey(site.cx + dx, site.cz + dz);
          if (known.has(key)) continue;
          const found: DecorSite = { cx: site.cx + dx, cz: site.cz + dz, ring };
          known.set(key, found);
          next.push(found);
        }
      }
    }
    frontier = next;
  }
  const sites: DecorSite[] = [];
  for (const site of known.values()) {
    if (site.cx < westmost || site.cx > eastmost) continue;
    if (site.ring < DECOR_RINGS || rng.chance(OUTER_RING_CHANCE)) sites.push(site);
  }
  return rng.shuffle(sites);
}

/**
 * The accepted blocks of one chunk plus the lookups that keep them off the road and off each other.
 *
 * Scenery has to respect road that does not exist yet. The next chunk may put road anywhere east of this chunk's
 * exit, so that line is treated as a wall: nothing crosses it, and the closer a block stands to it the lower it
 * has to be. To the west a block is checked against the road and scenery of the DECOR_MEMORY chunks before this
 * one, and may not reach past the columns those checks cover.
 */
class DecorField {
  readonly blocks: DecorBlock[] = [];
  private readonly around: readonly Surroundings[];
  private readonly westLimit: number;
  private readonly eastLimit: number;
  private readonly placed = new SpatialHash(DECOR_BUCKET);
  private readonly near: number[] = [];

  /** `around` lists this chunk's surroundings and those of the chunks before it. */
  constructor(around: readonly Surroundings[], westLimit: number, eastLimit: number) {
    this.around = around;
    this.westLimit = westLimit;
    this.eastLimit = eastLimit;
  }

  private static tooClose(block: DecorBlock, other: DecorBlock): boolean {
    const apartX = Math.abs(other.x - block.x) - (other.w + block.w) / 2 - DECOR_GAP;
    const apartZ = Math.abs(other.z - block.z) - (other.d + block.d) / 2 - DECOR_GAP;
    return apartX < 0 && apartZ < 0;
  }

  private crowded(block: DecorBlock): boolean {
    const reachX = block.w / 2 + DECOR_GAP;
    const reachZ = block.d / 2 + DECOR_GAP;
    this.placed.collect(block.x - reachX, block.z - reachZ, block.x + reachX, block.z + reachZ, this.near);
    for (let k = 0; k < this.near.length; k++) {
      if (DecorField.tooClose(block, this.blocks[this.near[k]])) return true;
    }
    for (const chunk of this.around) {
      for (let k = 0; k < chunk.decor.length; k++) {
        if (DecorField.tooClose(block, chunk.decor[k])) return true;
      }
    }
    return false;
  }

  /**
   * Adds the block if it is clear of every road and of other blocks, cutting its height down to what its distance
   * from the road allows. Blocks `maxClearance` or more from the road are turned away (pass Infinity to accept
   * any distance).
   */
  tryAdd(block: DecorBlock, maxClearance: number): boolean {
    const minX = block.x - block.w / 2;
    const minZ = block.z - block.d / 2;
    const maxX = minX + block.w;
    const maxZ = minZ + block.d;
    const toFuture = this.eastLimit - maxX;
    if (minX < this.westLimit || toFuture < RULES.decorMinClearance) return false;
    if (this.crowded(block)) return false;
    const wanted = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
    let toRoad = maxClearance < Infinity ? Math.max(wanted, maxClearance) : wanted;
    for (const chunk of this.around) {
      toRoad = chunk.walls.clearance(minX, minZ, maxX, maxZ, toRoad);
      if (toRoad < RULES.decorMinClearance) return false;
    }
    if (toRoad >= maxClearance) return false;
    for (const chunk of this.around) {
      const inBox = block.x >= chunk.minX && block.x <= chunk.maxX && block.z >= chunk.minZ && block.z <= chunk.maxZ;
      if (inBox && insideWalls(chunk.outline, block.x, block.z)) return false;
    }
    const clearance = Math.min(toRoad, toFuture);
    // Rounded down, never up: the height must stay inside the clearance rule after snapping.
    block.h = Math.floor(Math.min(block.h, clearance * RULES.decorHeightPerClearance) * 1024) / 1024;
    this.placed.insert(this.blocks.length, minX, minZ, maxX, maxZ);
    this.blocks.push(block);
    return true;
  }
}

/** Proposes one block per site per pass until the field holds `quota` blocks or the passes run out. */
function fillDecor(
  rng: Rng,
  field: DecorField,
  sites: readonly DecorSite[],
  quota: number,
  passes: number,
  maxClearance: number,
): void {
  for (let pass = 0; pass < passes; pass++) {
    for (const site of sites) {
      if (field.blocks.length >= quota) return;
      field.tryAdd(proposeBlock(rng, site), maxClearance);
    }
  }
}

function scatterDecor(rng: Rng, cells: readonly Cell[], around: readonly Surroundings[]): DecorBlock[] {
  const sites = decorSites(rng, cells);
  const target = DECOR_TARGET_MIN + rng.int(DECOR_TARGET_MAX - DECOR_TARGET_MIN + 1);
  const westLimit = (cells[0].cx - DECOR_MEMORY) * CELL - HALF_CELL;
  const eastLimit = cells[LAST].cx * CELL + HALF_CELL;
  const field = new DecorField(around, westLimit, eastLimit);
  // The street front first: the locked camera mostly sees what stands beside the road.
  const front = sites.filter((site) => site.ring <= 1);
  fillDecor(rng, field, front, Math.round(target * DECOR_FRONT_SHARE), DECOR_FRONT_PASSES, DECOR_FRONT_DEPTH);
  fillDecor(rng, field, sites, target, DECOR_SKYLINE_PASSES, Infinity);
  return field.blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------------------------

function boundsOf(
  walls: readonly Segment[],
  decor: readonly DecorBlock[],
  bumps: readonly Bump[],
): TrackChunk['bounds'] {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const include = (minX: number, minZ: number, maxX: number, maxZ: number): void => {
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minZ = Math.min(bounds.minZ, minZ);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxZ = Math.max(bounds.maxZ, maxZ);
  };
  // The walls enclose the path and every prop.
  for (const w of walls) {
    include(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz));
  }
  for (const b of decor) include(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2);
  // A ridge reaches a little past the walls on both sides.
  for (const b of bumps) {
    const reachX = Math.abs(b.dirX) * b.halfLength + Math.abs(b.dirZ) * b.halfWidth;
    const reachZ = Math.abs(b.dirZ) * b.halfLength + Math.abs(b.dirX) * b.halfWidth;
    include(b.x - reachX, b.z - reachZ, b.x + reachX, b.z + reachZ);
  }
  // Half a block size can fall between lattice points: round outwards so the bounds still hold everything.
  return {
    minX: Math.floor(bounds.minX * 1024) / 1024 + 0,
    minZ: Math.floor(bounds.minZ * 1024) / 1024 + 0,
    maxX: Math.ceil(bounds.maxX * 1024) / 1024 + 0,
    maxZ: Math.ceil(bounds.maxZ * 1024) / 1024 + 0,
  };
}

class Generator implements EndlessGenerator {
  readonly seed: string;
  readonly difficulty: Difficulty;
  readonly start: Pose = { x: 0, z: 0, heading: 0 };
  private readonly rng: Rng;
  private readonly used = new Set<number>();
  private index = 0;
  /** The cell the next chunk starts in. */
  private entryX = 0;
  private entryZ = 0;
  private join: Join | null = null;
  /** Base half width of the chunk before the next one, unrounded. */
  private entryWidth: number | null = null;
  private straightTail = 0;
  private lastBumpDist = -Infinity;
  private lastPropDist = -Infinity;
  /** Surroundings of the last DECOR_MEMORY chunks, oldest first. */
  private recent: Surroundings[] = [];

  constructor(seed: string, difficulty: Difficulty) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.rng = new Rng(`${seed}|endless|${difficulty}`);
  }

  private walk(index: number, intensity: number): Walk {
    const walk: Walk = {
      rng: this.rng.fork(`layout:${index}`),
      used: this.used,
      intensity,
      firstChunk: index === 0,
      straightTail: this.straightTail,
      cx: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryX),
      cz: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryZ),
      out: new Array<number>(ENDLESS_CHUNK_CELLS).fill(EAST),
      furthest: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryX),
    };
    this.used.add(cellKey(this.entryX, this.entryZ));
    if (!extendWalk(walk, 0)) throw new Error('endless layout walk found no route');
    return walk;
  }

  next(): TrackChunk {
    const index = this.index++;
    const firstChunk = index === 0;
    const startDist = this.join ? this.join.point.dist : 0;
    const intensity = intensityAt(this.difficulty, startDist);

    const walk = this.walk(index, intensity);
    const cells = cellsFromWalk(walk);
    const plan = planWidths(this.rng.fork(`width:${index}`), cells, this.used, intensity, this.entryWidth, firstChunk);
    const road = buildRoad(sampleCentreline(cells, plan), startDist, this.join);
    const walls = buildWalls(road, firstChunk);

    // The first chunk is a warm-up: plain road with nothing on it.
    const bumps = firstChunk
      ? { bumps: [], dists: [], cells: cells.map(() => false) }
      : placeBumps(this.rng.fork(`bumps:${index}`), cells, plan, startDist, intensity, this.lastBumpDist);
    const pillars = firstChunk
      ? { props: [], lastDist: this.lastPropDist }
      : placeProps(this.rng.fork(`props:${index}`), cells, plan, startDist, intensity, this.lastPropDist, bumps);

    const around = surroundingsOf(road, walls, firstChunk);
    const decor = scatterDecor(this.rng.fork(`decor:${index}`), cells, [around, ...this.recent]);
    around.decor = decor;

    const last = road.path.length - 1;
    this.join = { point: { ...road.path[last] }, left: { ...road.left[last] }, right: { ...road.right[last] } };
    this.entryWidth = plan.base;
    this.entryX = cells[LAST].cx + 1;
    this.entryZ = cells[LAST].cz;
    let tail = 0;
    while (tail < cells.length && cells[LAST - tail].kind !== 'corner') tail++;
    this.straightTail = tail === cells.length ? this.straightTail + tail : tail;
    for (const dist of bumps.dists) this.lastBumpDist = Math.max(this.lastBumpDist, dist);
    this.lastPropDist = pillars.lastDist;
    this.recent.push(around);
    if (this.recent.length > DECOR_MEMORY) this.recent.shift();

    return {
      index,
      path: road.path,
      left: road.left,
      right: road.right,
      walls,
      props: pillars.props,
      decor,
      bumps: bumps.bumps,
      startDist: road.path[0].dist,
      endDist: road.path[last].dist,
      intensity,
      bounds: boundsOf(walls, decor, bumps.bumps),
    };
  }
}

/**
 * An endless supply of road for a seed and a difficulty. The same two always give the same chunks, so a run can be
 * replayed or raced again. Call `next()` for chunk 0, 1, 2 ... in order.
 */
export function createEndlessGenerator(seed: string, difficulty: Difficulty): EndlessGenerator {
  return new Generator(seed, difficulty);
}
