import { describe, expect, it } from 'vitest';
import { createEndlessGenerator } from '../../src/gen/endless';
import {
  CHUNK_RULES,
  minBumpBeforeBend,
  minBumpToBend,
  validateChunk,
  validateChunkSequence,
} from '../../src/gen/validateChunk';
import type { Bump, DecorBlock, Difficulty, Prop, TrackChunk } from '../../src/types';

function run(seed: string, difficulty: Difficulty, count: number): TrackChunk[] {
  const generator = createEndlessGenerator(seed, difficulty);
  const chunks: TrackChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push(generator.next());
  return chunks;
}

const harsh = run('validate-harsh', 'hard', 40);
const gentle = run('validate-gentle', 'easy', 8);

/** Turn at a path vertex as the sine of the angle: 0 on a straight. */
function turnAt(chunk: TrackChunk, i: number): number {
  const p = chunk.path;
  const ax = p[i].x - p[i - 1].x;
  const az = p[i].z - p[i - 1].z;
  const bx = p[i + 1].x - p[i].x;
  const bz = p[i + 1].z - p[i].z;
  return (ax * bz - az * bx) / Math.sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
}

/** True when every vertex within `reach` samples of `i` is straight (or bent, when `bent` is set). */
function uniformAround(chunk: TrackChunk, i: number, reach: number, bent: boolean): boolean {
  if (i - reach < 1 || i + reach > chunk.path.length - 2) return false;
  for (let k = i - reach; k <= i + reach; k++) {
    if (Math.abs(turnAt(chunk, k)) > 1e-3 !== bent) return false;
  }
  return true;
}

interface Site {
  chunk: TrackChunk;
  previous: TrackChunk;
  /** Path index inside `chunk`. */
  index: number;
}

/** A copy without bumps and pillars, so that whatever a test puts on the road is the only thing wrong with it. */
function bare(chunk: TrackChunk): TrackChunk {
  const copy = structuredClone(chunk);
  copy.bumps.length = 0;
  copy.props.length = 0;
  return copy;
}

/**
 * A place on plain road (not a plaza) in the middle of a bend, or in the middle of a long straight of constant
 * width.
 */
function findSite(chunks: readonly TrackChunk[], bent: boolean, maxHalfWidth = 13): Site {
  for (let n = 2; n < chunks.length; n++) {
    const chunk = chunks[n];
    for (let i = 12; i < chunk.path.length - 12; i++) {
      const width = chunk.path[i].halfWidth;
      if (width > maxHalfWidth || !uniformAround(chunk, i, bent ? 4 : 10, bent)) continue;
      if (!bent && chunk.path.slice(i - 5, i + 6).some((p) => p.halfWidth !== width)) continue;
      return { chunk: bare(chunk), previous: bare(chunks[n - 1]), index: i };
    }
  }
  throw new Error('no suitable site found');
}

/** Unit vector along the road at a path index. */
function along(chunk: TrackChunk, i: number): { x: number; z: number } {
  const a = chunk.path[i - 1];
  const b = chunk.path[i + 1];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
}

function bumpAt(chunk: TrackChunk, i: number, changes: Partial<Bump> = {}): Bump {
  const dir = along(chunk, i);
  const p = chunk.path[i];
  const bump = { x: p.x, z: p.z, dirX: dir.x, dirZ: dir.z, halfLength: 6, halfWidth: p.halfWidth + 1, height: 0.5 };
  return { ...bump, ...changes };
}

/** A pillar `lateral` metres to the right of the centreline at a path index. */
function pillarAt(chunk: TrackChunk, i: number, lateral: number, radius: number): Prop {
  const dir = along(chunk, i);
  const p = chunk.path[i];
  return { kind: 'pillar', x: p.x - dir.z * lateral, z: p.z + dir.x * lateral, radius, height: 5, hue: 0 };
}

/** A block whose near face is `gap` metres outside the left wall at a path index of an axis-aligned straight. */
function blockBeside(chunk: TrackChunk, i: number, gap: number, h: number): DecorBlock {
  const dir = along(chunk, i);
  const p = chunk.path[i];
  const reach = p.halfWidth + gap + 4;
  return { x: p.x + dir.z * reach, z: p.z - dir.x * reach, w: 8, d: 8, h, hue: 0 };
}

/** Grows the chunk's bounds around a box, so a test about something else does not also trip the bounds check. */
function widenBounds(chunk: TrackChunk, x: number, z: number, reach: number): void {
  chunk.bounds.minX = Math.min(chunk.bounds.minX, x - reach);
  chunk.bounds.minZ = Math.min(chunk.bounds.minZ, z - reach);
  chunk.bounds.maxX = Math.max(chunk.bounds.maxX, x + reach);
  chunk.bounds.maxZ = Math.max(chunk.bounds.maxZ, z + reach);
}

/** Validates a mutated copy of a site's chunk against its untouched predecessor and returns the complaints. */
function broken(site: Site, mutate: (chunk: TrackChunk, previous: TrackChunk) => void): string {
  const chunk = structuredClone(site.chunk);
  const previous = structuredClone(site.previous);
  mutate(chunk, previous);
  const result = validateChunk(chunk, previous);
  expect(result.ok).toBe(false);
  return result.errors.join('\n');
}

describe('validateChunk accepts what the generator makes', () => {
  it('passes every chunk against the one before it', () => {
    for (const chunks of [harsh, gentle]) {
      chunks.forEach((chunk, n) => {
        expect(validateChunk(chunk, n > 0 ? chunks[n - 1] : null)).toEqual({ ok: true, errors: [] });
      });
    }
  });

  it('passes a chunk judged on its own, without the one before it', () => {
    for (const chunk of harsh) expect(validateChunk(chunk, null)).toEqual({ ok: true, errors: [] });
  });

  it('passes a run that starts anywhere, as the live window of chunks does', () => {
    expect(validateChunkSequence(harsh)).toEqual({ ok: true, errors: [] });
    expect(validateChunkSequence(harsh.slice(17, 26))).toEqual({ ok: true, errors: [] });
    expect(validateChunkSequence(harsh.slice(5, 6))).toEqual({ ok: true, errors: [] });
    expect(validateChunkSequence([])).toEqual({ ok: true, errors: [] });
  });

  it('does not change the chunks it checks', () => {
    const before = JSON.stringify(harsh.slice(0, 6));
    validateChunkSequence(harsh.slice(0, 6));
    expect(JSON.stringify(harsh.slice(0, 6))).toBe(before);
  });

  it('asks for 16 m of straight after a bump on a gentle road and 6 m at full intensity', () => {
    expect(minBumpToBend(0)).toBe(16);
    expect(minBumpToBend(CHUNK_RULES.gentleIntensity)).toBe(16);
    expect(minBumpToBend(1)).toBe(6);
    let previous = 16;
    for (let i = 0.3; i <= 1; i += 0.05) {
      expect(minBumpToBend(i)).toBeLessThanOrEqual(previous);
      previous = minBumpToBend(i);
    }
  });

  it('asks for 45 m of straight between a bump and the bend ahead on a gentle road, fading to the ordinary gap', () => {
    expect(CHUNK_RULES.bumpLandingGentle).toBe(45);
    expect(minBumpBeforeBend(0)).toBe(45);
    expect(minBumpBeforeBend(0.1)).toBe(45);
    expect(minBumpBeforeBend(CHUNK_RULES.gentleIntensity)).toBe(45);
    // From there the landing room fades out; medium's starting intensity still gets most of it.
    expect(minBumpBeforeBend(0.35)).toBeGreaterThan(30);
    expect(minBumpBeforeBend(0.35)).toBeLessThan(45);
    let previous = 45;
    for (let i = 0; i <= 1.0001; i += 0.01) {
      expect(minBumpBeforeBend(i)).toBeLessThanOrEqual(previous);
      expect(minBumpBeforeBend(i)).toBeGreaterThanOrEqual(minBumpToBend(i));
      previous = minBumpBeforeBend(i);
      // Past the fade it is the ordinary gap exactly, so harsher roads are generated as they always were.
      if (i >= CHUNK_RULES.bumpLandingFadeEnd) expect(minBumpBeforeBend(i)).toBe(minBumpToBend(i));
    }
  });
});

describe('validateChunk rejects a broken road', () => {
  const site = findSite(harsh, false);

  it('non-finite numbers', () => {
    expect(broken(site, (chunk) => (chunk.path[5].x = NaN))).toMatch(/bad number: path\[5\]/);
    expect(broken(site, (chunk) => (chunk.left[5].z = Infinity))).toMatch(/bad number: left\[5\]/);
    expect(broken(site, (chunk) => (chunk.bounds.maxX = NaN))).toMatch(/bad number: bounds/);
  });

  it('mismatched arrays', () => {
    expect(broken(site, (chunk) => chunk.left.pop())).toMatch(/edge arrays differ from path/);
  });

  it('uneven path spacing', () => {
    const errors = broken(site, (chunk) => {
      chunk.path.splice(site.index, 2);
      chunk.left.splice(site.index, 2);
      chunk.right.splice(site.index, 2);
    });
    expect(errors).toMatch(/path spacing outside 1\.\.5 m/);
  });

  it('dist that stalls or jumps', () => {
    expect(broken(site, (chunk) => (chunk.path[9].dist = chunk.path[8].dist))).toMatch(/path dist not increasing/);
    expect(
      broken(site, (chunk) => {
        for (let i = 9; i < chunk.path.length; i++) chunk.path[i].dist += 40;
        chunk.endDist += 40;
      }),
    ).toMatch(/path dist jumps/);
    expect(broken(site, (chunk) => (chunk.endDist += 1))).toMatch(/endDist differs from final dist/);
  });

  it('a road narrower than 7.4 m', () => {
    expect(broken(site, (chunk) => (chunk.path[site.index].halfWidth = 7.3))).toMatch(/road too narrow/);
  });

  it('a broken join', () => {
    expect(broken(site, (chunk) => (chunk.path[0].x += 1))).toMatch(/join broken/);
    expect(broken(site, (chunk) => (chunk.path[0].halfWidth += 0.5))).toMatch(/join changes width/);
    expect(
      broken(site, (chunk) => {
        for (const p of chunk.path) p.dist += 2;
        chunk.startDist += 2;
        chunk.endDist += 2;
      }),
    ).toMatch(/join breaks dist/);
    expect(broken(site, (chunk) => (chunk.left[0].z -= 0.5))).toMatch(/join leaves a gap in the walls/);
    expect(broken(site, (chunk) => (chunk.index += 1))).toMatch(/chunks out of order/);
    // A chunk that is fine in itself, placed after the wrong chunk.
    const result = validateChunk(harsh[9], harsh[7]);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/join broken/);
  });

  it('an edge that is not offset by the half width', () => {
    const errors = broken(site, (chunk) => {
      const i = site.index;
      const swap = chunk.left[i];
      chunk.left[i] = chunk.right[i];
      chunk.right[i] = swap;
    });
    expect(errors).toMatch(/edge not offset by half width/);
  });

  it('overlapping edges', () => {
    const errors = broken(site, (chunk) => {
      // Pull one point of the left edge right across the road and out the other side.
      const i = site.index;
      const from = chunk.left[i];
      const to = chunk.right[i];
      chunk.left[i] = { x: to.x + (to.x - from.x) * 0.25, z: to.z + (to.z - from.z) * 0.25 };
    });
    expect(errors).toMatch(/road edges intersect/);
  });

  it('a road folded back over the previous chunk', () => {
    const errors = broken(site, (chunk, previous) => {
      // Lay the chunk over the one before it, as if the walk had re-entered used cells.
      const dx = previous.path[0].x - chunk.path[0].x + 3;
      const dz = previous.path[0].z - chunk.path[0].z + 3;
      for (const p of [...chunk.path, ...chunk.left, ...chunk.right]) {
        p.x += dx;
        p.z += dz;
      }
    });
    expect(errors).toMatch(/road runs into itself/);
    expect(errors).toMatch(/road edges intersect/);
  });

  it('a hole in the wall', () => {
    expect(broken(site, (chunk) => chunk.walls.splice(site.index, 1))).toMatch(/road edge has no wall/);
    expect(broken(site, (chunk) => (chunk.walls[site.index].bz += 2))).toMatch(/road edge has no wall/);
  });

  it('a wall that is not a road edge', () => {
    const errors = broken(site, (chunk) => {
      const last = chunk.path.length - 1;
      const l = chunk.left[last];
      const r = chunk.right[last];
      chunk.walls.push({ ax: l.x, az: l.z, bx: r.x, bz: r.z });
    });
    expect(errors).toMatch(/walls that are not road edges/);
  });

  it('a first chunk left open behind the start', () => {
    const first = structuredClone(harsh[0]);
    first.walls.pop();
    const open = validateChunk(first, null);
    expect(open.errors.join('\n')).toMatch(/wall behind the start is not closed/);
    const none = structuredClone(harsh[0]);
    none.walls.length = 2 * (none.path.length - 1);
    expect(validateChunk(none, null).errors.join('\n')).toMatch(/no wall behind the start/);
  });

  it('bounds that leave something out', () => {
    expect(broken(site, (chunk) => (chunk.bounds.maxX -= 30))).toMatch(/bounds do not contain everything/);
  });

  it('an intensity outside 0..1', () => {
    expect(broken(site, (chunk) => (chunk.intensity = 1.2))).toMatch(/intensity outside 0\.\.1/);
  });
});

describe('validateChunk rejects misplaced bumps', () => {
  const straight = findSite(harsh, false);
  const bend = findSite(harsh, true);

  it('accepts a well-placed bump, so the rejections below are about what they say', () => {
    const chunk = structuredClone(straight.chunk);
    chunk.bumps.push(bumpAt(chunk, straight.index));
    expect(validateChunk(chunk, straight.previous)).toEqual({ ok: true, errors: [] });
  });

  it('a bump on a bend', () => {
    const errors = broken(bend, (chunk) => chunk.bumps.push(bumpAt(chunk, bend.index)));
    expect(errors).toMatch(/bump too close to a bend/);
  });

  it('a bump with too little straight after it for a gentle road', () => {
    // Twelve metres before a bend is fine flat out and too close on an easy road.
    const place = (chunks: readonly TrackChunk[]): { chunk: TrackChunk; previous: TrackChunk; index: number } => {
      for (let n = 2; n < chunks.length; n++) {
        const chunk = chunks[n];
        for (let i = 14; i < chunk.path.length - 14; i++) {
          const startsBend = Math.abs(turnAt(chunk, i + 4)) > 1e-3 && uniformAround(chunk, i - 3, 6, false);
          if (!startsBend || chunk.path[i].halfWidth >= 13) continue;
          return { chunk: bare(chunk), previous: bare(chunks[n - 1]), index: i };
        }
      }
      throw new Error('no straight before a bend found');
    };
    const easy = place(gentle);
    expect(easy.chunk.intensity).toBeLessThan(CHUNK_RULES.gentleIntensity);
    expect(broken(easy, (chunk) => chunk.bumps.push(bumpAt(chunk, easy.index)))).toMatch(/bump too close to a bend/);
    const hard = place(harsh.slice(20));
    expect(hard.chunk.intensity).toBe(1);
    const chunk = structuredClone(hard.chunk);
    // The road widens into the bend, so the ridge has to be a little wider than at its crest.
    chunk.bumps.push(bumpAt(chunk, hard.index, { halfWidth: chunk.path[hard.index].halfWidth + 2.5 }));
    expect(validateChunk(chunk, hard.previous)).toEqual({ ok: true, errors: [] });
  });

  it('a bump 30 m before a bend on a gentle road, while 30 m after one is fine', () => {
    // The rule looks ahead: a car comes down 20 to 30 m past a crest, and behind the crest it only needs room to
    // straighten up. Every stretch of plain straight on a few easy roads is tried both ways round.
    const bentAt = (chunk: TrackChunk, i: number): boolean => Math.abs(turnAt(chunk, i)) > 1e-3;
    let before: Site | null = null;
    let after: Site | null = null;
    for (let s = 0; s < 12 && !(before && after); s++) {
      const chunks = run(`landing-room-${s}`, 'easy', 8);
      for (let n = 2; n < chunks.length && !(before && after); n++) {
        const chunk = chunks[n];
        if (chunk.intensity >= CHUNK_RULES.gentleIntensity) continue;
        const path = chunk.path;
        for (let i = 12; i < path.length - 12; i++) {
          const width = path[i].halfWidth;
          if (width >= 13 || path.slice(i - 3, i + 4).some((p) => p.halfWidth !== width)) continue;
          let ahead = Infinity;
          let behind = Infinity;
          for (let k = 1; k < path.length - 1; k++) {
            if (!bentAt(chunk, k)) continue;
            if (k > i) ahead = Math.min(ahead, path[k].dist - path[i].dist);
            else behind = Math.min(behind, path[i].dist - path[k].dist);
          }
          const toEnd = chunk.endDist - path[i].dist;
          const toStart = path[i].dist - chunk.startDist;
          if (toStart < 50) continue;
          const site = { chunk: bare(chunk), previous: bare(chunks[n - 1]), index: i };
          if (!before && ahead > 26 && ahead < 34 && behind > 50 && toEnd > 50) before = site;
          if (!after && behind > 26 && behind < 34 && ahead > 50 && toEnd > 50) after = site;
        }
      }
    }
    if (!before || !after) throw new Error('no straight 30 m from a bend found');
    const errors = broken(before, (chunk) => chunk.bumps.push(bumpAt(chunk, before.index)));
    expect(errors).toMatch(/bump too close to a bend/);
    expect(errors).toMatch(/of straight after it, needs 45/);
    const chunk = structuredClone(after.chunk);
    chunk.bumps.push(bumpAt(chunk, after.index));
    expect(validateChunk(chunk, after.previous)).toEqual({ ok: true, errors: [] });
  });

  it('a bump within 45 m of the open end of a gentle chunk, where the next chunk may begin with a bend', () => {
    for (const chunk of gentle.slice(2)) {
      if (chunk.intensity >= CHUNK_RULES.gentleIntensity) continue;
      const path = chunk.path;
      // 30 m before the end of the chunk: its last cell is always a straight.
      const i = path.length - 11;
      const site = { chunk: bare(chunk), previous: bare(gentle[chunk.index - 1]), index: i };
      expect(broken(site, (copy) => copy.bumps.push(bumpAt(copy, i)))).toMatch(/bump too close to a chunk join/);
    }
  });

  it('a bump next to a chunk join', () => {
    expect(broken(straight, (chunk) => chunk.bumps.push(bumpAt(chunk, chunk.path.length - 4)))).toMatch(
      /bump too close to a chunk join/,
    );
    expect(broken(straight, (chunk) => chunk.bumps.push(bumpAt(chunk, 3)))).toMatch(/bump too close to a chunk join/);
  });

  it('a bump of the wrong size', () => {
    const add = (changes: Partial<Bump>) => (chunk: TrackChunk) =>
      chunk.bumps.push(bumpAt(chunk, straight.index, changes));
    expect(broken(straight, add({ height: 0.2 }))).toMatch(/bump height outside 0\.35\.\.0\.8 m/);
    expect(broken(straight, add({ height: 1.1 }))).toMatch(/bump height outside 0\.35\.\.0\.8 m/);
    expect(broken(straight, add({ halfLength: 3 }))).toMatch(/bump half length outside 5\.\.7 m/);
    expect(broken(straight, add({ halfLength: 9 }))).toMatch(/bump half length outside 5\.\.7 m/);
  });

  it('a bump that does not face along the road', () => {
    const p = straight.chunk.path[straight.index];
    const dir = along(straight.chunk, straight.index);
    const add = (changes: Partial<Bump>) => (chunk: TrackChunk) =>
      chunk.bumps.push(bumpAt(chunk, straight.index, changes));
    const turned = (angle: number): Partial<Bump> => ({
      dirX: dir.x * Math.cos(angle) - dir.z * Math.sin(angle),
      dirZ: dir.z * Math.cos(angle) + dir.x * Math.sin(angle),
    });
    const stretched = { dirX: dir.x * 1.2, dirZ: dir.z * 1.2 };
    const offCentre = { x: p.x - dir.z * 2, z: p.z + dir.x * 2 };
    expect(broken(straight, add(stretched))).toMatch(/bump direction is not a unit vector/);
    expect(broken(straight, add(turned(0.1)))).toMatch(/bump is not square to the road/);
    expect(broken(straight, add({ dirX: -dir.x, dirZ: -dir.z }))).toMatch(/bump is not square to the road/);
    expect(broken(straight, add(offCentre))).toMatch(/bump is not centred on the road/);
    // A few hundredths of a radian off is within tolerance.
    const chunk = structuredClone(straight.chunk);
    chunk.bumps.push(bumpAt(chunk, straight.index, turned(0.03)));
    expect(validateChunk(chunk, straight.previous)).toEqual({ ok: true, errors: [] });
  });

  it('a bump that stops short of the walls, or reaches far past them', () => {
    const width = straight.chunk.path[straight.index].halfWidth;
    expect(
      broken(straight, (chunk) => chunk.bumps.push(bumpAt(chunk, straight.index, { halfWidth: width - 1 }))),
    ).toMatch(/bump does not span the road/);
    expect(
      broken(straight, (chunk) => {
        chunk.bumps.push(bumpAt(chunk, straight.index, { halfWidth: width + 8 }));
        widenBounds(chunk, chunk.path[straight.index].x, chunk.path[straight.index].z, 40);
      }),
    ).toMatch(/bump is far wider than the road/);
  });

  it('a bump on a plaza', () => {
    for (let n = 2; n < harsh.length; n++) {
      const chunk = harsh[n];
      const i = chunk.path.findIndex((p, k) => p.halfWidth > 15 && k > 12 && k < chunk.path.length - 12);
      if (i < 0) continue;
      const plaza = { chunk: bare(chunk), previous: bare(harsh[n - 1]), index: i };
      const errors = broken(plaza, (copy) => copy.bumps.push(bumpAt(copy, i)));
      expect(errors).toMatch(/bump on a plaza or a width change/);
      return;
    }
    throw new Error('no plaza found');
  });

  it('two bumps close together', () => {
    const errors = broken(straight, (chunk) => {
      chunk.bumps.push(bumpAt(chunk, straight.index - 4), bumpAt(chunk, straight.index + 4));
    });
    expect(errors).toMatch(/bumps too close together/);
  });

  it('a bump too close to one in the previous chunk', () => {
    const errors = broken(straight, (chunk, previous) => {
      chunk.bumps.push(bumpAt(chunk, 8));
      previous.bumps.push(bumpAt(previous, previous.path.length - 9));
    });
    expect(errors).toMatch(/bumps too close together/);
  });

  it('a bump beside a pillar', () => {
    const errors = broken(straight, (chunk) => {
      chunk.bumps.push(bumpAt(chunk, straight.index));
      chunk.props.push(pillarAt(chunk, straight.index + 3, chunk.path[straight.index].halfWidth - 2.5, 1.5));
    });
    expect(errors).toMatch(/bump too close to a pillar/);
  });

  it('bumps or pillars in the first chunk', () => {
    const first = structuredClone(harsh[0]);
    first.bumps.push(bumpAt(first, 60));
    first.props.push(pillarAt(first, 30, first.path[30].halfWidth - 2.5, 1.5));
    const errors = validateChunk(first, null).errors.join('\n');
    expect(errors).toMatch(/bumps in the first chunk/);
    expect(errors).toMatch(/props in the first chunk/);
  });
});

describe('validateChunk rejects misplaced pillars', () => {
  // Narrow road: a pillar in the middle of it leaves no way round.
  const straight = findSite(harsh.slice(20), false, 9.5);
  const bend = findSite(harsh, true);

  it('accepts a pillar by the wall, so the rejections below are about what they say', () => {
    const chunk = structuredClone(straight.chunk);
    chunk.props.push(pillarAt(chunk, straight.index, chunk.path[straight.index].halfWidth - 2.2, 1.5));
    expect(validateChunk(chunk, straight.previous)).toEqual({ ok: true, errors: [] });
  });

  it('a pillar blocking the road', () => {
    const errors = broken(straight, (chunk) => chunk.props.push(pillarAt(chunk, straight.index, 0, 2.5)));
    expect(errors).toMatch(/prop blocks the road/);
  });

  it('a pillar outside the road or in the wall', () => {
    const width = straight.chunk.path[straight.index].halfWidth;
    expect(broken(straight, (chunk) => chunk.props.push(pillarAt(chunk, straight.index, width + 3, 1.5)))).toMatch(
      /prop is not inside the road/,
    );
    expect(broken(straight, (chunk) => chunk.props.push(pillarAt(chunk, straight.index, width - 1, 1.5)))).toMatch(
      /prop is not inside the road/,
    );
  });

  it('a pillar in a bend', () => {
    const errors = broken(bend, (chunk) => {
      chunk.props.push(pillarAt(chunk, bend.index, chunk.path[bend.index].halfWidth - 2.2, 1.5));
    });
    expect(errors).toMatch(/prop in a bend/);
  });

  it('a pillar next to a chunk join', () => {
    const errors = broken(straight, (chunk) => {
      const i = chunk.path.length - 4;
      chunk.props.push(pillarAt(chunk, i, chunk.path[i].halfWidth - 2.2, 1.5));
    });
    expect(errors).toMatch(/prop too close to a chunk join/);
  });

  it('pillars close together, in one chunk or across a join', () => {
    const width = straight.chunk.path[straight.index].halfWidth;
    expect(
      broken(straight, (chunk) => {
        chunk.props.push(pillarAt(chunk, straight.index - 4, width - 2.2, 1.5));
        chunk.props.push(pillarAt(chunk, straight.index + 4, 2.2 - width, 1.5));
      }),
    ).toMatch(/props too close together/);
    // Across a join: 15 m either side of it, on a chunk that opens with a straight.
    const n = harsh.findIndex((chunk, k) => k > 1 && uniformAround(chunk, 8, 7, false));
    const join = { chunk: bare(harsh[n]), previous: bare(harsh[n - 1]), index: 5 };
    expect(
      broken(join, (chunk, previous) => {
        chunk.props.push(pillarAt(chunk, 5, chunk.path[5].halfWidth - 2.2, 1.5));
        const i = previous.path.length - 6;
        previous.props.push(pillarAt(previous, i, previous.path[i].halfWidth - 2.2, 1.5));
      }),
    ).toMatch(/props too close together/);
  });

  it('a pillar of an impossible size', () => {
    const errors = broken(straight, (chunk) => {
      chunk.props.push(pillarAt(chunk, straight.index, chunk.path[straight.index].halfWidth - 2.2, -1));
    });
    expect(errors).toMatch(/prop has a bad size/);
  });
});

describe('validateChunk rejects misplaced decor', () => {
  const site = findSite(harsh, false);

  /** Drops the generated scenery so a block added by a test cannot land on top of one that is already there. */
  function clearDecor(chunk: TrackChunk, previous: TrackChunk): void {
    chunk.decor.length = 0;
    previous.decor.length = 0;
  }

  it('accepts a low block near the road and a tall one far from it', () => {
    const chunk = structuredClone(site.chunk);
    const previous = structuredClone(site.previous);
    clearDecor(chunk, previous);
    chunk.decor.push(blockBeside(chunk, site.index, 5, 4.4));
    expect(validateChunk(chunk, previous)).toEqual({ ok: true, errors: [] });
  });

  it('a tall block by the road', () => {
    const errors = broken(site, (chunk, previous) => {
      clearDecor(chunk, previous);
      chunk.decor.push(blockBeside(chunk, site.index, 5, 40));
    });
    expect(errors).toMatch(/decor too tall or too close to the road/);
  });

  it('a block against the wall, however low', () => {
    const errors = broken(site, (chunk, previous) => {
      clearDecor(chunk, previous);
      chunk.decor.push(blockBeside(chunk, site.index, 2, 3));
    });
    expect(errors).toMatch(/decor too tall or too close to the road/);
  });

  it('a block standing on the road', () => {
    const errors = broken(site, (chunk, previous) => {
      clearDecor(chunk, previous);
      const p = chunk.path[site.index];
      chunk.decor.push({ x: p.x, z: p.z, w: 6, d: 6, h: 3, hue: 0 });
    });
    expect(errors).toMatch(/decor stands on the road/);
  });

  it('a block of the wrong shape', () => {
    const add = (changes: Partial<DecorBlock>) => (chunk: TrackChunk, previous: TrackChunk) => {
      clearDecor(chunk, previous);
      chunk.decor.push({ ...blockBeside(chunk, site.index, 6, 4), ...changes });
    };
    expect(broken(site, add({ w: 3 }))).toMatch(/decor footprint outside 6\.\.22 m/);
    expect(broken(site, add({ h: 2 }))).toMatch(/decor height outside 3\.\.70 m/);
    expect(broken(site, add({ hue: 9 }))).toMatch(/decor hue outside 0\.\.5/);
  });

  it('overlapping blocks, in one chunk or across two', () => {
    expect(
      broken(site, (chunk, previous) => {
        clearDecor(chunk, previous);
        const block = blockBeside(chunk, site.index, 6, 4);
        chunk.decor.push(block, { ...block, x: block.x + 3 });
      }),
    ).toMatch(/decor blocks overlap/);
    expect(
      broken(site, (chunk, previous) => {
        clearDecor(chunk, previous);
        const block = blockBeside(chunk, site.index, 6, 4);
        chunk.decor.push(block);
        previous.decor.push({ ...block, z: block.z + 3 });
      }),
    ).toMatch(/decor blocks overlap/);
  });

  it('a block of the previous chunk towering over this chunk', () => {
    const errors = broken(site, (chunk, previous) => {
      clearDecor(chunk, previous);
      previous.decor.push(blockBeside(chunk, site.index, 5, 40));
    });
    expect(errors).toMatch(/decor\[0\] of chunk \d+ is 40 m tall/);
  });

  it('a block of this chunk towering over the previous chunk', () => {
    const errors = broken(site, (chunk, previous) => {
      clearDecor(chunk, previous);
      const block = blockBeside(previous, 20, 5, 40);
      chunk.decor.push(block);
      widenBounds(chunk, block.x, block.z, 10);
    });
    expect(errors).toMatch(/decor too tall or too close to the road/);
  });
});

describe('validateChunkSequence', () => {
  it('names the chunk a failure belongs to', () => {
    const chunks = structuredClone(harsh.slice(0, 8));
    chunks[5].path[10].halfWidth = 5;
    const result = validateChunkSequence(chunks);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /^chunk 5: road too narrow/.test(error))).toBe(true);
  });

  it('catches a chunk that does not follow the one before it', () => {
    const result = validateChunkSequence([harsh[3], harsh[5]]);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/chunk 5: chunks out of order/);
    expect(result.errors.join('\n')).toMatch(/chunk 5: join broken/);
  });

  it('catches a road that runs into a chunk further back than its neighbour', () => {
    // Chunk 9 is replaced by chunk 6 laid down again: it joins nothing and lands on road three chunks back.
    const chunks = structuredClone(harsh.slice(4, 10));
    const again = structuredClone(harsh[6]);
    const shift = chunks[4].endDist - again.startDist;
    for (const p of again.path) p.dist += shift;
    again.startDist += shift;
    again.endDist += shift;
    again.index = 9;
    chunks[5] = again;
    const result = validateChunkSequence(chunks);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/run: road runs into itself/);
    expect(result.errors.join('\n')).toMatch(/run: road edges intersect/);
  });

  it('catches scenery that crowds a road two chunks away, which no pair of neighbours would notice', () => {
    const chunks = harsh.slice(4, 10).map(bare);
    const site = findSite(chunks.slice(2), false);
    const target = chunks.find((chunk) => chunk.index === site.chunk.index)!;
    const owner = chunks.find((chunk) => chunk.index === site.chunk.index - 2)!;
    for (const chunk of chunks) chunk.decor.length = 0;
    const block = blockBeside(target, site.index, 5, 40);
    owner.decor.push(block);
    widenBounds(owner, block.x, block.z, 10);
    for (let n = 1; n < chunks.length; n++) expect(validateChunk(chunks[n], chunks[n - 1]).ok).toBe(true);
    const result = validateChunkSequence(chunks);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/run: decor too tall or too close to the road/);
  });

  it('catches bumps and pillars too close together across the whole run', () => {
    const chunks = harsh.slice(4, 10).map(bare);
    expect(validateChunkSequence(chunks).ok).toBe(true);
    const site = findSite(chunks, false);
    const target = chunks.find((chunk) => chunk.index === site.chunk.index)!;
    target.bumps.push(bumpAt(target, site.index - 5), bumpAt(target, site.index + 5));
    const result = validateChunkSequence(chunks);
    expect(result.errors.join('\n')).toMatch(/run: bumps too close together/);
  });
});
