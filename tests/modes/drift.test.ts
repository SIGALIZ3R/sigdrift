import { describe, expect, it } from 'vitest';
import type { CollisionEvent, InputState, Level, Pose, RunMode, World } from '../../src/types';
import { DT, SIM_HZ } from '../../src/types';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { createCarState, resetCarState } from '../../src/sim/car';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel, makeStraightLevel } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const RESET: InputState = { ...IDLE, reset: true };

const GRACE_TICKS = Math.round(1.2 * SIM_HZ);
const MULTIPLIER_TICKS = 2 * SIM_HZ;
/** Points per tick of the standard test slide below: 20 m/s at 0.5 rad. */
const SLIDE_SPEED = 20;
const SLIDE_ANGLE = 0.5;
const POINTS_PER_TICK = SLIDE_SPEED * SLIDE_ANGLE * DT * 10;

/**
 * A world without physics: the car only coasts along its velocity, and the test writes the derived fields the
 * scoring rules read. That pins the rules to exact numbers, which a real slide never gives.
 */
function stubWorld(level: Level): World {
  const car = createCarState(level.start);
  return {
    level,
    params: cloneParams(DEFAULT_CAR_PARAMS),
    car,
    tick: 0,
    lastCollision: null,
    step(): void {
      car.x += car.vx * DT;
      car.z += car.vz * DT;
      this.tick++;
    },
    placeCar(pose: Pose): void {
      resetCarState(car, pose);
      this.lastCollision = null;
    },
    snapshot(): number[] {
      return [this.tick, car.x, car.z];
    },
  };
}

function start(level: Level = makeStraightLevel(200, 8)): { world: World; run: RunMode } {
  const world = stubWorld(level);
  const run = createRunMode(world);
  for (let i = 0; i < COUNTDOWN_TICKS; i++) run.step(IDLE);
  return { world, run };
}

/** Makes the car read as sliding at `angle` while travelling at `speed`. The stub leaves the fields alone. */
function slide(world: World, speed = SLIDE_SPEED, angle = SLIDE_ANGLE): void {
  world.car.speed = speed;
  world.car.forwardSpeed = speed * Math.cos(angle);
  world.car.driftAngle = angle;
}

function straighten(world: World, speed = SLIDE_SPEED): void {
  slide(world, speed, 0);
}

function steps(run: RunMode, count: number): void {
  for (let i = 0; i < count; i++) run.step(IDLE);
}

function hit(impact: number): CollisionEvent {
  return { x: 0, z: 0, nx: 0, nz: 1, impact };
}

describe('what counts as drifting', () => {
  const isDrifting = (speed: number, angle: number, forwardSpeed?: number): boolean => {
    const { world, run } = start();
    slide(world, speed, angle);
    if (forwardSpeed !== undefined) world.car.forwardSpeed = forwardSpeed;
    run.step(IDLE);
    return run.state.drifting;
  };

  it('needs more than 7 m/s', () => {
    expect(isDrifting(7, 0.5)).toBe(false);
    expect(isDrifting(7.01, 0.5)).toBe(true);
  });

  it('needs a drift angle between 0.2 and 1.9 rad, either way', () => {
    expect(isDrifting(20, 0.2)).toBe(false);
    expect(isDrifting(20, 0.21)).toBe(true);
    expect(isDrifting(20, -0.21)).toBe(true);
    expect(isDrifting(20, -1.5)).toBe(true);
    expect(isDrifting(20, 1.89, 1)).toBe(true);
    expect(isDrifting(20, 1.9, 1)).toBe(false);
    expect(isDrifting(20, 0)).toBe(false);
  });

  it('needs the car to be travelling nose first', () => {
    expect(isDrifting(20, 0.5, 0)).toBe(false);
    expect(isDrifting(20, 0.5, -3)).toBe(false);
  });

  it('is never true during the countdown or after the finish', () => {
    const level = makeStraightLevel(200, 8);
    level.checkpoints = [];
    const world = stubWorld(level);
    const run = createRunMode(world);
    slide(world);
    run.step(IDLE);
    expect(run.state.drifting).toBe(false);
    expect(run.state.chainScore).toBe(0);

    for (let i = 1; i < COUNTDOWN_TICKS; i++) run.step(IDLE);
    slide(world);
    world.car.x = 199.95;
    world.car.vx = 20;
    run.step(IDLE);
    expect(run.state.phase).toBe('finished');
    expect(run.state.drifting).toBe(false);
    steps(run, 10);
    expect(run.state.drifting).toBe(false);
    expect(run.state.chainScore).toBe(0);
  });
});

describe('drift chain', () => {
  it('earns speed x angle x 10 points per second while drifting', () => {
    const { world, run } = start();
    slide(world);
    steps(run, 60);
    expect(run.state.drifting).toBe(true);
    expect(run.state.chainScore).toBeCloseTo(60 * POINTS_PER_TICK, 9);
    expect(run.state.driftScore).toBe(0);

    slide(world, 10, -1);
    steps(run, 30);
    expect(run.state.chainScore).toBeCloseTo(60 * POINTS_PER_TICK + 30 * 10 * 1 * DT * 10, 9);
  });

  it('banks the chain 1.2 s after the drifting stops', () => {
    const { world, run } = start();
    slide(world);
    steps(run, 60);
    straighten(world);
    steps(run, GRACE_TICKS - 1);
    expect(run.state.drifting).toBe(false);
    expect(run.state.chainScore).toBeCloseTo(60 * POINTS_PER_TICK, 9);
    expect(run.state.driftScore).toBe(0);

    run.step(IDLE);
    expect(run.state.chainScore).toBe(0);
    expect(run.state.multiplier).toBe(1);
    expect(run.state.driftScore).toBe(Math.round(60 * POINTS_PER_TICK));
    expect(run.state.lastChainBreakTick).toBe(-1);
  });

  it('keeps one chain across drifts linked within the grace time', () => {
    const { world, run } = start();
    slide(world);
    steps(run, 100);
    straighten(world);
    steps(run, GRACE_TICKS - 1);
    slide(world, SLIDE_SPEED, -SLIDE_ANGLE);
    steps(run, 100);
    expect(run.state.driftScore).toBe(0);
    expect(run.state.chainScore).toBeCloseTo(200 * POINTS_PER_TICK, 9);

    // The grace time starts again after every link.
    straighten(world);
    steps(run, GRACE_TICKS - 1);
    expect(run.state.driftScore).toBe(0);
    run.step(IDLE);
    expect(run.state.driftScore).toBe(Math.round(200 * POINTS_PER_TICK));
  });

  it('raises the multiplier by one for every 2 s of drifting in the chain, up to 8', () => {
    const { world, run } = start(makeStraightLevel(2000, 8));
    slide(world);
    steps(run, MULTIPLIER_TICKS - 1);
    expect(run.state.multiplier).toBe(1);
    run.step(IDLE);
    expect(run.state.multiplier).toBe(2);
    steps(run, MULTIPLIER_TICKS);
    expect(run.state.multiplier).toBe(3);
    steps(run, 5 * MULTIPLIER_TICKS - 1);
    expect(run.state.multiplier).toBe(7);
    run.step(IDLE);
    expect(run.state.multiplier).toBe(8);
    steps(run, 3 * MULTIPLIER_TICKS);
    expect(run.state.multiplier).toBe(8);
  });

  it('counts only drifting time towards the multiplier, across linked drifts', () => {
    const { world, run } = start();
    slide(world);
    steps(run, MULTIPLIER_TICKS - 20);
    straighten(world);
    steps(run, 100);
    expect(run.state.multiplier).toBe(1);
    slide(world);
    steps(run, 19);
    expect(run.state.multiplier).toBe(1);
    run.step(IDLE);
    expect(run.state.multiplier).toBe(2);
  });

  it('banks the chain times its multiplier', () => {
    const { world, run } = start();
    slide(world);
    steps(run, MULTIPLIER_TICKS);
    straighten(world);
    steps(run, GRACE_TICKS);
    expect(run.state.driftScore).toBe(Math.round(2 * MULTIPLIER_TICKS * POINTS_PER_TICK));
    expect(run.state.driftScore).toBe(400);

    // A second chain starts from nothing and adds to the bank.
    slide(world);
    steps(run, 60);
    expect(run.state.multiplier).toBe(1);
    straighten(world);
    steps(run, GRACE_TICKS);
    expect(run.state.driftScore).toBe(450);
  });
});

describe('losing the chain', () => {
  function midChain(): { world: World; run: RunMode } {
    const started = start();
    slide(started.world);
    steps(started.run, MULTIPLIER_TICKS + 10);
    expect(started.run.state.multiplier).toBe(2);
    expect(started.run.state.chainScore).toBeGreaterThan(0);
    return started;
  }

  function expectLost(run: RunMode, tick: number): void {
    expect(run.state.chainScore).toBe(0);
    expect(run.state.multiplier).toBe(1);
    expect(run.state.drifting).toBe(false);
    expect(run.state.driftScore).toBe(0);
    expect(run.state.lastChainBreakTick).toBe(tick);
  }

  it('happens on a wall hit harder than 3 m/s, and nothing is banked', () => {
    const { world, run } = midChain();
    world.lastCollision = hit(3.01);
    run.step(IDLE);
    expectLost(run, MULTIPLIER_TICKS + 11);

    // Nothing left to bank once the grace time has passed.
    world.lastCollision = null;
    straighten(world);
    steps(run, GRACE_TICKS + 5);
    expect(run.state.driftScore).toBe(0);
  });

  it('does not happen on a scrape of 3 m/s or less', () => {
    const { world, run } = midChain();
    const before = run.state.chainScore;
    world.lastCollision = hit(3);
    run.step(IDLE);
    expect(run.state.chainScore).toBeGreaterThan(before);
    expect(run.state.multiplier).toBe(2);
    expect(run.state.lastChainBreakTick).toBe(-1);
  });

  it('happens on a spin: more than 2.2 rad of drift angle above 5 m/s', () => {
    const { world, run } = midChain();
    slide(world, 5.01, 2.21);
    run.step(IDLE);
    expectLost(run, MULTIPLIER_TICKS + 11);
  });

  it('survives a slow pirouette and a fast slide that stays short of a spin', () => {
    const { world, run } = midChain();
    slide(world, 5, 3);
    run.step(IDLE);
    slide(world, 20, 2.2);
    run.step(IDLE);
    expect(run.state.chainScore).toBeGreaterThan(0);
    expect(run.state.multiplier).toBe(2);
    expect(run.state.lastChainBreakTick).toBe(-1);
  });

  it('happens on a reset', () => {
    const { run } = midChain();
    run.step(RESET);
    expect(run.state.resets).toBe(1);
    expectLost(run, MULTIPLIER_TICKS + 11);
  });

  it('starts a new chain from scratch afterwards', () => {
    const { world, run } = midChain();
    world.lastCollision = hit(10);
    run.step(IDLE);
    world.lastCollision = null;
    steps(run, 30);
    expect(run.state.drifting).toBe(true);
    expect(run.state.multiplier).toBe(1);
    expect(run.state.chainScore).toBeCloseTo(30 * POINTS_PER_TICK, 9);
  });

  it('leaves the break marker alone when there was no chain to lose', () => {
    const { world, run } = start();
    straighten(world);
    world.lastCollision = hit(12);
    run.step(IDLE);
    run.step(RESET);
    expect(run.state.lastChainBreakTick).toBe(-1);
  });
});

describe('drift score at the finish', () => {
  it('banks the live chain, multiplier included', () => {
    const level = makeStraightLevel(200, 8);
    level.checkpoints = [];
    const { world, run } = start(level);
    slide(world);
    steps(run, MULTIPLIER_TICKS);
    world.car.x = 199.95;
    world.car.vx = 20;
    run.step(IDLE);
    expect(run.state.phase).toBe('finished');
    expect(run.state.driftScore).toBe(Math.round(2 * (MULTIPLIER_TICKS + 1) * POINTS_PER_TICK));
    expect(run.state.chainScore).toBe(0);
    expect(run.state.multiplier).toBe(1);
    expect(run.state.lastChainBreakTick).toBe(-1);

    steps(run, GRACE_TICKS + 10);
    expect(run.state.driftScore).toBe(Math.round(2 * (MULTIPLIER_TICKS + 1) * POINTS_PER_TICK));
  });
});

describe('drift scoring with the real car', () => {
  it('scores a handbrake slide, banks it once the car is straight, and loses a chain against a wall', () => {
    const world = createWorld(makeOpenLevel(400));
    const run = createRunMode(world);
    const state = run.state;
    const drive = (seconds: number, input: Partial<InputState>, until?: () => boolean): void => {
      for (let i = 0; i < seconds * SIM_HZ && !until?.(); i++) run.step({ ...IDLE, ...input });
    };
    drive(3, {});
    drive(3.5, { throttle: 1 });
    drive(0.5, { steer: 1, handbrake: true });
    expect(state.drifting).toBe(true);
    expect(state.chainScore).toBeGreaterThan(0);
    expect(state.driftScore).toBe(0);

    // Let go of everything: the car straightens or stops, and the chain is banked 1.2 s later.
    drive(8, {}, () => state.driftScore > 0);
    expect(state.driftScore).toBeGreaterThan(10);
    expect(state.chainScore).toBe(0);
    expect(state.lastChainBreakTick).toBe(-1);

    // Second slide, this time carried into the wall.
    const banked = state.driftScore;
    drive(6, { throttle: 1 }, () => world.car.speed > 22);
    drive(0.4, { steer: -1, handbrake: true });
    expect(state.chainScore).toBeGreaterThan(0);
    drive(20, { throttle: 1 }, () => state.lastChainBreakTick >= 0);
    expect(state.lastChainBreakTick).toBe(state.ticks);
    expect(state.chainScore).toBe(0);
    expect(state.driftScore).toBe(banked);
  });
});
