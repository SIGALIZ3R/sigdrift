/**
 * Hand-built levels and endless-road chunks for tests: no generator involved, so sim tests do not depend on src/gen.
 */
import type { Bump, Gate, Level, PathPoint, Pose, Segment, TrackChunk, Vec2 } from '../../src/types';
import { GEN_VERSION } from '../../src/types';

const PATH_SPACING = 2;
/** Clear road behind the start pad and beyond the goal line before the closing walls. */
const END_MARGIN = 6;

function straightPath(fromX: number, toX: number, halfWidth: number): PathPoint[] {
  const steps = Math.max(1, Math.round((toX - fromX) / PATH_SPACING));
  const path: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const dist = ((toX - fromX) * i) / steps;
    path.push({ x: fromX + dist, z: 0, halfWidth, dist });
  }
  return path;
}

/** Travelling along +x, left is -z and right is +z. */
function edge(path: PathPoint[], side: -1 | 1): Vec2[] {
  return path.map((p) => ({ x: p.x, z: side * p.halfWidth }));
}

function polyline(points: Vec2[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({ ax: points[i - 1].x, az: points[i - 1].z, bx: points[i].x, bz: points[i].z });
  }
  return segments;
}

function gateAt(path: PathPoint[], pathIndex: number): Gate {
  const p = path[pathIndex];
  return {
    ax: p.x,
    az: -p.halfWidth,
    bx: p.x,
    bz: p.halfWidth,
    pathIndex,
    respawn: { x: p.x, z: 0, heading: 0 },
  };
}

function assemble(id: string, path: PathPoint[], walls: Segment[], bounds: Level['bounds']): Level {
  const last = path.length - 1;
  return {
    id,
    seed: id,
    genVersion: GEN_VERSION,
    path,
    left: edge(path, -1),
    right: edge(path, 1),
    walls,
    props: [],
    decor: [],
    start: { x: path[0].x, z: 0, heading: 0 },
    checkpoints: [gateAt(path, Math.floor(last / 2))],
    goal: gateAt(path, last),
    bounds,
    length: path[last].dist,
  };
}

/**
 * A straight road along +x. The start pad is at the origin, the goal line `lengthM` further on, and the road is
 * closed by a wall 6 m behind the start and 6 m beyond the goal.
 */
export function makeStraightLevel(lengthM: number, halfWidth: number): Level {
  const path = straightPath(0, lengthM, halfWidth);
  const minX = -END_MARGIN;
  const maxX = lengthM + END_MARGIN;
  const leftEdge = [{ x: minX, z: -halfWidth }, ...edge(path, -1), { x: maxX, z: -halfWidth }];
  const rightEdge = [{ x: minX, z: halfWidth }, ...edge(path, 1), { x: maxX, z: halfWidth }];
  const walls = [
    ...polyline(leftEdge),
    ...polyline(rightEdge),
    { ax: minX, az: -halfWidth, bx: minX, bz: halfWidth },
    { ax: maxX, az: -halfWidth, bx: maxX, bz: halfWidth },
  ];
  return assemble(`straight-${lengthM}x${halfWidth}`, path, walls, { minX, minZ: -halfWidth, maxX, maxZ: halfWidth });
}

/**
 * A walled square of side `sizeM` centred on the origin, with the start pad in the middle facing +x. The "road" is
 * the whole square: its centreline runs from the start towards the +x wall.
 */
export function makeOpenLevel(sizeM: number): Level {
  const half = sizeM / 2;
  const path = straightPath(0, Math.max(PATH_SPACING, half - END_MARGIN), half);
  const corners: Vec2[] = [
    { x: -half, z: -half },
    { x: half, z: -half },
    { x: half, z: half },
    { x: -half, z: half },
    { x: -half, z: -half },
  ];
  return assemble(`open-${sizeM}`, path, polyline(corners), { minX: -half, minZ: -half, maxX: half, maxZ: half });
}

// ---------------------------------------------------------------------------------------------------------------
// Endless road chunks
// ---------------------------------------------------------------------------------------------------------------

function boundsOf(points: Vec2[]): TrackChunk['bounds'] {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const p of points) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minZ = Math.min(bounds.minZ, p.z);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxZ = Math.max(bounds.maxZ, p.z);
  }
  return bounds;
}

/** Edges, walls and bookkeeping for a chunk whose centreline, edges and bumps are already known. */
function assembleChunk(
  index: number,
  path: PathPoint[],
  left: Vec2[],
  right: Vec2[],
  bumps: Bump[],
  entry: Pose,
): TrackChunk {
  const walls = [...polyline(left), ...polyline(right)];
  const corners = [...left, ...right];
  if (index === 0) {
    // The first chunk is closed END_MARGIN behind its first point, like the start of a hand-built level.
    const backX = -Math.cos(entry.heading) * END_MARGIN;
    const backZ = -Math.sin(entry.heading) * END_MARGIN;
    const capLeft = { x: left[0].x + backX, z: left[0].z + backZ };
    const capRight = { x: right[0].x + backX, z: right[0].z + backZ };
    walls.unshift(
      { ax: capLeft.x, az: capLeft.z, bx: left[0].x, bz: left[0].z },
      { ax: capRight.x, az: capRight.z, bx: right[0].x, bz: right[0].z },
      { ax: capLeft.x, az: capLeft.z, bx: capRight.x, bz: capRight.z },
    );
    corners.push(capLeft, capRight);
  }
  return {
    index,
    path,
    left,
    right,
    walls,
    props: [],
    decor: [],
    bumps,
    startDist: path[0].dist,
    endDist: path[path.length - 1].dist,
    intensity: 0,
    bounds: boundsOf(corners),
  };
}

/** A bump across a road of `halfWidth` at (x, z), its crest square to `heading`: 0.5 m high and 12 m long by default. */
export function makeBump(x: number, z: number, heading: number, halfWidth: number, height = 0.5, length = 12): Bump {
  return {
    x,
    z,
    dirX: Math.cos(heading),
    dirZ: Math.sin(heading),
    halfLength: length / 2,
    halfWidth: halfWidth + 1,
    height,
  };
}

/**
 * One chunk of straight road along +x on the line z = 0, from x = `startX` to `startX + lengthM`, with a path point
 * every 2 m. `dist` equals x, so chunks made with consecutive indices and touching ends join up into one road that
 * started at x = 0. Chunk 0 is closed by a wall 6 m behind its first point, exactly like `makeStraightLevel`.
 */
export function makeStraightChunk(
  index: number,
  startX: number,
  lengthM: number,
  halfWidth: number,
  bumps: Bump[] = [],
): TrackChunk {
  const path = straightPath(startX, startX + lengthM, halfWidth).map((p) => ({ ...p, dist: p.x }));
  return assembleChunk(index, path, edge(path, -1), edge(path, 1), bumps, { x: startX, z: 0, heading: 0 });
}

/** One chunk of a hand-built road: see `makeChunkRoad`. */
export interface ChunkShape {
  /** Centreline length, m. */
  length: number;
  /** Total change of heading over the chunk, rad. Positive turns right (towards +z when heading along +x). */
  turn?: number;
  /** Half width at the end of the chunk; it changes evenly from the half width the chunk starts with. */
  endHalfWidth?: number;
  /** Distances into the chunk (m) at which a default bump sits. */
  bumpsAt?: number[];
}

/**
 * Joined chunks built by hand: each is a straight or an arc of constant curvature, numbered from 0 and starting at
 * `start` (default: the origin, heading +x). Path points are about 2 m apart, the edges are the centreline offset
 * by the half width, and chunk 0 is closed 6 m behind the start. The start pose for a car is `start` itself.
 */
export function makeChunkRoad(
  shapes: ChunkShape[],
  halfWidth = 8,
  start: Pose = { x: 0, z: 0, heading: 0 },
): TrackChunk[] {
  const chunks: TrackChunk[] = [];
  let { x, z, heading } = start;
  let dist = 0;
  let width = halfWidth;
  shapes.forEach((shape, index) => {
    const steps = Math.max(1, Math.round(shape.length / PATH_SPACING));
    const stride = shape.length / steps;
    const bend = (shape.turn ?? 0) / steps;
    const widen = ((shape.endHalfWidth ?? width) - width) / steps;
    const entry = { x, z, heading };
    const path: PathPoint[] = [];
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    const bumps: Bump[] = [];
    const bumpSteps = (shape.bumpsAt ?? []).map((at) => Math.min(steps, Math.max(0, Math.round(at / stride))));
    for (let i = 0; i <= steps; i++) {
      if (i > 0) {
        // A chord of the arc: it leaves at the old heading plus half the step's turn.
        x += stride * Math.cos(heading + bend / 2);
        z += stride * Math.sin(heading + bend / 2);
        heading += bend;
        dist += stride;
        width += widen;
      }
      path.push({ x, z, halfWidth: width, dist });
      left.push({ x: x + Math.sin(heading) * width, z: z - Math.cos(heading) * width });
      right.push({ x: x - Math.sin(heading) * width, z: z + Math.cos(heading) * width });
      if (bumpSteps.includes(i)) bumps.push(makeBump(x, z, heading, width));
    }
    chunks.push(assembleChunk(index, path, left, right, bumps, entry));
  });
  return chunks;
}
