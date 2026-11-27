/**
 * Car against walls (segments) and props (circles).
 *
 * The car body is three circles along its length. Each tick, after the car has moved, every circle is pushed out of
 * whatever it overlaps and the car's velocity gets an impulse at that circle. Walls have no thickness, so each wall
 * test also checks whether the circle's centre went through the wall during the tick and, if so, sends it back to
 * the side it came from: the car cannot tunnel however fast it moves.
 *
 * Walls and props live in an unbounded hash grid and belong to an owner (a level, or one chunk of endless road),
 * so an owner's geometry can be added and removed without touching anyone else's.
 */
import type { CarParams, CarState, CollisionEvent, Level, Prop, Segment } from '../types';
import { DT } from '../types';
import { cos, sin } from '../core/fixedMath';
import { MAX_YAW_RATE, settleVelocity, updateKinematics } from './car';

declare const colliderBrand: unique symbol;

/** Made by `buildCollider` or `createCollider`. Its contents are private to this module. */
export interface Collider {
  readonly [colliderBrand]: true;
}

/**
 * Walls are 0.7 m high. A car whose wheels are more than this far above the ground under it passes over them;
 * props (pillars) are tall and always solid. The caller decides: see `resolveCollisions`.
 */
export const WALL_CLEAR_HEIGHT = 0.8;

/** What one owner put into the grid, so that it can be taken out again. */
interface Owned {
  walls: number[];
  props: number[];
}

/**
 * Hash grid of square cells. A cell's list holds wall slots as they are and prop slots as `-1 - slot`.
 * Slots are reused once their owner has been removed.
 */
interface Grid {
  cells: Map<number, number[]>;
  /** ax, az, bx, bz per wall slot. */
  walls: Float64Array;
  wallSlots: number;
  freeWalls: number[];
  /** x, z, radius per prop slot. */
  props: Float64Array;
  propSlots: number;
  freeProps: number[];
  owners: Map<number, Owned>;
  /** Scratch: the contact found by the latest overlap test. */
  nx: number;
  nz: number;
  depth: number;
  /** Scratch: whether this tick has touched anything, and its hardest contact so far. */
  touched: boolean;
  event: CollisionEvent;
}

const CELL_SIZE = 8;
const INV_CELL = 1 / CELL_SIZE;
/**
 * Cell coordinates are wrapped into 15 bits each, so a key is a small integer whatever the coordinates. Cells
 * 262 km apart share a list, which only costs a wasted test: everything solid at any one time is far closer together.
 */
const CELL_MASK = 0x7fff;
const CELL_BITS = 15;
/** A query wider than this many cells is nonsense (a broken state); it finds nothing rather than loop for ever. */
const MAX_QUERY_SPAN = 64;
/** Push-out passes over the whole body per tick, and contacts per circle per pass. Corners need more than one. */
const MAX_PASSES = 3;
const MAX_CONTACTS = 3;
/** Extra push-out so a resolved circle is clear of the surface rather than exactly on it. */
const SKIN = 1e-6;
/** Share of the physically correct spin an impact gives the car. Full strength makes every wall tap a spin. */
const YAW_KICK = 0.5;
/** Most yaw rate (rad/s) one impact may add, however hard. */
const MAX_YAW_KICK = 2.5;
const TOUCHING_EPSILON = 1e-9;
/** Slack on a wall's ends for the went-through test, so a path through the joint of two walls is caught by both. */
const JOINT_SLACK = 1e-9;

function cellKey(col: number, row: number): number {
  return ((col & CELL_MASK) << CELL_BITS) | (row & CELL_MASK);
}

function grown(array: Float64Array, length: number): Float64Array {
  if (array.length >= length) return array;
  const bigger = new Float64Array(Math.max(length, array.length * 2, 64));
  bigger.set(array);
  return bigger;
}

/** Adds `item` to, or takes it out of, every cell the box touches. Cell lists keep their order. */
function markBox(grid: Grid, item: number, add: boolean, x0: number, z0: number, x1: number, z1: number): void {
  const colFrom = Math.floor(Math.min(x0, x1) * INV_CELL);
  const rowFrom = Math.floor(Math.min(z0, z1) * INV_CELL);
  const cols = Math.floor(Math.max(x0, x1) * INV_CELL) - colFrom;
  const rows = Math.floor(Math.max(z0, z1) * INV_CELL) - rowFrom;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const key = cellKey(colFrom + c, rowFrom + r);
      const list = grid.cells.get(key);
      if (add) {
        if (!list) grid.cells.set(key, [item]);
        else if (list[list.length - 1] !== item && list.indexOf(item) < 0) list.push(item);
      } else if (list) {
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) grid.cells.delete(key);
      }
    }
  }
}

/** A long diagonal wall is marked piece by piece so it only lands in the cells near it, not its whole bounding box. */
function markWall(grid: Grid, slot: number, add: boolean): void {
  const ax = grid.walls[slot * 4];
  const az = grid.walls[slot * 4 + 1];
  const dx = grid.walls[slot * 4 + 2] - ax;
  const dz = grid.walls[slot * 4 + 3] - az;
  const length = Math.sqrt(dx * dx + dz * dz);
  // A wall with a coordinate that is not a number, or of absurd length, is left out: it could never be hit anyway.
  if (!(length < 1e7)) return;
  const pieces = Math.max(1, Math.ceil(length * INV_CELL));
  for (let i = 0; i < pieces; i++) {
    const from = i / pieces;
    const to = (i + 1) / pieces;
    markBox(grid, slot, add, ax + dx * from, az + dz * from, ax + dx * to, az + dz * to);
  }
}

function markProp(grid: Grid, slot: number, add: boolean): void {
  const x = grid.props[slot * 3];
  const z = grid.props[slot * 3 + 1];
  const radius = grid.props[slot * 3 + 2];
  if (!(radius >= 0 && radius < 500 && Math.abs(x) < Infinity && Math.abs(z) < Infinity)) return;
  markBox(grid, -1 - slot, add, x - radius, z - radius, x + radius, z + radius);
}

/** An empty collider, to be filled with `addSolids`. */
export function createCollider(): Collider {
  const grid: Grid = {
    cells: new Map(),
    walls: new Float64Array(0),
    wallSlots: 0,
    freeWalls: [],
    props: new Float64Array(0),
    propSlots: 0,
    freeProps: [],
    owners: new Map(),
    nx: 0,
    nz: 0,
    depth: 0,
    touched: false,
    event: { x: 0, z: 0, nx: 0, nz: 0, impact: 0 },
  };
  return grid as unknown as Collider;
}

/**
 * Adds walls and props under an owner id (for endless road, the chunk index). An owner may be added to more than
 * once; `removeSolids` takes out everything it ever added. Costs time in proportion to what is added.
 */
export function addSolids(collider: Collider, owner: number, walls: readonly Segment[], props: readonly Prop[]): void {
  const grid = collider as unknown as Grid;
  let owned = grid.owners.get(owner);
  if (!owned) {
    owned = { walls: [], props: [] };
    grid.owners.set(owner, owned);
  }
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    const slot = grid.freeWalls.length > 0 ? (grid.freeWalls.pop() as number) : grid.wallSlots++;
    grid.walls = grown(grid.walls, grid.wallSlots * 4);
    grid.walls[slot * 4] = wall.ax;
    grid.walls[slot * 4 + 1] = wall.az;
    grid.walls[slot * 4 + 2] = wall.bx;
    grid.walls[slot * 4 + 3] = wall.bz;
    owned.walls.push(slot);
    markWall(grid, slot, true);
  }
  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    const slot = grid.freeProps.length > 0 ? (grid.freeProps.pop() as number) : grid.propSlots++;
    grid.props = grown(grid.props, grid.propSlots * 3);
    grid.props[slot * 3] = prop.x;
    grid.props[slot * 3 + 1] = prop.z;
    grid.props[slot * 3 + 2] = prop.radius;
    owned.props.push(slot);
    markProp(grid, slot, true);
  }
}

/** Removes everything `owner` added. Unknown owners are ignored. Costs time in proportion to what is removed. */
export function removeSolids(collider: Collider, owner: number): void {
  const grid = collider as unknown as Grid;
  const owned = grid.owners.get(owner);
  if (!owned) return;
  for (let i = 0; i < owned.walls.length; i++) {
    markWall(grid, owned.walls[i], false);
    grid.freeWalls.push(owned.walls[i]);
  }
  for (let i = 0; i < owned.props.length; i++) {
    markProp(grid, owned.props[i], false);
    grid.freeProps.push(owned.props[i]);
  }
  grid.owners.delete(owner);
}

/** How many walls and props are in the collider, and how many grid cells they occupy. For tests and diagnostics. */
export function colliderStats(collider: Collider): { walls: number; props: number; cells: number; owners: number } {
  const grid = collider as unknown as Grid;
  return {
    walls: grid.wallSlots - grid.freeWalls.length,
    props: grid.propSlots - grid.freeProps.length,
    cells: grid.cells.size,
    owners: grid.owners.size,
  };
}

/** A collider holding `level.walls` and `level.props`, for a fixed level. */
export function buildCollider(level: Level): Collider {
  const collider = createCollider();
  addSolids(collider, 0, level.walls, level.props);
  return collider;
}

/**
 * Circle against one wall. `(prevX, prevZ)` is where the circle's centre was before this tick's move.
 * On contact, leaves the push-out normal and depth in the grid's scratch fields.
 */
function hitWall(
  grid: Grid,
  wall: number,
  cx: number,
  cz: number,
  prevX: number,
  prevZ: number,
  radius: number,
): boolean {
  const ax = grid.walls[wall * 4];
  const az = grid.walls[wall * 4 + 1];
  const dx = grid.walls[wall * 4 + 2] - ax;
  const dz = grid.walls[wall * 4 + 3] - az;
  const lengthSq = dx * dx + dz * dz;
  const invLength = lengthSq > 0 ? 1 / Math.sqrt(lengthSq) : 0;
  // Twice the signed area of (a, b, point): its sign says which side of the wall the point is on.
  const sideNow = dx * (cz - az) - dz * (cx - ax);
  const sideBefore = dx * (prevZ - az) - dz * (prevX - ax);
  const towardsBefore = sideBefore < 0 ? -invLength : invLength;

  if (sideNow * sideBefore < 0) {
    const t = sideBefore / (sideBefore - sideNow);
    const along = ((prevX + (cx - prevX) * t - ax) * dx + (prevZ + (cz - prevZ) * t - az) * dz) / lengthSq;
    if (along >= -JOINT_SLACK && along <= 1 + JOINT_SLACK) {
      grid.nx = -dz * towardsBefore;
      grid.nz = dx * towardsBefore;
      grid.depth = radius + Math.abs(sideNow) * invLength;
      return true;
    }
  }

  let along = lengthSq > 0 ? ((cx - ax) * dx + (cz - az) * dz) / lengthSq : 0;
  along = along < 0 ? 0 : along > 1 ? 1 : along;
  const offX = cx - (ax + dx * along);
  const offZ = cz - (az + dz * along);
  const distSq = offX * offX + offZ * offZ;
  if (distSq >= radius * radius) return false;
  if (distSq > TOUCHING_EPSILON) {
    const dist = Math.sqrt(distSq);
    grid.nx = offX / dist;
    grid.nz = offZ / dist;
    grid.depth = radius - dist;
  } else if (invLength > 0) {
    grid.nx = -dz * towardsBefore;
    grid.nz = dx * towardsBefore;
    grid.depth = radius;
  } else {
    return false;
  }
  return true;
}

/** Circle against one round prop. */
function hitProp(grid: Grid, prop: number, cx: number, cz: number, radius: number): boolean {
  const offX = cx - grid.props[prop * 3];
  const offZ = cz - grid.props[prop * 3 + 1];
  const reach = radius + grid.props[prop * 3 + 2];
  const distSq = offX * offX + offZ * offZ;
  if (distSq >= reach * reach || distSq <= TOUCHING_EPSILON) return false;
  const dist = Math.sqrt(distSq);
  grid.nx = offX / dist;
  grid.nz = offZ / dist;
  grid.depth = reach - dist;
  return true;
}

/**
 * Pushes the car out along the contact normal and bounces it. `offset` is the hit circle's position along the
 * car's nose (negative = behind the centre), which is the lever arm that turns an off-centre hit into spin.
 */
function respond(
  grid: Grid,
  car: CarState,
  params: CarParams,
  offset: number,
  cosH: number,
  sinH: number,
  radius: number,
): void {
  const nx = grid.nx;
  const nz = grid.nz;
  car.x += nx * (grid.depth + SKIN);
  car.z += nz * (grid.depth + SKIN);

  const lever = offset * (cosH * nz - sinH * nx);
  const closing = -(car.vx * nx + car.vz * nz + car.yawRate * lever);
  if (closing > 0) {
    const invMass = 1 / params.mass;
    const rebound = (1 + params.restitution) * closing;
    // The share of the true spin shrinks on hard hits so that no single impact adds more than MAX_YAW_KICK.
    const uncapped = (YAW_KICK * Math.abs(lever) * rebound * params.mass) / params.inertia;
    const share = uncapped > MAX_YAW_KICK ? (YAW_KICK * MAX_YAW_KICK) / uncapped : YAW_KICK;
    const spinPerImpulse = (share * lever) / params.inertia;
    const impulse = rebound / (invMass + spinPerImpulse * lever);
    const bounce = impulse * invMass;
    car.vx += nx * bounce;
    car.vz += nz * bounce;
    const yawRate = car.yawRate + spinPerImpulse * impulse;
    car.yawRate = yawRate > MAX_YAW_RATE ? MAX_YAW_RATE : yawRate < -MAX_YAW_RATE ? -MAX_YAW_RATE : yawRate;

    // Coulomb friction: the harder the hit, the more speed along the wall it costs. A light scrape costs little.
    const alongWall = car.vz * nx - car.vx * nz;
    const scrub = Math.min(Math.abs(alongWall), params.wallFriction * bounce);
    const change = alongWall < 0 ? scrub : -scrub;
    car.vx -= nz * change;
    car.vz += nx * change;
  }

  const impact = closing > 0 ? closing : 0;
  if (!grid.touched || impact > grid.event.impact) {
    grid.touched = true;
    grid.event.x = car.x + offset * cosH - nx * radius;
    grid.event.z = car.z + offset * sinH - nz * radius;
    grid.event.nx = nx;
    grid.event.nz = nz;
    grid.event.impact = impact;
  }
}

/**
 * Finds the deepest overlap of one body circle with anything near its path this tick and leaves it in the grid's
 * scratch fields. Deepest first matters where two walls meet: the wall the car is actually leaning on is deeper
 * than the end of its neighbour, and once it is resolved the neighbour's end no longer touches, so the car slides
 * over the joint instead of snagging on it.
 */
function deepestHit(
  grid: Grid,
  cx: number,
  cz: number,
  prevX: number,
  prevZ: number,
  radius: number,
  walls: boolean,
): boolean {
  const colFrom = Math.floor((Math.min(cx, prevX) - radius) * INV_CELL);
  const rowFrom = Math.floor((Math.min(cz, prevZ) - radius) * INV_CELL);
  const cols = Math.floor((Math.max(cx, prevX) + radius) * INV_CELL) - colFrom;
  const rows = Math.floor((Math.max(cz, prevZ) + radius) * INV_CELL) - rowFrom;
  let depth = 0;
  let nx = 0;
  let nz = 0;
  if (cols <= MAX_QUERY_SPAN && rows <= MAX_QUERY_SPAN) {
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const list = grid.cells.get(cellKey(colFrom + c, rowFrom + r));
        if (list === undefined) continue;
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          const hit =
            item >= 0
              ? walls && hitWall(grid, item, cx, cz, prevX, prevZ, radius)
              : hitProp(grid, -1 - item, cx, cz, radius);
          if (hit && grid.depth > depth) {
            depth = grid.depth;
            nx = grid.nx;
            nz = grid.nz;
          }
        }
      }
    }
  }
  grid.depth = depth;
  grid.nx = nx;
  grid.nz = nz;
  return depth > 0;
}

/** Pushes one body circle out of everything it overlaps, deepest first. Returns whether it touched anything. */
function resolveCircle(
  grid: Grid,
  car: CarState,
  params: CarParams,
  offset: number,
  cosH: number,
  sinH: number,
  prevX: number,
  prevZ: number,
  walls: boolean,
): boolean {
  const radius = params.collisionRadius;
  let touched = false;
  for (let contact = 0; contact < MAX_CONTACTS; contact++) {
    if (!deepestHit(grid, car.x + offset * cosH, car.z + offset * sinH, prevX, prevZ, radius, walls)) break;
    respond(grid, car, params, offset, cosH, sinH, radius);
    touched = true;
  }
  return touched;
}

/**
 * Call once per tick, after `stepCar`. Returns the hardest contact of the tick, or null if the car touched nothing.
 * The returned object belongs to the collider and is overwritten by the next call: copy it to keep it.
 *
 * Pass `walls = false` while the car is flying higher than WALL_CLEAR_HEIGHT above the ground: it then passes over
 * walls and only props stop it.
 *
 * Pass `regroup = true` on the first tick the walls are solid again after such a flight. While they were not, the
 * car may have turned so that its nose and tail are on opposite sides of a wall, and each circle on its own would
 * then be held on the side it happens to be on, pinning the car across the wall for good. On this one tick the
 * front and rear circles are instead taken to have come from where the car's centre is, so whichever of them is
 * across a wall from the centre is brought over to the centre's side: the car comes down whole, on one side.
 */
export function resolveCollisions(
  car: CarState,
  params: CarParams,
  collider: Collider,
  walls = true,
  regroup = false,
): CollisionEvent | null {
  const grid = collider as unknown as Grid;
  // A body with no size, or a nonsense one from a half-typed tuning value, touches nothing.
  if (!(params.collisionRadius > 0 && params.collisionRadius < Infinity)) return null;
  const reach = Math.max(0, params.halfLength - params.collisionRadius);
  const cosH = cos(car.heading);
  const sinH = sin(car.heading);
  // stepCar moved the car by exactly velocity * DT, so the pose before the move can be recovered from the state.
  const prevHeading = car.heading - car.yawRate * DT;
  const prevCos = cos(prevHeading);
  const prevSin = sin(prevHeading);
  const prevX = car.x - car.vx * DT;
  const prevZ = car.z - car.vz * DT;

  grid.touched = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let touched = false;
    for (let circle = -1; circle <= 1; circle++) {
      const offset = circle * reach;
      const fromCentre = regroup && circle !== 0;
      const fromX = fromCentre ? car.x : prevX + offset * prevCos;
      const fromZ = fromCentre ? car.z : prevZ + offset * prevSin;
      if (resolveCircle(grid, car, params, offset, cosH, sinH, fromX, fromZ, walls)) touched = true;
    }
    if (!touched) break;
  }
  if (!grid.touched) return null;
  settleVelocity(car, false);
  updateKinematics(car);
  return grid.event;
}
