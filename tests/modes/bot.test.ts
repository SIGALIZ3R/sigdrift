import { describe, expect, it } from 'vitest';
import type { InputState, Level, RunMode, World } from '../../src/types';
import { DT, SIM_HZ } from '../../src/types';
import { cos, sin } from '../../src/core/fixedMath';
import { createBot } from '../../src/modes/bot';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { generateLevel } from '../../src/gen/trackGen';
import { shiftWeek } from '../../src/gen/weeklySeed';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import { makeStraightLevel } from '../helpers/handLevel';

const FIRST_WEEK = '2026-W48';
const WEEKS = Array.from({ length: 12 }, (_, i) => shiftWeek(FIRST_WEEK, i));
const TIME_LIMIT_S = 150;
const MAX_RESETS = 3;
const STUCK_TICKS = 4 * SIM_HZ;
const ROLL_OUT_TICKS = 8 * SIM_HZ;
/** A little more than the car's top speed, so the run-off is tested with a margin. */
const FLAT_OUT = 43;
const NEUTRAL: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

/** Steps a finished run while the car brakes itself, and counts the ticks on which it touched anything. */
function rollOutContacts(run: RunMode): number {
  let contacts = 0;
  for (let i = 0; i < ROLL_OUT_TICKS; i++) {
    run.step(NEUTRAL);
    if (run.world.lastCollision !== null) contacts++;
  }
  return contacts;
}

/** Metres the car has travelled beyond the goal line. */
function pastGoal(run: RunMode): number {
  const { respawn } = run.world.level.goal;
  const car = run.world.car;
  return (car.x - respawn.x) * cos(respawn.heading) + (car.z - respawn.z) * sin(respawn.heading);
}

interface Drive {
  world: World;
  run: RunMode;
  /** Ticks on which the car touched anything while the run was on. */
  contacts: number;
  resetPresses: number[];
}

/** Lets the bot drive, through the same input quantisation the game uses, until it finishes or time runs out. */
function botDrive(level: Level, seconds: number): Drive {
  const world = createWorld(level);
  const run = createRunMode(world);
  const bot = createBot(level);
  const drive: Drive = { world, run, contacts: 0, resetPresses: [] };
  const limit = COUNTDOWN_TICKS + seconds * SIM_HZ;
  for (let i = 0; i < limit && run.state.phase !== 'finished'; i++) {
    const input = quantizeInput(bot(world, run.state));
    if (input.reset) drive.resetPresses.push(run.state.ticks);
    run.step(input);
    if (run.state.phase === 'running' && world.lastCollision !== null) drive.contacts++;
  }
  return drive;
}

function withPillar(level: Level, x: number, z: number, radius: number): Level {
  level.props.push({ kind: 'pillar', x, z, radius, height: 4, hue: 0 });
  return level;
}

describe('bot', () => {
  it('keeps its hands off the controls during the countdown and after the finish', () => {
    const level = makeStraightLevel(120, 9);
    const world = createWorld(level);
    const run = createRunMode(world);
    const bot = createBot(level);
    const neutral: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
    expect(bot(world, run.state)).toEqual(neutral);
    while (run.state.phase !== 'finished') {
      if (run.state.phase === 'countdown') expect(bot(world, run.state)).toEqual(neutral);
      run.step(bot(world, run.state));
      expect(run.state.ticks).toBeLessThan(60 * SIM_HZ);
    }
    expect(bot(world, run.state)).toEqual(neutral);
  });

  it('hands back the same input object every tick, so driving allocates nothing', () => {
    const level = makeStraightLevel(120, 9);
    const world = createWorld(level);
    const run = createRunMode(world);
    const bot = createBot(level);
    const first = bot(world, run.state);
    for (let i = 0; i < COUNTDOWN_TICKS + 50; i++) run.step(bot(world, run.state));
    expect(bot(world, run.state)).toBe(first);
    expect(first.throttle).toBeGreaterThan(0);
  });

  it('drives a straight road down the middle without touching anything', () => {
    const { world, run, contacts } = botDrive(makeStraightLevel(300, 8), 60);
    expect(run.state.phase).toBe('finished');
    expect(run.state.resets).toBe(0);
    expect(contacts).toBe(0);
    expect(Math.abs(world.car.z)).toBeLessThan(0.01);
  });

  it('gets back to the middle of the road when it starts off line and askew', () => {
    const level = makeStraightLevel(300, 10);
    level.start = { x: 0, z: 5, heading: 0.5 };
    const { world, run, contacts } = botDrive(level, 60);
    expect(run.state.phase).toBe('finished');
    expect(contacts).toBe(0);
    expect(Math.abs(world.car.z)).toBeLessThan(0.3);
  });

  it.each([
    ['in the middle of the road', 0, 2],
    ['left of centre', -3, 1.5],
    ['right of centre', 3, 1.5],
    ['against the left wall', -8, 1.6],
    ['against the right wall', 8, 1.6],
  ])('passes a pillar %s on its open side', (_where, z, radius) => {
    const level = withPillar(makeStraightLevel(300, 10), 150, z, radius);
    const { run, contacts } = botDrive(level, 60);
    expect(run.state.phase).toBe('finished');
    expect(run.state.resets).toBe(0);
    expect(contacts).toBe(0);
  });

  it('slows down for a narrow road', () => {
    const topSpeed = (halfWidth: number): number => {
      const level = makeStraightLevel(400, halfWidth);
      const world = createWorld(level);
      const run = createRunMode(world);
      const bot = createBot(level);
      let top = 0;
      while (run.state.phase !== 'finished') {
        run.step(bot(world, run.state));
        top = Math.max(top, world.car.speed);
      }
      return top;
    };
    expect(topSpeed(7.5)).toBeLessThan(topSpeed(11) - 3);
  });

  it('presses reset for one tick after 4 s without progress, and again every 4 s', () => {
    const level = makeStraightLevel(200, 8);
    // A wall right across the road: there is no way through.
    level.walls.push({ ax: 30, az: -8, bx: 30, bz: 8 });
    const { run, resetPresses } = botDrive(level, 30);
    expect(run.state.phase).toBe('running');
    expect(resetPresses.length).toBeGreaterThanOrEqual(3);
    expect(run.state.resets).toBe(resetPresses.length);
    for (let i = 1; i < resetPresses.length; i++) {
      // Each respawn restarts the wait, and the drive back to the wall comes on top of it.
      expect(resetPresses[i] - resetPresses[i - 1]).toBeGreaterThanOrEqual(STUCK_TICKS);
    }
  });

  it('does not press reset while it is getting somewhere', () => {
    const { resetPresses } = botDrive(makeStraightLevel(1000, 8), 120);
    expect(resetPresses).toEqual([]);
  });

  it('is deterministic: two bots on the same level drive identical runs', () => {
    const level = generateLevel(FIRST_WEEK);
    const a = botDrive(level, TIME_LIMIT_S);
    const b = botDrive(generateLevel(FIRST_WEEK), TIME_LIMIT_S);
    expect(a.run.state).toEqual(b.run.state);
    expect(a.world.snapshot()).toEqual(b.world.snapshot());
  });

  it('copes with a restart in the middle of a run', () => {
    const level = generateLevel(FIRST_WEEK);
    const world = createWorld(level);
    const run = createRunMode(world);
    const bot = createBot(level);
    const finish = (): number => {
      for (let i = 0; i < (TIME_LIMIT_S + 3) * SIM_HZ && run.state.phase !== 'finished'; i++) {
        run.step(quantizeInput(bot(world, run.state)));
      }
      expect(run.state.phase).toBe('finished');
      return run.state.ticks;
    };
    for (let i = 0; i < 20 * SIM_HZ; i++) run.step(quantizeInput(bot(world, run.state)));
    run.restart();
    const afterRestart = finish();
    expect(run.state.resets).toBe(0);
    expect(afterRestart).toBe(botDrive(level, TIME_LIMIT_S).run.state.ticks);
  });
});

/**
 * The driveability gate: a level the bot cannot finish cleanly is a level a player should not be given. A failure
 * here means the bot, the physics or the generator changed; the week id in the test name says where to look.
 */
describe('driveability of the weekly levels', () => {
  it.each(WEEKS)('%s: the bot finishes in under 150 s with at most 3 resets', (id) => {
    const { run } = botDrive(generateLevel(id), TIME_LIMIT_S);
    expect(run.state.phase).toBe('finished');
    expect(run.state.ticks * DT).toBeLessThan(TIME_LIMIT_S);
    expect(run.state.resets).toBeLessThanOrEqual(MAX_RESETS);
    expect(run.state.nextCheckpoint).toBe(run.state.checkpointCount);
    expect(run.state.splits).toHaveLength(run.state.checkpointCount);
    // The run does not end at the line: the car then brakes itself, and must have the room to do it.
    expect(rollOutContacts(run)).toBe(0);
    expect(run.world.car.speed).toBe(0);
  });

  it.each(WEEKS)('%s: a car crossing the line flat out stops in the run-off without touching anything', (id) => {
    const level = generateLevel(id);
    const world = createWorld(level);
    const run = createRunMode(world);
    for (let i = 0; i < COUNTDOWN_TICKS; i++) run.step(NEUTRAL);
    // Straight to the last few metres, with only the goal left to cross.
    run.state.nextCheckpoint = run.state.checkpointCount;
    const { x, z, heading } = level.goal.respawn;
    world.placeCar({ x: x - 6 * cos(heading), z: z - 6 * sin(heading), heading });
    world.car.vx = FLAT_OUT * cos(heading);
    world.car.vz = FLAT_OUT * sin(heading);
    for (let i = 0; i < SIM_HZ && run.state.phase !== 'finished'; i++) run.step({ ...NEUTRAL, throttle: 1 });
    expect(run.state.phase).toBe('finished');
    expect(world.car.speed).toBeGreaterThan(40);
    expect(rollOutContacts(run)).toBe(0);
    expect(world.car.speed).toBe(0);
    expect(pastGoal(run)).toBeGreaterThan(40);
  });
});

/**
 * The bot steers and feathers the pedals like a gamepad. A keyboard cannot: every key is fully on or off, and a
 * human presses it late. `keys` describes one such pair of hands.
 */
interface KeyboardStyle {
  /** Stick deflection beyond which the steering key goes down. */
  steerDeadzone: number;
  /** Pedal travel beyond which the pedal key goes down (fully). */
  pedalThreshold: number;
  /** Reaction time, in ticks, between the bot wanting something and the keys doing it. */
  lagTicks: number;
}

const STEADY_HANDS: KeyboardStyle = { steerDeadzone: 0.3, pedalThreshold: 0.15, lagTicks: Math.round(0.15 * SIM_HZ) };
/** Steers late and hard, and treats the throttle as a switch. */
const TWITCHY_HANDS: KeyboardStyle = { steerDeadzone: 0.5, pedalThreshold: 0.01, lagTicks: Math.round(0.15 * SIM_HZ) };

interface KeyboardDrive {
  finished: boolean;
  seconds: number;
  resets: number;
  /** Times the car went past 1.6 rad of drift at speed: a spin. */
  spins: number;
}

function keyboardDrive(level: Level, steerAssist: number, keys: KeyboardStyle): KeyboardDrive {
  const params = cloneParams(DEFAULT_CAR_PARAMS);
  params.steerAssist = steerAssist;
  const world = createWorld(level, params);
  const run = createRunMode(world);
  const bot = createBot(level);
  const pending: InputState[] = [];
  let spins = 0;
  let spinning = false;
  const limit = COUNTDOWN_TICKS + TIME_LIMIT_S * SIM_HZ;
  for (let i = 0; i < limit && run.state.phase !== 'finished'; i++) {
    const wanted = bot(world, run.state);
    pending.push({
      steer: Math.abs(wanted.steer) > keys.steerDeadzone ? Math.sign(wanted.steer) : 0,
      throttle: wanted.throttle > keys.pedalThreshold ? 1 : 0,
      brake: wanted.brake > keys.pedalThreshold ? 1 : 0,
      handbrake: false,
      reset: wanted.reset,
    });
    run.step(pending.length > keys.lagTicks ? (pending.shift() as InputState) : NEUTRAL);
    const spun = Math.abs(world.car.driftAngle) > 1.6 && world.car.speed > 5;
    if (spun && !spinning) spins++;
    spinning = spun;
  }
  return {
    finished: run.state.phase === 'finished',
    seconds: run.state.ticks * DT,
    resets: run.state.resets,
    spins,
  };
}

/**
 * The keyboard gate. The game ships with the steering assist on and most players use keys, so the weekly levels
 * must be finishable that way: digital steering and pedals, 150 ms late, at the assist strength the game applies.
 */
describe('driveability of the weekly levels on a keyboard, assist on', () => {
  it.each(WEEKS)('%s: on/off keys with a 150 ms reaction finish without spinning', (id) => {
    const drive = keyboardDrive(generateLevel(id), ASSIST_STRENGTH, STEADY_HANDS);
    expect(drive.finished).toBe(true);
    expect(drive.spins).toBe(0);
    expect(drive.resets).toBeLessThanOrEqual(1);
    expect(drive.seconds).toBeLessThan(90);
  });

  it('copes with twitchy hands on every level, where the same hands without the assist mostly spin', () => {
    let assistedSpins = 0;
    let unaidedSpins = 0;
    let unaidedFinishes = 0;
    for (const id of WEEKS) {
      const level = generateLevel(id);
      const assisted = keyboardDrive(level, ASSIST_STRENGTH, TWITCHY_HANDS);
      expect(assisted.finished, id).toBe(true);
      expect(assisted.resets, id).toBeLessThanOrEqual(MAX_RESETS);
      assistedSpins += assisted.spins;
      const unaided = keyboardDrive(level, 0, TWITCHY_HANDS);
      unaidedSpins += unaided.spins;
      if (unaided.finished) unaidedFinishes++;
    }
    expect(assistedSpins).toBeLessThanOrEqual(WEEKS.length / 2);
    // With the assist off the car is as loose as it was built to be: these hands are not good enough for it.
    expect(unaidedSpins).toBeGreaterThan(30);
    expect(unaidedFinishes).toBeLessThan(WEEKS.length);
  });
});
