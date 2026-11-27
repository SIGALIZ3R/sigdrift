import { describe, expect, it } from 'vitest';
import { hashNumbers } from '../../src/core/hash';
import { ENDLESS_CHUNK_CELLS, createEndlessGenerator, endlessLayoutStats, intensityAt } from '../../src/gen/endless';
import { CELL } from '../../src/gen/trackGen';
import { RULES } from '../../src/gen/validate';
import { CHUNK_RULES, validateChunkSequence } from '../../src/gen/validateChunk';
import type { Difficulty, PathPoint, TrackChunk } from '../../src/types';
import { CROSSING_CLEARANCE, MAX_GRADE, TERRAIN_Y } from '../../src/types';

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
  for (const p of chunk.path) out.push(p.x, p.z, p.y, p.halfWidth, p.dist);
  for (const p of chunk.left) out.push(p.x, p.z);
  for (const p of chunk.right) out.push(p.x, p.z);
  chunk.leftOpen.forEach((open, i) => out.push(open ? 1 : 0, chunk.rightOpen[i] ? 1 : 0));
  for (const w of chunk.walls) out.push(w.ax, w.az, w.bx, w.bz, w.ya, w.yb);
  for (const p of chunk.props) out.push(p.x, p.z, p.y, p.radius, p.height, p.hue);
  for (const d of chunk.decor) out.push(d.x, d.z, d.w, d.d, d.h, d.hue);
  for (const b of chunk.bumps) out.push(b.x, b.z, b.y, b.dirX, b.dirZ, b.halfLength, b.halfWidth, b.height);
  for (const s of chunk.supports) out.push(s.x, s.z, s.top, s.radius);
  const b = chunk.bounds;
  out.push(b.minX, b.minZ, b.maxX, b.maxZ, b.minY, b.maxY);
  return out;
}

function onLattice(v: number): boolean {
  return Number.isInteger(v * 1024);
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

/** Path points of a chunk, tagged with its index. */
interface Tagged {
  p: PathPoint;
  chunk: number;
}

/**
 * Independent check of the 2.5D rule: any two path points of chunks at most `window` apart (and more than 40 m
 * apart along the road) that are close enough in plan for their roads to touch must be CROSSING_CLEARANCE apart
 * in height. Returns the offending pairs and the crossings found (points passing over or under each other).
 */
function layerCheck(chunks: readonly TrackChunk[], window: number): { clashes: string[]; crossingPoints: number } {
  const bucket = 48;
  const grid = new Map<string, Tagged[]>();
  const clashes: string[] = [];
  let crossingPoints = 0;
  const key = (x: number, z: number): string => `${Math.floor(x / bucket)},${Math.floor(z / bucket)}`;
  for (const chunk of chunks) {
    for (const p of chunk.path) {
      const bx = Math.floor(p.x / bucket);
      const bz = Math.floor(p.z / bucket);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of grid.get(`${bx + dx},${bz + dz}`) ?? []) {
            if (chunk.index - other.chunk > window) continue;
            const q = other.p;
            if (Math.abs(q.dist - p.dist) <= RULES.overlapPathGap) continue;
            const apart = Math.hypot(p.x - q.x, p.z - q.z);
            if (apart > p.halfWidth + q.halfWidth + RULES.overlapMargin) continue;
            if (Math.abs(p.y - q.y) < CROSSING_CLEARANCE - 1e-6) {
              clashes.push(`chunk ${chunk.index} at ${p.dist.toFixed(1)} m vs chunk ${other.chunk} at ${q.dist.toFixed(1)} m`);
            } else if (apart < Math.max(p.halfWidth, q.halfWidth)) crossingPoints++;
          }
        }
      }
    }
    for (const p of chunk.path) {
      const k = key(p.x, p.z);
      const list = grid.get(k);
      if (list) list.push({ p, chunk: chunk.index });
      else grid.set(k, [{ p, chunk: chunk.index }]);
    }
  }
  return { clashes, crossingPoints };
}

interface RoadStats {
  km: number;
  meanHeight: number;
  maxHeight: number;
  /** Share of raised (>= 3 m) edge length, both sides, that is open. */
  openShare: number;
  bumpsPerKm: number;
  pillarsPerKm: number;
  meanHalfWidth: number;
}

function statsOf(chunks: readonly TrackChunk[]): RoadStats {
  let length = 0;
  let heightSum = 0;
  let maxHeight = 0;
  let raised = 0;
  let open = 0;
  let width = 0;
  let bumps = 0;
  let pillars = 0;
  for (const c of chunks) {
    bumps += c.bumps.length;
    pillars += c.props.length;
    for (let i = 0; i + 1 < c.path.length; i++) {
      const p = c.path[i];
      const q = c.path[i + 1];
      const run = q.dist - p.dist;
      length += run;
      heightSum += ((p.y + q.y) / 2) * run;
      width += p.halfWidth * run;
      maxHeight = Math.max(maxHeight, p.y);
      if (p.y >= 3 && q.y >= 3) {
        raised += 2 * run;
        open += ((c.leftOpen[i] ? 1 : 0) + (c.rightOpen[i] ? 1 : 0)) * run;
      }
    }
  }
  const km = length / 1000;
  return {
    km,
    meanHeight: heightSum / length,
    maxHeight,
    openShare: raised > 0 ? open / raised : 0,
    bumpsPerKm: bumps / km,
    pillarsPerKm: pillars / km,
    meanHalfWidth: width / length,
  };
}

describe('intensityAt', () => {
  it('starts where each difficulty says', () => {
    expect(intensityAt('easy', 0)).toBeCloseTo(0.1, 12);
    expect(intensityAt('medium', 0)).toBeCloseTo(0.35, 12);
    expect(intensityAt('hard', 0)).toBeCloseTo(0.6, 12);
  });

  it('rises by 0.1 per kilometre and tops out at 1', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(intensityAt(difficulty, 1000) - intensityAt(difficulty, 0)).toBeCloseTo(0.1, 6);
      let previous = intensityAt(difficulty, 0);
      for (let dist = 100; dist <= 12_000; dist += 100) {
        const now = intensityAt(difficulty, dist);
        expect(now).toBeGreaterThanOrEqual(previous);
        previous = now;
      }
      expect(intensityAt(difficulty, 20_000)).toBe(1);
      expect(intensityAt(difficulty, 1e9)).toBe(1);
    }
    expect(intensityAt('easy', -50)).toBe(intensityAt('easy', 0));
  });
});

describe('createEndlessGenerator', () => {
  it('is deterministic', () => {
    const a = run('same-road', 'medium', 30);
    const b = run('same-road', 'medium', 30);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('matches the pinned first five chunks', () => {
    // If this changes on purpose, bump GEN_VERSION (and the endless records' version) with it: distances driven on
    // the old road are not comparable with the new one.
    const numbers = run('endless-golden', 'medium', 5).flatMap(numbersOf);
    expect(hashNumbers(numbers)).toBe('5637d2dfdfec5ca3');
  });

  it('gives a different road for another seed or another difficulty', () => {
    const key = (chunks: TrackChunk[]): string => chunks.flatMap((c) => c.path.map((p) => `${p.x},${p.z},${p.y}`)).join(' ');
    const base = key(run('seed-a', 'medium', 6));
    expect(key(run('seed-b', 'medium', 6))).not.toBe(base);
    expect(key(run('seed-a', 'easy', 6))).not.toBe(base);
    expect(key(run('seed-a', 'hard', 6))).not.toBe(base);
  });

  it('starts level and straight, closed behind, with nothing on the first chunk', () => {
    for (const difficulty of DIFFICULTIES) {
      for (let s = 0; s < 20; s++) {
        const generator = createEndlessGenerator(`warm-up-${s}`, difficulty);
        const first = generator.next();
        expect(generator.start).toEqual({ x: first.path[0].x, z: first.path[0].z, heading: 0, y: first.path[0].y });
        expect(first.index).toBe(0);
        expect(first.startDist).toBe(0);
        expect(first.bumps).toEqual([]);
        expect(first.props).toEqual([]);
        expect(first.leftOpen.some(Boolean) || first.rightOpen.some(Boolean)).toBe(false);
        // 60 m dead straight and level along the heading, at full width.
        const ahead = first.path.filter((p) => p.dist <= 60);
        for (const p of ahead) {
          expect(p.z).toBe(first.path[0].z);
          expect(p.x).toBeCloseTo(first.path[0].x + p.dist, 9);
          expect(p.y).toBe(first.path[0].y);
          expect(p.halfWidth).toBeGreaterThanOrEqual(7.5);
        }
        // Closed behind the start (three cap walls at the start's height), open at the far end.
        const edgeWalls = 2 * (first.path.length - 1);
        expect(first.walls.length).toBe(edgeWalls + 3);
        for (const w of first.walls.slice(0, 3)) {
          expect(w.ya).toBe(first.path[0].y);
          expect(Math.min(w.ax, w.bx)).toBeGreaterThanOrEqual(first.path[0].x - 14 - 1e-9);
        }
      }
    }
  });

  it('numbers chunks, continues dist and joins them exactly, height and grade included', () => {
    for (const difficulty of DIFFICULTIES) {
      const chunks = run(`joins-${difficulty}`, difficulty, 40);
      chunks.forEach((chunk, n) => {
        const last = chunk.path.length - 1;
        expect(chunk.index).toBe(n);
        expect(chunk.left.length).toBe(chunk.path.length);
        expect(chunk.leftOpen.length).toBe(chunk.path.length);
        expect(chunk.startDist).toBe(chunk.path[0].dist);
        expect(chunk.endDist).toBe(chunk.path[last].dist);
        expect(chunk.intensity).toBe(intensityAt(difficulty, chunk.startDist));
        if (n === 0) return;
        const before = chunks[n - 1];
        const end = before.path.length - 1;
        expect(chunk.path[0]).toEqual(before.path[end]);
        expect(chunk.left[0]).toEqual(before.left[end]);
        expect(chunk.right[0]).toEqual(before.right[end]);
        expect(chunk.startDist).toBe(before.endDist);
        expect(chunk.path[0]).not.toBe(before.path[end]);
        // Every chunk ends level, so the grade is continuous across the join.
        const gradeIn = (before.path[end].y - before.path[end - 1].y) / (before.path[end].dist - before.path[end - 1].dist);
        const gradeOut = (chunk.path[1].y - chunk.path[0].y) / (chunk.path[1].dist - chunk.path[0].dist);
        expect(Math.abs(gradeOut - gradeIn)).toBeLessThan(0.04);
      });
    }
  });

  it('snaps every coordinate to 1/1024 m and never emits -0', () => {
    for (const chunk of run('lattice', 'hard', 12)) {
      // Intensity is a plain ratio, not a coordinate.
      const values = numbersOf(chunk).filter((_, i) => i !== 3);
      expect(values.every(onLattice)).toBe(true);
      expect(values.some((v) => Object.is(v, -0))).toBe(false);
    }
  });

  it('keeps every road above the city floor and every support and building on it', () => {
    for (const chunk of run('floors', 'hard', 40)) {
      for (const p of chunk.path) {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(CHUNK_RULES.maxHeight);
      }
      for (const s of chunk.supports) expect(s.top).toBeGreaterThan(TERRAIN_Y + 0.5);
      if (chunk.decor.length + chunk.supports.length > 0) expect(chunk.bounds.minY).toBe(TERRAIN_Y);
    }
  });

  it('typically builds a chunk in well under 5 ms, also after 2000 chunks', () => {
    const generator = createEndlessGenerator('speed', 'hard');
    for (let i = 0; i < 2000; i++) generator.next();
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const began = performance.now();
      generator.next();
      times.push(performance.now() - began);
    }
    times.sort((a, b) => a - b);
    console.info(`endless next() after 2000 chunks: median ${times[100].toFixed(2)} ms, p90 ${times[180].toFixed(2)} ms`);
    expect(times[100]).toBeLessThan(5);
  }, 30_000);
});

describe('the endless road is valid', () => {
  for (const difficulty of DIFFICULTIES) {
    it(`passes validateChunkSequence for 20 seeds x 80 chunks (${difficulty})`, () => {
      for (let s = 0; s < 20; s++) {
        const chunks = run(`sweep-${difficulty}-${s}`, difficulty, 80);
        const verdict = validateChunkSequence(chunks);
        expect(verdict.errors.slice(0, 5)).toEqual([]);
      }
    }, 60_000);
  }

  it('stays valid when every chunk has to follow the escape route (the never-trapped fallback)', () => {
    for (const difficulty of DIFFICULTIES) {
      const generator = createEndlessGenerator(`escape-${difficulty}`, difficulty, { searchBudget: 0 });
      const chunks: TrackChunk[] = [];
      for (let i = 0; i < 100; i++) chunks.push(generator.next());
      expect(validateChunkSequence(chunks).errors.slice(0, 5)).toEqual([]);
      expect(endlessLayoutStats(generator)?.escaped).toBe(100);
    }
  }, 60_000);
});

describe('the endless road is 2.5D and really random', () => {
  const LONG = 600;
  const longRuns = DIFFICULTIES.map((difficulty) => ({ difficulty, chunks: run(`long-${difficulty}`, difficulty, LONG) }));

  it(`never meets itself at the same level within any ${CHUNK_RULES.memory}-chunk window over ${LONG} chunks`, () => {
    for (const { chunks } of longRuns) {
      const { clashes } = layerCheck(chunks, CHUNK_RULES.memory);
      expect(clashes.slice(0, 5)).toEqual([]);
    }
  });

  it('keeps every chunk in its own six grid cells, apart from crossings', () => {
    for (const { chunks } of longRuns) {
      for (const chunk of chunks.slice(0, 120)) expect(cellsOf(chunk.path).length).toBe(ENDLESS_CHUNK_CELLS);
    }
  });

  it('passes over and under itself, and the rate is reported', () => {
    const rates: string[] = [];
    for (const { difficulty, chunks } of longRuns) {
      const generator = createEndlessGenerator(`long-${difficulty}`, difficulty);
      for (let i = 0; i < LONG; i++) generator.next();
      const stats = endlessLayoutStats(generator)!;
      const km = chunks[chunks.length - 1].endDist / 1000;
      const { crossingPoints } = layerCheck(chunks, CHUNK_RULES.memory);
      rates.push(`${difficulty} ${(stats.crossings / km).toFixed(2)}/km (${stats.crossings} in ${km.toFixed(0)} km)`);
      expect(stats.crossings).toBeGreaterThan(10);
      expect(crossingPoints).toBeGreaterThan(0);
      // Nearly every chunk is found by the first search: getting boxed in is rare.
      expect(stats.escaped).toBeLessThan(LONG * 0.05);
    }
    console.info(`endless crossings: ${rates.join(', ')}`);
  });

  it('heads in all four directions over a long run and climbs, drops and reuses old ground', () => {
    for (const { chunks } of longRuns) {
      const travel = [0, 0, 0, 0];
      let total = 0;
      for (const chunk of chunks) {
        for (let i = 0; i + 1 < chunk.path.length; i++) {
          const dx = chunk.path[i + 1].x - chunk.path[i].x;
          const dz = chunk.path[i + 1].z - chunk.path[i].z;
          const step = Math.hypot(dx, dz);
          total += step;
          if (Math.abs(dx) > Math.abs(dz)) travel[dx > 0 ? 0 : 2] += step;
          else travel[dz > 0 ? 1 : 3] += step;
        }
      }
      for (const t of travel) expect(t / total).toBeGreaterThan(0.12);
      let climbs = 0;
      let drops = 0;
      for (const chunk of chunks) {
        for (let i = 1; i < chunk.path.length; i++) {
          const grade = (chunk.path[i].y - chunk.path[i - 1].y) / (chunk.path[i].dist - chunk.path[i - 1].dist);
          expect(Math.abs(grade)).toBeLessThanOrEqual(MAX_GRADE + 0.002);
          if (grade > 0.05) climbs++;
          if (grade < -0.05) drops++;
        }
      }
      expect(climbs).toBeGreaterThan(1000);
      expect(drops).toBeGreaterThan(1000);
      // Ground more than ten chunks old is built over again: the road wanders back.
      const firstUse = new Map<string, number>();
      let reused = 0;
      for (const chunk of chunks) {
        for (const cell of cellsOf(chunk.path)) {
          const before = firstUse.get(cell);
          if (before !== undefined && chunk.index - before > CHUNK_RULES.memory) reused++;
          firstUse.set(cell, chunk.index);
        }
      }
      expect(reused).toBeGreaterThan(50);
    }
  });

  it('gets harsher with intensity and with difficulty', () => {
    const early: Record<Difficulty, RoadStats> = {} as Record<Difficulty, RoadStats>;
    const gentle: TrackChunk[] = [];
    const harsh: TrackChunk[] = [];
    for (const difficulty of DIFFICULTIES) {
      const first: TrackChunk[] = [];
      for (let s = 0; s < 8; s++) {
        const chunks = run(`harsher-${difficulty}-${s}`, difficulty, 40);
        first.push(...chunks.slice(1, 9));
        for (const chunk of chunks) {
          if (chunk.index === 0) continue;
          if (chunk.intensity < 0.35) gentle.push(chunk);
          if (chunk.intensity >= 0.9) harsh.push(chunk);
        }
      }
      early[difficulty] = statsOf(first);
    }
    const low = statsOf(gentle);
    const high = statsOf(harsh);
    const fmt = (s: RoadStats): string =>
      `height ${s.meanHeight.toFixed(1)}/${s.maxHeight.toFixed(1)} m, open ${(s.openShare * 100).toFixed(0)}%, ` +
      `bumps ${s.bumpsPerKm.toFixed(1)}/km, pillars ${s.pillarsPerKm.toFixed(1)}/km, half width ${s.meanHalfWidth.toFixed(1)} m`;
    console.info(`endless intensity < 0.35: ${fmt(low)}`);
    console.info(`endless intensity >= 0.9: ${fmt(high)}`);
    for (const difficulty of DIFFICULTIES) console.info(`endless first 2 km, ${difficulty}: ${fmt(early[difficulty])}`);
    expect(high.meanHeight).toBeGreaterThan(low.meanHeight * 1.5);
    expect(high.maxHeight).toBeGreaterThan(low.maxHeight);
    expect(high.openShare).toBeGreaterThan(low.openShare * 1.5);
    expect(high.bumpsPerKm).toBeGreaterThan(low.bumpsPerKm);
    expect(high.meanHalfWidth).toBeLessThan(low.meanHalfWidth - 1);
    expect(early.easy.meanHeight).toBeLessThan(early.hard.meanHeight);
    expect(early.easy.openShare).toBeLessThan(early.hard.openShare);
    expect(early.easy.bumpsPerKm).toBeLessThan(early.hard.bumpsPerKm);
  }, 60_000);
});
