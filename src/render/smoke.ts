import {
  AdditiveBlending,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import type { BufferAttribute, Color, Texture, Vector3 } from 'three';
import { SMOKE_TINT, SPARK } from './palette';

// Everything in this file is cosmetic and outside the simulation, so Math.random is fine here.

const SOFT_TEXTURE_SIZE = 64;

/** White texture whose alpha falls off smoothly from the centre: the shape of every soft glow and puff. */
export function createSoftTexture(): Texture {
  const size = SOFT_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const falloff = Math.max(0, 1 - Math.sqrt(u * u + v * v));
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(255 * falloff * falloff);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------------------------------------------
// Tyre smoke
// ---------------------------------------------------------------------------------------------------------------

const MAX_PUFFS = 350;
const PUFF_LIFE = 0.8;
const PUFF_GAIN = 0.085;
const PUFF_GROWTH = 2.2;
const PUFF_DRAG = 1.6;

// Per-puff record layout in `state`.
const STRIDE = 10;
const PX = 0;
const PY = 1;
const PZ = 2;
const VX = 3;
const VY = 4;
const VZ = 5;
const AGE = 6;
const LIFE = 7;
const SIZE = 8;
const GAIN = 9;

export interface Smoke {
  readonly mesh: InstancedMesh;
  /**
   * Adds one puff at ground position (x, z) that drifts with (vx, vz). `intensity` is 0..1; `groundY` is the
   * height of the ground there (0 on flat road).
   */
  spawn(x: number, z: number, vx: number, vz: number, intensity: number, groundY?: number): void;
  update(dt: number): void;
  setEnabled(enabled: boolean): void;
  /**
   * While on, the mesh is drawn even with no live puff (one invisible instance), so that its shader program and
   * pipeline are built on a frame of our choosing instead of on the first drift. Call with false straight after.
   */
  setWarmUp(on: boolean): void;
  clear(): void;
  dispose(): void;
}

class SmokePool implements Smoke {
  readonly mesh: InstancedMesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly state = new Float32Array(MAX_PUFFS * STRIDE);
  private readonly colors: InstancedBufferAttribute;
  private alive = 0;
  private enabled = true;

  /** `right` and `up` are the camera's fixed screen axes: the camera never rotates, so the quads never need to. */
  constructor(
    private readonly right: Vector3,
    private readonly up: Vector3,
    texture: Texture,
  ) {
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, MAX_PUFFS);
    this.colors = new InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3);
    this.colors.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = this.colors;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  spawn(x: number, z: number, vx: number, vz: number, intensity: number, groundY = 0): void {
    if (!this.enabled || this.alive === MAX_PUFFS) return;
    const s = this.state;
    const o = this.alive * STRIDE;
    s[o + PX] = x + (Math.random() - 0.5) * 0.3;
    s[o + PY] = groundY + 0.25;
    s[o + PZ] = z + (Math.random() - 0.5) * 0.3;
    s[o + VX] = vx + (Math.random() - 0.5) * 1.4;
    s[o + VY] = 0.9 + Math.random() * 0.7;
    s[o + VZ] = vz + (Math.random() - 0.5) * 1.4;
    s[o + AGE] = 0;
    s[o + LIFE] = PUFF_LIFE * (0.75 + Math.random() * 0.5);
    s[o + SIZE] = 0.8 + Math.random() * 0.5;
    s[o + GAIN] = PUFF_GAIN * (0.4 + 0.6 * intensity);
    this.alive++;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    this.integrate(dt);
    this.writeInstances();
    this.mesh.count = this.alive;
    this.mesh.visible = this.alive > 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  setWarmUp(on: boolean): void {
    if (this.alive > 0) return;
    if (on) {
      // Additive and black: the one instance that gets drawn adds nothing to the picture. A count of zero would
      // not do, because three skips the draw call (and with it the program) for an instanced mesh with none.
      this.colors.array.fill(0, 0, 3);
      this.colors.needsUpdate = true;
    }
    this.mesh.count = on ? 1 : 0;
    this.mesh.visible = on;
  }

  clear(): void {
    this.alive = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }

  /** Ages and moves every puff; a dead one is replaced by the last live one so the live set stays packed. */
  private integrate(dt: number): void {
    const s = this.state;
    const drag = Math.exp(-PUFF_DRAG * dt);
    for (let i = this.alive - 1; i >= 0; i--) {
      const o = i * STRIDE;
      s[o + AGE] += dt;
      if (s[o + AGE] >= s[o + LIFE]) {
        this.alive--;
        const last = this.alive * STRIDE;
        if (last !== o) s.copyWithin(o, last, last + STRIDE);
        continue;
      }
      s[o + VX] *= drag;
      s[o + VZ] *= drag;
      s[o + PX] += s[o + VX] * dt;
      s[o + PY] += s[o + VY] * dt;
      s[o + PZ] += s[o + VZ] * dt;
    }
  }

  private writeInstances(): void {
    const s = this.state;
    const matrices = this.mesh.instanceMatrix.array;
    const colors = this.colors.array;
    const right = this.right;
    const up = this.up;
    for (let i = 0; i < this.alive; i++) {
      const o = i * STRIDE;
      const t = s[o + AGE] / s[o + LIFE];
      const scale = s[o + SIZE] * (1 + PUFF_GROWTH * t);
      const m = i * 16;
      matrices[m] = right.x * scale;
      matrices[m + 1] = right.y * scale;
      matrices[m + 2] = right.z * scale;
      matrices[m + 3] = 0;
      matrices[m + 4] = up.x * scale;
      matrices[m + 5] = up.y * scale;
      matrices[m + 6] = up.z * scale;
      matrices[m + 7] = 0;
      matrices[m + 8] = 0;
      matrices[m + 9] = 0;
      matrices[m + 10] = 1;
      matrices[m + 11] = 0;
      matrices[m + 12] = s[o + PX];
      matrices[m + 13] = s[o + PY];
      matrices[m + 14] = s[o + PZ];
      matrices[m + 15] = 1;

      const fade = s[o + GAIN] * (1 - t) * (1 - t) * Math.min(1, t * 10);
      const c = i * 3;
      colors[c] = SMOKE_TINT.r * fade;
      colors[c + 1] = SMOKE_TINT.g * fade;
      colors[c + 2] = SMOKE_TINT.b * fade;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colors.needsUpdate = true;
  }
}

export function createSmoke(right: Vector3, up: Vector3, texture: Texture): Smoke {
  return new SmokePool(right, up, texture);
}

// ---------------------------------------------------------------------------------------------------------------
// Collision sparks
// ---------------------------------------------------------------------------------------------------------------

const MAX_SPARKS = 288;
const SPARK_SIZE_PX = 3.5;
const SPARK_GRAVITY = 14;
const SPARK_IMPACT_MAX = 20;

export interface Sparks {
  readonly points: Points;
  /**
   * Throws `count` sparks off a wall hit at (x, z); (nx, nz) is the normal pointing back at the car and `groundY`
   * the height of the road surface there.
   */
  burst(x: number, z: number, nx: number, nz: number, impact: number, count: number, groundY?: number): void;
  /**
   * Throws one spark from (x, y, z) with velocity (vx, vy, vz), living `life` seconds, in `color` (the usual spark
   * colour when left out). It bounces off nothing and stops falling at `floorY`.
   */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, floorY: number, color?: Color): void;
  update(dt: number): void;
  /** While on, the points are drawn even with no live spark (all black), to build their program ahead of time. */
  setWarmUp(on: boolean): void;
  clear(): void;
  dispose(): void;
}

class SparkPool implements Sparks {
  readonly points: Points<BufferGeometry, PointsMaterial>;
  private readonly positions: BufferAttribute;
  private readonly colors: BufferAttribute;
  private readonly velocity = new Float32Array(MAX_SPARKS * 3);
  private readonly age = new Float32Array(MAX_SPARKS);
  /** 0 marks a free slot. */
  private readonly life = new Float32Array(MAX_SPARKS);
  /** Lowest height each spark may fall to. */
  private readonly floor = new Float32Array(MAX_SPARKS);
  /** Colour of each spark at full brightness. */
  private readonly tint = new Float32Array(MAX_SPARKS * 3);
  private cursor = 0;
  private live = 0;

  constructor() {
    const geometry = new BufferGeometry();
    this.positions = new Float32BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
    this.colors = new Float32BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
    this.positions.setUsage(DynamicDrawUsage);
    this.colors.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    const material = new PointsMaterial({
      size: SPARK_SIZE_PX,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
  }

  burst(x: number, z: number, nx: number, nz: number, impact: number, count: number, groundY = 0): void {
    const speed = Math.min(impact, SPARK_IMPACT_MAX);
    const p = this.positions.array;
    const v = this.velocity;
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (i + 1) % MAX_SPARKS;
      if (this.life[i] === 0) this.live++;
      const o = i * 3;
      const out = speed * (0.25 + Math.random() * 0.6);
      const along = speed * (Math.random() - 0.5) * 1.4;
      p[o] = x;
      p[o + 1] = groundY + 0.35;
      p[o + 2] = z;
      v[o] = nx * out - nz * along;
      v[o + 1] = 2 + Math.random() * 4;
      v[o + 2] = nz * out + nx * along;
      this.age[i] = 0;
      this.life[i] = 0.22 + Math.random() * 0.28;
      this.floor[i] = groundY + 0.05;
      this.tint[o] = SPARK.r;
      this.tint[o + 1] = SPARK.g;
      this.tint[o + 2] = SPARK.b;
    }
    this.points.visible = true;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, floorY: number, color?: Color): void {
    const i = this.cursor;
    this.cursor = (i + 1) % MAX_SPARKS;
    if (this.life[i] === 0) this.live++;
    const o = i * 3;
    const p = this.positions.array;
    const v = this.velocity;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    v[o] = vx;
    v[o + 1] = vy;
    v[o + 2] = vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, life);
    this.floor[i] = floorY;
    const c = color ?? SPARK;
    this.tint[o] = c.r;
    this.tint[o + 1] = c.g;
    this.tint[o + 2] = c.b;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.live === 0) return;
    const p = this.positions.array;
    const c = this.colors.array;
    const v = this.velocity;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.life[i] === 0) continue;
      const o = i * 3;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.live--;
        c[o] = c[o + 1] = c[o + 2] = 0;
        continue;
      }
      v[o + 1] -= SPARK_GRAVITY * dt;
      p[o] += v[o] * dt;
      p[o + 1] = Math.max(this.floor[i], p[o + 1] + v[o + 1] * dt);
      p[o + 2] += v[o + 2] * dt;
      const fade = 1 - this.age[i] / this.life[i];
      c[o] = this.tint[o] * fade;
      c[o + 1] = this.tint[o + 1] * fade;
      c[o + 2] = this.tint[o + 2] * fade;
    }
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.points.visible = this.live > 0;
  }

  setWarmUp(on: boolean): void {
    // Dead sparks are black and the points are additive, so drawing them all shows nothing.
    if (this.live === 0) this.points.visible = on;
  }

  clear(): void {
    this.life.fill(0);
    this.colors.array.fill(0);
    this.colors.needsUpdate = true;
    this.live = 0;
    this.points.visible = false;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

export function createSparks(): Sparks {
  return new SparkPool();
}
