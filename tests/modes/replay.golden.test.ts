import { describe, expect, it } from 'vitest';
import { hashNumbers } from '../../src/core/hash';
import { generateLevel } from '../../src/gen/trackGen';
import { createBot } from '../../src/modes/bot';
import { createRunMode } from '../../src/modes/run';
import { decodeInput, encodeInput, quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import type { Level } from '../../src/types';
import { GEN_VERSION, PHYSICS_VERSION, SIM_HZ } from '../../src/types';

const WEEK = '2026-W48';
const TICK_LIMIT = 200 * SIM_HZ;

/**
 * The bot's run on 2026-W48, pinned.
 *
 * These two values change whenever the generator's output for that week, the car physics, the run rules or the
 * bot change. If the generator or the physics changed ON PURPOSE, bump GEN_VERSION or PHYSICS_VERSION in
 * src/types.ts (saved times and replays are only comparable within one version) and then update the pins. If only
 * the bot changed, update the pins. If nothing was meant to change, this is a determinism bug: find it.
 */
const PINNED_GEN_VERSION = 1;
const PINNED_PHYSICS_VERSION = 1;
const PINNED_FINISH_TICKS = 7146;
const PINNED_FINISH_HASH = 'c4a98890ec92152f';

interface Finish {
  ticks: number;
  hash: string;
}

/** The bot drives the level; every tick is stored as the code a replay file would hold. */
function record(level: Level): { codes: number[]; finish: Finish } {
  const world = createWorld(level);
  const run = createRunMode(world);
  const bot = createBot(level);
  const codes: number[] = [];
  while (run.state.phase !== 'finished' && codes.length < TICK_LIMIT) {
    const input = quantizeInput(bot(world, run.state));
    codes.push(encodeInput(input));
    run.step(input);
  }
  expect(run.state.phase).toBe('finished');
  return { codes, finish: { ticks: run.state.ticks, hash: hashNumbers(world.snapshot()) } };
}

/** Feeds recorded codes to a fresh world and run mode. No bot involved. */
function replay(level: Level, codes: readonly number[]): Finish {
  const world = createWorld(level);
  const run = createRunMode(world);
  for (const code of codes) run.step(decodeInput(code));
  expect(run.state.phase).toBe('finished');
  return { ticks: run.state.ticks, hash: hashNumbers(world.snapshot()) };
}

describe(`golden replay of ${WEEK}`, () => {
  const { codes, finish } = record(generateLevel(WEEK));

  it('replays to the same finishing tick and the same world state', () => {
    expect(replay(generateLevel(WEEK), codes)).toEqual(finish);
  });

  it('holds only codes that survive an encode / decode round trip', () => {
    for (const code of codes) expect(encodeInput(decodeInput(code))).toBe(code);
  });

  it('diverges when a single early input is changed', () => {
    const tampered = codes.slice();
    const at = tampered.findIndex((code) => code !== tampered[0]) + SIM_HZ;
    tampered[at] = encodeInput({ steer: 1, throttle: 1, brake: 0, handbrake: true, reset: false });
    const world = createWorld(generateLevel(WEEK));
    const run = createRunMode(world);
    for (const code of tampered) run.step(decodeInput(code));
    expect(hashNumbers(world.snapshot())).not.toBe(finish.hash);
  });

  it('matches the pinned finishing tick and state hash', () => {
    expect(GEN_VERSION).toBe(PINNED_GEN_VERSION);
    expect(PHYSICS_VERSION).toBe(PINNED_PHYSICS_VERSION);
    expect(finish).toEqual({ ticks: PINNED_FINISH_TICKS, hash: PINNED_FINISH_HASH });
  });
});
