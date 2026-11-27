/**
 * The simulation of one car on 2.5D road surfaces. `RoadSim` is shared by fixed levels (`createWorld`, here) and the
 * endless road (endlessWorld.ts): the same car, surfaces, slopes, falls and collisions on both.
 *
 * Each tick:
 *  1. Slope gravity: on the ground, the surface's gradient pulls the car downhill, -g * slope / (1 + slope²).
 *  2. The surface the car will be over at the end of the tick (at its wheels' height, see surface.ts) is handed to
 *     `stepCar`, which follows it, or launches off it when it falls away faster than gravity can follow (a crest
 *     at speed, an open edge, the end of a bridge). A small convex kink between two path segments is soaked up by
 *     the suspension instead of throwing the car for a tick.
 *  3. Walls and props at the car's own level push it out (collision.ts).
 *  4. Bookkeeping: the slope under the car, offTrack (resting on the city floor), wallDistance.
 */
import type { CarParams, CarState, CollisionEvent, InputState, Level, Pose, RoadPiece, Segment, SimBase, World } from '../types';
import { DT, STEP_UP, TERRAIN_Y } from '../types';
import { cos, sin } from '../core/fixedMath';
import { ENGINE, GRAVITY, createCarState, resetCarState, stepCar, updateKinematics } from './car';
import type { Collider } from './collision';
import { addSolids, createCollider, nearestSolidDistance, resolveCollisions } from './collision';
import { DEFAULT_CAR_PARAMS, cloneParams } from './params';
import type { SurfaceIndex } from './surface';
import { addPiece, createSurfaceIndex, nearestSurface, surfaceAt, surfaceEmpty } from './surface';

/**
 * Downward acceleration the suspension can follow without the wheels leaving the road. Just under the car's own
 * launch threshold (1.15 g in car.ts), so the car never launches while the suspension is following.
 */
const SUSPENSION_ACCEL = 1.1 * GRAVITY;
/**
 * How far the road may drop away below what the suspension can follow before the car takes off, m. Enough for the
 * kink at a path point on a smooth crest; far less than any real drop (an edge, a crest taken at speed).
 */
const SUSPENSION_TRAVEL = 0.06;
/** Most run-off past a closed end of a road that is taken for road (the gap from the end point to its cap wall), m. */
const MAX_RUNOFF = 100;
/** Walls this far above or below the end of a road are not its cap, m. */
const RUNOFF_HEIGHT = 1.5;

/**
 * How far the road carries on past one end of a piece before its closing wall: the furthest beyond the end that
 * any wall at the end's height reaches, within the road's width of the end point. `from` is the end point's index,
 * `towards` its neighbour.
 */
export function runoffPast(piece: RoadPiece, from: number, towards: number): number {
  const path = piece.path;
  if (path.length < 2) return 0;
  const a = path[from];
  const b = path[towards];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (!(length > 0)) return 0;
  const ux = dx / length;
  const uz = dz / length;
  const reach = a.halfWidth + 1;
  let runoff = 0;
  const walls = piece.walls;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    for (let end = 0; end < 2; end++) {
      const x = end === 0 ? w.ax : w.bx;
      const z = end === 0 ? w.az : w.bz;
      const y = end === 0 ? w.ya : w.yb;
      if (!(Math.abs(y - a.y) <= RUNOFF_HEIGHT)) continue;
      const along = (x - a.x) * ux + (z - a.z) * uz;
      const across = (z - a.z) * ux - (x - a.x) * uz;
      if (along < -runoff && along >= -MAX_RUNOFF && across >= -reach && across <= reach) runoff = -along;
    }
  }
  return runoff;
}

/** Everything both kinds of world share. Subclasses add the road and may follow the car along it (`afterStep`). */
export abstract class RoadSim implements SimBase {
  params: CarParams;
  readonly car: CarState;
  tick = 0;
  /** Owned by the collider and overwritten on the next step: copy it to keep it. */
  lastCollision: CollisionEvent | null = null;
  wallDistance = Infinity;
  offTrack = false;

  protected readonly surface: SurfaceIndex = createSurfaceIndex();
  protected readonly collider: Collider = createCollider();
  /** The surface under the car after the last step or placement. */
  protected groundOnRoad = false;
  protected groundOwner = -1;
  protected groundPath = -1;
  private slopeX = 0;
  private slopeZ = 0;

  constructor(start: Pose, params: CarParams) {
    this.params = params;
    this.car = createCarState(start);
    this.car.y = start.y ?? 0;
    this.car.pitchSlope = 0;
  }

  groundHeight(x: number, z: number, fromY: number): number {
    return surfaceAt(this.surface, x, z, fromY).y;
  }

  step(input: InputState): void {
    const car = this.car;
    const params = this.params;
    const hasRoad = !surfaceEmpty(this.surface);
    const prevY = car.y;
    const wasAirborne = car.airborne;

    // 1. Slope gravity, before the move so the move stays exactly velocity x DT (collision.ts relies on it).
    const vx0 = car.vx;
    const vz0 = car.vz;
    let ax = 0;
    let az = 0;
    if (!wasAirborne && (this.slopeX !== 0 || this.slopeZ !== 0)) {
      const sx = this.slopeX;
      const sz = this.slopeZ;
      const pull = -GRAVITY / (1 + sx * sx + sz * sz);
      ax = pull * sx;
      az = pull * sz;
      car.vx += ax * DT;
      car.vz += az * DT;
    }

    // 2. The ground where the car will be, at its own level.
    let ground = car.y;
    if (hasRoad) {
      const ahead = surfaceAt(this.surface, car.x + car.vx * DT, car.z + car.vz * DT, car.y);
      ground = ahead.y;
      if (!wasAirborne && ahead.onRoad) {
        const lowest = car.y + (car.vy - SUSPENSION_ACCEL * DT) * DT;
        if (ground < lowest && ground > lowest - SUSPENSION_TRAVEL) ground = lowest;
      }
    }
    stepCar(car, params, input, DT, ground);
    if (ax !== 0 || az !== 0) this.creep(ax, az, vx0, vz0);
    const landed = wasAirborne && !car.airborne;

    // 3. Walls and props at the car's level.
    const under = surfaceAt(this.surface, car.x, car.z, car.y);
    this.lastCollision = resolveCollisions(car, params, this.collider, true, false, prevY, under.onRoad ? under.y : NaN);
    // A landing or a knock changes where the car is heading, so its wheels pick the ground up afresh.
    if (!car.airborne && (landed || this.lastCollision !== null)) this.seatOnGround(landed);

    // 4. Bookkeeping.
    this.observeGround(hasRoad);
    this.afterStep();
    this.tick++;
  }

  placeCar(pose: Pose): void {
    const car = this.car;
    resetCarState(car, pose);
    const near = nearestSurface(this.surface, pose.x, pose.z, pose.y ?? 0);
    car.y = near.onRoad || !surfaceEmpty(this.surface) ? near.y : (pose.y ?? 0);
    car.pitchSlope = 0;
    this.lastCollision = null;
    this.offTrack = false;
    this.observeGround(false);
    this.afterPlace();
  }

  /**
   * The tick, everything the next step reads, and the height state. The other derived fields follow from these;
   * `rearSlide` is here because the steering assist and the wheelspin feed on last tick's value, and `reversing`
   * because the gear is a latch.
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
    ];
  }

  /** Called at the end of every step, before the tick count moves on. */
  protected afterStep(): void {}
  /** Called at the end of every placeCar. */
  protected afterPlace(): void {}

  /** Adds a road piece and its solids under an owner id. */
  protected addRoad(owner: number, piece: RoadPiece, extendStart: number, extendEnd: number): void {
    addPiece(this.surface, owner, piece, { extendStart, extendEnd });
    addSolids(this.collider, owner, piece.walls, piece.props);
  }

  /** Adds solids that are not part of a road piece (a cap wall). */
  protected addWalls(owner: number, walls: readonly Segment[]): void {
    addSolids(this.collider, owner, walls, []);
  }

  /**
   * The rest-settling in the car step stops a coasting car slower than a walking pace dead, which on a slope would
   * hold it up for ever. When gravity along the car's nose beats what holds it there (engine braking, handbrake),
   * the car instead keeps rolling from the speed it had: it rolls back down a hill it stalled on.
   */
  private creep(ax: number, az: number, vx0: number, vz0: number): void {
    const car = this.car;
    if (car.airborne || car.vx !== 0 || car.vz !== 0 || car.yawRate !== 0 || car.throttle !== 0 || car.brake !== 0) return;
    const params = this.params;
    const c = cos(car.heading);
    const s = sin(car.heading);
    const along = ax * c + az * s;
    const hold = (params.engineForce * ENGINE.braking + (car.handbrake ? params.handbrakeForce : 0)) / params.mass;
    if (!(Math.abs(along) > hold)) return;
    let v = vx0 * c + vz0 * s + along * DT;
    v = v > 0 ? Math.max(0, v - hold * DT) : Math.min(0, v + hold * DT);
    if (v === 0) return;
    car.vx = v * c;
    car.vz = v * s;
    car.x += car.vx * DT;
    car.z += car.vz * DT;
    updateKinematics(car);
  }

  /**
   * Puts the wheels on the road where the car now is, moving up or down as the road did over the last tick of its
   * new path. Looking back, not forward: the next step compares this with the slope ahead, and it is that change of
   * slope which unloads the tyres over a crest and throws the car off it. Only onto a road within reach of the
   * wheels: pushed out over an edge, the car stays where it is and falls on the next step. After a knock (not a
   * landing) a car riding a little above the road, its suspension drooping over a crest, is left as it is: seating
   * it would forgive the droop every tick, and a car rubbing a wall over a crest would never take off.
   */
  private seatOnGround(landed: boolean): void {
    const car = this.car;
    const here = surfaceAt(this.surface, car.x, car.z, car.y);
    if (!here.onRoad || !(Math.abs(here.y - car.y) <= STEP_UP)) return;
    if (!landed && car.y >= here.y) return;
    const y = here.y;
    const behind = surfaceAt(this.surface, car.x - car.vx * DT, car.z - car.vz * DT, y);
    car.y = y;
    car.vy = behind.onRoad && Math.abs(behind.y - y) <= STEP_UP ? (y - behind.y) / DT : 0;
  }

  /** Slope, pitch, owner, offTrack and wall distance from the surface under the car. */
  private observeGround(latch: boolean): void {
    const car = this.car;
    const hit = surfaceAt(this.surface, car.x, car.z, car.y);
    this.groundOnRoad = hit.onRoad;
    this.groundOwner = hit.owner;
    this.groundPath = hit.pathIndex;
    const grounded = !car.airborne;
    this.slopeX = grounded ? hit.slopeX : 0;
    this.slopeZ = grounded ? hit.slopeZ : 0;
    car.pitchSlope = grounded && (hit.slopeX !== 0 || hit.slopeZ !== 0) ? hit.slopeX * cos(car.heading) + hit.slopeZ * sin(car.heading) : 0;
    // Resting on the city floor: fell off an edge, or flew over a barrier.
    if (latch && grounded && !hit.onRoad && car.y < TERRAIN_Y + STEP_UP) this.offTrack = true;
    this.wallDistance = nearestSolidDistance(car, this.params, this.collider, hit.onRoad ? hit.y : NaN);
  }
}

class SimWorld extends RoadSim implements World {
  readonly level: Level;

  constructor(level: Level, params: CarParams) {
    super(level.start, params);
    this.level = level;
    const last = level.path.length - 1;
    this.addRoad(0, level, runoffPast(level, 0, 1), runoffPast(level, last, last - 1));
    this.placeCar(level.start);
  }
}

/**
 * The car starts at `level.start`, at rest on the road. `params` is used as given (not copied) so a tuning panel
 * can keep editing the object it passed in; without it the world gets its own copy of the defaults.
 */
export function createWorld(level: Level, params: CarParams = cloneParams(DEFAULT_CAR_PARAMS)): World {
  return new SimWorld(level, params);
}
