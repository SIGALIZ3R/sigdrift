/**
 * Weekly level generator.
 *
 * The road is laid on a grid of large cells by a self-avoiding walk, so a route from start to goal exists by
 * construction. Each cell holds either a straight or a quarter-circle bend, and the road never leaves the cells it
 * walks through: two stretches of road can only meet where the walk says they do.
 *
 * Layout, widths, props and decor each draw from their own random stream, so tuning scenery never moves the road.
 */

import { HALF_PI, atan2, cos, lerp, sin, smoothstep } from '../core/fixedMath';
import { Rng } from '../core/rng';
import type { DecorBlock, Gate, Level, PathPoint, Prop, Segment, Vec2 } from '../types';
import { GEN_VERSION } from '../types';
import { RULES, SpatialHash, WallIndex, insideWalls, validateLevel } from './validate';
import { seedForWeek } from './weeklySeed';

export const CELL = 48;
const HALF_CELL = CELL / 2;
const MIN_CELLS = 16;
const MAX_CELLS = 24;
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

const MIN_BASE_HALF_WIDTH = 9;
const MAX_BASE_HALF_WIDTH = 11;
const MAX_CORNER_HALF_WIDTH = 12.5;
const MIN_PLAZA_HALF_WIDTH = 15;
const MAX_PLAZA_HALF_WIDTH = 20;
const PLAZA_CHANCE = 0.3;
const NARROW_CHANCE = 0.14;
/** Distance over which the road changes width. A plaza tapers more gently because it changes by more. */
const BLEND = 16;
const PLAZA_BLEND = 20;

/** Closed ends: how far the road continues behind the start and beyond the goal. */
const START_CAP = 14;
/**
 * The run-off: a car crossing the line flat out needs just under 60 m to brake to a stop. The goal sits in the
 * middle of the last cell, so the cap runs through the rest of that cell and well into the next one, which the
 * walk keeps free of road (see `extendWalk`). The extra few metres are for the nose of the car.
 */
const GOAL_CAP = RULES.goalRunOff + 4;
const CHECKPOINT_EVERY = 3;

const CENTRE_PILLAR_MIN_HALF_WIDTH = 17;
/** How far a pillar may sit from the middle of its cell, which keeps it off gates and out of width changes. */
const PLAZA_PILLAR_REACH = 3;
const STRAIGHT_PILLAR_REACH = 7;
/** The validator measures spacing between path samples, which can read up to a step short. */
const PROP_SPACING = RULES.propSpacing + 4;
const PROP_HUES = 6;

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

/** Snaps to a 1/1024 m lattice so a level serialises and hashes identically everywhere. Adding 0 clears -0. */
export function snap(v: number): number {
  return Math.round(v * 1024) / 1024 + 0;
}

function cellKey(cx: number, cz: number): number {
  return (cx + 512) * 1024 + (cz + 512);
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: a self-avoiding walk over grid cells
// ---------------------------------------------------------------------------------------------------------------

interface Walk {
  count: number;
  /** The direction the level as a whole tends to travel in. */
  general: number;
  cx: number[];
  cz: number[];
  /** moves[i] is the travel direction from cell i to cell i + 1. */
  moves: number[];
  used: Set<number>;
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
  let weight: number;
  if (turn === 0) weight = straightRun(moves) > MAX_EASY_STRAIGHT ? 0.35 : 1.4;
  else if (bends === 0) weight = 0.85;
  // A second bend the same way makes a hairpin; the other way makes an S-bend.
  else if (bends === 1) weight = turn === turnBetween(moves[moves.length - 2], previous) ? 1 : 0.8;
  // Longer chains of bends are allowed but rare, so the road breathes between them.
  else weight = 0.25;
  const heading = (dir - walk.general + 4) & 3;
  return weight * (heading === 0 ? 1.3 : heading === 2 ? 0.5 : 1);
}

/** The three ways out of the newest cell, in a weighted random order. */
function moveOptions(walk: Walk): number[] {
  const step = walk.moves.length;
  if (step === 0) return [walk.general];
  const previous = walk.moves[step - 1];
  // The second cell and the second-to-last cell must be straight.
  if (step === 1 || step === walk.count - 2) return [previous];
  const pool = [previous, (previous + 1) & 3, (previous + 3) & 3];
  const weights = pool.map((dir) => moveWeight(walk, dir));
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
    if (walk.used.has(key)) continue;
    if (placingLast && walk.used.has(cellKey(cx + DIR_X[dir], cz + DIR_Z[dir]))) continue;
    walk.used.add(key);
    walk.cx.push(cx);
    walk.cz.push(cz);
    walk.moves.push(dir);
    if (extendWalk(walk)) return true;
    walk.used.delete(key);
    walk.cx.pop();
    walk.cz.pop();
    walk.moves.pop();
  }
  return false;
}

function walkLayout(rng: Rng): Walk {
  const walk: Walk = {
    count: MIN_CELLS + rng.int(MAX_CELLS - MIN_CELLS + 1),
    general: rng.int(4),
    cx: [0],
    cz: [0],
    moves: [],
    used: new Set([cellKey(0, 0)]),
    budget: WALK_BUDGET,
    rng,
  };
  if (!extendWalk(walk)) throw new Error('layout walk found no route');
  return walk;
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

function planWidths(rng: Rng, cells: Cell[]): WidthPlan {
  const base = rng.range(MIN_BASE_HALF_WIDTH, MAX_BASE_HALF_WIDTH);
  const plan: WidthPlan = { base, corner: Math.min(MAX_CORNER_HALF_WIDTH, base + rng.range(0.8, 2.2)) };
  const occupied = new Set(cells.map((cell) => cellKey(cell.cx, cell.cz)));
  // A plaza must not crowd the run-off either.
  const runOff = runOffCell(cells);
  occupied.add(cellKey(runOff.cx, runOff.cz));
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
    // onto itself.
    const canBePlaza = hasOpenSides(cell, occupied) && cells[i - 1].kind !== 'plaza';
    if (canBePlaza) plazaSites.push(i);
    if (canBePlaza && roll < PLAZA_CHANCE) {
      makePlaza(cell, size);
      plazas++;
    } else if (roll > 1 - NARROW_CHANCE) {
      cell.kind = 'narrow';
      cell.midWidth = Math.max(RULES.minHalfWidth, base - lerp(1.5, 3, size));
    }
  }
  if (plazas === 0 && plazaSites.length > 0) makePlaza(cells[rng.pick(plazaSites)], rng.next());
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
function buildRoad(line: Centreline): Road {
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
      halfWidth: snap(line.halfWidth[i]),
      dist: snap(line.dist[i]),
    });
  }
  return road;
}

function shifted(p: Vec2, dir: number, distance: number): Vec2 {
  return { x: p.x + DIR_X[dir] * distance, z: p.z + DIR_Z[dir] * distance };
}

/** One closed loop: up the left edge, around the cap beyond the goal, back down the right edge, around the start. */
function buildWalls(road: Road, startDir: number, goalDir: number): Segment[] {
  const { left, right } = road;
  const last = left.length - 1;
  const loop: Vec2[] = [shifted(right[0], startDir, -START_CAP), shifted(left[0], startDir, -START_CAP)];
  for (let i = 0; i <= last; i++) loop.push(left[i]);
  loop.push(shifted(left[last], goalDir, GOAL_CAP), shifted(right[last], goalDir, GOAL_CAP));
  for (let i = last; i >= 0; i--) loop.push(right[i]);
  return loop.map((a, i) => {
    const b = loop[(i + 1) % loop.length];
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z };
  });
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
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, pathIndex, respawn: { x: p.x, z: p.z, heading: headingOf(dir) } };
}

/**
 * Picks the line between cell b - 1 and cell b for a checkpoint near `target`, preferring one with straight road
 * on both sides. Returns -1 when nothing nearby is far enough from the previous gate and from both ends.
 */
function pickCheckpointLine(cells: readonly Cell[], target: number, previous: number, length: number): number {
  let fallback = -1;
  for (const b of [target, target + 1, target - 1]) {
    if (b < previous + 2 || b > cells.length - 2) continue;
    const dist = cells[b].startDist;
    if (dist < RULES.checkpointEndClearance || length - dist < RULES.checkpointEndClearance) continue;
    if (cells[b - 1].kind !== 'corner' && cells[b].kind !== 'corner') return b;
    if (fallback < 0) fallback = b;
  }
  return fallback;
}

function placeCheckpoints(cells: readonly Cell[], road: Road, length: number): Gate[] {
  const gates: Gate[] = [];
  let previous = 0;
  for (let target = CHECKPOINT_EVERY; target <= cells.length - 2; target += CHECKPOINT_EVERY) {
    const line = pickCheckpointLine(cells, target, previous, length);
    if (line < 0) continue;
    gates.push(gateAt(road, cells[line].firstIndex, cells[line].inDir));
    previous = line;
  }
  return gates;
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

function pillarSpot(rng: Rng, cell: Cell): PillarSpot | null {
  if (cell.kind === 'plaza') {
    if (cell.midWidth >= CENTRE_PILLAR_MIN_HALF_WIDTH && rng.chance(0.75)) return centrePillar(rng);
    return rng.chance(0.5) ? sidePillar(rng, cell.midWidth, PLAZA_PILLAR_REACH) : null;
  }
  if (cell.kind !== 'straight' || !rng.chance(0.2)) return null;
  return sidePillar(rng, cell.midWidth, STRAIGHT_PILLAR_REACH);
}

function placeProps(rng: Rng, cells: readonly Cell[]): Prop[] {
  const props: Prop[] = [];
  let lastDist = -PROP_SPACING;
  // Cells 0 and 1 are too close to the start, and the last two lead onto the goal line.
  for (let i = 2; i <= cells.length - 3; i++) {
    const cell = cells[i];
    const spot = pillarSpot(rng, cell);
    if (!spot) continue;
    const dist = cell.startDist + HALF_CELL + spot.along;
    if (dist - lastDist < PROP_SPACING) continue;
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
  return props;
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
  private readonly walls: readonly Segment[];
  private readonly wallIndex: WallIndex;
  private readonly placed = new SpatialHash(DECOR_BUCKET);
  private readonly near: number[] = [];

  constructor(walls: readonly Segment[]) {
    this.walls = walls;
    this.wallIndex = new WallIndex(walls);
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
   * Adds the block if it is clear of the road and of other blocks, cutting its height down to what its distance
   * from the road allows. `onRoadCell` marks blocks that could have landed on the tarmac itself, and blocks
   * `maxClearance` or more from the road are turned away (pass Infinity to accept any distance).
   */
  tryAdd(block: DecorBlock, onRoadCell: boolean, maxClearance: number): boolean {
    if (this.crowded(block)) return false;
    const minX = block.x - block.w / 2;
    const minZ = block.z - block.d / 2;
    const maxX = minX + block.w;
    const maxZ = minZ + block.d;
    const wanted = Math.max(RULES.decorMinClearance, block.h / RULES.decorHeightPerClearance);
    const limit = maxClearance < Infinity ? Math.max(wanted, maxClearance) : wanted;
    const clearance = this.wallIndex.clearance(minX, minZ, maxX, maxZ, limit);
    if (clearance < RULES.decorMinClearance || clearance >= maxClearance) return false;
    if (onRoadCell && insideWalls(this.walls, block.x, block.z)) return false;
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

function scatterDecor(rng: Rng, cells: readonly Cell[], walls: readonly Segment[]): DecorBlock[] {
  const sites = decorSites(rng, cells);
  const target = DECOR_TARGET_MIN + rng.int(DECOR_TARGET_MAX - DECOR_TARGET_MIN + 1);
  const field = new DecorField(walls);
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

function boundsOf(walls: readonly Segment[], decor: readonly DecorBlock[]): Level['bounds'] {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const include = (minX: number, minZ: number, maxX: number, maxZ: number): void => {
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minZ = Math.min(bounds.minZ, minZ);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxZ = Math.max(bounds.maxZ, maxZ);
  };
  // The walls enclose the path and every prop.
  for (const w of walls) include(w.ax, w.az, w.ax, w.az);
  for (const b of decor) include(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2);
  // Half a block size can fall between lattice points: round outwards so the bounds still hold everything.
  return {
    minX: Math.floor(bounds.minX * 1024) / 1024 + 0,
    minZ: Math.floor(bounds.minZ * 1024) / 1024 + 0,
    maxX: Math.ceil(bounds.maxX * 1024) / 1024 + 0,
    maxZ: Math.ceil(bounds.maxZ * 1024) / 1024 + 0,
  };
}

/** Names of the random streams. Each part of a level draws only from its own. */
export interface StreamLabels {
  layout: string;
  width: string;
  props: string;
  decor: string;
}

export const DEFAULT_STREAMS: StreamLabels = { layout: 'layout', width: 'width', props: 'props', decor: 'decor' };

/**
 * One generation attempt, not validated. Exported so tests can show that the streams are independent; the game
 * should call generateLevel.
 */
export function buildLevel(seed: string, id: string, streams: StreamLabels = DEFAULT_STREAMS): Level {
  const rng = new Rng(seed);
  const cells = cellsFromWalk(walkLayout(rng.fork(streams.layout)));
  const plan = planWidths(rng.fork(streams.width), cells);
  const road = buildRoad(sampleCentreline(cells, plan));
  const lastIndex = road.path.length - 1;
  const startDir = cells[0].outDir;
  const goalDir = cells[cells.length - 1].inDir;
  const walls = buildWalls(road, startDir, goalDir);
  const length = road.path[lastIndex].dist;
  const decor = scatterDecor(rng.fork(streams.decor), cells, walls);
  return {
    id,
    seed,
    genVersion: GEN_VERSION,
    path: road.path,
    left: road.left,
    right: road.right,
    walls,
    props: placeProps(rng.fork(streams.props), cells),
    decor,
    start: { x: road.path[0].x, z: road.path[0].z, heading: headingOf(startDir) },
    checkpoints: placeCheckpoints(cells, road, length),
    goal: gateAt(road, lastIndex, goalDir),
    bounds: boundsOf(walls, decor),
    length,
  };
}

/** Builds and validates one attempt. Returns the reasons it failed instead of the level when it is not usable. */
function attemptLevel(seed: string, id: string): Level | string[] {
  let level: Level;
  try {
    level = buildLevel(seed, id);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const verdict = validateLevel(level);
  return verdict.ok ? level : verdict.errors;
}

/**
 * Generates the level for a seed. If an attempt fails validation the seed is extended and tried again, and
 * `Level.seed` records the seed that was actually used.
 */
export function generateLevelFromSeed(seed: string, id: string): Level {
  let failure: string[] = [];
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const outcome = attemptLevel(retry === 0 ? seed : `${seed}|retry${retry}`, id);
    if (!Array.isArray(outcome)) return outcome;
    failure = outcome;
  }
  throw new Error(`no valid level for seed "${seed}" after ${MAX_RETRIES} retries: ${failure.join('; ')}`);
}

/** The level for a week id such as "2026-W48". */
export function generateLevel(id: string): Level {
  return generateLevelFromSeed(seedForWeek(id), id);
}
