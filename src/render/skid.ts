import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Mesh, MeshBasicMaterial } from 'three';
import type { CarParams, CarState } from '../types';
import { WHEEL_COUNT, wheelOffsetX, wheelOffsetZ } from './carMesh';
import { SKID } from './palette';

/**
 * Tyre marks: one ribbon per wheel, all four in a single mesh. Each wheel owns a fixed block of quads used as a
 * ring buffer, so marks last for the whole run until the block wraps and the oldest are overwritten.
 */

const QUADS_PER_WHEEL = 4096;
const VERTS_PER_WHEEL = QUADS_PER_WHEEL * 4;
const HALF_WIDTH = 0.12;
/** Just above the road paint, below the gate bars. */
const MARK_Y = 0.04;
/** A new quad is laid once the wheel has moved this far, m. */
const MIN_STEP = 0.3;
/** A longer step than this in one go is a teleport, not a slide. */
const MAX_STEP = 6;
const SLIDE_THRESHOLD = 0.3;
const REAR_ALPHA_MIN = 0.2;
const REAR_ALPHA_MAX = 0.85;
const FRONT_ALPHA_MIN = 0.1;
const FRONT_ALPHA_MAX = 0.45;

// Layout of the per-wheel record in `prev`: last anchor point, its left and right ribbon edge, its alpha.
const PREV_STRIDE = 7;
const AX = 0;
const AZ = 1;
const LX = 2;
const LZ = 3;
const RX = 4;
const RZ = 5;
const ALPHA = 6;

interface UpdateRange {
  start: number;
  count: number;
}

export interface SkidMarks {
  readonly mesh: Mesh;
  /** Call once per simulation tick. */
  lay(car: CarState, params: CarParams): void;
  /** Call once per rendered frame, before drawing: schedules the upload of whatever `lay` wrote. */
  flush(): void;
  clear(): void;
  dispose(): void;
}

function buildIndex(): Uint32Array {
  const quads = WHEEL_COUNT * QUADS_PER_WHEEL;
  const index = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const v = q * 4;
    const o = q * 6;
    index[o] = v;
    index[o + 1] = v + 1;
    index[o + 2] = v + 2;
    index[o + 3] = v;
    index[o + 4] = v + 2;
    index[o + 5] = v + 3;
  }
  return index;
}

function emptyRanges(): UpdateRange[] {
  const ranges: UpdateRange[] = [];
  for (let w = 0; w < WHEEL_COUNT; w++) ranges.push({ start: 0, count: 0 });
  return ranges;
}

class SkidRibbons implements SkidMarks {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly positions = new BufferAttribute(new Float32Array(WHEEL_COUNT * VERTS_PER_WHEEL * 3), 3);
  private readonly colors = new BufferAttribute(new Float32Array(WHEEL_COUNT * VERTS_PER_WHEEL * 4), 4);
  // Reused every frame: three only reads these objects during the upload, then empties its list.
  private readonly positionRanges = emptyRanges();
  private readonly colorRanges = emptyRanges();

  private readonly cursor = new Int32Array(WHEEL_COUNT);
  private readonly sliding = new Uint8Array(WHEEL_COUNT);
  private readonly hasEdge = new Uint8Array(WHEEL_COUNT);
  private readonly prev = new Float64Array(WHEEL_COUNT * PREV_STRIDE);
  private readonly dirtyFrom = new Int32Array(WHEEL_COUNT);
  private readonly dirtyCount = new Int32Array(WHEEL_COUNT);
  private uploadAll = false;

  constructor() {
    this.positions.setUsage(DynamicDrawUsage);
    this.colors.setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    geometry.setIndex(new BufferAttribute(buildIndex(), 1));
    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new Mesh(geometry, material);
    // The geometry changes all the time, so a cached bounding sphere would cull it wrongly.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  lay(car: CarState, params: CarParams): void {
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const slide = w < 2 ? car.frontSlide : car.rearSlide;
      if (slide < SLIDE_THRESHOLD) {
        this.sliding[w] = 0;
        continue;
      }
      const lx = wheelOffsetX(params, w);
      const lz = wheelOffsetZ(params, w);
      this.extend(w, car.x + lx * cos - lz * sin, car.z + lx * sin + lz * cos, markAlpha(w, slide));
    }
  }

  flush(): void {
    if (this.uploadAll) {
      this.uploadAll = false;
      this.dirtyCount.fill(0);
      this.positions.clearUpdateRanges();
      this.colors.clearUpdateRanges();
      this.positions.needsUpdate = true;
      this.colors.needsUpdate = true;
      return;
    }
    let any = false;
    for (let w = 0; w < WHEEL_COUNT; w++) {
      if (this.dirtyCount[w] === 0) continue;
      if (!any) {
        any = true;
        this.positions.clearUpdateRanges();
        this.colors.clearUpdateRanges();
      }
      this.queueRange(w);
      this.dirtyCount[w] = 0;
    }
    if (any) {
      this.positions.needsUpdate = true;
      this.colors.needsUpdate = true;
    }
  }

  clear(): void {
    this.positions.array.fill(0);
    this.cursor.fill(0);
    this.sliding.fill(0);
    this.hasEdge.fill(0);
    this.uploadAll = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /** Continues wheel `w`'s ribbon to (x, z), or starts a new strip there if the wheel was not sliding. */
  private extend(w: number, x: number, z: number, alpha: number): void {
    const prev = this.prev;
    const o = w * PREV_STRIDE;
    const dx = x - prev[o + AX];
    const dz = z - prev[o + AZ];
    const d2 = dx * dx + dz * dz;
    if (this.sliding[w] === 0 || d2 > MAX_STEP * MAX_STEP) {
      this.sliding[w] = 1;
      this.hasEdge[w] = 0;
      prev[o + AX] = x;
      prev[o + AZ] = z;
      prev[o + ALPHA] = alpha;
      return;
    }
    if (d2 < MIN_STEP * MIN_STEP) return;

    // Ribbon edges lie across the direction the wheel actually travelled, not across the car.
    const inv = HALF_WIDTH / Math.sqrt(d2);
    let px = -dz * inv;
    let pz = dx * inv;
    if (this.hasEdge[w] === 0) {
      prev[o + LX] = prev[o + AX] - px;
      prev[o + LZ] = prev[o + AZ] - pz;
      prev[o + RX] = prev[o + AX] + px;
      prev[o + RZ] = prev[o + AZ] + pz;
      this.hasEdge[w] = 1;
    } else if ((prev[o + RX] - prev[o + LX]) * px + (prev[o + RZ] - prev[o + LZ]) * pz < 0) {
      // The wheel reversed direction: keep left and right on the same sides so the quad does not twist.
      px = -px;
      pz = -pz;
    }

    this.writeQuad(w, x - px, z - pz, x + px, z + pz, alpha);
    prev[o + AX] = x;
    prev[o + AZ] = z;
    prev[o + LX] = x - px;
    prev[o + LZ] = z - pz;
    prev[o + RX] = x + px;
    prev[o + RZ] = z + pz;
    prev[o + ALPHA] = alpha;
  }

  /** Writes the quad from the wheel's previous edge to the new edge (lx, lz)-(rx, rz). */
  private writeQuad(w: number, lx: number, lz: number, rx: number, rz: number, alpha: number): void {
    const prev = this.prev;
    const o = w * PREV_STRIDE;
    const q = this.cursor[w];
    const v = w * VERTS_PER_WHEEL + q * 4;

    const p = this.positions.array;
    let i = v * 3;
    p[i++] = prev[o + LX];
    p[i++] = MARK_Y;
    p[i++] = prev[o + LZ];
    p[i++] = prev[o + RX];
    p[i++] = MARK_Y;
    p[i++] = prev[o + RZ];
    p[i++] = rx;
    p[i++] = MARK_Y;
    p[i++] = rz;
    p[i++] = lx;
    p[i++] = MARK_Y;
    p[i] = lz;

    const rgb = w < 2 ? SKID.front : SKID.rear;
    const c = this.colors.array;
    const startAlpha = prev[o + ALPHA];
    let j = v * 4;
    for (let corner = 0; corner < 4; corner++) {
      c[j++] = rgb[0];
      c[j++] = rgb[1];
      c[j++] = rgb[2];
      c[j++] = corner < 2 ? startAlpha : alpha;
    }

    if (this.dirtyCount[w] === 0) this.dirtyFrom[w] = q;
    this.dirtyCount[w]++;
    this.cursor[w] = (q + 1) % QUADS_PER_WHEEL;
  }

  /** Adds wheel `w`'s dirty quads to both attributes' upload lists. */
  private queueRange(w: number): void {
    let firstQuad = this.dirtyFrom[w];
    let quads = this.dirtyCount[w];
    if (firstQuad + quads > QUADS_PER_WHEEL) {
      // The ring wrapped inside this frame: re-send the wheel's whole block rather than two pieces.
      firstQuad = 0;
      quads = QUADS_PER_WHEEL;
    }
    const firstVertex = w * VERTS_PER_WHEEL + firstQuad * 4;
    const position = this.positionRanges[w];
    position.start = firstVertex * 3;
    position.count = quads * 12;
    this.positions.updateRanges.push(position);
    const color = this.colorRanges[w];
    color.start = firstVertex * 4;
    color.count = quads * 16;
    this.colors.updateRanges.push(color);
  }
}

function markAlpha(wheel: number, slide: number): number {
  const t = Math.min(1, (slide - SLIDE_THRESHOLD) / (1 - SLIDE_THRESHOLD));
  return wheel < 2
    ? FRONT_ALPHA_MIN + (FRONT_ALPHA_MAX - FRONT_ALPHA_MIN) * t
    : REAR_ALPHA_MIN + (REAR_ALPHA_MAX - REAR_ALPHA_MIN) * t;
}

export function createSkidMarks(): SkidMarks {
  return new SkidRibbons();
}
