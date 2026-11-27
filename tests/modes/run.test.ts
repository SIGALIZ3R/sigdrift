import { describe, expect, it } from 'vitest';
import type { Gate, InputState, Level, RunMode, World } from '../../src/types';
import { DT, SIM_HZ } from '../../src/types';
import { PI } from '../../src/core/fixedMath';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel, makeStraightLevel } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const FULL_THROTTLE: InputState = { ...IDLE, throttle: 1 };
const RESET: InputState = { ...IDLE, reset: true };

const HALF_WIDTH = 8;
const CHECKPOINT_XS = [50, 100, 150];
const GOAL_X = 200;

function gateAcross(level: Level, x: number, halfSpan = HALF_WIDTH, heading = 0): Gate {
  const pathIndex = level.path.findIndex((p) => p.x >= x);
  return { ax: x, az: -halfSpan, bx: x, bz: halfSpan, pathIndex, respawn: { x, z: 0, heading } };
}

/** A 200 m straight along +x with checkpoints at x = 50, 100 and 150 and the goal at x = 200. */
function threeGateLevel(): Level {
  const level = makeStraightLevel(GOAL_X, HALF_WIDTH);
  level.checkpoints = CHECKPOINT_XS.map((x) => gateAcross(level, x));
  return level;
}

function start(level: Level): { world: World; run: RunMode } {
  const world = createWorld(level);
  const run = createRunMode(world);
  for (let i = 0; i < COUNTDOWN_TICKS; i++) run.step(IDLE);
  return { world, run };
}

function steps(run: RunMode, count: number, input: InputState = IDLE): void {
  for (let i = 0; i < count; i++) run.step(input);
}

/** Puts the car just short of the line x = `lineX` at `speed` along +x (negative: rolling backwards) and steps once. */
function cross(run: RunMode, lineX: number, speed = 20, z = 0): void {
  const car = run.world.car;
  car.x = lineX - Math.sign(speed) * 0.05;
  car.z = z;
  car.heading = 0;
  car.vx = speed;
  car.vz = 0;
  car.yawRate = 0;
  run.step(IDLE);
}

describe('countdown', () => {
  it('lasts three seconds', () => {
    expect(COUNTDOWN_TICKS).toBe(3 * SIM_HZ);
  });

  it('starts in the countdown with a clean slate', () => {
    const level = threeGateLevel();
    const run = createRunMode(createWorld(level));
    expect(run.state).toEqual({
      phase: 'countdown',
      countdownTicks: COUNTDOWN_TICKS,
      ticks: 0,
      nextCheckpoint: 0,
      checkpointCount: 3,
      splits: [],
      respawn: level.start,
      resets: 0,
      driftScore: 0,
      chainScore: 0,
      multiplier: 1,
      drifting: false,
      lastCheckpointTick: -1,
      lastChainBreakTick: -1,
    });
    expect(run.state.respawn).not.toBe(level.start);
  });

  it('holds the car on the start pad, whatever the driver does', () => {
    const level = threeGateLevel();
    const world = createWorld(level);
    const run = createRunMode(world);
    for (let i = 1; i < COUNTDOWN_TICKS; i++) {
      run.step({ steer: 1, throttle: 1, brake: 0, handbrake: false, reset: false });
      expect(run.state.phase).toBe('countdown');
      expect(run.state.countdownTicks).toBe(COUNTDOWN_TICKS - i);
    }
    expect(world.tick).toBe(0);
    expect(run.state.ticks).toBe(0);
    expect(world.car.x).toBe(level.start.x);
    expect(world.car.z).toBe(level.start.z);
    expect(world.car.speed).toBe(0);
    expect(world.car.steerAngle).toBe(0);
  });

  it('turns into the run when it reaches zero, and the clock starts on the next tick', () => {
    const world = createWorld(threeGateLevel());
    const run = createRunMode(world);
    steps(run, COUNTDOWN_TICKS, FULL_THROTTLE);
    expect(run.state.phase).toBe('running');
    expect(run.state.countdownTicks).toBe(0);
    expect(run.state.ticks).toBe(0);
    expect(world.tick).toBe(0);

    run.step(FULL_THROTTLE);
    expect(run.state.ticks).toBe(1);
    expect(world.tick).toBe(1);
    expect(world.car.speed).toBeGreaterThan(0);
  });
});

describe('gates', () => {
  it('counts each checkpoint once, in order, and records the split', () => {
    const level = threeGateLevel();
    const { run } = start(level);
    steps(run, 10);
    cross(run, 50);
    expect(run.state.nextCheckpoint).toBe(1);
    expect(run.state.splits).toEqual([11]);
    expect(run.state.lastCheckpointTick).toBe(11);
    expect(run.state.respawn).toEqual(level.checkpoints[0].respawn);
    expect(run.state.respawn).not.toBe(level.checkpoints[0].respawn);

    steps(run, 5);
    cross(run, 100);
    cross(run, 150);
    expect(run.state.nextCheckpoint).toBe(3);
    expect(run.state.splits).toEqual([11, 17, 18]);
    expect(run.state.lastCheckpointTick).toBe(18);
    expect(run.state.respawn).toEqual(level.checkpoints[2].respawn);
    expect(run.state.phase).toBe('running');
  });

  it('ignores a checkpoint taken out of order', () => {
    const level = threeGateLevel();
    const { run } = start(level);
    cross(run, 100);
    cross(run, 150);
    expect(run.state.nextCheckpoint).toBe(0);
    expect(run.state.splits).toEqual([]);
    expect(run.state.lastCheckpointTick).toBe(-1);
    expect(run.state.respawn).toEqual(level.start);

    cross(run, 50);
    expect(run.state.nextCheckpoint).toBe(1);
  });

  it('ignores a gate crossed backwards, and counts it when it is then taken forwards', () => {
    const { run } = start(threeGateLevel());
    cross(run, 50, -20);
    expect(run.world.car.x).toBeLessThan(50);
    expect(run.state.nextCheckpoint).toBe(0);
    cross(run, 50, 20);
    expect(run.state.nextCheckpoint).toBe(1);
    // Rolling back over it and through again changes nothing: the next gate is the one at x = 100.
    cross(run, 50, -20);
    cross(run, 50, 20);
    expect(run.state.nextCheckpoint).toBe(1);
    expect(run.state.splits).toHaveLength(1);
  });

  it('takes the forward direction from the respawn heading of the gate', () => {
    const level = threeGateLevel();
    level.checkpoints = [gateAcross(level, 50, HALF_WIDTH, PI)];
    const { run } = start(level);
    cross(run, 50, 20);
    expect(run.state.nextCheckpoint).toBe(0);
    cross(run, 50, -20);
    expect(run.state.nextCheckpoint).toBe(1);
  });

  it('only counts a crossing between the two ends of the gate', () => {
    const level = threeGateLevel();
    level.checkpoints = [gateAcross(level, 50, 2)];
    const { run } = start(level);
    cross(run, 50, 20, 5);
    cross(run, 50, 20, -2.5);
    expect(run.state.nextCheckpoint).toBe(0);
    cross(run, 50, 20, 1.9);
    expect(run.state.nextCheckpoint).toBe(1);
  });

  it('does not count a car that is standing or creeping short of the line', () => {
    const { run } = start(threeGateLevel());
    const car = run.world.car;
    car.x = 49.5;
    steps(run, 60);
    expect(run.state.nextCheckpoint).toBe(0);
  });

  it('ignores the goal until every checkpoint is taken', () => {
    const { run } = start(threeGateLevel());
    cross(run, GOAL_X);
    expect(run.state.phase).toBe('running');
    cross(run, 50);
    cross(run, 100);
    cross(run, GOAL_X);
    expect(run.state.phase).toBe('running');
    cross(run, 150);
    expect(run.state.phase).toBe('running');
    cross(run, GOAL_X);
    expect(run.state.phase).toBe('finished');
    expect(run.state.nextCheckpoint).toBe(3);
    expect(run.state.splits).toHaveLength(3);
  });

  it('finishes a level that has no checkpoints as soon as the goal is crossed', () => {
    const level = threeGateLevel();
    level.checkpoints = [];
    const { run } = start(level);
    expect(run.state.checkpointCount).toBe(0);
    cross(run, GOAL_X);
    expect(run.state.phase).toBe('finished');
  });

  it('is reached by simply driving the road', () => {
    const { run } = start(threeGateLevel());
    for (let i = 0; i < 30 * SIM_HZ && run.state.phase === 'running'; i++) run.step(FULL_THROTTLE);
    expect(run.state.phase).toBe('finished');
    expect(run.state.splits).toHaveLength(3);
    expect(run.state.splits[0]).toBeLessThan(run.state.splits[1]);
    expect(run.state.splits[2]).toBeLessThan(run.state.ticks);
    expect(run.state.resets).toBe(0);
  });
});

describe('reset', () => {
  it('puts the car at rest on the start pad before any checkpoint, and the clock keeps running', () => {
    const level = threeGateLevel();
    const { world, run } = start(level);
    steps(run, 2 * SIM_HZ, { ...FULL_THROTTLE, steer: 0.3 });
    expect(world.car.x).toBeGreaterThan(5);
    run.step(RESET);
    expect(run.state.resets).toBe(1);
    expect(run.state.ticks).toBe(2 * SIM_HZ + 1);
    expect(world.tick).toBe(2 * SIM_HZ + 1);
    expect(world.car.x).toBe(level.start.x);
    expect(world.car.z).toBe(level.start.z);
    expect(world.car.heading).toBe(level.start.heading);
    expect(world.car.speed).toBe(0);
    expect(world.car.yawRate).toBe(0);
  });

  it('returns to the last checkpoint taken, facing along the road', () => {
    const level = threeGateLevel();
    const { world, run } = start(level);
    cross(run, 50);
    cross(run, 100);
    steps(run, SIM_HZ, { ...FULL_THROTTLE, steer: -0.4 });
    run.step(RESET);
    expect(world.car.x).toBe(100);
    expect(world.car.z).toBe(0);
    expect(world.car.heading).toBe(0);
    expect(world.car.speed).toBe(0);
    // Being put back on the line is not a crossing.
    expect(run.state.nextCheckpoint).toBe(2);
    expect(run.state.splits).toHaveLength(2);
  });

  it('fires once per press, however long the button is held', () => {
    const { world, run } = start(threeGateLevel());
    steps(run, SIM_HZ, FULL_THROTTLE);
    steps(run, SIM_HZ, { ...FULL_THROTTLE, reset: true });
    expect(run.state.resets).toBe(1);
    // Held, the car drives off again instead of being pinned to the pad.
    expect(world.car.x).toBeGreaterThan(1);

    steps(run, 3, FULL_THROTTLE);
    run.step(RESET);
    expect(run.state.resets).toBe(2);
    run.step(IDLE);
    run.step(RESET);
    expect(run.state.resets).toBe(3);
  });

  it('ignores a button held through the countdown until it is pressed again', () => {
    const world = createWorld(threeGateLevel());
    const run = createRunMode(world);
    steps(run, COUNTDOWN_TICKS + 10, RESET);
    expect(run.state.phase).toBe('running');
    expect(run.state.resets).toBe(0);
    run.step(IDLE);
    run.step(RESET);
    expect(run.state.resets).toBe(1);
  });

  it('does nothing once the run is finished', () => {
    const level = threeGateLevel();
    level.checkpoints = [];
    const { run } = start(level);
    cross(run, GOAL_X, 8);
    run.step(RESET);
    expect(run.state.resets).toBe(0);
    expect(run.world.car.x).toBeGreaterThan(GOAL_X);
  });
});

describe('finish', () => {
  function finishedRun(speed: number): { world: World; run: RunMode } {
    const level = threeGateLevel();
    level.checkpoints = [];
    const started = start(level);
    steps(started.run, 100);
    cross(started.run, GOAL_X, speed);
    return started;
  }

  it('freezes the time', () => {
    const { world, run } = finishedRun(8);
    expect(run.state.phase).toBe('finished');
    expect(run.state.ticks).toBe(101);
    steps(run, 5 * SIM_HZ, FULL_THROTTLE);
    expect(run.state.phase).toBe('finished');
    expect(run.state.ticks).toBe(101);
    expect(run.state.ticks * DT).toBeCloseTo(101 / 120, 12);
    expect(world.tick).toBe(101 + 5 * SIM_HZ);
  });

  it('brakes the car to a stop and keeps it there, ignoring the driver', () => {
    const { world, run } = finishedRun(8);
    const car = world.car;
    let slowest = Infinity;
    for (let i = 0; i < 5 * SIM_HZ; i++) {
      run.step({ steer: 1, throttle: 1, brake: 0, handbrake: false, reset: false });
      slowest = Math.min(slowest, car.forwardSpeed);
    }
    expect(car.speed).toBe(0);
    expect(car.throttle).toBe(0);
    expect(car.steerAngle).toBe(0);
    // Stopped by the brakes within a few metres, without bouncing off the end wall or selecting reverse.
    expect(slowest).toBeGreaterThanOrEqual(0);
    expect(car.x).toBeGreaterThan(GOAL_X);
    expect(car.x).toBeLessThan(GOAL_X + 4);
    expect(car.z).toBeCloseTo(0, 6);
  });

  it('also stops a car that crossed the line going backwards over a reversed goal', () => {
    const level = threeGateLevel();
    level.checkpoints = [];
    level.goal = gateAcross(level, 100, HALF_WIDTH, PI);
    const { world, run } = start(level);
    cross(run, 100, -8);
    expect(run.state.phase).toBe('finished');
    steps(run, 5 * SIM_HZ, FULL_THROTTLE);
    expect(world.car.speed).toBe(0);
    expect(world.car.x).toBeGreaterThan(80);
  });
});

describe('restart', () => {
  it('goes back to the start line with a fresh countdown and a fresh state', () => {
    const level = makeOpenLevel(300);
    const { world, run } = start(level);
    const state = run.state;
    // A lap of everything: a slide for drift points, a wall for a broken chain, and a reset.
    steps(run, 3 * SIM_HZ, FULL_THROTTLE);
    steps(run, SIM_HZ, { ...IDLE, steer: 1, handbrake: true });
    steps(run, 2 * SIM_HZ, FULL_THROTTLE);
    run.step(RESET);
    steps(run, SIM_HZ, FULL_THROTTLE);
    expect(state.ticks).toBe(7 * SIM_HZ + 1);
    expect(state.resets).toBe(1);

    run.restart();
    expect(run.state).toBe(state);
    expect(state).toEqual(createRunMode(createWorld(level)).state);
    expect(world.tick).toBe(0);
    expect(world.car.x).toBe(level.start.x);
    expect(world.car.z).toBe(level.start.z);
    expect(world.car.heading).toBe(level.start.heading);
    expect(world.car.speed).toBe(0);
    expect(world.lastCollision).toBeNull();
  });

  it('forgets checkpoints, splits and the respawn point', () => {
    const level = threeGateLevel();
    const { run } = start(level);
    cross(run, 50);
    cross(run, 100);
    run.restart();
    expect(run.state.nextCheckpoint).toBe(0);
    expect(run.state.splits).toEqual([]);
    expect(run.state.respawn).toEqual(level.start);
    expect(run.state.lastCheckpointTick).toBe(-1);

    steps(run, COUNTDOWN_TICKS);
    cross(run, 100);
    expect(run.state.nextCheckpoint).toBe(0);
    run.step(RESET);
    expect(run.world.car.x).toBe(level.start.x);
  });

  it('works from the finished state, and the second run plays out exactly like the first', () => {
    const level = threeGateLevel();
    const world = createWorld(level);
    const run = createRunMode(world);
    const drive = (): number[] => {
      for (let i = 0; i < 40 * SIM_HZ && run.state.phase !== 'finished'; i++) run.step(FULL_THROTTLE);
      return [run.state.ticks, ...run.state.splits, ...world.snapshot()];
    };
    const first = drive();
    expect(run.state.phase).toBe('finished');
    run.restart();
    expect(run.state.phase).toBe('countdown');
    expect(drive()).toEqual(first);
  });
});
