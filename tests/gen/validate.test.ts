import { describe, expect, it } from 'vitest';
import { generateLevel } from '../../src/gen/trackGen';
import {
  SpatialHash,
  WallIndex,
  distPointSegment,
  distSegmentBox,
  insideWalls,
  segmentsTouch,
  validateLevel,
} from '../../src/gen/validate';
import type { Level, Segment } from '../../src/types';

const base = generateLevel('2026-W48');

function broken(mutate: (level: Level) => void): string[] {
  const level = structuredClone(base);
  mutate(level);
  const result = validateLevel(level);
  expect(result.ok).toBe(false);
  return result.errors;
}

/** A path index on straight road, well away from both ends. */
function straightIndex(level: Level): number {
  const p = level.path;
  for (let i = 40; i < p.length - 40; i++) {
    const a = p[i - 6];
    const b = p[i + 6];
    let straight = true;
    for (let k = i - 5; k < i + 6; k++) {
      if (distPointSegment(p[k].x, p[k].z, a.x, a.z, b.x, b.z) > 1e-6) straight = false;
    }
    if (straight) return i;
  }
  throw new Error('no straight found');
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

describe('validateLevel', () => {
  it('accepts a generated level', () => {
    expect(validateLevel(base)).toEqual({ ok: true, errors: [] });
  });

  it('rejects road edges that cross', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      const p = level.path[i];
      const r = level.right[i];
      // Drags one left edge point clean through the right edge.
      level.left[i] = { x: 2 * r.x - p.x, z: 2 * r.z - p.z };
    });
    expect(errors.some((e) => e.startsWith('road edges intersect'))).toBe(true);
  });

  it('rejects a missing wall', () => {
    const errors = broken((level) => level.walls.splice(100, 1));
    expect(errors.some((e) => e.startsWith('walls are not a closed loop'))).toBe(true);
  });

  it('rejects walls that form two separate loops', () => {
    const errors = broken((level) => {
      const x = level.bounds.maxX - 40;
      const z = level.bounds.maxZ - 40;
      level.walls.push(seg(x, z, x + 5, z), seg(x + 5, z, x, z + 5), seg(x, z + 5, x, z));
    });
    expect(errors.some((e) => e.startsWith('walls form more than one loop'))).toBe(true);
  });

  it('rejects a prop that blocks the road', () => {
    const errors = broken((level) => {
      const p = level.path[straightIndex(level)];
      level.props.push({ kind: 'pillar', x: p.x, z: p.z, radius: p.halfWidth - 2, height: 5, hue: 0 });
    });
    expect(errors.some((e) => e.startsWith('prop blocks the road'))).toBe(true);
  });

  it('rejects a prop outside the road', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      const outside = beside(level, i, level.path[i].halfWidth + 3);
      level.props.push({ kind: 'pillar', ...outside, radius: 1.5, height: 5, hue: 0 });
    });
    expect(errors.some((e) => e.startsWith('prop is not inside the road'))).toBe(true);
  });

  it('rejects a prop next to the start', () => {
    const errors = broken((level) => {
      const p = level.path[6];
      level.props.push({ kind: 'pillar', x: p.x, z: p.z, radius: 1.2, height: 5, hue: 0 });
    });
    expect(errors.some((e) => e.startsWith('prop too close to the start'))).toBe(true);
  });

  it('rejects tall decor next to the road', () => {
    const errors = broken((level) => {
      const i = straightIndex(level);
      // An 8 m block whose near face is 5 m outside the wall: fine as a kerb-side hut, not as a 50 m tower.
      level.decor.push({ ...beside(level, i, level.path[i].halfWidth + 5 + 4), w: 8, d: 8, h: 50, hue: 2 });
    });
    expect(errors.some((e) => e.startsWith('decor too tall or too close to the road'))).toBe(true);
  });

  it('rejects decor standing on the road', () => {
    const errors = broken((level) => {
      const p = level.path[straightIndex(level)];
      level.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 3, hue: 0 });
    });
    expect(errors.some((e) => e.startsWith('decor'))).toBe(true);
  });

  it('rejects overlapping decor', () => {
    const errors = broken((level) => level.decor.push({ ...level.decor[0] }));
    expect(errors.some((e) => e.startsWith('decor blocks overlap'))).toBe(true);
  });

  it('rejects numbers that are not finite', () => {
    expect(broken((level) => (level.path[10].x = Number.NaN))[0]).toMatch(/^bad number: path\[10\]/);
    expect(broken((level) => (level.walls[3].bz = Infinity))[0]).toMatch(/^bad number: walls\[3\]/);
  });

  it('rejects a road that is too narrow', () => {
    const errors = broken((level) => (level.path[50].halfWidth = 5));
    expect(errors.some((e) => e.startsWith('road too narrow'))).toBe(true);
  });

  it('rejects path distances that do not increase', () => {
    const errors = broken((level) => (level.path[50].dist = level.path[49].dist));
    expect(errors.some((e) => e.startsWith('path dist not increasing'))).toBe(true);
  });

  it('rejects a gap in the path', () => {
    const errors = broken((level) => {
      level.path.splice(60, 2);
      level.left.splice(60, 2);
      level.right.splice(60, 2);
    });
    expect(errors.some((e) => e.startsWith('path spacing outside 1..5 m'))).toBe(true);
  });

  it('rejects edge arrays of the wrong length', () => {
    const errors = broken((level) => level.left.pop());
    expect(errors.some((e) => e.startsWith('edge arrays differ from path'))).toBe(true);
  });

  it('rejects a length outside the allowed range', () => {
    const errors = broken((level) => {
      for (const p of level.path) p.dist *= 2;
      level.length *= 2;
    });
    expect(errors.some((e) => e.startsWith('length outside 600..1300 m'))).toBe(true);
  });

  it('rejects gates out of order and a goal that is not last', () => {
    const swapped = broken((level) => level.checkpoints.reverse());
    expect(swapped.some((e) => e.startsWith('gates out of order'))).toBe(true);
    const early = broken((level) => (level.goal.pathIndex = level.checkpoints[0].pathIndex));
    expect(early.some((e) => e.startsWith('gates out of order: goal'))).toBe(true);
  });

  it('rejects a respawn point off the road', () => {
    const errors = broken((level) => (level.checkpoints[0].respawn.x = level.bounds.maxX + 50));
    expect(errors.some((e) => e.startsWith('respawn is off the road'))).toBe(true);
  });

  it('rejects a start outside the road or against a wall', () => {
    const outside = broken((level) => (level.start.x = level.bounds.maxX + 50));
    expect(outside.some((e) => e.startsWith('start is outside the road'))).toBe(true);
    const hugging = broken((level) => {
      const nearWall = beside(level, 0, level.path[0].halfWidth - 3);
      level.start.x = nearWall.x;
      level.start.z = nearWall.z;
    });
    expect(hugging.some((e) => e.startsWith('start too close to a wall'))).toBe(true);
  });

  it('rejects bounds that leave something out', () => {
    const errors = broken((level) => (level.bounds.maxX -= 30));
    expect(errors.some((e) => e.startsWith('bounds do not contain everything'))).toBe(true);
  });

  it('rejects a road that doubles back onto itself', () => {
    const errors = broken((level) => {
      // Fold the second half of the centreline back over the first half.
      const n = level.path.length;
      for (let i = n >> 1; i < n; i++) {
        level.path[i].x = level.path[n - 1 - i].x;
        level.path[i].z = level.path[n - 1 - i].z;
      }
    });
    expect(errors.some((e) => e.startsWith('road runs into itself'))).toBe(true);
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
