/**
 * Endless road generator: the road for infinite mode, handed out a chunk at a time.
 *
 * It uses the fixed levels' grid. Every cell holds a straight or a quarter-circle bend, and the road never leaves
 * the cells it walks through, so two stretches of road can only meet where the walk says they do. The road wanders
 * in any direction: a slowly turning "heading" biases each chunk's walk, and it climbs, drops and passes OVER or
 * UNDER earlier stretches of itself.
 *
 * MEMORY. The generator remembers the cells of the last CHUNK_RULES.memory chunks (with their height ranges). A new
 * chunk never enters one of those cells, except to CROSS it: the old cell is a plain straight, the new road goes
 * straight through it at right angles, and the height plan holds the new road level at least PLAN_CLEARANCE above
 * or below the old one through the whole overlap. Ground of older chunks is free again (the mode keeps far fewer
 * chunks alive than that).
 *
 * NEVER TRAPPED. A chunk is only accepted if, from the cell straight ahead of its exit, a breadth-first search over
 * free cells reaches open ground outside everything remembered. That route is kept: scenery never goes on it, so
 * the next chunk can always follow it if its own search (bounded, deterministic backtracking) finds nothing better.
 *
 * SCENERY. Decor blocks stand on the city floor in cells next to the road. A cell that holds scenery is reserved:
 * no road may enter it while that scenery can still be alive (CHUNK_RULES.liveWindow chunks), and a block's height
 * is limited by its distance to the nearest cell some later road could still use.
 *
 * How hard a chunk is comes from one number, its intensity, which grows with distance: hills, grades and crests,
 * crossings, open drop-off edges on raised road, bumps, bends, narrower road and pillars all rise with it.
 *
 * Every part of a chunk draws from its own random stream, so tuning the scenery never moves the road.
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
  Support,
  TrackChunk,
  Vec2,
  Wall,
} from '../types';
import { CELL, DIR_X, DIR_Z, centrePillar, pathHeightAt, proposeBlock, pushCellPoint, sidePillar } from './trackGen';
import type { Cell, CellKind, Centreline, DecorSite, PillarSpot } from './trackGen';
import {
  BEND_GRADE,
  DECK_THICKNESS,
  HeightProfile,
  MAX_RISE,
  PLAN_CLEARANCE,
  RAISED_HEIGHT,
  RoadIndex,
  chooseOpenEdges,
  bumpClimbAt,
  bumpsAlong,
  edgeLandsOnOther,
  forEachLandingPoint,
  emitEdgeWalls,
  maxClimb,
  pieceBounds,
  profileLimits,
  raisedSegments,
  snap,
  wallBetween,
  wander,
} from './road3d';
import type { BumpAlong, GradeLimit, ProfileLimits, RoadHit, WanderStyle } from './road3d';
import { RULES, SpatialHash, WallIndex } from './validate';
import { CHUNK_RULES, bumpLandingRoom, minBumpBeforeBend, minBumpToOpenEdge } from './validateChunk';

/** Cells of road in one chunk: between about 225 m (all bends) and 288 m (all straights). */
export const ENDLESS_CHUNK_CELLS = 6;

const LAST = ENDLESS_CHUNK_CELLS - 1;
const HALF_CELL = CELL / 2;
/** Travel directions are numbered clockwise from east, as in the level generator. */
const EAST = 0;
const PATH_STEP = 3;
const ARC_LENGTH = HALF_PI * HALF_CELL;
const ARC_STEPS = 13;
const MEMORY = CHUNK_RULES.memory;
const LIVE = CHUNK_RULES.liveWindow;

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

// ---- layout ----
/** Chance that a cell following straight road turns, at intensity 0 and 1. */
const TURN_CHANCE_GENTLE = 0.2;
const TURN_CHANCE_HARSH = 0.6;
const HAIRPIN_BIAS = 2.6;
/** Chance per chunk that the general heading turns a quarter left or right. */
const HEADING_TURN_CHANCE = 0.3;
const HEADING_AHEAD = 1.35;
const HEADING_BACK = 0.45;
/** Chance per chunk that the walk goes looking for road to cross, at intensity 0 and 1. */
const CROSS_WANT_GENTLE = 0.1;
const CROSS_WANT_HARSH = 0.85;
const CROSS_PULL_ON = 8;
const CROSS_PULL_CLOSER = 8;
const CROSS_PULL_AWAY = 0.15;
const MAX_CROSSINGS = 2;
/** From this intensity a chunk that wanted to cross and did not leaves the wish to the next one. */
const SEEK_INTENSITY = 0.45;
/** Guided approaches to a crossing a walk tries before searching freely. */
const GUIDED_TRIES = 8;
/**
 * Chance that a plain straight is kept ready to be crossed later (no open edge near its middle; one without a bump
 * or pillar there can then be crossed), at intensity 0 and 1.
 */
const READY_CHANCE_GENTLE = 0.5;
const READY_CHANCE_HARSH = 0.75;
/** Share of the ready straights that also keep bumps and pillars away from their middle. */
const READY_CLEAR_SHARE = 0.5;
const WALK_BUDGET = 1500;
/** Cells a trap search may visit; far more than the remembered road can enclose. */
const ESCAPE_LIMIT = 40_000;

// ---- crossings ----
/** Both roads are level this far either side of the middle of a crossing cell (the overlap reaches ~29 m). */
const CROSS_HOLD = 32;
/** The old road's height range is taken over this far either side of the middle of the cell. */
const CROSS_OLD_REACH = 40;
const CROSS_MAX_HEIGHT = 36;
/**
 * Bumps, pillars and open edges this close (centreline) to the middle of a cell make it uncrossable, and the new
 * road keeps them this far from its crossings. The heart of a crossing (where one centreline is within the other
 * road's half width) reaches up to 13.5 m either way of the middle; the validator's keep-out is measured from there.
 */
const CROSS_HEART = CHUNK_RULES.crossingMaxHalfWidth;
const CROSS_FEATURE_KEEP = CROSS_HEART + CHUNK_RULES.crossingKeepOut + 2.5;
const CROSS_EDGE_KEEP = CROSS_HEART + CHUNK_RULES.crossingKeepOut + 4.5;
const CROSS_BUMP_KEEP = 64;
const CROSS_PROP_KEEP = 46;
/** Share of the steepest climb the height plan may use. */
const HEIGHT_SAFETY = 0.95;

// ---- heights ----
/** The first chunk is level for this long, then gentle, and stays low. */
const FIRST_LEVEL = 64;
const FIRST_GENTLE = 110;
const FIRST_MAX_HEIGHT = 4;
const MIN_HILL = 5;

// ---- widths ----
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
const BLEND = 16;
const PLAZA_BLEND = 20;
/** Either side of a chunk join the road holds the width the two chunks agreed on. */
const JOIN_HOLD = 15;
/** The closed end behind the start. */
const START_CAP = 14;

// ---- bumps ----
const BUMPS_PER_CHUNK_GENTLE = 0.35;
const BUMPS_PER_CHUNK_HARSH = 2.6;
const MAX_BUMPS = 3;
const BUMP_SLACK = 0.25;
const BUMP_SPACING = CHUNK_RULES.bumpSpacing + 1;
const BUMP_JOIN_CLEARANCE = CHUNK_RULES.bumpJoinClearance + 1;
const BUMP_AFTER_BEND = CHUNK_RULES.bumpBendGapGentle + BUMP_SLACK;
const BUMP_CELL_MARGIN = 8;
const BUMP_MIN_HEIGHT_GENTLE = 0.35;
const BUMP_MIN_HEIGHT_HARSH = 0.65;
const BUMP_HEIGHT_SPREAD = 0.15;
const BUMP_OVERHANG = 1;
/** The road is held level this far beyond each end of a ridge. */
const BUMP_LEVEL = CHUNK_RULES.bumpLevelReach + 3;

// ---- open edges ----
const OPEN_SHARE_GENTLE = 0.04;
const OPEN_SHARE_HARSH = 0.35;
const OPEN_JOIN_KEEP = CHUNK_RULES.openJoinClearance + 2;
const OPEN_MAX_HALF_WIDTH = CHUNK_RULES.openMaxHalfWidth - 0.1;
const OPEN_GAP = 20;
const OTHER_ROAD_GAP = RULES.overlapPathGap;

// ---- pillars ----
const MAX_PILLARS = 2;
const PLAZA_PILLAR_CHANCE_GENTLE = 0.08;
const PLAZA_PILLAR_CHANCE_HARSH = 0.9;
const STRAIGHT_PILLAR_CHANCE_GENTLE = 0.02;
const STRAIGHT_PILLAR_CHANCE_HARSH = 0.85;
const CENTRE_PILLAR_MIN_HALF_WIDTH = 17;
const PLAZA_PILLAR_REACH = 3;
const STRAIGHT_PILLAR_REACH = 7;
const JOIN_PILLAR_REACH = 3;
const PROP_SPACING = RULES.propSpacing + 4;
const PROP_BUMP_CLEARANCE = CHUNK_RULES.bumpPropClearance + 5;
const OPEN_PROP_KEEP = CHUNK_RULES.openPropClearance + 4;
const PROP_HUES = 6;

// ---- supports ----
const SUPPORT_SPACING: [number, number] = [18, 24];
const SUPPORT_RADIUS: [number, number] = [0.9, 1.4];
/**
 * No column this close (along the road) to the middle of a straight cell: a later road may cross under there, and
 * its footprint (half width up to 12.5 m) plus the column and its clearance must fit.
 */
const SUPPORT_BAND = 15.5;

// ---- decor ----
const DECOR_CELL_CHANCE = 0.7;
const DECOR_TARGET_MIN = 35;
const DECOR_TARGET_MAX = 70;
const DECOR_FRONT_SHARE = 0.6;
const DECOR_FRONT_DEPTH = 34;
const DECOR_FRONT_PASSES = 8;
const DECOR_SKYLINE_PASSES = 12;
const DECOR_GAP = 2;
const DECOR_BUCKET = 24;
/** A road never comes closer than this to a cell it does not pass through (half widths are at most 19 m). */
const FUTURE_ROAD_GAP = 5;

/** The grid has no edge, so cells are keyed over a far wider range than the level generator needs. */
const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 1 << 21;

function cellKey(cx: number, cz: number): number {
  return (cx + KEY_OFFSET) * KEY_SPAN + (cz + KEY_OFFSET);
}

function keyX(key: number): number {
  return Math.floor(key / KEY_SPAN) - KEY_OFFSET;
}

function keyZ(key: number): number {
  return (key % KEY_SPAN) - KEY_OFFSET;
}

/** How much the road climbs at an intensity: 0 (flat) .. 1 (big climbs, steep drops, sharp crests). */
function elevationAt(intensity: number): number {
  return lerp(0.15, 1, smoothstep(0.05, 0.85, intensity));
}

function maxHeightFor(elevation: number, first: boolean): number {
  return first ? FIRST_MAX_HEIGHT : lerp(MIN_HILL, MAX_RISE, elevation);
}

// ---------------------------------------------------------------------------------------------------------------
// Memory: what the generator knows about cells of earlier chunks
// ---------------------------------------------------------------------------------------------------------------

interface Occupant {
  chunk: number;
  kind: CellKind;
  /** Travel direction through the cell on entering it. */
  dir: number;
  /** Centreline distance of the middle of the cell. */
  centre: number;
  /** A later road may pass over or under it. */
  crossable: boolean;
  /** Road height range around the middle of the cell (see CROSS_OLD_REACH). */
  lo: number;
  hi: number;
  crossed: boolean;
}

interface CrossPlan {
  key: number;
  occupant: Occupant;
  /** Chunk-local centreline distance of the middle of the crossing cell. */
  centre: number;
  /** Heights the new road may be held at through the crossing. */
  lo: number;
  hi: number;
  /** Walk height state before this crossing, restored on backtracking. */
  prevEnd: number;
  prevLo: number;
  prevHi: number;
}

interface Walk {
  rng: Rng;
  index: number;
  intensity: number;
  first: boolean;
  /** Second try: consecutive bends allowed at any intensity, no crossings. */
  relaxed: boolean;
  heading: number;
  inDir0: number;
  straightTail: number;
  wantCross: boolean;
  /**
   * Free cells either side of crossable straights: (sideA, sideB) as four numbers (ax, az, bx, bz) per crossable
   * cell, which lies between them.
   */
  entries: number[];
  /** Cells the walk must follow first, as (cx, cz) pairs starting with cell 0 (a guided approach to a crossing). */
  guide: number[];
  limits: ProfileLimits;
  cx: number[];
  cz: number[];
  /** out[k] is the travel direction on leaving cell k. */
  out: number[];
  /** Chunk-local distance where cell k begins. */
  starts: number[];
  crossing: (CrossPlan | null)[];
  own: Set<number>;
  crossCount: number;
  /** Where the last height constraint (chunk start or crossing hold) ends, and the heights possible there. */
  heightEnd: number;
  heightLo: number;
  heightHi: number;
  budget: number;
  exitDir: number;
  /** Route from the cell ahead of the exit to open ground, as (cx, cz) pairs. */
  escape: number[];
}

function inDirOf(walk: Walk, k: number): number {
  return k === 0 ? walk.inDir0 : walk.out[k - 1];
}

function isBend(walk: Walk, k: number): boolean {
  return inDirOf(walk, k) !== walk.out[k];
}

function cellLength(walk: Walk, k: number): number {
  if (isBend(walk, k)) return ARC_LENGTH;
  return walk.first && k === 0 ? HALF_CELL : CELL;
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
  let weight: number;
  if (dir === inDir) {
    const longStraight = straightsBefore(walk, k) >= (i < 0.5 ? 3 : 2);
    weight = (1 - turnChance) * (longStraight ? 0.35 : 1);
  } else {
    const bends = bendsBefore(walk, k);
    let chain = 1;
    if (bends > 0) {
      // A gentle road never puts two bends in consecutive cells (unless that is the only way on).
      if (i < GENTLE && !walk.relaxed) return 0;
      // A second bend the same way makes a hairpin; the other way makes an S-bend.
      const sameWay = turnBetween(inDir, dir) === turnBetween(inDirOf(walk, k - 1), inDir);
      const shape = sameWay ? lerp(1, HAIRPIN_BIAS, smoothstep(0.5, 1, i)) : 0.9;
      chain = shape * (bends === 1 ? lerp(0.35, 1.1, smoothstep(GENTLE, 0.8, i)) : 0.3 * smoothstep(0.4, 1, i));
      if (walk.relaxed) chain = Math.max(chain, 0.15);
    }
    weight = (turnChance / 2) * chain;
  }
  // A walk looking for road to cross has no favourite direction: it must be free to come back.
  if (walk.wantCross && walk.entries.length > 0) return weight;
  const relative = (dir - walk.heading + 4) & 3;
  return weight * (relative === 0 ? HEADING_AHEAD : relative === 2 ? HEADING_BACK : 1);
}

/** Grade limit at a chunk-local distance, given whether the cell there is a bend. */
function gradeFor(limits: ProfileLimits, bent: boolean, first: boolean, d: number): number {
  let g = bent ? limits.bendGrade : limits.maxGrade;
  if (first) {
    if (d < FIRST_LEVEL) return 0;
    if (d < FIRST_GENTLE) g = Math.min(g, BEND_GRADE);
  }
  return g;
}

/** Grade limit over the cells a walk has laid so far; cell `known` and beyond count as straight. */
function walkLimit(walk: Walk, known: number): GradeLimit {
  return (d: number): number => {
    let k = 0;
    while (k + 1 <= known && walk.starts[k + 1] <= d) k++;
    return gradeFor(walk.limits, k < known && isBend(walk, k), walk.first, d);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cells and widths
// ---------------------------------------------------------------------------------------------------------------

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
    const entryOffset = walk.first && k === 0 ? 0 : -HALF_CELL;
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

function cellAtDist(cells: readonly Cell[], d: number): number {
  let k = 0;
  while (k + 1 < cells.length && cells[k + 1].startDist <= d) k++;
  return k;
}

/** Chunk-local distance of the middle of a straight cell. */
function cellCentre(cell: Cell): number {
  return cell.startDist - cell.entryOffset;
}

interface WidthPlan {
  base: number;
  corner: number;
  /** Half width at the start of the chunk: the base width of the chunk before it. */
  entry: number;
}

function planWidths(
  rng: Rng,
  cells: Cell[],
  intensity: number,
  entry: number | null,
  first: boolean,
  plain: ReadonlySet<number>,
  openSides: (cell: Cell) => boolean,
): WidthPlan {
  const wanted = lerp(BASE_HALF_WIDTH_GENTLE, BASE_HALF_WIDTH_HARSH, intensity);
  const base = Math.max(MIN_BASE_HALF_WIDTH, wanted + rng.range(-BASE_HALF_WIDTH_JITTER, BASE_HALF_WIDTH_JITTER));
  const corner = Math.min(MAX_CORNER_HALF_WIDTH, base + rng.range(0.8, 2.2));
  const plazaChance = lerp(PLAZA_CHANCE_GENTLE, PLAZA_CHANCE_HARSH, intensity);
  const narrowChance = lerp(NARROW_CHANCE_GENTLE, NARROW_CHANCE_HARSH, intensity);
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    cell.midWidth = cell.kind === 'corner' ? corner : base;
    const roll = rng.next();
    const size = rng.next();
    // The cells at both ends stay plain so every join is predictable, and so does the road right after the start
    // and through and beside every crossing.
    if (cell.kind !== 'straight' || k === 0 || k === LAST || (first && k < 2) || plain.has(k)) continue;
    if (roll < plazaChance && openSides(cell) && cells[k - 1].kind !== 'plaza') {
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

// ---------------------------------------------------------------------------------------------------------------
// Bumps (planned before the heights: the road is held level under every one)
// ---------------------------------------------------------------------------------------------------------------

interface BumpPlan {
  /** Chunk-local crest positions. */
  local: number[];
  halfLengths: number[];
  heights: number[];
  halfWidths: number[];
  cells: number[];
}

function emptyBumps(): BumpPlan {
  return { local: [], halfLengths: [], heights: [], halfWidths: [], cells: [] };
}

function widestUnder(cells: readonly Cell[], plan: WidthPlan, index: number, s: number, halfLength: number): number {
  let widest = halfWidthAt(cells, plan, index, s);
  for (let offset = -halfLength; offset <= halfLength; offset += 0.5) {
    widest = Math.max(widest, halfWidthAt(cells, plan, index, s + offset));
  }
  return Math.max(widest, halfWidthAt(cells, plan, index, s + halfLength));
}

/**
 * Picks where in a plain straight cell a crest may go, or null when the cell is unsuitable. A gentle road leaves
 * landing room after every crest; as the intensity rises a crest may sit just before the bend that follows.
 * It draws the same random numbers whether or not the cell turns out to be suitable.
 */
function bumpSpot(
  rng: Rng,
  cells: readonly Cell[],
  k: number,
  intensity: number,
  enteredFromBend: boolean,
): { s: number; halfLength: number; lo: number; wanted: number; beforeBend: boolean } | null {
  const cell = cells[k];
  const afterBend = k > 0 ? cells[k - 1].kind === 'corner' : enteredFromBend;
  const beforeBend = k < LAST && cells[k + 1].kind === 'corner';
  const toBend = minBumpBeforeBend(intensity) + BUMP_SLACK;
  const daring = rng.chance(smoothstep(GENTLE, 1, intensity));
  const spread = rng.next();
  const wanted = rng.range(CHUNK_RULES.bumpMinHalfLength, CHUNK_RULES.bumpMaxHalfLength);
  // The road is held level for the ridge and BUMP_LEVEL beyond, all inside the chunk.
  const hold = wanted + BUMP_LEVEL + 1;
  const lo = Math.max(afterBend ? BUMP_AFTER_BEND : BUMP_CELL_MARGIN, k === 0 ? Math.max(BUMP_JOIN_CLEARANCE, hold) : 0);
  // The next chunk may open with a bend, so the end of the chunk is treated as one.
  const toEnd = beforeBend ? toBend : k === LAST ? Math.max(BUMP_JOIN_CLEARANCE, toBend, hold) : BUMP_CELL_MARGIN;
  const hi = cell.length - toEnd;
  if (hi < lo) return null;
  const s = beforeBend && daring ? hi - spread * Math.min(3, hi - lo) : lerp(lo, hi, spread);
  // The whole ridge stays on straight road.
  const halfLength = beforeBend ? Math.min(wanted, cell.length - s - BUMP_SLACK) : wanted;
  return { s, halfLength, lo, wanted, beforeBend };
}

/** Straight road from chunk-local distance `local` in cell k to the next bend of the chunk, or to its end, m. */
function roomAhead(cells: readonly Cell[], k: number, local: number, length: number): number {
  for (let j = k + 1; j < cells.length; j++) if (cells[j].kind === 'corner') return cells[j].startDist - local;
  return length - local;
}

/** Bump heights are lowered in steps of this while looking for one that fits, m. */
const BUMP_HEIGHT_STEP = 1 / 64;

/**
 * The highest crest, at most `height`, whose flight (bumpLandingRoom) fits in `room` metres of straight road, or null
 * when not even the lowest bump does.
 */
function fitBumpHeight(height: number, halfLength: number, room: number): number | null {
  for (let h = height; h >= BUMP_MIN_HEIGHT_GENTLE; h -= BUMP_HEIGHT_STEP) {
    if (bumpLandingRoom(h, halfLength) <= room) return h;
  }
  return bumpLandingRoom(BUMP_MIN_HEIGHT_GENTLE, halfLength) <= room ? BUMP_MIN_HEIGHT_GENTLE : null;
}

function planBumps(
  rng: Rng,
  cells: readonly Cell[],
  plan: WidthPlan,
  startDist: number,
  intensity: number,
  lastBumpDist: number,
  crossCentres: readonly number[],
  clearCentres: readonly number[],
  enteredFromBend: boolean,
  lastOpenDist: number,
): BumpPlan {
  const out = emptyBumps();
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
  const last = cells[LAST];
  const length = last.startDist + last.length;
  for (const k of sites) {
    const cell = cells[k];
    const picked = bumpSpot(rng, cells, k, intensity, enteredFromBend);
    const planned = lerp(BUMP_MIN_HEIGHT_GENTLE, BUMP_MIN_HEIGHT_HARSH, intensity) + rng.range(0, BUMP_HEIGHT_SPREAD);
    if (picked === null || out.local.length >= wanted) continue;
    // A car flying off the crest must not be carried over the barrier of the next bend (or the next chunk's, which
    // may open with one): a ridge too sharp for the straight road left ahead is lowered, moved back to the start of
    // its straight, or left out.
    let spot: { s: number; halfLength: number } = picked;
    let height = fitBumpHeight(planned, spot.halfLength, roomAhead(cells, k, cell.startDist + spot.s, length) - BUMP_SLACK);
    if (height === null || height < planned) {
      const s = picked.lo;
      const halfLength = picked.beforeBend ? Math.min(picked.wanted, cell.length - s - BUMP_SLACK) : picked.wanted;
      const earlier = fitBumpHeight(planned, halfLength, roomAhead(cells, k, cell.startDist + s, length) - BUMP_SLACK);
      if (earlier !== null && (height === null || earlier > height)) {
        spot = { s, halfLength };
        height = earlier;
      }
    }
    if (height === null) continue;
    const local = cell.startDist + spot.s;
    const reach = spot.halfLength + BUMP_LEVEL;
    if (local - reach < 1 || local + reach > Math.floor(length) - 1) continue;
    let clear = startDist + local - lastBumpDist >= BUMP_SPACING;
    // A gentle road keeps its crests clear of the open edges the previous chunk ended with.
    clear = clear && startDist + local - lastOpenDist >= minBumpToOpenEdge(intensity) + 2;
    for (const d of out.local) clear = clear && Math.abs(local - d) >= BUMP_SPACING;
    for (const c of crossCentres) clear = clear && Math.abs(local - c) >= CROSS_BUMP_KEEP;
    for (const c of clearCentres) clear = clear && Math.abs(local - c) >= CROSS_FEATURE_KEEP + 1;
    if (!clear) continue;
    out.local.push(local);
    out.halfLengths.push(spot.halfLength);
    out.heights.push(height);
    out.halfWidths.push(
      Math.max(halfWidthAt(cells, plan, k, spot.s) + BUMP_OVERHANG, widestUnder(cells, plan, k, spot.s, spot.halfLength) + BUMP_SLACK),
    );
    out.cells.push(k);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------------------------------------------

interface Anchor {
  from: number;
  to: number;
  /** Allowed heights, and the part of them preferred. */
  lo: number;
  hi: number;
  preferLo: number;
  preferHi: number;
  /** Index into the bump plan, or -1. */
  bump: number;
  height: number;
}

/** A height in [lo, hi], uniformly inside [preferLo, preferHi] when that overlaps, on the lattice when possible. */
function pickHeight(rng: Rng, lo: number, hi: number, preferLo: number, preferHi: number): number {
  const u = rng.next();
  const a = Math.max(lo, preferLo);
  const b = Math.min(hi, preferHi);
  const raw = a <= b ? a + (b - a) * u : lo + (hi - lo) * u;
  let v = snap(raw);
  if (v > hi) v = Math.floor(hi * 1024) / 1024;
  if (v < lo) v = Math.ceil(lo * 1024) / 1024;
  return v < lo || v > hi ? raw : v;
}

/**
 * Picks a height for every level hold so consecutive holds can be joined within the grade limits. Exact: works out
 * the heights reachable at each hold going forwards, then picks backwards inside them. Returns false when the holds
 * cannot all be met.
 */
function solveAnchors(rng: Rng, anchors: Anchor[], h0: number, limit: GradeLimit, gradeChange: number): boolean {
  const budgets: number[] = [];
  const reachLo: number[] = [];
  const reachHi: number[] = [];
  let lo = h0;
  let hi = h0;
  let end = 0;
  for (const a of anchors) {
    if (a.from < end) return false;
    const budget = a.from > end ? maxClimb(end, a.from, limit, gradeChange) * HEIGHT_SAFETY : 0;
    lo = Math.max(a.lo, lo - budget);
    hi = Math.min(a.hi, hi + budget);
    if (lo > hi) return false;
    budgets.push(budget);
    reachLo.push(lo);
    reachHi.push(hi);
    end = a.to;
  }
  for (let k = anchors.length - 1; k >= 0; k--) {
    const a = anchors[k];
    let lo = reachLo[k];
    let hi = reachHi[k];
    if (k + 1 < anchors.length) {
      lo = Math.max(lo, anchors[k + 1].height - budgets[k + 1]);
      hi = Math.min(hi, anchors[k + 1].height + budgets[k + 1]);
    }
    if (lo > hi) return false;
    a.height = pickHeight(rng, lo, hi, a.preferLo, a.preferHi);
  }
  return true;
}

interface CrossingCell {
  /** Cell index in the chunk. */
  k: number;
  key: number;
  centre: number;
  lo: number;
  hi: number;
  occupant: Occupant;
}

/**
 * The chunk's height profile (chunk-local distances): level at the start (where the last chunk ended) and at the
 * end, level and clear of the old road through every crossing, level under every bump, random hills between.
 * Bumps that cannot be fitted are dropped from the plan.
 */
function planHeights(
  rng: Rng,
  cells: readonly Cell[],
  crossings: readonly CrossingCell[],
  bumps: BumpPlan,
  h0: number,
  limits: ProfileLimits,
  elevation: number,
  first: boolean,
): HeightProfile {
  const last = cells[LAST];
  const length = last.startDist + last.length;
  const limit: GradeLimit = (d) => gradeFor(limits, cells[cellAtDist(cells, d)].kind === 'corner', first, d);
  const maxHeight = maxHeightFor(elevation, first);
  let keep = bumps.local.map(() => true);
  let anchors: Anchor[] = [];
  for (let attempt = 0; attempt <= bumps.local.length; attempt++) {
    anchors = [];
    for (const c of crossings) {
      const lowSide = c.hi <= c.occupant.lo;
      const preferLo = lowSide ? c.lo + (c.hi - c.lo) * 0.4 : c.lo;
      const preferHi = lowSide ? c.hi : c.lo + (c.hi - c.lo) * 0.6;
      anchors.push({ from: c.centre - CROSS_HOLD, to: c.centre + CROSS_HOLD, lo: c.lo, hi: c.hi, preferLo, preferHi, bump: -1, height: 0 });
    }
    bumps.local.forEach((d, b) => {
      if (!keep[b]) return;
      const reach = bumps.halfLengths[b] + BUMP_LEVEL;
      anchors.push({ from: Math.floor(d - reach), to: Math.ceil(d + reach), lo: 0, hi: CROSS_MAX_HEIGHT, preferLo: 0, preferHi: maxHeight, bump: b, height: 0 });
    });
    anchors.sort((a, b) => a.from - b.from);
    anchors.push({ from: Math.floor(length), to: Math.ceil(length) + 1, lo: 0, hi: CROSS_MAX_HEIGHT, preferLo: 0, preferHi: maxHeight, bump: -1, height: 0 });
    if (solveAnchors(rng, anchors, h0, limit, limits.gradeChange)) break;
    // Drop the last bump still planned and try again.
    let dropped = false;
    for (let b = keep.length - 1; b >= 0 && !dropped; b--) {
      if (keep[b]) {
        keep[b] = false;
        dropped = true;
      }
    }
    if (!dropped) {
      // Cannot happen: the walk only plans crossings it has checked can be reached. Never throw: let the road
      // run as it can; the validator would report the low crossing.
      keep = keep.map(() => false);
      for (const a of anchors) {
        a.lo = 0;
        a.hi = CROSS_MAX_HEIGHT;
      }
      solveAnchors(rng, anchors, h0, limit, limits.gradeChange);
      break;
    }
  }
  // Remove the dropped bumps from the plan.
  for (let b = keep.length - 1; b >= 0; b--) {
    if (keep[b]) continue;
    bumps.local.splice(b, 1);
    bumps.halfLengths.splice(b, 1);
    bumps.heights.splice(b, 1);
    bumps.halfWidths.splice(b, 1);
    bumps.cells.splice(b, 1);
  }
  const style: WanderStyle = {
    maxHeight,
    ramp: [lerp(70, 35, elevation), lerp(150, 100, elevation)],
    hold: [0, lerp(50, 25, elevation)],
    drama: lerp(0.25, 0.85, elevation),
  };
  const profile = new HeightProfile(0, h0, limit, limits.gradeChange);
  if (first) profile.holdTo(FIRST_LEVEL);
  for (const a of anchors) {
    if (!wander(profile, rng, a.from, a.height, style) && !profile.rampTo(a.from, a.height)) {
      // Unreachable by construction; keep going level rather than throw.
      profile.holdTo(a.from);
    }
    profile.holdTo(a.to);
  }
  return profile;
}

// ---------------------------------------------------------------------------------------------------------------
// Road geometry
// ---------------------------------------------------------------------------------------------------------------

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
 * Offsets the centreline to both sides and snaps everything to the lattice. Inside the chunk the normal comes from
 * a central difference; at the far end the road is known to head exactly along the exit direction, which keeps the
 * walls of two chunks meeting without a gap whatever follows.
 */
function buildRoad(line: Centreline, startDist: number, join: Join | null, profile: HeightProfile, exitDir: number): Road {
  const road: Road = { path: [], left: [], right: [] };
  const last = line.x.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i === 0 && join) {
      road.path.push({ ...join.point });
      road.left.push({ ...join.left });
      road.right.push({ ...join.right });
      continue;
    }
    const tx = i === last ? DIR_X[exitDir] : line.x[i + 1] - line.x[i > 0 ? i - 1 : 0];
    const tz = i === last ? DIR_Z[exitDir] : line.z[i + 1] - line.z[i > 0 ? i - 1 : 0];
    const reach = line.halfWidth[i] / Math.sqrt(tx * tx + tz * tz);
    // Right of the travel direction (tx, tz) is (-tz, tx).
    road.right.push({ x: snap(line.x[i] - tz * reach), z: snap(line.z[i] + tx * reach) });
    road.left.push({ x: snap(line.x[i] + tz * reach), z: snap(line.z[i] - tx * reach) });
    road.path.push({
      x: snap(line.x[i]),
      z: snap(line.z[i]),
      y: snap(Math.max(0, profile.heightAt(line.dist[i]))),
      halfWidth: snap(line.halfWidth[i]),
      dist: snap(startDist + line.dist[i]),
    });
  }
  return road;
}

/** The closed end behind the start, at the start's height. Runs from the right edge round to the left edge. */
function startCapWalls(road: Road, startDir: number): Wall[] {
  const y = road.path[0].y;
  const back = (p: Vec2): Vec2 => ({ x: p.x - DIR_X[startDir] * START_CAP, z: p.z - DIR_Z[startDir] * START_CAP });
  const backLeft = back(road.left[0]);
  const backRight = back(road.right[0]);
  return [
    wallBetween(road.right[0], backRight, y, y),
    wallBetween(backRight, backLeft, y, y),
    wallBetween(backLeft, road.left[0], y, y),
  ];
}

/** True when a hit lies on a different stretch of road than centreline distance `dist`. */
function otherStretch(hits: readonly RoadHit[], dist: number, gap: number): boolean {
  for (let k = 0; k < hits.length; k++) if (Math.abs(hits[k].dist - dist) > gap) return true;
  return false;
}

/**
 * True when a car going over edge segment i could come down on another stretch of road (see
 * road3d.edgeLandsOnOther: just beyond the edge at any height, or anywhere it could fly to).
 */
function edgeOverOther(
  index: RoadIndex,
  live: (road: number) => boolean,
  path: readonly PathPoint[],
  edge: readonly Vec2[],
  i: number,
  hits: RoadHit[],
  climb: number,
): boolean {
  const mid = (path[i].dist + path[i + 1].dist) / 2;
  return edgeLandsOnOther(
    path,
    edge,
    i,
    (x, z) => index.query(x, z, 0, hits),
    (hit, far) => Math.abs(hit.dist - mid) > OTHER_ROAD_GAP && (!far || live(hit.road)),
    climb,
  );
}

/** Whether a car flying off edge segment i could come down in one of `cells` (see road3d.forEachLandingPoint). */
function landsIn(path: readonly PathPoint[], edge: readonly Vec2[], i: number, cells: ReadonlySet<number>, climb: number): boolean {
  let found = false;
  forEachLandingPoint(
    path,
    edge,
    i,
    (x, z) => {
      if (!found && cells.has(cellKey(cellOf(x), cellOf(z)))) found = true;
    },
    climb,
  );
  return found;
}

/** Ground the next chunk is promised: its route to open ground and the cells around its first cell. */
function promisedCells(walk: Walk): Set<number> {
  const keepFree = new Set<number>();
  for (let n = 0; n + 1 < walk.escape.length; n += 2) keepFree.add(cellKey(walk.escape[n], walk.escape[n + 1]));
  const ex = walk.cx[LAST] + DIR_X[walk.exitDir];
  const ez = walk.cz[LAST] + DIR_Z[walk.exitDir];
  for (let d = 0; d < 4; d++) keepFree.add(cellKey(ex + DIR_X[d], ez + DIR_Z[d]));
  keepFree.add(cellKey(ex, ez));
  return keepFree;
}

/**
 * Cells a car flying off any open edge of the road could come down in, other than the chunk's own: later road must
 * stay out of them while this chunk can be live (they are reserved like scenery ground).
 */
function landingCells(
  road: Road,
  edges: { leftOpen: boolean[]; rightOpen: boolean[] },
  own: ReadonlySet<number>,
  bumpsOnRoad: readonly BumpAlong[],
): number[] {
  const out = new Set<number>();
  const path = road.path;
  for (let i = 0; i + 1 < path.length; i++) {
    for (const [open, edge] of [
      [edges.leftOpen, road.left],
      [edges.rightOpen, road.right],
    ] as const) {
      if (!open[i]) continue;
      forEachLandingPoint(
        path,
        edge,
        i,
        (x, z) => {
          const key = cellKey(cellOf(x), cellOf(z));
          if (!own.has(key)) out.add(key);
        },
        bumpClimbAt(bumpsOnRoad, (path[i].dist + path[i + 1].dist) / 2),
      );
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------
// Open edges
// ---------------------------------------------------------------------------------------------------------------

function nearAny(d0: number, d1: number, dists: readonly number[], reach: number): boolean {
  for (const d of dists) if (d1 > d - reach && d0 < d + reach) return true;
  return false;
}

function planEdges(
  rng: Rng,
  road: Road,
  intensity: number,
  crossDists: readonly number[],
  bumpDists: readonly number[],
  index: RoadIndex,
  live: (road: number) => boolean,
  keepFree: ReadonlySet<number>,
  bumpsOnRoad: readonly BumpAlong[],
): { leftOpen: boolean[]; rightOpen: boolean[] } {
  // crossDists holds both crossings and the middles of straights kept ready for one.
  const path = road.path;
  const n = path.length;
  const raised = raisedSegments(path, RAISED_HEIGHT);
  const bendVertex: boolean[] = new Array<boolean>(n).fill(false);
  for (let i = 1; i + 1 < n; i++) {
    const ax = path[i].x - path[i - 1].x;
    const az = path[i].z - path[i - 1].z;
    const bx = path[i + 1].x - path[i].x;
    const bz = path[i + 1].z - path[i].z;
    const scale = Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
    bendVertex[i] = scale > 0 && Math.abs(ax * bz - az * bx) > 0.01 * scale;
  }
  const bend: boolean[] = new Array<boolean>(n).fill(false);
  const allowLeft: boolean[] = new Array<boolean>(n).fill(false);
  const allowRight: boolean[] = new Array<boolean>(n).fill(false);
  const bumpKeep = minBumpToOpenEdge(intensity);
  const bendsOk = intensity >= CHUNK_RULES.openBendIntensity;
  const startDist = path[0].dist;
  const endDist = path[n - 1].dist;
  const hits: RoadHit[] = [];
  for (let i = 0; i + 1 < n; i++) {
    bend[i] = bendVertex[i] || bendVertex[i + 1];
    if (!raised[i]) continue;
    const a = path[i];
    const b = path[i + 1];
    if (Math.max(a.halfWidth, b.halfWidth) > OPEN_MAX_HALF_WIDTH) continue;
    if (a.dist < startDist + OPEN_JOIN_KEEP || b.dist > endDist - OPEN_JOIN_KEEP) continue;
    if (bend[i] && !bendsOk) continue;
    if (nearAny(a.dist, b.dist, crossDists, CROSS_EDGE_KEEP)) continue;
    if (bumpKeep > 0 && nearAny(a.dist, b.dist, bumpDists, bumpKeep + 2)) continue;
    // Nor where a car going over it could come down on other road, or on ground promised to the next chunk.
    const climb = bumpClimbAt(bumpsOnRoad, (a.dist + b.dist) / 2);
    allowLeft[i] = !edgeOverOther(index, live, path, road.left, i, hits, climb) && !landsIn(path, road.left, i, keepFree, climb);
    allowRight[i] = !edgeOverOther(index, live, path, road.right, i, hits, climb) && !landsIn(path, road.right, i, keepFree, climb);
  }
  const share = lerp(OPEN_SHARE_GENTLE, OPEN_SHARE_HARSH, smoothstep(0.1, 1, intensity));
  const run: [number, number] = [lerp(28, 40, intensity), lerp(50, 120, intensity)];
  const plan = chooseOpenEdges(rng, { path, raised, allowLeft, allowRight, bend, share, run, gap: OPEN_GAP });
  return { leftOpen: plan.leftOpen, rightOpen: plan.rightOpen };
}

function openNear(path: readonly PathPoint[], leftOpen: readonly boolean[], rightOpen: readonly boolean[], d: number, reach: number): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    if (!leftOpen[i] && !rightOpen[i]) continue;
    if (path[i + 1].dist > d - reach && path[i].dist < d + reach) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

function pillarSpot(rng: Rng, cells: readonly Cell[], plan: WidthPlan, k: number, intensity: number): PillarSpot | null {
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
  road: Road,
  edges: { leftOpen: boolean[]; rightOpen: boolean[] },
  startDist: number,
  intensity: number,
  lastPropDist: number,
  bumps: BumpPlan,
  crossDists: readonly number[],
  clearDists: readonly number[],
): { props: Prop[]; dists: number[]; lastDist: number } {
  const props: Prop[] = [];
  const dists: number[] = [];
  let lastDist = lastPropDist;
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    const spot = pillarSpot(rng, cells, plan, k, intensity);
    const height = rng.range(3, 7);
    const hue = rng.int(PROP_HUES);
    if (!spot || bumps.cells.includes(k) || props.length >= MAX_PILLARS) continue;
    const dist = startDist + cell.startDist + HALF_CELL + spot.along;
    if (dist - lastDist < PROP_SPACING) continue;
    let clear = true;
    for (const b of bumps.local) clear = clear && Math.abs(dist - (startDist + b)) >= PROP_BUMP_CLEARANCE;
    for (const c of crossDists) clear = clear && Math.abs(dist - c) >= CROSS_PROP_KEEP;
    for (const c of clearDists) clear = clear && Math.abs(dist - c) >= CROSS_FEATURE_KEEP + 1;
    if (!clear || openNear(road.path, edges.leftOpen, edges.rightOpen, dist, OPEN_PROP_KEEP)) continue;
    lastDist = dist;
    const dirX = DIR_X[cell.inDir];
    const dirZ = DIR_Z[cell.inDir];
    dists.push(dist);
    props.push({
      kind: 'pillar',
      x: snap(cell.cx * CELL + dirX * spot.along - dirZ * spot.lateral),
      z: snap(cell.cz * CELL + dirZ * spot.along + dirX * spot.lateral),
      y: snap(pathHeightAt(road.path, dist)),
      radius: snap(spot.radius),
      height: snap(height),
      hue,
    });
  }
  return { props, dists, lastDist };
}

// ---------------------------------------------------------------------------------------------------------------
// Supports
// ---------------------------------------------------------------------------------------------------------------

/**
 * Columns under the raised parts of the chunk, every 18 to 24 m of centreline, carried on across joins. A column
 * keeps out of the middle of every straight cell (a later road may cross under there) and out of the footprint of
 * every other stretch of road. Returns where the next column would go.
 */
function placeSupports(
  rng: Rng,
  cells: readonly Cell[],
  road: Road,
  index: RoadIndex,
  from: number,
  out: Support[],
): number {
  const path = road.path;
  const last = path.length - 1;
  const startDist = path[0].dist;
  const hits: RoadHit[] = [];
  let d = from;
  let i = 0;
  while (d <= path[last].dist) {
    while (i < last - 1 && path[i + 1].dist < d) i++;
    const a = path[i];
    const b = path[i + 1];
    const t = Math.max(0, Math.min(1, (d - a.dist) / (b.dist - a.dist)));
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t;
    const radius = rng.range(SUPPORT_RADIUS[0], SUPPORT_RADIUS[1]);
    const cell = cells[cellAtDist(cells, d - startDist)];
    const inBand = cell.kind !== 'corner' && Math.abs(d - startDist - cellCentre(cell)) < SUPPORT_BAND;
    if (y >= RAISED_HEIGHT && !inBand) {
      index.query(x, z, radius + CHUNK_RULES.supportClearance, hits);
      if (!otherStretch(hits, d, OTHER_ROAD_GAP)) {
        out.push({ x: snap(x), z: snap(z), top: snap(y - DECK_THICKNESS), radius: snap(radius) });
      }
    }
    d += rng.range(SUPPORT_SPACING[0], SUPPORT_SPACING[1]);
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------------------------------------------

/** One live chunk's road as the scenery sees it. */
interface RoadSide {
  index: number;
  edges: WallIndex;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function roadSideOf(index: number, road: Road, walls: readonly Wall[]): RoadSide {
  const outline: Segment[] = [...walls];
  const last = road.path.length - 1;
  for (const edge of [road.left, road.right]) {
    for (let i = 0; i < last; i++) outline.push({ ax: edge[i].x, az: edge[i].z, bx: edge[i + 1].x, bz: edge[i + 1].z });
  }
  for (const i of [0, last]) outline.push({ ax: road.left[i].x, az: road.left[i].z, bx: road.right[i].x, bz: road.right[i].z });
  const side: RoadSide = { index, edges: new WallIndex(outline), minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const s of outline) {
    side.minX = Math.min(side.minX, s.ax, s.bx);
    side.minZ = Math.min(side.minZ, s.az, s.bz);
    side.maxX = Math.max(side.maxX, s.ax, s.bx);
    side.maxZ = Math.max(side.maxZ, s.az, s.bz);
  }
  return side;
}

function cellBoxDistance(minX: number, minZ: number, maxX: number, maxZ: number, cx: number, cz: number): number {
  const cMinX = cx * CELL - HALF_CELL;
  const cMinZ = cz * CELL - HALF_CELL;
  const dx = Math.max(0, cMinX - maxX, minX - (cMinX + CELL));
  const dz = Math.max(0, cMinZ - maxZ, minZ - (cMinZ + CELL));
  return Math.sqrt(dx * dx + dz * dz);
}

function cellOf(v: number): number {
  return Math.floor((v + HALF_CELL) / CELL);
}

/**
 * The accepted blocks of one chunk plus the lookups that keep them off every road that can be alive with them,
 * off each other, and low enough near ground a later road could still use.
 */
class DecorField {
  readonly blocks: DecorBlock[] = [];
  /** Candidate cells holding scenery; reserved for the chunks that can be alive with it. */
  readonly touched = new Set<number>();
  private readonly placed = new SpatialHash(DECOR_BUCKET);
  private readonly near: number[] = [];
  private readonly hits: RoadHit[] = [];
  private readonly cells: number[] = [];

  constructor(
    private readonly live: readonly RoadSide[],
    private readonly liveDecor: readonly DecorBlock[],
    private readonly liveHash: SpatialHash,
    private readonly index: RoadIndex,
    private readonly liveRoad: (road: number) => boolean,
    private readonly candidates: ReadonlySet<number>,
    private readonly corners: ReadonlySet<number>,
    /** The next chunk's first cell: its road starts on this chunk's last cell's edge, so no gap is promised there. */
    private readonly entry: number,
  ) {}

  private crowded(block: DecorBlock, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    const tooClose = (o: DecorBlock): boolean =>
      Math.abs(o.x - block.x) - (o.w + block.w) / 2 < DECOR_GAP && Math.abs(o.z - block.z) - (o.d + block.d) / 2 < DECOR_GAP;
    this.placed.collect(minX - DECOR_GAP, minZ - DECOR_GAP, maxX + DECOR_GAP, maxZ + DECOR_GAP, this.near);
    for (let k = 0; k < this.near.length; k++) if (tooClose(this.blocks[this.near[k]])) return true;
    this.liveHash.collect(minX - DECOR_GAP, minZ - DECOR_GAP, maxX + DECOR_GAP, maxZ + DECOR_GAP, this.near);
    for (let k = 0; k < this.near.length; k++) if (tooClose(this.liveDecor[this.near[k]])) return true;
    return false;
  }

  /**
   * Adds the block if it is clear of every live road and of other blocks, cutting its height down to what its
   * distance from the road (and from ground a later road may use) allows. Blocks `maxClearance` or more from the
   * road are turned away (pass Infinity to accept any distance).
   */
  tryAdd(block: DecorBlock, maxClearance: number): boolean {
    const minX = block.x - block.w / 2;
    const minZ = block.z - block.d / 2;
    const maxX = minX + block.w;
    const maxZ = minZ + block.d;
    // Every cell the block touches must be scenery ground.
    this.cells.length = 0;
    for (let cx = cellOf(minX); cx <= cellOf(maxX); cx++) {
      for (let cz = cellOf(minZ); cz <= cellOf(maxZ); cz++) {
        const key = cellKey(cx, cz);
        if (this.candidates.has(key)) this.cells.push(key);
        else if (!this.corners.has(key)) return false;
      }
    }
    if (this.crowded(block, minX, minZ, maxX, maxZ)) return false;
    const wanted = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
    let toRoad = maxClearance < Infinity ? Math.max(wanted, maxClearance) : wanted;
    for (const side of this.live) {
      if (minX > side.maxX + toRoad || maxX < side.minX - toRoad || minZ > side.maxZ + toRoad || maxZ < side.minZ - toRoad) continue;
      toRoad = side.edges.clearance(minX, minZ, maxX, maxZ, toRoad);
      if (toRoad < RULES.decorMinClearance) return false;
    }
    if (toRoad >= maxClearance) return false;
    const hits = this.index.query(block.x, block.z, 0, this.hits);
    for (let k = 0; k < hits.length; k++) if (this.liveRoad(hits[k].road)) return false;
    // Ground a later road may still use: any cell that is not scenery ground, nor reserved by this chunk.
    let toFuture = wanted;
    let toEntry = Infinity;
    const reach = Math.ceil(wanted / CELL) + 1;
    for (let cx = cellOf(minX) - reach; cx <= cellOf(maxX) + reach; cx++) {
      for (let cz = cellOf(minZ) - reach; cz <= cellOf(maxZ) + reach; cz++) {
        const key = cellKey(cx, cz);
        if (this.corners.has(key) || this.touched.has(key) || this.cells.includes(key)) continue;
        const d = cellBoxDistance(minX, minZ, maxX, maxZ, cx, cz);
        if (key === this.entry) toEntry = d;
        else toFuture = Math.min(toFuture, d);
      }
    }
    toFuture = Math.min(Math.max(FUTURE_ROAD_GAP, toFuture), toEntry);
    const clearance = Math.min(toRoad, toFuture);
    // Rounded down, never up: the height must stay inside the clearance rule after snapping.
    const h = Math.floor(Math.min(block.h, clearance * RULES.decorHeightPerClearance) * 1024) / 1024;
    if (h < RULES.decorMinHeight) return false;
    block.h = h;
    for (const key of this.cells) this.touched.add(key);
    this.placed.insert(this.blocks.length, minX, minZ, maxX, maxZ);
    this.blocks.push(block);
    return true;
  }
}

function fillDecor(rng: Rng, field: DecorField, sites: readonly DecorSite[], quota: number, passes: number, maxClearance: number): void {
  for (let pass = 0; pass < passes; pass++) {
    for (const site of sites) {
      if (field.blocks.length >= quota) return;
      field.tryAdd(proposeBlock(rng, site), maxClearance);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------------------------

/** What the generator keeps about one remembered chunk. */
interface ChunkRecord {
  chunk: TrackChunk;
  side: RoadSide;
  /** Keys of its bend cells (never crossable, so safe ground for scenery while it is remembered). */
  corners: number[];
  bumpDists: number[];
  propDists: number[];
}

/** Knobs for tests. The game never passes any. */
export interface EndlessOptions {
  /**
   * Steps each layout search may take (default 1500). 0 makes every chunk after the first follow the previous
   * chunk's escape route, which exercises the never-trapped fallback.
   */
  searchBudget?: number;
}

/** How each chunk's layout was found, for tests and tuning. */
export interface EndlessLayoutStats {
  /** Chunks laid by the first search. */
  searched: number;
  /** Chunks laid by the second, relaxed search. */
  relaxed: number;
  /** Chunks that followed the escape route. */
  escaped: number;
  /** Crossings made (each one passes over or under remembered road). */
  crossings: number;
}

class Generator implements EndlessGenerator {
  readonly seed: string;
  readonly stats: EndlessLayoutStats = { searched: 0, relaxed: 0, escaped: 0, crossings: 0 };
  readonly difficulty: Difficulty;
  readonly start: Pose = { x: 0, z: 0, heading: 0, y: 0 };
  private readonly rng: Rng;
  private index = 0;
  /** Cell key -> the remembered chunks' uses of that cell (two where one crosses the other). */
  private readonly occupancy = new Map<number, Occupant[]>();
  private readonly keysOf = new Map<number, number[]>();
  /** Cell key -> newest chunk whose scenery stands in it. */
  private readonly reserved = new Map<number, number>();
  private readonly reservedKeysOf = new Map<number, number[]>();
  /** Cell key -> chunk that crossed there. */
  private readonly crossCells = new Map<number, number>();
  private history: ChunkRecord[] = [];
  private heading = EAST;
  /** The last chunk wanted to cross remembered road and did not manage: keep looking. */
  private seeking = false;
  /** The cell the next chunk starts in, and the direction it is entered. */
  private entryX = 0;
  private entryZ = 0;
  private entryDir = EAST;
  /** Free route from the entry cell to open ground, as (cx, cz) pairs. */
  private escape: number[] = [];
  private join: Join | null = null;
  private entryWidth: number | null = null;
  private endHeight = 0;
  private straightTail = 0;
  private lastBent = false;
  private lastBumpDist = -Infinity;
  private lastPropDist = -Infinity;
  private nextSupport = NaN;
  /** Box around every cell the next chunk must avoid (refreshed per chunk). */
  private boxMinX = 0;
  private boxMinZ = 0;
  private boxMaxX = 0;
  private boxMaxZ = 0;

  private readonly searchBudget: number;

  constructor(seed: string, difficulty: Difficulty, options: EndlessOptions) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.rng = new Rng(`${seed}|endless|${difficulty}`);
    this.searchBudget = options.searchBudget ?? WALK_BUDGET;
  }

  // ---- memory ----

  /** Where the last open edge of the previous chunk ends (centreline distance), or -Infinity. */
  private lastOpenDist(): number {
    const record = this.history[this.history.length - 1];
    if (!record) return -Infinity;
    const { path, leftOpen, rightOpen } = record.chunk;
    for (let i = path.length - 2; i >= 0; i--) if (leftOpen[i] || rightOpen[i]) return path[i + 1].dist;
    return -Infinity;
  }

  /** True when a chunk at least `minChunk` uses the cell. */
  private occupied(key: number, minChunk: number): boolean {
    const list = this.occupancy.get(key);
    if (!list) return false;
    for (const o of list) if (o.chunk >= minChunk) return true;
    return false;
  }

  /** Scenery in the cell can still be alive with chunk `chunk`. */
  private reservedFor(key: number, chunk: number): boolean {
    const r = this.reserved.get(key);
    return r !== undefined && r >= chunk - LIVE;
  }

  /** Blocked for chunk `chunk` (no road may go there at all, not even across). */
  private blockedFor(key: number, chunk: number): boolean {
    return this.occupied(key, chunk - MEMORY) || this.reservedFor(key, chunk);
  }

  private forget(index: number): void {
    const stale = index - MEMORY - 1;
    for (const key of this.keysOf.get(stale) ?? []) {
      const list = this.occupancy.get(key);
      if (!list) continue;
      const kept = list.filter((o) => o.chunk > stale);
      if (kept.length > 0) this.occupancy.set(key, kept);
      else this.occupancy.delete(key);
      if (this.crossCells.get(key) === stale) this.crossCells.delete(key);
    }
    this.keysOf.delete(stale);
    const unreserved = index - LIVE - 1;
    for (const key of this.reservedKeysOf.get(unreserved) ?? []) {
      if (this.reserved.get(key) === unreserved) this.reserved.delete(key);
    }
    this.reservedKeysOf.delete(unreserved);
    while (this.history.length > 0 && this.history[0].chunk.index < index - MEMORY) this.history.shift();
  }

  /** Box around every cell blocked for the chunk after `index`, and the entry cell. */
  private refreshBox(index: number): void {
    let minX = this.entryX;
    let maxX = this.entryX;
    let minZ = this.entryZ;
    let maxZ = this.entryZ;
    const grow = (key: number): void => {
      const x = keyX(key);
      const z = keyZ(key);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (const [key, list] of this.occupancy) {
      for (const o of list) {
        if (o.chunk >= index + 1 - MEMORY) {
          grow(key);
          break;
        }
      }
    }
    for (const [key, r] of this.reserved) if (r >= index + 1 - LIVE) grow(key);
    this.boxMinX = minX;
    this.boxMinZ = minZ;
    this.boxMaxX = maxX;
    this.boxMaxZ = maxZ;
  }

  // ---- layout ----

  private newWalk(index: number, intensity: number, limits: ProfileLimits, relaxed: boolean): Walk {
    const crossRng = this.rng.fork(`cross:${index}`);
    const walk: Walk = {
      rng: this.rng.fork(relaxed ? `layout-relaxed:${index}` : `layout:${index}`),
      index,
      intensity,
      first: index === 0,
      relaxed,
      heading: this.heading,
      inDir0: this.entryDir,
      straightTail: this.straightTail,
      wantCross:
        !relaxed && index > 0 && (this.seeking || crossRng.chance(lerp(CROSS_WANT_GENTLE, CROSS_WANT_HARSH, intensity))),
      entries: [],
      guide: [],
      limits,
      cx: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryX),
      cz: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryZ),
      out: new Array<number>(ENDLESS_CHUNK_CELLS).fill(this.entryDir),
      starts: new Array<number>(ENDLESS_CHUNK_CELLS + 1).fill(0),
      crossing: new Array<CrossPlan | null>(ENDLESS_CHUNK_CELLS).fill(null),
      own: new Set([cellKey(this.entryX, this.entryZ)]),
      crossCount: 0,
      heightEnd: 0,
      heightLo: this.endHeight,
      heightHi: this.endHeight,
      budget: this.searchBudget,
      exitDir: this.entryDir,
      escape: [],
    };
    if (walk.wantCross) {
      for (const [key, list] of this.occupancy) {
        if (list.length !== 1 || !list[0].crossable || list[0].crossed) continue;
        const o = list[0];
        const x = keyX(key);
        const z = keyZ(key);
        // A crossing enters from one side and leaves by the other, so both must be free.
        const sx = -DIR_Z[o.dir];
        const sz = DIR_X[o.dir];
        if (this.blockedFor(cellKey(x - sx, z - sz), index) || this.blockedFor(cellKey(x + sx, z + sz), index)) continue;
        walk.entries.push(x - sx, z - sz, x + sx, z + sz);
      }
    }
    return walk;
  }

  private nearestEntry(walk: Walk, x: number, z: number): number {
    let best = Infinity;
    for (let n = 0; n < walk.entries.length; n += 2) {
      best = Math.min(best, Math.abs(walk.entries[n] - x) + Math.abs(walk.entries[n + 1] - z));
    }
    return best;
  }

  /** Steers a walk that wants to cross towards the free cells beside crossable road. */
  private crossPull(walk: Walk, k: number, dir: number): number {
    if (!walk.wantCross || walk.entries.length === 0 || k >= LAST - 1) return 1;
    const tx = walk.cx[k] + DIR_X[dir];
    const tz = walk.cz[k] + DIR_Z[dir];
    const list = this.occupancy.get(cellKey(tx, tz));
    if (list && list.length > 0) {
      const o = list[0];
      return list.length === 1 && o.crossable && !o.crossed && ((o.dir - dir) & 1) === 1 ? CROSS_PULL_ON : 1;
    }
    const before = this.nearestEntry(walk, walk.cx[k], walk.cz[k]);
    const after = this.nearestEntry(walk, tx, tz);
    return after < before ? CROSS_PULL_CLOSER : after > before ? CROSS_PULL_AWAY : 1;
  }

  /** The ways out of cell k that the rules allow, in a weighted random order. */
  private moveOptions(walk: Walk, k: number): number[] {
    const inDir = inDirOf(walk, k);
    // The run opens with straight road: a cell and a half of it before anything else may happen.
    if (walk.first && k < 2) return [EAST];
    if (walk.crossing[k]) return [inDir];
    if (2 * (k + 1) + 1 < walk.guide.length) {
      const dx = walk.guide[2 * (k + 1)] - walk.cx[k];
      const dz = walk.guide[2 * (k + 1) + 1] - walk.cz[k];
      for (let dir = 0; dir < 4; dir++) if (DIR_X[dir] === dx && DIR_Z[dir] === dz && dir !== ((inDir + 2) & 3)) return [dir];
      return [];
    }
    const pool: number[] = [];
    const weights: number[] = [];
    for (const dir of [inDir, (inDir + 1) & 3, (inDir + 3) & 3]) {
      const weight = moveWeight(walk, k, dir);
      if (weight <= 0) continue;
      pool.push(dir);
      weights.push(weight * this.crossPull(walk, k, dir));
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
   * Whether the walk may enter remembered cell `key` (the move out of cell k in direction `dir`) as a crossing:
   * the old cell is a crossable straight at right angles, the cell beyond is free, no other crossing is next door,
   * and the road can climb or drop to a height clear of the old road in time. Returns the plan or null.
   */
  private planCrossing(walk: Walk, k: number, dir: number, key: number): CrossPlan | null {
    const t = k + 1;
    if (walk.relaxed || walk.first || t < 1 || t > LAST - 1 || walk.crossCount >= MAX_CROSSINGS) return null;
    const list = this.occupancy.get(key);
    if (!list || list.length !== 1) return null;
    const occupant = list[0];
    if (!occupant.crossable || occupant.crossed || ((occupant.dir - dir) & 1) === 0) return null;
    const cx = walk.cx[k] + DIR_X[dir];
    const cz = walk.cz[k] + DIR_Z[dir];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const near = cellKey(cx + dx, cz + dz);
        if (this.crossCells.has(near)) return null;
        for (let m = 1; m < t; m++) if (walk.crossing[m]?.key === near) return null;
      }
    }
    const beyond = cellKey(cx + DIR_X[dir], cz + DIR_Z[dir]);
    if (walk.own.has(beyond) || this.blockedFor(beyond, walk.index)) return null;
    const centre = walk.starts[t] + HALF_CELL;
    const from = walk.heightEnd;
    const to = centre - CROSS_HOLD;
    if (to < from) return null;
    const budget = to > from ? maxClimb(from, to, walkLimit(walk, t), walk.limits.gradeChange) * HEIGHT_SAFETY : 0;
    const lo = Math.max(0, walk.heightLo - budget);
    const hi = Math.min(CROSS_MAX_HEIGHT, walk.heightHi + budget);
    const overLo = Math.max(lo, occupant.hi + PLAN_CLEARANCE);
    const underHi = Math.min(hi, occupant.lo - PLAN_CLEARANCE);
    const canOver = overLo <= hi;
    const canUnder = lo <= underHi;
    if (!canOver && !canUnder) return null;
    const over = canOver && (!canUnder || walk.rng.chance(0.5));
    return {
      key,
      occupant,
      centre,
      lo: over ? overLo : lo,
      hi: over ? hi : underHi,
      prevEnd: walk.heightEnd,
      prevLo: walk.heightLo,
      prevHi: walk.heightHi,
    };
  }

  /**
   * Breadth-first search over cells the next chunk may use, from (sx, sz) to any cell outside everything
   * remembered. Returns the route as (cx, cz) pairs, or null when the cell is boxed in.
   */
  private escapeRoute(walk: Walk, sx: number, sz: number): number[] | null {
    const next = walk.index + 1;
    const blocked = (key: number): boolean => walk.own.has(key) || this.blockedFor(key, next);
    let minX = this.boxMinX;
    let maxX = this.boxMaxX;
    let minZ = this.boxMinZ;
    let maxZ = this.boxMaxZ;
    for (let k = 0; k < ENDLESS_CHUNK_CELLS; k++) {
      minX = Math.min(minX, walk.cx[k]);
      maxX = Math.max(maxX, walk.cx[k]);
      minZ = Math.min(minZ, walk.cz[k]);
      maxZ = Math.max(maxZ, walk.cz[k]);
    }
    const start = cellKey(sx, sz);
    if (blocked(start)) return null;
    const parent = new Map<number, number>([[start, -1]]);
    const queue: number[] = [start];
    for (let head = 0; head < queue.length && queue.length < ESCAPE_LIMIT; head++) {
      const key = queue[head];
      const x = keyX(key);
      const z = keyZ(key);
      if (x < minX || x > maxX || z < minZ || z > maxZ) {
        const route: number[] = [];
        for (let at = key; at !== -1; at = parent.get(at) ?? -1) route.push(keyZ(at), keyX(at));
        return route.reverse();
      }
      for (let n = 0; n < 4; n++) {
        const dir = (walk.heading + n) & 3;
        const nkey = cellKey(x + DIR_X[dir], z + DIR_Z[dir]);
        if (parent.has(nkey) || blocked(nkey)) continue;
        parent.set(nkey, key);
        queue.push(nkey);
      }
    }
    return null;
  }

  /** The walk is complete if the cell ahead of its exit is free and has a way out to open ground. */
  private finishWalk(walk: Walk, dir: number): boolean {
    const ex = walk.cx[LAST] + DIR_X[dir];
    const ez = walk.cz[LAST] + DIR_Z[dir];
    // The road ends on the edge of that cell, so it must be free for this chunk too, not only for the next.
    const key = cellKey(ex, ez);
    if (walk.own.has(key) || this.blockedFor(key, walk.index)) return false;
    const route = this.escapeRoute(walk, ex, ez);
    if (!route) return false;
    walk.exitDir = dir;
    walk.escape = route;
    return true;
  }

  /** Depth-first: tries each way out of cell k and backs up when every way is blocked, within the walk's budget. */
  private extendWalk(walk: Walk, k: number): boolean {
    if (walk.budget-- <= 0) return false;
    for (const dir of this.moveOptions(walk, k)) {
      walk.out[k] = dir;
      walk.starts[k + 1] = walk.starts[k] + cellLength(walk, k);
      if (k === LAST) {
        if (this.finishWalk(walk, dir)) return true;
        continue;
      }
      const cx = walk.cx[k] + DIR_X[dir];
      const cz = walk.cz[k] + DIR_Z[dir];
      const key = cellKey(cx, cz);
      if (walk.own.has(key) || this.reservedFor(key, walk.index)) continue;
      let plan: CrossPlan | null = null;
      if (this.occupied(key, walk.index - MEMORY)) {
        plan = this.planCrossing(walk, k, dir, key);
        if (!plan) continue;
      }
      walk.cx[k + 1] = cx;
      walk.cz[k + 1] = cz;
      walk.own.add(key);
      walk.crossing[k + 1] = plan;
      if (plan) {
        walk.crossCount++;
        walk.heightEnd = plan.centre + CROSS_HOLD;
        walk.heightLo = plan.lo;
        walk.heightHi = plan.hi;
      }
      if (this.extendWalk(walk, k + 1)) return true;
      walk.own.delete(key);
      walk.crossing[k + 1] = null;
      if (plan) {
        walk.crossCount--;
        walk.heightEnd = plan.prevEnd;
        walk.heightLo = plan.prevLo;
        walk.heightHi = plan.prevHi;
      }
      if (walk.budget <= 0) return false;
    }
    return false;
  }

  /**
   * The last resort: follow the route to open ground the previous chunk left (straight on beyond its end). That
   * route is free of road and scenery by construction, so this always works.
   */
  private followEscape(index: number, intensity: number, limits: ProfileLimits): Walk {
    const walk = this.newWalk(index, intensity, limits, true);
    const route = this.escape;
    let dir = this.entryDir;
    const cellX: number[] = [];
    const cellZ: number[] = [];
    for (let k = 0; k <= ENDLESS_CHUNK_CELLS; k++) {
      if (2 * k + 1 < route.length) {
        cellX.push(route[2 * k]);
        cellZ.push(route[2 * k + 1]);
      } else if (k === 0) {
        cellX.push(this.entryX);
        cellZ.push(this.entryZ);
      } else {
        cellX.push(cellX[k - 1] + DIR_X[dir]);
        cellZ.push(cellZ[k - 1] + DIR_Z[dir]);
      }
      if (k > 0) {
        const dx = cellX[k] - cellX[k - 1];
        const dz = cellZ[k] - cellZ[k - 1];
        dir = dx > 0 ? 0 : dz > 0 ? 1 : dx < 0 ? 2 : 3;
        walk.out[k - 1] = dir;
      }
    }
    for (let k = 0; k < ENDLESS_CHUNK_CELLS; k++) {
      walk.cx[k] = cellX[k];
      walk.cz[k] = cellZ[k];
      walk.own.add(cellKey(cellX[k], cellZ[k]));
      walk.starts[k + 1] = walk.starts[k] + cellLength(walk, k);
    }
    walk.exitDir = walk.out[LAST];
    const fresh = this.escapeRoute(walk, cellX[ENDLESS_CHUNK_CELLS], cellZ[ENDLESS_CHUNK_CELLS]);
    walk.escape = fresh ?? route.slice(2 * ENDLESS_CHUNK_CELLS);
    return walk;
  }

  /**
   * Short routes from the entry cell to the near side of a crossable straight, then across it, as (cx, cz) pairs
   * from cell 0 to the cell beyond the crossing. Longer approaches come first: they leave more road to climb or
   * drop clear of the old road. At most `count` of them.
   */
  private crossingApproaches(walk: Walk, count: number): number[][] {
    const found: number[][] = [];
    const e = walk.entries;
    const order: number[] = [];
    for (let n = 0; n < e.length; n += 4) order.push(n, n + 2);
    walk.rng.shuffle(order);
    const x0 = walk.cx[0];
    const z0 = walk.cz[0];
    for (const at of order) {
      const ax = e[at];
      const az = e[at + 1];
      // Too far for three steps.
      if (Math.abs(ax - x0) + Math.abs(az - z0) > 3) continue;
      const other = at % 4 === 0 ? at + 2 : at - 2;
      const bx = e[other];
      const bz = e[other + 1];
      const xx = (ax + bx) / 2;
      const xz = (az + bz) / 2;
      const avoid = new Set([cellKey(xx, xz), cellKey(bx, bz)]);
      if (avoid.has(cellKey(x0, z0))) continue;
      // Every simple path of up to three steps over free cells from the entry cell to A, longest first.
      const paths: number[][] = [];
      const route = [x0, z0];
      const used = new Set([cellKey(x0, z0)]);
      const search = (depth: number): void => {
        const x = route[route.length - 2];
        const z = route[route.length - 1];
        if (x === ax && z === az) {
          paths.push(route.slice());
          return;
        }
        if (depth === 3) return;
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + DIR_X[dir];
          const nz = z + DIR_Z[dir];
          const key = cellKey(nx, nz);
          if (used.has(key) || avoid.has(key) || this.blockedFor(key, walk.index)) continue;
          used.add(key);
          route.push(nx, nz);
          search(depth + 1);
          route.length -= 2;
          used.delete(key);
        }
      };
      search(0);
      paths.sort((p, q) => q.length - p.length);
      for (const path of paths.slice(0, 2)) found.push([...path, xx, xz, bx, bz]);
    }
    found.sort((p, q) => q.length - p.length);
    return found.slice(0, count);
  }

  private layout(index: number, intensity: number, limits: ProfileLimits): Walk {
    this.refreshBox(index);
    // A walk that wants to cross tries a few guided approaches first.
    const probe = this.newWalk(index, intensity, limits, false);
    if (probe.wantCross && probe.entries.length > 0) {
      for (const route of this.crossingApproaches(probe, GUIDED_TRIES)) {
        const walk = this.newWalk(index, intensity, limits, false);
        walk.guide = route;
        if (this.extendWalk(walk, 0) && walk.crossCount > 0) {
          this.stats.searched++;
          this.stats.crossings += walk.crossCount;
          return walk;
        }
      }
    }
    for (const relaxed of [false, true]) {
      const walk = this.newWalk(index, intensity, limits, relaxed);
      if (this.extendWalk(walk, 0)) {
        if (relaxed) this.stats.relaxed++;
        else this.stats.searched++;
        this.stats.crossings += walk.crossCount;
        return walk;
      }
    }
    this.stats.escaped++;
    return this.followEscape(index, intensity, limits);
  }

  // ---- one chunk ----

  /** A RoadIndex over every remembered chunk and this one, and which chunk each road id is. */
  private roadIndex(index: number, road: Road): { roads: RoadIndex; chunkOf: number[] } {
    const roads = new RoadIndex(4, 16);
    const chunkOf: number[] = [];
    for (const record of this.history) {
      roads.add(record.chunk.path);
      chunkOf.push(record.chunk.index);
    }
    roads.add(road.path);
    chunkOf.push(index);
    return { roads, chunkOf };
  }

  private scatterDecor(
    rng: Rng,
    index: number,
    walk: Walk,
    cells: readonly Cell[],
    own: RoadSide,
    roads: RoadIndex,
    chunkOf: readonly number[],
  ): { decor: DecorBlock[]; reserved: number[] } {
    const liveRecords = this.history.filter((r) => r.chunk.index >= index - LIVE);
    const keepFree = promisedCells(walk);
    const ex = walk.cx[LAST] + DIR_X[walk.exitDir];
    const ez = walk.cz[LAST] + DIR_Z[walk.exitDir];
    const corners = new Set<number>();
    for (const record of liveRecords) for (const key of record.corners) corners.add(key);
    const sites: DecorSite[] = [];
    const candidates = new Set<number>();
    const seen = new Set<number>();
    for (const cell of cells) {
      const key = cellKey(cell.cx, cell.cz);
      if (cell.kind === 'corner') {
        corners.add(key);
        sites.push({ cx: cell.cx, cz: cell.cz, ring: 0 });
      }
    }
    for (const cell of cells) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = cellKey(cell.cx + dx, cell.cz + dz);
          if (seen.has(key)) continue;
          seen.add(key);
          const roll = rng.next();
          if (walk.own.has(key) || keepFree.has(key) || this.occupied(key, index - MEMORY)) continue;
          if (roll >= DECOR_CELL_CHANCE) continue;
          candidates.add(key);
          sites.push({ cx: cell.cx + dx, cz: cell.cz + dz, ring: 1 });
        }
      }
    }
    const liveDecor: DecorBlock[] = [];
    const liveHash = new SpatialHash(DECOR_BUCKET);
    for (const record of liveRecords) {
      for (const b of record.chunk.decor) {
        liveHash.insert(liveDecor.length, b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2);
        liveDecor.push(b);
      }
    }
    const sides = [...liveRecords.map((r) => r.side), own];
    const live = (road: number): boolean => chunkOf[road] >= index - LIVE;
    const field = new DecorField(sides, liveDecor, liveHash, roads, live, candidates, corners, cellKey(ex, ez));
    rng.shuffle(sites);
    const target = DECOR_TARGET_MIN + rng.int(DECOR_TARGET_MAX - DECOR_TARGET_MIN + 1);
    fillDecor(rng, field, sites, Math.round(target * DECOR_FRONT_SHARE), DECOR_FRONT_PASSES, DECOR_FRONT_DEPTH);
    fillDecor(rng, field, sites, target, DECOR_SKYLINE_PASSES, Infinity);
    return { decor: field.blocks, reserved: [...field.touched] };
  }

  next(): TrackChunk {
    const index = this.index++;
    this.forget(index);
    const first = index === 0;
    const startDist = this.join ? this.join.point.dist : 0;
    const intensity = intensityAt(this.difficulty, startDist);
    const elevation = first ? 0.15 : elevationAt(intensity);
    const limits = profileLimits(elevation);
    if (!first) {
      const turn = this.rng.fork(`heading:${index}`);
      if (turn.chance(HEADING_TURN_CHANCE)) this.heading = (this.heading + (turn.chance(0.5) ? 1 : 3)) & 3;
    }

    // ---- layout ----
    const walk = this.layout(index, intensity, limits);
    this.seeking = walk.wantCross && walk.crossCount === 0 && intensity >= SEEK_INTENSITY;
    const cells = cellsFromWalk(walk);
    const crossings: CrossingCell[] = [];
    const plain = new Set<number>();
    for (let k = 0; k < ENDLESS_CHUNK_CELLS; k++) {
      const plan = walk.crossing[k];
      if (!plan) continue;
      crossings.push({ k, key: plan.key, centre: plan.centre, lo: plan.lo, hi: plan.hi, occupant: plan.occupant });
      plain.add(k - 1).add(k).add(k + 1);
    }
    const openSides = (cell: Cell): boolean => {
      const sideX = -DIR_Z[cell.inDir];
      const sideZ = DIR_X[cell.inDir];
      for (const side of [-1, 1]) {
        const key = cellKey(cell.cx + sideX * side, cell.cz + sideZ * side);
        if (walk.own.has(key) || this.occupied(key, index - MEMORY)) return false;
      }
      return true;
    };
    const plan = planWidths(this.rng.fork(`width:${index}`), cells, intensity, this.entryWidth, first, plain, openSides);

    // ---- heights ----
    const crossLocal = crossings.map((c) => c.centre);
    // Some plain straights are kept clear so a later chunk can pass over or under them.
    const readyRng = this.rng.fork(`ready:${index}`);
    const readyLocal: number[] = [];
    const clearLocal: number[] = [];
    cells.forEach((cell, k) => {
      const roll = readyRng.next();
      const clear = readyRng.chance(READY_CLEAR_SHARE);
      const plainStraight = cell.kind === 'straight' || cell.kind === 'narrow';
      if (first || k === 0 || k === LAST || !plainStraight || walk.crossing[k]) return;
      if (roll >= lerp(READY_CHANCE_GENTLE, READY_CHANCE_HARSH, intensity)) return;
      readyLocal.push(cellCentre(cell));
      if (clear) clearLocal.push(cellCentre(cell));
    });
    const bumps = first
      ? emptyBumps()
      : planBumps(this.rng.fork(`bumps:${index}`), cells, plan, startDist, intensity, this.lastBumpDist, crossLocal, clearLocal, this.lastBent, this.lastOpenDist());
    const profile = planHeights(this.rng.fork(`heights:${index}`), cells, crossings, bumps, this.endHeight, limits, elevation, first);
    const road = buildRoad(sampleCentreline(cells, plan), startDist, this.join, profile, walk.exitDir);
    const path = road.path;
    const last = path.length - 1;
    const { roads, chunkOf } = this.roadIndex(index, road);

    // The bumps come before the edges: a car launched by one flies further off an open edge after it.
    const bumpList: Bump[] = bumps.local.map((local, b) => {
      const cell = cells[bumps.cells[b]];
      const along = cell.entryOffset + (local - cell.startDist);
      const dirX = DIR_X[cell.inDir];
      const dirZ = DIR_Z[cell.inDir];
      return {
        x: snap(cell.cx * CELL + dirX * along),
        z: snap(cell.cz * CELL + dirZ * along),
        y: snap(pathHeightAt(path, startDist + local)),
        // A straight cell runs along a grid axis, so its direction is an exact unit vector.
        dirX,
        dirZ,
        halfLength: snap(bumps.halfLengths[b]),
        halfWidth: snap(bumps.halfWidths[b]),
        height: snap(bumps.heights[b]),
      };
    });
    const bumpsOnRoad = bumpsAlong(path, bumpList);

    // ---- edges and walls ----
    const crossDists = crossLocal.map((c) => startDist + c);
    const readyDists = readyLocal.map((c) => startDist + c);
    const clearDists = clearLocal.map((c) => startDist + c);
    const bumpDists = bumps.local.map((d) => startDist + d);
    const n = path.length;
    const edges = first
      ? { leftOpen: new Array<boolean>(n).fill(false), rightOpen: new Array<boolean>(n).fill(false) }
      : planEdges(
          this.rng.fork(`edges:${index}`),
          road,
          intensity,
          [...crossDists, ...readyDists],
          bumpDists,
          roads,
          (r) => chunkOf[r] >= index - LIVE,
          promisedCells(walk),
          bumpsOnRoad,
        );
    const walls: Wall[] = first ? startCapWalls(road, EAST) : [];
    emitEdgeWalls(path, road.left, road.right, edges.leftOpen, edges.rightOpen, walls);

    // ---- things on and under the road ----
    const pillars = first
      ? { props: [] as Prop[], dists: [] as number[], lastDist: this.lastPropDist }
      : placeProps(this.rng.fork(`props:${index}`), cells, plan, road, edges, startDist, intensity, this.lastPropDist, bumps, crossDists, clearDists);
    const supportRng = this.rng.fork(`supports:${index}`);
    if (Number.isNaN(this.nextSupport)) this.nextSupport = supportRng.range(0, SUPPORT_SPACING[1]);
    const supports: Support[] = [];
    this.nextSupport = placeSupports(supportRng, cells, road, roads, this.nextSupport, supports);

    // ---- scenery ----
    const side = roadSideOf(index, road, walls);
    const scenery = this.scatterDecor(this.rng.fork(`decor:${index}`), index, walk, cells, side, roads, chunkOf);

    const piece = { path, left: road.left, right: road.right, walls, props: pillars.props, bumps: bumpList, supports, decor: scenery.decor };
    const chunk: TrackChunk = {
      index,
      ...piece,
      leftOpen: edges.leftOpen,
      rightOpen: edges.rightOpen,
      bounds: pieceBounds(piece),
      startDist: path[0].dist,
      endDist: path[last].dist,
      intensity,
    };

    // Later road keeps out of where a car flying off this chunk's open edges could come down, while it is live.
    const landing = landingCells(road, edges, walk.own, bumpsOnRoad);
    this.remember(index, chunk, walk, cells, crossings, side, bumpDists, pillars.dists, [...scenery.reserved, ...landing]);
    return chunk;
  }

  /** Records the chunk's cells, scenery and end state for the chunks that follow. */
  private remember(
    index: number,
    chunk: TrackChunk,
    walk: Walk,
    cells: readonly Cell[],
    crossings: readonly CrossingCell[],
    side: RoadSide,
    bumpDists: number[],
    propDists: number[],
    reserved: readonly number[],
  ): void {
    const previous = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    const path = chunk.path;
    const keys: number[] = [];
    const corners: number[] = [];
    const crossingCells = new Set(crossings.map((c) => c.k));
    const nearFeature = (c: number): boolean => {
      for (const list of [bumpDists, propDists, previous?.bumpDists ?? [], previous?.propDists ?? []]) {
        for (const d of list) if (Math.abs(d - c) < CROSS_FEATURE_KEEP) return true;
      }
      if (openNear(path, chunk.leftOpen, chunk.rightOpen, c, CROSS_EDGE_KEEP)) return true;
      const p = previous?.chunk;
      return p ? openNear(p.path, p.leftOpen, p.rightOpen, c, CROSS_EDGE_KEEP) : false;
    };
    cells.forEach((cell, k) => {
      const key = cellKey(cell.cx, cell.cz);
      const centre = chunk.startDist + cellCentre(cell);
      let lo = Infinity;
      let hi = -Infinity;
      for (const source of [path, previous?.chunk.path ?? []]) {
        for (const p of source) {
          if (Math.abs(p.dist - centre) > CROSS_OLD_REACH) continue;
          lo = Math.min(lo, p.y);
          hi = Math.max(hi, p.y);
        }
      }
      const straight = cell.kind === 'straight' || cell.kind === 'narrow';
      const crossable =
        straight && k < LAST && !crossingCells.has(k) && !(walk.first && k < 2) && lo <= hi && !nearFeature(centre);
      const occupant: Occupant = { chunk: index, kind: cell.kind, dir: cell.inDir, centre, crossable, lo, hi, crossed: false };
      const list = this.occupancy.get(key);
      if (list) {
        for (const o of list) o.crossed = true;
        list.push(occupant);
      } else this.occupancy.set(key, [occupant]);
      keys.push(key);
      if (cell.kind === 'corner') corners.push(key);
    });
    // The chunk's first point sits on the edge of the previous chunk's last cell, so that cell stays blocked for as
    // long as this chunk is remembered.
    if (index > 0) {
      const key = cellKey(cells[0].cx - DIR_X[cells[0].inDir], cells[0].cz - DIR_Z[cells[0].inDir]);
      const touch: Occupant = { chunk: index, kind: 'corner', dir: cells[0].inDir, centre: chunk.startDist, crossable: false, lo: 0, hi: 0, crossed: true };
      const list = this.occupancy.get(key);
      if (list) list.push(touch);
      else this.occupancy.set(key, [touch]);
      keys.push(key);
    }
    this.keysOf.set(index, keys);
    for (const c of crossings) this.crossCells.set(c.key, index);
    for (const key of reserved) this.reserved.set(key, index);
    this.reservedKeysOf.set(index, [...reserved]);
    this.history.push({ chunk, side, corners, bumpDists, propDists });

    const last = path.length - 1;
    this.join = { point: { ...path[last] }, left: { ...chunk.left[last] }, right: { ...chunk.right[last] } };
    this.endHeight = path[last].y;
    // The base width this chunk ended on (held for JOIN_HOLD before the join), which the next chunk starts from.
    this.entryWidth = path[last].halfWidth;
    this.entryDir = walk.exitDir;
    this.entryX = walk.cx[LAST] + DIR_X[walk.exitDir];
    this.entryZ = walk.cz[LAST] + DIR_Z[walk.exitDir];
    this.escape = walk.escape;
    let tail = 0;
    while (tail < cells.length && cells[LAST - tail].kind !== 'corner') tail++;
    this.straightTail = tail === cells.length ? this.straightTail + tail : tail;
    this.lastBent = cells[LAST].kind === 'corner';
    for (const d of bumpDists) this.lastBumpDist = Math.max(this.lastBumpDist, d);
    if (propDists.length > 0) this.lastPropDist = Math.max(this.lastPropDist, ...propDists);
  }
}

/**
 * An endless supply of road for a seed and a difficulty. The same two always give the same chunks, so a run can be
 * replayed or raced again. Call `next()` for chunk 0, 1, 2 ... in order.
 */
export function createEndlessGenerator(seed: string, difficulty: Difficulty, options: EndlessOptions = {}): EndlessGenerator {
  return new Generator(seed, difficulty, options);
}

/** Layout statistics of a generator made by createEndlessGenerator (null for any other). */
export function endlessLayoutStats(generator: EndlessGenerator): EndlessLayoutStats | null {
  return generator instanceof Generator ? { ...generator.stats } : null;
}
