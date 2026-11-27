/**
 * The simulation on an endless road: the same car, surfaces and collisions as world.ts (RoadSim), on a road that
 * arrives in chunks. On top of that it follows the car's progress along the centreline.
 *
 * Progress follows the car's OWN stretch of road: each tick it looks only a few segments either side of where the
 * car was, so where the road crosses over or under itself the car never jumps to the other stretch. It moves to
 * another stretch only when the car stands on it (it came down there after a jump or a fall): the surface under the
 * car says which road that is.
 */
import type { CarParams, EndlessWorld, PathPoint, Pose, TrackChunk, Wall } from '../types';
import { CROSSING_CLEARANCE } from '../types';
import { removeSolids } from './collision';
import { DEFAULT_CAR_PARAMS, cloneParams } from './params';
import { removePiece } from './surface';
import { RoadSim, runoffPast } from './world';

/** Kept for compatibility: the old "landed outside the road" margin. The city floor rule replaced it. */
export const ROAD_MARGIN = 0.5;

/** Collider owner of the wall across the entry of the oldest live chunk. Chunks own their index, which is >= 0. */
const CAP_OWNER = -1;
/** The progress tracker looks this many centreline segments either side of where the car was last tick. */
const LOCAL_WINDOW = 8;
/** A centreline counts as the car's level when within this of the car's wheels, m. */
const HEIGHT_MATCH = CROSSING_CLEARANCE / 2;
/** Penalty (m) on the distance to a centreline that is not at the car's level, so one that is always wins. */
const OFF_LEVEL = 1e6;
/** The road under the car is another stretch than the one followed when their distances differ by this, m. */
const RESEAT_GAP = 30;

class EndlessSim extends RoadSim implements EndlessWorld {
  readonly chunks: TrackChunk[] = [];
  trackDist = 0;
  chunkIndex = 0;

  private readonly capWall: Wall[] = [{ ax: 0, az: 0, bx: 0, bz: 0, ya: 0, yb: 0 }];
  private capped = false;
  /** Road behind the first path point of the oldest live chunk, m (only chunk 0 has any). */
  private runoff = 0;
  /** The centreline segment nearest the car: position in `chunks`, and the index of the segment's first point. */
  private nearChunk = 0;
  private nearSegment = 0;
  /** Scratch, set by `measure`: distance from the centreline, distance along the road, centreline height there. */
  private distance = 0;
  private along = 0;
  private height = 0;

  constructor(start: Pose, params: CarParams) {
    super(start, params);
  }

  addChunk(chunk: TrackChunk): void {
    const count = this.chunks.length;
    if (count > 0 && chunk.index !== this.chunks[count - 1].index + 1) {
      throw new Error(`chunk ${chunk.index} cannot follow chunk ${this.chunks[count - 1].index}`);
    }
    if (chunk.path.length < 2) throw new Error(`chunk ${chunk.index} has no road`);
    this.chunks.push(chunk);
    this.addRoad(chunk.index, chunk, chunk.index === 0 ? runoffPast(chunk, 0, 1) : 0, 0);
    if (count === 0) {
      this.closeEntry();
      this.nearChunk = 0;
      this.nearSegment = 0;
      // The first road under a car that is standing still: put its wheels on it.
      const car = this.car;
      if (!car.airborne && car.speed === 0) {
        const y = this.groundHeight(car.x, car.z, car.y + 2 * HEIGHT_MATCH);
        if (Math.abs(y - car.y) < 2 * HEIGHT_MATCH) car.y = y;
      }
      this.reseat();
    }
  }

  dropChunksBefore(index: number): void {
    let dropped = 0;
    while (dropped < this.chunks.length && this.chunks[dropped].index < index) {
      removePiece(this.surface, this.chunks[dropped].index);
      removeSolids(this.collider, this.chunks[dropped].index);
      dropped++;
    }
    if (dropped === 0) return;
    this.chunks.splice(0, dropped);
    this.closeEntry();
    this.nearChunk -= dropped;
    if (this.nearChunk < 0) {
      // The road was taken away from under the car. Start again from the oldest road there is.
      this.nearChunk = 0;
      this.nearSegment = 0;
      if (this.chunks.length > 0) this.reseat();
    }
  }

  /** Everything RoadSim snapshots, then the progress along the road. */
  snapshot(): number[] {
    const snapshot = super.snapshot();
    snapshot.push(this.trackDist);
    return snapshot;
  }

  protected afterStep(): void {
    this.follow();
  }

  protected afterPlace(): void {
    if (this.chunks.length > 0) this.reseat();
  }

  /**
   * Keeps the entry of the oldest live chunk shut. Chunk 0 brings its own wall behind the start; any later chunk
   * that becomes the oldest gets one straight across its first pair of edge points, at the height of the road there.
   */
  private closeEntry(): void {
    if (this.capped) {
      removeSolids(this.collider, CAP_OWNER);
      this.capped = false;
    }
    this.runoff = 0;
    if (this.chunks.length === 0) return;
    const oldest = this.chunks[0];
    if (oldest.index === 0) {
      this.runoff = runoffPast(oldest, 0, 1);
    } else if (oldest.left.length > 0 && oldest.right.length > 0) {
      const wall = this.capWall[0];
      wall.ax = oldest.left[0].x;
      wall.az = oldest.left[0].z;
      wall.bx = oldest.right[0].x;
      wall.bz = oldest.right[0].z;
      wall.ya = oldest.path[0].y;
      wall.yb = oldest.path[0].y;
      this.addWalls(CAP_OWNER, this.capWall);
      this.capped = true;
    }
  }

  /**
   * Measures a point against one centreline segment and leaves the result in `distance`, `along` and `height`.
   * The very first live segment carries on backwards over the start runoff.
   */
  private measure(chunk: number, segment: number, x: number, z: number): void {
    const path: PathPoint[] = this.chunks[chunk].path;
    const a = path[segment];
    const b = path[segment + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / lengthSq : 0;
    if (t > 1) t = 1;
    else if (t < 0) {
      const back = chunk === 0 && segment === 0 && this.chunks[0].index === 0 && this.runoff > 0 ? -this.runoff / Math.sqrt(lengthSq) : 0;
      if (t < back) t = back;
    }
    const offX = x - (a.x + dx * t);
    const offZ = z - (a.z + dz * t);
    const onSegment = t > 0 ? t : 0;
    this.distance = Math.sqrt(offX * offX + offZ * offZ);
    this.along = a.dist + (b.dist - a.dist) * onSegment;
    this.height = a.y + (b.y - a.y) * onSegment;
  }

  /**
   * Moves the tracker to the nearest centreline segment at the car's level within a few segments of where it was.
   *
   * While the car is AIRBORNE its height says nothing about which stretch it belongs to (falling off a descent, it
   * drops level with road further along), so heights are ignored and the tracker follows the horizontal projection
   * onto its own stretch: progress never runs ahead of the car. Where it comes down is settled once it lands.
   */
  private trackNearby(x: number, z: number, y: number, airborne = false): void {
    const chunks = this.chunks;
    let chunk = this.nearChunk;
    let segment = this.nearSegment;
    for (let i = 0; i < LOCAL_WINDOW; i++) {
      if (segment > 0) segment--;
      else if (chunk > 0) segment = chunks[--chunk].path.length - 2;
      else break;
    }
    let best = Infinity;
    for (let i = 0; i <= 2 * LOCAL_WINDOW; i++) {
      this.measure(chunk, segment, x, z);
      // Nearest to the centreline itself, not to the road's edge: where the road changes width they differ.
      const score = this.distance + (airborne || Math.abs(this.height - y) <= HEIGHT_MATCH ? 0 : OFF_LEVEL);
      if (score < best) {
        best = score;
        this.nearChunk = chunk;
        this.nearSegment = segment;
      }
      if (segment < chunks[chunk].path.length - 2) segment++;
      else if (chunk < chunks.length - 1) {
        chunk++;
        segment = 0;
      } else break;
    }
    this.measure(this.nearChunk, this.nearSegment, x, z);
  }

  /** Index in `chunks` of the live chunk with this index, or -1. */
  private positionOf(index: number): number {
    if (this.chunks.length === 0) return -1;
    const at = index - this.chunks[0].index;
    return at >= 0 && at < this.chunks.length ? at : -1;
  }

  /**
   * Looks over every live chunk for the centreline nearest the car at its level. Used only when the tracker is
   * placed from scratch and the car is not standing on any road.
   */
  private trackAnywhere(x: number, z: number, y: number): void {
    let best = Infinity;
    for (let chunk = 0; chunk < this.chunks.length; chunk++) {
      const segments = this.chunks[chunk].path.length - 1;
      for (let segment = 0; segment < segments; segment++) {
        this.measure(chunk, segment, x, z);
        const score = this.distance + (Math.abs(this.height - y) <= HEIGHT_MATCH ? 0 : OFF_LEVEL);
        if (score < best) {
          best = score;
          this.nearChunk = chunk;
          this.nearSegment = segment;
        }
      }
    }
  }

  /** Places the tracker from scratch: on the road the car stands on, or the nearest centreline at its level. */
  private reseat(): void {
    const car = this.car;
    const at = this.groundOnRoad ? this.positionOf(this.groundOwner) : -1;
    if (at >= 0) {
      this.nearChunk = at;
      this.nearSegment = Math.min(Math.max(0, this.groundPath), this.chunks[at].path.length - 2);
      this.trackNearby(car.x, car.z, car.y);
    } else {
      this.trackAnywhere(car.x, car.z, car.y);
      this.measure(this.nearChunk, this.nearSegment, car.x, car.z);
    }
    this.trackDist = this.along;
    this.chunkIndex = this.chunks[this.nearChunk].index;
  }

  /**
   * Once per tick: follows the car along its own stretch of road. When the car stands on a stretch of road far
   * along the road from the one followed (it came down there after a jump, or fell onto a road below), the tracker
   * moves there.
   */
  private follow(): void {
    if (this.chunks.length === 0) return;
    const car = this.car;
    this.trackNearby(car.x, car.z, car.y, car.airborne);
    if (!car.airborne && this.groundOnRoad) {
      const at = this.positionOf(this.groundOwner);
      if (at >= 0) {
        const path = this.chunks[at].path;
        const segment = Math.min(Math.max(0, this.groundPath), path.length - 2);
        if (Math.abs(path[segment].dist - this.along) > RESEAT_GAP) {
          this.nearChunk = at;
          this.nearSegment = segment;
          this.trackNearby(car.x, car.z, car.y);
        }
      }
    }
    this.trackDist = this.along;
    this.chunkIndex = this.chunks[this.nearChunk].index;
  }
}

/**
 * The car starts at `start`, at rest, on an empty world: add chunks before stepping. `params` is used as given
 * (not copied), as in `createWorld`.
 */
export function createEndlessWorld(start: Pose, params: CarParams = cloneParams(DEFAULT_CAR_PARAMS)): EndlessWorld {
  return new EndlessSim(start, params);
}
