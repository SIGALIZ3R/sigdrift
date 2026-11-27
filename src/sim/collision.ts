/**
 * Car against walls (segments) and props (circles).
 *
 * The car body is three circles along its length. Each tick, after the car has moved, every circle is pushed out of
 * whatever it overlaps and the car's velocity gets an impulse at that circle. Walls have no thickness, so each wall
 * test also checks whether the circle's centre went through the wall during the tick and, if so, sends it back to
 * the side it came from: the car cannot tunnel however fast it moves.
 */
import type { CarParams, CarState, CollisionEvent, Level, Prop, Segment } from '../types';
import { DT } from '../types';
import { cos, sin } from '../core/fixedMath';
import { MAX_YAW_RATE, settleVelocity, updateKinematics } from './car';

declare const colliderBrand: unique symbol;

/** Built once per level by `buildCollider`. Its contents are private to this module. */
export interface Collider {
  readonly [colliderBrand]: true;
}

/**
 * Uniform grid in compressed-row form: the items of cell `c` are `items[cellStart[c] .. cellStart[c + 1])`.
 * Item ids below `wallCount` are walls, the rest are props.
 */
interface Grid {
  minX: number;
  minZ: number;
  invCell: number;
  cols: number;
  rows: number;
  cellStart: Int32Array;
  items: Int32Array;
  /** ax, az, bx, bz per wall. */
  walls: Float64Array;
  wallCount: number;
  /** x, z, radius per prop. */
  props: Float64Array;
  /** Scratch: the contact found by the latest overlap test. */
  nx: number;
  nz: number;
  depth: number;
  /** Scratch: whether this tick has touched anything, and its hardest contact so far. */
  touched: boolean;
  event: CollisionEvent;
}

const MIN_CELL_SIZE = 6;
const MAX_CELLS = 1 << 18;
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

function packWalls(walls: readonly Segment[]): Float64Array {
  const packed = new Float64Array(walls.length * 4);
  walls.forEach((w, i) => packed.set([w.ax, w.az, w.bx, w.bz], i * 4));
  return packed;
}

function packProps(props: readonly Prop[]): Float64Array {
  const packed = new Float64Array(props.length * 3);
  props.forEach((p, i) => packed.set([p.x, p.z, p.radius], i * 3));
  return packed;
}

function cellIndex(coordinate: number, origin: number, invCell: number, count: number): number {
  const index = Math.floor((coordinate - origin) * invCell);
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

/** Appends (cell, item) for every cell the box touches, skipping cells that already hold the item. */
function addBox(
  grid: Grid,
  pairs: number[],
  lastItem: Int32Array,
  item: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): void {
  const colFrom = cellIndex(Math.min(x0, x1), grid.minX, grid.invCell, grid.cols);
  const colTo = cellIndex(Math.max(x0, x1), grid.minX, grid.invCell, grid.cols);
  const rowFrom = cellIndex(Math.min(z0, z1), grid.minZ, grid.invCell, grid.rows);
  const rowTo = cellIndex(Math.max(z0, z1), grid.minZ, grid.invCell, grid.rows);
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let col = colFrom; col <= colTo; col++) {
      const cell = row * grid.cols + col;
      if (lastItem[cell] === item) continue;
      lastItem[cell] = item;
      pairs.push(cell, item);
    }
  }
}

/** A long diagonal wall is added piece by piece so it only lands in the cells near it, not its whole bounding box. */
function addWall(grid: Grid, pairs: number[], lastItem: Int32Array, wall: number): void {
  const ax = grid.walls[wall * 4];
  const az = grid.walls[wall * 4 + 1];
  const dx = grid.walls[wall * 4 + 2] - ax;
  const dz = grid.walls[wall * 4 + 3] - az;
  const pieces = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) * grid.invCell));
  for (let i = 0; i < pieces; i++) {
    const from = i / pieces;
    const to = (i + 1) / pieces;
    addBox(grid, pairs, lastItem, wall, ax + dx * from, az + dz * from, ax + dx * to, az + dz * to);
  }
}

function fillCells(grid: Grid, pairs: readonly number[]): void {
  const cellStart = new Int32Array(grid.cols * grid.rows + 1);
  for (let i = 0; i < pairs.length; i += 2) cellStart[pairs[i] + 1]++;
  for (let cell = 0; cell < cellStart.length - 1; cell++) cellStart[cell + 1] += cellStart[cell];
  const items = new Int32Array(pairs.length / 2);
  const next = cellStart.slice(0, -1);
  for (let i = 0; i < pairs.length; i += 2) items[next[pairs[i]]++] = pairs[i + 1];
  grid.cellStart = cellStart;
  grid.items = items;
}

/** Bounds of everything solid, falling back to the level's own bounds when there is nothing to hit. */
function solidBounds(level: Level, walls: Float64Array, props: Float64Array): Level['bounds'] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const include = (x: number, z: number, pad: number): void => {
    minX = Math.min(minX, x - pad);
    minZ = Math.min(minZ, z - pad);
    maxX = Math.max(maxX, x + pad);
    maxZ = Math.max(maxZ, z + pad);
  };
  for (let i = 0; i < walls.length; i += 2) include(walls[i], walls[i + 1], 0);
  for (let i = 0; i < props.length; i += 3) include(props[i], props[i + 1], props[i + 2]);
  return minX <= maxX && minZ <= maxZ ? { minX, minZ, maxX, maxZ } : level.bounds;
}

/** Builds the lookup grid over `level.walls` and `level.props`. */
export function buildCollider(level: Level): Collider {
  const walls = packWalls(level.walls);
  const props = packProps(level.props);
  const bounds = solidBounds(level, walls, props);
  const width = Math.max(bounds.maxX - bounds.minX, MIN_CELL_SIZE);
  const depth = Math.max(bounds.maxZ - bounds.minZ, MIN_CELL_SIZE);
  const cell = Math.max(MIN_CELL_SIZE, Math.sqrt((width * depth) / MAX_CELLS));
  const grid: Grid = {
    minX: bounds.minX,
    minZ: bounds.minZ,
    invCell: 1 / cell,
    cols: Math.max(1, Math.ceil(width / cell)),
    rows: Math.max(1, Math.ceil(depth / cell)),
    cellStart: new Int32Array(0),
    items: new Int32Array(0),
    walls,
    wallCount: level.walls.length,
    props,
    nx: 0,
    nz: 0,
    depth: 0,
    touched: false,
    event: { x: 0, z: 0, nx: 0, nz: 0, impact: 0 },
  };

  const pairs: number[] = [];
  const lastItem = new Int32Array(grid.cols * grid.rows).fill(-1);
  for (let wall = 0; wall < grid.wallCount; wall++) addWall(grid, pairs, lastItem, wall);
  for (let i = 0; i < level.props.length; i++) {
    const p = level.props[i];
    addBox(grid, pairs, lastItem, grid.wallCount + i, p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius);
  }
  fillCells(grid, pairs);
  return grid as unknown as Collider;
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
function deepestHit(grid: Grid, cx: number, cz: number, prevX: number, prevZ: number, radius: number): boolean {
  const colFrom = cellIndex(Math.min(cx, prevX) - radius, grid.minX, grid.invCell, grid.cols);
  const colTo = cellIndex(Math.max(cx, prevX) + radius, grid.minX, grid.invCell, grid.cols);
  const rowFrom = cellIndex(Math.min(cz, prevZ) - radius, grid.minZ, grid.invCell, grid.rows);
  const rowTo = cellIndex(Math.max(cz, prevZ) + radius, grid.minZ, grid.invCell, grid.rows);
  let depth = 0;
  let nx = 0;
  let nz = 0;
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let col = colFrom; col <= colTo; col++) {
      const cell = row * grid.cols + col;
      for (let i = grid.cellStart[cell]; i < grid.cellStart[cell + 1]; i++) {
        const item = grid.items[i];
        const hit =
          item < grid.wallCount
            ? hitWall(grid, item, cx, cz, prevX, prevZ, radius)
            : hitProp(grid, item - grid.wallCount, cx, cz, radius);
        if (hit && grid.depth > depth) {
          depth = grid.depth;
          nx = grid.nx;
          nz = grid.nz;
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
): boolean {
  const radius = params.collisionRadius;
  let touched = false;
  for (let contact = 0; contact < MAX_CONTACTS; contact++) {
    if (!deepestHit(grid, car.x + offset * cosH, car.z + offset * sinH, prevX, prevZ, radius)) break;
    respond(grid, car, params, offset, cosH, sinH, radius);
    touched = true;
  }
  return touched;
}

/**
 * Call once per tick, after `stepCar`. Returns the hardest contact of the tick, or null if the car touched nothing.
 * The returned object belongs to the collider and is overwritten by the next call: copy it to keep it.
 */
export function resolveCollisions(car: CarState, params: CarParams, collider: Collider): CollisionEvent | null {
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
      const fromX = prevX + offset * prevCos;
      const fromZ = prevZ + offset * prevSin;
      if (resolveCircle(grid, car, params, offset, cosH, sinH, fromX, fromZ)) touched = true;
    }
    if (!touched) break;
  }
  if (!grid.touched) return null;
  settleVelocity(car, false);
  updateKinematics(car);
  return grid.event;
}
