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
 *
 * HEIGHTS. Roads pass over and under each other, so every solid only exists for a car at its own level:
 *  - a wall (a road barrier, see Wall) for a car whose wheels are within [base - 1, top] at the wall's closest
 *    point, where base is the wall's height there and top is WALL_HEIGHT + 0.1 above the road (above the bump the
 *    car stands on, if it stands on its own road): roads above and below never block each other, and a car that
 *    flies higher than the barrier passes over it;
 *  - a prop for a car whose wheels are within [prop.y - 1, prop.y + prop.height].
 */
import type { CarParams, CarState, CollisionEvent, Level, Prop, Segment, Wall } from '../types';
import { DT, WALL_HEIGHT } from '../types';
import { cos, sin } from '../core/fixedMath';
import { MAX_YAW_RATE, settleVelocity, updateKinematics } from './car';

declare const colliderBrand: unique symbol;

/** Made by `buildCollider` or `createCollider`. Its contents are private to this module. */
export interface Collider {
  readonly [colliderBrand]: true;
}

/** A car whose wheels are more than this above the road a wall stands on passes over the wall, m. */
export const WALL_CLEAR_HEIGHT = WALL_HEIGHT + 0.1;
/** A car whose wheels are more than this below a solid's base passes under it, m. */
export const UNDER_CLEARANCE = 1;
/** The ground under the car counts as the wall's own road (a bump on it) when within this of the wall's base, m. */
const SAME_ROAD = 1.5;
/** `nearestSolidDistance` looks this far, m. Beyond it the answer is Infinity. */
export const WALL_DISTANCE_RANGE = 8;

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
  /** ax, az, bx, bz, ya, yb per wall slot. */
  walls: Float64Array;
  wallSlots: number;
  freeWalls: number[];
  /** x, z, radius, y, height per prop slot. */
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
  /** Height filter of the current query: the car's wheels now and last tick, and the road under it (NaN: none). */
  carY: number;
  prevY: number;
  groundY: number;
  /** Where the car's centre is, for walls it was not at the height of last tick. */
  centreX: number;
  centreZ: number;
  /** Scratch of the segment-segment distance: parameter along the wall of the closest point. */
  closestT: number;
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
const WALL_STRIDE = 6;
const PROP_STRIDE = 5;
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
  const ax = grid.walls[slot * WALL_STRIDE];
  const az = grid.walls[slot * WALL_STRIDE + 1];
  const dx = grid.walls[slot * WALL_STRIDE + 2] - ax;
  const dz = grid.walls[slot * WALL_STRIDE + 3] - az;
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
  const x = grid.props[slot * PROP_STRIDE];
  const z = grid.props[slot * PROP_STRIDE + 1];
  const radius = grid.props[slot * PROP_STRIDE + 2];
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
    carY: 0,
    prevY: 0,
    groundY: NaN,
    centreX: 0,
    centreZ: 0,
    closestT: 0,
  };
  return grid as unknown as Collider;
}

function heightOr0(value: number | undefined): number {
  return value !== undefined && Math.abs(value) < 1e9 ? value : 0;
}

/**
 * Adds walls and props under an owner id (for endless road, the chunk index). An owner may be added to more than
 * once; `removeSolids` takes out everything it ever added. Costs time in proportion to what is added. A plain
 * Segment (no ya / yb) is a wall on a road at height 0.
 */
export function addSolids(collider: Collider, owner: number, walls: readonly (Segment | Wall)[], props: readonly Prop[]): void {
  const grid = collider as unknown as Grid;
  let owned = grid.owners.get(owner);
  if (!owned) {
    owned = { walls: [], props: [] };
    grid.owners.set(owner, owned);
  }
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i] as Partial<Wall> & Segment;
    const slot = grid.freeWalls.length > 0 ? (grid.freeWalls.pop() as number) : grid.wallSlots++;
    grid.walls = grown(grid.walls, grid.wallSlots * WALL_STRIDE);
    const o = slot * WALL_STRIDE;
    grid.walls[o] = wall.ax;
    grid.walls[o + 1] = wall.az;
    grid.walls[o + 2] = wall.bx;
    grid.walls[o + 3] = wall.bz;
    grid.walls[o + 4] = heightOr0(wall.ya);
    grid.walls[o + 5] = heightOr0(wall.yb);
    owned.walls.push(slot);
    markWall(grid, slot, true);
  }
  for (let i = 0; i < props.length; i++) {
    const prop = props[i] as Partial<Prop> & Prop;
    const slot = grid.freeProps.length > 0 ? (grid.freeProps.pop() as number) : grid.propSlots++;
    grid.props = grown(grid.props, grid.propSlots * PROP_STRIDE);
    const o = slot * PROP_STRIDE;
    grid.props[o] = prop.x;
    grid.props[o + 1] = prop.z;
    grid.props[o + 2] = prop.radius;
    grid.props[o + 3] = heightOr0(prop.y);
    // A prop with no height given is a pillar of any height.
    grid.props[o + 4] = prop.height >= 0 ? prop.height : Infinity;
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

/** Whether a wall whose road is at `base` (here) is solid for wheels at height `y`. */
function wallSolidFor(grid: Grid, base: number, y: number): boolean {
  const ground = grid.groundY;
  const road = ground > base && ground - base < SAME_ROAD ? ground : base;
  return y >= base - UNDER_CLEARANCE && y <= road + WALL_CLEAR_HEIGHT;
}

/**
 * Circle against one wall. `(prevX, prevZ)` is where the circle's centre was before this tick's move.
 * On contact, leaves the push-out normal and depth in the grid's scratch fields.
 *
 * A wall the car was not at the height of last tick (it was flying over it, or coming down onto it from above) has
 * no "before" side for the circle: the car's centre stands in for it, so whichever circle is across the wall from
 * the centre is brought over to the centre's side and the car comes down whole, on one side.
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
  const o = wall * WALL_STRIDE;
  const ax = grid.walls[o];
  const az = grid.walls[o + 1];
  const dx = grid.walls[o + 2] - ax;
  const dz = grid.walls[o + 3] - az;
  const lengthSq = dx * dx + dz * dz;
  let along = lengthSq > 0 ? ((cx - ax) * dx + (cz - az) * dz) / lengthSq : 0;
  along = along < 0 ? 0 : along > 1 ? 1 : along;
  const ya = grid.walls[o + 4];
  const base = ya + (grid.walls[o + 5] - ya) * along;
  if (!wallSolidFor(grid, base, grid.carY)) return false;
  if (!wallSolidFor(grid, base, grid.prevY)) {
    prevX = grid.centreX;
    prevZ = grid.centreZ;
  }

  const invLength = lengthSq > 0 ? 1 / Math.sqrt(lengthSq) : 0;
  // Twice the signed area of (a, b, point): its sign says which side of the wall the point is on.
  const sideNow = dx * (cz - az) - dz * (cx - ax);
  const sideBefore = dx * (prevZ - az) - dz * (prevX - ax);
  const towardsBefore = sideBefore < 0 ? -invLength : invLength;

  if (sideNow * sideBefore < 0) {
    const t = sideBefore / (sideBefore - sideNow);
    const crossing = ((prevX + (cx - prevX) * t - ax) * dx + (prevZ + (cz - prevZ) * t - az) * dz) / lengthSq;
    if (crossing >= -JOINT_SLACK && crossing <= 1 + JOINT_SLACK) {
      grid.nx = -dz * towardsBefore;
      grid.nz = dx * towardsBefore;
      grid.depth = radius + Math.abs(sideNow) * invLength;
      return true;
    }
  }

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

/** Whether a prop is solid for wheels at height `y`. */
function propSolidFor(grid: Grid, prop: number, y: number): boolean {
  const base = grid.props[prop * PROP_STRIDE + 3];
  return y >= base - UNDER_CLEARANCE && y <= base + grid.props[prop * PROP_STRIDE + 4];
}

/** Circle against one round prop. */
function hitProp(grid: Grid, prop: number, cx: number, cz: number, radius: number): boolean {
  const o = prop * PROP_STRIDE;
  const offX = cx - grid.props[o];
  const offZ = cz - grid.props[o + 1];
  const reach = radius + grid.props[o + 2];
  const distSq = offX * offX + offZ * offZ;
  if (distSq >= reach * reach || distSq <= TOUCHING_EPSILON) return false;
  if (!propSolidFor(grid, prop, grid.carY)) return false;
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
    grid.centreX = car.x;
    grid.centreZ = car.z;
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
 * Heights (see the top of this file): `car.y` is where the wheels are now, `prevY` where they were before the
 * step (default: the same), and `groundY` the road surface under the car (NaN when it is over no road), which lets
 * a car on a bump next to a wall still meet it.
 *
 * A wall the car was not at the height of last tick (by `prevY`) has no "before" side: see `hitWall`. Without that
 * a car that turned while flying over a wall could come down with its nose and tail on opposite sides, each held on
 * the side it happens to be on, pinned across the wall for good.
 *
 * Legacy switches: `walls = false` ignores every wall; `regroup = true` takes the front and rear circles to have
 * come from the car's centre for every wall.
 */
export function resolveCollisions(
  car: CarState,
  params: CarParams,
  collider: Collider,
  walls = true,
  regroup = false,
  prevY: number = car.y,
  groundY = NaN,
): CollisionEvent | null {
  const grid = collider as unknown as Grid;
  // A body with no size, or a nonsense one from a half-typed tuning value, touches nothing.
  if (!(params.collisionRadius > 0 && params.collisionRadius < Infinity)) return null;
  grid.carY = car.y;
  grid.prevY = prevY;
  grid.groundY = groundY;
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

/**
 * Squared distance between segments p0..p1 and a0..a1 (Ericson, Real-Time Collision Detection 5.1.9). Leaves the
 * parameter of the closest point along a0..a1 in `grid.closestT`.
 */
function segmentDistanceSq(
  grid: Grid,
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  a0x: number,
  a0z: number,
  a1x: number,
  a1z: number,
): number {
  const d1x = p1x - p0x;
  const d1z = p1z - p0z;
  const d2x = a1x - a0x;
  const d2z = a1z - a0z;
  const rx = p0x - a0x;
  const rz = p0z - a0z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    t = f / e;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-12) {
      s = -c / a;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      if (denom > 1e-12) {
        s = (b * f - c * e) / denom;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = -c / a;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      } else if (t > 1) {
        t = 1;
        s = (b - c) / a;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      }
    }
  }
  grid.closestT = t;
  const ox = p0x + d1x * s - (a0x + d2x * t);
  const oz = p0z + d1z * s - (a0z + d2z * t);
  return ox * ox + oz * oz;
}

/**
 * Gap between the car's body (its collision circles, taken as the capsule through them) and the nearest wall or prop
 * that is solid for it at its height (see the top of this file), m: 0 when touching, Infinity beyond
 * WALL_DISTANCE_RANGE. `groundY` as in `resolveCollisions`. Allocates nothing.
 */
export function nearestSolidDistance(car: CarState, params: CarParams, collider: Collider, groundY = NaN): number {
  const grid = collider as unknown as Grid;
  const radius = params.collisionRadius;
  if (!(radius >= 0 && radius < Infinity) || !(Math.abs(car.x) < 1e9 && Math.abs(car.z) < 1e9)) return Infinity;
  grid.carY = car.y;
  grid.groundY = groundY;
  const reach = Math.max(0, params.halfLength - radius);
  const cosH = cos(car.heading);
  const sinH = sin(car.heading);
  const p0x = car.x - reach * cosH;
  const p0z = car.z - reach * sinH;
  const p1x = car.x + reach * cosH;
  const p1z = car.z + reach * sinH;
  const look = reach + radius + WALL_DISTANCE_RANGE;
  const colFrom = Math.floor((car.x - look) * INV_CELL);
  const rowFrom = Math.floor((car.z - look) * INV_CELL);
  const cols = Math.floor((car.x + look) * INV_CELL) - colFrom;
  const rows = Math.floor((car.z + look) * INV_CELL) - rowFrom;
  const limit = WALL_DISTANCE_RANGE + radius;
  let best = limit * limit;
  let found = false;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const list = grid.cells.get(cellKey(colFrom + c, rowFrom + r));
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (item >= 0) {
          const o = item * WALL_STRIDE;
          const ax = grid.walls[o];
          const az = grid.walls[o + 1];
          const bx = grid.walls[o + 2];
          const bz = grid.walls[o + 3];
          const distSq = segmentDistanceSq(grid, p0x, p0z, p1x, p1z, ax, az, bx, bz);
          if (!(distSq < best)) continue;
          const ya = grid.walls[o + 4];
          if (!wallSolidFor(grid, ya + (grid.walls[o + 5] - ya) * grid.closestT, car.y)) continue;
          best = distSq;
          found = true;
        } else {
          const prop = -1 - item;
          const o = prop * PROP_STRIDE;
          const px = grid.props[o];
          const pz = grid.props[o + 1];
          const distSq = segmentDistanceSq(grid, px, pz, px, pz, p0x, p0z, p1x, p1z);
          const dist = Math.sqrt(distSq) - grid.props[o + 2];
          const clear = dist > 0 ? dist * dist : 0;
          if (!(clear < best) || !propSolidFor(grid, prop, car.y)) continue;
          best = clear;
          found = true;
        }
      }
    }
  }
  if (!found) return Infinity;
  const gap = Math.sqrt(best) - radius;
  return gap > 0 ? gap : 0;
}
