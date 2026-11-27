import { describe, expect, it } from 'vitest';
import { hashNumbers } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';
import { generateLevel } from '../../src/gen/trackGen';
import { getLevelDef, generateLevelFor } from '../../src/gen/levels';
import { createBot } from '../../src/modes/bot';
import { createRunMode } from '../../src/modes/run';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { decodeInput, encodeInput, quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import type { InputState, Level, RunMode, World } from '../../src/types';
import { GEN_VERSION, PHYSICS_VERSION, SIM_HZ } from '../../src/types';

const WEEK = '2026-W48';
/** The rough runs need pillars, which 2026-W48 no longer has at GEN_VERSION 2. */
const ROUGH_WEEK = '2027-W05';
/** The fall run needs raised road with open edges taken at full throttle: Vertigo Ramps has both. */
const FALL_LEVEL = 'L3';
const TICK_LIMIT = 200 * SIM_HZ;

/**
 * Recordings, pinned. Between them they are the guard that says "the simulation changed".
 *
 * WHAT EACH ONE COVERS
 * - The clean run on 2026-W48: the bot drives to the finish. It grips, so it exercises the generator's output for
 *   the week (hills, crests, an overpass, open edges), the engine, brakes, drag, steering, slope gravity, the
 *   pre-peak part of the tyre curve, gates and the clock. It touches no wall and never leaves the ground.
 * - The roll-out: the same run carried on past the line while the car brakes itself to a stop in the run-off.
 * - The rough runs on 2027-W05: a scripted hooligan (see `roughDriver`) for a fixed 75 s, once with the steering
 *   assist as the game ships it and once with it off. These cover what the clean run cannot: wall and pillar
 *   collisions, tyres past their peak, the handbrake, the steering assist, brake-to-reverse, respawns, drift
 *   scoring with the proximity bonus and lost multipliers. The test asserts that each of those really happened, so
 *   the pin cannot quietly lose its coverage, and it hashes the run state (score, splits, resets) along with the
 *   world, once a second.
 * - The fall run on L3: full throttle and on/off steering along the bot's line for 90 s. It flies off crests and
 *   off open edges onto the city floor, and is put back at its checkpoint after each fall.
 *
 * WHEN A PIN MOVES
 * If the generator or the physics changed ON PURPOSE in a released game, bump GEN_VERSION or PHYSICS_VERSION in
 * src/types.ts (saved times and replays are only comparable within one version) and then update the pins. If only
 * the bot or the rough driver changed, update the pins. If nothing was meant to change, this is a determinism
 * bug: find it.
 *
 * HISTORY
 * - The handling retune that came with endless mode (punchier launch, less drag, less oversteer) moved every pin:
 *   the clean run went from 7146 ticks (59.55 s) to 6919 (57.66 s). The bot did not change.
 * - Still before release, braking stopped moving weight forward beyond BRAKE_TRANSFER_LIMIT (the brake pedal
 *   with a steering key held threw the tail out). Every hash moved; the clean run still takes 6919 ticks.
 * - PHYSICS_VERSION 3 / GEN_VERSION 2 (2.5D roads, the drift retune, ScoreState scoring, falls, the bot's care
 *   on hills and crests) moved every pin. The rough runs moved to 2027-W05 (W48 has no pillar left) with seed
 *   golden-rough-3, and the fall run was added.
 * - Open edges keep their whole landing zone clear of other road (not just 16 m), pillars stay off the outside of a
 *   bend's exit, and the score locks out while a wreck slides after a crash: the rough and fall pins moved (the
 *   generator's output for the weekly options changed, GEN_VERSION stays 2 before release). The clean run is
 *   unchanged.
 */
const PINNED_GEN_VERSION = 2;
const PINNED_PHYSICS_VERSION = 3;
const PINNED_FINISH_TICKS = 6846;
const PINNED_FINISH_HASH = 'df1b3dd29b743c1f';
const PINNED_ROLL_OUT_HASH = '5d66b21d43398cb1';
const PINNED_ROUGH_ASSISTED_HASH = '8032ac6d2a19b047';
const PINNED_ROUGH_UNASSISTED_HASH = '21abae8bce4195ea';
const PINNED_FALL_HASH = '952fcb22876474f3';

const ROLL_OUT_TICKS = 4 * SIM_HZ;
const ROUGH_TICKS = 75 * SIM_HZ;
const ROUGH_SAMPLE_EVERY = SIM_HZ;
/** Chosen because this script finds walls, a pillar, spins and three checkpoints. Changing it moves the pins. */
const ROUGH_SEED = 'golden-rough-3';
const FALL_TICKS = 90 * SIM_HZ;
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
    s.falls,
    s.lastFallTick,
    s.respawnInTicks,
    s.score.points,
    s.score.multiplier,
    s.score.peakMultiplier,
    s.score.drifting ? 1 : 0,
    s.score.proximity,
    s.score.combo,
    s.score.lastMultiplierLossTick,
    s.score.lastCloseTick,
    s.lastCheckpointTick,
    s.respawn.x,
    s.respawn.z,
    s.respawn.heading,
    s.respawn.y ?? 0,
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
  multiplierLosses: number;
  closeCalls: number;
  resets: number;
  checkpoints: number;
  points: number;
}

function roughRun(steerAssist: number): RoughRun {
  const level = generateLevel(ROUGH_WEEK);
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
    multiplierLosses: 0,
    closeCalls: 0,
    resets: 0,
    checkpoints: 0,
    points: 0,
  };
  let lastLoss = -1;
  let lastClose = -1;
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
      const score = run.state.score;
      if (score.drifting) seen.driftingTicks++;
      if (score.lastMultiplierLossTick !== lastLoss) {
        lastLoss = score.lastMultiplierLossTick;
        seen.multiplierLosses++;
      }
      if (score.lastCloseTick !== lastClose) {
        lastClose = score.lastCloseTick;
        seen.closeCalls++;
      }
    }
    if ((tick + 1) % ROUGH_SAMPLE_EVERY === 0) samples.push(...fullState(run));
  }
  // Not finishing is part of the design: the run is a fixed length, so the pin never depends on reaching the goal.
  seen.resets = run.state.resets;
  seen.checkpoints = run.state.nextCheckpoint;
  seen.points = run.state.score.points;
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
    // Pillars are circles and take their own path through the collision code.
    expect(seen.pillarHits).toBeGreaterThan(0);
    expect(seen.slidingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.pastPeakTicks).toBeGreaterThan(0);
    expect(seen.handbrakeTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.reversingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.driftingTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.multiplierLosses).toBeGreaterThan(1);
    expect(seen.closeCalls).toBeGreaterThan(1);
    expect(seen.points).toBeGreaterThan(0);
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

describe(`golden fall run on ${FALL_LEVEL}`, () => {
  function fallRun(): { hash: string; falls: number; waitTicks: number; airTicks: number; floorTicks: number; checkpoints: number } {
    const def = getLevelDef(FALL_LEVEL);
    if (def === null) throw new Error(FALL_LEVEL);
    const level = generateLevelFor(def);
    const world = createWorld(level);
    const run = createRunMode(world);
    const bot = createBot(level);
    const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
    const samples: number[] = [];
    let waitTicks = 0;
    let airTicks = 0;
    let floorTicks = 0;
    for (let tick = 0; tick < FALL_TICKS; tick++) {
      const wanted = bot(world, run.state);
      input.steer = Math.abs(wanted.steer) > 0.2 ? Math.sign(wanted.steer) : 0;
      input.throttle = run.state.phase === 'running' ? 1 : 0;
      input.reset = wanted.reset;
      run.step(quantizeInput(input));
      if (run.state.respawnInTicks > 0) waitTicks++;
      if (world.car.airborne) airTicks++;
      if (world.offTrack) floorTicks++;
      if ((tick + 1) % ROUGH_SAMPLE_EVERY === 0) samples.push(...fullState(run));
    }
    return {
      hash: hashNumbers(samples),
      falls: run.state.falls,
      waitTicks,
      airTicks,
      floorTicks,
      checkpoints: run.state.nextCheckpoint,
    };
  }

  it('falls off, waits on the floor and is put back, and matches its pin', () => {
    const seen = fallRun();
    expect(seen.falls).toBeGreaterThanOrEqual(2);
    expect(seen.waitTicks).toBeGreaterThan(seen.falls * (SIM_HZ / 2));
    expect(seen.floorTicks).toBeGreaterThan(0);
    expect(seen.airTicks).toBeGreaterThan(SIM_HZ);
    expect(seen.checkpoints).toBeGreaterThanOrEqual(1);
    expect(seen.hash).toBe(PINNED_FALL_HASH);
  });

  it('is the same run twice over', () => {
    expect(fallRun()).toEqual(fallRun());
  });
});
