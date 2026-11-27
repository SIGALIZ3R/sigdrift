import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { BufferAttribute } from 'three';
import type { DecorBlock, Gate, Level, Pose, Prop, RunState, Vec2 } from '../types';
import { ACCENTS, GATE, HUE, SURFACE, accentFor } from './palette';

// Heights of the flat layers, kept well apart so they never z-fight. Skid marks sit at 0.04 (see skid.ts).
const Y_GROUND = -0.06;
const Y_GRID = -0.04;
const Y_ROAD = 0.01;
const Y_PAINT = 0.03;
const Y_GATE = 0.06;

// Unlit surfaces get a baked shade from a fixed fake light on the camera's side, so the two visible faces of a
// box read as different planes.
const LIGHT_X = 0.9;
const LIGHT_Z = 0.44;

function sideShade(nx: number, nz: number): number {
  return 0.42 + 0.58 * Math.max(0, nx * LIGHT_X + nz * LIGHT_Z);
}

/** Collects coloured triangles from many small parts into one BufferGeometry (one draw call). */
export class GeometryBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, color: Color, k = 1): number {
    this.positions.push(x, y, z);
    this.colors.push(color.r * k, color.g * k, color.b * k);
    return this.positions.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /** Flat line on the plane `y` from a to b. `colorB` lets the line fade along its length. */
  line(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfWidth: number,
    y: number,
    colorA: Color,
    colorB: Color = colorA,
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return;
    const px = (-dz / len) * halfWidth;
    const pz = (dx / len) * halfWidth;
    const v0 = this.vertex(ax - px, y, az - pz, colorA);
    const v1 = this.vertex(bx - px, y, bz - pz, colorB);
    const v2 = this.vertex(bx + px, y, bz + pz, colorB);
    const v3 = this.vertex(ax + px, y, az + pz, colorA);
    this.quad(v0, v1, v2, v3);
  }

  /** Vertical quad standing on the ground line a-b. */
  upright(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, color: Color, k = 1): void {
    const v0 = this.vertex(ax, y0, az, color, k);
    const v1 = this.vertex(bx, y0, bz, color, k);
    const v2 = this.vertex(bx, y1, bz, color, k);
    const v3 = this.vertex(ax, y1, az, color, k);
    this.quad(v0, v1, v2, v3);
  }

  /** Upright box centred on (cx, cz) with its long axis along the unit vector (ux, uz). Sides are shaded. */
  box(
    cx: number,
    cz: number,
    ux: number,
    uz: number,
    halfLen: number,
    halfThick: number,
    y0: number,
    y1: number,
    side: Color,
    top: Color,
  ): void {
    const nx = -uz;
    const nz = ux;
    const ex = ux * halfLen;
    const ez = uz * halfLen;
    const tx = nx * halfThick;
    const tz = nz * halfThick;
    const x0 = cx - ex - tx;
    const z0 = cz - ez - tz;
    const x1 = cx + ex - tx;
    const z1 = cz + ez - tz;
    const x2 = cx + ex + tx;
    const z2 = cz + ez + tz;
    const x3 = cx - ex + tx;
    const z3 = cz - ez + tz;
    this.upright(x0, z0, x1, z1, y0, y1, side, sideShade(-nx, -nz));
    this.upright(x1, z1, x2, z2, y0, y1, side, sideShade(ux, uz));
    this.upright(x2, z2, x3, z3, y0, y1, side, sideShade(nx, nz));
    this.upright(x3, z3, x0, z0, y0, y1, side, sideShade(-ux, -uz));
    const a = this.vertex(x0, y1, z0, top);
    const b = this.vertex(x1, y1, z1, top);
    const c = this.vertex(x2, y1, z2, top);
    const d = this.vertex(x3, y1, z3, top);
    this.quad(a, b, c, d);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    return geometry;
  }
}

/** Material for anything made with GeometryBuilder: unlit, vertex coloured, winding-agnostic. */
export function builderMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
}

// Cosmetic variation that must look the same on every load of the same level, hence no Math.random.
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------------------------
// Ground and grid
// ---------------------------------------------------------------------------------------------------------------

const GROUND_MARGIN = 400;
const GRID_CELL = 12;
const GRID_MARGIN = 96;
const GRID_FADE_M = 90;
const GRID_HALF_WIDTH = 0.08;
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
// Road
// ---------------------------------------------------------------------------------------------------------------

const DASH_PERIOD = 9;
const DASH_LENGTH = 3;
const DASH_HALF_WIDTH = 0.09;
const EDGE_INSET = 0.45;
const EDGE_WIDTH = 0.26;

function addRoad(b: GeometryBuilder, level: Level): void {
  const n = level.path.length;
  const first = b.vertexCount;
  for (let i = 0; i < n; i++) {
    b.vertex(level.left[i].x, Y_ROAD, level.left[i].z, SURFACE.road);
    b.vertex(level.right[i].x, Y_ROAD, level.right[i].z, SURFACE.road);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = first + i * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
}

function addCentreLine(b: GeometryBuilder, level: Level): void {
  const path = level.path;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    const q = path[i + 1];
    const span = q.dist - p.dist;
    if (span <= 0) continue;
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

/** Neon strip just inside one road edge, following the edge polyline. */
function addEdgeStrip(b: GeometryBuilder, level: Level, edge: Vec2[], color: Color): void {
  const n = level.path.length;
  const first = b.vertexCount;
  for (let i = 0; i < n; i++) {
    const e = edge[i];
    const dx = level.path[i].x - e.x;
    const dz = level.path[i].z - e.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    b.vertex(e.x + ux * EDGE_INSET, Y_PAINT, e.z + uz * EDGE_INSET, color);
    b.vertex(e.x + ux * (EDGE_INSET + EDGE_WIDTH), Y_PAINT, e.z + uz * (EDGE_INSET + EDGE_WIDTH), color);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = first + i * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------------

const WALL_HEIGHT = 0.7;
const WALL_HALF_THICK = 0.13;
/** Each wall box is slightly longer than its segment so neighbours close the gap at a bend. */
const WALL_OVERLAP = 0.06;

function nearestPathIndex(level: Level, x: number, z: number): number {
  const path = level.path;
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

/** Cyan for the left road edge, magenta for the right, violet for the closed ends that run across the road. */
function wallTopColor(level: Level, mx: number, mz: number, ux: number, uz: number): Color {
  const path = level.path;
  const i = nearestPathIndex(level, mx, mz);
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

function addWalls(b: GeometryBuilder, level: Level): void {
  for (const w of level.walls) {
    const dx = w.bx - w.ax;
    const dz = w.bz - w.az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const top = wallTopColor(level, mx, mz, ux, uz);
    b.box(mx, mz, ux, uz, len / 2 + WALL_OVERLAP, WALL_HALF_THICK, 0, WALL_HEIGHT, SURFACE.wall, top);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------------------------------------------

const PILLAR_SIDES = 14;
const RING_HEIGHT = 0.18;
const RING_GAP = 0.06;

function addTube(
  b: GeometryBuilder,
  cx: number,
  cz: number,
  radius: number,
  y0: number,
  y1: number,
  color: Color,
  shaded: boolean,
): void {
  const step = (Math.PI * 2) / PILLAR_SIDES;
  for (let k = 0; k < PILLAR_SIDES; k++) {
    const a0 = k * step;
    const a1 = a0 + step;
    const mid = a0 + step / 2;
    const shade = shaded ? sideShade(Math.cos(mid), Math.sin(mid)) : 1;
    b.upright(
      cx + Math.cos(a0) * radius,
      cz + Math.sin(a0) * radius,
      cx + Math.cos(a1) * radius,
      cz + Math.sin(a1) * radius,
      y0,
      y1,
      color,
      shade,
    );
  }
}

function addDisc(b: GeometryBuilder, cx: number, cz: number, radius: number, y: number, color: Color): void {
  const step = (Math.PI * 2) / PILLAR_SIDES;
  const centre = b.vertex(cx, y, cz, color);
  const first = b.vertexCount;
  for (let k = 0; k < PILLAR_SIDES; k++) {
    b.vertex(cx + Math.cos(k * step) * radius, y, cz + Math.sin(k * step) * radius, color);
  }
  for (let k = 0; k < PILLAR_SIDES; k++) {
    b.triangle(centre, first + k, first + ((k + 1) % PILLAR_SIDES));
  }
}

function addPillar(b: GeometryBuilder, prop: Prop): void {
  const glow = accentFor(prop.hue).glow;
  addTube(b, prop.x, prop.z, prop.radius, 0, prop.height, SURFACE.pillar, true);
  addDisc(b, prop.x, prop.z, prop.radius, prop.height, SURFACE.pillar);
  const ringRadius = prop.radius + RING_GAP;
  const low = Math.max(0.1, prop.height * 0.3);
  const high = Math.max(low + RING_HEIGHT + 0.1, prop.height - 0.3 - RING_HEIGHT);
  addTube(b, prop.x, prop.z, ringRadius, low, low + RING_HEIGHT, glow, false);
  addTube(b, prop.x, prop.z, ringRadius, high, high + RING_HEIGHT, glow, false);
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

function addDecorAccents(b: GeometryBuilder, level: Level): void {
  const roof = new Color();
  const strip = new Color();
  level.decor.forEach((block, index) => {
    const glow = accentFor(block.hue).glow;
    addRoofOutline(b, block, roof.copy(glow).multiplyScalar(ROOF_GLOW));
    addLightStrips(b, block, index, strip.copy(glow).multiplyScalar(STRIP_GLOW));
  });
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

function buildDecor(level: Level): InstancedMesh | null {
  const count = level.decor.length;
  if (count === 0) return null;
  const mesh = new InstancedMesh(decorBoxGeometry(), new MeshBasicMaterial({ vertexColors: true }), count);
  const matrix = new Matrix4();
  const tint = new Color();
  level.decor.forEach((block, i) => {
    matrix.makeScale(block.w, block.h, block.d).setPosition(block.x, 0, block.z);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, tint.copy(SURFACE.decor).lerp(accentFor(block.hue).base, 0.07));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// Start marking and gates
// ---------------------------------------------------------------------------------------------------------------

const START_HALF_LENGTH = 3.4;
const START_HALF_WIDTH = 1.9;
const START_LINE_HALF_WIDTH = 0.07;

function addStartMarking(b: GeometryBuilder, start: Pose): void {
  const fx = Math.cos(start.heading);
  const fz = Math.sin(start.heading);
  const rx = -fz;
  const rz = fx;
  // (s, t) = metres ahead of and to the right of the start pose.
  const mark = (s0: number, t0: number, s1: number, t1: number): void => {
    b.line(
      start.x + fx * s0 + rx * t0,
      start.z + fz * s0 + rz * t0,
      start.x + fx * s1 + rx * t1,
      start.z + fz * s1 + rz * t1,
      START_LINE_HALF_WIDTH,
      Y_PAINT,
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
  b.box(gate.ax, gate.az, 1, 0, POST_HALF, POST_HALF, 0, POST_HEIGHT, SURFACE.post, SURFACE.post);
  b.box(gate.bx, gate.bz, 1, 0, POST_HALF, POST_HALF, 0, POST_HEIGHT, SURFACE.post, SURFACE.post);
}

/** Light bar on the road across the gate, shifted `offset` metres along the road. */
function addGateBar(b: GeometryBuilder, gate: Gate, offset: number, halfWidth: number, color: Color): void {
  const dx = gate.bx - gate.ax;
  const dz = gate.bz - gate.az;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const ox = (-dz / len) * offset;
  const oz = (dx / len) * offset;
  b.line(gate.ax + ox, gate.az + oz, gate.bx + ox, gate.bz + oz, halfWidth, Y_GATE, color);
}

function addPostCaps(b: GeometryBuilder, gate: Gate, color: Color): void {
  const y = POST_HEIGHT + 0.02;
  b.line(gate.ax - POST_HALF, gate.az, gate.ax + POST_HALF, gate.az, POST_HALF, y, color);
  b.line(gate.bx - POST_HALF, gate.bz, gate.bx + POST_HALF, gate.bz, POST_HALF, y, color);
}

function buildGateParts(b: GeometryBuilder, level: Level): GatePart[] {
  const parts: GatePart[] = [];
  const part = (gate: number, color: Color, add: () => void): void => {
    const start = b.vertexCount;
    add();
    parts.push({ start, count: b.vertexCount - start, color, gate });
  };
  level.checkpoints.forEach((gate, i) => {
    part(i, GATE.checkpoint, () => {
      addGateBar(b, gate, 0, CHECKPOINT_HALF_WIDTH, GATE.checkpoint);
      addPostCaps(b, gate, GATE.checkpoint);
    });
  });
  const goalIndex = level.checkpoints.length;
  part(goalIndex, GATE.goalWhite, () => {
    addGateBar(b, level.goal, -GOAL_BAR_OFFSET, GOAL_HALF_WIDTH, GATE.goalWhite);
    addPostCaps(b, level.goal, GATE.goalWhite);
  });
  part(goalIndex, GATE.goalGreen, () => {
    addGateBar(b, level.goal, GOAL_BAR_OFFSET, GOAL_HALF_WIDTH, GATE.goalGreen);
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
  /** Recolours the gates: passed ones dim, the next one pulsing (steady when `reducedFlash`). */
  update(run: RunState, time: number, reducedFlash: boolean): void;
  dispose(): void;
}

function buildStaticGeometry(level: Level): BufferGeometry {
  const b = new GeometryBuilder();
  addGround(b, level);
  addGrid(b, level);
  addRoad(b, level);
  addCentreLine(b, level);
  addEdgeStrip(b, level, level.left, ACCENTS[HUE.cyan].glow);
  addEdgeStrip(b, level, level.right, ACCENTS[HUE.magenta].glow);
  addStartMarking(b, level.start);
  addWalls(b, level);
  for (const prop of level.props) addPillar(b, prop);
  for (const gate of level.checkpoints) addGatePosts(b, gate);
  addGatePosts(b, level.goal);
  addDecorAccents(b, level);
  return b.build();
}

class LevelMeshes implements LevelVisual {
  readonly group = new Group();
  private readonly staticMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly gateMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly decor: InstancedMesh | null;
  private readonly gateParts: GatePart[];
  private readonly gateColors: BufferAttribute;
  private readonly goalIndex: number;

  constructor(level: Level) {
    this.staticMesh = new Mesh(buildStaticGeometry(level), builderMaterial());
    this.staticMesh.frustumCulled = false;

    const gates = new GeometryBuilder();
    this.gateParts = buildGateParts(gates, level);
    this.goalIndex = level.checkpoints.length;
    this.gateMesh = new Mesh(gates.build(), builderMaterial());
    this.gateMesh.frustumCulled = false;
    this.gateColors = this.gateMesh.geometry.getAttribute('color') as BufferAttribute;
    this.gateColors.setUsage(DynamicDrawUsage);

    this.decor = buildDecor(level);
    this.group.add(this.staticMesh, this.gateMesh);
    if (this.decor) this.group.add(this.decor);
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
    this.group.removeFromParent();
    for (const mesh of [this.staticMesh, this.gateMesh]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    if (this.decor) {
      this.decor.geometry.dispose();
      (this.decor.material as MeshBasicMaterial).dispose();
      this.decor.dispose();
    }
  }
}

export function buildLevelVisual(level: Level): LevelVisual {
  return new LevelMeshes(level);
}
