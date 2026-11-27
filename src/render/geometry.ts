import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  MeshBasicMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Color } from 'three';

// Unlit surfaces get a baked shade from a fixed fake light on the camera's side, so the two visible faces of a
// box read as different planes.
const LIGHT_X = 0.9;
const LIGHT_Z = 0.44;

/** Brightness of an upright face whose outward normal is (nx, nz). */
export function sideShade(nx: number, nz: number): number {
  return 0.42 + 0.58 * Math.max(0, nx * LIGHT_X + nz * LIGHT_Z);
}

/**
 * Brightness of a nearly flat surface whose height rises by (gx, gz) metres per metre: slopes that face the fake
 * light are lighter, the ones facing away darker. Exactly 1 on flat ground.
 */
export function slopeShade(gx: number, gz: number): number {
  return Math.min(2.2, Math.max(0.45, 1 - 2.2 * (gx * LIGHT_X + gz * LIGHT_Z)));
}

const INITIAL_VERTICES = 2048;

/**
 * Collects coloured triangles from many small parts into one BufferGeometry (one draw call).
 *
 * The working buffers are typed arrays that only ever grow, and `reset` empties the builder without giving them
 * up: one builder can make any number of geometries (a chunk of endless road every few seconds) without leaving
 * garbage behind. `build` copies out exactly what was written.
 */
export class GeometryBuilder {
  private positions: Float32Array;
  private colors: Float32Array;
  private sections: Float32Array;
  private indices: Uint32Array;
  private vertices = 0;
  private indexCount = 0;
  private originX = 0;
  private originZ = 0;
  /**
   * While on, every vertex also records `section` and `build` adds it as a 'section' attribute: the id of the
   * stretch of road deck it belongs to, which the deck materials fade as a whole (see sections.ts).
   */
  trackSections = false;
  /** Section id written with each new vertex while `trackSections` is on. 0 = never fades. */
  section = 0;

  constructor(vertexCapacity = INITIAL_VERTICES) {
    this.positions = new Float32Array(vertexCapacity * 3);
    this.colors = new Float32Array(vertexCapacity * 3);
    this.sections = new Float32Array(vertexCapacity);
    this.indices = new Uint32Array(vertexCapacity * 2);
  }

  /**
   * Empties the builder. Every vertex added afterwards is stored relative to (originX, originZ): a mesh placed at
   * that point keeps full float precision however far from the world origin its road is.
   */
  reset(originX = 0, originZ = 0): this {
    this.vertices = 0;
    this.indexCount = 0;
    this.originX = originX;
    this.originZ = originZ;
    this.section = 0;
    return this;
  }

  get vertexCount(): number {
    return this.vertices;
  }

  vertex(x: number, y: number, z: number, color: Color, k = 1): number {
    return this.vertexRGB(x, y, z, color.r * k, color.g * k, color.b * k);
  }

  vertexRGB(x: number, y: number, z: number, r: number, g: number, b: number): number {
    const v = this.vertices;
    const o = v * 3;
    if (o + 3 > this.positions.length) this.growVertices();
    const p = this.positions;
    p[o] = x - this.originX;
    p[o + 1] = y;
    p[o + 2] = z - this.originZ;
    const c = this.colors;
    c[o] = r;
    c[o + 1] = g;
    c[o + 2] = b;
    this.sections[v] = this.section;
    this.vertices = v + 1;
    return v;
  }

  triangle(a: number, b: number, c: number): void {
    const o = this.indexCount;
    if (o + 3 > this.indices.length) this.growIndices();
    const i = this.indices;
    i[o] = a;
    i[o + 1] = b;
    i[o + 2] = c;
    this.indexCount = o + 3;
  }

  quad(a: number, b: number, c: number, d: number): void {
    const o = this.indexCount;
    if (o + 6 > this.indices.length) this.growIndices();
    const i = this.indices;
    i[o] = a;
    i[o + 1] = b;
    i[o + 2] = c;
    i[o + 3] = a;
    i[o + 4] = c;
    i[o + 5] = d;
    this.indexCount = o + 6;
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

  /** Flat-topped line from a (height ay) to b (height by): a strip of paint that follows a slope. */
  line3(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    halfWidth: number,
    colorA: Color,
    colorB: Color = colorA,
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return;
    const px = (-dz / len) * halfWidth;
    const pz = (dx / len) * halfWidth;
    const v0 = this.vertex(ax - px, ay, az - pz, colorA);
    const v1 = this.vertex(bx - px, by, bz - pz, colorB);
    const v2 = this.vertex(bx + px, by, bz + pz, colorB);
    const v3 = this.vertex(ax + px, ay, az + pz, colorA);
    this.quad(v0, v1, v2, v3);
  }

  /** Vertical quad on the line a-b from (ya0 at a, yb0 at b) up to (ya1 at a, yb1 at b). */
  wall4(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    ya0: number,
    yb0: number,
    ya1: number,
    yb1: number,
    color: Color,
    k = 1,
  ): void {
    const v0 = this.vertex(ax, ya0, az, color, k);
    const v1 = this.vertex(bx, yb0, bz, color, k);
    const v2 = this.vertex(bx, yb1, bz, color, k);
    const v3 = this.vertex(ax, ya1, az, color, k);
    this.quad(v0, v1, v2, v3);
  }

  /** Vertical quad standing on the ground line a-b. */
  upright(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, color: Color, k = 1): void {
    this.uprightSloped(ax, az, bx, bz, y0, y1, y1, color, k);
  }

  /** Vertical quad on the ground line a-b whose top edge runs from height `ya` at a to `yb` at b. */
  uprightSloped(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    y0: number,
    ya: number,
    yb: number,
    color: Color,
    k = 1,
  ): void {
    const v0 = this.vertex(ax, y0, az, color, k);
    const v1 = this.vertex(bx, y0, bz, color, k);
    const v2 = this.vertex(bx, yb, bz, color, k);
    const v3 = this.vertex(ax, ya, az, color, k);
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
    const ex = ux * halfLen;
    const ez = uz * halfLen;
    this.beam2(cx - ex, cz - ez, cx + ex, cz + ez, halfThick, y0, y0, y1, y1, true, true, side, top);
  }

  /**
   * Upright box along the ground line a-b, `halfThick` to either side of it, whose top runs from height `ya` at a
   * to `yb` at b. `capA` / `capB` say whether the end faces are built: where two beams meet end to end they are
   * hidden and can be left out. Sides are shaded.
   */
  beam(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfThick: number,
    y0: number,
    ya: number,
    yb: number,
    capA: boolean,
    capB: boolean,
    side: Color,
    top: Color,
  ): void {
    this.beam2(ax, az, bx, bz, halfThick, y0, y0, ya, yb, capA, capB, side, top);
  }

  /** As `beam`, with a bottom that also slopes: from `ba` at a to `bb` at b. */
  beam2(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfThick: number,
    ba: number,
    bb: number,
    ya: number,
    yb: number,
    capA: boolean,
    capB: boolean,
    side: Color,
    top: Color,
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) return;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const tx = nx * halfThick;
    const tz = nz * halfThick;
    const x0 = ax - tx;
    const z0 = az - tz;
    const x1 = bx - tx;
    const z1 = bz - tz;
    const x2 = bx + tx;
    const z2 = bz + tz;
    const x3 = ax + tx;
    const z3 = az + tz;
    this.wall4(x0, z0, x1, z1, ba, bb, ya, yb, side, sideShade(-nx, -nz));
    if (capB) this.wall4(x1, z1, x2, z2, bb, bb, yb, yb, side, sideShade(ux, uz));
    this.wall4(x2, z2, x3, z3, bb, ba, yb, ya, side, sideShade(nx, nz));
    if (capA) this.wall4(x3, z3, x0, z0, ba, ba, ya, ya, side, sideShade(-ux, -uz));
    const a = this.vertex(x0, ya, z0, top);
    const b = this.vertex(x1, yb, z1, top);
    const c = this.vertex(x2, yb, z2, top);
    const d = this.vertex(x3, ya, z3, top);
    this.quad(a, b, c, d);
  }

  /**
   * Copies what has been added into a new geometry. Its bounding sphere is filled in from the same pass, so
   * frustum culling never has to walk the vertices again.
   */
  build(): BufferGeometry {
    const n = this.vertices;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions.slice(0, n * 3), 3));
    geometry.setAttribute('color', new BufferAttribute(this.colors.slice(0, n * 3), 3));
    if (this.trackSections) geometry.setAttribute('section', new BufferAttribute(this.sections.slice(0, n), 1));
    const used = this.indices.subarray(0, this.indexCount);
    geometry.setIndex(new BufferAttribute(n > 65535 ? used.slice() : new Uint16Array(used), 1));
    geometry.boundingSphere = this.bounds();
    return geometry;
  }

  private bounds(): Sphere {
    const p = this.positions;
    const end = this.vertices * 3;
    if (end === 0) return new Sphere(new Vector3(), 0);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let o = 0; o < end; o += 3) {
      const x = p[o];
      const y = p[o + 1];
      const z = p[o + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    // The sphere around the bounding box: a little larger than the tightest one, never smaller.
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    return new Sphere(new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2), radius);
  }

  private growVertices(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Float32Array(this.colors.length * 2);
    colors.set(this.colors);
    this.colors = colors;
    const sections = new Float32Array(this.sections.length * 2);
    sections.set(this.sections);
    this.sections = sections;
  }

  private growIndices(): void {
    const indices = new Uint32Array(this.indices.length * 2);
    indices.set(this.indices);
    this.indices = indices;
  }
}

/** Material for anything made with GeometryBuilder: unlit, vertex coloured, winding-agnostic. */
export function builderMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
}

/** Light laid over the surfaces below it. Additive and depth-tested, so walls and pillars still hide it. */
export function glowMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}
