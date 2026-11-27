import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from 'three';
import type { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial } from 'three';
import { TERRAIN_Y, WALL_HEIGHT } from '../types';
import type { DecorBlock, PathPoint } from '../types';
import { CAMERA_PITCH, CAMERA_YAW } from './camera';

/**
 * Keeping the car in sight under a camera that never moves.
 *
 * Roads now pass over each other, and the camera looks down at a slant, so a bridge (or any raised stretch
 * between the car and the camera) can hide the car. Every road deck is cut into SECTIONS of about 24 m; each
 * frame the sections that are well above the car and lie on its line of sight fade out to a sparse dither, and
 * fade back once they are clear. City blocks between the car and the camera sink into the floor the same way.
 *
 * Fading is done in the deck materials' shaders from a small table of per-section opacities (one texel per
 * section), so it costs no extra draw calls: a whole chunk stays one mesh however many of its sections fade.
 * The opaque deck uses an ordered dither ("screen door") rather than blending, so it keeps writing depth and needs
 * no sorting; the additive light on it is simply scaled.
 */

/** Unit direction from any point of the scene towards the locked camera. */
export const TO_CAMERA_X = Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW);
export const TO_CAMERA_Y = Math.sin(CAMERA_PITCH);
export const TO_CAMERA_Z = Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW);
const TO_CAMERA_FLAT = Math.cos(CAMERA_PITCH);

/** Target length of one deck section along the road, m. */
export const SECTION_LENGTH = 24;
/** A deck fades only when it is this much higher than the car's wheels, m. */
export const FADE_ABOVE = 2;
/** ...and only where it crosses the line of sight within this horizontal distance of the car, m. */
export const FADE_REACH = 25;
/** Opacity a fully faded section keeps. */
export const FADE_MIN_ALPHA = 0.15;
/** The line of sight is taken from this high above the wheels, m. */
const EYE_HEIGHT = 0.6;
/** Extra room round the line of sight, for the car's own size and the deck's thickness, m. */
const FADE_MARGIN = 2.8;
const FADE_OUT_RATE = 9;
const FADE_IN_RATE = 4;

/**
 * Whether a road deck whose centreline passes through (px, py, pz), `halfWidth` wide, hides a car with its
 * wheels at (x, y, z) from the camera: it must be more than FADE_ABOVE above the car and cross the line of sight
 * within FADE_REACH (horizontally) of it.
 */
export function deckHidesCar(
  px: number,
  py: number,
  pz: number,
  halfWidth: number,
  x: number,
  y: number,
  z: number,
): boolean {
  if (py - y <= FADE_ABOVE) return false;
  // How far along the sight line (from the car's eye towards the camera) it reaches the deck's height.
  const s = (py - (y + EYE_HEIGHT)) / TO_CAMERA_Y;
  if (s * TO_CAMERA_FLAT > FADE_REACH) return false;
  const dx = px - (x + TO_CAMERA_X * s);
  const dz = pz - (z + TO_CAMERA_Z * s);
  const r = halfWidth + FADE_MARGIN;
  return dx * dx + dz * dz <= r * r;
}

/**
 * Where each section of a road begins: path indices, ascending, starting at 0, with path.length - 1 last (so
 * section k covers points starts[k] .. starts[k + 1]). Sections are about `length` metres long; a short tail is
 * merged into the section before it.
 */
export function deckSectionStarts(path: readonly PathPoint[], length = SECTION_LENGTH): Int32Array {
  const n = path.length;
  if (n < 2) return Int32Array.of(0, Math.max(0, n - 1));
  const starts: number[] = [0];
  let from = path[0].dist;
  for (let i = 1; i < n - 1; i++) {
    if (path[i].dist - from >= length) {
      starts.push(i);
      from = path[i].dist;
    }
  }
  if (starts.length > 1 && path[n - 1].dist - from < length / 2) starts.pop();
  starts.push(n - 1);
  return Int32Array.from(starts);
}

/** Section `k` that path point `i` belongs to (the last section owns the last point). */
export function sectionOfPoint(starts: Int32Array, i: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// The section table: one opacity per section, shared by every deck material
// ---------------------------------------------------------------------------------------------------------------

export const SECTION_TEXTURE_WIDTH = 256;
const SECTION_TEXTURE_HEIGHT = 16;
export const SECTION_CAPACITY = SECTION_TEXTURE_WIDTH * SECTION_TEXTURE_HEIGHT;

export class SectionTable {
  readonly texture: DataTexture;
  private readonly data = new Uint8Array(SECTION_CAPACITY * 4);
  private readonly alpha = new Float32Array(SECTION_CAPACITY).fill(1);
  private readonly target = new Float32Array(SECTION_CAPACITY).fill(1);
  /** 1 where the id is handed out. Id 0 is never handed out: it is "always opaque". */
  private readonly used = new Uint8Array(SECTION_CAPACITY);
  /** Ids that are not at full opacity, or are on their way there. */
  private readonly moving = new Int32Array(SECTION_CAPACITY);
  private movingCount = 0;
  private readonly isMoving = new Uint8Array(SECTION_CAPACITY);

  constructor() {
    this.data.fill(255);
    this.used[0] = 1;
    this.texture = new DataTexture(this.data, SECTION_TEXTURE_WIDTH, SECTION_TEXTURE_HEIGHT, RGBAFormat, UnsignedByteType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Hands out `count` consecutive ids and returns the first; 0 (never fades) when the table is full. */
  alloc(count: number): number {
    if (count <= 0) return 0;
    let run = 0;
    for (let id = 1; id < SECTION_CAPACITY; id++) {
      run = this.used[id] === 0 ? run + 1 : 0;
      if (run === count) {
        const base = id - count + 1;
        for (let k = base; k <= id; k++) {
          this.used[k] = 1;
          this.alpha[k] = 1;
          this.target[k] = 1;
          this.write(k);
        }
        return base;
      }
    }
    return 0;
  }

  free(base: number, count: number): void {
    if (base <= 0) return;
    for (let k = base; k < base + count && k < SECTION_CAPACITY; k++) {
      this.used[k] = 0;
      this.alpha[k] = 1;
      this.target[k] = 1;
      this.write(k);
    }
  }

  setTarget(id: number, alpha: number): void {
    if (id <= 0 || this.target[id] === alpha) return;
    this.target[id] = alpha;
    if (this.isMoving[id] === 0) {
      this.isMoving[id] = 1;
      this.moving[this.movingCount++] = id;
    }
  }

  opacity(id: number): number {
    return this.alpha[id];
  }

  /** Eases every section towards its target and schedules the texture upload if anything changed. */
  step(dt: number): void {
    if (this.movingCount === 0) return;
    const out = 1 - Math.exp(-FADE_OUT_RATE * Math.max(0, dt));
    const back = 1 - Math.exp(-FADE_IN_RATE * Math.max(0, dt));
    let kept = 0;
    let changed = false;
    for (let m = 0; m < this.movingCount; m++) {
      const id = this.moving[m];
      const target = this.target[id];
      let a = this.alpha[id];
      a += (target - a) * (target < a ? out : back);
      if (Math.abs(target - a) < 0.004) a = target;
      if (a !== this.alpha[id]) {
        this.alpha[id] = a;
        changed = this.write(id) || changed;
      }
      if (a === target) this.isMoving[id] = 0;
      else this.moving[kept++] = id;
    }
    this.movingCount = kept;
    if (changed) this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  private write(id: number): boolean {
    const value = Math.round(this.alpha[id] * 255);
    const o = id * 4;
    if (this.data[o] === value) return false;
    this.data[o] = value;
    this.texture.needsUpdate = true;
    return true;
  }
}

/**
 * GLSL for the deck materials. The vertex stage looks up its section's opacity (`section` attribute, one texel
 * per id); the opaque material drops fragments on an ordered 4x4 dither below that opacity, the additive one is
 * scaled by it.
 */
export function injectSectionFade(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  texture: DataTexture,
  additive: boolean,
): void {
  shader.uniforms.sectionAlpha = { value: texture };
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float section;\nuniform sampler2D sectionAlpha;\nvarying float vSectionAlpha;',
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        int sid = int(section + 0.5);
        vSectionAlpha = texelFetch(sectionAlpha, ivec2(sid % ${SECTION_TEXTURE_WIDTH}, sid / ${SECTION_TEXTURE_WIDTH}), 0).r;
      }`,
    );
  const fade = additive
    ? 'diffuseColor.rgb *= vSectionAlpha;'
    : `if (vSectionAlpha < 0.995) {
        ivec2 q = ivec2(gl_FragCoord.xy) % 4;
        int e = q.x ^ q.y;
        int bayer = ((e & 1) << 3) | ((q.y & 1) << 2) | (e & 2) | ((q.y & 2) >> 1);
        if (vSectionAlpha * 16.0 < float(bayer) + 0.5) discard;
      }`;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSectionAlpha;')
    .replace('#include <color_fragment>', `#include <color_fragment>\n${fade}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Deck fading
// ---------------------------------------------------------------------------------------------------------------

/** The sections of one built road: what the fader tests against the line of sight every frame. */
export interface DeckSections {
  readonly path: readonly PathPoint[];
  /** Path index each section starts at; see deckSectionStarts. */
  readonly starts: Int32Array;
  /** Id of section 0 in the table (0 when the table was full: such a road never fades). */
  readonly base: number;
  /** Per section: centre, radius (horizontal) and highest surface, for a quick rejection. */
  readonly cx: Float32Array;
  readonly cz: Float32Array;
  readonly radius: Float32Array;
  readonly maxY: Float32Array;
}

export function describeSections(path: readonly PathPoint[], starts: Int32Array, base: number): DeckSections {
  const count = starts.length - 1;
  const cx = new Float32Array(count);
  const cz = new Float32Array(count);
  const radius = new Float32Array(count);
  const maxY = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    let top = -Infinity;
    let wide = 0;
    for (let i = starts[k]; i <= starts[k + 1]; i++) {
      const p = path[i];
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
      top = Math.max(top, p.y);
      wide = Math.max(wide, p.halfWidth);
    }
    cx[k] = (x0 + x1) / 2;
    cz[k] = (z0 + z1) / 2;
    radius[k] = Math.hypot(x1 - x0, z1 - z0) / 2 + wide;
    maxY[k] = top;
  }
  return { path, starts, base, cx, cz, radius, maxY };
}

export class DeckFader {
  private readonly decks: DeckSections[] = [];

  constructor(private readonly table: SectionTable) {}

  get deckCount(): number {
    return this.decks.length;
  }

  add(deck: DeckSections): void {
    if (deck.base > 0 && !this.decks.includes(deck)) this.decks.push(deck);
  }

  remove(deck: DeckSections): void {
    const i = this.decks.indexOf(deck);
    if (i >= 0) this.decks.splice(i, 1);
  }

  clear(): void {
    this.decks.length = 0;
  }

  /** Call once per frame with the car's position (y = its wheels). */
  update(x: number, y: number, z: number, dt: number): void {
    const decks = this.decks;
    for (let d = 0; d < decks.length; d++) {
      const deck = decks[d];
      const count = deck.starts.length - 1;
      for (let k = 0; k < count; k++) this.table.setTarget(deck.base + k, sectionHides(deck, k, x, y, z) ? FADE_MIN_ALPHA : 1);
    }
    this.table.step(dt);
  }
}

/** Whether section k of `deck` hides the car at (x, y, z). */
export function sectionHides(deck: DeckSections, k: number, x: number, y: number, z: number): boolean {
  if (deck.maxY[k] - y <= FADE_ABOVE) return false;
  const dx = deck.cx[k] - x;
  const dz = deck.cz[k] - z;
  const reach = deck.radius[k] + FADE_REACH + FADE_MARGIN + WALL_HEIGHT;
  if (dx * dx + dz * dz > reach * reach) return false;
  const path = deck.path;
  for (let i = deck.starts[k]; i <= deck.starts[k + 1]; i++) {
    const p = path[i];
    if (deckHidesCar(p.x, p.y, p.z, p.halfWidth, x, y, z)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// City blocks
// ---------------------------------------------------------------------------------------------------------------

/** The sight line is taken from this far above the wheels, and a block counts if it comes this close to the line, m. */
const SIGHT_HEIGHT = 0.6;
const SIGHT_CLEARANCE = 2.8;
/** What is left of a sunk block: a slab on the floor, m. */
const SUNK_HEIGHT = 0.04;
/** Share of its height a block sinks, and rises again, per second. */
const SINK_RATE = 9;
const RISE_RATE = 2.5;
/** A block stays down this long after it last stood in the way, so it does not bob while the car weaves, s. */
const SINK_HOLD = 0.8;

/**
 * Whether a block (standing on the city floor) hides the point (x, y, z), or anything within SIGHT_CLEARANCE of
 * it sideways, from the camera.
 */
export function blockHides(block: DecorBlock, x: number, y: number, z: number): boolean {
  const top = TERRAIN_Y + block.h;
  const py = y + SIGHT_HEIGHT;
  if (py >= top) return false;
  // Ray from the point towards the camera against the block grown sideways by the clearance (slab test). All
  // three components of the direction are positive, so the ray leaves through the +x, top or +z face.
  const nearX = (block.x - block.w / 2 - SIGHT_CLEARANCE - x) / TO_CAMERA_X;
  const farX = (block.x + block.w / 2 + SIGHT_CLEARANCE - x) / TO_CAMERA_X;
  const nearZ = (block.z - block.d / 2 - SIGHT_CLEARANCE - z) / TO_CAMERA_Z;
  const farZ = (block.z + block.d / 2 + SIGHT_CLEARANCE - z) / TO_CAMERA_Z;
  const farY = (top - py) / TO_CAMERA_Y;
  const enter = Math.max(nearX, nearZ, 0);
  const leave = Math.min(farX, farZ, farY);
  return leave > enter;
}

/** One road's city blocks: the instanced mesh that draws them and how far each one stands. */
export interface BlockSet {
  readonly decor: readonly DecorBlock[];
  readonly mesh: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  /** 1 = standing at full height, 0 = sunk. */
  readonly level: Float32Array;
  /** Seconds left before a sunk block may rise again. */
  readonly hold: Float32Array;
}

export function blockSet(decor: readonly DecorBlock[], mesh: InstancedMesh<BoxGeometry, MeshBasicMaterial>): BlockSet {
  return { decor, mesh, level: new Float32Array(decor.length).fill(1), hold: new Float32Array(decor.length) };
}

export class BlockSinker {
  private readonly sets: BlockSet[] = [];
  private sunk = 0;

  constructor(private readonly matrix: Matrix4) {}

  /** Number of city blocks currently not at full height. */
  get sunkBlocks(): number {
    return this.sunk;
  }

  add(set: BlockSet): void {
    if (!this.sets.includes(set)) this.sets.push(set);
  }

  remove(set: BlockSet): void {
    const i = this.sets.indexOf(set);
    if (i >= 0) this.sets.splice(i, 1);
  }

  clear(): void {
    this.sets.length = 0;
    this.sunk = 0;
  }

  /** Call once per frame with the car's position (y = its wheels). */
  update(x: number, y: number, z: number, dt: number): void {
    const step = Math.max(0, dt);
    let sunk = 0;
    for (let s = 0; s < this.sets.length; s++) {
      const set = this.sets[s];
      const { decor, level, hold } = set;
      let dirty = false;
      for (let i = 0; i < decor.length; i++) {
        if (blockHides(decor[i], x, y, z)) hold[i] = SINK_HOLD;
        else if (hold[i] > 0) hold[i] = Math.max(0, hold[i] - step);
        const before = level[i];
        const after = hold[i] > 0 ? Math.max(0, before - SINK_RATE * step) : Math.min(1, before + RISE_RATE * step);
        if (after !== before) {
          level[i] = after;
          this.place(set, i);
          dirty = true;
        }
        if (after < 1) sunk++;
      }
      if (dirty) set.mesh.instanceMatrix.needsUpdate = true;
    }
    this.sunk = sunk;
  }

  private place(set: BlockSet, i: number): void {
    const block = set.decor[i];
    const mesh = set.mesh;
    const height = Math.max(block.h * set.level[i], SUNK_HEIGHT);
    this.matrix.makeScale(block.w, height, block.d).setPosition(block.x - mesh.position.x, 0, block.z - mesh.position.z);
    mesh.setMatrixAt(i, this.matrix);
  }
}
