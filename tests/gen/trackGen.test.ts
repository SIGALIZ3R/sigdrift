import { describe, expect, it } from 'vitest';
import { hashString } from '../../src/core/hash';
import { DEFAULT_STREAMS, buildLevel, generateLevel, generateLevelFromSeed } from '../../src/gen/trackGen';
import { RULES, insideWalls, validateLevel } from '../../src/gen/validate';
import { seedForWeek, shiftWeek } from '../../src/gen/weeklySeed';
import type { Level } from '../../src/types';
import { GEN_VERSION } from '../../src/types';

const FIRST_WEEK = '2026-W48';
const WEEKS = 60;
const PROPERTY_SEEDS = 400;

const weeks: Level[] = [];
for (let i = 0; i < WEEKS; i++) weeks.push(generateLevel(shiftWeek(FIRST_WEEK, i)));

interface BendRun {
  /** Total heading change in radians, positive to the right: about PI/2 for one bend, PI for a hairpin. */
  turn: number;
  /** Straight path vertices between the previous run and this one. Bends that meet head-on leave exactly one. */
  gap: number;
}

/** Splits the road into unbroken runs of bends that turn the same way. */
function bendRuns(level: Level): BendRun[] {
  const runs: BendRun[] = [];
  let turn = 0;
  let gap = 0;
  let gapBefore = 0;
  const p = level.path;
  for (let i = 1; i < p.length - 1; i++) {
    const ax = p[i].x - p[i - 1].x;
    const az = p[i].z - p[i - 1].z;
    const bx = p[i + 1].x - p[i].x;
    const bz = p[i + 1].z - p[i].z;
    const step = Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
    if (Math.abs(step) < 1e-3) {
      if (turn !== 0) runs.push({ turn, gap: gapBefore });
      turn = 0;
      gap++;
      continue;
    }
    if (turn === 0) gapBefore = gap;
    gap = 0;
    turn += step;
  }
  if (turn !== 0) runs.push({ turn, gap: gapBefore });
  return runs;
}

function hasHairpin(runs: BendRun[]): boolean {
  return runs.some((run) => Math.abs(run.turn) > 3);
}

function hasSBend(runs: BendRun[]): boolean {
  return runs.some((run, i) => i > 0 && run.gap <= 1 && Math.sign(run.turn) !== Math.sign(runs[i - 1].turn));
}

/** A single quarter turn with straight road on both sides. */
function hasLoneBend(runs: BendRun[]): boolean {
  return runs.some((run, i) => run.gap > 1 && (runs[i + 1]?.gap ?? 2) > 1 && Math.abs(run.turn) < 2);
}

function layoutKey(level: Level): string {
  return level.path.map((p) => `${p.x},${p.z}`).join(' ');
}

function onLattice(v: number): boolean {
  return Number.isInteger(v * 1024);
}

describe('generateLevel', () => {
  const level = weeks[0];

  it('is deterministic', () => {
    const again = generateLevel(FIRST_WEEK);
    expect(again).toEqual(level);
    expect(JSON.stringify(again)).toBe(JSON.stringify(level));
  });

  it('matches the pinned level for 2026-W48', () => {
    // If this changes on purpose after a release, bump GEN_VERSION in src/types.ts: weeks already played must stay
    // reproducible. (Re-pinned before the first release for the 64 m run-off beyond the goal.)
    expect(hashString(JSON.stringify(level))).toBe('517fd5ea');
  });

  it('labels the level with its week, seed and generator version', () => {
    expect(level.id).toBe(FIRST_WEEK);
    expect(level.seed.startsWith(seedForWeek(FIRST_WEEK))).toBe(true);
    expect(level.genVersion).toBe(GEN_VERSION);
    expect(generateLevelFromSeed(seedForWeek(FIRST_WEEK), FIRST_WEEK)).toEqual(level);
  });

  it('starts at the first path point facing down the road', () => {
    const { path, start } = level;
    expect(start.x).toBe(path[0].x);
    expect(start.z).toBe(path[0].z);
    const ahead = Math.atan2(path[1].z - path[0].z, path[1].x - path[0].x);
    expect(start.heading).toBeCloseTo(ahead, 12);
  });

  it('puts gates across the road with respawns on the centreline', () => {
    const last = level.path.length - 1;
    expect(level.goal.pathIndex).toBe(last);
    expect(level.checkpoints.length).toBeGreaterThanOrEqual(3);
    for (const gate of [...level.checkpoints, level.goal]) {
      const i = gate.pathIndex;
      expect({ x: gate.ax, z: gate.az }).toEqual(level.left[i]);
      expect({ x: gate.bx, z: gate.bz }).toEqual(level.right[i]);
      expect(gate.respawn.x).toBe(level.path[i].x);
      expect(gate.respawn.z).toBe(level.path[i].z);
      const along = Math.atan2(level.path[i].z - level.path[i - 1].z, level.path[i].x - level.path[i - 1].x);
      expect(Math.cos(gate.respawn.heading - along)).toBeGreaterThan(0.99);
    }
  });

  it('keeps left on the left and right on the right', () => {
    const { path, left, right } = level;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dz = path[i].z - path[i - 1].z;
      // Right of (dx, dz) is (-dz, dx).
      expect((right[i].x - path[i].x) * -dz + (right[i].z - path[i].z) * dx).toBeGreaterThan(0);
      expect((left[i].x - path[i].x) * -dz + (left[i].z - path[i].z) * dx).toBeLessThan(0);
    }
  });

  it('snaps every coordinate to 1/1024 m and never emits -0', () => {
    const values: number[] = [];
    for (const p of level.path) values.push(p.x, p.z, p.halfWidth, p.dist);
    for (const p of [...level.left, ...level.right]) values.push(p.x, p.z);
    for (const w of level.walls) values.push(w.ax, w.az, w.bx, w.bz);
    for (const p of level.props) values.push(p.x, p.z, p.radius, p.height);
    for (const d of level.decor) values.push(d.x, d.z, d.w, d.d, d.h);
    values.push(level.bounds.minX, level.bounds.minZ, level.bounds.maxX, level.bounds.maxZ, level.length);
    expect(values.every(onLattice)).toBe(true);
    expect(values.some((v) => Object.is(v, -0))).toBe(false);
  });
});

describe('generated levels obey the rules', () => {
  it(`validates ${PROPERTY_SEEDS} arbitrary seeds, rarely needing a retry`, () => {
    let retried = 0;
    const started = performance.now();
    for (let i = 0; i < PROPERTY_SEEDS; i++) {
      const seed = `prop-test-${i}`;
      const level = generateLevelFromSeed(seed, 'property');
      expect(validateLevel(level).errors, seed).toEqual([]);
      if (level.seed !== seed) retried++;
      expect(level.decor.length, seed).toBeGreaterThanOrEqual(150);
      expect(level.decor.length, seed).toBeLessThanOrEqual(320);
    }
    const perLevel = (performance.now() - started) / PROPERTY_SEEDS;
    const fraction = retried / PROPERTY_SEEDS;
    console.info(
      `trackGen: ${retried}/${PROPERTY_SEEDS} seeds needed a retry (${(fraction * 100).toFixed(1)}%), ` +
        `${perLevel.toFixed(2)} ms per level including two validations`,
    );
    expect(fraction).toBeLessThan(0.2);
    // Typically a few milliseconds. The bound is loose so a busy CI machine cannot fail it, yet a slip into
    // quadratic scans still does.
    expect(perLevel).toBeLessThan(200);
  });

  it(`validates the next ${WEEKS} weeks`, () => {
    for (const level of weeks) expect(validateLevel(level).errors, level.id).toEqual([]);
  });

  it('leaves a walled, empty run-off beyond the goal that no other road reaches', () => {
    for (const level of weeks) {
      const { goal, path, walls } = level;
      const dirX = Math.round(Math.cos(goal.respawn.heading));
      const dirZ = Math.round(Math.sin(goal.respawn.heading));
      const halfWidth = path[path.length - 1].halfWidth;
      // Probe points across the whole width of the run-off, every 2 m for the full distance.
      for (let ahead = 1; ahead <= RULES.goalRunOff; ahead += 2) {
        for (const side of [-(halfWidth - 0.5), 0, halfWidth - 0.5]) {
          const x = goal.respawn.x + dirX * ahead - dirZ * side;
          const z = goal.respawn.z + dirZ * ahead + dirX * side;
          expect(insideWalls(walls, x, z), `${level.id} ${ahead} m past the goal`).toBe(true);
          for (const p of path) {
            const clear = Math.hypot(p.x - x, p.z - z) > p.halfWidth || p.dist > level.length - 30;
            if (!clear) expect.fail(`${level.id}: road at dist ${p.dist} reaches the run-off`);
          }
          for (const prop of level.props) expect(Math.hypot(prop.x - x, prop.z - z)).toBeGreaterThan(prop.radius);
          for (const d of level.decor) {
            const onBlock = Math.abs(d.x - x) <= d.w / 2 && Math.abs(d.z - z) <= d.d / 2;
            if (onBlock) expect.fail(`${level.id}: decor stands in the run-off`);
          }
        }
      }
    }
  });

  it('keeps every half width inside 7.5..20 m and bends at 12.5 m or less', () => {
    for (const level of weeks) {
      const { path } = level;
      for (let i = 1; i < path.length - 1; i++) {
        expect(path[i].halfWidth).toBeGreaterThanOrEqual(7.5);
        expect(path[i].halfWidth).toBeLessThanOrEqual(20);
        const bent =
          Math.abs(
            (path[i].x - path[i - 1].x) * (path[i + 1].z - path[i].z) -
              (path[i].z - path[i - 1].z) * (path[i + 1].x - path[i].x),
          ) > 1e-3;
        if (bent) expect(path[i].halfWidth).toBeLessThanOrEqual(12.5);
      }
    }
  });

  it('changes width gradually', () => {
    for (const level of weeks) {
      const { path } = level;
      for (let i = 1; i < path.length; i++) {
        const slope = Math.abs(path[i].halfWidth - path[i - 1].halfWidth) / (path[i].dist - path[i - 1].dist);
        // The steepest blend is 9 -> 20 m over 20 m, and a smoothstep peaks at 1.5 times its mean slope.
        expect(slope).toBeLessThan(0.85);
      }
    }
  });
});

describe('variety across weeks', () => {
  it('includes hairpins, S-bends and lone bends', () => {
    const runs = weeks.map(bendRuns);
    const hairpins = runs.filter(hasHairpin).length;
    const sBends = runs.filter(hasSBend).length;
    const loneBends = runs.filter(hasLoneBend).length;
    const rights = runs.filter((r) => r.some((run) => run.turn > 0)).length;
    const lefts = runs.filter((r) => r.some((run) => run.turn < 0)).length;
    console.info(
      `trackGen: of ${WEEKS} weeks, ${hairpins} have a hairpin, ${sBends} an S-bend, ${loneBends} a lone bend`,
    );
    expect(loneBends).toBeGreaterThanOrEqual(WEEKS / 3);
    expect(hairpins).toBeGreaterThanOrEqual(WEEKS / 3);
    expect(hairpins).toBeLessThan(WEEKS);
    expect(sBends).toBeGreaterThanOrEqual(WEEKS / 3);
    expect(rights).toBeGreaterThan(WEEKS / 2);
    expect(lefts).toBeGreaterThan(WEEKS / 2);
  });

  it('includes plazas, narrows and props, but not in every level', () => {
    const plazas = weeks.filter((level) => level.path.some((p) => p.halfWidth >= 15)).length;
    const narrows = weeks.filter((level) => level.path.some((p) => p.halfWidth < 8.9)).length;
    const centrePillars = weeks.filter((level) =>
      level.props.some((prop) => level.path.some((p) => Math.hypot(p.x - prop.x, p.z - prop.z) < 1.6)),
    ).length;
    const withProps = weeks.filter((level) => level.props.length > 0).length;
    expect(plazas).toBeGreaterThanOrEqual(WEEKS / 2);
    expect(narrows).toBeGreaterThanOrEqual(WEEKS / 4);
    expect(narrows).toBeLessThan(WEEKS);
    expect(centrePillars).toBeGreaterThanOrEqual(WEEKS / 6);
    expect(withProps).toBeGreaterThanOrEqual(WEEKS / 2);
  });

  it('varies in length and never repeats a layout', () => {
    const lengths = weeks.map((level) => level.length);
    expect(new Set(lengths.map((length) => Math.round(length))).size).toBeGreaterThanOrEqual(15);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeGreaterThan(200);
    expect(new Set(weeks.map(layoutKey)).size).toBe(WEEKS);
  });

  it('starts in every compass direction', () => {
    const headings = new Set(weeks.map((level) => Math.round(level.start.heading * 100)));
    expect(headings.size).toBe(4);
  });
});

describe('random streams are independent', () => {
  const seed = seedForWeek(FIRST_WEEK);
  const reference = buildLevel(seed, FIRST_WEEK);

  it('builds the same level as generateLevel when nothing is relabelled', () => {
    expect(reference).toEqual(weeks[0]);
  });

  it('changes only the decor when the decor stream changes', () => {
    const other = buildLevel(seed, FIRST_WEEK, { ...DEFAULT_STREAMS, decor: 'decor-b' });
    expect(other.decor).not.toEqual(reference.decor);
    expect({ ...other, decor: [], bounds: null }).toEqual({ ...reference, decor: [], bounds: null });
  });

  it('changes only the props when the props stream changes', () => {
    // One level may by chance get the same props (or none) from both streams, so look at several.
    let differing = 0;
    for (let i = 0; i < 10; i++) {
      const a = buildLevel(`stream-test-${i}`, 'x');
      const b = buildLevel(`stream-test-${i}`, 'x', { ...DEFAULT_STREAMS, props: 'props-b' });
      expect({ ...b, props: [] }).toEqual({ ...a, props: [] });
      if (JSON.stringify(a.props) !== JSON.stringify(b.props)) differing++;
    }
    expect(differing).toBeGreaterThanOrEqual(5);
  });

  it('keeps the centreline when the width stream changes', () => {
    const other = buildLevel(seed, FIRST_WEEK, { ...DEFAULT_STREAMS, width: 'width-b' });
    expect(layoutKey(other)).toBe(layoutKey(reference));
    expect(other.path.map((p) => p.halfWidth)).not.toEqual(reference.path.map((p) => p.halfWidth));
  });

  it('moves the road when the layout stream changes', () => {
    const other = buildLevel(seed, FIRST_WEEK, { ...DEFAULT_STREAMS, layout: 'layout-b' });
    expect(layoutKey(other)).not.toBe(layoutKey(reference));
  });
});
