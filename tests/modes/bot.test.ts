import { describe, expect, it } from 'vitest';
import type { InputState, Level, RunMode, World } from '../../src/types';
import { DT, SIM_HZ } from '../../src/types';
import { createBot } from '../../src/modes/bot';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { generateLevel } from '../../src/gen/trackGen';
import { shiftWeek } from '../../src/gen/weeklySeed';
import { quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import { makeStraightLevel } from '../helpers/handLevel';

const FIRST_WEEK = '2026-W48';
const WEEKS = Array.from({ length: 12 }, (_, i) => shiftWeek(FIRST_WEEK, i));
const TIME_LIMIT_S = 150;
const MAX_RESETS = 3;
const STUCK_TICKS = 4 * SIM_HZ;

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
  });
});
