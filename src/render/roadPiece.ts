import {
  AddEquation,
  BoxGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  SrcColorFactor,
  ZeroFactor,
} from 'three';
import { TERRAIN_Y, WALL_HEIGHT } from '../types';
import type { Bump, DecorBlock, PathPoint, Prop, Segment, Support, Vec2, Wall } from '../types';
import { builderMaterial, glowMaterial, sideShade, slopeShade } from './geometry';
import type { GeometryBuilder } from './geometry';
import { bumpHeightAt, bumpSlope, bumpStep, stepNear } from './ground';
import {
  BlockSinker,
  DeckFader,
  SectionTable,
  deckSectionStarts,
  describeSections,
  injectSectionFade,
} from './occlusion';
import type { DeckSections } from './occlusion';
import { ACCENTS, DECK, FLOOR_SHADOW, HUE, SURFACE, accentFor } from './palette';
import { RoadSurface } from './surface';

export { WALL_HEIGHT };

/**
 * One road with everything that stands on, under or beside it: the deck (tarmac on a slab with side faces), its
 * paint, barrier walls, hazard paint along open edges, pillars, the columns holding it up, its shadow on the city
 * floor and the city blocks around it. A fixed level is one piece; the endless road is one piece per chunk. Both
 * go through the same code, so they cannot drift apart in looks.
 *
 * Every vertex of the deck carries the id of the road SECTION it belongs to (see occlusion.ts), so a stretch that
 * would hide the car can fade on its own.
 *
 * Nothing in here allocates per vertex: geometry is appended to a caller-owned GeometryBuilder, and the working
 * state lives in typed arrays that are kept between calls.
 */

// Heights of the flat layers above the road surface, kept apart so they never z-fight. Skid marks sit at 0.04.
export const Y_ROAD = 0.01;
/** Soft additive light on the road (pillar bases, hazard glow); under the paint so lines stay crisp. */
export const Y_GLOW = 0.02;
export const Y_PAINT = 0.03;
/** Thickness of the road slab under the surface, m. */
export const DECK_DEPTH = 0.8;
/** The shadow of a deck lies this far above the city floor. */
const Y_FLOOR_SHADOW = 0.03;

export interface RoadPiece {
  /** Centreline: heights, dashes, sections, and which side a wall is on. */
  path: readonly PathPoint[];
  /** Outline of the tarmac, left and right edge point by point. */
  left: readonly Vec2[];
  right: readonly Vec2[];
  /** Road surface height at each outline point. */
  heights: readonly number[];
  /** Outline points before path[0] (a walled run-off behind the start): outline i is path point i - lead. */
  lead: number;
  /** Per path segment: no barrier on that edge (see RoadPiece in types.ts). */
  leftOpen: readonly boolean[];
  rightOpen: readonly boolean[];
  walls: readonly Wall[];
  props: readonly Prop[];
  supports: readonly Support[];
  decor: readonly DecorBlock[];
  /** Bumps that belong to this piece: these get their warning paint here. */
  bumps: readonly Bump[];
  /** The first `groundCount` of these shape the surface of this piece: its own bumps and any neighbour's. */
  ground: readonly Bump[];
  groundCount: number;
  /** The tarmac runs on this far past the last outline point, m, to lap under the piece that follows. */
  overlap: number;
  /** Varies the cosmetic detail from piece to piece. Must be the same on every load of the same piece. */
  variation: number;
  /** Section ids: `sectionBase + k` for section k, which starts at path index sectionStarts[k]. */
  sectionBase: number;
  sectionStarts: Int32Array;
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

/**
 * The runs of consecutive open edge segments: pairs [start, end) of segment indices, flattened. Only the first
 * `count` entries of `open` are looked at (the last entry of a RoadPiece's open array is unused).
 */
export function hazardSpans(open: readonly boolean[], count: number): number[] {
  const spans: number[] = [];
  let start = -1;
  const n = Math.min(count, open.length);
  for (let i = 0; i < n; i++) {
    if (open[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      spans.push(start, i);
      start = -1;
    }
  }
  if (start >= 0) spans.push(start, n);
  return spans;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared materials and the registries every piece reports to
// ---------------------------------------------------------------------------------------------------------------

/** Materials, geometry and per-scene registries that every piece shares. Owned by the renderer. */
export interface TrackShared {
  /** Opaque, vertex coloured: floors, gates, anything that never fades. */
  readonly solid: MeshBasicMaterial;
  /** Additive light that never fades. */
  readonly glow: MeshBasicMaterial;
  /** The road decks: opaque, fading per section by dithering. */
  readonly deck: MeshBasicMaterial;
  /** Additive light on the decks, fading per section. */
  readonly deckGlow: MeshBasicMaterial;
  /** Darkens what is under it (multiply): the decks' shadows on the city floor. */
  readonly shadow: MeshBasicMaterial;
  readonly decorMaterial: MeshBasicMaterial;
  /** Unit box standing on y = 0, instanced for every city block. */
  readonly decorGeometry: BoxGeometry;
  /** Opacity of every deck section, and the texture the deck shaders read it from. */
  readonly sections: SectionTable;
  /** Fades the sections that would hide the car. */
  readonly fader: DeckFader;
  /** Sinks the city blocks that would hide the car. */
  readonly sinker: BlockSinker;
  /** Every road on show, for "how high is the road here". */
  readonly surface: RoadSurface;
  dispose(): void;
}

export function createTrackShared(): TrackShared {
  const solid = builderMaterial();
  const glow = glowMaterial();
  const sections = new SectionTable();
  const deck = builderMaterial();
  deck.onBeforeCompile = (shader) => injectSectionFade(shader, sections.texture, false);
  deck.customProgramCacheKey = () => 'sigdrift-deck';
  const deckGlow = glowMaterial();
  deckGlow.onBeforeCompile = (shader) => injectSectionFade(shader, sections.texture, true);
  deckGlow.customProgramCacheKey = () => 'sigdrift-deck-glow';
  const shadow = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
  });
  const decorMaterial = new MeshBasicMaterial({ vertexColors: true });
  const decorGeometry = decorBoxGeometry();
  return {
    solid,
    glow,
    deck,
    deckGlow,
    shadow,
    decorMaterial,
    decorGeometry,
    sections,
    fader: new DeckFader(sections),
    sinker: new BlockSinker(new Matrix4()),
    surface: new RoadSurface(),
    dispose() {
      solid.dispose();
      glow.dispose();
      deck.dispose();
      deckGlow.dispose();
      shadow.dispose();
      decorMaterial.dispose();
      decorGeometry.dispose();
      sections.dispose();
    },
  };
}

/** Cuts a road into sections, takes ids for them from the table and describes them for the fader. */
export function allocateSections(path: readonly PathPoint[], table: SectionTable): DeckSections {
  const starts = deckSectionStarts(path);
  const base = table.alloc(starts.length - 1);
  return describeSections(path, starts, base);
}

// Cosmetic variation that must look the same on every load of the same level, hence no Math.random.
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Path points within this much height of the asked-for point count fully; others pay for the difference. */
const NEAREST_Y_WEIGHT = 25;
let nearestHint = 0;

/**
 * Index of the path point nearest to (x, y, z), heavily weighting height so a bridge and the road under it are
 * never confused. Looks around the previous answer first: walls and props come roughly in road order.
 */
function nearestPathIndex(path: readonly PathPoint[], x: number, z: number, y: number): number {
  const n = path.length;
  if (n === 0) return 0;
  const cost = (i: number): number => {
    const p = path[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const dy = (y - p.y) * NEAREST_Y_WEIGHT;
    return dx * dx + dz * dz + dy * dy;
  };
  const hint = Math.min(nearestHint, n - 1);
  let best = hint;
  let bestD = cost(hint);
  for (let i = Math.max(0, hint - 8); i <= Math.min(n - 1, hint + 8); i++) {
    const d = cost(i);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = path[best];
  const local = (p.halfWidth + 4) * (p.halfWidth + 4);
  if (bestD > local) {
    for (let i = 0; i < n; i++) {
      const d = cost(i);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  nearestHint = best;
  return best;
}

// Section id of every path point of the piece being built.
let pointSection = new Int32Array(1024);

function fillPointSections(piece: RoadPiece): void {
  const n = piece.path.length;
  if (pointSection.length < n) pointSection = new Int32Array(n * 2);
  const { sectionStarts: starts, sectionBase: base } = piece;
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < starts.length - 2 && i >= starts[k + 1]) k++;
    pointSection[i] = base > 0 ? base + k : 0;
  }
}

function sectionAt(piece: RoadPiece, x: number, z: number, y: number): number {
  return piece.path.length === 0 ? 0 : pointSection[nearestPathIndex(piece.path, x, z, y)];
}

// ---------------------------------------------------------------------------------------------------------------
// Stations: the cross-sections the deck is built on
// ---------------------------------------------------------------------------------------------------------------

/** How far outside the tarmac a bump still counts as touching it, m. */
const BUMP_PAD = 0.25;
/** Vertices across the road where the surface is not flat. Two are enough for flat road. */
const BUMP_COLUMNS = 9;

let stationCapacity = 512;
let stationLX = new Float64Array(stationCapacity);
let stationLZ = new Float64Array(stationCapacity);
let stationRX = new Float64Array(stationCapacity);
let stationRZ = new Float64Array(stationCapacity);
/** Road surface height (without bumps). */
let stationY = new Float64Array(stationCapacity);
/** Surface height at the left and right edge, bumps included (filled by addRoadSurface). */
let stationTopL = new Float64Array(stationCapacity);
let stationTopR = new Float64Array(stationCapacity);
/** 1 where a bump may raise the surface, 0 where it is certainly plain. */
let stationRaised = new Uint8Array(stationCapacity);
/** Path segment the stretch to the next station lies on, or -1 (run-off beyond the path). */
let stationSeg = new Int32Array(stationCapacity);
/** Section id of the station. */
let stationSection = new Int32Array(stationCapacity);
let stationCount = 0;

function grown(old: Float64Array, capacity: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(capacity);
  next.set(old);
  return next;
}

function grownInt(old: Int32Array, capacity: number): Int32Array<ArrayBuffer> {
  const next = new Int32Array(capacity);
  next.set(old);
  return next;
}

function growStations(): void {
  stationCapacity *= 2;
  stationLX = grown(stationLX, stationCapacity);
  stationLZ = grown(stationLZ, stationCapacity);
  stationRX = grown(stationRX, stationCapacity);
  stationRZ = grown(stationRZ, stationCapacity);
  stationY = grown(stationY, stationCapacity);
  stationTopL = grown(stationTopL, stationCapacity);
  stationTopR = grown(stationTopR, stationCapacity);
  const raised = new Uint8Array(stationCapacity);
  raised.set(stationRaised);
  stationRaised = raised;
  stationSeg = grownInt(stationSeg, stationCapacity);
  stationSection = grownInt(stationSection, stationCapacity);
}

function pushStation(lx: number, lz: number, rx: number, rz: number, y: number, raised: number, seg: number, section: number): void {
  if (stationCount === stationCapacity) growStations();
  const s = stationCount++;
  stationLX[s] = lx;
  stationLZ[s] = lz;
  stationRX[s] = rx;
  stationRZ[s] = rz;
  stationY[s] = y;
  stationRaised[s] = raised;
  stationSeg[s] = seg;
  stationSection[s] = section;
}

/**
 * Turns the outline into stations: one per outline point, plus as many in between as it takes to follow a bump
 * smoothly wherever the road crosses one. Plain road gets no extra stations: slopes are straight between points.
 */
function buildStations(piece: RoadPiece): void {
  const { left, right, heights, ground, groundCount, path, lead } = piece;
  const n = Math.min(left.length, right.length, heights.length);
  const last = path.length - 1;
  stationCount = 0;
  let stepBefore = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const y = heights[i];
    const at = i - lead;
    const seg = at >= 0 && at < last ? at : -1;
    const section = last >= 0 ? pointSection[Math.min(last, Math.max(0, at))] : 0;
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
      step = stepNear(ground, groundCount, cx, cz, cx1, cz1, half + BUMP_PAD, y, heights[i + 1]);
      // The outer edge of a bend is longer than the centreline; it is the one that sets the spacing.
      length = Math.max(
        Math.hypot(cx1 - cx, cz1 - cz),
        Math.hypot(l1.x - l.x, l1.z - l.z),
        Math.hypot(r1.x - r.x, r1.z - r.z),
      );
    }
    pushStation(l.x, l.z, r.x, r.z, y, step > 0 || stepBefore > 0 ? 1 : 0, seg, section);
    if (step > 0) {
      const l1 = left[i + 1];
      const r1 = right[i + 1];
      const y1 = heights[i + 1];
      const pieces = Math.ceil(length / step);
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        pushStation(
          l.x + (l1.x - l.x) * t,
          l.z + (l1.z - l.z) * t,
          r.x + (r1.x - r.x) * t,
          r.z + (r1.z - r.z) * t,
          y + (y1 - y) * t,
          1,
          seg,
          section,
        );
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

/** Whether the stretch from station s to s + 1 has an open (barrier-free) edge on that side. */
function stretchOpen(piece: RoadPiece, s: number, leftSide: boolean): boolean {
  const seg = stationSeg[s];
  if (seg < 0) return false;
  return (leftSide ? piece.leftOpen[seg] : piece.rightOpen[seg]) === true;
}

// ---------------------------------------------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------------------------------------------

const DASH_PERIOD = 9;
const DASH_LENGTH = 3;
const DASH_HALF_WIDTH = 0.09;
const EDGE_INSET = 0.45;
const EDGE_WIDTH = 0.26;
/** The bottom outline of the slab, m tall. */
const LIP_HEIGHT = 0.07;

/** Slope of the road at station s along its length (rise per metre), as a gradient in x and z. */
const rampSlope = { x: 0, z: 0 };
function stationRamp(s: number): void {
  const a = Math.max(0, s - 1);
  const b = Math.min(stationCount - 1, s + 1);
  const dx = (stationLX[b] + stationRX[b] - stationLX[a] - stationRX[a]) / 2;
  const dz = (stationLZ[b] + stationRZ[b] - stationLZ[a] - stationRZ[a]) / 2;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) {
    rampSlope.x = rampSlope.z = 0;
    return;
  }
  const rise = (stationY[b] - stationY[a]) / len2;
  rampSlope.x = dx * rise;
  rampSlope.z = dz * rise;
}

/** The tarmac, on the current stations, shaded by its slope (climbs facing the fake light are lighter). */
function addRoadSurface(b: GeometryBuilder, piece: RoadPiece): void {
  const { ground, groundCount } = piece;
  const columns = groundCount > 0 ? BUMP_COLUMNS : 2;
  const road = SURFACE.road;
  const first = b.vertexCount;
  for (let s = 0; s < stationCount; s++) {
    b.section = stationSection[s];
    const lx = stationLX[s];
    const lz = stationLZ[s];
    const dx = stationRX[s] - lx;
    const dz = stationRZ[s] - lz;
    const base = stationY[s];
    const raised = stationRaised[s] === 1;
    stationRamp(s);
    for (let c = 0; c < columns; c++) {
      const t = c / (columns - 1);
      const x = lx + dx * t;
      const z = lz + dz * t;
      let h = 0;
      let gx = rampSlope.x;
      let gz = rampSlope.z;
      if (raised) {
        h = bumpHeightAt(ground, groundCount, x, z, base);
        gx += bumpSlope.x;
        gz += bumpSlope.z;
      }
      const shade = slopeShade(gx, gz);
      b.vertexRGB(x, base + Y_ROAD + h, z, road.r * shade, road.g * shade, road.b * shade);
      if (c === 0) stationTopL[s] = base + h;
      if (c === columns - 1) stationTopR[s] = base + h;
    }
  }
  for (let s = 0; s < stationCount - 1; s++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = first + s * columns + c;
      b.quad(a, a + 1, a + columns + 1, a + columns);
    }
  }
}

/** Brightness of a deck side face whose outward normal is (nx, nz): never darker than the tarmac on top. */
function deckSideShade(nx: number, nz: number): number {
  return 0.8 + 0.5 * Math.max(0, nx * 0.9 + nz * 0.44);
}

/**
 * The slab's side faces down both edges, a dim line along their bottom, and its two ends. From the locked camera
 * the faces towards it show as a lighter band under the road edge: the deeper the drop, the more it reads.
 */
function addDeckSides(b: GeometryBuilder): void {
  for (let side = 0; side < 2; side++) {
    const leftSide = side === 0;
    const xs = leftSide ? stationLX : stationRX;
    const zs = leftSide ? stationLZ : stationRZ;
    const tops = leftSide ? stationTopL : stationTopR;
    for (let s = 0; s < stationCount - 1; s++) {
      const dx = xs[s + 1] - xs[s];
      const dz = zs[s + 1] - zs[s];
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-6) continue;
      // Left of (dx, dz) is (dz, -dx); right is (-dz, dx).
      const nx = (leftSide ? dz : -dz) / len;
      const nz = (leftSide ? -dx : dx) / len;
      b.section = stationSection[s];
      const bottomA = stationY[s] - DECK_DEPTH;
      const bottomB = stationY[s + 1] - DECK_DEPTH;
      b.wall4(xs[s], zs[s], xs[s + 1], zs[s + 1], bottomA, bottomB, tops[s] + Y_ROAD, tops[s + 1] + Y_ROAD, DECK.side, deckSideShade(nx, nz));
      const ox = nx * 0.015;
      const oz = nz * 0.015;
      b.wall4(
        xs[s] + ox,
        zs[s] + oz,
        xs[s + 1] + ox,
        zs[s + 1] + oz,
        bottomA,
        bottomB,
        bottomA + LIP_HEIGHT,
        bottomB + LIP_HEIGHT,
        DECK.lip,
      );
    }
  }
  if (stationCount < 2) return;
  for (const s of [0, stationCount - 1]) {
    b.section = stationSection[s];
    const bottom = stationY[s] - DECK_DEPTH;
    b.wall4(stationLX[s], stationLZ[s], stationRX[s], stationRZ[s], bottom, bottom, stationTopL[s] + Y_ROAD, stationTopR[s] + Y_ROAD, DECK.side, 0.8);
  }
}

/** Neon strip just inside one road edge, on the current stations. Left out where the edge is open. */
function addEdgeStrip(b: GeometryBuilder, piece: RoadPiece, leftSide: boolean, color: Color): void {
  let pair = -1;
  let pairStation = -1;
  for (let s = 0; s < stationCount - 1; s++) {
    if (stretchOpen(piece, s, leftSide)) continue;
    if (pairStation !== s) pair = addEdgePair(b, piece, s, leftSide, color);
    const next = addEdgePair(b, piece, s + 1, leftSide, color);
    b.quad(pair, pair + 1, next + 1, next);
    pair = next;
    pairStation = s + 1;
  }
}

/** The two vertices of an edge strip at station s; returns the first. */
function addEdgePair(b: GeometryBuilder, piece: RoadPiece, s: number, leftSide: boolean, color: Color): number {
  const { ground, groundCount } = piece;
  b.section = stationSection[s];
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
  const base = stationY[s];
  let h0 = 0;
  let h1 = 0;
  if (stationRaised[s] === 1) {
    h0 = bumpHeightAt(ground, groundCount, x0, z0, base);
    h1 = bumpHeightAt(ground, groundCount, x1, z1, base);
  }
  const first = b.vertex(x0, base + Y_PAINT + h0, z0, color);
  b.vertex(x1, base + Y_PAINT + h1, z1, color);
  return first;
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
      if (stepNear(ground, groundCount, p.x, p.z, q.x, q.z, pad, p.y, q.y) > 0) continue;
    }
    b.section = pointSection[i];
    for (let k = Math.floor(p.dist / DASH_PERIOD); k * DASH_PERIOD < q.dist; k++) {
      const from = Math.max(p.dist, k * DASH_PERIOD);
      const to = Math.min(q.dist, k * DASH_PERIOD + DASH_LENGTH);
      if (to <= from) continue;
      const ta = (from - p.dist) / span;
      const tb = (to - p.dist) / span;
      b.line3(
        p.x + (q.x - p.x) * ta,
        p.y + (q.y - p.y) * ta + Y_PAINT,
        p.z + (q.z - p.z) * ta,
        p.x + (q.x - p.x) * tb,
        p.y + (q.y - p.y) * tb + Y_PAINT,
        p.z + (q.z - p.z) * tb,
        DASH_HALF_WIDTH,
        SURFACE.laneDash,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Open edges: hazard paint where the car can fall off
// ---------------------------------------------------------------------------------------------------------------

const HAZARD_PITCH = 1.5;
const HAZARD_STRIPE = 0.7;
const HAZARD_SLANT = 0.55;
const HAZARD_INNER = 0.95;
const HAZARD_OUTER = 0.08;
const HAZARD_LINE_INSET = 0.04;
const HAZARD_LINE_HALF = 0.06;
const HAZARD_GLOW_REACH = 2.4;
/** The red line along the side face, measured down from the deck top, m. */
const HAZARD_SIDE_TOP = 0.05;
const HAZARD_SIDE_BOTTOM = 0.2;
const BLACK = new Color(0, 0, 0);

/** Longest piece of brink line or glow over a bump, m: short enough to follow the bump's profile. */
const HAZARD_BUMP_STEP = 0.5;

/** Height of the tarmac at (x, z) on a stretch whose plain road height there is `base`: plus any bump. */
function deckHeight(piece: RoadPiece, x: number, z: number, base: number): number {
  const { ground, groundCount } = piece;
  return groundCount > 0 ? base + bumpHeightAt(ground, groundCount, x, z, base) : base;
}

/** How many pieces an open edge segment's paint is cut into: 1, or enough to follow a bump next to it. */
function hazardPieces(piece: RoadPiece, a: Vec2, e: Vec2, ya: number, yb: number, len: number): number {
  const { ground, groundCount } = piece;
  if (groundCount === 0) return 1;
  if (stepNear(ground, groundCount, a.x, a.z, e.x, e.z, HAZARD_GLOW_REACH + 0.5, ya, yb) <= 0) return 1;
  return Math.max(1, Math.ceil(len / HAZARD_BUMP_STEP));
}

/** Edge point `i` of the path (outline index i + lead) on one side. */
function edgePoint(piece: RoadPiece, i: number, leftSide: boolean): Vec2 {
  return (leftSide ? piece.left : piece.right)[i + piece.lead];
}

/**
 * Calls `paint` for every open edge segment on one side of the piece with the segment's ends, heights, the unit
 * direction inwards (towards the road) and how far along the open run it starts.
 */
function forEachOpenEdge(
  piece: RoadPiece,
  leftSide: boolean,
  paint: (i: number, a: Vec2, bEnd: Vec2, ya: number, yb: number, nx: number, nz: number, runStart: number) => void,
): void {
  const { path } = piece;
  const outline = leftSide ? piece.left : piece.right;
  const open = leftSide ? piece.leftOpen : piece.rightOpen;
  const spans = hazardSpans(open, path.length - 1);
  for (let k = 0; k < spans.length; k += 2) {
    let run = 0;
    for (let i = spans[k]; i < spans[k + 1]; i++) {
      if (i + 1 + piece.lead >= outline.length) break;
      const a = edgePoint(piece, i, leftSide);
      const e = edgePoint(piece, i + 1, leftSide);
      const dx = e.x - a.x;
      const dz = e.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-6) continue;
      // Inwards from the left edge is the road's right, (-dz, dx); from the right edge, its left (dz, -dx).
      const nx = (leftSide ? -dz : dz) / len;
      const nz = (leftSide ? dx : -dx) / len;
      paint(i, a, e, path[i].y, path[i + 1].y, nx, nz, run);
      run += len;
    }
  }
}

/** Amber stripes slanting in from the brink, a hot red line right on it and another along the side face. */
function addHazardPaint(b: GeometryBuilder, piece: RoadPiece): void {
  for (let side = 0; side < 2; side++) {
    const leftSide = side === 0;
    forEachOpenEdge(piece, leftSide, (i, a, e, ya, yb, nx, nz, runStart) => {
      b.section = pointSection[i];
      const dx = e.x - a.x;
      const dz = e.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const ux = dx / len;
      const uz = dz / len;
      const lift = Y_PAINT + 0.004;
      const at = (along: number, inward: number, out: { x: number; y: number; z: number }): void => {
        const t = Math.min(1, Math.max(0, along / len));
        out.x = a.x + ux * along + nx * inward;
        out.z = a.z + uz * along + nz * inward;
        // On the tarmac, which a bump beside the drop raises: the warning must never be buried under it.
        out.y = deckHeight(piece, out.x, out.z, ya + (yb - ya) * t) + lift;
      };
      // Pieces the brink line and the glow are cut into: one, or HAZARD_BUMP_STEP-long ones over a bump.
      const pieces = hazardPieces(piece, a, e, ya, yb, len);
      // Stripes on a fixed pitch along the whole open run, each a parallelogram leaning along the road.
      for (let k = Math.floor(runStart / HAZARD_PITCH); k * HAZARD_PITCH < runStart + len; k++) {
        const s0 = Math.max(0, k * HAZARD_PITCH - runStart);
        const s1 = Math.min(len, k * HAZARD_PITCH + HAZARD_STRIPE - runStart);
        if (s1 <= s0) continue;
        at(s0, HAZARD_OUTER, pa);
        at(s1, HAZARD_OUTER, pb);
        at(Math.min(len + HAZARD_SLANT, s1 + HAZARD_SLANT), HAZARD_INNER, pc);
        at(s0 + HAZARD_SLANT, HAZARD_INNER, pd);
        const v0 = b.vertex(pa.x, pa.y, pa.z, DECK.hazardStripe);
        const v1 = b.vertex(pb.x, pb.y, pb.z, DECK.hazardStripe);
        const v2 = b.vertex(pc.x, pc.y, pc.z, DECK.hazardStripe);
        const v3 = b.vertex(pd.x, pd.y, pd.z, DECK.hazardStripe);
        b.quad(v0, v1, v2, v3);
      }
      // The brink itself, following any bump.
      for (let k = 0; k < pieces; k++) {
        at((len * k) / pieces, HAZARD_LINE_INSET, pa);
        at((len * (k + 1)) / pieces, HAZARD_LINE_INSET, pb);
        b.line3(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, HAZARD_LINE_HALF, DECK.hazardEdge);
      }
      // Down the side face, just outside it.
      const ox = -nx * 0.02;
      const oz = -nz * 0.02;
      b.wall4(
        a.x + ox,
        a.z + oz,
        e.x + ox,
        e.z + oz,
        ya - HAZARD_SIDE_BOTTOM,
        yb - HAZARD_SIDE_BOTTOM,
        ya - HAZARD_SIDE_TOP,
        yb - HAZARD_SIDE_TOP,
        DECK.hazardEdge,
      );
    });
  }
}

const pa = { x: 0, y: 0, z: 0 };
const pb = { x: 0, y: 0, z: 0 };
const pc = { x: 0, y: 0, z: 0 };
const pd = { x: 0, y: 0, z: 0 };

/** How far the light curtain under a deck edge hangs towards the city floor, at most, m. */
const CURTAIN_DROP = 6;
/** Brightness of the curtain where it leaves the deck, as a share of the edge's accent colour. */
const CURTAIN_LIGHT = 0.2;
const CURTAIN_LIGHT_OPEN = 0.34;
const curtainLeft = ACCENTS[HUE.cyan].base.clone().multiplyScalar(CURTAIN_LIGHT);
const curtainRight = ACCENTS[HUE.magenta].base.clone().multiplyScalar(CURTAIN_LIGHT);
const curtainOpen = ACCENTS[HUE.hotPink].base.clone().multiplyScalar(CURTAIN_LIGHT_OPEN);

/**
 * A faint sheet of the edge's colour hanging under each deck edge and fading out towards the floor, red under an
 * open edge. From a camera that never moves this is what makes a raised road read as raised: the longer the
 * curtain below an edge, the higher the road. Additive, on the current stations.
 */
function addDeckCurtains(b: GeometryBuilder, piece: RoadPiece): void {
  for (let side = 0; side < 2; side++) {
    const leftSide = side === 0;
    const xs = leftSide ? stationLX : stationRX;
    const zs = leftSide ? stationLZ : stationRZ;
    for (let s = 0; s < stationCount - 1; s++) {
      const topA = stationY[s] - DECK_DEPTH;
      const topB = stationY[s + 1] - DECK_DEPTH;
      const dropA = Math.min(CURTAIN_DROP, topA - TERRAIN_Y);
      const dropB = Math.min(CURTAIN_DROP, topB - TERRAIN_Y);
      if (dropA <= 0.2 && dropB <= 0.2) continue;
      b.section = stationSection[s];
      const color = stretchOpen(piece, s, leftSide) ? curtainOpen : leftSide ? curtainLeft : curtainRight;
      const v0 = b.vertex(xs[s], topA, zs[s], color);
      const v1 = b.vertex(xs[s + 1], topB, zs[s + 1], color);
      const v2 = b.vertex(xs[s + 1], topB - Math.max(0, dropB), zs[s + 1], BLACK);
      const v3 = b.vertex(xs[s], topA - Math.max(0, dropA), zs[s], BLACK);
      b.quad(v0, v1, v2, v3);
    }
  }
}

/** A soft red light on the deck along every open edge, strongest at the brink. Additive. */
function addHazardGlow(b: GeometryBuilder, piece: RoadPiece): void {
  for (let side = 0; side < 2; side++) {
    forEachOpenEdge(piece, side === 0, (i, a, e, ya, yb, nx, nz) => {
      b.section = pointSection[i];
      const r = HAZARD_GLOW_REACH;
      const dx = e.x - a.x;
      const dz = e.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      // Cut into short pieces over a bump so the glow lies on the raised tarmac, not under it.
      const pieces = hazardPieces(piece, a, e, ya, yb, len);
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const x0 = a.x + dx * t0;
        const z0 = a.z + dz * t0;
        const x1 = a.x + dx * t1;
        const z1 = a.z + dz * t1;
        const y0 = ya + (yb - ya) * t0;
        const y1 = ya + (yb - ya) * t1;
        const v0 = b.vertex(x0, deckHeight(piece, x0, z0, y0) + Y_GLOW, z0, DECK.hazardGlow);
        const v1 = b.vertex(x1, deckHeight(piece, x1, z1, y1) + Y_GLOW, z1, DECK.hazardGlow);
        const v2 = b.vertex(x1 + nx * r, deckHeight(piece, x1 + nx * r, z1 + nz * r, y1) + Y_GLOW, z1 + nz * r, BLACK);
        const v3 = b.vertex(x0 + nx * r, deckHeight(piece, x0 + nx * r, z0 + nz * r, y0) + Y_GLOW, z0 + nz * r, BLACK);
        b.quad(v0, v1, v2, v3);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------------

export const WALL_HALF_THICK = 0.13;
/** Each wall box is slightly longer than its segment so neighbours close the gap at a bend. */
export const WALL_OVERLAP = 0.06;
/** A surface this much above the road's own counts as part of a bump, for the walls' warning colour. */
const RAISED_MIN = 0.02;

/** Cyan for the left road edge, magenta for the right, violet for the closed ends that run across the road. */
function wallTopColor(path: readonly PathPoint[], i: number, mx: number, mz: number, ux: number, uz: number): Color {
  if (path.length < 2) return ACCENTS[HUE.violet].glow;
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
 * Barrier walls, standing on the road surface (ya at a, yb at b) and reaching down to the bottom of the slab so
 * their outer face continues the deck's side. On a plain stretch a wall is one box. Where it crosses a bump it is
 * cut into short pieces whose tops follow the surface, always WALL_HEIGHT above it, and those tops turn amber.
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
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const near = path.length > 0 ? nearestPathIndex(path, mx, mz, (w.ya + w.yb) / 2) : 0;
    b.section = path.length > 0 ? pointSection[near] : 0;
    const top = wallTopColor(path, near, mx, mz, ux, uz);
    const ox = ux * WALL_OVERLAP;
    const oz = uz * WALL_OVERLAP;
    const slope = (w.yb - w.ya) / len;
    const ya = w.ya - slope * WALL_OVERLAP;
    const yb = w.yb + slope * WALL_OVERLAP;
    const step =
      groundCount > 0 ? stepNear(ground, groundCount, w.ax, w.az, w.bx, w.bz, WALL_HALF_THICK + 0.1, w.ya, w.yb) : 0;
    if (step === 0) {
      b.beam2(
        w.ax - ox,
        w.az - oz,
        w.bx + ox,
        w.bz + oz,
        WALL_HALF_THICK,
        ya - DECK_DEPTH,
        yb - DECK_DEPTH,
        ya + WALL_HEIGHT,
        yb + WALL_HEIGHT,
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
    let pBase = ya;
    let ph = bumpHeightAt(ground, groundCount, w.ax, w.az, w.ya);
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      const x = w.ax + dx * t;
      const z = w.az + dz * t;
      const base = w.ya + (w.yb - w.ya) * t;
      const h = bumpHeightAt(ground, groundCount, x, z, base);
      const last = k === pieces;
      const qx = last ? x + ox : x;
      const qz = last ? z + oz : z;
      const qBase = last ? yb : base;
      const raised = ph > RAISED_MIN || h > RAISED_MIN;
      b.beam2(
        px,
        pz,
        qx,
        qz,
        WALL_HALF_THICK,
        pBase - DECK_DEPTH,
        qBase - DECK_DEPTH,
        pBase + WALL_HEIGHT + ph,
        qBase + WALL_HEIGHT + h,
        k === 1,
        last,
        SURFACE.wall,
        raised ? warning : top,
      );
      px = qx;
      pz = qz;
      pBase = qBase;
      ph = h;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bump markings
// ---------------------------------------------------------------------------------------------------------------

/** Bump paint sits this far above the true surface: clear of the faceted tarmac, just under the skid marks. */
const BUMP_PAINT_Y = 0.035;
/** Half the width of the glowing line along the crest, measured along the road, m. */
const CREST_HALF = 0.24;
/** The crest line stops this far short of the road edge, leaving the edge strips alone. */
const CREST_MARGIN = 0.8;
const CREST_BRIGHTNESS = 1.15;
/** Contour rings up both faces of the bump: how many, how wide, how far they wobble and how bright they are. */
const CONTOUR_LEVELS = 4;
const CONTOUR_HALF = 0.11;
const CONTOUR_WOBBLE = 0.22;
const CONTOUR_SEGMENT = 0.7;
const CONTOUR_MARGIN = 0.7;
const CONTOUR_FOOT = 0.7;
const CONTOUR_TOP = 1.25;
/** The face the car lands on is marked too, but dimmer than the one it meets first. */
const CONTOUR_FAR_SIDE = 0.7;
/** Bump colours: violet at the foot, lime at the crest, and the light rising off it. */
const BUMP_FOOT = ACCENTS[HUE.violet].glow;
const BUMP_TOP = ACCENTS[HUE.lime].glow;
const BUMP_GLOW_COLOR = ACCENTS[HUE.lime].base;
const BUMP_GLOW = 0.8;
const contourColor = new Color();
/** Chevrons painted on the plain road before the bump, pointing at it. */
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
    const h = bump.y + (inside ? bump.height * 0.5 * (1 + Math.cos((Math.PI * u) / bump.halfLength)) : 0);
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

/** Height of a bump's own profile (without the road under it) at u along the road from its crest. */
function bumpProfile(bump: Bump, u: number): number {
  return Math.abs(u) < bump.halfLength ? bump.height * 0.5 * (1 + Math.cos((Math.PI * u) / bump.halfLength)) : 0;
}

/**
 * One wavy contour line across a bump at `u` along the road from its crest: a glowing ring at one height, like a
 * line on a contour map. It wobbles along its length (seeded by the bump, so every bump looks its own) and fades
 * out towards the road edges.
 */
function addContour(b: GeometryBuilder, bump: Bump, u: number, reach: number, color: Color, k: number, seed: number): void {
  const segments = Math.max(4, Math.ceil((2 * reach) / CONTOUR_SEGMENT));
  const rx = -bump.dirZ;
  const rz = bump.dirX;
  const limit = bump.halfLength - CONTOUR_HALF;
  const first = b.vertexCount;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const v = -reach + 2 * reach * t;
    const wobble =
      CONTOUR_WOBBLE * (Math.sin(v * 0.9 + seed) * 0.65 + Math.sin(v * 2.3 + seed * 1.7) * 0.35);
    let uc = u + wobble * (1 - Math.abs(u) / bump.halfLength);
    uc = Math.max(-limit, Math.min(limit, uc));
    // Brightest across the middle of the road, fading to nothing at the ends.
    const edge = 1 - Math.abs(2 * t - 1);
    const fade = k * Math.min(1, edge * 3.5);
    for (const du of [-CONTOUR_HALF, CONTOUR_HALF]) {
      const uu = uc + du;
      const h = bump.y + bumpProfile(bump, uu);
      b.vertex(bump.x + bump.dirX * uu + rx * v, BUMP_PAINT_Y + h, bump.z + bump.dirZ * uu + rz * v, color, fade);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = first + i * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
}

/**
 * Glowing contour rings up both faces of the bump, a bright line along its crest: the rings bunch up where the
 * bump is steep and run from violet at its foot to lime at the top, so its shape reads from above.
 */
function addBumpPaint(b: GeometryBuilder, bump: Bump, roadHalfWidth: number): void {
  const crest = roadHalfWidth - CREST_MARGIN;
  if (crest > 0.3) {
    addBumpStrip(b, bump, -CREST_HALF, CREST_HALF, -crest, crest, BUMP_TOP, CREST_BRIGHTNESS, CREST_BRIGHTNESS);
  }
  const reach = roadHalfWidth - CONTOUR_MARGIN;
  if (reach < 1) return;
  const seed = (bump.x * 0.37 + bump.z * 0.61) % 6.283;
  for (let j = 1; j <= CONTOUR_LEVELS; j++) {
    // Equal steps in height: where along the profile the bump reaches this level.
    const level = j / (CONTOUR_LEVELS + 1);
    const u = (bump.halfLength / Math.PI) * Math.acos(2 * level - 1);
    if (u - CONTOUR_HALF <= CREST_HALF + 0.05) continue;
    contourColor.copy(BUMP_FOOT).lerp(BUMP_TOP, level);
    const k = CONTOUR_FOOT + (CONTOUR_TOP - CONTOUR_FOOT) * level;
    addContour(b, bump, -u, reach, contourColor, k, seed + j * 1.3);
    addContour(b, bump, u, reach, contourColor, k * CONTOUR_FAR_SIDE, seed + j * 2.1 + 1);
  }
}

/** Light rising off a bump: strongest on the crest, nothing at its foot. Goes in the additive glow pass. */
function addBumpGlow(b: GeometryBuilder, bump: Bump, roadHalfWidth: number): void {
  const reach = roadHalfWidth - 0.3;
  if (reach < 1 || !(bump.height > 0)) return;
  const rows = Math.max(6, Math.ceil((2 * bump.halfLength) / bumpStep(bump)));
  const cols = 8;
  const rx = -bump.dirZ;
  const rz = bump.dirX;
  const first = b.vertexCount;
  for (let r = 0; r <= rows; r++) {
    const u = -bump.halfLength + (2 * bump.halfLength * r) / rows;
    const rise = bumpProfile(bump, u) / bump.height;
    const h = bump.y + bumpProfile(bump, u) + BUMP_PAINT_Y * 0.5;
    for (let c = 0; c <= cols; c++) {
      const across = (c / cols) * 2 - 1;
      const v = across * reach;
      const k = BUMP_GLOW * rise * rise * (1 - across * across);
      b.vertex(bump.x + bump.dirX * u + rx * v, h, bump.z + bump.dirZ * u + rz * v, BUMP_GLOW_COLOR, k);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = first + r * (cols + 1) + c;
      b.quad(a, a + 1, a + cols + 2, a + cols + 1);
    }
  }
}

/**
 * Chevrons on the plain road before the bump, pointing the way the car is going. They follow the centreline and
 * its slope, so they stay on the road through a bend or a climb. One that would fall before this piece's first
 * point is left out.
 */
function addChevrons(b: GeometryBuilder, piece: RoadPiece, bump: Bump, nearest: number): void {
  const { path, ground, groundCount } = piece;
  const at = path[nearest];
  const crestDist = at.dist + (bump.x - at.x) * bump.dirX + (bump.z - at.z) * bump.dirZ;
  const glow = BUMP_TOP;
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
    const grade = (q.y - p.y) / len;
    const x = p.x + dx * t;
    const z = p.z + dz * t;
    const y = p.y + (q.y - p.y) * t;
    const halfSpan = Math.min(CHEVRON_MAX_SPAN, p.halfWidth + (q.halfWidth - p.halfWidth) * t - CHEVRON_MARGIN);
    if (halfSpan < 0.8) continue;
    const depth = Math.min(1.9, halfSpan * 0.6);
    const tipX = x + fx * depth;
    const tipZ = z + fz * depth;
    const leftX = x - fx * depth + fz * halfSpan;
    const leftZ = z - fz * depth - fx * halfSpan;
    const rightX = x - fx * depth - fz * halfSpan;
    const rightZ = z - fz * depth + fx * halfSpan;
    // Plain paint only works on plain road: skip a chevron that would land on a bump.
    if (
      bumpHeightAt(ground, groundCount, tipX, tipZ, y) > 0 ||
      bumpHeightAt(ground, groundCount, leftX, leftZ, y) > 0 ||
      bumpHeightAt(ground, groundCount, rightX, rightZ, y) > 0
    ) {
      continue;
    }
    const tipY = y + grade * depth + Y_PAINT;
    const tailY = y - grade * depth + Y_PAINT;
    paintA.copy(glow).multiplyScalar(CHEVRON_BRIGHTNESS[c] ?? 0.4);
    // The arms fade towards their tails, which keeps the tip the brightest point: an arrowhead, not a bar.
    paintB.copy(paintA).multiplyScalar(0.55);
    b.line3(leftX, tailY, leftZ, tipX, tipY, tipZ, CHEVRON_HALF_WIDTH, paintB, paintA);
    b.line3(tipX, tipY, tipZ, rightX, tailY, rightZ, CHEVRON_HALF_WIDTH, paintA, paintB);
  }
}

function addBumpMarkings(b: GeometryBuilder, piece: RoadPiece): void {
  const { bumps, path } = piece;
  if (path.length < 2) return;
  for (let i = 0; i < bumps.length; i++) {
    const bump = bumps[i];
    if (!(bump.height > 0) || !(bump.halfLength > 0)) continue;
    const nearest = nearestPathIndex(path, bump.x, bump.z, bump.y);
    b.section = pointSection[nearest];
    addBumpPaint(b, bump, Math.min(path[nearest].halfWidth, bump.halfWidth));
    addChevrons(b, piece, bump, nearest);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars and supports
// ---------------------------------------------------------------------------------------------------------------

const PILLAR_SIDES = 20;
const SUPPORT_SIDES = 10;
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
/** A support's neon ring sits this far under the deck it holds, m. */
const SUPPORT_RING_BELOW = 0.9;
const SUPPORT_RING_HEIGHT = 0.28;
const SUPPORT_FOOT_LIGHT = 0.6;

// The circles every round part is built on, and the fake-light shade of each of their sides.
function circle(sides: number): { cos: Float64Array; sin: Float64Array; shade: Float64Array } {
  const cos = new Float64Array(sides + 1);
  const sin = new Float64Array(sides + 1);
  const shade = new Float64Array(sides);
  for (let k = 0; k <= sides; k++) {
    const angle = (k % sides) * ((Math.PI * 2) / sides);
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  for (let k = 0; k < sides; k++) {
    const mid = (k + 0.5) * ((Math.PI * 2) / sides);
    shade[k] = sideShade(Math.cos(mid), Math.sin(mid));
  }
  return { cos, sin, shade };
}
const PILLAR_CIRCLE = circle(PILLAR_SIDES);
const SUPPORT_CIRCLE = circle(SUPPORT_SIDES);

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
  shape = PILLAR_CIRCLE,
): void {
  const sides = shape.shade.length;
  for (let k = 0; k < sides; k++) {
    const shade = shaded ? shape.shade[k] : 1;
    const x0 = cx + shape.cos[k] * radius;
    const z0 = cz + shape.sin[k] * radius;
    const x1 = cx + shape.cos[k + 1] * radius;
    const z1 = cz + shape.sin[k + 1] * radius;
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
  const { cos, sin } = PILLAR_CIRCLE;
  for (let k = 0; k < PILLAR_SIDES; k++) {
    b.vertex(cx + cos[k] * r0, y, cz + sin[k] * r0, inner);
    b.vertex(cx + cos[k] * r1, y, cz + sin[k] * r1, outer);
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

/** Height of the surface a prop stands on: its road at `prop.y`, plus any bump there. */
function propBase(piece: RoadPiece, prop: Prop): number {
  const { ground, groundCount } = piece;
  return prop.y + (groundCount > 0 ? bumpHeightAt(ground, groundCount, prop.x, prop.z, prop.y) : 0);
}

/**
 * A pillar is the one thing on the road that ends a run, so it is built to be seen: a body lit in its accent
 * colour from the foot up, a glowing band round the rim of its cap, and two rings round the shaft.
 * `base` is the height of the surface it stands on.
 */
function addPillar(b: GeometryBuilder, prop: Prop, base: number): void {
  const accent = accentFor(prop.hue);
  const { x, z, radius } = prop;
  const height = base + prop.height;
  pillarTop.copy(SURFACE.pillar).lerp(accent.base, PILLAR_TINT);
  pillarFoot.copy(pillarTop).multiplyScalar(PILLAR_FOOT_LIGHT);
  pillarTop.multiplyScalar(PILLAR_TOP_LIGHT);
  addTube(b, x, z, radius, prop.y, height, pillarFoot, pillarTop, true);

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

const supportFoot = new Color();

/** A dark column from the city floor up to the underside of its deck, with a neon ring just under the deck. */
function addSupport(b: GeometryBuilder, support: Support): void {
  const { x, z, radius, top } = support;
  if (!(top > TERRAIN_Y) || !(radius > 0)) return;
  supportFoot.copy(DECK.support).multiplyScalar(SUPPORT_FOOT_LIGHT);
  addTube(b, x, z, radius, TERRAIN_Y, top, supportFoot, DECK.support, true, SUPPORT_CIRCLE);
  const ringTop = top - SUPPORT_RING_BELOW;
  if (ringTop - SUPPORT_RING_HEIGHT > TERRAIN_Y + 0.5) {
    addTube(b, x, z, radius + RING_GAP, ringTop - SUPPORT_RING_HEIGHT, ringTop, DECK.supportRing, DECK.supportRing, false, SUPPORT_CIRCLE);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shadows on the city floor
// ---------------------------------------------------------------------------------------------------------------

/** How far the soft edge of a deck's shadow spreads beyond the road, per metre of height above the floor. */
const SHADOW_SPREAD_BASE = 1.2;
const SHADOW_SPREAD_PER_M = 0.12;
/** Share of the half width that is fully dark. */
const SHADOW_CORE = 0.55;
/** Height above the floor at which a shadow has gone as pale as it gets, m. */
const SHADOW_FADE_HEIGHT = 24;
const shadowCore = new Color();
const WHITE = new Color(1, 1, 1);

/**
 * The deck's shadow straight down on the city floor: a dark band under the road that softens and pales the
 * higher the road runs. Drawn with the multiply material, so white leaves the floor as it is.
 */
export function addRoadShadow(b: GeometryBuilder, piece: RoadPiece): void {
  const { path } = piece;
  const n = path.length;
  if (n < 2) return;
  const y = TERRAIN_Y + Y_FLOOR_SHADOW;
  const first = b.vertexCount;
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const c = path[Math.min(n - 1, i + 1)];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const rx = -dz / len;
    const rz = dx / len;
    const height = Math.max(0, p.y - TERRAIN_Y);
    const pale = Math.min(1, height / SHADOW_FADE_HEIGHT);
    const core = FLOOR_SHADOW.nearCore + (FLOOR_SHADOW.farCore - FLOOR_SHADOW.nearCore) * pale;
    shadowCore.setRGB(core, core, core);
    const inner = p.halfWidth * SHADOW_CORE;
    const outer = p.halfWidth + SHADOW_SPREAD_BASE + SHADOW_SPREAD_PER_M * height;
    b.vertex(p.x - rx * outer, y, p.z - rz * outer, WHITE);
    b.vertex(p.x - rx * inner, y, p.z - rz * inner, shadowCore);
    b.vertex(p.x + rx * inner, y, p.z + rz * inner, shadowCore);
    b.vertex(p.x + rx * outer, y, p.z + rz * outer, WHITE);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = first + i * 4;
    for (let c = 0; c < 3; c++) b.quad(a + c, a + c + 1, a + c + 5, a + c + 4);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Decor: dark instanced boxes on the city floor, plus neon detail merged into the static mesh
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
  const y = TERRAIN_Y + block.h + 0.03;
  b.line(x0, z0, x1, z0, ROOF_HALF_WIDTH, y, color);
  b.line(x1, z0, x1, z1, ROOF_HALF_WIDTH, y, color);
  b.line(x1, z1, x0, z1, ROOF_HALF_WIDTH, y, color);
  b.line(x0, z1, x0, z0, ROOF_HALF_WIDTH, y, color);
}

/** Vertical light strips on the +X and +Z faces, the only two the locked camera can see. */
function addLightStrips(b: GeometryBuilder, block: DecorBlock, index: number, color: Color): void {
  if (hash01(index * 7 + 1) > STRIP_CHANCE || block.w < 2 || block.d < 2) return;
  const count = 1 + Math.floor(hash01(index * 7 + 2) * 3);
  const y0 = TERRAIN_Y + block.h * 0.12;
  const y1 = TERRAIN_Y + block.h * 0.92;
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
  b.section = 0;
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
 * The piece's city blocks as one instanced mesh standing on the city floor at (originX, originZ), or null when it
 * has none. The geometry and material are the shared ones: disposing the mesh frees only its own instance buffers.
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
  mesh.position.set(originX, TERRAIN_Y, originZ);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------------------------------------------

/**
 * Appends everything opaque in the piece to `b` (which should have `trackSections` on): the deck and its paint,
 * hazard paint on open edges, walls, pillars, supports, the neon detail on the city blocks and, where there are
 * bumps, their warning paint.
 */
export function addRoadPiece(b: GeometryBuilder, piece: RoadPiece): void {
  fillPointSections(piece);
  nearestHint = 0;
  buildStations(piece);
  addRoadSurface(b, piece);
  addDeckSides(b);
  addCentreLine(b, piece);
  addEdgeStrip(b, piece, true, ACCENTS[HUE.cyan].glow);
  addEdgeStrip(b, piece, false, ACCENTS[HUE.magenta].glow);
  addHazardPaint(b, piece);
  addWalls(b, piece);
  const { props, supports } = piece;
  for (let i = 0; i < props.length; i++) {
    b.section = sectionAt(piece, props[i].x, props[i].z, props[i].y);
    addPillar(b, props[i], propBase(piece, props[i]));
  }
  for (let i = 0; i < supports.length; i++) {
    b.section = sectionAt(piece, supports[i].x, supports[i].z, supports[i].top + DECK_DEPTH);
    addSupport(b, supports[i]);
  }
  addDecorAccents(b, piece);
  if (piece.bumps.length > 0) addBumpMarkings(b, piece);
  b.section = 0;
}

/**
 * Appends the piece's additive light (pools round its pillars, red glow along open edges, the light curtains under
 * its edges) to `b`.
 */
export function addRoadPieceGlow(b: GeometryBuilder, piece: RoadPiece): void {
  fillPointSections(piece);
  nearestHint = 0;
  buildStations(piece);
  addDeckCurtains(b, piece);
  const { props } = piece;
  for (let i = 0; i < props.length; i++) {
    b.section = sectionAt(piece, props[i].x, props[i].z, props[i].y);
    addPillarGlow(b, props[i], propBase(piece, props[i]));
  }
  addHazardGlow(b, piece);
  const { bumps, path } = piece;
  if (path.length >= 2) {
    for (let i = 0; i < bumps.length; i++) {
      const bump = bumps[i];
      if (!(bump.height > 0) || !(bump.halfLength > 0)) continue;
      const nearest = nearestPathIndex(path, bump.x, bump.z, bump.y);
      b.section = pointSection[nearest];
      addBumpGlow(b, bump, Math.min(path[nearest].halfWidth, bump.halfWidth));
    }
  }
  b.section = 0;
}
