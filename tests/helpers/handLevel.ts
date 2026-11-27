/**
 * Hand-built levels for tests: no generator involved, so sim tests do not depend on src/gen.
 */
import type { Gate, Level, PathPoint, Segment, Vec2 } from '../../src/types';
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
