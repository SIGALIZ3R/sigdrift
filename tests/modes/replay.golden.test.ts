import { describe, expect, it } from 'vitest';
import { hashNumbers } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';
import { generateLevel } from '../../src/gen/trackGen';
import { createBot } from '../../src/modes/bot';
import { createRunMode } from '../../src/modes/run';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { decodeInput, encodeInput, quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import type { InputState, Level, RunMode, World } from '../../src/types';
import { GEN_VERSION, PHYSICS_VERSION, SIM_HZ } from '../../src/types';

const WEEK = '2026-W48';
const TICK_LIMIT = 200 * SIM_HZ;

/**
 * Three recordings on 2026-W48, pinned. Between them they are the guard that says "the simulation changed".
 *
 * WHAT EACH ONE COVERS
 * - The clean run: the bot drives to the finish. It grips, so it exercises the generator's output for the week,
 *   the engine, brakes, drag, steering, the pre-peak part of the tyre curve, gates and the clock. It touches no
 *   wall, never slides, never uses the handbrake and never scores a drift.
 * - The roll-out: the same run carried on past the line while the car brakes itself to a stop in the run-off.
 * - The rough runs: a scripted hooligan (see `roughDriver`) for a fixed 75 s, once with the steering assist as the
 *   game ships it and once with it off. These cover what the clean run cannot: wall and pillar collisions,
 *   tyres past their peak, the handbrake, the steering assist, brake-to-reverse, respawns and drift scoring. The
 *   test asserts that each of those really happened, so the pin cannot quietly lose its coverage, and it hashes
 *   the run state (score, chain, splits, resets) along with the world, once a second.
 *
 * WHEN A PIN MOVES
 * If the generator or the physics changed ON PURPOSE in a released game, bump GEN_VERSION or PHYSICS_VERSION in
 * src/types.ts (saved times and replays are only comparable within one version) and then update the pins. If only
 * the bot or the rough driver changed, update the pins. If nothing was meant to change, this is a determinism
 * bug: find it.
 */
const PINNED_GEN_VERSION = 1;
const PINNED_PHYSICS_VERSION = 1;
const PINNED_FINISH_TICKS = 7146;
const PINNED_FINISH_HASH = '94e2d46922156c3e';
const PINNED_ROLL_OUT_HASH = 'd1385782c2d8ec46';
const PINNED_ROUGH_ASSISTED_HASH = 'd9ed9f890d095905';
const PINNED_ROUGH_UNASSISTED_HASH = 'cd55ebc5ff9d66b0';

const ROLL_OUT_TICKS = 4 * SIM_HZ;
const ROUGH_TICKS = 75 * SIM_HZ;
const ROUGH_SAMPLE_EVERY = SIM_HZ;
/** Chosen because this script finds walls, a pillar, spins and three checkpoints. Changing it moves the pins. */
const ROUGH_SEED = 'golden-rough-6';
/** Share of the half-second slots in which the rough driver simply follows the road. */
const ROUGH_FOLLOW = 0.6;

interface Finish {
  ticks: number;
  hash: string;
}

/** The bot drives the level; every tick is stored as the code a replay file would hold. */
function record(level: Level): { codes: number[]; finish: Finish; run: RunMode } {
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
  return { codes, finish: { ticks: run.state.ticks, hash: hashNumbers(world.snapshot()) }, run };
}

/** Feeds recorded codes to a fresh world and run mode. No bot involved. */
function replay(level: Level, codes: readonly number[]): Finish {
  const world = createWorld(level);
  const run = createRunMode(world);
  for (const code of codes) run.step(decodeInput(code));
  expect(run.state.phase).toBe('finished');
  return { ticks: run.state.ticks, hash: hashNumbers(world.snapshot()) };
}

/** Everything a tick can change: the world's dynamic state and the rules' state. */
function fullState(run: RunMode): number[] {
  const s = run.state;
  return [
    ...run.world.snapshot(),
    s.ticks,
    s.countdownTicks,
    s.nextCheckpoint,
    s.resets,
    s.driftScore,
    s.chainScore,
    s.multiplier,
    s.drifting ? 1 : 0,
    s.lastCheckpointTick,
    s.lastChainBreakTick,
    s.respawn.x,
    s.respawn.z,
    s.respawn.heading,
    ...s.splits,
  ];
}

type RoughMove = 'follow' | 'floor' | 'flick' | 'handbrake' | 'brake';

/**
 * A driver who mostly follows the road like the bot, but every half second may do something daft instead: floor
 * it, yank the wheel under power, pull the handbrake on full lock, or stamp on the brake. Twice it stops and
 * backs up, and three times it presses reset. Everything is drawn from one seeded stream, so the run is the same
 * everywhere.
 */
function roughDriver(level: Level, seed: string): (world: World, run: RunMode, tick: number) => InputState {
  const bot = createBot(level);
  const rng = new Rng(seed);
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  let move: RoughMove = 'follow';
  let flick = 0;
  const reverseFrom = [20 * SIM_HZ, 50 * SIM_HZ];
  const reverseTicks = 4 * SIM_HZ;
  const resetAt = [12 * SIM_HZ, 34 * SIM_HZ, 61 * SIM_HZ];
  return (world, run, tick) => {
    const follow = bot(world, run.state);
    if (tick % (SIM_HZ / 2) === 0) {
      const roll = rng.next();
      move = roll < ROUGH_FOLLOW ? 'follow' : roll < 0.8 ? 'floor' : roll < 0.9 ? 'flick' : roll < 0.97 ? 'handbrake' : 'brake';
      flick = rng.chance(0.5) ? 1 : -1;
    }
    input.steer = move === 'flick' || move === 'handbrake' ? flick : follow.steer;
    input.throttle = move === 'follow' ? follow.throttle : move === 'brake' ? 0 : 1;
    input.brake = move === 'follow' ? follow.brake : move === 'brake' ? 1 : 0;
    input.handbrake = move === 'handbrake';
    input.reset = follow.reset || resetAt.includes(tick);
    if (reverseFrom.some((from) => tick >= from && tick < from + reverseTicks)) {
      input.steer = 0.3;
      input.throttle = 0;
      input.brake = 1;
      input.handbrake = false;
    }
    return input;
  };
}

interface RoughRun {
  hash: string;
  collisionTicks: number;
  hardHits: number;
  pillarHits: number;
  slidingTicks: number;
  pastPeakTicks: number;
  handbrakeTicks: number;
  reversingTicks: number;
  driftingTicks: number;
  chainBreaks: number;
  resets: number;
  checkpoints: number;
  driftScore: number;
}

function roughRun(steerAssist: number): RoughRun {
  const level = generateLevel(WEEK);
  const params = cloneParams(DEFAULT_CAR_PARAMS);
  params.steerAssist = steerAssist;
  const world = createWorld(level, params);
  const run = createRunMode(world);
  const driver = roughDriver(level, ROUGH_SEED);
  const samples: number[] = [];
  const seen: RoughRun = {
    hash: '',
    collisionTicks: 0,
    hardHits: 0,
    pillarHits: 0,
    slidingTicks: 0,
    pastPeakTicks: 0,
    handbrakeTicks: 0,
    reversingTicks: 0,
    driftingTicks: 0,
    chainBreaks: 0,
    resets: 0,
    checkpoints: 0,
    driftScore: 0,
  };
  let lastBreak = -1;
  for (let tick = 0; tick < ROUGH_TICKS; tick++) {
    run.step(quantizeInput(driver(world, run, tick)));
    const car = world.car;
    const hit = world.lastCollision;
    if (run.state.phase === 'running') {
      if (hit !== null) {
        seen.collisionTicks++;
        if (hit.impact > 5) seen.hardHits++;
        if (level.props.some((p) => Math.hypot(p.x - hit.x, p.z - hit.z) < p.radius + 0.01)) seen.pillarHits++;
      }
      if (car.rearSlide > 0.5) seen.slidingTicks++;
      if (car.rearSlide === 1 && car.frontSlide > 0) seen.pastPeakTicks++;
      if (car.handbrake) seen.handbrakeTicks++;
      if (car.reversing && car.forwardSpeed < -1) seen.reversingTicks++;
      if (run.state.drifting) seen.driftingTicks++;
      if (run.state.lastChainBreakTick !== lastBreak) {
        lastBreak = run.state.lastChainBreakTick;
        seen.chainBreaks++;
      }
    }
    if ((tick + 1) % ROUGH_SAMPLE_EVERY === 0) samples.push(...fullState(run));
  }
  // Not finishing is part of the design: the run is a fixed length, so the pin never depends on reaching the goal.
  seen.resets = run.state.resets;
  seen.checkpoints = run.state.nextCheckpoint;
  seen.driftScore = run.state.driftScore;
  seen.hash = hashNumbers(samples);
  return seen;
}

describe(`golden replay of ${WEEK}`, () => {
  const { codes, finish, run } = record(generateLevel(WEEK));

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
    const tamperedRun = createRunMode(world);
    for (const code of tampered) tamperedRun.step(decodeInput(code));
    expect(hashNumbers(world.snapshot())).not.toBe(finish.hash);
  });

  it('matches the pinned finishing tick and state hash', () => {
    expect(GEN_VERSION).toBe(PINNED_GEN_VERSION);
    expect(PHYSICS_VERSION).toBe(PINNED_PHYSICS_VERSION);
    expect(finish).toEqual({ ticks: PINNED_FINISH_TICKS, hash: PINNED_FINISH_HASH });
  });

  it('matches the pinned roll-out: the car brakes itself to rest in the run-off, touching nothing', () => {
    // Runs last in this block: it carries the recorded run on past the finish.
    const idle: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
    const samples: number[] = [];
    let contacts = 0;
    let braked = 0;
    let handbraked = 0;
    for (let i = 0; i < ROLL_OUT_TICKS; i++) {
      run.step(idle);
      if (run.world.lastCollision !== null) contacts++;
      if (run.world.car.brake > 0) braked++;
      if (run.world.car.handbrake) handbraked++;
      if ((i + 1) % (SIM_HZ / 4) === 0) samples.push(...fullState(run));
    }
    expect(contacts).toBe(0);
    // Both halves of the roll-out ran: the brake down to walking pace, then the handbrake.
    expect(braked).toBeGreaterThan(SIM_HZ);
    expect(handbraked).toBeGreaterThan(0);
    expect(run.world.car.speed).toBe(0);
    expect(run.state.ticks).toBe(PINNED_FINISH_TICKS);
    expect(hashNumbers(samples)).toBe(PINNED_ROLL_OUT_HASH);
  });
});

describe(`rough golden runs on ${WEEK}`, () => {
  it.each([
    ['with the steering assist the game ships', ASSIST_STRENGTH, PINNED_ROUGH_ASSISTED_HASH] as const,
    ['with the steering assist off', 0, PINNED_ROUGH_UNASSISTED_HASH] as const,
  ])('%s: covers the rough half of the simulation and matches its pin', (_name, steerAssist, pinned) => {
    const seen = roughRun(steerAssist);
    // Coverage first. If one of these fails, the driver no longer reaches that part of the simulation and the
    // script needs changing: the pin below would otherwise stop guarding it.
    expect(seen.collisionTicks).toBeGreaterThan(20);
    expect(seen.hardHits).toBeGreaterThan(1);
    // Pillars are circles and take their own path through the collision code; the assisted run clips one.
    if (steerAssist > 0) expect(seen.pillarHits).toBeGreaterThan(0);
    expect(seen.slidingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.pastPeakTicks).toBeGreaterThan(0);
    expect(seen.handbrakeTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.reversingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.driftingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.chainBreaks).toBeGreaterThan(0);
    expect(seen.driftScore).toBeGreaterThan(0);
    expect(seen.resets).toBeGreaterThanOrEqual(3);
    expect(seen.checkpoints).toBeGreaterThanOrEqual(1);
    expect(seen.hash).toBe(pinned);
  });

  it('is the same run twice over', () => {
    expect(roughRun(ASSIST_STRENGTH)).toEqual(roughRun(ASSIST_STRENGTH));
  });

  it('is a different run with the assist off', () => {
    expect(roughRun(0).hash).not.toBe(roughRun(ASSIST_STRENGTH).hash);
  });
});
