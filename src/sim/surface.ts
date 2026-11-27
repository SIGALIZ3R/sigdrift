/**
 * Road surfaces in 2.5D: which road (if any) a car at height `fromY` stands on at (x, z), how high it is there, and
 * how steep. See "ROAD SURFACE HEIGHT" in types.ts.
 *
 * Every centreline segment i..i+1 of every road piece is one entry. Its FOOTPRINT is
 *  - the band beside the segment: points whose projection falls on the segment and whose distance from the
 *    centreline is at most the interpolated half width + FOOTPRINT_MARGIN, plus
 *  - the quad between the road edges left[i], left[i+1], right[i+1], right[i] (side edges widened by the same
 *    margin), which fills the wedge on the outside of a bend between the bands of two segments.
 * Deliberately NOT the round caps a capsule would have at each end: beside a widening, the cap of the wide end
 * bulges out past the walls of the narrower road leading up to it, and would make road out of thin air there.
 *
 * The height over a segment is linear along it (by the projection, clamped to the segment), level across it, plus
 * the highest bump that covers the point and belongs to a road within BUMP_MATCH of that height.
 *
 * A closed end of a road (the start of a level, its goal run-off) may be extended: the band of the first / last
 * segment then carries on straight past the end for that many metres, level with the end point.
 *
 * Entries live in an unbounded hash grid (like the collider), owned by a piece id so endless chunks can come and go.
 * Queries allocate nothing and return one reused result object.
 */
import type { RoadPiece } from '../types';
import { STEP_UP, TERRAIN_Y } from '../types';
import { PI, cos, sin } from '../core/fixedMath';

/** The result of a surface query. One object per index, overwritten by the next query: copy what you keep. */
export interface SurfaceHit {
  /** Surface height, m (TERRAIN_Y over the city floor). */
  y: number;
  /** True on a road, false over the city floor. */
  onRoad: boolean;
  /** Horizontal gradient of the surface (rise per metre along x and along z). 0 on the floor. */
  slopeX: number;
  slopeZ: number;
  /** Owner id of the road piece, or -1 on the floor. */
  owner: number;
  /** Index into that piece's `path` of the start of the segment the point is over, or -1 on the floor. */
  pathIndex: number;
}

declare const surfaceBrand: unique symbol;

/** Made by `createSurfaceIndex`. Its contents are private to this module. */
export interface SurfaceIndex {
  readonly [surfaceBrand]: true;
}

/** How far beyond a road's edge a point still counts as on it, m. */
export const FOOTPRINT_MARGIN = 0.25;
/** A bump lifts only a road whose surface is within this of the bump's own `y`, m. */
export const BUMP_MATCH = 1.5;

/** Extra road past a piece's ends (closed ends: the start cap and the goal run-off), m. */
export interface PieceOptions {
  extendStart?: number;
  extendEnd?: number;
}

const CELL_SIZE = 8;
const INV_CELL = 1 / CELL_SIZE;
const CELL_MASK = 0x7fff;
const CELL_BITS = 15;
/** An entry whose box covers more cells than this goes in a list every query scans instead (huge test arenas). */
const BIG_CELLS = 256;
/** Slack on the projection range so a point exactly on the joint of two segments is in at least one band. */
const JOINT_SLACK = 1e-9;
/** Slack on the quad's cross edges (shared with the neighbouring quad) against rounding. */
const CROSS_SLACK = 1e-6;

// Segment record layout (Float64Array, SEG_STRIDE numbers per slot).
const AX = 0;
const AZ = 1;
const AY = 2;
const DX = 3;
const DZ = 4;
const DY = 5;
const HA = 6;
const DH = 7;
const INV_LEN_SQ = 8;
const INV_LEN = 9;
const T_MIN = 10;
const T_MAX = 11;
const OWNER = 12;
const PATH = 13;
/** 1 when the quad is convex and usable. */
const QUAD = 14;
/** Four edges, each an inward unit normal and an offset: inside when nx * x + nz * z >= offset for all four. */
const Q0 = 15;
const BOX = 27;
const SEG_STRIDE = 31;

// Bump record layout.
const B_X = 0;
const B_Z = 1;
const B_Y = 2;
const B_DIRX = 3;
const B_DIRZ = 4;
const B_HALF_LENGTH = 5;
const B_HALF_WIDTH = 6;
const B_HEIGHT = 7;
const BUMP_STRIDE = 8;

interface Cell {
  segs: number[];
  bumps: number[];
}

interface Owned {
  segs: number[];
  bumps: number[];
}

interface Index {
  cells: Map<number, Cell>;
  segs: Float64Array;
  segSlots: number;
  freeSegs: number[];
  bumps: Float64Array;
  bumpSlots: number;
  freeBumps: number[];
  /** Segments too big for the grid. */
  big: number[];
  owners: Map<number, Owned>;
  hit: SurfaceHit;
  /** Scratch of the bump search. */
  bumpH: number;
  bumpSX: number;
  bumpSZ: number;
  /** Scratch of the segment scan: best candidate so far. */
  bestY: number;
  bestScore: number;
  bestSX: number;
  bestSZ: number;
  bestSeg: number;
}

const NO_BUMPS: number[] = [];

function cellKey(col: number, row: number): number {
  return ((col & CELL_MASK) << CELL_BITS) | (row & CELL_MASK);
}

function grown(array: Float64Array, length: number): Float64Array {
  if (array.length >= length) return array;
  const bigger = new Float64Array(Math.max(length, array.length * 2, 256));
  bigger.set(array);
  return bigger;
}

export function createSurfaceIndex(): SurfaceIndex {
  const index: Index = {
    cells: new Map(),
    segs: new Float64Array(0),
    segSlots: 0,
    freeSegs: [],
    bumps: new Float64Array(0),
    bumpSlots: 0,
    freeBumps: [],
    big: [],
    owners: new Map(),
    hit: { y: TERRAIN_Y, onRoad: false, slopeX: 0, slopeZ: 0, owner: -1, pathIndex: -1 },
    bumpH: 0,
    bumpSX: 0,
    bumpSZ: 0,
    bestY: 0,
    bestScore: 0,
    bestSX: 0,
    bestSZ: 0,
    bestSeg: -1,
  };
  return index as unknown as SurfaceIndex;
}

function cellsOfBox(x0: number, z0: number, x1: number, z1: number): number {
  return (Math.floor(x1 * INV_CELL) - Math.floor(x0 * INV_CELL) + 1) * (Math.floor(z1 * INV_CELL) - Math.floor(z0 * INV_CELL) + 1);
}

function markBox(index: Index, item: number, bump: boolean, add: boolean, x0: number, z0: number, x1: number, z1: number): void {
  const colFrom = Math.floor(x0 * INV_CELL);
  const rowFrom = Math.floor(z0 * INV_CELL);
  const cols = Math.floor(x1 * INV_CELL) - colFrom;
  const rows = Math.floor(z1 * INV_CELL) - rowFrom;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const key = cellKey(colFrom + c, rowFrom + r);
      let cell = index.cells.get(key);
      if (add) {
        if (!cell) {
          cell = { segs: [], bumps: [] };
          index.cells.set(key, cell);
        }
        const list = bump ? cell.bumps : cell.segs;
        if (list.indexOf(item) < 0) list.push(item);
      } else if (cell) {
        const list = bump ? cell.bumps : cell.segs;
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
        if (cell.segs.length === 0 && cell.bumps.length === 0) index.cells.delete(key);
      }
    }
  }
}

/** Grid placement of one segment slot: in the cells of its box, or in the big list. */
function placeSeg(index: Index, slot: number, add: boolean): void {
  const s = index.segs;
  const o = slot * SEG_STRIDE;
  const x0 = s[o + BOX];
  const z0 = s[o + BOX + 1];
  const x1 = s[o + BOX + 2];
  const z1 = s[o + BOX + 3];
  if (cellsOfBox(x0, z0, x1, z1) > BIG_CELLS) {
    if (add) index.big.push(slot);
    else {
      const at = index.big.indexOf(slot);
      if (at >= 0) index.big.splice(at, 1);
    }
    return;
  }
  markBox(index, slot, false, add, x0, z0, x1, z1);
}

function placeBump(index: Index, slot: number, add: boolean): void {
  const b = index.bumps;
  const o = slot * BUMP_STRIDE;
  const reach = b[o + B_HALF_LENGTH] + b[o + B_HALF_WIDTH];
  markBox(index, slot, true, add, b[o + B_X] - reach, b[o + B_Z] - reach, b[o + B_X] + reach, b[o + B_Z] + reach);
}

function finite(...values: number[]): boolean {
  for (let i = 0; i < values.length; i++) if (!(Math.abs(values[i]) < 1e9)) return false;
  return true;
}

/**
 * Writes the quad's four inward edge planes into the record at `o` and returns whether the quad is convex and
 * usable. Points in order: left[i], left[i+1], right[i+1], right[i].
 */
function writeQuad(s: Float64Array, o: number, xs: readonly number[], zs: readonly number[]): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) & 3;
    const k2 = (k + 2) & 3;
    const cross = (xs[k1] - xs[k]) * (zs[k2] - zs[k1]) - (zs[k1] - zs[k]) * (xs[k2] - xs[k1]);
    if (!(Math.abs(cross) > 1e-9)) return false;
    const side = cross > 0 ? 1 : -1;
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  const cx = (xs[0] + xs[1] + xs[2] + xs[3]) / 4;
  const cz = (zs[0] + zs[1] + zs[2] + zs[3]) / 4;
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) & 3;
    const ex = xs[k1] - xs[k];
    const ez = zs[k1] - zs[k];
    const length = Math.sqrt(ex * ex + ez * ez);
    if (!(length > 1e-9)) return false;
    let nx = -ez / length;
    let nz = ex / length;
    if (nx * (cx - xs[k]) + nz * (cz - zs[k]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    // Edges 0 (left side) and 2 (right side) get the footprint margin; the cross edges only rounding slack.
    const slack = k === 0 || k === 2 ? FOOTPRINT_MARGIN : CROSS_SLACK;
    s[o + Q0 + k * 3] = nx;
    s[o + Q0 + k * 3 + 1] = nz;
    s[o + Q0 + k * 3 + 2] = nx * xs[k] + nz * zs[k] - slack;
  }
  return true;
}

const quadX = [0, 0, 0, 0];
const quadZ = [0, 0, 0, 0];

/**
 * Adds a road piece under an owner id (a level: 0; an endless chunk: its index). An owner may be added to more
 * than once; `removePiece` takes out everything it added.
 */
export function addPiece(surface: SurfaceIndex, owner: number, piece: RoadPiece, options?: PieceOptions): void {
  const index = surface as unknown as Index;
  let owned = index.owners.get(owner);
  if (!owned) {
    owned = { segs: [], bumps: [] };
    index.owners.set(owner, owned);
  }
  const path = piece.path;
  const last = path.length - 2;
  const extendStart = options?.extendStart ?? 0;
  const extendEnd = options?.extendEnd ?? 0;
  for (let i = 0; i <= last; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    if (!(lengthSq > 1e-12) || !finite(a.x, a.z, a.y, b.x, b.z, b.y, a.halfWidth, b.halfWidth)) continue;
    const length = Math.sqrt(lengthSq);
    const slot = index.freeSegs.length > 0 ? (index.freeSegs.pop() as number) : index.segSlots++;
    index.segs = grown(index.segs, index.segSlots * SEG_STRIDE);
    const s = index.segs;
    const o = slot * SEG_STRIDE;
    s[o + AX] = a.x;
    s[o + AZ] = a.z;
    s[o + AY] = a.y;
    s[o + DX] = dx;
    s[o + DZ] = dz;
    s[o + DY] = b.y - a.y;
    s[o + HA] = a.halfWidth;
    s[o + DH] = b.halfWidth - a.halfWidth;
    s[o + INV_LEN_SQ] = 1 / lengthSq;
    s[o + INV_LEN] = 1 / length;
    s[o + T_MIN] = (i === 0 && extendStart > 0 ? -extendStart / length : 0) - JOINT_SLACK;
    s[o + T_MAX] = 1 + (i === last && extendEnd > 0 ? extendEnd / length : 0) + JOINT_SLACK;
    s[o + OWNER] = owner;
    s[o + PATH] = i;

    // Box: the band (with its extensions) and the quad.
    const reach = Math.max(a.halfWidth, b.halfWidth) + FOOTPRINT_MARGIN;
    const fromX = a.x + dx * s[o + T_MIN];
    const fromZ = a.z + dz * s[o + T_MIN];
    const toX = a.x + dx * s[o + T_MAX];
    const toZ = a.z + dz * s[o + T_MAX];
    let x0 = Math.min(fromX, toX) - reach;
    let z0 = Math.min(fromZ, toZ) - reach;
    let x1 = Math.max(fromX, toX) + reach;
    let z1 = Math.max(fromZ, toZ) + reach;
    s[o + QUAD] = 0;
    const left = piece.left;
    const right = piece.right;
    if (left.length > i + 1 && right.length > i + 1) {
      quadX[0] = left[i].x;
      quadZ[0] = left[i].z;
      quadX[1] = left[i + 1].x;
      quadZ[1] = left[i + 1].z;
      quadX[2] = right[i + 1].x;
      quadZ[2] = right[i + 1].z;
      quadX[3] = right[i].x;
      quadZ[3] = right[i].z;
      if (finite(quadX[0], quadX[1], quadX[2], quadX[3], quadZ[0], quadZ[1], quadZ[2], quadZ[3]) && writeQuad(s, o, quadX, quadZ)) {
        s[o + QUAD] = 1;
        for (let k = 0; k < 4; k++) {
          x0 = Math.min(x0, quadX[k] - FOOTPRINT_MARGIN);
          z0 = Math.min(z0, quadZ[k] - FOOTPRINT_MARGIN);
          x1 = Math.max(x1, quadX[k] + FOOTPRINT_MARGIN);
          z1 = Math.max(z1, quadZ[k] + FOOTPRINT_MARGIN);
        }
      }
    }
    s[o + BOX] = x0;
    s[o + BOX + 1] = z0;
    s[o + BOX + 2] = x1;
    s[o + BOX + 3] = z1;
    owned.segs.push(slot);
    placeSeg(index, slot, true);
  }

  const bumps = piece.bumps;
  for (let i = 0; i < bumps.length; i++) {
    const bump = bumps[i];
    if (!finite(bump.x, bump.z, bump.y, bump.dirX, bump.dirZ, bump.halfLength, bump.halfWidth, bump.height)) continue;
    if (!(bump.halfLength > 0 && bump.halfLength + bump.halfWidth < 500)) continue;
    const slot = index.freeBumps.length > 0 ? (index.freeBumps.pop() as number) : index.bumpSlots++;
    index.bumps = grown(index.bumps, index.bumpSlots * BUMP_STRIDE);
    const b = index.bumps;
    const o = slot * BUMP_STRIDE;
    b[o + B_X] = bump.x;
    b[o + B_Z] = bump.z;
    b[o + B_Y] = bump.y;
    b[o + B_DIRX] = bump.dirX;
    b[o + B_DIRZ] = bump.dirZ;
    b[o + B_HALF_LENGTH] = bump.halfLength;
    b[o + B_HALF_WIDTH] = bump.halfWidth;
    b[o + B_HEIGHT] = bump.height;
    owned.bumps.push(slot);
    placeBump(index, slot, true);
  }
}

/** Removes everything `owner` added. Unknown owners are ignored. */
export function removePiece(surface: SurfaceIndex, owner: number): void {
  const index = surface as unknown as Index;
  const owned = index.owners.get(owner);
  if (!owned) return;
  for (let i = 0; i < owned.segs.length; i++) {
    placeSeg(index, owned.segs[i], false);
    index.freeSegs.push(owned.segs[i]);
  }
  for (let i = 0; i < owned.bumps.length; i++) {
    placeBump(index, owned.bumps[i], false);
    index.freeBumps.push(owned.bumps[i]);
  }
  index.owners.delete(owner);
}

/** Whether the index holds no road at all. */
export function surfaceEmpty(surface: SurfaceIndex): boolean {
  return (surface as unknown as Index).owners.size === 0;
}

/** Counts, for tests and diagnostics. */
export function surfaceStats(surface: SurfaceIndex): { segments: number; bumps: number; cells: number; owners: number; big: number } {
  const index = surface as unknown as Index;
  return {
    segments: index.segSlots - index.freeSegs.length,
    bumps: index.bumpSlots - index.freeBumps.length,
    cells: index.cells.size,
    owners: index.owners.size,
    big: index.big.length,
  };
}

/**
 * The highest bump among `list` that covers (x, z) and belongs to a road at height `base`: leaves its height and
 * gradient in the scratch fields (0 when none).
 */
function bumpAt(index: Index, list: readonly number[], x: number, z: number, base: number): void {
  let best = 0;
  let sx = 0;
  let sz = 0;
  const b = index.bumps;
  for (let i = 0; i < list.length; i++) {
    const o = list[i] * BUMP_STRIDE;
    if (!(Math.abs(base - b[o + B_Y]) <= BUMP_MATCH)) continue;
    const dx = x - b[o + B_X];
    const dz = z - b[o + B_Z];
    const dirX = b[o + B_DIRX];
    const dirZ = b[o + B_DIRZ];
    const halfLength = b[o + B_HALF_LENGTH];
    const along = dx * dirX + dz * dirZ;
    if (!(along > -halfLength && along < halfLength)) continue;
    const across = dz * dirX - dx * dirZ;
    const halfWidth = b[o + B_HALF_WIDTH];
    if (!(across >= -halfWidth && across <= halfWidth)) continue;
    const height = b[o + B_HEIGHT];
    const phase = (PI * along) / halfLength;
    const h = height * 0.5 * (1 + cos(phase));
    if (h > best) {
      best = h;
      // d/d(along) of the raised cosine, along the bump's direction.
      const rise = (-height * 0.5 * PI * sin(phase)) / halfLength;
      sx = rise * dirX;
      sz = rise * dirZ;
    }
  }
  index.bumpH = best;
  index.bumpSX = sx;
  index.bumpSZ = sz;
}

/**
 * Considers every segment of `list` under (x, z). Mode 0 keeps the highest surface not above `limit`; mode 1 keeps
 * the surface nearest `limit` (by height). The best so far is in the index's best* fields.
 */
function scan(index: Index, list: readonly number[], bumps: readonly number[], x: number, z: number, limit: number, nearest: boolean): void {
  const s = index.segs;
  for (let i = 0; i < list.length; i++) {
    const slot = list[i];
    const o = slot * SEG_STRIDE;
    const ax = s[o + AX];
    const az = s[o + AZ];
    const dx = s[o + DX];
    const dz = s[o + DZ];
    const px = x - ax;
    const pz = z - az;
    const t = (px * dx + pz * dz) * s[o + INV_LEN_SQ];
    const t01 = t < 0 ? 0 : t > 1 ? 1 : t;
    let inside = false;
    if (t >= s[o + T_MIN] && t <= s[o + T_MAX]) {
      const across = (pz * dx - px * dz) * s[o + INV_LEN];
      const reach = s[o + HA] + s[o + DH] * t01 + FOOTPRINT_MARGIN;
      inside = across <= reach && across >= -reach;
    }
    if (!inside && s[o + QUAD] === 1) {
      inside =
        s[o + Q0] * x + s[o + Q0 + 1] * z >= s[o + Q0 + 2] &&
        s[o + Q0 + 3] * x + s[o + Q0 + 4] * z >= s[o + Q0 + 5] &&
        s[o + Q0 + 6] * x + s[o + Q0 + 7] * z >= s[o + Q0 + 8] &&
        s[o + Q0 + 9] * x + s[o + Q0 + 10] * z >= s[o + Q0 + 11];
    }
    if (!inside) continue;
    const dy = s[o + DY];
    const base = s[o + AY] + dy * t01;
    // A bump only ever raises a road: one already too high cannot come back into reach.
    if (!nearest && base > limit) continue;
    let h = base;
    let sx = 0;
    let sz = 0;
    if (t >= 0 && t <= 1 && dy !== 0) {
      const grade = dy * s[o + INV_LEN_SQ];
      sx = grade * dx;
      sz = grade * dz;
    }
    if (bumps.length > 0) {
      bumpAt(index, bumps, x, z, base);
      if (index.bumpH > 0) {
        h += index.bumpH;
        sx += index.bumpSX;
        sz += index.bumpSZ;
      }
    }
    let score: number;
    if (nearest) score = -Math.abs(h - limit);
    else if (h <= limit) score = h;
    else continue;
    if (index.bestSeg < 0 || score > index.bestScore) {
      index.bestScore = score;
      index.bestY = h;
      index.bestSX = sx;
      index.bestSZ = sz;
      index.bestSeg = slot;
    }
  }
}

function query(index: Index, x: number, z: number, limit: number, nearest: boolean): SurfaceHit {
  index.bestSeg = -1;
  if (Math.abs(x) < 1e9 && Math.abs(z) < 1e9 && limit === limit) {
    const cell = index.cells.get(cellKey(Math.floor(x * INV_CELL), Math.floor(z * INV_CELL)));
    const bumps = cell === undefined ? NO_BUMPS : cell.bumps;
    if (cell !== undefined) scan(index, cell.segs, bumps, x, z, limit, nearest);
    if (index.big.length > 0) scan(index, index.big, bumps, x, z, limit, nearest);
  }
  const hit = index.hit;
  const seg = index.bestSeg;
  if (seg < 0) {
    hit.y = TERRAIN_Y;
    hit.onRoad = false;
    hit.slopeX = 0;
    hit.slopeZ = 0;
    hit.owner = -1;
    hit.pathIndex = -1;
  } else {
    hit.y = index.bestY;
    hit.onRoad = true;
    hit.slopeX = index.bestSX;
    hit.slopeZ = index.bestSZ;
    hit.owner = index.segs[seg * SEG_STRIDE + OWNER];
    hit.pathIndex = index.segs[seg * SEG_STRIDE + PATH];
  }
  return hit;
}

/**
 * The surface a car whose wheels are at `fromY` rests on at (x, z): the highest road surface at most STEP_UP above
 * `fromY` whose footprint holds the point, or the city floor. The result object is reused by every query.
 */
export function surfaceAt(surface: SurfaceIndex, x: number, z: number, fromY: number): SurfaceHit {
  return query(surface as unknown as Index, x, z, fromY + STEP_UP, false);
}

/**
 * The road surface at (x, z) nearest in height to `y`, whatever side of it; the city floor only when no road is
 * there at all. For placing a car. The result object is the same one `surfaceAt` reuses.
 */
export function nearestSurface(surface: SurfaceIndex, x: number, z: number, y: number): SurfaceHit {
  return query(surface as unknown as Index, x, z, y, true);
}
