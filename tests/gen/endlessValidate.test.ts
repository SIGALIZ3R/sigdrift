import { describe, expect, it } from 'vitest';
import { createEndlessGenerator } from '../../src/gen/endless';
import {
  BUMP_FLIGHT_SPEED,
  CHUNK_RULES,
  bumpLandingRoom,
  minBumpBeforeBend,
  minBumpToBend,
  minBumpToOpenEdge,
  validateChunk,
  validateChunkSequence,
} from '../../src/gen/validateChunk';
import type { Bump, DecorBlock, Difficulty, PathPoint, Prop, TrackChunk } from '../../src/types';
import { CROSSING_CLEARANCE } from '../../src/types';

function run(seed: string, difficulty: Difficulty, count: number): TrackChunk[] {
  const generator = createEndlessGenerator(seed, difficulty);
  const chunks: TrackChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push(generator.next());
  return chunks;
}

const harsh = run('validate-harsh', 'hard', 60);

/** The memory window before chunk n (oldest first), not counting the chunk right before it. */
function earlierOf(chunks: readonly TrackChunk[], n: number): TrackChunk[] {
  return chunks.slice(Math.max(0, n - CHUNK_RULES.memory), Math.max(0, n - 1));
}

/** Turn at a path vertex as the sine of the angle: 0 on a straight. */
function turnAt(path: readonly PathPoint[], i: number): number {
  const ax = path[i].x - path[i - 1].x;
  const az = path[i].z - path[i - 1].z;
  const bx = path[i + 1].x - path[i].x;
  const bz = path[i + 1].z - path[i].z;
  return (ax * bz - az * bx) / Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
}

interface Site {
  /** Index of the chunk in `harsh`. */
  n: number;
  /** Path index inside it. */
  i: number;
}

/** A path index in the middle of a long straight of constant width, optionally raised and with closed edges. */
function findStraight(options: { raised?: boolean } = {}): Site {
  for (let n = 3; n < harsh.length; n++) {
    const path = harsh[n].path;
    for (let i = 12; i < path.length - 12; i++) {
      let ok = path[i].halfWidth <= 12.5;
      for (let k = i - 10; k <= i + 10 && ok; k++) {
        ok = Math.abs(turnAt(path, k)) < 1e-3 && path[k].halfWidth === path[i].halfWidth;
        ok = ok && !harsh[n].leftOpen[k] && !harsh[n].rightOpen[k] && !harsh[n].leftOpen[k - 1];
        if (options.raised) ok = ok && path[k].y >= 4;
      }
      if (ok) return { n, i };
    }
  }
  throw new Error('no suitable site found');
}

/** Validates a mutated copy of a chunk (with its untouched window) and returns the complaints. */
function broken(n: number, mutate: (chunk: TrackChunk, previous: TrackChunk | null, earlier: TrackChunk[]) => void): string {
  const chunk = structuredClone(harsh[n]);
  const previous = n > 0 ? structuredClone(harsh[n - 1]) : null;
  const earlier = structuredClone(earlierOf(harsh, n));
  mutate(chunk, previous, earlier);
  const result = validateChunk(chunk, previous, earlier);
  expect(result.ok).toBe(false);
  return result.errors.join('\n');
}

/** Unit vector along the road at a path index. */
function along(path: readonly PathPoint[], i: number): { x: number; z: number } {
  const a = path[i - 1];
  const b = path[i + 1];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
}

/** Removes the wall standing on an edge segment, if any. */
function dropWall(chunk: TrackChunk, side: 'left' | 'right', i: number): void {
  const edge = side === 'left' ? chunk.left : chunk.right;
  const a = edge[i];
  const b = edge[i + 1];
  const at = chunk.walls.findIndex((w) => (w.ax === a.x && w.az === a.z && w.bx === b.x && w.bz === b.z) || (w.ax === b.x && w.az === b.z && w.bx === a.x && w.bz === a.z));
  if (at >= 0) chunk.walls.splice(at, 1);
}

/** A minimal stand-alone stretch of road: a straight from (x, z) along (dx, dz), for the window of another chunk. */
function strayRoad(index: number, x: number, z: number, dx: number, dz: number, y: number, halfWidth: number, dist: number): TrackChunk {
  const path: PathPoint[] = [];
  for (let k = 0; k <= 6; k++) path.push({ x: x + dx * 3 * k, z: z + dz * 3 * k, y, halfWidth, dist: dist + 3 * k });
  const left = path.map((p) => ({ x: p.x + dz * halfWidth, z: p.z - dx * halfWidth }));
  const right = path.map((p) => ({ x: p.x - dz * halfWidth, z: p.z + dx * halfWidth }));
  const walls = [];
  for (const edge of [left, right]) {
    for (let k = 0; k < 6; k++) walls.push({ ax: edge[k].x, az: edge[k].z, bx: edge[k + 1].x, bz: edge[k + 1].z, ya: y, yb: y });
  }
  const xs = [...left, ...right].map((p) => p.x);
  const zs = [...left, ...right].map((p) => p.z);
  return {
    index,
    path,
    left,
    right,
    leftOpen: path.map(() => false),
    rightOpen: path.map(() => false),
    walls,
    props: [],
    bumps: [],
    supports: [],
    decor: [],
    bounds: { minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs), minY: y, maxY: y + 1 },
    startDist: dist,
    endDist: dist + 18,
    intensity: 0.5,
  };
}

describe('validateChunk accepts what the generator makes', () => {
  it('every chunk with its window, and runs of any length', () => {
    harsh.forEach((chunk, n) => {
      expect(validateChunk(chunk, n > 0 ? harsh[n - 1] : null, earlierOf(harsh, n))).toEqual({ ok: true, errors: [] });
    });
    for (const chunk of harsh.slice(1, 12)) expect(validateChunk(chunk, null).ok).toBe(true);
    expect(validateChunkSequence(harsh)).toEqual({ ok: true, errors: [] });
    expect(validateChunkSequence(harsh.slice(17, 26))).toEqual({ ok: true, errors: [] });
    expect(validateChunkSequence([])).toEqual({ ok: true, errors: [] });
  });
});

describe('the intensity rules', () => {
  it('shrink the straight around a bump and the room to an open edge as the road gets harsher', () => {
    expect(minBumpToBend(0)).toBe(16);
    expect(minBumpToBend(1)).toBe(6);
    expect(minBumpBeforeBend(0)).toBe(45);
    expect(minBumpToOpenEdge(0)).toBe(40);
    expect(minBumpToOpenEdge(1)).toBe(0);
    let previous = [Infinity, Infinity, Infinity];
    for (let i = 0; i <= 1; i += 0.05) {
      const now = [minBumpToBend(i), minBumpBeforeBend(i), minBumpToOpenEdge(i)];
      now.forEach((v, k) => expect(v).toBeLessThanOrEqual(previous[k]));
      expect(minBumpBeforeBend(i)).toBeGreaterThanOrEqual(minBumpToBend(i));
      previous = now;
    }
  });
});

describe('the bump flight rule', () => {
  it('asks more straight road ahead of a taller or sharper crest, and none of a crest a car cannot fly off', () => {
    expect(bumpLandingRoom(0.2, 7, 10)).toBe(0);
    expect(bumpLandingRoom(0.8, 5)).toBeGreaterThan(bumpLandingRoom(0.5, 5));
    expect(bumpLandingRoom(0.5, 5)).toBeGreaterThan(bumpLandingRoom(0.5, 7));
    expect(bumpLandingRoom(0.5, 6, 30)).toBeLessThan(bumpLandingRoom(0.5, 6, BUMP_FLIGHT_SPEED));
    // The old harsh gap (6 m) is far too short for a full-height crest taken at speed.
    expect(bumpLandingRoom(CHUNK_RULES.bumpMaxHeight, CHUNK_RULES.bumpMinHalfLength)).toBeGreaterThan(50);
  });

  it('keeps every generated crest far enough before the next bend for its flight', () => {
    for (const chunk of harsh) {
      for (const bump of chunk.bumps) {
        const room = bumpLandingRoom(bump.height, bump.halfLength);
        if (room === 0) continue;
        // Distance along the road from the crest to the chunk's end, which counts as a bend.
        let crest = Infinity;
        let at = 0;
        chunk.path.forEach((p, i) => {
          const d = Math.hypot(p.x - bump.x, p.z - bump.z);
          if (d < crest) {
            crest = d;
            at = i;
          }
        });
        let ahead = chunk.endDist - chunk.path[at].dist;
        for (let i = at + 1; i + 1 < chunk.path.length; i++) {
          if (Math.abs(turnAt(chunk.path, i)) > 0.01) {
            ahead = chunk.path[i].dist - chunk.path[at].dist;
            break;
          }
        }
        expect(ahead + 2).toBeGreaterThanOrEqual(room);
      }
    }
  });

  it('rejects a crest whose flight would carry a car over the next bend', () => {
    let rejected = 0;
    for (let n = 1; n < harsh.length; n++) {
      if (harsh[n].bumps.length === 0) continue;
      const chunk = structuredClone(harsh[n]);
      chunk.bumps[0].height = CHUNK_RULES.bumpMaxHeight;
      chunk.bumps[0].halfLength = CHUNK_RULES.bumpMinHalfLength;
      const result = validateChunk(chunk, structuredClone(harsh[n - 1]), structuredClone(earlierOf(harsh, n)));
      if (result.errors.some((e) => /bump too close to a (bend|chunk join)/.test(e))) rejected++;
    }
    expect(rejected).toBeGreaterThan(5);
  });
});

describe('validateChunk rejects a broken road', () => {
  const straight = findStraight();

  it('non-finite numbers and mismatched arrays', () => {
    expect(broken(straight.n, (c) => (c.path[5].y = NaN))).toMatch(/bad number: path\[5\]/);
    expect(broken(straight.n, (c) => (c.bounds.maxY = Infinity))).toMatch(/bad number: bounds/);
    expect(broken(straight.n, (c) => c.left.pop())).toMatch(/edge arrays differ from path/);
    expect(broken(straight.n, (c) => c.leftOpen.pop())).toMatch(/open-edge arrays differ from path/);
  });

  it('a broken join: position, height, width, dist, edges, order', () => {
    const n = straight.n;
    expect(broken(n, (c) => (c.path[0].x += 1))).toMatch(/join broken/);
    expect(broken(n, (c) => (c.path[0].y += 0.5))).toMatch(/join changes height/);
    expect(broken(n, (c) => (c.path[0].halfWidth += 0.5))).toMatch(/join changes width/);
    expect(
      broken(n, (c) => {
        for (const p of c.path) p.dist += 2;
        c.startDist += 2;
        c.endDist += 2;
      }),
    ).toMatch(/join breaks dist/);
    expect(broken(n, (c) => (c.left[0].z -= 0.5))).toMatch(/join leaves a gap in the walls/);
    expect(broken(n, (c) => (c.index += 1))).toMatch(/chunks out of order/);
  });

  it('a road below the city, too steep, or with a kink in its grade', () => {
    const { n, i } = straight;
    expect(broken(n, (c) => (c.path[i].y = -1))).toMatch(/road below the city/);
    expect(broken(n, (c) => (c.path[i].y += 1.5))).toMatch(/road too steep/);
    expect(broken(n, (c) => (c.path[i].y += 0.2))).toMatch(/grade changes too sharply/);
  });

  it('a road narrower than 7.4 m or with an edge in the wrong place', () => {
    const { n, i } = straight;
    expect(broken(n, (c) => (c.path[i].halfWidth = 7.3))).toMatch(/road too narrow/);
    expect(
      broken(n, (c) => {
        const swap = c.left[i];
        c.left[i] = c.right[i];
        c.right[i] = swap;
      }),
    ).toMatch(/edge not offset by half width/);
  });

  it('a hole in the wall, a wall at the wrong height, a wall that is not an edge', () => {
    const { n, i } = straight;
    expect(broken(n, (c) => dropWall(c, 'left', i))).toMatch(/road edge has no wall/);
    expect(broken(n, (c) => (c.walls[3].ya += 1))).toMatch(/wall height differs from the road/);
    expect(
      broken(n, (c) => {
        const last = c.path.length - 1;
        c.walls.push({ ax: c.left[last].x, az: c.left[last].z, bx: c.right[last].x, bz: c.right[last].z, ya: 0, yb: 0 });
      }),
    ).toMatch(/walls that are not road edges/);
  });

  it('a first chunk that is open behind, not level, or not empty', () => {
    expect(broken(0, (c) => c.walls.splice(0, 1))).toMatch(/wall behind the start is not closed/);
    expect(broken(0, (c) => c.walls.splice(0, 3))).toMatch(/no wall behind the start/);
    expect(broken(0, (c) => (c.path[6].y += 0.01))).toMatch(/start is not level/);
    expect(
      broken(0, (c) => {
        const p = c.path[30];
        c.bumps.push({ x: p.x, z: p.z, y: p.y, dirX: 1, dirZ: 0, halfLength: 6, halfWidth: p.halfWidth + 1, height: 0.5 });
      }),
    ).toMatch(/bumps in the first chunk/);
  });

  it('bounds that leave something out', () => {
    expect(broken(straight.n, (c) => (c.bounds.maxX -= 30))).toMatch(/bounds do not contain everything/);
    expect(broken(straight.n, (c) => (c.bounds.maxY = c.path[0].y - 1))).toMatch(/bounds do not contain everything/);
  });
});

describe('validateChunk checks the road against its memory window', () => {
  it('a road laid over an earlier stretch at the same level', () => {
    const n = 20;
    const errors = broken(n, (c, _previous, earlier) => {
      // An earlier chunk of the window lies exactly where this one does, at the same height.
      const ghost = structuredClone(c);
      ghost.index = earlier[0].index;
      for (const p of ghost.path) p.dist -= 5000;
      ghost.startDist -= 5000;
      ghost.endDist -= 5000;
      earlier[0] = ghost;
    });
    expect(errors).toMatch(/road runs into itself/);
  });

  it('an overpass too low over an earlier stretch', () => {
    const n = 20;
    const errors = broken(n, (c, _previous, earlier) => {
      const ghost = structuredClone(c);
      ghost.index = earlier[0].index;
      for (const p of ghost.path) {
        p.dist -= 5000;
        p.y += CROSSING_CLEARANCE - 3;
      }
      earlier[0] = ghost;
    });
    expect(errors).toMatch(/crossing too low/);
  });

  it('ignores road older than the memory window', () => {
    const n = 20;
    const chunk = harsh[n];
    const ghost = structuredClone(chunk);
    ghost.index = n - CHUNK_RULES.memory - 1;
    for (const p of ghost.path) p.dist -= 5000;
    const verdict = validateChunk(chunk, harsh[n - 1], [ghost, ...earlierOf(harsh, n)]);
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('an open edge that a car could drop off onto other road', () => {
    const { n, i } = findStraight({ raised: true });
    const errors = broken(n, (c, _previous, earlier) => {
      c.leftOpen[i] = true;
      dropWall(c, 'left', i);
      // Another stretch of road 8 to 16 m beyond that edge, far below.
      const dir = along(c.path, i);
      const out = { x: dir.z, z: -dir.x };
      const reach = c.path[i].halfWidth + 12;
      const start = { x: c.path[i].x + out.x * reach - dir.x * 9, z: c.path[i].z + out.z * reach - dir.z * 9 };
      earlier[0] = strayRoad(earlier[0].index, start.x, start.z, dir.x, dir.z, 0, 4, c.startDist - 9000);
    });
    expect(errors).toMatch(/open edge above another road/);
  });
});

describe('validateChunk checks open edges', () => {
  it('an open edge on low road, with a wall left on it, or too short', () => {
    // The first chunk opens level at ground height.
    expect(harsh[0].path[10].y).toBeLessThan(3);
    expect(
      broken(0, (c) => {
        for (let k = 4; k < 16; k++) {
          c.leftOpen[k] = true;
          dropWall(c, 'left', k);
        }
      }),
    ).toMatch(/open edge on low road/);
    const high = findStraight({ raised: true });
    expect(broken(high.n, (c) => (c.leftOpen[high.i] = true))).toMatch(/open edge has a wall/);
    expect(
      broken(high.n, (c) => {
        c.leftOpen[high.i] = true;
        dropWall(c, 'left', high.i);
      }),
    ).toMatch(/open stretch too short/);
  });

  it('open edges in the first chunk', () => {
    expect(
      broken(0, (c) => {
        for (let k = 10; k < 30; k++) {
          c.rightOpen[k] = true;
          dropWall(c, 'right', k);
        }
      }),
    ).toMatch(/open edges in the first chunk/);
  });
});

describe('validateChunk checks what stands on and under the road', () => {
  const { n, i } = findStraight();

  function bumpAt(c: TrackChunk, k: number, changes: Partial<Bump> = {}): Bump {
    const dir = along(c.path, k);
    const p = c.path[k];
    return { x: p.x, z: p.z, y: p.y, dirX: dir.x, dirZ: dir.z, halfLength: 6, halfWidth: p.halfWidth + 1, height: 0.5, ...changes };
  }

  it('bumps that are too big, off the centreline or off the surface', () => {
    expect(broken(n, (c) => c.bumps.push(bumpAt(c, i, { height: 2 })))).toMatch(/bump height outside/);
    expect(broken(n, (c) => c.bumps.push(bumpAt(c, i, { halfLength: 12 })))).toMatch(/bump half length outside/);
    expect(broken(n, (c) => c.bumps.push(bumpAt(c, i, { y: c.path[i].y + 3 })))).toMatch(/bump is not centred on the road/);
    expect(broken(n, (c) => c.bumps.push(bumpAt(c, i, { halfWidth: 2 })))).toMatch(/bump does not span the road/);
  });

  it('a bump on a slope', () => {
    const slope = (() => {
      for (let m = 3; m < harsh.length; m++) {
        const path = harsh[m].path;
        for (let k = 20; k < path.length - 20; k++) {
          const grade = (path[k + 1].y - path[k - 1].y) / (path[k + 1].dist - path[k - 1].dist);
          if (Math.abs(grade) > 0.06 && Math.abs(turnAt(path, k)) < 1e-3) return { m, k };
        }
      }
      throw new Error('no slope found');
    })();
    expect(broken(slope.m, (c) => c.bumps.push(bumpAt(c, slope.k)))).toMatch(/bump on a slope/);
  });

  function pillar(c: TrackChunk, k: number, lateral: number, changes: Partial<Prop> = {}): Prop {
    const dir = along(c.path, k);
    const p = c.path[k];
    return { kind: 'pillar', x: p.x - dir.z * lateral, z: p.z + dir.x * lateral, y: p.y, radius: 1.5, height: 5, hue: 0, ...changes };
  }

  it('pillars outside the road, at the wrong height or in the first chunk', () => {
    expect(broken(n, (c) => c.props.push(pillar(c, i, c.path[i].halfWidth + 3)))).toMatch(/prop is not inside the road/);
    expect(broken(n, (c) => c.props.push(pillar(c, i, 0, { y: c.path[i].y + 4 })))).toMatch(/prop is not inside the road/);
    expect(broken(0, (c) => c.props.push(pillar(c, 40, 3)))).toMatch(/props in the first chunk/);
  });

  it('a support that holds up nothing', () => {
    const raised = findStraight({ raised: true });
    expect(
      broken(raised.n, (c) => {
        const p = c.path[raised.i];
        c.supports.push({ x: p.x, z: p.z, top: p.y - 3, radius: 1 });
      }),
    ).toMatch(/support holds up nothing/);
  });

  function blockBeside(c: TrackChunk, k: number, gap: number, h: number): DecorBlock {
    const dir = along(c.path, k);
    const p = c.path[k];
    const reach = p.halfWidth + gap + 4;
    return { x: p.x + dir.z * reach, z: p.z - dir.x * reach, w: 8, d: 8, h, hue: 0 };
  }

  it('decor on the road, too tall beside it, overlapping or the wrong size', () => {
    expect(
      broken(n, (c) => {
        const p = c.path[i];
        c.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 5, hue: 0 });
      }),
    ).toMatch(/decor stands on the road/);
    expect(broken(n, (c) => c.decor.push(blockBeside(c, i, 5, 40)))).toMatch(/decor too tall or too close to the road/);
    expect(
      broken(n, (c) => {
        const block = blockBeside(c, i, 30, 5);
        c.decor.push(block, { ...block, x: block.x + 1 });
      }),
    ).toMatch(/decor blocks overlap/);
    expect(broken(n, (c) => c.decor.push({ ...blockBeside(c, i, 30, 5), w: 40 }))).toMatch(/decor footprint outside/);
  });

  it('decor of an earlier chunk that the new road runs into', () => {
    const errors = broken(n, (c, previous) => {
      const p = c.path[i];
      previous!.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 5, hue: 0 });
    });
    expect(errors).toMatch(/decor stands on the road/);
  });
});
