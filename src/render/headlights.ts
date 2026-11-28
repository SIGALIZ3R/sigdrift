import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Mesh, MeshBasicMaterial } from 'three';
import type { Ground } from './ground';
import { CAR } from './palette';

/**
 * Two headlight beams lying on the road ahead of the car, one from each lamp. Each is a fan of triangles whose
 * vertices follow the road surface every frame and whose light falls off smoothly with distance and towards its
 * sides, so it fades out instead of ending at an edge. A beam goes dark from the point where the road under it
 * drops away (an edge, a wall, a drop to a lower road), so light never lands on the city floor far below.
 */

/** How far a beam reaches, m. */
const BEAM_LENGTH = 28;
/** Rows of vertices along a beam and columns across it. */
const ROWS = 14;
const COLS = 7;
/** Half the beam's width at the lamp, m, and how much it widens per metre (about an 11° half angle). */
const START_HALF = 0.22;
const SPREAD = 0.2;
/** Each beam is turned this far outwards, rad. */
const TOE_OUT = 0.05;
/** Light on the road sits this far above it, m. */
const LIFT = 0.08;
/** A row more than this above or below the one before it is off the road: the beam stops there, m. */
const MAX_STEP = 1.2;
/** The road surface a row may still climb to above the one before it is found from this height, m. */
const CLIMB = 0.2;

/** Brightness at along-fraction t (0 at the lamp, 1 at the far end) and across-fraction c (-1..1). */
function falloff(t: number, c: number): number {
  // Brightest a couple of metres out, then a long smooth fade to nothing at the far end.
  const rise = Math.min(1, 0.45 + t * 6);
  const along = Math.pow(1 - t, 1.5);
  const across = 1 - c * c;
  return rise * along * across * across * across;
}

export class HeadlightBeams {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** Car-frame position of each vertex (x forward, z right), and its brightness before any cut-off. */
  private readonly localX: Float32Array;
  private readonly localZ: Float32Array;
  private readonly weight: Float32Array;
  private readonly positions: BufferAttribute;
  private readonly colors: BufferAttribute;
  private readonly rowHeight = new Float32Array(COLS);
  private readonly rowLit = new Uint8Array(COLS);

  /** `lampX` is how far ahead of the pose the lamps sit, `lampZ` how far either side of the centreline. */
  constructor(lampX: number, lampZ: number) {
    const perBeam = ROWS * COLS;
    const count = perBeam * 2;
    this.localX = new Float32Array(count);
    this.localZ = new Float32Array(count);
    this.weight = new Float32Array(count);
    const index: number[] = [];
    for (let beam = 0; beam < 2; beam++) {
      const side = beam === 0 ? -1 : 1;
      const toe = side * TOE_OUT;
      const ca = Math.cos(toe);
      const sa = Math.sin(toe);
      for (let r = 0; r < ROWS; r++) {
        const t = r / (ROWS - 1);
        const d = t * BEAM_LENGTH;
        const half = START_HALF + d * SPREAD;
        for (let c = 0; c < COLS; c++) {
          const across = (c / (COLS - 1)) * 2 - 1;
          const ax = d;
          const az = across * half;
          const i = beam * perBeam + r * COLS + c;
          this.localX[i] = lampX + ax * ca - az * sa;
          this.localZ[i] = side * lampZ + ax * sa + az * ca;
          this.weight[i] = falloff(t, across);
        }
      }
      for (let r = 0; r < ROWS - 1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const a = beam * perBeam + r * COLS + c;
          index.push(a, a + 1, a + COLS + 1, a, a + COLS + 1, a + COLS);
        }
      }
    }
    const geometry = new BufferGeometry();
    this.positions = new BufferAttribute(new Float32Array(count * 3), 3);
    this.colors = new BufferAttribute(new Float32Array(count * 3), 3);
    this.positions.setUsage(DynamicDrawUsage);
    this.colors.setUsage(DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      this.positions.setXYZ(i, this.localX[i], 0, this.localZ[i]);
    }
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    geometry.setIndex(index);
    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.renderOrder = 2;
    // The vertices move every frame; the bounding sphere would go stale.
    this.mesh.frustumCulled = false;
  }

  /**
   * Lays the beams on the road for a car at (x, z) facing (cos, sin), standing at `startY`. `light` scales the
   * brightness (dimmer as the car leaves the ground). Positions are in the car group's frame: x and z turned with
   * the car, y absolute.
   */
  update(ground: Ground, x: number, z: number, cos: number, sin: number, startY: number, light: number): void {
    const pos = this.positions.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const base = CAR.headlightBeam;
    const perBeam = ROWS * COLS;
    for (let beam = 0; beam < 2; beam++) {
      this.rowHeight.fill(startY);
      this.rowLit.fill(1);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = beam * perBeam + r * COLS + c;
          const lx = this.localX[i];
          const lz = this.localZ[i];
          const wx = x + lx * cos - lz * sin;
          const wz = z + lx * sin + lz * cos;
          const prev = this.rowHeight[c];
          let y = prev;
          if (this.rowLit[c] === 1) {
            // Searching from just above the last row lets the beam follow a climb or a dip, one row at a time.
            const h = ground.heightAt(wx, wz, prev + CLIMB);
            if (Math.abs(h - prev) > MAX_STEP) this.rowLit[c] = 0;
            else y = h;
          }
          this.rowHeight[c] = y;
          pos[i * 3 + 1] = y + LIFT;
          const k = this.rowLit[c] === 1 ? this.weight[i] * light : 0;
          col[i * 3] = base.r * k;
          col[i * 3 + 1] = base.g * k;
          col[i * 3 + 2] = base.b * k;
        }
      }
    }
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
