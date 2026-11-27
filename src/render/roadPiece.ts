import { BoxGeometry, Color, Float32BufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial } from 'three';
import type { Bump, DecorBlock, PathPoint, Prop, Segment, Vec2 } from '../types';
import { builderMaterial, glowMaterial, sideShade, slopeShade } from './geometry';
import type { GeometryBuilder } from './geometry';
import { bumpHeightAt, bumpSlope, bumpStep, stepNear } from './ground';
import { ACCENTS, HUE, SURFACE, accentFor } from './palette';

/**
 * One stretch of road with everything that stands on or beside it: tarmac, paint, barrier walls, pillars and the
 * city blocks around it. A whole weekly level is one piece; the endless road is one piece per chunk. Both go
 * through the same code, so they cannot drift apart in looks.
 *
 * Nothing in here allocates per vertex: geometry is appended to a caller-owned GeometryBuilder, and the working
 * state lives in typed arrays that are kept between calls.
 */

// Heights of the flat layers, kept well apart so they never z-fight. Skid marks sit at 0.04 (see skid.ts).
export const Y_ROAD = 0.01;
/** Soft additive light on the road (pillar bases); under the paint so lines stay crisp. */
export const Y_GLOW = 0.02;
export const Y_PAINT = 0.03;

export interface RoadPiece {
  /** Centreline: places the dashes and tells a left wall from a right one. */
  path: readonly PathPoint[];
  /** Outline of the tarmac, left and right edge point by point. Need not be the same length as `path`. */
  left: readonly Vec2[];
  right: readonly Vec2[];
  walls: readonly Segment[];
  props: readonly Prop[];
  decor: readonly DecorBlock[];
  /** Bumps that belong to this piece: these get their warning paint here. */
  bumps: readonly Bump[];
  /** The first `groundCount` of these shape the ground under this piece: its own bumps and any neighbour's. */
  ground: readonly Bump[];
  groundCount: number;
  /** The tarmac runs on this far past the last outline point, m, to lap under the piece that follows. */
  overlap: number;
  /** Varies the cosmetic detail from piece to piece. Must be the same on every load of the same piece. */
  variation: number;
}

const CAP_MATCH = 1e-6;

function samePoint(ax: number, az: number, b: Vec2): boolean {
  return Math.abs(ax - b.x) <= CAP_MATCH && Math.abs(az - b.z) <= CAP_MATCH;
}

/**
 * Where a closed end of the road is: the far end of the wall that leaves the edge point `at` without following
 * the road edge on to `next`. Null when no wall closes the road there.
 *
 * A road's `left` and `right` stop at its first and last path point, but its walls may run on to a closing wall
 * some way beyond (the run-off behind a start line, or past a finish). The tarmac has to reach as far as the car
 * can, so both the weekly level and the first chunk of the endless road add these corners to their outline.
 */
export function closedEndCorner(walls: readonly Segment[], at: Vec2, next: Vec2): Vec2 | null {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (samePoint(w.ax, w.az, at) && !samePoint(w.bx, w.bz, next)) return { x: w.bx, z: w.bz };
    if (samePoint(w.bx, w.bz, at) && !samePoint(w.ax, w.az, next)) return { x: w.ax, z: w.az };
  }
  return null;
}

/** Materials and geometry that every piece shares. Owned by the renderer; a piece only ever disposes its own. */
export interface TrackShared {
  /** Everything opaque. */
  readonly solid: MeshBasicMaterial;
  /** Additive light on the road. */
  readonly glow: MeshBasicMaterial;
  readonly decorMaterial: MeshBasicMaterial;
  /** Unit box standing on y = 0, instanced for every city block. */
  readonly decorGeometry: BoxGeometry;
  dispose(): void;
}

export function createTrackShared(): TrackShared {
  const solid = builderMaterial();
  const glow = glowMaterial();
  const decorMaterial = new MeshBasicMaterial({ vertexColors: true });
  const decorGeometry = decorBoxGeometry();
  return {
    solid,
    glow,
    decorMaterial,
    decorGeometry,
    dispose() {
      solid.dispose();
      glow.dispose();
      decorMaterial.dispose();
      decorGeometry.dispose();
    },
  };
}

// Cosmetic variation that must look the same on every load of the same level, hence no Math.random.
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function nearestPathIndex(path: readonly PathPoint[], x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dx = x - path[i].x;
    const dz = z - path[i].z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Stations: the cross-sections the tarmac and its edge strips are built on
// ---------------------------------------------------------------------------------------------------------------

/** How far outside the tarmac a bump still counts as touching it, m. */
const BUMP_PAD = 0.25;
/** Vertices across the road where the ground is not flat. Two are enough for flat road. */
const BUMP_COLUMNS = 9;

let stationCapacity = 512;
let stationLX = new Float64Array(stationCapacity);
let stationLZ = new Float64Array(stationCapacity);
let stationRX = new Float64Array(stationCapacity);
let stationRZ = new Float64Array(stationCapacity);
/** 1 where the ground at the station may be raised, 0 where it is certainly flat. */
let stationRaised = new Uint8Array(stationCapacity);
let stationCount = 0;

function grown(old: Float64Array, capacity: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(capacity);
  next.set(old);
  return next;
}

function growStations(): void {
  stationCapacity *= 2;
  stationLX = grown(stationLX, stationCapacity);
  stationLZ = grown(stationLZ, stationCapacity);
  stationRX = grown(stationRX, stationCapacity);
  stationRZ = grown(stationRZ, stationCapacity);
  const raised = new Uint8Array(stationCapacity);
  raised.set(stationRaised);
  stationRaised = raised;
}

function pushStation(lx: number, lz: number, rx: number, rz: number, raised: number): void {
  if (stationCount === stationCapacity) growStations();
  const s = stationCount++;
  stationLX[s] = lx;
  stationLZ[s] = lz;
  stationRX[s] = rx;
  stationRZ[s] = rz;
  stationRaised[s] = raised;
}

/**
 * Turns the outline into stations: one per outline point, plus as many in between as it takes to follow a bump
 * smoothly wherever the road crosses one. Flat road gets no extra stations.
 */
function buildStations(piece: RoadPiece): void {
  const { left, right, ground, groundCount } = piece;
  const n = Math.min(left.length, right.length);
  stationCount = 0;
  let stepBefore = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    let step = 0;
    let length = 0;
    if (groundCount > 0 && i < n - 1) {
      const l1 = left[i + 1];
      const r1 = right[i + 1];
      const cx = (l.x + r.x) / 2;
      const cz = (l.z + r.z) / 2;
      const cx1 = (l1.x + r1.x) / 2;
      const cz1 = (l1.z + r1.z) / 2;
      const half = Math.max(Math.hypot(r.x - l.x, r.z - l.z), Math.hypot(r1.x - l1.x, r1.z - l1.z)) / 2;
      step = stepNear(ground, groundCount, cx, cz, cx1, cz1, half + BUMP_PAD);
      // The outer edge of a bend is longer than the centreline; it is the one that sets the spacing.
      length = Math.max(
        Math.hypot(cx1 - cx, cz1 - cz),
        Math.hypot(l1.x - l.x, l1.z - l.z),
        Math.hypot(r1.x - r.x, r1.z - r.z),
      );
    }
    pushStation(l.x, l.z, r.x, r.z, step > 0 || stepBefore > 0 ? 1 : 0);
    if (step > 0) {
      const l1 = left[i + 1];
      const r1 = right[i + 1];
      const pieces = Math.ceil(length / step);
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        pushStation(l.x + (l1.x - l.x) * t, l.z + (l1.z - l.z) * t, r.x + (r1.x - r.x) * t, r.z + (r1.z - r.z) * t, 1);
      }
    }
    stepBefore = step;
  }
  if (piece.overlap > 0 && stationCount >= 2) extendLastStation(piece.overlap);
}

/** Pushes the last station on along the road, so this piece's tarmac laps under the start of the next. */
function extendLastStation(distance: number): void {
  const s = stationCount - 1;
  const p = s - 1;
  const dx = (stationLX[s] + stationRX[s] - stationLX[p] - stationRX[p]) / 2;
  const dz = (stationLZ[s] + stationRZ[s] - stationLZ[p] - stationRZ[p]) / 2;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  const ox = (dx / len) * distance;
  const oz = (dz / len) * distance;
  stationLX[s] += ox;
  stationLZ[s] += oz;
  stationRX[s] += ox;
  stationRZ[s] += oz;
}

// ---------------------------------------------------------------------------------------------------------------
// Road
// ---------------------------------------------------------------------------------------------------------------

const DASH_PERIOD = 9;
const DASH_LENGTH = 3;
const DASH_HALF_WIDTH = 0.09;
const EDGE_INSET = 0.45;
const EDGE_WIDTH = 0.26;

/** The tarmac, on the current stations. Over a bump it follows the ground and is shaded by its slope. */
function addRoadSurface(b: GeometryBuilder, piece: RoadPiece): void {
  const { ground, groundCount } = piece;
  const columns = groundCount > 0 ? BUMP_COLUMNS : 2;
  const road = SURFACE.road;
  const first = b.vertexCount;
  for (let s = 0; s < stationCount; s++) {
    const lx = stationLX[s];
    const lz = stationLZ[s];
    const dx = stationRX[s] - lx;
    const dz = stationRZ[s] - lz;
    const raised = stationRaised[s] === 1;
    for (let c = 0; c < columns; c++) {
      const t = c / (columns - 1);
      const x = lx + dx * t;
      const z = lz + dz * t;
      if (!raised) {
        b.vertexRGB(x, Y_ROAD, z, road.r, road.g, road.b);
        continue;
      }
      const h = bumpHeightAt(ground, groundCount, x, z);
      const shade = slopeShade(bumpSlope.x, bumpSlope.z);
      b.vertexRGB(x, Y_ROAD + h, z, road.r * shade, road.g * shade, road.b * shade);
    }
  }
  for (let s = 0; s < stationCount - 1; s++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = first + s * columns + c;
      b.quad(a, a + 1, a + columns + 1, a + columns);
    }
  }
}

/** Neon strip just inside one road edge, on the current stations. */
function addEdgeStrip(b: GeometryBuilder, piece: RoadPiece, leftSide: boolean, color: Color): void {
  const { ground, groundCount } = piece;
  const first = b.vertexCount;
  for (let s = 0; s < stationCount; s++) {
    const ex = leftSide ? stationLX[s] : stationRX[s];
    const ez = leftSide ? stationLZ[s] : stationRZ[s];
    const dx = (leftSide ? stationRX[s] : stationLX[s]) - ex;
    const dz = (leftSide ? stationRZ[s] : stationLZ[s]) - ez;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const x0 = ex + ux * EDGE_INSET;
    const z0 = ez + uz * EDGE_INSET;
    const x1 = ex + ux * (EDGE_INSET + EDGE_WIDTH);
    const z1 = ez + uz * (EDGE_INSET + EDGE_WIDTH);
    let h0 = 0;
    let h1 = 0;
    if (stationRaised[s] === 1) {
      h0 = bumpHeightAt(ground, groundCount, x0, z0);
      h1 = bumpHeightAt(ground, groundCount, x1, z1);
    }
    b.vertex(x0, Y_PAINT + h0, z0, color);
    b.vertex(x1, Y_PAINT + h1, z1, color);
  }
  for (let s = 0; s < stationCount - 1; s++) {
    const a = first + s * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Centre dashes, spaced by distance along the whole road so they carry on unbroken from piece to piece. */
function addCentreLine(b: GeometryBuilder, piece: RoadPiece): void {
  const { path, ground, groundCount } = piece;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    const q = path[i + 1];
    const span = q.dist - p.dist;
    if (span <= 0) continue;
    // A bump carries its own markings; flat dashes would cut straight through it.
    if (groundCount > 0) {
      const pad = Math.max(p.halfWidth, q.halfWidth) + BUMP_PAD;
      if (stepNear(ground, groundCount, p.x, p.z, q.x, q.z, pad) > 0) continue;
    }
    for (let k = Math.floor(p.dist / DASH_PERIOD); k * DASH_PERIOD < q.dist; k++) {
      const from = Math.max(p.dist, k * DASH_PERIOD);
      const to = Math.min(q.dist, k * DASH_PERIOD + DASH_LENGTH);
      if (to <= from) continue;
      const ta = (from - p.dist) / span;
      const tb = (to - p.dist) / span;
      b.line(
        p.x + (q.x - p.x) * ta,
        p.z + (q.z - p.z) * ta,
        p.x + (q.x - p.x) * tb,
        p.z + (q.z - p.z) * tb,
        DASH_HALF_WIDTH,
        Y_PAINT,
        SURFACE.laneDash,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------------

export const WALL_HEIGHT = 0.7;
export const WALL_HALF_THICK = 0.13;
/** Each wall box is slightly longer than its segment so neighbours close the gap at a bend. */
export const WALL_OVERLAP = 0.06;
/** Ground this much above the plane counts as part of a bump, for the walls' warning colour. */
const RAISED_MIN = 0.02;

/** Cyan for the left road edge, magenta for the right, violet for the closed ends that run across the road. */
function wallTopColor(path: readonly PathPoint[], mx: number, mz: number, ux: number, uz: number): Color {
  if (path.length === 0) return ACCENTS[HUE.violet].glow;
  const i = nearestPathIndex(path, mx, mz);
  const prev = path[Math.max(i - 1, 0)];
  const next = path[Math.min(i + 1, path.length - 1)];
  const dx = next.x - prev.x;
  const dz = next.z - prev.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const tx = dx / len;
  const tz = dz / len;
  if (Math.abs(ux * tx + uz * tz) < 0.5) return ACCENTS[HUE.violet].glow;
  const side = (mx - path[i].x) * -tz + (mz - path[i].z) * tx;
  return side > 0 ? ACCENTS[HUE.magenta].glow : ACCENTS[HUE.cyan].glow;
}

/**
 * Barrier walls. On flat ground a wall is one box. Where it crosses a bump it is cut into short pieces whose tops
 * follow the ground, always WALL_HEIGHT above it, and those tops turn amber: the bump is flagged from both sides
 * of the road even when the car hides its crest.
 */
function addWalls(b: GeometryBuilder, piece: RoadPiece): void {
  const { walls, path, ground, groundCount } = piece;
  const warning = ACCENTS[HUE.amber].glow;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const dx = w.bx - w.ax;
    const dz = w.bz - w.az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    const top = wallTopColor(path, (w.ax + w.bx) / 2, (w.az + w.bz) / 2, ux, uz);
    const ox = ux * WALL_OVERLAP;
    const oz = uz * WALL_OVERLAP;
    const step = groundCount > 0 ? stepNear(ground, groundCount, w.ax, w.az, w.bx, w.bz, WALL_HALF_THICK + 0.1) : 0;
    if (step === 0) {
      b.beam(
        w.ax - ox,
        w.az - oz,
        w.bx + ox,
        w.bz + oz,
        WALL_HALF_THICK,
        0,
        WALL_HEIGHT,
        WALL_HEIGHT,
        true,
        true,
        SURFACE.wall,
        top,
      );
      continue;
    }
    const pieces = Math.ceil(len / step);
    let px = w.ax - ox;
    let pz = w.az - oz;
    let ph = bumpHeightAt(ground, groundCount, w.ax, w.az);
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      const x = w.ax + dx * t;
      const z = w.az + dz * t;
      const h = bumpHeightAt(ground, groundCount, x, z);
      const last = k === pieces;
      const qx = last ? x + ox : x;
      const qz = last ? z + oz : z;
      const raised = ph > RAISED_MIN || h > RAISED_MIN;
      b.beam(
        px,
        pz,
        qx,
        qz,
        WALL_HALF_THICK,
        0,
        WALL_HEIGHT + ph,
        WALL_HEIGHT + h,
        k === 1,
        last,
        SURFACE.wall,
        raised ? warning : top,
      );
      px = qx;
      pz = qz;
      ph = h;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bump markings
// ---------------------------------------------------------------------------------------------------------------

/** Bump paint sits this far above the true ground: clear of the faceted tarmac, just under the skid marks. */
const BUMP_PAINT_Y = 0.035;
/** Half the width of the glowing line along the crest, measured along the road, m. */
const CREST_HALF = 0.24;
/** The crest line stops this far short of the road edge, leaving the edge strips alone. */
const CREST_MARGIN = 0.8;
const CREST_BRIGHTNESS = 1.15;
/** Hazard stripes up both faces of the bump. */
const STRIPE_MARGIN = 1.0;
const STRIPE_WIDTH = 0.6;
const STRIPE_PITCH = 1.3;
/** Stripes start this far in from the foot of the bump and stop this far from the crest line. */
const STRIPE_FOOT_GAP = 0.2;
const STRIPE_CREST_GAP = 0.22;
/** Stripe brightness at the foot and at the top, as a multiple of plain amber. */
const STRIPE_FOOT = 0.14;
const STRIPE_TOP = 0.95;
/** The face the car lands on is marked too, but stays clearly dimmer than the one it meets first. */
const STRIPE_FAR_SIDE = 0.45;
/** Chevrons painted on the flat road before the bump, pointing at it. */
const CHEVRON_COUNT = 3;
const CHEVRON_FIRST = 3.5;
const CHEVRON_SPACING = 5.5;
const CHEVRON_HALF_WIDTH = 0.24;
const CHEVRON_MARGIN = 1.3;
const CHEVRON_MAX_SPAN = 3.2;
const CHEVRON_BRIGHTNESS = [0.95, 0.68, 0.45];

const paintA = new Color();
const paintB = new Color();

/**
 * A strip of paint on one bump, laid out in the bump's own frame: from `u0` to `u1` along the road (relative to
 * the crest) and from `v0` to `v1` across it. Within a bump the height depends on u alone, so two vertices per
 * row follow the surface exactly however wide the strip is. Brightness runs from `k0` at u0 to `k1` at u1.
 */
function addBumpStrip(
  b: GeometryBuilder,
  bump: Bump,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  color: Color,
  k0: number,
  k1: number,
): void {
  const rows = Math.max(1, Math.ceil(Math.abs(u1 - u0) / bumpStep(bump)));
  const rx = -bump.dirZ;
  const rz = bump.dirX;
  const first = b.vertexCount;
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const u = u0 + (u1 - u0) * t;
    const k = k0 + (k1 - k0) * t;
    const inside = Math.abs(u) < bump.halfLength;
    const h = inside ? bump.height * 0.5 * (1 + Math.cos((Math.PI * u) / bump.halfLength)) : 0;
    const cx = bump.x + bump.dirX * u;
    const cz = bump.z + bump.dirZ * u;
    b.vertex(cx + rx * v0, BUMP_PAINT_Y + h, cz + rz * v0, color, k);
    b.vertex(cx + rx * v1, BUMP_PAINT_Y + h, cz + rz * v1, color, k);
  }
  for (let row = 0; row < rows; row++) {
    const a = first + row * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Glowing amber line along the crest and hazard stripes up both faces. */
function addBumpPaint(b: GeometryBuilder, bump: Bump, roadHalfWidth: number): void {
  const amber = ACCENTS[HUE.amber];
  const crest = roadHalfWidth - CREST_MARGIN;
  if (crest > 0.3) {
    addBumpStrip(b, bump, -CREST_HALF, CREST_HALF, -crest, crest, amber.glow, CREST_BRIGHTNESS, CREST_BRIGHTNESS);
  }

  const reach = roadHalfWidth - STRIPE_MARGIN;
  const near = bump.halfLength - STRIPE_FOOT_GAP;
  const far = CREST_HALF + STRIPE_CREST_GAP;
  if (reach < STRIPE_WIDTH / 2 || near <= far) return;
  const count = Math.max(1, Math.floor((2 * reach + STRIPE_PITCH - STRIPE_WIDTH) / STRIPE_PITCH));
  const start = -((count - 1) * STRIPE_PITCH + STRIPE_WIDTH) / 2;
  for (let s = 0; s < count; s++) {
    const v0 = start + s * STRIPE_PITCH;
    const v1 = v0 + STRIPE_WIDTH;
    addBumpStrip(b, bump, -near, -far, v0, v1, amber.glow, STRIPE_FOOT, STRIPE_TOP);
    addBumpStrip(b, bump, far, near, v0, v1, amber.glow, STRIPE_TOP * STRIPE_FAR_SIDE, STRIPE_FOOT * STRIPE_FAR_SIDE);
  }
}

/**
 * Chevrons on the flat road before the bump, pointing the way the car is going. They follow the centreline, so
 * they stay on the road through a bend. One that would fall before this piece's first point is left out.
 */
function addChevrons(b: GeometryBuilder, piece: RoadPiece, bump: Bump, nearest: number): void {
  const { path, ground, groundCount } = piece;
  const at = path[nearest];
  const crestDist = at.dist + (bump.x - at.x) * bump.dirX + (bump.z - at.z) * bump.dirZ;
  const glow = ACCENTS[HUE.amber].glow;
  let j = Math.min(nearest, path.length - 2);
  for (let c = 0; c < CHEVRON_COUNT; c++) {
    const dist = crestDist - bump.halfLength - CHEVRON_FIRST - c * CHEVRON_SPACING;
    while (j > 0 && path[j].dist > dist) j--;
    const p = path[j];
    const q = path[j + 1];
    const span = q.dist - p.dist;
    if (dist < p.dist || span <= 0) return;
    const t = Math.min(1, (dist - p.dist) / span);
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    const x = p.x + dx * t;
    const z = p.z + dz * t;
    const halfSpan = Math.min(CHEVRON_MAX_SPAN, p.halfWidth + (q.halfWidth - p.halfWidth) * t - CHEVRON_MARGIN);
    if (halfSpan < 0.8) continue;
    const depth = Math.min(1.9, halfSpan * 0.6);
    const tipX = x + fx * depth;
    const tipZ = z + fz * depth;
    const leftX = x - fx * depth + fz * halfSpan;
    const leftZ = z - fz * depth - fx * halfSpan;
    const rightX = x - fx * depth - fz * halfSpan;
    const rightZ = z - fz * depth + fx * halfSpan;
    // Flat paint only works on flat ground: skip a chevron that would land on a bump.
    if (
      bumpHeightAt(ground, groundCount, tipX, tipZ) > 0 ||
      bumpHeightAt(ground, groundCount, leftX, leftZ) > 0 ||
      bumpHeightAt(ground, groundCount, rightX, rightZ) > 0
    ) {
      continue;
    }
    paintA.copy(glow).multiplyScalar(CHEVRON_BRIGHTNESS[c] ?? 0.4);
    // The arms fade towards their tails, which keeps the tip the brightest point: an arrowhead, not a bar.
    paintB.copy(paintA).multiplyScalar(0.55);
    b.line(leftX, leftZ, tipX, tipZ, CHEVRON_HALF_WIDTH, Y_PAINT, paintB, paintA);
    b.line(tipX, tipZ, rightX, rightZ, CHEVRON_HALF_WIDTH, Y_PAINT, paintA, paintB);
  }
}

function addBumpMarkings(b: GeometryBuilder, piece: RoadPiece): void {
  const { bumps, path } = piece;
  if (path.length < 2) return;
  for (let i = 0; i < bumps.length; i++) {
    const bump = bumps[i];
    if (!(bump.height > 0) || !(bump.halfLength > 0)) continue;
    const nearest = nearestPathIndex(path, bump.x, bump.z);
    addBumpPaint(b, bump, Math.min(path[nearest].halfWidth, bump.halfWidth));
    addChevrons(b, piece, bump, nearest);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

const PILLAR_SIDES = 20;
const RING_HEIGHT = 0.22;
const RING_GAP = 0.06;
/** How strongly the body takes on its accent hue, and how much brighter it is lit at its foot than at its top. */
const PILLAR_TINT = 0.1;
const PILLAR_FOOT_LIGHT = 1.7;
const PILLAR_TOP_LIGHT = 0.9;
/** Width of the glowing band around the rim of the cap, as seen from above. */
const CAP_RING_WIDTH = 0.34;
const CAP_RING_BRIGHTNESS = 0.9;
/** Pool of light on the road around the base: how far it reaches and how bright it is at the pillar. */
const BASE_GLOW_REACH = 3.2;
const BASE_GLOW_MID = 1.1;
const BASE_GLOW_BRIGHTNESS = 0.5;
const BLACK = new Color(0, 0, 0);

// The circle every pillar part is built on, and the fake-light shade of each of its sides.
const CIRCLE_COS = new Float64Array(PILLAR_SIDES + 1);
const CIRCLE_SIN = new Float64Array(PILLAR_SIDES + 1);
const CIRCLE_SHADE = new Float64Array(PILLAR_SIDES);
for (let k = 0; k <= PILLAR_SIDES; k++) {
  const angle = (k % PILLAR_SIDES) * ((Math.PI * 2) / PILLAR_SIDES);
  CIRCLE_COS[k] = Math.cos(angle);
  CIRCLE_SIN[k] = Math.sin(angle);
}
for (let k = 0; k < PILLAR_SIDES; k++) {
  const mid = (k + 0.5) * ((Math.PI * 2) / PILLAR_SIDES);
  CIRCLE_SHADE[k] = sideShade(Math.cos(mid), Math.sin(mid));
}

/** Tube whose colour runs from `foot` at y0 to `top` at y1, shaded by the fake light. */
function addTube(
  b: GeometryBuilder,
  cx: number,
  cz: number,
  radius: number,
  y0: number,
  y1: number,
  foot: Color,
  top: Color,
  shaded: boolean,
): void {
  for (let k = 0; k < PILLAR_SIDES; k++) {
    const shade = shaded ? CIRCLE_SHADE[k] : 1;
    const x0 = cx + CIRCLE_COS[k] * radius;
    const z0 = cz + CIRCLE_SIN[k] * radius;
    const x1 = cx + CIRCLE_COS[k + 1] * radius;
    const z1 = cz + CIRCLE_SIN[k + 1] * radius;
    const v0 = b.vertex(x0, y0, z0, foot, shade);
    const v1 = b.vertex(x1, y0, z1, foot, shade);
    const v2 = b.vertex(x1, y1, z1, top, shade);
    const v3 = b.vertex(x0, y1, z0, top, shade);
    b.quad(v0, v1, v2, v3);
  }
}

/** Flat ring on the plane `y` from radius r0 to r1, coloured `inner` to `outer`. r0 = 0 gives a disc. */
function addRing(
  b: GeometryBuilder,
  cx: number,
  cz: number,
  r0: number,
  r1: number,
  y: number,
  inner: Color,
  outer: Color,
): void {
  const first = b.vertexCount;
  for (let k = 0; k < PILLAR_SIDES; k++) {
    const cos = CIRCLE_COS[k];
    const sin = CIRCLE_SIN[k];
    b.vertex(cx + cos * r0, y, cz + sin * r0, inner);
    b.vertex(cx + cos * r1, y, cz + sin * r1, outer);
  }
  for (let k = 0; k < PILLAR_SIDES; k++) {
    const a = first + k * 2;
    const next = first + ((k + 1) % PILLAR_SIDES) * 2;
    b.quad(a, a + 1, next + 1, next);
  }
}

const pillarFoot = new Color();
const pillarTop = new Color();
const pillarCap = new Color();
const pillarRim = new Color();

/**
 * A pillar is the one thing on the road that ends a run, so it is built to be seen: a body lit in its accent
 * colour from the foot up, a glowing band round the rim of its cap, and two rings round the shaft.
 * `base` is the height of the ground it stands on.
 */
function addPillar(b: GeometryBuilder, prop: Prop, base: number): void {
  const accent = accentFor(prop.hue);
  const { x, z, radius } = prop;
  const height = base + prop.height;
  pillarTop.copy(SURFACE.pillar).lerp(accent.base, PILLAR_TINT);
  pillarFoot.copy(pillarTop).multiplyScalar(PILLAR_FOOT_LIGHT);
  pillarTop.multiplyScalar(PILLAR_TOP_LIGHT);
  addTube(b, x, z, radius, 0, height, pillarFoot, pillarTop, true);

  pillarCap.copy(SURFACE.pillarCap).lerp(accent.base, PILLAR_TINT);
  pillarRim.copy(accent.glow).multiplyScalar(CAP_RING_BRIGHTNESS);
  const capInner = Math.max(0, radius - CAP_RING_WIDTH);
  addRing(b, x, z, 0, capInner, height, pillarCap, pillarCap);
  addRing(b, x, z, capInner, radius + RING_GAP, height, pillarRim, pillarRim);

  const ringRadius = radius + RING_GAP;
  const low = Math.max(0.1, prop.height * 0.3);
  const high = Math.max(low + RING_HEIGHT + 0.1, prop.height - RING_HEIGHT);
  addTube(b, x, z, ringRadius, base + low, base + low + RING_HEIGHT, accent.glow, accent.glow, false);
  addTube(b, x, z, ringRadius, base + high, base + high + RING_HEIGHT, accent.glow, accent.glow, false);
}

/** The pool of accent light a pillar throws on the road. Goes into the additive glow mesh: black adds nothing. */
function addPillarGlow(b: GeometryBuilder, prop: Prop, base: number): void {
  const accent = accentFor(prop.hue).base;
  pillarFoot.copy(accent).multiplyScalar(BASE_GLOW_BRIGHTNESS);
  // Two bands approximate a soft falloff: most of the light is lost in the first metre.
  pillarTop.copy(accent).multiplyScalar(BASE_GLOW_BRIGHTNESS * 0.3);
  const r0 = prop.radius * 0.9;
  const r1 = prop.radius + BASE_GLOW_MID;
  const r2 = prop.radius + BASE_GLOW_REACH;
  addRing(b, prop.x, prop.z, r0, r1, Y_GLOW + base, pillarFoot, pillarTop);
  addRing(b, prop.x, prop.z, r1, r2, Y_GLOW + base, pillarTop, BLACK);
}

// ---------------------------------------------------------------------------------------------------------------
// Decor: dark instanced boxes, plus neon detail merged into the static mesh
// ---------------------------------------------------------------------------------------------------------------

const ROOF_GLOW = 0.4;
const ROOF_INSET = 0.3;
const ROOF_HALF_WIDTH = 0.14;
const STRIP_GLOW = 0.75;
const STRIP_HALF_WIDTH = 0.16;
const STRIP_STANDOFF = 0.04;
const STRIP_CHANCE = 0.55;

function addRoofOutline(b: GeometryBuilder, block: DecorBlock, color: Color): void {
  const x0 = block.x - block.w / 2 + ROOF_INSET;
  const x1 = block.x + block.w / 2 - ROOF_INSET;
  const z0 = block.z - block.d / 2 + ROOF_INSET;
  const z1 = block.z + block.d / 2 - ROOF_INSET;
  if (x1 <= x0 || z1 <= z0) return;
  const y = block.h + 0.03;
  b.line(x0, z0, x1, z0, ROOF_HALF_WIDTH, y, color);
  b.line(x1, z0, x1, z1, ROOF_HALF_WIDTH, y, color);
  b.line(x1, z1, x0, z1, ROOF_HALF_WIDTH, y, color);
  b.line(x0, z1, x0, z0, ROOF_HALF_WIDTH, y, color);
}

/** Vertical light strips on the +X and +Z faces, the only two the locked camera can see. */
function addLightStrips(b: GeometryBuilder, block: DecorBlock, index: number, color: Color): void {
  if (hash01(index * 7 + 1) > STRIP_CHANCE || block.w < 2 || block.d < 2) return;
  const count = 1 + Math.floor(hash01(index * 7 + 2) * 3);
  const y0 = block.h * 0.12;
  const y1 = block.h * 0.92;
  for (let s = 0; s < count; s++) {
    const along = (hash01(index * 31 + s * 3 + 3) - 0.5) * 0.7;
    if (hash01(index * 31 + s * 3 + 4) < 0.5) {
      const x = block.x + block.w / 2 + STRIP_STANDOFF;
      const z = block.z + along * block.d;
      b.upright(x, z - STRIP_HALF_WIDTH, x, z + STRIP_HALF_WIDTH, y0, y1, color);
    } else {
      const z = block.z + block.d / 2 + STRIP_STANDOFF;
      const x = block.x + along * block.w;
      b.upright(x - STRIP_HALF_WIDTH, z, x + STRIP_HALF_WIDTH, z, y0, y1, color);
    }
  }
}

function addDecorAccents(b: GeometryBuilder, piece: RoadPiece): void {
  const decor = piece.decor;
  for (let i = 0; i < decor.length; i++) {
    const block = decor[i];
    const glow = accentFor(block.hue).glow;
    addRoofOutline(b, block, paintA.copy(glow).multiplyScalar(ROOF_GLOW));
    addLightStrips(b, block, piece.variation + i, paintB.copy(glow).multiplyScalar(STRIP_GLOW));
  }
}

/** Unit box standing on y = 0 with a baked shade per face. */
function decorBoxGeometry(): BoxGeometry {
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const normal = geometry.getAttribute('normal');
  const colors: number[] = [];
  for (let i = 0; i < normal.count; i++) {
    const shade = normal.getY(i) > 0.5 ? 1 : 0.75 * sideShade(normal.getX(i), normal.getZ(i));
    colors.push(shade, shade, shade);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

const decorMatrix = new Matrix4();
const decorTint = new Color();

/**
 * The piece's city blocks as one instanced mesh placed at (originX, originZ), or null when it has none. The
 * geometry and material are the shared ones: disposing the mesh frees only its own instance buffers.
 */
export function buildDecorMesh(
  decor: readonly DecorBlock[],
  shared: TrackShared,
  originX = 0,
  originZ = 0,
): InstancedMesh<BoxGeometry, MeshBasicMaterial> | null {
  const count = decor.length;
  if (count === 0) return null;
  const mesh = new InstancedMesh(shared.decorGeometry, shared.decorMaterial, count);
  for (let i = 0; i < count; i++) {
    const block = decor[i];
    decorMatrix.makeScale(block.w, block.h, block.d).setPosition(block.x - originX, 0, block.z - originZ);
    mesh.setMatrixAt(i, decorMatrix);
    mesh.setColorAt(i, decorTint.copy(SURFACE.decor).lerp(accentFor(block.hue).base, 0.07));
  }
  mesh.position.set(originX, 0, originZ);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------------------------------------------

/**
 * Appends everything opaque in the piece to `b`: tarmac, centre dashes, edge strips, walls, pillars, the neon
 * detail on the city blocks and, where there are bumps, their warning paint.
 */
export function addRoadPiece(b: GeometryBuilder, piece: RoadPiece): void {
  buildStations(piece);
  addRoadSurface(b, piece);
  addCentreLine(b, piece);
  addEdgeStrip(b, piece, true, ACCENTS[HUE.cyan].glow);
  addEdgeStrip(b, piece, false, ACCENTS[HUE.magenta].glow);
  addWalls(b, piece);
  const { props, ground, groundCount } = piece;
  for (let i = 0; i < props.length; i++) {
    addPillar(b, props[i], groundCount > 0 ? bumpHeightAt(ground, groundCount, props[i].x, props[i].z) : 0);
  }
  addDecorAccents(b, piece);
  if (piece.bumps.length > 0) addBumpMarkings(b, piece);
}

/** Appends the piece's additive light (the pools around its pillars) to `b`. Adds nothing when it has no props. */
export function addRoadPieceGlow(b: GeometryBuilder, piece: RoadPiece): void {
  const { props, ground, groundCount } = piece;
  for (let i = 0; i < props.length; i++) {
    addPillarGlow(b, props[i], groundCount > 0 ? bumpHeightAt(ground, groundCount, props[i].x, props[i].z) : 0);
  }
}
