import { Color, DynamicDrawUsage, Group, Mesh } from 'three';
import type { BoxGeometry, BufferAttribute, BufferGeometry, InstancedMesh, MeshBasicMaterial } from 'three';
import { TERRAIN_Y } from '../types';
import type { Gate, Level, Pose, RunState, Vec2 } from '../types';
import { GeometryBuilder } from './geometry';
import { blockSet } from './occlusion';
import type { BlockSet, DeckSections } from './occlusion';
import { GATE, SURFACE } from './palette';
import {
  Y_PAINT,
  addRoadPiece,
  addRoadPieceGlow,
  addRoadShadow,
  allocateSections,
  buildDecorMesh,
  closedEndCorner,
} from './roadPiece';
import type { RoadPiece, TrackShared } from './roadPiece';
import { PathIndex } from './surface';

// Kept for the modules that grew up importing the builder from here.
export { GeometryBuilder, builderMaterial } from './geometry';

// The city floor, far below every road. The road, its glow and its paint are in roadPiece.ts (0.01 to 0.03 above
// the road surface); skid marks sit at 0.04 above it (see skid.ts); deck shadows at TERRAIN_Y + 0.03.
export const Y_GROUND = TERRAIN_Y - 0.02;
export const Y_GRID = TERRAIN_Y;
/** Gate bars, above the road surface. */
const Y_GATE = 0.06;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------------------------
// Ground and grid
// ---------------------------------------------------------------------------------------------------------------

const GROUND_MARGIN = 400;
export const GRID_CELL = 12;
const GRID_MARGIN = 96;
const GRID_FADE_M = 90;
export const GRID_HALF_WIDTH = 0.08;
/** The grid only needs a rough distance to the road, so every third path point is enough. */
const GRID_PATH_STRIDE = 3;

function addGround(b: GeometryBuilder, level: Level): void {
  const { minX, minZ, maxX, maxZ } = level.bounds;
  const m = GROUND_MARGIN;
  const v0 = b.vertex(minX - m, Y_GROUND, minZ - m, SURFACE.ground);
  const v1 = b.vertex(maxX + m, Y_GROUND, minZ - m, SURFACE.ground);
  const v2 = b.vertex(maxX + m, Y_GROUND, maxZ + m, SURFACE.ground);
  const v3 = b.vertex(minX - m, Y_GROUND, maxZ + m, SURFACE.ground);
  b.quad(v0, v1, v2, v3);
}

function distanceToRoad(level: Level, x: number, z: number): number {
  const path = level.path;
  let best = Infinity;
  for (let i = 0; i < path.length; i += GRID_PATH_STRIDE) {
    const p = path[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz) - p.halfWidth;
    if (d < best) best = d;
  }
  return best;
}

function addGrid(b: GeometryBuilder, level: Level): void {
  const { minX, minZ, maxX, maxZ } = level.bounds;
  const x0 = Math.floor((minX - GRID_MARGIN) / GRID_CELL) * GRID_CELL;
  const z0 = Math.floor((minZ - GRID_MARGIN) / GRID_CELL) * GRID_CELL;
  const nx = Math.ceil((maxX + GRID_MARGIN - x0) / GRID_CELL);
  const nz = Math.ceil((maxZ + GRID_MARGIN - z0) / GRID_CELL);
  const row = nx + 1;

  const fade = new Float32Array(row * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const d = distanceToRoad(level, x0 + i * GRID_CELL, z0 + j * GRID_CELL);
      fade[j * row + i] = 1 - smoothstep(0, GRID_FADE_M, d);
    }
  }

  const colorA = new Color();
  const colorB = new Color();
  const segment = (ax: number, az: number, bx: number, bz: number, fa: number, fb: number): void => {
    if (fa < 0.02 && fb < 0.02) return;
    colorA.copy(SURFACE.ground).lerp(SURFACE.grid, fa);
    colorB.copy(SURFACE.ground).lerp(SURFACE.grid, fb);
    b.line(ax, az, bx, bz, GRID_HALF_WIDTH, Y_GRID, colorA, colorB);
  };

  for (let j = 0; j <= nz; j++) {
    const z = z0 + j * GRID_CELL;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * GRID_CELL;
      segment(x, z, x + GRID_CELL, z, fade[j * row + i], fade[j * row + i + 1]);
    }
  }
  for (let i = 0; i <= nx; i++) {
    const x = x0 + i * GRID_CELL;
    for (let j = 0; j < nz; j++) {
      const z = z0 + j * GRID_CELL;
      segment(x, z, x, z + GRID_CELL, fade[j * row + i], fade[(j + 1) * row + i]);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tarmac outline
// ---------------------------------------------------------------------------------------------------------------

/** Everything that is tarmac: the road from start pose to goal line, plus the walled ends beyond both. */
interface RoadOutline {
  left: Vec2[];
  right: Vec2[];
  heights: number[];
  /** Outline points added before path[0]. */
  lead: number;
  /** How far the walled ends reach past the first and the last path point, m. */
  runStart: number;
  runEnd: number;
}

/**
 * `level.left` and `level.right` stop at the start pose and at the goal line, but the walls close the road some
 * way behind the start and a long way beyond the goal (the run-off). Those ends are found from the walls and
 * added here, so the surface and its edge strips reach every wall the car can.
 */
function roadOutline(level: Level): RoadOutline {
  const outline: RoadOutline = {
    left: level.left.slice(),
    right: level.right.slice(),
    heights: level.path.map((p) => p.y),
    lead: 0,
    runStart: 0,
    runEnd: 0,
  };
  const n = level.path.length;
  if (n < 2) return outline;
  const extend = (index: number, neighbour: number, atStart: boolean): void => {
    const l = closedEndCorner(level.walls, level.left[index], level.left[neighbour]);
    const r = closedEndCorner(level.walls, level.right[index], level.right[neighbour]);
    if (!l || !r) return;
    const y = level.path[index].y;
    const reach = Math.hypot((l.x + r.x) / 2 - level.path[index].x, (l.z + r.z) / 2 - level.path[index].z);
    if (atStart) {
      outline.left.unshift(l);
      outline.right.unshift(r);
      outline.heights.unshift(y);
      outline.lead = 1;
      outline.runStart = reach;
    } else {
      outline.left.push(l);
      outline.right.push(r);
      outline.heights.push(y);
      outline.runEnd = reach;
    }
  };
  extend(0, 1, true);
  extend(n - 1, n - 2, false);
  return outline;
}

// ---------------------------------------------------------------------------------------------------------------
// Start marking and gates
// ---------------------------------------------------------------------------------------------------------------

const START_HALF_LENGTH = 3.4;
const START_HALF_WIDTH = 1.9;
const START_LINE_HALF_WIDTH = 0.07;

/** Surface height of the level's road at (x, z), for a point near the height `y`. */
function roadY(index: PathIndex, x: number, z: number, y: number): number {
  const h = index.surfaceAt(x, z, y + 1.5);
  return h === -Infinity ? y : h;
}

function addStartMarking(b: GeometryBuilder, start: Pose, index: PathIndex): void {
  const fx = Math.cos(start.heading);
  const fz = Math.sin(start.heading);
  const rx = -fz;
  const rz = fx;
  const y = start.y ?? 0;
  // (s, t) = metres ahead of and to the right of the start pose.
  const mark = (s0: number, t0: number, s1: number, t1: number): void => {
    const ax = start.x + fx * s0 + rx * t0;
    const az = start.z + fz * s0 + rz * t0;
    const bx = start.x + fx * s1 + rx * t1;
    const bz = start.z + fz * s1 + rz * t1;
    b.line3(
      ax,
      roadY(index, ax, az, y) + Y_PAINT,
      az,
      bx,
      roadY(index, bx, bz, y) + Y_PAINT,
      bz,
      START_LINE_HALF_WIDTH,
      SURFACE.startMark,
    );
  };
  const l = START_HALF_LENGTH;
  const w = START_HALF_WIDTH;
  mark(-l, -w, l, -w);
  mark(-l, w, l, w);
  for (let k = 0; k <= 3; k++) {
    const s = -l + (k * 2 * l) / 3;
    mark(s, -w, s, w);
  }
}

const POST_HEIGHT = 1.5;
const POST_HALF = 0.2;
const CHECKPOINT_HALF_WIDTH = 0.35;
const GOAL_HALF_WIDTH = 0.3;
const GOAL_BAR_OFFSET = 0.45;

const GATE_PASSED = 0.1;
const GATE_AHEAD = 0.5;
const GOAL_AHEAD = 0.7;
const GATE_STEADY = 1.3;
const GATE_PULSE_BASE = 1.15;
const GATE_PULSE_DEPTH = 0.55;
const GATE_PULSE_RATE = 7;

/** A run of vertices in the gate mesh that always shares one colour. */
interface GatePart {
  start: number;
  count: number;
  color: Color;
  /** Checkpoint index, or checkpoints.length for the goal. */
  gate: number;
}

function addGatePosts(b: GeometryBuilder, gate: Gate): void {
  const y = gate.y;
  b.box(gate.ax, gate.az, 1, 0, POST_HALF, POST_HALF, y, y + POST_HEIGHT, SURFACE.post, SURFACE.post);
  b.box(gate.bx, gate.bz, 1, 0, POST_HALF, POST_HALF, y, y + POST_HEIGHT, SURFACE.post, SURFACE.post);
}

/** Light bar on the road across the gate, shifted `offset` metres along the road (and up or down its slope). */
function addGateBar(b: GeometryBuilder, gate: Gate, offset: number, halfWidth: number, color: Color, index: PathIndex): void {
  const dx = gate.bx - gate.ax;
  const dz = gate.bz - gate.az;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const ox = (-dz / len) * offset;
  const oz = (dx / len) * offset;
  const mx = (gate.ax + gate.bx) / 2 + ox;
  const mz = (gate.az + gate.bz) / 2 + oz;
  const y = roadY(index, mx, mz, gate.y) + Y_GATE;
  b.line3(gate.ax + ox, y, gate.az + oz, gate.bx + ox, y, gate.bz + oz, halfWidth, color);
}

function addPostCaps(b: GeometryBuilder, gate: Gate, color: Color): void {
  const y = gate.y + POST_HEIGHT + 0.02;
  b.line(gate.ax - POST_HALF, gate.az, gate.ax + POST_HALF, gate.az, POST_HALF, y, color);
  b.line(gate.bx - POST_HALF, gate.bz, gate.bx + POST_HALF, gate.bz, POST_HALF, y, color);
}

function buildGateParts(b: GeometryBuilder, level: Level, index: PathIndex): GatePart[] {
  const parts: GatePart[] = [];
  const part = (gate: number, color: Color, add: () => void): void => {
    const start = b.vertexCount;
    add();
    parts.push({ start, count: b.vertexCount - start, color, gate });
  };
  level.checkpoints.forEach((gate, i) => {
    part(i, GATE.checkpoint, () => {
      addGateBar(b, gate, 0, CHECKPOINT_HALF_WIDTH, GATE.checkpoint, index);
      addPostCaps(b, gate, GATE.checkpoint);
    });
  });
  const goalIndex = level.checkpoints.length;
  part(goalIndex, GATE.goalWhite, () => {
    addGateBar(b, level.goal, -GOAL_BAR_OFFSET, GOAL_HALF_WIDTH, GATE.goalWhite, index);
    addPostCaps(b, level.goal, GATE.goalWhite);
  });
  part(goalIndex, GATE.goalGreen, () => {
    addGateBar(b, level.goal, GOAL_BAR_OFFSET, GOAL_HALF_WIDTH, GATE.goalGreen, index);
  });
  return parts;
}

function gateBrightness(gate: number, goalIndex: number, run: RunState, time: number, steady: boolean): number {
  if (run.phase === 'finished') return gate === goalIndex ? GATE_STEADY : GATE_PASSED;
  if (gate < run.nextCheckpoint) return GATE_PASSED;
  if (gate > run.nextCheckpoint) return gate === goalIndex ? GOAL_AHEAD : GATE_AHEAD;
  return steady ? GATE_STEADY : GATE_PULSE_BASE + GATE_PULSE_DEPTH * Math.sin(time * GATE_PULSE_RATE);
}

// ---------------------------------------------------------------------------------------------------------------
// Level visual
// ---------------------------------------------------------------------------------------------------------------

export interface LevelVisual {
  readonly group: Group;
  /** The level's road, indexed for height queries (also registered with the shared surface). */
  readonly index: PathIndex;
  /** Recolours the gates: passed ones dim, the next one pulsing (steady when `reducedFlash`). */
  update(run: RunState, time: number, reducedFlash: boolean): void;
  /** Frees the level's own geometry and its section ids. The shared materials stay with whoever made them. */
  dispose(): void;
}

/** Key the level's road is registered under in the shared surface (chunks use their index, >= 0). */
export const LEVEL_SURFACE_KEY = -1;

/** The whole level as one road piece: its tarmac is the outline extended to the walled ends. */
function levelPiece(level: Level, outline: RoadOutline, sections: DeckSections): RoadPiece {
  return {
    path: level.path,
    left: outline.left,
    right: outline.right,
    heights: outline.heights,
    lead: outline.lead,
    leftOpen: level.leftOpen,
    rightOpen: level.rightOpen,
    walls: level.walls,
    props: level.props,
    supports: level.supports,
    decor: level.decor,
    bumps: level.bumps,
    ground: level.bumps,
    groundCount: level.bumps.length,
    overlap: 0,
    variation: 0,
    sectionBase: sections.base,
    sectionStarts: sections.starts,
  };
}

function buildStaticGeometry(level: Level, piece: RoadPiece, index: PathIndex): BufferGeometry {
  const b = new GeometryBuilder(32768);
  b.trackSections = true;
  addGround(b, level);
  addGrid(b, level);
  addRoadPiece(b, piece);
  addStartMarking(b, level.start, index);
  for (const gate of level.checkpoints) addGatePosts(b, gate);
  addGatePosts(b, level.goal);
  return b.build();
}

class LevelMeshes implements LevelVisual {
  readonly group = new Group();
  readonly index: PathIndex;
  private readonly staticMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly gateMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly glowMesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  private readonly shadowMesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  private readonly decor: InstancedMesh<BoxGeometry, MeshBasicMaterial> | null;
  private readonly blocks: BlockSet | null = null;
  private readonly sections: DeckSections;
  private readonly gateParts: GatePart[];
  private readonly gateColors: BufferAttribute;
  private readonly goalIndex: number;

  constructor(
    level: Level,
    private readonly shared: TrackShared,
  ) {
    const outline = roadOutline(level);
    this.index = new PathIndex(level.path, outline.runStart, outline.runEnd);
    this.sections = allocateSections(level.path, shared.sections);
    const piece = levelPiece(level, outline, this.sections);
    this.staticMesh = new Mesh(buildStaticGeometry(level, piece, this.index), shared.deck);
    this.staticMesh.frustumCulled = false;

    const gates = new GeometryBuilder();
    this.gateParts = buildGateParts(gates, level, this.index);
    this.goalIndex = level.checkpoints.length;
    this.gateMesh = new Mesh(gates.build(), shared.solid);
    this.gateMesh.frustumCulled = false;
    this.gateColors = this.gateMesh.geometry.getAttribute('color') as BufferAttribute;
    this.gateColors.setUsage(DynamicDrawUsage);

    const glow = new GeometryBuilder();
    glow.trackSections = true;
    addRoadPieceGlow(glow, piece);
    if (glow.vertexCount > 0) {
      this.glowMesh = new Mesh(glow.build(), shared.deckGlow);
      this.glowMesh.frustumCulled = false;
      this.glowMesh.renderOrder = 1;
      this.group.add(this.glowMesh);
    }

    const shadow = new GeometryBuilder(4096);
    addRoadShadow(shadow, piece);
    if (shadow.vertexCount > 0) {
      this.shadowMesh = new Mesh(shadow.build(), shared.shadow);
      this.shadowMesh.frustumCulled = false;
      this.shadowMesh.renderOrder = -1;
      this.group.add(this.shadowMesh);
    }

    this.decor = buildDecorMesh(level.decor, shared);
    this.group.add(this.staticMesh, this.gateMesh);
    if (this.decor) {
      this.decor.frustumCulled = false;
      this.group.add(this.decor);
      this.blocks = blockSet(level.decor, this.decor);
      shared.sinker.add(this.blocks);
    }
    shared.fader.add(this.sections);
    shared.surface.add(LEVEL_SURFACE_KEY, this.index, level.bumps);
  }

  update(run: RunState, time: number, reducedFlash: boolean): void {
    const colors = this.gateColors.array;
    const parts = this.gateParts;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const k = gateBrightness(part.gate, this.goalIndex, run, time, reducedFlash);
      const r = part.color.r * k;
      const g = part.color.g * k;
      const b = part.color.b * k;
      const end = (part.start + part.count) * 3;
      for (let o = part.start * 3; o < end; o += 3) {
        colors[o] = r;
        colors[o + 1] = g;
        colors[o + 2] = b;
      }
    }
    this.gateColors.needsUpdate = true;
  }

  dispose(): void {
    const shared = this.shared;
    this.group.removeFromParent();
    this.staticMesh.geometry.dispose();
    this.gateMesh.geometry.dispose();
    this.glowMesh?.geometry.dispose();
    this.shadowMesh?.geometry.dispose();
    // Not its geometry or material: those are the shared ones.
    this.decor?.dispose();
    if (this.blocks) shared.sinker.remove(this.blocks);
    shared.fader.remove(this.sections);
    shared.sections.free(this.sections.base, this.sections.starts.length - 1);
    shared.surface.remove(LEVEL_SURFACE_KEY);
  }
}

/** `shared` supplies the materials and registries; they are not disposed with the level. */
export function buildLevelVisual(level: Level, shared: TrackShared): LevelVisual {
  return new LevelMeshes(level, shared);
}
