/**
 * Fixed-level generator: the weekly run and the five hand-picked levels.
 *
 * The road is laid on a grid of large cells by a walk, so a route from start to goal exists by construction. Each
 * cell holds either a straight or a quarter-circle bend, and the road never leaves the cells it walks through: two
 * stretches of road can only meet where the walk says they do. The walk may enter a cell it already used only to
 * CROSS it: both uses are straights at right angles, and the height plan puts one of them at least
 * CROSSING_CLEARANCE above the other through the whole cell (an overpass, held level).
 *
 * Heights come from a smooth grade-limited profile (see road3d.ts): level at the start, the goal and every crossing,
 * random climbs, drops and crests in between. Raised stretches stand on supports and some of their edges are left
 * open: no barrier, a real drop to the city floor.
 *
 * Layout, widths, heights, open edges, props, bumps, supports and decor each draw from their own random stream, so
 * tuning one part never moves another that comes before it.
 */

import { HALF_PI, atan2, cos, lerp, sin, smoothstep } from '../core/fixedMath';
import { Rng } from '../core/rng';
import type { Bump, DecorBlock, Gate, Level, PathPoint, Prop, Segment, Support, TrackOptions, Vec2, Wall } from '../types';
import { GEN_VERSION } from '../types';
import { WEEKLY_OPTIONS } from './levels';
import {
  BEND_GRADE,
  HeightProfile,
  MAX_RISE,
  PLAN_CLEARANCE,
  RoadIndex,
  bumpsAlong,
  chooseOpenEdges,
  edgeOverOtherRoad,
  emitEdgeWalls,
  maxClimb,
  pieceBounds,
  placeSupports,
  profileLimits,
  raisedSegments,
  snap,
  wallBetween,
  wander,
} from './road3d';
import type { BumpAlong, GradeLimit, RoadHit } from './road3d';
import { RULES, SpatialHash, WallIndex, insideQuad, validateLevel } from './validate';
import { seedForWeek } from './weeklySeed';

export { snap } from './road3d';

export const CELL = 48;
const HALF_CELL = CELL / 2;
/** Travel directions in clockwise order (east, south, west, north): adding 1 is a right turn. */
export const DIR_X = [1, 0, -1, 0];
export const DIR_Z = [0, 1, 0, -1];
const PATH_STEP = 3;
const ARC_LENGTH = HALF_PI * HALF_CELL;
const ARC_STEPS = 13;
/** A walk in open ground almost never gets stuck; the budget only stops a pathological search. */
const WALK_BUDGET = 5000;
/** Once this many cells in a row are straight, carrying straight on becomes unlikely. */
const MAX_EASY_STRAIGHT = 3;

const MAX_CORNER_HALF_WIDTH = 12.5;
const MIN_PLAZA_HALF_WIDTH = 15;
const MAX_PLAZA_HALF_WIDTH = 20;
const NARROW_CHANCE = 0.14;
/** Distance over which the road changes width. A plaza tapers more gently because it changes by more. */
const BLEND = 16;
const PLAZA_BLEND = 20;

/** Closed ends: how far the road continues behind the start and beyond the goal. */
const START_CAP = RULES.startCap;
/**
 * The run-off: a car crossing the line flat out needs just under 60 m to brake to a stop. The goal sits in the
 * middle of the last cell, so the cap runs through the rest of that cell and well into the next one, which the
 * walk keeps free of road (see `extendWalk`). The extra few metres are for the nose of the car.
 */
const GOAL_CAP = RULES.goalCap;
/**
 * Cells between checkpoints. No edge is open within 40 m of a checkpoint, so levels with a lot of open edge space
 * their checkpoints out more (a fall then costs more road, which suits a hard level).
 */
function checkpointEvery(options: TrackOptions): number {
  return options.openEdges >= 0.4 ? 5 : options.openEdges >= 0.15 ? 4 : 3;
}

// ---- heights ----
/** Level road at the start and before the goal, m of centreline. */
const LEVEL_END = 24;
/** Gentler grades this close to the start and the goal. */
const GENTLE_END = 60;
/** A crossing is held level this far either side of the middle of its cell, on both roads. */
const CROSSING_HOLD = 32;
/**
 * Barriers stay closed this close (centreline) to the middle of a crossing cell: the heart of the crossing reaches
 * about 13 m either way, plus the validator's 30 m.
 */
const CROSSING_EDGE_KEEP = 46;
/** No open edge this close (centreline) to the start, the goal or a checkpoint. */
const GATE_EDGE_KEEP = 40;
/** From this open-edge share up, the outside of a bend may be open too. */
const OUTSIDE_OPEN_FROM = 0.15;
/** A ground hit further than this along the centreline is another stretch of road. */
const OTHER_ROAD_GAP = RULES.overlapPathGap;

const CENTRE_PILLAR_MIN_HALF_WIDTH = 17;
/** How far a pillar may sit from the middle of its cell, which keeps it off gates and out of width changes. */
const PLAZA_PILLAR_REACH = 3;
const STRAIGHT_PILLAR_REACH = 7;
/** The validator measures spacing between path samples, which can read up to a step short. */
const PROP_SPACING = RULES.propSpacing + 4;
const PROP_HUES = 6;
/** Pillars per km the classic rates below were tuned for. */
const PILLAR_RATE_REFERENCE = 2.5;
/** From the middle of a crossing cell: the heart of the crossing reaches about 13 m either way, plus 30 m. */
const PROP_CROSSING_CLEARANCE = 46;

// ---- bumps ----
const BUMP_END_CLEARANCE = 64;
const BUMP_GATE_CLEARANCE = 42;
const BUMP_CROSSING_CLEARANCE = 64;
const BUMP_PROP_CLEARANCE = 42;
const BUMP_BEND_CLEARANCE = 42;
/** A bumpy level lets a crest sit this close to the bend that follows. */
const BUMP_BEND_CLEARANCE_DARING = 19;
const BUMP_GATE_CLEARANCE_DARING = 32;
const BUMP_SPACING = 64;
/** The road is held level this far beyond each end of a bump. */
const BUMP_LEVEL_MARGIN = 13;
const BUMP_WIDTH_PROBE = 3.5;
/** No open edge this close to a bump on a gentle level, and on a bumpy one. */
const BUMP_OPEN_CLEARANCE = 40;
const BUMP_OPEN_CLEARANCE_DARING = 20;
const BUMP_MAX_ROAD_HALF_WIDTH = 13;

const DECOR_RINGS = 3;
const OUTER_RING_CHANCE = 0.5;
const DECOR_TARGET_MIN = 200;
const DECOR_TARGET_MAX = 300;
/** Share of the blocks spent on the street front, and how far from the road that front reaches. */
const DECOR_FRONT_SHARE = 0.6;
const DECOR_FRONT_DEPTH = 34;
const DECOR_FRONT_PASSES = 8;
const DECOR_SKYLINE_PASSES = 12;
const DECOR_GAP = 2;
const DECOR_BUCKET = 24;
/** Footprint size range per ring: blocks squeezed in beside the road are small, the skyline behind is bulky. */
const DECOR_SIZE_BY_RING: readonly (readonly [number, number])[] = [
  [6, 12],
  [6, 18],
  [8, 22],
  [10, 22],
];
const DECOR_LOW_RISE = 5;

const MAX_RETRIES = 50;

function cellKey(cx: number, cz: number): number {
  return (cx + 512) * 1024 + (cz + 512);
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: a walk over grid cells that may cross itself at right angles
// ---------------------------------------------------------------------------------------------------------------

/** A cell the road passes through twice: first along one axis, later across it. Walk indices. */
export interface CrossingPlan {
  first: number;
  second: number;
}

interface Walk {
  count: number;
  /** The direction the level as a whole tends to travel in. */
  general: number;
  cx: number[];
  cz: number[];
  /** moves[i] is the travel direction from cell i to cell i + 1. */
  moves: number[];
  /** Cell key -> walk index of its first use. */
  used: Map<number, number>;
  crossings: CrossingPlan[];
  /** Keys of cells used twice. */
  crossed: Set<number>;
  /** Crossings the walk tries to make. */
  wantCrossings: number;
  twist: number;
  /** Rough grade limits for the climb-budget estimate. */
  straightGrade: number;
  bendGrade: number;
  budget: number;
  rng: Rng;
}

/** -1 left, 0 straight on, +1 right. */
function turnBetween(from: number, to: number): number {
  const delta = (to - from + 4) & 3;
  return delta === 3 ? -1 : delta;
}

/** Length of the run of equal moves that ends the walk: one more than the straight cells just laid. */
function straightRun(moves: readonly number[]): number {
  let run = 1;
  while (run < moves.length && moves[moves.length - 1 - run] === moves[moves.length - 1]) run++;
  return run;
}

/** How many bends in a row lead up to the newest cell. */
function bendRun(moves: readonly number[]): number {
  let run = 0;
  while (run + 1 < moves.length && moves[moves.length - 1 - run] !== moves[moves.length - 2 - run]) run++;
  return run;
}

/** How attractive it is to leave the newest cell in direction `dir`. Shapes the mix of straights and bends. */
function moveWeight(walk: Walk, dir: number): number {
  const moves = walk.moves;
  const previous = moves[moves.length - 1];
  const turn = turnBetween(previous, dir);
  const bends = bendRun(moves);
  const twisty = 0.4 + 1.2 * walk.twist;
  let weight: number;
  if (turn === 0) weight = straightRun(moves) > MAX_EASY_STRAIGHT ? 0.35 : 1.4 * (1.6 - 1.2 * walk.twist);
  else if (bends === 0) weight = 0.85;
  // A second bend the same way makes a hairpin; the other way makes an S-bend.
  else if (bends === 1) weight = (turn === turnBetween(moves[moves.length - 2], previous) ? 1 : 0.8) * twisty;
  // Longer chains of bends are allowed but rare, so the road breathes between them.
  else weight = 0.25 * twisty * twisty;
  // A walk that still wants to cross itself has no favourite direction: it must be free to come back.
  if (walk.crossings.length < walk.wantCrossings) return weight;
  const heading = (dir - walk.general + 4) & 3;
  return weight * (heading === 0 ? 1.3 : heading === 2 ? 0.5 : 1);
}

/** True when cell `index` of the walk (already followed by a move) is a straight. */
function walkCellStraight(walk: Walk, index: number, nextMove: number): boolean {
  const out = index < walk.moves.length ? walk.moves[index] : nextMove;
  return index > 0 && walk.moves[index - 1] === out;
}

/** True when no crossing cell is among the eight neighbours of (cx, cz). */
function clearOfCrossings(walk: Walk, cx: number, cz: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) if (walk.crossed.has(cellKey(cx + dx, cz + dz))) return false;
  }
  return true;
}

/**
 * Whether moving from the newest cell in direction `dir` into an already used cell is a legal crossing: the earlier
 * use is a straight at right angles, far enough from both ends, the cell beyond is free, no other crossing is next
 * door, and the road in between is long enough to climb or drop the clearance.
 */
function crossingAllowed(walk: Walk, dir: number): boolean {
  const newest = walk.cx.length - 1;
  const index = newest + 1;
  const cx = walk.cx[newest] + DIR_X[dir];
  const cz = walk.cz[newest] + DIR_Z[dir];
  const key = cellKey(cx, cz);
  const first = walk.used.get(key);
  if (first === undefined || walk.crossings.length >= walk.wantCrossings || walk.crossed.has(key)) return false;
  if (first < 3 || index > walk.count - 4) return false;
  if (!walkCellStraight(walk, first, dir) || ((walk.moves[first] - dir) & 1) === 0) return false;
  if (walk.used.has(cellKey(cx + DIR_X[dir], cz + DIR_Z[dir])) || !clearOfCrossings(walk, cx, cz)) return false;
  // Climb budget between the two level holds, roughly: the cells strictly between the two uses.
  let budget = 0;
  for (let m = first + 1; m <= newest; m++) {
    budget += walkCellStraight(walk, m, dir) ? walk.straightGrade * CELL : walk.bendGrade * ARC_LENGTH;
  }
  budget = 0.92 * (budget - 2 * (CROSSING_HOLD - HALF_CELL) * walk.straightGrade) - 1;
  return budget >= PLAN_CLEARANCE + 0.3;
}

/**
 * Manhattan distance from (cx, cz) to the nearest free cell from which a crossing could be entered, counting only
 * straights laid long enough ago that the road since could already climb most of the clearance.
 */
function distanceToCrossingEntry(walk: Walk, cx: number, cz: number): number {
  let best = Infinity;
  const newest = walk.cx.length - 1;
  let climb = 0;
  for (let i = newest - 1; i >= 3; i--) {
    climb += walk.moves[i] === walk.moves[i - 1] ? walk.straightGrade * CELL : walk.bendGrade * ARC_LENGTH;
    if (walk.moves[i - 1] !== walk.moves[i] || climb < PLAN_CLEARANCE) continue;
    const key = cellKey(walk.cx[i], walk.cz[i]);
    if (walk.crossed.has(key)) continue;
    const sideX = -DIR_Z[walk.moves[i]];
    const sideZ = DIR_X[walk.moves[i]];
    for (const side of [-1, 1]) {
      const ex = walk.cx[i] + sideX * side;
      const ez = walk.cz[i] + sideZ * side;
      const free = !walk.used.has(cellKey(ex, ez)) || (ex === walk.cx[newest] && ez === walk.cz[newest]);
      if (free) best = Math.min(best, Math.abs(ex - cx) + Math.abs(ez - cz));
    }
  }
  return best;
}

/** Steers a walk that still wants crossings back towards road it has already laid. */
function crossingPull(walk: Walk, dir: number): number {
  const newest = walk.cx.length - 1;
  if (walk.crossings.length >= walk.wantCrossings || newest < 4 || newest > walk.count - 6) return 1;
  const cx = walk.cx[newest] + DIR_X[dir];
  const cz = walk.cz[newest] + DIR_Z[dir];
  if (walk.used.has(cellKey(cx, cz))) return crossingAllowed(walk, dir) ? 10 : 1;
  const before = distanceToCrossingEntry(walk, walk.cx[newest], walk.cz[newest]);
  const after = distanceToCrossingEntry(walk, cx, cz);
  return after < before ? 4 : after > before ? 0.35 : 1;
}

/** True when the newest cell is the second use of a crossing: it must be left straight on. */
function newestIsCrossing(walk: Walk): boolean {
  const n = walk.crossings.length;
  return n > 0 && walk.crossings[n - 1].second === walk.cx.length - 1;
}

/** The three ways out of the newest cell, in a weighted random order. */
function moveOptions(walk: Walk): number[] {
  const step = walk.moves.length;
  if (step === 0) return [walk.general];
  const previous = walk.moves[step - 1];
  // The second cell, the second-to-last cell and a crossing cell must be straight.
  if (step === 1 || step === walk.count - 2 || newestIsCrossing(walk)) return [previous];
  const pool = [previous, (previous + 1) & 3, (previous + 3) & 3];
  const weights = pool.map((dir) => moveWeight(walk, dir) * crossingPull(walk, dir));
  const order: number[] = [];
  while (pool.length > 0) {
    let pick = 0;
    let roll = walk.rng.next() * weights.reduce((sum, w) => sum + w, 0);
    while (pick < pool.length - 1 && roll >= weights[pick]) roll -= weights[pick++];
    order.push(pool[pick]);
    pool.splice(pick, 1);
    weights.splice(pick, 1);
  }
  return order;
}

/**
 * Depth-first: tries each way out of the newest cell and backs up when every way is blocked.
 *
 * The cell straight beyond the last one is reserved for the run-off past the goal: the walk never ends facing a
 * cell it has already used, and since the last cell is the last one laid, nothing can be put there afterwards.
 */
function extendWalk(walk: Walk): boolean {
  const index = walk.cx.length - 1;
  if (index === walk.count - 1) return true;
  if (walk.budget-- <= 0) return false;
  const placingLast = index + 1 === walk.count - 1;
  for (const dir of moveOptions(walk)) {
    const cx = walk.cx[index] + DIR_X[dir];
    const cz = walk.cz[index] + DIR_Z[dir];
    const key = cellKey(cx, cz);
    const prior = walk.used.get(key);
    if (prior !== undefined && !crossingAllowed(walk, dir)) continue;
    if (placingLast && walk.used.has(cellKey(cx + DIR_X[dir], cz + DIR_Z[dir]))) continue;
    if (prior === undefined) walk.used.set(key, index + 1);
    else {
      walk.crossings.push({ first: prior, second: index + 1 });
      walk.crossed.add(key);
    }
    walk.cx.push(cx);
    walk.cz.push(cz);
    walk.moves.push(dir);
    if (extendWalk(walk)) return true;
    if (prior === undefined) walk.used.delete(key);
    else {
      walk.crossings.pop();
      walk.crossed.delete(key);
    }
    walk.cx.pop();
    walk.cz.pop();
    walk.moves.pop();
  }
  return false;
}

/** Walks tried per level when the first one does not cross itself as often as wanted. */
const WALK_CANDIDATES = 48;

/**
 * Lays out the road. Crossings need the walk to come back to itself at a right angle, which no single walk can be
 * forced to do, so several walks are tried and the first that makes the wanted number of crossings wins (else the
 * one with the most). Every candidate draws from its own fork, so the choice is deterministic.
 */
function walkLayout(rng: Rng, options: TrackOptions): Walk {
  const [minCells, maxCells] = options.cells;
  const limits = profileLimits(options.elevation);
  const wanted = Math.max(0, Math.min(4, options.crossings));
  const whole = Math.floor(wanted);
  const wantCrossings = whole + (rng.chance(wanted - whole) ? 1 : 0);
  let best: Walk | null = null;
  for (let candidate = 0; candidate < WALK_CANDIDATES; candidate++) {
    const stream = candidate === 0 ? rng : rng.fork(`walk${candidate}`);
    const walk: Walk = {
      count: minCells + stream.int(maxCells - minCells + 1),
      general: stream.int(4),
      cx: [0],
      cz: [0],
      moves: [],
      used: new Map([[cellKey(0, 0), 0]]),
      crossings: [],
      crossed: new Set(),
      wantCrossings,
      twist: Math.max(0, Math.min(1, options.twist)),
      straightGrade: limits.maxGrade,
      bendGrade: limits.bendGrade,
      budget: WALK_BUDGET,
      rng: stream,
    };
    if (!extendWalk(walk)) continue;
    if (!best || walk.crossings.length > best.crossings.length) best = walk;
    if (walk.crossings.length >= wantCrossings) break;
  }
  if (!best) throw new Error('layout walk found no route');
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Cells and widths
// ---------------------------------------------------------------------------------------------------------------

export type CellKind = 'straight' | 'corner' | 'plaza' | 'narrow';

export interface Cell {
  cx: number;
  cz: number;
  /** Travel direction on entering and on leaving. They differ in a corner cell. */
  inDir: number;
  outDir: number;
  kind: CellKind;
  /** Half width in the middle of the cell, away from the blends at its ends. */
  midWidth: number;
  /** Where a straight's centreline starts and ends, measured from the cell centre along the travel direction. */
  entryOffset: number;
  exitOffset: number;
  /** Centreline length inside the cell, and the distance travelled when entering it. */
  length: number;
  startDist: number;
  steps: number;
  /** Path index of the point where the centreline enters the cell. */
  firstIndex: number;
}

function cellsFromWalk(walk: Walk): Cell[] {
  const cells: Cell[] = [];
  let startDist = 0;
  let firstIndex = 0;
  for (let i = 0; i < walk.count; i++) {
    const inDir = walk.moves[Math.max(i - 1, 0)];
    const outDir = walk.moves[Math.min(i, walk.count - 2)];
    const corner = inDir !== outDir;
    // The road starts and ends at a cell centre; everywhere else it runs edge to edge.
    const entryOffset = i === 0 ? 0 : -HALF_CELL;
    const exitOffset = i === walk.count - 1 ? 0 : HALF_CELL;
    const length = corner ? ARC_LENGTH : exitOffset - entryOffset;
    const steps = corner ? ARC_STEPS : Math.round(length / PATH_STEP);
    cells.push({
      cx: walk.cx[i],
      cz: walk.cz[i],
      inDir,
      outDir,
      kind: corner ? 'corner' : 'straight',
      midWidth: 0,
      entryOffset,
      exitOffset,
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

interface WidthPlan {
  base: number;
  corner: number;
}

/** The cell straight beyond the last one. It holds the far end of the run-off past the goal and no road. */
function runOffCell(cells: readonly Cell[]): { cx: number; cz: number } {
  const last = cells[cells.length - 1];
  return { cx: last.cx + DIR_X[last.inDir], cz: last.cz + DIR_Z[last.inDir] };
}

/** True when the cells to the left and right of a straight are free, so a wide plaza has nothing to crowd. */
function hasOpenSides(cell: Cell, occupied: Set<number>): boolean {
  const sideX = -DIR_Z[cell.inDir];
  const sideZ = DIR_X[cell.inDir];
  const leftKey = cellKey(cell.cx - sideX, cell.cz - sideZ);
  const rightKey = cellKey(cell.cx + sideX, cell.cz + sideZ);
  return !occupied.has(leftKey) && !occupied.has(rightKey);
}

function makePlaza(cell: Cell, size: number): void {
  cell.kind = 'plaza';
  cell.midWidth = lerp(MIN_PLAZA_HALF_WIDTH, MAX_PLAZA_HALF_WIDTH, size);
}

function planWidths(rng: Rng, cells: Cell[], options: TrackOptions, nearCrossing: Set<number>): WidthPlan {
  const base = rng.range(options.halfWidth[0], options.halfWidth[1]);
  const plan: WidthPlan = { base, corner: Math.min(MAX_CORNER_HALF_WIDTH, base + rng.range(0.8, 2.2)) };
  const occupied = new Set(cells.map((cell) => cellKey(cell.cx, cell.cz)));
  // A plaza must not crowd the run-off either.
  const runOff = runOffCell(cells);
  occupied.add(cellKey(runOff.cx, runOff.cz));
  const plazaChance = Math.max(0, Math.min(1, options.plazas)) * 0.6;
  const plazaSites: number[] = [];
  let plazas = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    cell.midWidth = cell.kind === 'corner' ? plan.corner : base;
    // The first and last two cells stay plain so the start and the finish are predictable.
    if (cell.kind !== 'straight' || i < 2 || i > cells.length - 3) continue;
    const roll = rng.next();
    const size = rng.next();
    // Two plazas in a row are wider than they are far apart, which the overlap rule reads as a road folded
    // onto itself. Nor does a plaza sit next to a crossing.
    const canBePlaza =
      hasOpenSides(cell, occupied) && cells[i - 1].kind !== 'plaza' && !nearCrossing.has(cellKey(cell.cx, cell.cz));
    if (canBePlaza) plazaSites.push(i);
    if (canBePlaza && roll < plazaChance) {
      makePlaza(cell, size);
      plazas++;
    } else if (roll > 1 - NARROW_CHANCE) {
      cell.kind = 'narrow';
      cell.midWidth = Math.max(RULES.minHalfWidth, base - lerp(1.5, 3, size));
    }
  }
  if (plazas === 0 && plazaChance > 0 && plazaSites.length > 0) makePlaza(cells[rng.pick(plazaSites)], rng.next());
  return plan;
}

/** Half width on the line between two neighbouring cells. Bends keep their full width right up to both ends. */
function joinWidth(cells: readonly Cell[], plan: WidthPlan, before: number, after: number): number {
  if (before < 0 || after >= cells.length) return plan.base;
  return cells[before].kind === 'corner' || cells[after].kind === 'corner' ? plan.corner : plan.base;
}

/** Half width `s` metres into a cell: its own width in the middle, blended to the shared width at each end. */
function halfWidthAt(cells: readonly Cell[], plan: WidthPlan, index: number, s: number): number {
  const cell = cells[index];
  const blend = cell.kind === 'plaza' ? PLAZA_BLEND : BLEND;
  if (s < blend) return lerp(joinWidth(cells, plan, index - 1, index), cell.midWidth, smoothstep(0, blend, s));
  const remaining = cell.length - s;
  if (remaining < blend) {
    return lerp(joinWidth(cells, plan, index, index + 1), cell.midWidth, smoothstep(0, blend, remaining));
  }
  return cell.midWidth;
}

/** Index of the cell whose centreline contains distance `d`. */
function cellAtDist(cells: readonly Cell[], d: number): number {
  let lo = 0;
  let hi = cells.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cells[mid].startDist <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------------------------------------------

interface Anchor {
  from: number;
  to: number;
  height: number;
  /** Index of the anchor on the other road of the same crossing, or -1. */
  partner: number;
}

/** Share of the steepest climb the height assignment may plan with. */
const ANCHOR_SAFETY = 0.95;

function gradeLimitFor(cells: readonly Cell[], length: number, options: TrackOptions): GradeLimit {
  const limits = profileLimits(options.elevation);
  return (d: number): number => {
    let g = cells[cellAtDist(cells, d)].kind === 'corner' ? limits.bendGrade : limits.maxGrade;
    if (d < GENTLE_END || d > length - GENTLE_END) g = Math.min(g, BEND_GRADE);
    if (d < LEVEL_END || d > length - LEVEL_END) g = 0;
    return g;
  };
}

/** Picks a height for every level hold so consecutive holds can be joined and every crossing has its clearance. */
function assignAnchorHeights(rng: Rng, anchors: Anchor[], budgets: readonly number[], maxHeight: number): boolean {
  for (let attempt = 0; attempt < 60; attempt++) {
    let ok = true;
    for (let k = 1; k < anchors.length && ok; k++) {
      const previous = anchors[k - 1].height;
      const lo = Math.max(0, previous - budgets[k]);
      const hi = Math.min(maxHeight, previous + budgets[k]);
      const partner = anchors[k].partner;
      const u = rng.next();
      const side = rng.next();
      let height: number;
      if (partner >= 0 && partner < k) {
        const other = anchors[partner].height;
        const below: [number, number] = [lo, Math.min(hi, other - PLAN_CLEARANCE)];
        const above: [number, number] = [Math.max(lo, other + PLAN_CLEARANCE), hi];
        const options = [below, above].filter(([a, b]) => b >= a);
        if (options.length === 0) {
          ok = false;
          break;
        }
        const [a, b] = options[side < 0.5 || options.length === 1 ? 0 : 1];
        // Hug the near side of the gap a little: big height changes eat the climb budget for what follows.
        height = options.length === 1 && a === below[0] ? b - (b - a) * u * 0.5 : a + (b - a) * u * 0.5;
      } else if (partner > k) {
        // First road of a crossing: low or high, so the other road can pass over or under.
        height = side < 0.5 ? lo + (hi - lo) * u * 0.3 : hi - (hi - lo) * u * 0.3;
      } else {
        height = lo + (hi - lo) * u;
      }
      anchors[k].height = snap(Math.max(0, height));
    }
    if (ok) return true;
  }
  return false;
}

/** Crossing cells, for every part of the generator that must keep clear of them. */
interface CrossingInfo {
  plans: CrossingPlan[];
  /** Walk indices of both uses of every crossing cell. */
  cells: Set<number>;
  /** Centreline distance of the middle of every crossing cell, both uses. */
  dists: number[];
}

function crossingInfo(cells: readonly Cell[], plans: readonly CrossingPlan[]): CrossingInfo {
  const info: CrossingInfo = { plans: [...plans], cells: new Set(), dists: [] };
  for (const plan of plans) {
    for (const index of [plan.first, plan.second]) {
      info.cells.add(index);
      info.dists.push(cells[index].startDist + HALF_CELL);
    }
  }
  return info;
}

function planHeights(
  rng: Rng,
  cells: readonly Cell[],
  crossings: CrossingInfo,
  bumps: BumpPlan,
  options: TrackOptions,
): HeightProfile {
  const length = cells[cells.length - 1].startDist + cells[cells.length - 1].length;
  const limits = profileLimits(options.elevation);
  const limit = gradeLimitFor(cells, length, options);
  const profile = new HeightProfile(0, 0, limit, limits.gradeChange);
  let maxHeight = MAX_RISE * Math.max(0, Math.min(1, options.elevation));
  if (crossings.plans.length > 0) maxHeight = Math.max(maxHeight, PLAN_CLEARANCE + 4);

  const anchors: Anchor[] = [{ from: 0, to: LEVEL_END, height: 0, partner: -1 }];
  const holds: { from: number; to: number; key: number }[] = [];
  crossings.plans.forEach((plan, k) => {
    for (const index of [plan.first, plan.second]) {
      const middle = cells[index].startDist + HALF_CELL;
      holds.push({ from: Math.round(middle - CROSSING_HOLD), to: Math.round(middle + CROSSING_HOLD), key: k });
    }
  });
  // Level road under every bump, at whatever height suits.
  bumps.dists.forEach((d, k) => {
    const reach = bumps.halfLengths[k] + BUMP_LEVEL_MARGIN;
    holds.push({ from: Math.round(d - reach), to: Math.round(d + reach), key: -1 - k });
  });
  holds.sort((a, b) => a.from - b.from);
  for (const hold of holds) anchors.push({ from: hold.from, to: hold.to, height: 0, partner: -1 });
  for (let a = 1; a < anchors.length; a++) {
    for (let b = a + 1; b < anchors.length; b++) {
      if (holds[a - 1].key >= 0 && holds[a - 1].key === holds[b - 1].key) {
        anchors[a].partner = b;
        anchors[b].partner = a;
      }
    }
  }
  anchors.push({ from: Math.floor(length - LEVEL_END), to: Math.ceil(length) + 2, height: 0, partner: -1 });
  const budgets = anchors.map((anchor, k) =>
    k === 0 ? 0 : maxClimb(anchors[k - 1].to, anchor.from, limit, limits.gradeChange) * ANCHOR_SAFETY,
  );
  if (!assignAnchorHeights(rng, anchors, budgets, maxHeight)) throw new Error('no height plan fits the crossings');

  const style = {
    maxHeight,
    ramp: [40, 150] as [number, number],
    hold: [0, 45] as [number, number],
    drama: 0.35 + 0.5 * Math.max(0, Math.min(1, options.elevation)),
  };
  profile.holdTo(anchors[0].to);
  for (let k = 1; k < anchors.length; k++) {
    if (!wander(profile, rng, anchors[k].from, anchors[k].height, style)) throw new Error('height plan unreachable');
    profile.holdTo(anchors[k].to);
  }
  return profile;
}

// ---------------------------------------------------------------------------------------------------------------
// Road geometry
// ---------------------------------------------------------------------------------------------------------------

export interface Centreline {
  x: number[];
  z: number[];
  halfWidth: number[];
  dist: number[];
}

/** Appends the centreline point a fraction `t` of the way through the cell. */
export function pushCellPoint(line: Centreline, cell: Cell, t: number): void {
  const centreX = cell.cx * CELL;
  const centreZ = cell.cz * CELL;
  const inX = DIR_X[cell.inDir];
  const inZ = DIR_Z[cell.inDir];
  if (cell.kind !== 'corner') {
    const along = lerp(cell.entryOffset, cell.exitOffset, t);
    line.x.push(centreX + inX * along);
    line.z.push(centreZ + inZ * along);
    return;
  }
  // Quarter circle about the grid corner shared by the entry and exit edges, from the entry midpoint.
  const outX = DIR_X[cell.outDir];
  const outZ = DIR_Z[cell.outDir];
  const c = cos(t * HALF_PI) * HALF_CELL;
  const s = sin(t * HALF_PI) * HALF_CELL;
  line.x.push(centreX + (outX - inX) * HALF_CELL - outX * c + inX * s);
  line.z.push(centreZ + (outZ - inZ) * HALF_CELL - outZ * c + inZ * s);
}

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

/** Offsets the centreline to both sides along a central-difference normal and snaps everything to the lattice. */
function buildRoad(line: Centreline, profile: HeightProfile): Road {
  const road: Road = { path: [], left: [], right: [] };
  const last = line.x.length - 1;
  for (let i = 0; i <= last; i++) {
    const before = i > 0 ? i - 1 : 0;
    const after = i < last ? i + 1 : last;
    const tx = line.x[after] - line.x[before];
    const tz = line.z[after] - line.z[before];
    const reach = line.halfWidth[i] / Math.sqrt(tx * tx + tz * tz);
    // Right of the travel direction (tx, tz) is (-tz, tx).
    road.right.push({ x: snap(line.x[i] - tz * reach), z: snap(line.z[i] + tx * reach) });
    road.left.push({ x: snap(line.x[i] + tz * reach), z: snap(line.z[i] - tx * reach) });
    road.path.push({
      x: snap(line.x[i]),
      z: snap(line.z[i]),
      y: snap(Math.max(0, profile.heightAt(line.dist[i]))),
      halfWidth: snap(line.halfWidth[i]),
      dist: snap(line.dist[i]),
    });
  }
  return road;
}

/** Road height at a centreline distance, interpolated between path points exactly as the surface is. */
export function pathHeightAt(path: readonly PathPoint[], dist: number): number {
  let lo = 0;
  let hi = path.length - 1;
  if (dist <= path[0].dist) return path[0].y;
  if (dist >= path[hi].dist) return path[hi].y;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].dist <= dist) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  return a.y + ((b.y - a.y) * (dist - a.dist)) / (b.dist - a.dist);
}

function shifted(p: Vec2, dir: number, distance: number): Vec2 {
  return { x: p.x + DIR_X[dir] * distance, z: p.z + DIR_Z[dir] * distance };
}

/** The closed end behind the start, at the start's height. Runs from the right edge round to the left edge. */
function startCapWalls(road: Road, startDir: number): Wall[] {
  const y = road.path[0].y;
  const backLeft = shifted(road.left[0], startDir, -START_CAP);
  const backRight = shifted(road.right[0], startDir, -START_CAP);
  return [
    wallBetween(road.right[0], backRight, y, y),
    wallBetween(backRight, backLeft, y, y),
    wallBetween(backLeft, road.left[0], y, y),
  ];
}

/** The walled run-off beyond the goal, level at the goal's height. Runs from the left edge round to the right. */
function goalCapWalls(road: Road, goalDir: number): Wall[] {
  const last = road.path.length - 1;
  const y = road.path[last].y;
  const farLeft = shifted(road.left[last], goalDir, GOAL_CAP);
  const farRight = shifted(road.right[last], goalDir, GOAL_CAP);
  return [
    wallBetween(road.left[last], farLeft, y, y),
    wallBetween(farLeft, farRight, y, y),
    wallBetween(farRight, road.right[last], y, y),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------------------------

function headingOf(dir: number): number {
  return atan2(DIR_Z[dir], DIR_X[dir]);
}

function gateAt(road: Road, pathIndex: number, dir: number): Gate {
  const p = road.path[pathIndex];
  const a = road.left[pathIndex];
  const b = road.right[pathIndex];
  return {
    ax: a.x,
    az: a.z,
    bx: b.x,
    bz: b.z,
    pathIndex,
    y: p.y,
    respawn: { x: p.x, z: p.z, heading: headingOf(dir), y: p.y },
  };
}

/**
 * Picks the line between cell b - 1 and cell b for a checkpoint near `target`, preferring one with straight road
 * on both sides. Never a line that touches a crossing cell. Returns -1 when nothing nearby is far enough from the
 * previous gate and from both ends.
 */
function pickCheckpointLine(
  cells: readonly Cell[],
  crossings: CrossingInfo,
  target: number,
  previous: number,
  length: number,
): number {
  let fallback = -1;
  for (const b of [target, target + 1, target - 1]) {
    if (b < previous + 2 || b > cells.length - 2) continue;
    if (crossings.cells.has(b) || crossings.cells.has(b - 1)) continue;
    const dist = cells[b].startDist;
    if (dist < RULES.checkpointEndClearance || length - dist < RULES.checkpointEndClearance) continue;
    if (cells[b - 1].kind !== 'corner' && cells[b].kind !== 'corner') return b;
    if (fallback < 0) fallback = b;
  }
  return fallback;
}

/** The cell lines checkpoints sit on: checkpoint k is where cell lines[k] begins. */
function checkpointLines(cells: readonly Cell[], crossings: CrossingInfo, length: number, every: number): number[] {
  const lines: number[] = [];
  let previous = 0;
  for (let target = every; target <= cells.length - 2; target += every) {
    const line = pickCheckpointLine(cells, crossings, target, previous, length);
    if (line < 0) continue;
    lines.push(line);
    previous = line;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Open edges
// ---------------------------------------------------------------------------------------------------------------

interface EdgePlan {
  leftOpen: boolean[];
  rightOpen: boolean[];
  /** Centreline distances where an open stretch begins or ends. */
  stretchEnds: number[];
}

function planEdges(
  rng: Rng,
  cells: readonly Cell[],
  road: Road,
  index: RoadIndex,
  crossings: CrossingInfo,
  gateDists: readonly number[],
  bumpDists: readonly number[],
  bumpsOnRoad: readonly BumpAlong[],
  options: TrackOptions,
): EdgePlan {
  const path = road.path;
  const n = path.length;
  const length = path[n - 1].dist;
  const raised = raisedSegments(path);
  const bend: boolean[] = new Array<boolean>(n).fill(false);
  const allowLeft: boolean[] = new Array<boolean>(n).fill(false);
  const allowRight: boolean[] = new Array<boolean>(n).fill(false);
  // Gentle settings never leave the outside of a bend open (every bend here is tight: radius 24 m).
  const outsideOk = options.openEdges >= OUTSIDE_OPEN_FROM;
  const daring = Math.max(0, Math.min(1, (options.bumpsPerKm - 1.5) / 2.5));
  const bumpKeep = lerp(BUMP_OPEN_CLEARANCE, BUMP_OPEN_CLEARANCE_DARING, daring);
  const hits: RoadHit[] = [];
  for (const cell of cells) {
    const turn = turnBetween(cell.inDir, cell.outDir);
    for (let i = cell.firstIndex; i < cell.firstIndex + cell.steps && i + 1 < n; i++) {
      bend[i] = turn !== 0;
      if (!raised[i] || options.openEdges <= 0) continue;
      const d0 = path[i].dist;
      const d1 = path[i + 1].dist;
      let keep = d0 < GATE_EDGE_KEEP || d1 > length - GATE_EDGE_KEEP;
      for (const g of gateDists) keep = keep || (d1 > g - GATE_EDGE_KEEP && d0 < g + GATE_EDGE_KEEP);
      for (const c of crossings.dists) keep = keep || (d1 > c - CROSSING_EDGE_KEEP && d0 < c + CROSSING_EDGE_KEEP);
      for (const b of bumpDists) keep = keep || (d1 > b - bumpKeep && d0 < b + bumpKeep);
      if (keep) continue;
      // The outside of a right turn is the left edge.
      allowLeft[i] =
        (outsideOk || turn <= 0) && !edgeOverOtherRoad(index, 0, path, road.left, i, OTHER_ROAD_GAP, hits, bumpsOnRoad);
      allowRight[i] =
        (outsideOk || turn >= 0) && !edgeOverOtherRoad(index, 0, path, road.right, i, OTHER_ROAD_GAP, hits, bumpsOnRoad);
    }
  }
  const plan = chooseOpenEdges(rng, { path, raised, allowLeft, allowRight, bend, share: options.openEdges });
  const stretchEnds: number[] = [];
  for (const open of [plan.leftOpen, plan.rightOpen]) {
    for (let i = 0; i + 1 < n; i++) {
      if (open[i] && (i === 0 || !open[i - 1])) stretchEnds.push(path[i].dist);
      if (open[i] && !open[i + 1]) stretchEnds.push(path[i + 1].dist);
    }
  }
  return { leftOpen: plan.leftOpen, rightOpen: plan.rightOpen, stretchEnds };
}

/** True when any edge segment from `from` to `to` (path indices) is open. */
function anyOpen(edges: EdgePlan, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < Math.min(to, edges.leftOpen.length); i++) {
    if (edges.leftOpen[i] || edges.rightOpen[i]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------------------------------------------

export interface PillarSpot {
  /** Metres from the cell centre along the road, and to the right of the centreline. */
  along: number;
  lateral: number;
  radius: number;
}

export function centrePillar(rng: Rng): PillarSpot {
  return { along: rng.range(-PLAZA_PILLAR_REACH, PLAZA_PILLAR_REACH), lateral: 0, radius: rng.range(1.6, 2.4) };
}

/**
 * A pillar off to one side. It either hugs its wall, or stands far enough out that a car fits behind it: gaps in
 * between look passable and are not, so they are never used.
 */
export function sidePillar(rng: Rng, halfWidth: number, reach: number): PillarSpot {
  const radius = rng.range(1.2, 2);
  const side = rng.chance(0.5) ? 1 : -1;
  const hugGap = rng.range(0.4, 0.9);
  const splitGap = rng.range(4.5, 6.5);
  const wantsSplit = rng.chance(0.6);
  const offCentre = halfWidth - radius - splitGap >= 1;
  const corridor = 2 * (halfWidth - radius) - splitGap;
  const gap = wantsSplit && offCentre && corridor >= RULES.propCorridor + 0.5 ? splitGap : hugGap;
  return { along: rng.range(-reach, reach), lateral: side * (halfWidth - radius - gap), radius };
}

function pillarSpot(rng: Rng, cell: Cell, rate: number): PillarSpot | null {
  if (cell.kind === 'plaza') {
    if (cell.midWidth >= CENTRE_PILLAR_MIN_HALF_WIDTH && rng.chance(Math.min(1, 0.75 * rate))) return centrePillar(rng);
    return rng.chance(Math.min(1, 0.5 * rate)) ? sidePillar(rng, cell.midWidth, PLAZA_PILLAR_REACH) : null;
  }
  if (cell.kind !== 'straight' || !rng.chance(Math.min(1, 0.2 * rate))) return null;
  return sidePillar(rng, cell.midWidth, STRAIGHT_PILLAR_REACH);
}

interface PropPlan {
  props: Prop[];
  dists: number[];
}

function placeProps(
  rng: Rng,
  cells: readonly Cell[],
  crossings: CrossingInfo,
  edges: EdgePlan,
  path: readonly PathPoint[],
  bumpDists: readonly number[],
  options: TrackOptions,
): PropPlan {
  const out: PropPlan = { props: [], dists: [] };
  const rate = Math.max(0, options.pillarsPerKm) / PILLAR_RATE_REFERENCE;
  let lastDist = -PROP_SPACING;
  // Cells 0 and 1 are too close to the start, and the last two lead onto the goal line.
  for (let i = 2; i <= cells.length - 3; i++) {
    const cell = cells[i];
    const spot = pillarSpot(rng, cell, rate);
    if (!spot) continue;
    // Not under or over a crossing, and not beside an open drop.
    if (crossings.cells.has(i) || anyOpen(edges, cell.firstIndex - 8, cell.firstIndex + cell.steps + 8)) continue;
    // Not on the outside of the line out of the bend just before: a car drifts wide there. (lateral > 0 is the
    // road's right; the outside of a right turn, turn > 0, is its left.)
    const before = turnBetween(cells[i - 1].inDir, cells[i - 1].outDir);
    if (before !== 0 && spot.lateral !== 0 && Math.sign(spot.lateral) === -Math.sign(before)) continue;
    const dist = cell.startDist + HALF_CELL + spot.along;
    if (!farFrom(dist, crossings.dists, PROP_CROSSING_CLEARANCE)) continue;
    if (!farFrom(dist, bumpDists, BUMP_PROP_CLEARANCE)) continue;
    if (dist - lastDist < PROP_SPACING) continue;
    lastDist = dist;
    const dirX = DIR_X[cell.inDir];
    const dirZ = DIR_Z[cell.inDir];
    out.dists.push(dist);
    out.props.push({
      kind: 'pillar',
      x: snap(cell.cx * CELL + dirX * spot.along - dirZ * spot.lateral),
      z: snap(cell.cz * CELL + dirZ * spot.along + dirX * spot.lateral),
      y: snap(pathHeightAt(path, dist)),
      radius: snap(spot.radius),
      height: snap(rng.range(3, 7)),
      hue: rng.int(PROP_HUES),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------------------------------------------

interface StraightRun {
  from: number;
  to: number;
}

/** Stretches of centreline that are geometrically straight (any cell but a bend), with their distance range. */
function straightRuns(cells: readonly Cell[]): StraightRun[] {
  const runs: StraightRun[] = [];
  let from = -1;
  for (let i = 0; i <= cells.length; i++) {
    const straight = i < cells.length && cells[i].kind !== 'corner';
    if (straight && from < 0) from = cells[i].startDist;
    if (!straight && from >= 0) {
      runs.push({ from, to: i < cells.length ? cells[i].startDist : cells[i - 1].startDist + cells[i - 1].length });
      from = -1;
    }
  }
  return runs;
}

function farFrom(d: number, dists: readonly number[], clearance: number): boolean {
  for (const other of dists) if (Math.abs(d - other) < clearance) return false;
  return true;
}

/** Where the bumps go, chosen from the layout alone so the height plan can hold the road level under them. */
interface BumpPlan {
  dists: number[];
  halfLengths: number[];
  heights: number[];
  halfWidths: number[];
}

/**
 * Picks crest positions on straight road away from bends, crossings, gates and the ends. A gentle level keeps 40 m
 * of straight either side; a bumpy one lets a crest sit closer to the bend that follows. The heights are decided
 * later: planHeights holds the road level through every bump.
 */
function planBumps(
  rng: Rng,
  cells: readonly Cell[],
  plan: WidthPlan,
  crossings: CrossingInfo,
  gateDists: readonly number[],
  options: TrackOptions,
): BumpPlan {
  const last = cells[cells.length - 1];
  const length = last.startDist + last.length;
  const rate = (Math.max(0, options.bumpsPerKm) * length) / 1000;
  const wanted = Math.floor(rate) + (rng.chance(rate - Math.floor(rate)) ? 1 : 0);
  const daring = Math.max(0, Math.min(1, (options.bumpsPerKm - 1.5) / 2.5));
  const bendClearance = lerp(BUMP_BEND_CLEARANCE, BUMP_BEND_CLEARANCE_DARING, daring);
  const gateClearance = lerp(BUMP_GATE_CLEARANCE, BUMP_GATE_CLEARANCE_DARING, daring);
  const out: BumpPlan = { dists: [], halfLengths: [], heights: [], halfWidths: [] };
  const runs = straightRuns(cells)
    .map((run) => ({ from: run.from + bendClearance, to: run.to - bendClearance }))
    .filter((run) => run.to > run.from);
  let total = 0;
  for (const run of runs) total += run.to - run.from;
  for (let attempt = 0; attempt < 40 * wanted && out.dists.length < wanted && total > 0; attempt++) {
    let roll = rng.next() * total;
    let pick = 0;
    while (pick < runs.length - 1 && roll >= runs[pick].to - runs[pick].from) {
      roll -= runs[pick].to - runs[pick].from;
      pick++;
    }
    const d = Math.min(runs[pick].to, runs[pick].from + roll);
    const halfLength = rng.range(5, 7);
    const height = rng.range(0.35, 0.65) + 0.15 * daring;
    if (d < BUMP_END_CLEARANCE || d > length - BUMP_END_CLEARANCE) continue;
    if (!farFrom(d, gateDists, gateClearance) || !farFrom(d, crossings.dists, BUMP_CROSSING_CLEARANCE)) continue;
    if (!farFrom(d, out.dists, BUMP_SPACING)) continue;
    // The validator measures the width at path samples, up to one step beyond the ridge.
    let widest = 0;
    for (let s = d - halfLength - BUMP_WIDTH_PROBE; s <= d + halfLength + BUMP_WIDTH_PROBE; s += 0.5) {
      const k = cellAtDist(cells, s);
      widest = Math.max(widest, halfWidthAt(cells, plan, k, s - cells[k].startDist));
    }
    if (widest > BUMP_MAX_ROAD_HALF_WIDTH) continue;
    out.dists.push(d);
    out.halfLengths.push(halfLength);
    out.heights.push(height);
    out.halfWidths.push(widest + 1);
  }
  return out;
}

function makeBumps(cells: readonly Cell[], path: readonly PathPoint[], plan: BumpPlan): Bump[] {
  return plan.dists.map((d, k) => {
    const cell = cells[cellAtDist(cells, d)];
    const along = cell.entryOffset + (d - cell.startDist);
    const dirX = DIR_X[cell.inDir];
    const dirZ = DIR_Z[cell.inDir];
    return {
      x: snap(cell.cx * CELL + dirX * along),
      z: snap(cell.cz * CELL + dirZ * along),
      y: snap(pathHeightAt(path, d)),
      // A straight runs along a grid axis, so its direction is an exact unit vector.
      dirX,
      dirZ,
      halfLength: snap(plan.halfLengths[k]),
      halfWidth: snap(plan.halfWidths[k]),
      height: snap(plan.heights[k]),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------------------------------------------

export interface DecorSite {
  cx: number;
  cz: number;
  /** Cells between this one and the nearest road cell, counting diagonals as one. 0 is a road cell. */
  ring: number;
}

/**
 * Every cell within DECOR_RINGS of the road, in a shuffled order so that a capped count stays evenly spread.
 * The run-off cell counts as a road cell: the walled run-off reaches into it, so blocks proposed there need the
 * same "not on the tarmac" test as blocks in any cell the road passes through.
 */
function decorSites(rng: Rng, cells: readonly Cell[]): DecorSite[] {
  const known = new Map<number, DecorSite>();
  let frontier: DecorSite[] = cells.map((cell) => ({ cx: cell.cx, cz: cell.cz, ring: 0 }));
  frontier.push({ ...runOffCell(cells), ring: 0 });
  for (const site of frontier) known.set(cellKey(site.cx, site.cz), site);
  frontier = [...known.values()];
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
  const sites = [...known.values()].filter((site) => site.ring < DECOR_RINGS || rng.chance(OUTER_RING_CHANCE));
  return rng.shuffle(sites);
}

/** A random block somewhere in the cell. Its height is only a wish until the clearance rule has had its say. */
export function proposeBlock(rng: Rng, site: DecorSite): DecorBlock {
  const [minSize, maxSize] = DECOR_SIZE_BY_RING[site.ring];
  const x = snap(site.cx * CELL + rng.range(-HALF_CELL, HALF_CELL));
  const z = snap(site.cz * CELL + rng.range(-HALF_CELL, HALF_CELL));
  const w = snap(rng.range(minSize, maxSize));
  const d = snap(rng.range(minSize, maxSize));
  // Squaring the roll gives mostly low-rise with the occasional tower.
  const tall = rng.next();
  const h = DECOR_LOW_RISE + (RULES.decorMaxHeight - DECOR_LOW_RISE) * tall * tall;
  return { x, z, w, d, h, hue: rng.int(RULES.decorHues) };
}

/** The accepted blocks plus the lookups that keep them off the road and off each other. */
class DecorField {
  readonly blocks: DecorBlock[] = [];
  private readonly outline: WallIndex;
  private readonly onRoad: (x: number, z: number) => boolean;
  private readonly placed = new SpatialHash(DECOR_BUCKET);
  private readonly near: number[] = [];

  /** `outline`: every road edge and closed end, open or not. `onRoad`: is a point on any road in plan? */
  constructor(outline: readonly Segment[], onRoad: (x: number, z: number) => boolean) {
    this.outline = new WallIndex(outline);
    this.onRoad = onRoad;
  }

  private crowded(block: DecorBlock): boolean {
    const reachX = block.w / 2 + DECOR_GAP;
    const reachZ = block.d / 2 + DECOR_GAP;
    this.placed.collect(block.x - reachX, block.z - reachZ, block.x + reachX, block.z + reachZ, this.near);
    for (let k = 0; k < this.near.length; k++) {
      const other = this.blocks[this.near[k]];
      const apartX = Math.abs(other.x - block.x) - other.w / 2 - reachX;
      const apartZ = Math.abs(other.z - block.z) - other.d / 2 - reachZ;
      if (apartX < 0 && apartZ < 0) return true;
    }
    return false;
  }

  /**
   * Adds the block if it is clear of every road (in plan, so never under a bridge) and of other blocks, cutting
   * its height down to what its distance from the road allows. `onRoadCell` marks blocks that could have landed on
   * the tarmac itself, and blocks `maxClearance` or more from the road are turned away (Infinity accepts any).
   */
  tryAdd(block: DecorBlock, onRoadCell: boolean, maxClearance: number): boolean {
    if (this.crowded(block)) return false;
    const minX = block.x - block.w / 2;
    const minZ = block.z - block.d / 2;
    const maxX = minX + block.w;
    const maxZ = minZ + block.d;
    const wanted = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
    const limit = maxClearance < Infinity ? Math.max(wanted, maxClearance) : wanted;
    const clearance = this.outline.clearance(minX, minZ, maxX, maxZ, limit);
    if (clearance < RULES.decorMinClearance || clearance >= maxClearance) return false;
    if (onRoadCell && this.onRoad(block.x, block.z)) return false;
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
      field.tryAdd(proposeBlock(rng, site), site.ring === 0, maxClearance);
    }
  }
}

function scatterDecor(rng: Rng, cells: readonly Cell[], field: DecorField): DecorBlock[] {
  const sites = decorSites(rng, cells);
  const target = DECOR_TARGET_MIN + rng.int(DECOR_TARGET_MAX - DECOR_TARGET_MIN + 1);
  // The street front first: the locked camera mostly sees what stands beside the road.
  const front = sites.filter((site) => site.ring <= 1);
  fillDecor(rng, field, front, Math.round(target * DECOR_FRONT_SHARE), DECOR_FRONT_PASSES, DECOR_FRONT_DEPTH);
  const skyline = sites.filter((site) => site.ring >= 1);
  fillDecor(rng, field, skyline, target, DECOR_SKYLINE_PASSES, Infinity);
  return field.blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------------------------

/** Names of the random streams. Each part of a level draws only from its own. */
export interface StreamLabels {
  layout: string;
  width: string;
  elevation: string;
  edges: string;
  props: string;
  bumps: string;
  supports: string;
  decor: string;
}

export const DEFAULT_STREAMS: StreamLabels = {
  layout: 'layout',
  width: 'width',
  elevation: 'elevation',
  edges: 'edges',
  props: 'props',
  bumps: 'bumps',
  supports: 'supports',
  decor: 'decor',
};

/**
 * One generation attempt, not validated. Exported so tests can show that the streams are independent; the game
 * should call generateTrack / generateLevel.
 */
export function buildLevel(
  seed: string,
  id: string,
  options: TrackOptions = WEEKLY_OPTIONS,
  streams: StreamLabels = DEFAULT_STREAMS,
): Level {
  const rng = new Rng(seed);
  const walk = walkLayout(rng.fork(streams.layout), options);
  const cells = cellsFromWalk(walk);
  const crossings = crossingInfo(cells, walk.crossings);
  const nearCrossing = new Set<number>();
  for (const index of crossings.cells) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) nearCrossing.add(cellKey(cells[index].cx + dx, cells[index].cz + dz));
    }
  }
  const plan = planWidths(rng.fork(streams.width), cells, options, nearCrossing);
  const lastCell = cells[cells.length - 1];
  const lines = checkpointLines(cells, crossings, lastCell.startDist + lastCell.length, checkpointEvery(options));
  const gateDists = lines.map((line) => cells[line].startDist);
  const bumpPlan = planBumps(
    rng.fork(streams.bumps),
    cells,
    plan,
    crossings,
    [0, ...gateDists, lastCell.startDist + lastCell.length],
    options,
  );
  const profile = planHeights(rng.fork(streams.elevation), cells, crossings, bumpPlan, options);
  const road = buildRoad(sampleCentreline(cells, plan), profile);
  const path = road.path;
  const lastIndex = path.length - 1;
  const length = path[lastIndex].dist;
  const startDir = cells[0].outDir;
  const goalDir = lastCell.inDir;
  const index = new RoadIndex();
  index.add(path);

  const checkpoints = lines.map((line) => gateAt(road, cells[line].firstIndex, cells[line].inDir));
  const goal = gateAt(road, lastIndex, goalDir);
  // The bumps are known before the edges: a car launched by one flies further off an open edge after it.
  const bumps = makeBumps(cells, path, bumpPlan);
  const edges = planEdges(rng.fork(streams.edges), cells, road, index, crossings, gateDists, bumpPlan.dists, bumpsAlong(path, bumps), options);

  const startCap = startCapWalls(road, startDir);
  const goalCap = goalCapWalls(road, goalDir);
  const walls: Wall[] = [...startCap];
  emitEdgeWalls(path, road.left, road.right, edges.leftOpen, edges.rightOpen, walls);
  walls.push(...goalCap);

  const props = placeProps(rng.fork(streams.props), cells, crossings, edges, path, bumpPlan.dists, options);
  const supports: Support[] = [];
  placeSupports(rng.fork(streams.supports), path, index, 0, { spacing: [18, 24] }, supports);

  // Decor keeps clear of every road edge and closed end, open or not, and off every road and run-off in plan.
  const outline: Segment[] = [...startCap, ...goalCap];
  for (const edge of [road.left, road.right]) {
    for (let i = 0; i < lastIndex; i++) outline.push({ ax: edge[i].x, az: edge[i].z, bx: edge[i + 1].x, bz: edge[i + 1].z });
  }
  const hits: RoadHit[] = [];
  const corner = (wall: Wall, end: 'a' | 'b'): Vec2 => (end === 'a' ? { x: wall.ax, z: wall.az } : { x: wall.bx, z: wall.bz });
  const onRoad = (x: number, z: number): boolean =>
    index.query(x, z, 0, hits).length > 0 ||
    insideQuad(road.right[0], corner(startCap[1], 'a'), corner(startCap[1], 'b'), road.left[0], x, z) ||
    insideQuad(road.left[lastIndex], corner(goalCap[1], 'a'), corner(goalCap[1], 'b'), road.right[lastIndex], x, z);
  const decor = scatterDecor(rng.fork(streams.decor), cells, new DecorField(outline, onRoad));

  const piece = { path, left: road.left, right: road.right, walls, props: props.props, bumps, supports, decor };
  return {
    id,
    seed,
    genVersion: GEN_VERSION,
    ...piece,
    leftOpen: edges.leftOpen,
    rightOpen: edges.rightOpen,
    bounds: pieceBounds(piece),
    start: { x: path[0].x, z: path[0].z, heading: headingOf(startDir), y: path[0].y },
    checkpoints,
    goal,
    length,
  };
}

/** Builds and validates one attempt. Returns the reasons it failed instead of the level when it is not usable. */
function attemptLevel(seed: string, id: string, options: TrackOptions): Level | string[] {
  let level: Level;
  try {
    level = buildLevel(seed, id, options);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const verdict = validateLevel(level);
  return verdict.ok ? level : verdict.errors;
}

/**
 * Generates a level for a seed and a set of options. If an attempt fails validation the seed is extended and tried
 * again, and `Level.seed` records the seed that was actually used.
 */
export function generateTrack(seed: string, id: string, options: TrackOptions): Level {
  let failure: string[] = [];
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const outcome = attemptLevel(retry === 0 ? seed : `${seed}|retry${retry}`, id, options);
    if (!Array.isArray(outcome)) return outcome;
    failure = outcome;
  }
  throw new Error(`no valid level for seed "${seed}" after ${MAX_RETRIES} retries: ${failure.join('; ')}`);
}

/** A level with the weekly options for any seed. */
export function generateLevelFromSeed(seed: string, id: string): Level {
  return generateTrack(seed, id, WEEKLY_OPTIONS);
}

/** The level for a week id such as "2026-W48". */
export function generateLevel(id: string): Level {
  return generateTrack(seedForWeek(id), id, WEEKLY_OPTIONS);
}
