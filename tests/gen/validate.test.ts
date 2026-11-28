import { describe, expect, it } from 'vitest';
import { generateLevel } from '../../src/gen/trackGen';
import {
  RULES,
  SpatialHash,
  WallIndex,
  distPointSegment,
  distSegmentBox,
  findCrossings,
  insideWalls,
  segmentsTouch,
  validateLevel,
} from '../../src/gen/validate';
import type { Level, Segment, Vec2, Wall } from '../../src/types';
import { CROSSING_CLEARANCE } from '../../src/types';

const base = generateLevel('2026-W48');

function broken(mutate: (level: Level) => void): string[] {
  const level = structuredClone(base);
  mutate(level);
  const result = validateLevel(level);
  expect(result.ok).toBe(false);
  return result.errors;
}

function has(errors: string[], rule: string): boolean {
  return errors.some((e) => e.startsWith(rule));
}

/** A path index on straight road with barriers on both sides, well away from both ends. */
function straightIndex(level: Level, from = 40): number {
  const p = level.path;
  for (let i = from; i < p.length - 40; i++) {
    const a = p[i - 6];
    const b = p[i + 6];
    let ok = true;
    for (let k = i - 5; k < i + 6; k++) {
      if (distPointSegment(p[k].x, p[k].z, a.x, a.z, b.x, b.z) > 1e-6) ok = false;
      if (level.leftOpen[k] || level.rightOpen[k]) ok = false;
    }
    if (ok) return i;
  }
  throw new Error('no straight found');
}

/** A path index in the middle of a bend. */
function bendIndex(level: Level): number {
  const p = level.path;
  for (let i = 30; i < p.length - 30; i++) {
    let bent = true;
    for (let k = i - 3; k <= i + 3; k++) {
      const cross =
        (p[k].x - p[k - 1].x) * (p[k + 1].z - p[k].z) - (p[k].z - p[k - 1].z) * (p[k + 1].x - p[k].x);
      if (Math.abs(cross) < 1e-3) bent = false;
    }
    if (bent) return i;
  }
  throw new Error('no bend found');
}

/** Unit vector pointing to the left of the road at a path index. */
function leftNormal(level: Level, index: number): { x: number; z: number } {
  const p = level.path[index];
  const l = level.left[index];
  return { x: (l.x - p.x) / p.halfWidth, z: (l.z - p.z) / p.halfWidth };
}

/** The point `reach` metres to the left of the centreline at a path index. */
function beside(level: Level, index: number, reach: number): { x: number; z: number } {
  const n = leftNormal(level, index);
  return { x: level.path[index].x + n.x * reach, z: level.path[index].z + n.z * reach };
}

function seg(ax: number, az: number, bx: number, bz: number): Segment {
  return { ax, az, bx, bz };
}

function wall(ax: number, az: number, bx: number, bz: number, y = 0): Wall {
  return { ax, az, bx, bz, ya: y, yb: y };
}

/** Index of the wall on edge segment i of one side. */
function edgeWall(level: Level, edge: Vec2[], i: number): number {
  const a = edge[i];
  const b = edge[i + 1];
  const found = level.walls.findIndex(
    (w) => (w.ax === a.x && w.az === a.z && w.bx === b.x && w.bz === b.z) || (w.ax === b.x && w.az === b.z && w.bx === a.x && w.bz === a.z),
  );
  if (found < 0) throw new Error(`no wall on segment ${i}`);
  return found;
}

/** Opens the left edge from segment `from` to `to` (exclusive), taking its walls away. */
function openLeft(level: Level, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    if (level.leftOpen[i]) continue;
    level.walls.splice(edgeWall(level, level.left, i), 1);
    level.leftOpen[i] = true;
  }
}

/** Moves every wall end that sits at `from`. The road edge arrays are left alone. */
function moveWallVertex(level: Level, from: Vec2, to: Vec2): void {
  let moved = 0;
  for (const w of level.walls) {
    if (w.ax === from.x && w.az === from.z) {
      w.ax = to.x;
      w.az = to.z;
      moved++;
    }
    if (w.bx === from.x && w.bz === from.z) {
      w.bx = to.x;
      w.bz = to.z;
      moved++;
    }
  }
  expect(moved).toBe(2);
}

/** Metres past the goal line, measured the way the road is travelling. */
function pastGoal(level: Level, x: number, z: number): number {
  const { respawn } = level.goal;
  return (x - respawn.x) * Math.cos(respawn.heading) + (z - respawn.z) * Math.sin(respawn.heading);
}

/**
 * The two far corners of the cap beyond the goal: where the walls that leave the last left and right edge points,
 * other than the road edges themselves, end up.
 */
function goalCapCorners(level: Level): [Vec2, Vec2] {
  const last = level.path.length - 1;
  const farEnd = (edge: Vec2[]): Vec2 => {
    const at = edge[last];
    const before = edge[last - 1];
    for (const w of level.walls) {
      const a = { x: w.ax, z: w.az };
      const b = { x: w.bx, z: w.bz };
      for (const [near, far] of [
        [a, b],
        [b, a],
      ]) {
        if (near.x === at.x && near.z === at.z && !(far.x === before.x && far.z === before.z)) return far;
      }
    }
    throw new Error('no cap wall found');
  };
  return [farEnd(level.left), farEnd(level.right)];
}

/** Pulls the wall that closes the road beyond the goal in to `distance` metres past the line. */
function setRunOff(level: Level, distance: number): void {
  const { heading } = level.goal.respawn;
  for (const corner of goalCapCorners(level)) {
    const shift = distance - pastGoal(level, corner.x, corner.z);
    moveWallVertex(level, corner, { x: corner.x + Math.cos(heading) * shift, z: corner.z + Math.sin(heading) * shift });
  }
}

/** The path indices at the heart of the level's crossing on the lower and on the upper road. */
function crossingHeart(level: Level): { low: number; high: number } {
  const { dists } = findCrossings(level);
  expect(dists.length).toBeGreaterThan(0);
  const first = level.path.findIndex((p) => p.dist === dists[0]);
  const last = level.path.findIndex((p) => p.dist === dists[dists.length - 1]);
  return level.path[first].y < level.path[last].y ? { low: first, high: last } : { low: last, high: first };
}

describe('validateLevel', () => {
  it('accepts a generated level', () => {
    expect(validateLevel(base)).toEqual({ ok: true, errors: [] });
  });

  it('the pinned level has a crossing, open edges, supports and raised road to test against', () => {
    expect(findCrossings(base).count).toBe(1);
    expect(base.leftOpen.some(Boolean) || base.rightOpen.some(Boolean)).toBe(true);
    expect(base.supports.length).toBeGreaterThan(5);
  });

  it('rejects road edges that cross at the same level', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      const p = level.path[i];
      const r = level.right[i];
      // Drags one left edge point clean through the right edge.
      level.left[i] = { x: 2 * r.x - p.x, z: 2 * r.z - p.z };
    });
    expect(has(errors, 'road edges intersect')).toBe(true);
  });

  it('rejects a missing wall', () => {
    const errors = broken((level) => level.walls.splice(edgeWall(level, level.right, straightIndex(level)), 1));
    expect(errors).toEqual([expect.stringMatching(/^road edge has no wall: right\[\d+\]/)]);
  });

  it('rejects a wall on an open edge and a wall that belongs to nothing', () => {
    const open = broken((level) => {
      // Whichever side of the road has an open stretch.
      const onLeft = level.leftOpen.some(Boolean);
      const edge = onLeft ? level.left : level.right;
      const i = (onLeft ? level.leftOpen : level.rightOpen).findIndex(Boolean);
      level.walls.push(wall(edge[i].x, edge[i].z, edge[i + 1].x, edge[i + 1].z, level.path[i].y));
    });
    expect(has(open, 'open edge has a wall')).toBe(true);
    const stray = broken((level) => {
      const x = level.bounds.maxX - 40;
      const z = level.bounds.maxZ - 40;
      level.walls.push(wall(x, z, x + 5, z));
    });
    expect(has(stray, 'wall belongs to no edge')).toBe(true);
  });

  it('rejects a wall at the wrong height', () => {
    const errors = broken((level) => (level.walls[edgeWall(level, level.left, straightIndex(level))].ya += 1));
    expect(has(errors, 'wall height differs from the road')).toBe(true);
  });

  it('rejects ends that are not closed off', () => {
    const start = broken((level) => {
      // The wall straight across behind the start.
      const back = level.walls.findIndex((w) => !level.left.some((p) => p.x === w.ax && p.z === w.az) && !level.right.some((p) => p.x === w.ax && p.z === w.az));
      level.walls.splice(back, 1);
    });
    expect(has(start, 'start is not closed off')).toBe(true);
  });

  it('rejects a wall dragged across the road, even when it stops short of the far wall', () => {
    // The road is physically shut 0.2 m from the right wall, yet no two walls cross.
    const errors = broken((level) => {
      const i = straightIndex(level);
      const n = leftNormal(level, i);
      const r = level.right[i];
      moveWallVertex(level, level.left[i], { x: r.x + n.x * 0.2, z: r.z + n.z * 0.2 });
    });
    expect(has(errors, 'road edge has no wall')).toBe(true);
    expect(has(errors, 'wall cuts across the road')).toBe(true);
    expect(has(errors, 'walls intersect')).toBe(false);
  });

  it('rejects walls that cross each other at the same height', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      const p = level.path[i];
      const r = level.right[i];
      // The left wall is pulled clean through the right wall.
      moveWallVertex(level, level.left[i], { x: 2 * r.x - p.x, z: 2 * r.z - p.z });
    });
    expect(has(errors, 'walls intersect')).toBe(true);
  });

  it('rejects a cap that crosses itself where no road edge is involved', () => {
    // Stretching the cap beyond the goal until it reaches back across another part of the level is how a longer
    // run-off would go wrong: here the far corners are simply swapped, which twists the cap into a bow tie.
    const errors = broken((level) => {
      const [a, b] = goalCapCorners(level);
      const parked = { x: level.bounds.maxX + 1000, z: level.bounds.maxZ + 1000 };
      moveWallVertex(level, a, parked);
      moveWallVertex(level, b, a);
      moveWallVertex(level, parked, b);
    });
    expect(has(errors, 'walls intersect')).toBe(true);
    expect(has(errors, 'road edge has no wall')).toBe(false);
  });

  it('gives a generated level its full run-off beyond the goal', () => {
    for (const corner of goalCapCorners(base)) {
      expect(pastGoal(base, corner.x, corner.z)).toBeGreaterThanOrEqual(RULES.goalRunOff);
    }
  });

  it('rejects a run-off that is too short for a car to stop in', () => {
    const errors = broken((level) => setRunOff(level, 16));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^run-off beyond the goal is too short: a wall 16 m past the line/);
    const barely = broken((level) => setRunOff(level, RULES.goalRunOff - 0.5));
    expect(has(barely, 'run-off beyond the goal is too short')).toBe(true);
  });

  it('accepts a run-off of exactly the required length', () => {
    const level = structuredClone(base);
    setRunOff(level, RULES.goalRunOff);
    expect(validateLevel(level).errors.filter((e) => e.startsWith('run-off'))).toEqual([]);
  });

  it('rejects a pillar standing in the run-off', () => {
    const errors = broken((level) => {
      const { respawn } = level.goal;
      const x = respawn.x + Math.cos(respawn.heading) * 30;
      const z = respawn.z + Math.sin(respawn.heading) * 30;
      level.props.push({ kind: 'pillar', x, z, y: level.goal.y, radius: 1.5, height: 5, hue: 0 });
    });
    expect(has(errors, 'run-off beyond the goal is blocked')).toBe(true);
  });

  it('rejects a prop that blocks the road', () => {
    const errors = broken((level) => {
      const p = level.path[straightIndex(level)];
      level.props.push({ kind: 'pillar', x: p.x, z: p.z, y: p.y, radius: p.halfWidth - 2, height: 5, hue: 0 });
    });
    expect(has(errors, 'prop blocks the road')).toBe(true);
  });

  it('rejects a prop outside the road, or floating above it', () => {
    const outside = broken((level) => {
      const i = straightIndex(level);
      const at = beside(level, i, level.path[i].halfWidth + 3);
      level.props.push({ kind: 'pillar', ...at, y: level.path[i].y, radius: 1.5, height: 5, hue: 0 });
    });
    expect(has(outside, 'prop is not inside the road')).toBe(true);
    const floating = broken((level) => {
      const i = straightIndex(level);
      const p = level.path[i];
      level.props.push({ kind: 'pillar', x: p.x, z: p.z, y: p.y + 1, radius: 1.2, height: 5, hue: 0 });
    });
    expect(has(floating, 'prop is not inside the road')).toBe(true);
  });

  it('rejects a prop next to the start', () => {
    const errors = broken((level) => {
      const p = level.path[6];
      level.props.push({ kind: 'pillar', x: p.x, z: p.z, y: p.y, radius: 1.2, height: 5, hue: 0 });
    });
    expect(has(errors, 'prop too close to the start')).toBe(true);
  });

  it('rejects tall decor next to the road', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      // An 8 m block whose near face is 5 m outside the edge: fine as a kerb-side hut, not as a 50 m tower.
      level.decor.push({ ...beside(level, i, level.path[i].halfWidth + 5 + 4), w: 8, d: 8, h: 50, hue: 2 });
    });
    expect(has(errors, 'decor too tall or too close to the road')).toBe(true);
  });

  it('rejects decor standing on the road, or under a raised road', () => {
    const onRoad = broken((level) => {
      const p = level.path[straightIndex(level)];
      level.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 3, hue: 0 });
    });
    expect(has(onRoad, 'decor')).toBe(true);
    const underBridge = broken((level) => {
      const p = level.path[crossingHeart(level).high];
      level.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 3, hue: 0 });
    });
    expect(has(underBridge, 'decor stands on the road')).toBe(true);
  });

  it('rejects overlapping decor', () => {
    const errors = broken((level) => level.decor.push({ ...level.decor[0] }));
    expect(has(errors, 'decor blocks overlap')).toBe(true);
  });

  it('rejects numbers that are not finite', () => {
    expect(broken((level) => (level.path[10].x = Number.NaN))[0]).toMatch(/^bad number: path\[10\]/);
    expect(broken((level) => (level.path[10].y = Number.NaN))[0]).toMatch(/^bad number: path\[10\]/);
    expect(broken((level) => (level.walls[3].bz = Infinity))[0]).toMatch(/^bad number: walls\[3\]/);
    expect(broken((level) => (level.walls[3].yb = Infinity))[0]).toMatch(/^bad number: walls\[3\]/);
  });

  it('rejects a road that is too narrow', () => {
    const errors = broken((level) => (level.path[50].halfWidth = 5));
    expect(has(errors, 'road too narrow')).toBe(true);
  });

  it('rejects path distances that do not increase', () => {
    const errors = broken((level) => (level.path[50].dist = level.path[49].dist));
    expect(has(errors, 'path dist not increasing')).toBe(true);
  });

  it('rejects a gap in the path', () => {
    const errors = broken((level) => {
      for (const list of [level.path, level.left, level.right, level.leftOpen, level.rightOpen]) list.splice(60, 2);
    });
    expect(has(errors, 'path spacing outside 1..5 m')).toBe(true);
  });

  it('rejects edge arrays of the wrong length', () => {
    expect(has(broken((level) => level.left.pop()), 'edge arrays differ from path')).toBe(true);
    expect(has(broken((level) => level.rightOpen.pop()), 'open-edge arrays differ from path')).toBe(true);
  });

  it('rejects a length outside the allowed range', () => {
    const errors = broken((level) => {
      for (const p of level.path) p.dist *= 2;
      level.length *= 2;
    });
    expect(has(errors, 'length outside')).toBe(true);
  });

  it('rejects gates out of order and a goal that is not last', () => {
    const swapped = broken((level) => level.checkpoints.reverse());
    expect(has(swapped, 'gates out of order')).toBe(true);
    const early = broken((level) => (level.goal.pathIndex = level.checkpoints[0].pathIndex));
    expect(has(early, 'gates out of order: goal')).toBe(true);
  });

  it('rejects a respawn point off the road or at the wrong height', () => {
    const off = broken((level) => (level.checkpoints[0].respawn.x = level.bounds.maxX + 50));
    expect(has(off, 'respawn is off the road')).toBe(true);
    const high = broken((level) => (level.checkpoints[0].respawn.y = (level.checkpoints[0].respawn.y ?? 0) + 2));
    expect(has(high, 'respawn is off the road')).toBe(true);
    const gate = broken((level) => (level.checkpoints[0].y += 2));
    expect(has(gate, 'gate height differs from the road')).toBe(true);
  });

  it('rejects a start outside the road or against a wall', () => {
    const outside = broken((level) => (level.start.x = level.bounds.maxX + 50));
    expect(has(outside, 'start is outside the road')).toBe(true);
    const hugging = broken((level) => {
      const nearWall = beside(level, 0, level.path[0].halfWidth - 3);
      level.start.x = nearWall.x;
      level.start.z = nearWall.z;
    });
    expect(has(hugging, 'start too close to a wall')).toBe(true);
  });

  it('rejects bounds that leave something out', () => {
    expect(has(broken((level) => (level.bounds.maxX -= 30)), 'bounds do not contain everything')).toBe(true);
    expect(has(broken((level) => (level.bounds.maxY -= 5)), 'bounds do not contain everything')).toBe(true);
    expect(has(broken((level) => (level.bounds.minY += 1)), 'bounds do not contain everything')).toBe(true);
  });

  it('rejects a road that doubles back onto itself', () => {
    const errors = broken((level) => {
      // Fold the second half of the centreline back over the first half, at the same height.
      const n = level.path.length;
      for (let i = n >> 1; i < n; i++) {
        level.path[i].x = level.path[n - 1 - i].x;
        level.path[i].z = level.path[n - 1 - i].z;
        level.path[i].y = level.path[n - 1 - i].y;
      }
    });
    expect(has(errors, 'road runs into itself')).toBe(true);
  });

  it('counts repeated failures of one rule instead of listing each', () => {
    const errors = broken((level) => {
      for (const p of level.path) p.halfWidth = 5;
    });
    const narrow = errors.filter((e) => e.startsWith('road too narrow'));
    expect(narrow).toHaveLength(1);
    expect(narrow[0]).toMatch(/\(and \d+ more\)$/);
  });
});

describe('validateLevel in three dimensions', () => {
  it('rejects a crossing where both roads are at the same level', () => {
    const errors = broken((level) => {
      for (const p of level.path) p.y = 0;
    });
    expect(has(errors, 'road runs into itself')).toBe(true);
  });

  it('rejects an overpass that is too low to drive under', () => {
    const errors = broken((level) => {
      const { low, high } = crossingHeart(level);
      const floor = level.path[low].y;
      const middle = level.path[high].dist;
      for (const p of level.path) {
        if (Math.abs(p.dist - middle) < 45) p.y = floor + CROSSING_CLEARANCE - 2;
      }
    });
    expect(has(errors, 'crossing too low')).toBe(true);
  });

  it('rejects a road that is too steep, steep in a bend, kinked, or not level at the ends', () => {
    const steep = broken((level) => (level.path[straightIndex(level, 60)].y += 3));
    expect(has(steep, 'road too steep')).toBe(true);
    expect(has(steep, 'grade changes too sharply')).toBe(true);
    const bend = broken((level) => {
      const i = bendIndex(level);
      // A steady 9% ramp through the bend.
      for (let k = i - 3; k <= i + 3; k++) level.path[k].y = level.path[i - 3].y + 0.09 * (level.path[k].dist - level.path[i - 3].dist);
    });
    expect(has(bend, 'road too steep in a bend')).toBe(true);
    const start = broken((level) => (level.path[3].y += 0.2));
    expect(has(start, 'start is not level')).toBe(true);
    const below = broken((level) => (level.path[30].y = -1));
    expect(has(below, 'road below the city')).toBe(true);
  });

  it('rejects a support standing on another road, or holding up nothing', () => {
    const onRoad = broken((level) => {
      const { high } = crossingHeart(level);
      const p = level.path[high];
      level.supports.push({ x: p.x, z: p.z, top: p.y - 0.6, radius: 1 });
    });
    expect(has(onRoad, 'support stands on a road')).toBe(true);
    const nothing = broken((level) => (level.supports[0].top -= 2));
    expect(has(nothing, 'support holds up nothing')).toBe(true);
  });

  it('rejects an open edge beside a gate, on low road, or on both sides of a bend', () => {
    const gate = broken((level) => {
      const at = level.checkpoints[1].pathIndex;
      openLeft(level, at - 6, at + 6);
    });
    expect(has(gate, 'open edge near a gate')).toBe(true);
    const low = broken((level) => openLeft(level, 2, 14));
    expect(has(low, 'open edge on low road')).toBe(true);
    const bend = broken((level) => {
      const i = bendIndex(level);
      openLeft(level, i - 3, i + 3);
      for (let k = i - 3; k < i + 3; k++) {
        if (level.rightOpen[k]) continue;
        level.walls.splice(
          level.walls.findIndex((w) => w.ax === level.right[k].x && w.az === level.right[k].z),
          1,
        );
        level.rightOpen[k] = true;
      }
    });
    expect(has(bend, 'open on both sides in a bend')).toBe(true);
  });

  it('rejects an open edge right at a crossing', () => {
    const errors = broken((level) => {
      const { high } = crossingHeart(level);
      openLeft(level, high - 8, high + 8);
    });
    expect(has(errors, 'open edge at a crossing')).toBe(true);
  });

  it('rejects open stretches that are too short or too long', () => {
    const short = broken((level) => {
      const i = straightIndex(level);
      openLeft(level, i, i + 2);
    });
    expect(has(short, 'open stretch too short')).toBe(true);
  });

  it('rejects a bump in a bend, off the road or out of size', () => {
    const corner = broken((level) => {
      const i = bendIndex(level);
      const p = level.path[i];
      const d = { x: level.path[i + 1].x - p.x, z: level.path[i + 1].z - p.z };
      const len = Math.hypot(d.x, d.z);
      level.bumps.push({ x: p.x, z: p.z, y: p.y, dirX: d.x / len, dirZ: d.z / len, halfLength: 5, halfWidth: p.halfWidth + 1, height: 0.5 });
    });
    expect(has(corner, 'bump in a corner')).toBe(true);
    const floating = broken((level) => {
      const p = level.path[straightIndex(level)];
      level.bumps.push({ x: p.x, z: p.z, y: p.y + 3, dirX: 1, dirZ: 0, halfLength: 5, halfWidth: p.halfWidth + 1, height: 0.5 });
    });
    expect(has(floating, 'bump is not on the road')).toBe(true);
  });
});

describe('geometry helpers', () => {
  it('measures point to segment distance, including beyond the ends', () => {
    expect(distPointSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distPointSegment(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(distPointSegment(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(distPointSegment(3, 4, 0, 0, 0, 0)).toBe(5);
  });

  it('measures segment to box distance', () => {
    expect(distSegmentBox(seg(-5, 5, 5, 5), 0, 0, 2, 2)).toBe(3);
    expect(distSegmentBox(seg(5, -5, 5, 5), 0, 0, 2, 2)).toBe(3);
    expect(distSegmentBox(seg(-1, 1, 3, 1), 0, 0, 2, 2)).toBe(0);
    expect(distSegmentBox(seg(0.5, 0.5, 1.5, 1.5), 0, 0, 2, 2)).toBe(0);
    // A diagonal passing the corner at (2, 2): the nearest point is on the segment's interior.
    expect(distSegmentBox(seg(2, 6, 6, 2), 0, 0, 2, 2)).toBeCloseTo(Math.SQRT2 * 2, 12);
    expect(distSegmentBox(seg(5, 6, 9, 6), 0, 0, 2, 2)).toBe(5);
  });

  it('detects crossing, touching and overlapping segments', () => {
    expect(segmentsTouch(seg(0, 0, 4, 4), seg(0, 4, 4, 0))).toBe(true);
    expect(segmentsTouch(seg(0, 0, 4, 0), seg(2, 0, 2, 3))).toBe(true);
    expect(segmentsTouch(seg(0, 0, 4, 0), seg(3, 0, 8, 0))).toBe(true);
    expect(segmentsTouch(seg(0, 0, 4, 0), seg(5, 0, 8, 0))).toBe(false);
    expect(segmentsTouch(seg(0, 0, 4, 0), seg(0, 1, 4, 1))).toBe(false);
    expect(segmentsTouch(seg(0, 0, 4, 4), seg(5, 5, 9, 0))).toBe(false);
  });

  it('tells inside from outside a closed loop', () => {
    const square = [seg(0, 0, 10, 0), seg(10, 0, 10, 10), seg(10, 10, 0, 10), seg(0, 10, 0, 0)];
    expect(insideWalls(square, 5, 5)).toBe(true);
    expect(insideWalls(square, 15, 5)).toBe(false);
    expect(insideWalls(square, -1, 5)).toBe(false);
    expect(insideWalls(square, 5, 11)).toBe(false);
  });

  it('collects ids from every bucket a box touches', () => {
    const hash = new SpatialHash(10);
    hash.insert(1, 1, 1, 2, 2);
    hash.insert(2, 25, 25, 26, 26);
    hash.insert(3, -15, -15, -14, -14);
    const out: number[] = [99];
    expect(hash.collect(0, 0, 5, 5, out)).toEqual([1]);
    expect(hash.collect(-20, -20, 30, 30, out).sort()).toEqual([1, 2, 3]);
    expect(hash.collect(100, 100, 110, 110, out)).toEqual([]);
  });

  it('reports wall clearance up to a limit', () => {
    const walls = new WallIndex([seg(0, 0, 100, 0)]);
    expect(walls.clearance(40, 7, 50, 12, 30)).toBe(7);
    expect(walls.clearance(40, 70, 50, 80, 30)).toBe(30);
    expect(walls.clearance(40, -5, 50, 5, 30)).toBe(0);
  });
});
