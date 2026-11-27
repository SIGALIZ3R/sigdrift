import { describe, expect, it } from 'vitest';
import { hashNumbers } from '../../src/core/hash';
import { ENDLESS_CHUNK_CELLS, createEndlessGenerator, intensityAt } from '../../src/gen/endless';
import { CELL } from '../../src/gen/trackGen';
import { RULES } from '../../src/gen/validate';
import { CHUNK_RULES, minBumpBeforeBend, minBumpToBend, validateChunkSequence } from '../../src/gen/validateChunk';
import type { Difficulty, PathPoint, TrackChunk } from '../../src/types';

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

function run(seed: string, difficulty: Difficulty, count: number): TrackChunk[] {
  const generator = createEndlessGenerator(seed, difficulty);
  const chunks: TrackChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push(generator.next());
  return chunks;
}

/** Every number of a chunk in a fixed order, for hashing. */
function numbersOf(chunk: TrackChunk): number[] {
  const out: number[] = [chunk.index, chunk.startDist, chunk.endDist, chunk.intensity];
  for (const p of chunk.path) out.push(p.x, p.z, p.halfWidth, p.dist);
  for (const p of chunk.left) out.push(p.x, p.z);
  for (const p of chunk.right) out.push(p.x, p.z);
  for (const w of chunk.walls) out.push(w.ax, w.az, w.bx, w.bz);
  for (const p of chunk.props) out.push(p.x, p.z, p.radius, p.height, p.hue);
  for (const d of chunk.decor) out.push(d.x, d.z, d.w, d.d, d.h, d.hue);
  for (const b of chunk.bumps) out.push(b.x, b.z, b.dirX, b.dirZ, b.halfLength, b.halfWidth, b.height);
  out.push(chunk.bounds.minX, chunk.bounds.minZ, chunk.bounds.maxX, chunk.bounds.maxZ);
  return out;
}

/** The whole run as one centreline, without the repeated point at each join. */
function wholePath(chunks: readonly TrackChunk[]): PathPoint[] {
  const path: PathPoint[] = [];
  chunks.forEach((chunk, n) => path.push(...(n === 0 ? chunk.path : chunk.path.slice(1))));
  return path;
}

/** Signed turn at every interior vertex of a path, rad, positive to the right. */
function turns(path: readonly PathPoint[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i + 1 < path.length; i++) {
    const ax = path[i].x - path[i - 1].x;
    const az = path[i].z - path[i - 1].z;
    const bx = path[i + 1].x - path[i].x;
    const bz = path[i + 1].z - path[i].z;
    out.push(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
  }
  out.push(0);
  return out;
}

interface BendRun {
  /** Total heading change, rad: about PI/2 for one bend, PI for a hairpin. */
  turn: number;
  /** Straight vertices between the previous run and this one. */
  gap: number;
  /** `dist` where the run starts and ends. */
  from: number;
  to: number;
}

/** Splits a road into unbroken runs of bends that turn the same way. */
function bendRuns(path: readonly PathPoint[]): BendRun[] {
  const runs: BendRun[] = [];
  const turn = turns(path);
  let current: BendRun | null = null;
  let gap = 0;
  for (let i = 1; i + 1 < path.length; i++) {
    const step = turn[i];
    const bent = Math.abs(step) >= 1e-3;
    if (current && (!bent || Math.sign(step) !== Math.sign(current.turn))) {
      runs.push(current);
      current = null;
      gap = 0;
    }
    if (!bent) {
      gap++;
      continue;
    }
    if (!current) current = { turn: 0, gap, from: path[i].dist, to: path[i].dist };
    current.turn += step;
    current.to = path[i].dist;
  }
  if (current) runs.push(current);
  return runs;
}

/** Number of quarter-circle bends in a path. */
function bendCount(path: readonly PathPoint[]): number {
  let total = 0;
  for (const run of bendRuns(path)) total += Math.abs(run.turn);
  return Math.round(total / (Math.PI / 2));
}

function cellOf(x: number, z: number): string {
  return `${Math.floor((x + CELL / 2) / CELL)},${Math.floor((z + CELL / 2) / CELL)}`;
}

/** The grid cells a path passes through, in order. Segment midpoints are used: sample points sit on cell borders. */
function cellsOf(path: readonly PathPoint[]): string[] {
  const cells: string[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const cell = cellOf((path[i].x + path[i + 1].x) / 2, (path[i].z + path[i + 1].z) / 2);
    if (cells[cells.length - 1] !== cell) cells.push(cell);
  }
  return cells;
}

function columnOf(cell: string): number {
  return Number(cell.split(',')[0]);
}

/** Position of a bump's crest along the road: the crest sits on the centreline of a straight. */
function crestDist(chunk: TrackChunk, bump: TrackChunk['bumps'][number]): number {
  let best = Infinity;
  let dist = 0;
  for (let i = 0; i + 1 < chunk.path.length; i++) {
    const a = chunk.path[i];
    const b = chunk.path[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const dot = (bump.x - a.x) * (b.x - a.x) + (bump.z - a.z) * (b.z - a.z);
    const t = Math.min(1, Math.max(0, dot / (length * length)));
    const off = Math.hypot(bump.x - a.x - (b.x - a.x) * t, bump.z - a.z - (b.z - a.z) * t);
    if (off < best) {
      best = off;
      dist = a.dist + (b.dist - a.dist) * t;
    }
  }
  expect(best).toBeLessThan(0.01);
  return dist;
}

function onLattice(v: number): boolean {
  return Number.isInteger(v * 1024);
}

describe('intensityAt', () => {
  it('starts where each difficulty says', () => {
    expect(intensityAt('easy', 0)).toBeCloseTo(0.1, 12);
    expect(intensityAt('medium', 0)).toBeCloseTo(0.35, 12);
    expect(intensityAt('hard', 0)).toBeCloseTo(0.6, 12);
  });

  it('rises by about 0.1 per kilometre and stops at 1', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(intensityAt(difficulty, 1000) - intensityAt(difficulty, 0)).toBeCloseTo(0.1, 6);
      let previous = intensityAt(difficulty, 0);
      for (let dist = 50; dist <= 20_000; dist += 50) {
        const now = intensityAt(difficulty, dist);
        expect(now).toBeGreaterThanOrEqual(previous);
        // Smooth: no jumps.
        expect(now - previous).toBeLessThan(0.01);
        expect(now).toBeLessThanOrEqual(1);
        previous = now;
      }
      expect(intensityAt(difficulty, 20_000)).toBe(1);
      expect(intensityAt(difficulty, 1e9)).toBe(1);
    }
  });

  it('keeps the difficulties in order until they all top out', () => {
    for (let dist = 0; dist <= 3900; dist += 100) {
      expect(intensityAt('easy', dist)).toBeLessThan(intensityAt('medium', dist));
      expect(intensityAt('medium', dist)).toBeLessThan(intensityAt('hard', dist));
    }
    expect(intensityAt('easy', -50)).toBe(intensityAt('easy', 0));
  });
});

describe('createEndlessGenerator', () => {
  it('is deterministic', () => {
    const a = run('same-road', 'medium', 40);
    const b = run('same-road', 'medium', 40);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('matches the pinned first five chunks', () => {
    // If this changes on purpose after a release, bump PHYSICS_VERSION or the endless record's version with it:
    // distances driven on the old road are not comparable with the new one.
    const numbers = run('endless-golden', 'medium', 5).flatMap(numbersOf);
    expect(hashNumbers(numbers)).toBe('a9c06a70045adfd9');
  });

  it('gives a different road for another seed or another difficulty', () => {
    const key = (chunks: TrackChunk[]): string =>
      wholePath(chunks)
        .map((p) => `${p.x},${p.z},${p.halfWidth}`)
        .join(' ');
    const base = key(run('seed-a', 'medium', 6));
    expect(key(run('seed-b', 'medium', 6))).not.toBe(base);
    expect(key(run('seed-a', 'easy', 6))).not.toBe(base);
    expect(key(run('seed-a', 'hard', 6))).not.toBe(base);
  });

  it('reports its seed, difficulty and a start pose with clear straight road ahead', () => {
    for (const difficulty of DIFFICULTIES) {
      const generator = createEndlessGenerator('start-check', difficulty);
      expect(generator.seed).toBe('start-check');
      expect(generator.difficulty).toBe(difficulty);
      const first = generator.next();
      const { start } = generator;
      expect(start).toEqual({ x: first.path[0].x, z: first.path[0].z, heading: 0 });
      // At least 60 m dead straight along the heading, at full width, with nothing standing on it.
      const ahead = first.path.filter((p) => p.dist <= 60);
      expect(ahead[ahead.length - 1].dist).toBeGreaterThanOrEqual(57);
      for (const p of ahead) {
        expect(p.z).toBe(start.z);
        expect(p.x).toBeCloseTo(start.x + p.dist, 9);
        expect(p.halfWidth).toBeGreaterThanOrEqual(7.5);
      }
      expect(first.path.find((p) => p.dist > 60)!.z).toBe(start.z);
    }
  });

  it('closes the road about 14 m behind the start and nowhere else', () => {
    const [first, second] = run('cap-check', 'medium', 2);
    const edgeWalls = 2 * (first.path.length - 1);
    expect(first.walls.length).toBe(edgeWalls + 3);
    const cap = first.walls.slice(edgeWalls);
    const backX = Math.min(...cap.map((w) => Math.min(w.ax, w.bx)));
    expect(first.path[0].x - backX).toBeCloseTo(14, 6);
    expect(second.walls.length).toBe(2 * (second.path.length - 1));
    // The far end is open: no wall joins the two edges there.
    const last = first.path.length - 1;
    const l = first.left[last];
    const r = first.right[last];
    const crossesEnd = first.walls.some(
      (w) =>
        (w.ax === l.x && w.az === l.z && w.bx === r.x && w.bz === r.z) ||
        (w.ax === r.x && w.az === r.z && w.bx === l.x && w.bz === l.z),
    );
    expect(crossesEnd).toBe(false);
  });

  it('leaves the first chunk free of bumps and pillars', () => {
    for (const difficulty of DIFFICULTIES) {
      for (let s = 0; s < 30; s++) {
        const first = createEndlessGenerator(`warm-up-${s}`, difficulty).next();
        expect(first.index).toBe(0);
        expect(first.startDist).toBe(0);
        expect(first.bumps).toEqual([]);
        expect(first.props).toEqual([]);
      }
    }
  });

  it('numbers chunks, continues dist and joins them exactly', () => {
    const chunks = run('joins', 'hard', 30);
    chunks.forEach((chunk, n) => {
      const last = chunk.path.length - 1;
      expect(chunk.index).toBe(n);
      expect(chunk.left.length).toBe(chunk.path.length);
      expect(chunk.right.length).toBe(chunk.path.length);
      expect(chunk.startDist).toBe(chunk.path[0].dist);
      expect(chunk.endDist).toBe(chunk.path[last].dist);
      expect(chunk.intensity).toBe(intensityAt('hard', chunk.startDist));
      if (n === 0) return;
      const before = chunks[n - 1];
      const end = before.path.length - 1;
      expect(chunk.path[0]).toEqual(before.path[end]);
      expect(chunk.left[0]).toEqual(before.left[end]);
      expect(chunk.right[0]).toEqual(before.right[end]);
      expect(chunk.startDist).toBe(before.endDist);
      // Joined, never shared: editing one chunk must not edit its neighbour.
      expect(chunk.path[0]).not.toBe(before.path[end]);
    });
  });

  it('snaps every coordinate to 1/1024 m and never emits -0', () => {
    for (const chunk of run('lattice', 'hard', 12)) {
      // Intensity is a plain ratio, not a coordinate.
      const values = numbersOf(chunk).filter((_, i) => i !== 3);
      expect(values.every(onLattice)).toBe(true);
      expect(values.some((v) => Object.is(v, -0))).toBe(false);
    }
  });

  it('samples the centreline about every 3 m', () => {
    for (const chunk of run('spacing', 'medium', 20)) {
      for (let i = 1; i < chunk.path.length; i++) {
        const step = Math.hypot(chunk.path[i].x - chunk.path[i - 1].x, chunk.path[i].z - chunk.path[i - 1].z);
        expect(step).toBeGreaterThan(2.5);
        expect(step).toBeLessThan(3.5);
      }
    }
  });

  it('builds unit bump directions that follow the road exactly', () => {
    let seen = 0;
    for (const chunk of run('bump-dir', 'hard', 40)) {
      for (const bump of chunk.bumps) {
        seen++;
        expect(bump.dirX * bump.dirX + bump.dirZ * bump.dirZ).toBe(1);
        expect(Math.abs(bump.dirX) + Math.abs(bump.dirZ)).toBe(1);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('typically builds a chunk in well under 5 ms', () => {
    const generator = createEndlessGenerator('speed', 'hard');
    for (let i = 0; i < 20; i++) generator.next();
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const began = performance.now();
      generator.next();
      times.push(performance.now() - began);
    }
    times.sort((a, b) => a - b);
    console.info(`endless next(): median ${times[100].toFixed(2)} ms, p90 ${times[180].toFixed(2)} ms`);
    expect(times[100]).toBeLessThan(5);
  });
});

describe('the endless road never meets itself', () => {
  const CHUNKS = 300;

  for (const difficulty of DIFFICULTIES) {
    it(`uses every grid cell once and keeps the road apart over ${CHUNKS} chunks (${difficulty})`, () => {
      const chunks = run(`forever-${difficulty}`, difficulty, CHUNKS);
      const visited = new Set<string>();
      let furthest = -Infinity;
      chunks.forEach((chunk, n) => {
        const cells = cellsOf(chunk.path);
        expect(cells.length).toBe(ENDLESS_CHUNK_CELLS);
        const entry = columnOf(cells[0]);
        // A chunk starts east of everything before it ...
        expect(entry).toBeGreaterThan(furthest);
        let reached = entry;
        cells.forEach((cell, k) => {
          expect(visited.has(cell)).toBe(false);
          visited.add(cell);
          const column = columnOf(cell);
          // ... never goes west of where it started, nor more than two columns back from its furthest point ...
          expect(column).toBeGreaterThanOrEqual(entry);
          expect(column).toBeGreaterThanOrEqual(reached - 2);
          // ... and ends in a column nothing has reached before.
          if (k === cells.length - 1 && n > 0) expect(column).toBeGreaterThan(reached);
          reached = Math.max(reached, column);
        });
        furthest = reached;
        // It leaves heading exactly east.
        const last = chunk.path.length - 1;
        expect(chunk.path[last].z).toBe(chunk.path[last - 1].z);
        expect(chunk.path[last].x).toBeGreaterThan(chunk.path[last - 1].x);
      });
      expect(visited.size).toBe(CHUNKS * ENDLESS_CHUNK_CELLS);

      // Every pair of points more than a corner apart along the road must be apart in space too. A spatial hash
      // over the whole run finds the candidates, so chunks far apart in the sequence are compared as well.
      const path = wholePath(chunks);
      const bucket = 48;
      const hash = new Map<string, number[]>();
      path.forEach((p, i) => {
        const key = `${Math.floor(p.x / bucket)},${Math.floor(p.z / bucket)}`;
        const list = hash.get(key);
        if (list) list.push(i);
        else hash.set(key, [i]);
      });
      let compared = 0;
      let closest = Infinity;
      path.forEach((p) => {
        const bx = Math.floor(p.x / bucket);
        const bz = Math.floor(p.z / bucket);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (const j of hash.get(`${bx + dx},${bz + dz}`) ?? []) {
              const q = path[j];
              if (q.dist - p.dist <= RULES.overlapPathGap) continue;
              compared++;
              const spare = Math.hypot(q.x - p.x, q.z - p.z) - (p.halfWidth + q.halfWidth + 3);
              closest = Math.min(closest, spare);
            }
          }
        }
      });
      expect(compared).toBeGreaterThan(1000);
      expect(closest).toBeGreaterThan(0);
    });
  }
});

describe('generated chunks obey the rules', () => {
  const SEEDS = 20;
  const CHUNKS = 60;

  for (const difficulty of DIFFICULTIES) {
    it(`passes validation for ${SEEDS} seeds of ${CHUNKS} chunks (${difficulty})`, { timeout: 120_000 }, () => {
      const failures: string[] = [];
      let length = 0;
      for (let s = 0; s < SEEDS; s++) {
        const chunks = run(`rules-${s}`, difficulty, CHUNKS);
        length += chunks[CHUNKS - 1].endDist;
        const verdict = validateChunkSequence(chunks);
        for (const error of verdict.errors) failures.push(`seed ${s}: ${error}`);
      }
      expect(failures).toEqual([]);
      // About 15 km per run.
      expect(length / SEEDS).toBeGreaterThan(14_000);
      expect(length / SEEDS).toBeLessThan(17_500);
    });
  }

  it('keeps widths, plazas and decor counts inside their ranges', { timeout: 60_000 }, () => {
    for (const difficulty of DIFFICULTIES) {
      for (let s = 0; s < 6; s++) {
        for (const chunk of run(`ranges-${s}`, difficulty, 40)) {
          for (const p of chunk.path) {
            expect(p.halfWidth).toBeGreaterThanOrEqual(7.5);
            expect(p.halfWidth).toBeLessThanOrEqual(19);
          }
          expect(chunk.decor.length).toBeGreaterThanOrEqual(40);
          expect(chunk.decor.length).toBeLessThanOrEqual(90);
          expect(chunk.props.length).toBeLessThanOrEqual(2);
          expect(chunk.bumps.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('holds the agreed width for 15 m either side of every join', () => {
    const chunks = run('join-width', 'medium', 40);
    for (let n = 1; n < chunks.length; n++) {
      const width = chunks[n].path[0].halfWidth;
      for (const p of chunks[n].path) {
        if (p.dist - chunks[n].startDist <= 15) expect(p.halfWidth).toBe(width);
      }
      for (const p of chunks[n - 1].path) {
        if (chunks[n - 1].endDist - p.dist <= 15) expect(p.halfWidth).toBe(width);
      }
    }
  });

  it('narrows the plain road from about 11.5 m to about 8 m as the intensity rises', () => {
    // The agreed width at a join is the base width of the chunk before it.
    const widthAt = (difficulty: Difficulty, index: number): number => {
      let total = 0;
      for (let s = 0; s < 20; s++) total += run(`base-${s}`, difficulty, index + 2)[index + 1].path[0].halfWidth;
      return total / 20;
    };
    expect(widthAt('easy', 0)).toBeGreaterThan(10.8);
    expect(widthAt('easy', 0)).toBeLessThan(11.5);
    const late = widthAt('hard', 24);
    expect(late).toBeGreaterThan(7.7);
    expect(late).toBeLessThan(8.4);
  });

  it('never bends in two consecutive cells while the road is gentle', () => {
    let bends = 0;
    for (let s = 0; s < 40; s++) {
      const gentle = run(`gentle-${s}`, 'easy', 12).filter((chunk) => chunk.intensity < CHUNK_RULES.gentleIntensity);
      expect(gentle.length).toBeGreaterThanOrEqual(6);
      for (const run of bendRuns(wholePath(gentle))) {
        bends++;
        // One quarter turn at a time, with at least a whole straight cell (15 inner samples) before it.
        expect(Math.abs(run.turn)).toBeLessThan(2);
        if (bends > 1) expect(run.gap).toBeGreaterThanOrEqual(15);
      }
    }
    expect(bends).toBeGreaterThan(100);
  });

  it('makes S-bends and hairpins once the road is harsh', () => {
    let hairpins = 0;
    let sBends = 0;
    for (let s = 0; s < 10; s++) {
      const harsh = run(`harsh-${s}`, 'hard', 40).slice(20);
      const runs = bendRuns(wholePath(harsh));
      hairpins += runs.filter((r) => Math.abs(r.turn) > 3).length;
      sBends += runs.filter((r, i) => i > 0 && r.gap <= 1 && Math.sign(r.turn) !== Math.sign(runs[i - 1].turn)).length;
    }
    expect(hairpins).toBeGreaterThan(20);
    expect(sBends).toBeGreaterThan(100);
  });

  it('keeps bumps well clear of bends on a gentle road and lets them crowd the next bend on a harsh one', { timeout: 60_000 }, () => {
    const gapsAfter = (difficulty: Difficulty, from: number, to: number): number[] => {
      const gaps: number[] = [];
      for (let s = 0; s < 30; s++) {
        const chunks = run(`bump-gap-${s}`, difficulty, to);
        const runs = bendRuns(wholePath(chunks));
        for (const chunk of chunks.slice(from)) {
          for (const bump of chunk.bumps) {
            const at = crestDist(chunk, bump);
            // More ahead of the crest than behind it while the road is gentle: room to land before the bend.
            const needed = minBumpBeforeBend(chunk.intensity);
            expect(needed).toBeGreaterThanOrEqual(minBumpToBend(chunk.intensity));
            let after = Infinity;
            for (const r of runs) {
              // Straight road before the crest as well as after it.
              if (r.to <= at) expect(at - r.to).toBeGreaterThanOrEqual(CHUNK_RULES.bumpBendGapGentle - 0.01);
              if (r.from >= at) after = Math.min(after, r.from - at);
              expect(r.from > at || r.to < at).toBe(true);
            }
            expect(after).toBeGreaterThanOrEqual(needed - 0.01);
            expect(after).toBeGreaterThanOrEqual(bump.halfLength);
            gaps.push(after);
          }
        }
      }
      return gaps;
    };
    // The first 2 km of an easy run: a car that takes a bump at speed flies 20 to 30 m and can neither brake nor
    // steer on the way, so no crest sits within 45 m of the bend ahead. (It used to be 16 m.)
    const gentle = gapsAfter('easy', 1, 8);
    expect(gentle.length).toBeGreaterThan(20);
    expect(Math.min(...gentle)).toBeGreaterThanOrEqual(45 - 0.01);
    // The landing room fades out over the next kilometre and a half...
    const fading = gapsAfter('easy', 9, 13);
    expect(fading.length).toBeGreaterThan(20);
    expect(Math.min(...fading)).toBeLessThan(45);
    expect(Math.min(...fading)).toBeGreaterThanOrEqual(12);
    // ...and a harsh road has none.
    const harsh = gapsAfter('hard', 20, 40);
    expect(harsh.length).toBeGreaterThan(200);
    expect(Math.min(...harsh)).toBeGreaterThanOrEqual(6 - 0.01);
    // A fair share sit right in front of a bend: that is what makes them dangerous.
    expect(harsh.filter((gap) => gap < 10).length / harsh.length).toBeGreaterThan(0.15);
  });

  it('scales bump height with intensity', { timeout: 60_000 }, () => {
    const heights = (difficulty: Difficulty, from: number, to: number): number[] =>
      Array.from({ length: 30 }, (_, s) => run(`bump-height-${s}`, difficulty, to).slice(from))
        .flat()
        .flatMap((chunk) => chunk.bumps.map((bump) => bump.height));
    const low = heights('easy', 1, 6);
    expect(low.length).toBeGreaterThan(10);
    expect(Math.min(...low)).toBeGreaterThanOrEqual(0.349);
    expect(Math.max(...low)).toBeLessThanOrEqual(0.56);
    const high = heights('hard', 44, 50);
    expect(Math.min(...high)).toBeGreaterThanOrEqual(0.64);
    expect(Math.max(...high)).toBeLessThanOrEqual(0.8);
  });

  it('keeps decor out of the ground the next chunk may build on', () => {
    const chunks = run('decor-future', 'medium', 40);
    chunks.forEach((chunk) => {
      const exit = chunk.path[chunk.path.length - 1].x;
      for (const block of chunk.decor) expect(block.x + block.w / 2).toBeLessThanOrEqual(exit - 4);
    });
  });
});

describe('difficulty', () => {
  interface Stats {
    bumpsPerKm: number;
    bendsPerKm: number;
    pillarsPerKm: number;
    meanHalfWidth: number;
    meanIntensity: number;
    chunksWithBump: number;
  }

  /** The first 3 km or so of many runs: far enough to measure, short enough that the difficulties still differ. */
  function measure(difficulty: Difficulty): Stats {
    const SEEDS = 40;
    const CHUNKS = 12;
    let km = 0;
    let bumps = 0;
    let bends = 0;
    let pillars = 0;
    let width = 0;
    let points = 0;
    let intensity = 0;
    let withBump = 0;
    for (let s = 0; s < SEEDS; s++) {
      const chunks = run(`stats-${s}`, difficulty, CHUNKS);
      km += chunks[CHUNKS - 1].endDist / 1000;
      bends += bendCount(wholePath(chunks));
      for (const chunk of chunks) {
        bumps += chunk.bumps.length;
        pillars += chunk.props.length;
        intensity += chunk.intensity;
        if (chunk.bumps.length > 0) withBump++;
        for (const p of chunk.path) {
          width += p.halfWidth;
          points++;
        }
      }
    }
    return {
      bumpsPerKm: bumps / km,
      bendsPerKm: bends / km,
      pillarsPerKm: pillars / km,
      meanHalfWidth: width / points,
      meanIntensity: intensity / (SEEDS * CHUNKS),
      chunksWithBump: withBump / (SEEDS * CHUNKS),
    };
  }

  it('gets harsher from easy to medium to hard', () => {
    const easy = measure('easy');
    const medium = measure('medium');
    const hard = measure('hard');
    for (const [name, stats] of [['easy', easy], ['medium', medium], ['hard', hard]] as const) {
      console.info(
        `endless ${name}: intensity ${stats.meanIntensity.toFixed(2)}, ${stats.bendsPerKm.toFixed(1)} bends/km, ` +
          `${stats.bumpsPerKm.toFixed(2)} bumps/km (${(stats.chunksWithBump * 100).toFixed(0)}% of chunks), ` +
          `${stats.pillarsPerKm.toFixed(2)} pillars/km, mean half width ${stats.meanHalfWidth.toFixed(2)} m`,
      );
    }
    expect(easy.meanIntensity).toBeLessThan(medium.meanIntensity);
    expect(medium.meanIntensity).toBeLessThan(hard.meanIntensity);
    expect(easy.bumpsPerKm).toBeLessThan(medium.bumpsPerKm);
    expect(medium.bumpsPerKm).toBeLessThan(hard.bumpsPerKm);
    expect(easy.bendsPerKm).toBeLessThan(medium.bendsPerKm);
    expect(medium.bendsPerKm).toBeLessThan(hard.bendsPerKm);
    expect(easy.pillarsPerKm).toBeLessThan(medium.pillarsPerKm);
    expect(medium.pillarsPerKm).toBeLessThan(hard.pillarsPerKm);
    expect(easy.meanHalfWidth).toBeGreaterThan(medium.meanHalfWidth);
    expect(medium.meanHalfWidth).toBeGreaterThan(hard.meanHalfWidth);
    // "Occasional, not many": on an easy road most chunks have no bump at all, and even hard stays sparse.
    expect(easy.chunksWithBump).toBeLessThan(0.6);
    expect(easy.bumpsPerKm).toBeLessThan(2.5);
    expect(hard.bumpsPerKm).toBeLessThan(6);
    expect(hard.bumpsPerKm).toBeGreaterThan(2);
  });

  it('puts a bump in about one chunk in three as an easy run starts, and one or two per chunk flat out', () => {
    let early = 0;
    let earlyChunks = 0;
    let late = 0;
    let lateChunks = 0;
    for (let s = 0; s < 200; s++) {
      const chunks = run(`bump-rate-${s}`, 'easy', 4);
      for (const chunk of chunks.slice(1)) {
        earlyChunks++;
        if (chunk.bumps.length > 0) early++;
      }
    }
    for (let s = 0; s < 20; s++) {
      for (const chunk of run(`bump-rate-${s}`, 'hard', 50).slice(20)) {
        expect(chunk.intensity).toBe(1);
        lateChunks++;
        late += chunk.bumps.length;
      }
    }
    expect(early / earlyChunks).toBeGreaterThan(0.2);
    expect(early / earlyChunks).toBeLessThan(0.5);
    expect(late / lateChunks).toBeGreaterThan(0.9);
    expect(late / lateChunks).toBeLessThan(2);
  });

  it('gets harsher with distance within one difficulty', () => {
    const early: TrackChunk[] = [];
    const late: TrackChunk[] = [];
    for (let s = 0; s < 30; s++) {
      const chunks = run(`distance-${s}`, 'easy', 48);
      early.push(...chunks.slice(1, 9));
      late.push(...chunks.slice(40, 48));
      for (let n = 1; n < chunks.length; n++) {
        expect(chunks[n].intensity).toBeGreaterThanOrEqual(chunks[n - 1].intensity);
      }
      expect(chunks[47].intensity).toBeGreaterThan(chunks[0].intensity + 0.8);
    }
    const bumps = (chunks: TrackChunk[]): number => chunks.reduce((sum, chunk) => sum + chunk.bumps.length, 0);
    const bends = (chunks: TrackChunk[]): number => chunks.reduce((sum, chunk) => sum + bendCount(chunk.path), 0);
    const width = (chunks: TrackChunk[]): number => {
      const all = chunks.flatMap((chunk) => chunk.path);
      return all.reduce((sum, p) => sum + p.halfWidth, 0) / all.length;
    };
    expect(bumps(late)).toBeGreaterThan(bumps(early) * 1.5);
    expect(bends(late)).toBeGreaterThan(bends(early) * 1.3);
    expect(width(late)).toBeLessThan(width(early) - 1);
  });
});
