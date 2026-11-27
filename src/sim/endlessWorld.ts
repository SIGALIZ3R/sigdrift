/**
 * The simulation on an endless road: the same car and the same collisions as world.ts, on a track that arrives in
 * chunks and has bumps. On top of that it follows the car's progress along the centreline and notices when the car
 * comes down outside the road.
 */
import type {
  CarParams,
  CarState,
  CollisionEvent,
  EndlessWorld,
  InputState,
  PathPoint,
  Pose,
  Segment,
  TrackChunk,
} from '../types';
import { DT } from '../types';
import { createCarState, resetCarState, stepCar } from './car';
import type { Collider } from './collision';
import { WALL_CLEAR_HEIGHT, addSolids, createCollider, removeSolids, resolveCollisions } from './collision';
import { bumpHeight } from './ground';
import { DEFAULT_CAR_PARAMS, cloneParams } from './params';

/** The car's centre may be this far beyond the road's half width and still count as on the road, m. */
export const ROAD_MARGIN = 0.5;

/** Collider owner of the wall across the entry of the oldest live chunk. Chunks own their index, which is >= 0. */
const CAP_OWNER = -1;
/** The progress tracker looks this many centreline segments either side of where the car was last tick. */
const LOCAL_WINDOW = 8;
/** How far behind chunk 0's first path point its own closing wall may be and still be taken for the cap, m. */
const MAX_START_RUNOFF = 40;

const NO_PROPS: readonly [] = [];

/** Boxes worked out once per chunk so that lookups can skip the chunks that are nowhere near. */
interface ChunkBox {
  roadMinX: number;
  roadMinZ: number;
  roadMaxX: number;
  roadMaxZ: number;
  bumpMinX: number;
  bumpMinZ: number;
  bumpMaxX: number;
  bumpMaxZ: number;
}

function boxOf(chunk: TrackChunk): ChunkBox {
  const box: ChunkBox = {
    roadMinX: Infinity,
    roadMinZ: Infinity,
    roadMaxX: -Infinity,
    roadMaxZ: -Infinity,
    bumpMinX: Infinity,
    bumpMinZ: Infinity,
    bumpMaxX: -Infinity,
    bumpMaxZ: -Infinity,
  };
  const road = (x: number, z: number): void => {
    if (x < box.roadMinX) box.roadMinX = x;
    if (x > box.roadMaxX) box.roadMaxX = x;
    if (z < box.roadMinZ) box.roadMinZ = z;
    if (z > box.roadMaxZ) box.roadMaxZ = z;
  };
  for (const p of chunk.path) road(p.x, p.z);
  for (const p of chunk.left) road(p.x, p.z);
  for (const p of chunk.right) road(p.x, p.z);
  for (const w of chunk.walls) {
    road(w.ax, w.az);
    road(w.bx, w.bz);
  }
  for (const b of chunk.bumps) {
    const reach = b.halfLength + b.halfWidth;
    if (b.x - reach < box.bumpMinX) box.bumpMinX = b.x - reach;
    if (b.x + reach > box.bumpMaxX) box.bumpMaxX = b.x + reach;
    if (b.z - reach < box.bumpMinZ) box.bumpMinZ = b.z - reach;
    if (b.z + reach > box.bumpMaxZ) box.bumpMaxZ = b.z + reach;
  }
  return box;
}

/**
 * How far the road of chunk 0 runs on behind its first path point before its own closing wall: the furthest back
 * any of its walls reaches within the road's width of the start line.
 */
function startRunoff(chunk: TrackChunk): number {
  const a = chunk.path[0];
  const b = chunk.path[1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (!(length > 0)) return 0;
  const ux = dx / length;
  const uz = dz / length;
  const reach = a.halfWidth + 1;
  let runoff = 0;
  const consider = (x: number, z: number): void => {
    const along = (x - a.x) * ux + (z - a.z) * uz;
    const across = (z - a.z) * ux - (x - a.x) * uz;
    if (along < -runoff && along >= -MAX_START_RUNOFF && across >= -reach && across <= reach) runoff = -along;
  };
  for (const w of chunk.walls) {
    consider(w.ax, w.az);
    consider(w.bx, w.bz);
  }
  return runoff;
}

class EndlessSim implements EndlessWorld {
  params: CarParams;
  readonly car: CarState;
  tick = 0;
  /** Owned by the collider and overwritten on the next step: copy it to keep it. */
  lastCollision: CollisionEvent | null = null;
  readonly chunks: TrackChunk[] = [];
  trackDist = 0;
  chunkIndex = 0;
  offTrack = false;

  private readonly collider: Collider = createCollider();
  private readonly boxes: ChunkBox[] = [];
  private readonly capWall: Segment[] = [{ ax: 0, az: 0, bx: 0, bz: 0 }];
  private capped = false;
  /** Road behind the first path point of the oldest live chunk, m (only chunk 0 has any). */
  private runoff = 0;
  /** The centreline segment nearest the car: position in `chunks`, and the index of the segment's first point. */
  private nearChunk = 0;
  private nearSegment = 0;
  /** Whether the car was flying above the walls on the last step (they were not solid for it then). */
  private wasOverWalls = false;
  /**
   * Scratch, set by `measure`: distance from the centreline, distance beyond the road's edge (negative on the
   * road), and distance along the road.
   */
  private distance = 0;
  private outside = 0;
  private along = 0;

  constructor(start: Pose, params: CarParams) {
    this.params = params;
    this.car = createCarState(start);
  }

  addChunk(chunk: TrackChunk): void {
    const count = this.chunks.length;
    if (count > 0 && chunk.index !== this.chunks[count - 1].index + 1) {
      throw new Error(`chunk ${chunk.index} cannot follow chunk ${this.chunks[count - 1].index}`);
    }
    if (chunk.path.length < 2) throw new Error(`chunk ${chunk.index} has no road`);
    this.chunks.push(chunk);
    this.boxes.push(boxOf(chunk));
    addSolids(this.collider, chunk.index, chunk.walls, chunk.props);
    if (count === 0) {
      this.closeEntry();
      this.nearChunk = 0;
      this.nearSegment = 0;
      this.reseat();
    }
  }

  dropChunksBefore(index: number): void {
    let dropped = 0;
    while (dropped < this.chunks.length && this.chunks[dropped].index < index) {
      removeSolids(this.collider, this.chunks[dropped].index);
      dropped++;
    }
    if (dropped === 0) return;
    this.chunks.splice(0, dropped);
    this.boxes.splice(0, dropped);
    this.closeEntry();
    this.nearChunk -= dropped;
    if (this.nearChunk < 0) {
      // The road was taken away from under the car. Start again from the oldest road there is.
      this.nearChunk = 0;
      this.nearSegment = 0;
      if (this.chunks.length > 0) this.reseat();
    }
  }

  groundHeight(x: number, z: number): number {
    let height = 0;
    let found = false;
    for (let c = 0; c < this.boxes.length; c++) {
      const box = this.boxes[c];
      if (!(x >= box.bumpMinX && x <= box.bumpMaxX && z >= box.bumpMinZ && z <= box.bumpMaxZ)) continue;
      const bumps = this.chunks[c].bumps;
      for (let i = 0; i < bumps.length; i++) {
        const h = bumpHeight(bumps[i], x, z);
        if (h !== 0 && (!found || h > height)) {
          height = h;
          found = true;
        }
      }
    }
    return height;
  }

  step(input: InputState): void {
    const car = this.car;
    const wasAirborne = car.airborne;
    const ground = this.groundHeight(car.x + car.vx * DT, car.z + car.vz * DT);
    stepCar(car, this.params, input, DT, ground);
    const landed = wasAirborne && !car.airborne;
    const overWalls = car.airborne && car.y - ground > WALL_CLEAR_HEIGHT;
    // Coming back down to wall height the car picks one side of any wall it is across: see resolveCollisions.
    const regroup = this.wasOverWalls && !overWalls;
    this.wasOverWalls = overWalls;
    this.lastCollision = resolveCollisions(car, this.params, this.collider, !overWalls, regroup);
    // A landing or a knock changes where the car is heading, so its wheels pick the ground up afresh.
    if (!car.airborne && (landed || this.lastCollision !== null)) this.seatOnGround();
    this.follow();
    this.tick++;
  }

  placeCar(pose: Pose): void {
    resetCarState(this.car, pose);
    this.car.y = this.groundHeight(pose.x, pose.z);
    this.lastCollision = null;
    this.offTrack = false;
    this.wasOverWalls = false;
    if (this.chunks.length > 0) this.reseat();
  }

  /**
   * The tick, everything the next step reads (see world.ts), the height state, the progress along the road, and
   * whether the car was above the walls.
   */
  snapshot(): number[] {
    const { x, z, heading, vx, vz, yawRate, steerAngle, accelLong, rearSlide, reversing, y, vy, airborne } = this.car;
    return [
      this.tick,
      x,
      z,
      heading,
      vx,
      vz,
      yawRate,
      steerAngle,
      accelLong,
      rearSlide,
      reversing ? 1 : 0,
      y,
      vy,
      airborne ? 1 : 0,
      this.offTrack ? 1 : 0,
      this.trackDist,
      this.wasOverWalls ? 1 : 0,
    ];
  }

  /**
   * Puts the wheels on the ground where the car now is, moving up or down as the ground did over the last tick of
   * its new path. Looking back, not forward: the next step compares this with the slope ahead, and it is that
   * change of slope which unloads the tyres over a crest and throws the car off it. Seated on the slope ahead, the
   * step after every knock would find no change at all, and a car rubbing a wall could never leave the ground.
   */
  private seatOnGround(): void {
    const car = this.car;
    const here = this.groundHeight(car.x, car.z);
    car.y = here;
    car.vy = (here - this.groundHeight(car.x - car.vx * DT, car.z - car.vz * DT)) / DT;
  }

  /**
   * Keeps the entry of the oldest live chunk shut. Chunk 0 brings its own wall behind the start; any later chunk
   * that becomes the oldest gets one straight across its first pair of edge points.
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
      this.runoff = startRunoff(oldest);
    } else if (oldest.left.length > 0 && oldest.right.length > 0) {
      const wall = this.capWall[0];
      wall.ax = oldest.left[0].x;
      wall.az = oldest.left[0].z;
      wall.bx = oldest.right[0].x;
      wall.bz = oldest.right[0].z;
      addSolids(this.collider, CAP_OWNER, this.capWall, NO_PROPS);
      this.capped = true;
    }
  }

  /**
   * Measures a point against one centreline segment and leaves the result in `distance`, `outside` and `along`.
   * The very first live segment carries on backwards over the start runoff, at the width of its first point.
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
      const back = chunk === 0 && segment === 0 && this.runoff > 0 ? -this.runoff / Math.sqrt(lengthSq) : 0;
      if (t < back) t = back;
    }
    const offX = x - (a.x + dx * t);
    const offZ = z - (a.z + dz * t);
    const onSegment = t > 0 ? t : 0;
    this.distance = Math.sqrt(offX * offX + offZ * offZ);
    this.outside = this.distance - (a.halfWidth + (b.halfWidth - a.halfWidth) * onSegment);
    this.along = a.dist + (b.dist - a.dist) * onSegment;
  }

  /** Moves the tracker to the nearest centreline segment within a few segments of where it was. */
  private trackNearby(x: number, z: number): void {
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
      if (this.distance < best) {
        best = this.distance;
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

  /**
   * Looks over every live chunk for the centreline nearest the car, and moves the tracker there if the car is on
   * that stretch of road. Returns whether it is.
   *
   * Nearest to the centreline, as in `trackNearby`, and not "best inside the road's edge": measured against its end
   * point, a segment is a disc as wide as the road is there, and beside a widening the disc of the wide end bulges
   * out past the walls of the narrower road leading up to it.
   */
  private trackAnywhere(x: number, z: number): boolean {
    let best = Infinity;
    let bestChunk = -1;
    let bestSegment = 0;
    for (let chunk = 0; chunk < this.chunks.length; chunk++) {
      const box = this.boxes[chunk];
      if (
        x < box.roadMinX - ROAD_MARGIN ||
        x > box.roadMaxX + ROAD_MARGIN ||
        z < box.roadMinZ - ROAD_MARGIN ||
        z > box.roadMaxZ + ROAD_MARGIN
      ) {
        continue;
      }
      const segments = this.chunks[chunk].path.length - 1;
      for (let segment = 0; segment < segments; segment++) {
        this.measure(chunk, segment, x, z);
        if (this.distance < best) {
          best = this.distance;
          bestChunk = chunk;
          bestSegment = segment;
        }
      }
    }
    if (bestChunk < 0) return false;
    this.measure(bestChunk, bestSegment, x, z);
    if (!(this.outside <= ROAD_MARGIN)) return false;
    this.nearChunk = bestChunk;
    this.nearSegment = bestSegment;
    return true;
  }

  /** Places the tracker from scratch: on the road the car is on, or failing that on the nearest stretch nearby. */
  private reseat(): void {
    const car = this.car;
    if (!this.trackAnywhere(car.x, car.z)) this.trackNearby(car.x, car.z);
    this.trackDist = this.along;
    this.chunkIndex = this.chunks[this.nearChunk].index;
  }

  /**
   * Once per tick: follows the car along the road, and when it is on the ground checks that there is road under
   * it. When the stretch being followed says the car is not on it (after a flight it may have come down on any
   * stretch of road), everything is searched before that is believed.
   */
  private follow(): void {
    if (this.chunks.length === 0) return;
    const car = this.car;
    this.trackNearby(car.x, car.z);
    if (!car.airborne && !this.offTrack && this.outside > ROAD_MARGIN) {
      if (!this.trackAnywhere(car.x, car.z)) {
        this.offTrack = true;
        this.trackNearby(car.x, car.z);
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
