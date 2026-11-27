/**
 * Hand-built levels and endless-road chunks for tests: no generator involved, so sim tests do not depend on src/gen.
 *
 * Roads are 2.5D (see types.ts): path points carry a height, edges may be open (no barrier), walls carry the road
 * height at each end. The old builders (makeStraightLevel, makeOpenLevel, makeStraightChunk, makeChunkRoad) still
 * make flat roads at y = 0 exactly as before; the newer ones add ramps, crossings and open edges.
 */
import type { Bump, Gate, Level, PathPoint, Pose, TrackChunk, Vec2, Wall } from '../../src/types';
import { GEN_VERSION } from '../../src/types';

const PATH_SPACING = 2;
/** Clear road behind the start pad and beyond the goal line before the closing walls. */
const END_MARGIN = 6;

type Bounds = Level['bounds'];

function wall(a: Vec2, b: Vec2, ya = 0, yb = ya): Wall {
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, ya, yb };
}

function polyline(points: Vec2[], y = 0): Wall[] {
  const walls: Wall[] = [];
  for (let i = 1; i < points.length; i++) walls.push(wall(points[i - 1], points[i], y));
  return walls;
}

function boundsOf(points: Vec2[], heights: number[]): Bounds {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of points) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minZ = Math.min(bounds.minZ, p.z);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxZ = Math.max(bounds.maxZ, p.z);
  }
  for (const y of heights) {
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}

function headingAt(path: PathPoint[], i: number): number {
  const a = path[Math.max(0, i - 1)];
  const b = path[Math.min(path.length - 1, i + 1)];
  return Math.atan2(b.z - a.z, b.x - a.x);
}

function gateAt(path: PathPoint[], left: Vec2[], right: Vec2[], pathIndex: number): Gate {
  const p = path[pathIndex];
  return {
    ax: left[pathIndex].x,
    az: left[pathIndex].z,
    bx: right[pathIndex].x,
    bz: right[pathIndex].z,
    pathIndex,
    y: p.y,
    respawn: { x: p.x, z: p.z, heading: headingAt(path, pathIndex), y: p.y },
  };
}

function closedFlags(path: PathPoint[]): boolean[] {
  return path.map(() => false);
}

function assemble(
  id: string,
  path: PathPoint[],
  left: Vec2[],
  right: Vec2[],
  walls: Wall[],
  bounds: Bounds,
  extra: Partial<Level> = {},
): Level {
  const last = path.length - 1;
  return {
    id,
    seed: id,
    genVersion: GEN_VERSION,
    path,
    left,
    right,
    leftOpen: closedFlags(path),
    rightOpen: closedFlags(path),
    walls,
    props: [],
    bumps: [],
    supports: [],
    decor: [],
    start: { x: path[0].x, z: path[0].z, heading: headingAt(path, 0), y: path[0].y },
    checkpoints: [gateAt(path, left, right, Math.floor(last / 2))],
    goal: gateAt(path, left, right, last),
    bounds,
    length: path[last].dist,
    ...extra,
  };
}

function straightPath(fromX: number, toX: number, halfWidth: number): PathPoint[] {
  const steps = Math.max(1, Math.round((toX - fromX) / PATH_SPACING));
  const path: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const dist = ((toX - fromX) * i) / steps;
    path.push({ x: fromX + dist, z: 0, y: 0, halfWidth, dist });
  }
  return path;
}

/** Travelling along +x, left is -z and right is +z. */
function edge(path: PathPoint[], side: -1 | 1): Vec2[] {
  return path.map((p) => ({ x: p.x, z: p.z + side * p.halfWidth }));
}

/**
 * A straight flat road along +x at y = 0. The start pad is at the origin, the goal line `lengthM` further on, and
 * the road is closed by a wall 6 m behind the start and 6 m beyond the goal.
 */
export function makeStraightLevel(lengthM: number, halfWidth: number): Level {
  const path = straightPath(0, lengthM, halfWidth);
  const minX = -END_MARGIN;
  const maxX = lengthM + END_MARGIN;
  const left = edge(path, -1);
  const right = edge(path, 1);
  const leftEdge = [{ x: minX, z: -halfWidth }, ...left, { x: maxX, z: -halfWidth }];
  const rightEdge = [{ x: minX, z: halfWidth }, ...right, { x: maxX, z: halfWidth }];
  const walls = [
    ...polyline(leftEdge),
    ...polyline(rightEdge),
    wall({ x: minX, z: -halfWidth }, { x: minX, z: halfWidth }),
    wall({ x: maxX, z: -halfWidth }, { x: maxX, z: halfWidth }),
  ];
  const bounds = { minX, minZ: -halfWidth, maxX, maxZ: halfWidth, minY: 0, maxY: 0 };
  return assemble(`straight-${lengthM}x${halfWidth}`, path, left, right, walls, bounds);
}

/**
 * A walled flat square of side `sizeM` centred on the origin at y = 0, with the start pad in the middle facing +x.
 * The "road" is the whole square: a coarse centreline along z = 0 from the -x wall, wide enough that its footprint
 * covers every corner. The checkpoint is half way from the start to the goal, which is 6 m short of the +x wall.
 */
export function makeOpenLevel(sizeM: number): Level {
  const half = sizeM / 2;
  const goalX = Math.max(PATH_SPACING, half - END_MARGIN);
  const width = half + 1;
  const xs = [-half, 0, goalX / 2, goalX];
  const path: PathPoint[] = xs.map((x) => ({ x, z: 0, y: 0, halfWidth: width, dist: x + half }));
  const left = edge(path, -1);
  const right = edge(path, 1);
  const corners: Vec2[] = [
    { x: -half, z: -half },
    { x: half, z: -half },
    { x: half, z: half },
    { x: -half, z: half },
    { x: -half, z: -half },
  ];
  const level = assemble(`open-${sizeM}`, path, left, right, polyline(corners), {
    minX: -half,
    minZ: -half,
    maxX: half,
    maxZ: half,
    minY: 0,
    maxY: 0,
  });
  return {
    ...level,
    start: { x: 0, z: 0, heading: 0, y: 0 },
    checkpoints: [gateAt(path, left, right, 2)],
    goal: gateAt(path, left, right, 3),
    length: goalX,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Roads with shape and height
// ---------------------------------------------------------------------------------------------------------------

/** One stretch of a hand-built road: a straight or an arc of constant curvature, optionally climbing. */
export interface ChunkShape {
  /** Centreline length, m. */
  length: number;
  /** Total change of heading over the stretch, rad. Positive turns right (towards +z when heading along +x). */
  turn?: number;
  /** Half width at the end of the stretch; it changes evenly from the half width it starts with. */
  endHalfWidth?: number;
  /** Distances into the stretch (m) at which a default bump sits. */
  bumpsAt?: number[];
  /** Height gained over the stretch (negative: lost), m, eased in and out (smoothstep): max grade 1.5 x rise / length. */
  rise?: number;
  /** No barrier along this stretch's left / right edge. */
  openLeft?: boolean;
  openRight?: boolean;
}

/** A road shape and where it begins. */
export interface RoadStart extends Pose {
  y?: number;
}

interface Stretch {
  path: PathPoint[];
  left: Vec2[];
  right: Vec2[];
  leftOpen: boolean[];
  rightOpen: boolean[];
  bumps: Bump[];
}

/** A bump across a road of `halfWidth` at (x, z), its crest square to `heading`: 0.5 m high and 12 m long by default. */
export function makeBump(x: number, z: number, heading: number, halfWidth: number, height = 0.5, length = 12, y = 0): Bump {
  return {
    x,
    z,
    y,
    dirX: Math.cos(heading),
    dirZ: Math.sin(heading),
    halfLength: length / 2,
    halfWidth: halfWidth + 1,
    height,
  };
}

/**
 * Walks `shapes` from `start` and returns one stretch per shape. Path points are about 2 m apart, the edges are the
 * centreline offset by the half width (at the heading there), and consecutive stretches share their joining point.
 */
function walkShapes(shapes: ChunkShape[], halfWidth: number, start: RoadStart): Stretch[] {
  const stretches: Stretch[] = [];
  let { x, z, heading } = start;
  let y = start.y ?? 0;
  let dist = 0;
  let width = halfWidth;
  for (const shape of shapes) {
    const steps = Math.max(1, Math.round(shape.length / PATH_SPACING));
    const stride = shape.length / steps;
    const bend = (shape.turn ?? 0) / steps;
    const widen = ((shape.endHalfWidth ?? width) - width) / steps;
    const rise = shape.rise ?? 0;
    const y0 = y;
    const stretch: Stretch = { path: [], left: [], right: [], leftOpen: [], rightOpen: [], bumps: [] };
    const bumpSteps = (shape.bumpsAt ?? []).map((at) => Math.min(steps, Math.max(0, Math.round(at / stride))));
    for (let i = 0; i <= steps; i++) {
      if (i > 0) {
        // A chord of the arc: it leaves at the old heading plus half the step's turn.
        x += stride * Math.cos(heading + bend / 2);
        z += stride * Math.sin(heading + bend / 2);
        heading += bend;
        dist += stride;
        width += widen;
        const u = i / steps;
        y = y0 + rise * u * u * (3 - 2 * u);
      }
      stretch.path.push({ x, z, y, halfWidth: width, dist });
      stretch.left.push({ x: x + Math.sin(heading) * width, z: z - Math.cos(heading) * width });
      stretch.right.push({ x: x - Math.sin(heading) * width, z: z + Math.cos(heading) * width });
      stretch.leftOpen.push(shape.openLeft === true && i < steps);
      stretch.rightOpen.push(shape.openRight === true && i < steps);
      if (bumpSteps.includes(i)) stretch.bumps.push(makeBump(x, z, heading, width, 0.5, 12, y));
    }
    stretches.push(stretch);
  }
  return stretches;
}

/** Barriers along every edge segment that is not open, at the road's height. */
function edgeWalls(s: Stretch): Wall[] {
  // All of the left edge, then all of the right, as the flat builders always did (collision ties go by order).
  const walls: Wall[] = [];
  for (const side of [s.left, s.right]) {
    const open = side === s.left ? s.leftOpen : s.rightOpen;
    for (let i = 0; i + 1 < s.path.length; i++) {
      if (!open[i]) walls.push(wall(side[i], side[i + 1], s.path[i].y, s.path[i + 1].y));
    }
  }
  return walls;
}

/** Three walls closing the road `margin` metres beyond an end point, at its height. `back` points away from the road. */
function capWalls(left: Vec2, right: Vec2, back: number, y: number, margin = END_MARGIN): { walls: Wall[]; corners: Vec2[] } {
  const bx = Math.cos(back) * margin;
  const bz = Math.sin(back) * margin;
  const capLeft = { x: left.x + bx, z: left.z + bz };
  const capRight = { x: right.x + bx, z: right.z + bz };
  return {
    walls: [wall(capLeft, left, y), wall(capRight, right, y), wall(capLeft, capRight, y)],
    corners: [capLeft, capRight],
  };
}

/** Joins stretches into one, dropping the duplicated joining points. */
function joinStretches(stretches: Stretch[]): Stretch {
  const joined: Stretch = { path: [], left: [], right: [], leftOpen: [], rightOpen: [], bumps: [] };
  stretches.forEach((s, n) => {
    const from = n === 0 ? 0 : 1;
    if (n > 0) {
      // The joining point's open flags belong to the segment after it.
      joined.leftOpen[joined.leftOpen.length - 1] = s.leftOpen[0];
      joined.rightOpen[joined.rightOpen.length - 1] = s.rightOpen[0];
    }
    joined.path.push(...s.path.slice(from));
    joined.left.push(...s.left.slice(from));
    joined.right.push(...s.right.slice(from));
    joined.leftOpen.push(...s.leftOpen.slice(from));
    joined.rightOpen.push(...s.rightOpen.slice(from));
    joined.bumps.push(...s.bumps);
  });
  return joined;
}

/**
 * A level built from shapes (see ChunkShape), starting at `start`, closed 6 m behind the start and 6 m beyond the
 * goal. One checkpoint half way along the path. Edges marked open get no barrier.
 */
export function makeShapedLevel(id: string, shapes: ChunkShape[], halfWidth = 8, start: RoadStart = { x: 0, z: 0, heading: 0 }): Level {
  const road = joinStretches(walkShapes(shapes, halfWidth, start));
  const last = road.path.length - 1;
  const walls = edgeWalls(road);
  const startCap = capWalls(road.left[0], road.right[0], headingAt(road.path, 0) + Math.PI, road.path[0].y);
  const goalCap = capWalls(road.left[last], road.right[last], headingAt(road.path, last), road.path[last].y);
  walls.push(...startCap.walls, ...goalCap.walls);
  const bounds = boundsOf(
    [...road.left, ...road.right, ...startCap.corners, ...goalCap.corners],
    road.path.map((p) => p.y),
  );
  return {
    ...assemble(id, road.path, road.left, road.right, walls, bounds),
    leftOpen: road.leftOpen,
    rightOpen: road.rightOpen,
    bumps: road.bumps,
  };
}

/** Heights of the ramp level, for tests: flat 40 m, climb `RAMP.rise` over 100 m, flat 40 m on top, descend, flat. */
export const RAMP = Object.freeze({ halfWidth: 8, rise: 8, climbFrom: 40, climbTo: 140, topTo: 180, descendTo: 280, end: 340 });

/** A straight road along +x that climbs 8 m (max grade 12%), runs level on top, comes back down, and runs out flat. */
export function makeRampLevel(): Level {
  return makeShapedLevel(
    'ramp',
    [
      { length: RAMP.climbFrom },
      { length: RAMP.climbTo - RAMP.climbFrom, rise: RAMP.rise },
      { length: RAMP.topTo - RAMP.climbTo },
      { length: RAMP.descendTo - RAMP.topTo, rise: -RAMP.rise },
      { length: RAMP.end - RAMP.descendTo },
    ],
    RAMP.halfWidth,
  );
}

/**
 * A straight road along +x with a constant grade from the start (y = grade * x), `length` long. For slope gravity.
 */
export function makeSlopeLevel(grade: number, length = 200, halfWidth = 8): Level {
  const level = makeStraightLevel(length, halfWidth);
  const y = (x: number): number => Math.max(0, grade * x);
  const path = level.path.map((p) => ({ ...p, y: y(p.x) }));
  const walls = level.walls.map((w) => ({ ...w, ya: y(w.ax), yb: y(w.bx) }));
  return {
    ...level,
    id: `slope-${grade}`,
    path,
    walls,
    start: { ...level.start, y: 0 },
    checkpoints: level.checkpoints.map((g) => ({ ...g, y: y(g.ax), respawn: { ...g.respawn, y: y(g.ax) } })),
    goal: { ...level.goal, y: y(level.goal.ax), respawn: { ...level.goal.respawn, y: y(level.goal.ax) } },
    bounds: { ...level.bounds, minY: 0, maxY: y(length) },
  };
}

/** Geometry of the crossing level, for tests. */
export const CROSSING = Object.freeze({
  halfWidth: 6,
  /** The lower road runs along z = 0 from x = 0 to `loopAt`, at y = 0. */
  loopAt: 100,
  radius: 30,
  /** The bridge runs north (-z) along x = loopAt - radius at y = `height`, crossing over z = 0. */
  crossX: 70,
  height: 7,
  /** How far the bridge runs on north from the end of the loop. */
  bridgeLength: 110,
});

/**
 * A road that passes over itself: east along z = 0 at y = 0 for 100 m, a 270-degree right-hand loop (radius 30)
 * climbing 7 m, then north along x = 70 at y = 7, over the road it started on (at (70, 0)), with its own walls.
 * With `openBridge` the bridge's edges have no barrier over the 24 m around the crossing, so a car can drop off it
 * onto the road below.
 */
export function makeCrossingLevel(openBridge = false): Level {
  const c = CROSSING;
  const loop = (3 * Math.PI) / 2;
  const before = c.radius - 12;
  const bridge: ChunkShape[] = openBridge
    ? [{ length: before }, { length: 24, openLeft: true, openRight: true }, { length: c.bridgeLength - before - 24 }]
    : [{ length: c.bridgeLength }];
  return makeShapedLevel(
    openBridge ? 'crossing-open' : 'crossing',
    [{ length: c.loopAt }, { length: loop * c.radius, turn: loop, rise: c.height }, ...bridge],
    c.halfWidth,
  );
}

/** Geometry of the open-edge level, for tests: raised `height` m between `openFrom` and `openTo` with no barriers. */
export const OPEN_EDGE = Object.freeze({ halfWidth: 7, height: 5, openFrom: 120, openTo: 200, end: 320 });

/** A straight road along +x that climbs 5 m, runs 80 m on top with OPEN edges (no barriers), and comes back down. */
export function makeOpenEdgeLevel(): Level {
  const o = OPEN_EDGE;
  return makeShapedLevel(
    'open-edge',
    [
      { length: 40 },
      { length: o.openFrom - 40, rise: o.height },
      { length: o.openTo - o.openFrom, openLeft: true, openRight: true },
      { length: 80, rise: -o.height },
      { length: o.end - o.openTo - 80 },
    ],
    o.halfWidth,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Endless road chunks
// ---------------------------------------------------------------------------------------------------------------

/** Edges, walls and bookkeeping for a chunk whose stretch is already known. */
function assembleChunk(index: number, s: Stretch): TrackChunk {
  const walls = edgeWalls(s);
  const corners = [...s.left, ...s.right];
  if (index === 0) {
    // The first chunk is closed END_MARGIN behind its first point, like the start of a hand-built level.
    const cap = capWalls(s.left[0], s.right[0], headingAt(s.path, 0) + Math.PI, s.path[0].y);
    // Same order as before: the two side pieces, then the cross wall.
    walls.unshift(...cap.walls);
    corners.push(...cap.corners);
  }
  return {
    index,
    path: s.path,
    left: s.left,
    right: s.right,
    leftOpen: s.leftOpen,
    rightOpen: s.rightOpen,
    walls,
    props: [],
    bumps: s.bumps,
    supports: [],
    decor: [],
    startDist: s.path[0].dist,
    endDist: s.path[s.path.length - 1].dist,
    intensity: 0,
    bounds: boundsOf(corners, s.path.map((p) => p.y)),
  };
}

/**
 * One chunk of straight flat road along +x on the line z = 0 at y = 0, from x = `startX` to `startX + lengthM`, with
 * a path point every 2 m. `dist` equals x, so chunks made with consecutive indices and touching ends join up into one
 * road that started at x = 0. Chunk 0 is closed by a wall 6 m behind its first point, exactly like
 * `makeStraightLevel`.
 */
export function makeStraightChunk(index: number, startX: number, lengthM: number, halfWidth: number, bumps: Bump[] = []): TrackChunk {
  const path = straightPath(startX, startX + lengthM, halfWidth).map((p) => ({ ...p, dist: p.x }));
  const stretch: Stretch = {
    path,
    left: edge(path, -1),
    right: edge(path, 1),
    leftOpen: closedFlags(path),
    rightOpen: closedFlags(path),
    bumps,
  };
  return assembleChunk(index, stretch);
}

/**
 * Joined chunks built by hand: each is a straight or an arc of constant curvature (optionally climbing, with open
 * edges), numbered from 0 and starting at `start` (default: the origin, heading +x, y = 0). Path points are about
 * 2 m apart, the edges are the centreline offset by the half width, and chunk 0 is closed 6 m behind the start.
 * The start pose for a car is `start` itself.
 */
export function makeChunkRoad(shapes: ChunkShape[], halfWidth = 8, start: RoadStart = { x: 0, z: 0, heading: 0 }): TrackChunk[] {
  return walkShapes(shapes, halfWidth, start).map((s, index) => assembleChunk(index, s));
}

/**
 * Endless chunks that cross over themselves like `makeCrossingLevel`: chunk 0 east at y = 0, chunk 1 the climbing
 * 270-degree loop, then the bridge north over chunk 0 at y = 7 in three chunks (2: 18 m, 3: the 24 m over the road
 * below, open-edged with `openBridge`, 4: 18 m), and chunk 5, 100 m more road on.
 */
export function makeCrossingChunks(openBridge = false): TrackChunk[] {
  const c = CROSSING;
  const loop = (3 * Math.PI) / 2;
  const before = c.radius - 12;
  return makeChunkRoad(
    [
      { length: c.loopAt },
      { length: loop * c.radius, turn: loop, rise: c.height },
      { length: before },
      { length: 24, openLeft: openBridge, openRight: openBridge },
      { length: 18 },
      { length: 100 },
    ],
    c.halfWidth,
  );
}
