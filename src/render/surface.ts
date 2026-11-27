import { STEP_UP, TERRAIN_Y } from '../types';
import type { Bump, PathPoint } from '../types';
import { bumpHeightAt } from './ground';
import type { Ground } from './ground';

/**
 * Which road surface is under a point, and how high it is: the renderer's own answer to "ROAD SURFACE HEIGHT" in
 * types.ts, for the car's shadow and underglow, skid marks, smoke, sparks and the camera.
 *
 * A road is indexed once, when it is built, on a coarse grid of the segments of its centreline. A query then only
 * looks at the handful of segments in one cell and allocates nothing.
 */

const CELL = 12;
/**
 * A point this far outside the road edge still counts as on it, m. The same as the simulation's FOOTPRINT_MARGIN
 * (src/sim/surface.ts): a car the simulation still has on the road must stand on road here too, or its shadow drops
 * to the city floor and its body is lifted towards the axles.
 */
export const EDGE_SLACK = 0.25;
/**
 * Two candidate surfaces closer in height than this belong to one stretch of road (roads that cross are
 * CROSSING_CLEARANCE apart), m.
 */
const SAME_STRETCH = 2;

/** One road's centreline, indexed for point queries. */
export class PathIndex {
  readonly path: readonly PathPoint[];
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly items: Int32Array;
  /** How far the road reaches past its first and its last point (walled run-off), m. */
  private readonly extendStart: number;
  private readonly extendEnd: number;

  // What the last query that found a surface found.
  /** Segment index (path[i] to path[i + 1]). */
  segment = -1;
  /** Signed distance from the centreline, + = to the road's right, m. */
  lateral = 0;
  /** Half the road width there, m. */
  halfWidth = 0;
  /** Unit direction of the road there. */
  dirX = 1;
  dirZ = 0;

  constructor(path: readonly PathPoint[], extendStart = 0, extendEnd = 0) {
    this.path = path;
    this.extendStart = Math.max(0, extendStart);
    this.extendEnd = Math.max(0, extendEnd);
    const n = path.length;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let reach = 0;
    for (let i = 0; i < n; i++) {
      const p = path[i];
      if (p.x < minX) minX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.z > maxZ) maxZ = p.z;
      if (p.halfWidth > reach) reach = p.halfWidth;
    }
    const pad = reach + EDGE_SLACK + Math.max(this.extendStart, this.extendEnd) + 1;
    if (n === 0) {
      minX = minZ = 0;
      maxX = maxZ = 0;
    }
    this.minX = minX - pad;
    this.minZ = minZ - pad;
    this.cols = Math.max(1, Math.ceil((maxX + pad - this.minX) / CELL));
    this.rows = Math.max(1, Math.ceil((maxZ + pad - this.minZ) / CELL));
    const cells = this.cols * this.rows;
    // Compressed rows: count the segments per cell, turn the counts into starts, then fill.
    const start = new Int32Array(cells + 1);
    for (let i = 0; i < n - 1; i++) {
      this.cellRange(i);
      for (let r = range.r0; r <= range.r1; r++) {
        for (let c = range.c0; c <= range.c1; c++) start[r * this.cols + c + 1]++;
      }
    }
    for (let c = 1; c <= cells; c++) start[c] += start[c - 1];
    const items = new Int32Array(start[cells]);
    const cursor = start.slice(0, cells);
    for (let i = 0; i < n - 1; i++) {
      this.cellRange(i);
      for (let r = range.r0; r <= range.r1; r++) {
        for (let c = range.c0; c <= range.c1; c++) items[cursor[r * this.cols + c]++] = i;
      }
    }
    this.cellStart = start;
    this.items = items;
  }

  /** Highest road surface (bumps not included) at (x, z) that is at or below `maxY`; -Infinity if none. */
  surfaceAt(x: number, z: number, maxY: number): number {
    const col = Math.floor((x - this.minX) / CELL);
    const row = Math.floor((z - this.minZ) / CELL);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -Infinity;
    const cell = row * this.cols + col;
    const path = this.path;
    const last = path.length - 2;
    let best = -Infinity;
    let bestOver = Infinity;
    for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
      const i = this.items[k];
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-12) continue;
      const len = Math.sqrt(len2);
      const raw = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      const lo = i === 0 ? -this.extendStart / len : 0;
      const hi = i === last ? 1 + this.extendEnd / len : 1;
      const t = raw < lo ? lo : raw > hi ? hi : raw;
      const along = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = x - (a.x + dx * t);
      const oz = z - (a.z + dz * t);
      const hw = a.halfWidth + (b.halfWidth - a.halfWidth) * along + EDGE_SLACK;
      if (ox * ox + oz * oz > hw * hw) continue;
      const y = a.y + (b.y - a.y) * along;
      if (y > maxY) continue;
      // How far past the segment's ends the point lies, m. Neighbouring segments of one stretch of road all
      // reach the point near a joint; the one it really lies along is the one it overshoots least.
      const over = (raw < lo ? lo - raw : raw > hi ? raw - hi : 0) * len;
      if (best !== -Infinity) {
        const sameStretch = Math.abs(y - best) < SAME_STRETCH;
        if (sameStretch ? over >= bestOver : y <= best) continue;
      }
      best = y;
      bestOver = over;
      this.segment = i;
      this.dirX = dx / len;
      this.dirZ = dz / len;
      // right of (dx, dz) is (-dz, dx)
      this.lateral = (x - a.x) * -this.dirZ + (z - a.z) * this.dirX;
      this.halfWidth = hw - EDGE_SLACK;
    }
    return best;
  }

  /** Sets `range` to the cells segment i (widened by the road and any run-off) may reach. */
  private cellRange(i: number): void {
    const a = this.path[i];
    const b = this.path[i + 1];
    let ext = Math.max(a.halfWidth, b.halfWidth) + EDGE_SLACK;
    if (i === 0) ext += this.extendStart;
    if (i === this.path.length - 2) ext += this.extendEnd;
    range.c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - ext - this.minX) / CELL));
    range.c1 = Math.min(this.cols - 1, Math.floor((Math.max(a.x, b.x) + ext - this.minX) / CELL));
    range.r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - ext - this.minZ) / CELL));
    range.r1 = Math.min(this.rows - 1, Math.floor((Math.max(a.z, b.z) + ext - this.minZ) / CELL));
  }
}

const range = { c0: 0, c1: 0, r0: 0, r1: 0 };

/**
 * Every road on show (the fixed level, or the live chunks of the endless road) with their bumps: the Ground the
 * car, its marks and its effects stand on.
 */
export class RoadSurface implements Ground {
  private readonly roads: PathIndex[] = [];
  private readonly keys: number[] = [];
  private readonly bumpLists: (readonly Bump[])[] = [];
  /** Every bump of every road on show. */
  private readonly bumps: Bump[] = [];

  /** The road the last query found, or null when it found only the city floor. */
  hit: PathIndex | null = null;

  get roadCount(): number {
    return this.roads.length;
  }

  add(key: number, road: PathIndex, bumps: readonly Bump[]): void {
    this.remove(key);
    this.roads.push(road);
    this.keys.push(key);
    this.bumpLists.push(bumps);
    this.refreshBumps();
  }

  remove(key: number): void {
    const i = this.keys.indexOf(key);
    if (i < 0) return;
    this.roads.splice(i, 1);
    this.keys.splice(i, 1);
    this.bumpLists.splice(i, 1);
    this.refreshBumps();
  }

  clear(): void {
    this.roads.length = 0;
    this.keys.length = 0;
    this.bumpLists.length = 0;
    this.bumps.length = 0;
    this.hit = null;
  }

  /**
   * The surface a car at `fromY` standing at (x, z) rests on: the highest road surface at or below
   * fromY + STEP_UP, bumps included; TERRAIN_Y (the city floor) where there is none.
   */
  heightAt(x: number, z: number, fromY = Infinity): number {
    const maxY = fromY + STEP_UP;
    let best = -Infinity;
    this.hit = null;
    const roads = this.roads;
    for (let r = 0; r < roads.length; r++) {
      const y = roads[r].surfaceAt(x, z, maxY);
      if (y > best) {
        best = y;
        this.hit = roads[r];
      }
    }
    if (best === -Infinity) return TERRAIN_Y;
    const bumps = this.bumps;
    return bumps.length === 0 ? best : best + bumpHeightAt(bumps, bumps.length, x, z, best);
  }

  private refreshBumps(): void {
    const bumps = this.bumps;
    bumps.length = 0;
    for (let i = 0; i < this.bumpLists.length; i++) {
      const list = this.bumpLists[i];
      for (let j = 0; j < list.length; j++) bumps.push(list[j]);
    }
  }
}
