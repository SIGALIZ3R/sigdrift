/**
 * Drift scoring (src/modes/driftScore.ts): the rules pinned to exact numbers on hand-set car states, then the rules
 * as the run mode applies them, then a real slide with the real car.
 */
import { describe, expect, it } from 'vitest';
import type { CarState, CollisionEvent, InputState, Level, Pose, RunMode, ScoreState, World } from '../../src/types';
import { DT, SIM_HZ, TERRAIN_Y } from '../../src/types';
import {
  CLOSE_PROXIMITY,
  DRIFT_MAX_ANGLE,
  DRIFT_MIN_ANGLE,
  DRIFT_MIN_SPEED,
  LOSS_IMPACT,
  MAX_MULTIPLIER,
  MULTIPLIER_DECAY,
  MULTIPLIER_HOLD_TICKS,
  MULTIPLIER_PROXIMITY_RATE,
  MULTIPLIER_RATE,
  POINTS_RATE,
  PROXIMITY_FAR,
  PROXIMITY_NEAR,
  PROXIMITY_POINTS_BONUS,
  RECOVER_CLEAN_TICKS,
  RECOVER_TICKS,
  SPIN_ANGLE,
  createScoreState,
  isRecovering,
  isDrifting,
  proximityAt,
  resetScore,
  stepScore,
} from '../../src/modes/driftScore';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { createCarState, resetCarState } from '../../src/sim/car';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel, makeStraightLevel } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const RESET: InputState = { ...IDLE, reset: true };
const CLEAN = { crashed: false, lost: false };
const CRASHED = { crashed: true, lost: false };
const LOST = { crashed: false, lost: true };
const FAR = Infinity;

/** The standard test slide: 20 m/s at 0.5 rad. */
const SLIDE_SPEED = 20;
const SLIDE_ANGLE = 0.5;
/** Points per tick of the standard slide at multiplier 1 and proximity 0. */
const BASE_PER_TICK = SLIDE_SPEED * SLIDE_ANGLE * POINTS_RATE * DT;

/** A car that reads as sliding at `angle` while travelling at `speed`, on the ground. */
function sliding(speed = SLIDE_SPEED, angle = SLIDE_ANGLE): CarState {
  const car = createCarState({ x: 0, z: 0, heading: 0 });
  car.speed = speed;
  car.forwardSpeed = speed * Math.cos(angle);
  car.driftAngle = angle;
  return car;
}

function straight(car: CarState, speed = SLIDE_SPEED): CarState {
  car.speed = speed;
  car.forwardSpeed = speed;
  car.driftAngle = 0;
  return car;
}

/** Steps the score `ticks` times from tick `from`, and returns the tick after the last. */
function run(s: ScoreState, car: CarState, ticks: number, wallDistance = FAR, from = 0): number {
  for (let i = 0; i < ticks; i++) stepScore(s, car, wallDistance, from + i, CLEAN);
  return from + ticks;
}

describe('what counts as drifting', () => {
  it(`needs more than ${DRIFT_MIN_SPEED} m/s`, () => {
    expect(isDrifting(sliding(DRIFT_MIN_SPEED, 0.5))).toBe(false);
    expect(isDrifting(sliding(DRIFT_MIN_SPEED + 0.01, 0.5))).toBe(true);
  });

  it(`needs a drift angle between ${DRIFT_MIN_ANGLE} and ${DRIFT_MAX_ANGLE} rad, either way`, () => {
    for (const sign of [1, -1]) {
      expect(isDrifting(sliding(20, sign * DRIFT_MIN_ANGLE))).toBe(false);
      expect(isDrifting(sliding(20, sign * (DRIFT_MIN_ANGLE + 0.01)))).toBe(true);
      expect(isDrifting(sliding(20, sign * 1.6))).toBe(true);
      expect(isDrifting(sliding(20, sign * (DRIFT_MAX_ANGLE - 0.01)))).toBe(true);
      expect(isDrifting(sliding(20, sign * DRIFT_MAX_ANGLE))).toBe(false);
    }
  });

  it('needs the wheels on the ground, and does not count reversing', () => {
    const air = sliding();
    air.airborne = true;
    expect(isDrifting(air)).toBe(false);
    const reverse = sliding(10, 0.5);
    reverse.reversing = true;
    expect(isDrifting(reverse)).toBe(false);
  });
});

describe('proximity', () => {
  it(`is 0 from ${PROXIMITY_FAR} m out, 1 from ${PROXIMITY_NEAR} m in, and rises smoothly in between`, () => {
    expect(proximityAt(Infinity)).toBe(0);
    expect(proximityAt(PROXIMITY_FAR)).toBe(0);
    expect(proximityAt(PROXIMITY_NEAR)).toBe(1);
    expect(proximityAt(0)).toBe(1);
    expect(proximityAt((PROXIMITY_FAR + PROXIMITY_NEAR) / 2)).toBeCloseTo(0.5, 12);
    let last = 0;
    for (let d = PROXIMITY_FAR; d >= PROXIMITY_NEAR; d -= 0.05) {
      const p = proximityAt(d);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('only counts while drifting', () => {
    const s = createScoreState();
    stepScore(s, straight(sliding()), 0, 0, CLEAN);
    expect(s.proximity).toBe(0);
    stepScore(s, sliding(), 0, 1, CLEAN);
    expect(s.proximity).toBe(1);
    stepScore(s, straight(sliding()), 0, 2, CLEAN);
    expect(s.proximity).toBe(0);
  });
});

describe('points', () => {
  it('start from a clean slate', () => {
    expect(createScoreState()).toMatchObject({
      points: 0,
      multiplier: 1,
      peakMultiplier: 1,
      drifting: false,
      proximity: 0,
      combo: 0,
      lastMultiplierLossTick: -1,
      lastCloseTick: -1,
    });
  });

  it(`flow at speed x angle x ${POINTS_RATE} a second, times the multiplier, in the open`, () => {
    const s = createScoreState();
    stepScore(s, sliding(), FAR, 0, CLEAN);
    expect(s.drifting).toBe(true);
    expect(s.multiplier).toBeCloseTo(1 + MULTIPLIER_RATE * DT, 12);
    expect(s.points).toBeCloseTo(BASE_PER_TICK * s.multiplier, 12);
    expect(s.combo).toBe(s.points);
  });

  it(`are worth ${1 + PROXIMITY_POINTS_BONUS} times as much brushing a wall`, () => {
    const s = createScoreState();
    stepScore(s, sliding(), 0.2, 0, CLEAN);
    const multiplier = 1 + (MULTIPLIER_RATE + MULTIPLIER_PROXIMITY_RATE) * DT;
    expect(s.multiplier).toBeCloseTo(multiplier, 12);
    expect(s.points).toBeCloseTo(BASE_PER_TICK * (1 + PROXIMITY_POINTS_BONUS) * multiplier, 12);
  });

  it('use the absolute drift angle, so left and right slides score alike', () => {
    const left = createScoreState();
    const right = createScoreState();
    run(left, sliding(20, -0.7), SIM_HZ, 2);
    run(right, sliding(20, 0.7), SIM_HZ, 2);
    expect(left.points).toBe(right.points);
    expect(left.points).toBeGreaterThan(0);
  });

  it('are nothing for grinding along a wall without drifting, or for a car in the air', () => {
    const s = createScoreState();
    run(s, straight(sliding()), SIM_HZ, 0);
    expect(s.points).toBe(0);
    const air = sliding();
    air.airborne = true;
    run(s, air, SIM_HZ, 0);
    expect(s.points).toBe(0);
    expect(s.drifting).toBe(false);
  });

  it('make hugging the wall by far the best way to score', () => {
    const open = createScoreState();
    const close = createScoreState();
    run(open, sliding(), 10 * SIM_HZ, 6);
    run(close, sliding(), 10 * SIM_HZ, 0.3);
    expect(close.points).toBeGreaterThan(4 * open.points);
  });
});

describe('the multiplier', () => {
  it(`climbs by ${MULTIPLIER_RATE} a second of drifting in the open`, () => {
    const s = createScoreState();
    run(s, sliding(), 4 * SIM_HZ);
    expect(s.multiplier).toBeCloseTo(1 + 4 * MULTIPLIER_RATE, 9);
  });

  it(`climbs by up to ${MULTIPLIER_PROXIMITY_RATE} a second more the closer the wall is`, () => {
    const at = (distance: number): number => {
      const s = createScoreState();
      run(s, sliding(), SIM_HZ, distance);
      return s.multiplier;
    };
    expect(at(0.3)).toBeCloseTo(1 + MULTIPLIER_RATE + MULTIPLIER_PROXIMITY_RATE, 9);
    expect(at((PROXIMITY_FAR + PROXIMITY_NEAR) / 2)).toBeCloseTo(1 + MULTIPLIER_RATE + MULTIPLIER_PROXIMITY_RATE / 2, 9);
    expect(at(1)).toBeGreaterThan(at(2));
    expect(at(2)).toBeGreaterThan(at(3.5));
    expect(at(5)).toBeCloseTo(1 + MULTIPLIER_RATE, 9);
  });

  it(`stops at ${MAX_MULTIPLIER}, and the peak is remembered`, () => {
    const s = createScoreState();
    run(s, sliding(), 30 * SIM_HZ, 0);
    expect(s.multiplier).toBe(MAX_MULTIPLIER);
    expect(s.peakMultiplier).toBe(MAX_MULTIPLIER);
  });

  it('holds for 1.5 s after the drifting stops, then decays by 0.5 a second to 1, ending the combo', () => {
    const s = createScoreState();
    const car = sliding();
    let tick = run(s, car, 8 * SIM_HZ);
    const held = s.multiplier;
    const points = s.points;
    expect(held).toBeCloseTo(3, 9);
    straight(car);
    tick = run(s, car, MULTIPLIER_HOLD_TICKS, FAR, tick);
    expect(s.multiplier).toBe(held);
    expect(s.combo).toBe(points);
    tick = run(s, car, SIM_HZ, FAR, tick);
    expect(s.multiplier).toBeCloseTo(held - MULTIPLIER_DECAY, 9);
    tick = run(s, car, 4 * SIM_HZ, FAR, tick);
    expect(s.multiplier).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.points).toBe(points);
    expect(s.peakMultiplier).toBe(held);
    expect(s.lastMultiplierLossTick).toBe(-1);
  });

  it('carries across drifts linked within the hold', () => {
    const s = createScoreState();
    const car = sliding();
    let tick = run(s, car, 2 * SIM_HZ);
    tick = run(s, straight(car), SIM_HZ, FAR, tick);
    run(s, sliding(), 2 * SIM_HZ, FAR, tick);
    expect(s.multiplier).toBeCloseTo(1 + 4 * MULTIPLIER_RATE, 9);
    expect(s.combo).toBeCloseTo(s.points, 9);
  });

  it('waits in the air: a jump between two drifts links them', () => {
    const s = createScoreState();
    const car = sliding();
    let tick = run(s, car, 2 * SIM_HZ);
    car.airborne = true;
    tick = run(s, car, 3 * SIM_HZ, FAR, tick);
    expect(s.multiplier).toBeCloseTo(1 + 2 * MULTIPLIER_RATE, 9);
    car.airborne = false;
    run(s, car, SIM_HZ, FAR, tick);
    expect(s.multiplier).toBeCloseTo(1 + 3 * MULTIPLIER_RATE, 9);
  });
});

describe('losing the multiplier', () => {
  /** A score in the middle of a good combo: 6 s of drifting at 1 m from a wall. */
  function midCombo(): { s: ScoreState; car: CarState; tick: number } {
    const s = createScoreState();
    const car = sliding();
    const tick = run(s, car, 6 * SIM_HZ, 1);
    expect(s.multiplier).toBeGreaterThan(5);
    return { s, car, tick };
  }

  it(`happens on a real impact (${LOSS_IMPACT} m/s or more): multiplier and combo go, the points stay`, () => {
    const { s, car, tick } = midCombo();
    const points = s.points;
    const peak = s.peakMultiplier;
    stepScore(s, car, 0, tick, CRASHED);
    expect(s.points).toBe(points);
    expect(s.multiplier).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.drifting).toBe(false);
    expect(s.lastMultiplierLossTick).toBe(tick);
    expect(s.peakMultiplier).toBe(peak);
  });

  it('happens on a fall or a reset', () => {
    const { s, car, tick } = midCombo();
    const points = s.points;
    stepScore(s, car, FAR, tick, LOST);
    expect(s.multiplier).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.points).toBe(points);
    expect(s.lastMultiplierLossTick).toBe(tick);
  });

  it(`happens on a spin: more than ${SPIN_ANGLE} rad of drift angle above 5 m/s`, () => {
    const { s, tick } = midCombo();
    stepScore(s, sliding(20, SPIN_ANGLE + 0.01), FAR, tick, CLEAN);
    expect(s.multiplier).toBe(1);
    expect(s.lastMultiplierLossTick).toBe(tick);
  });

  it('survives a slow pirouette, a slide that stays short of a spin, and reversing', () => {
    const { s, tick } = midCombo();
    const multiplier = s.multiplier;
    stepScore(s, sliding(4.9, 3), FAR, tick, CLEAN);
    stepScore(s, sliding(20, SPIN_ANGLE - 0.01), FAR, tick + 1, CLEAN);
    const reverse = sliding(10, 3.1);
    reverse.reversing = true;
    stepScore(s, reverse, FAR, tick + 2, CLEAN);
    expect(s.multiplier).toBe(multiplier);
    expect(s.lastMultiplierLossTick).toBe(-1);
  });

  it('starts again from scratch, and stamps nothing when there was nothing to lose', () => {
    const { s, car, tick } = midCombo();
    stepScore(s, car, FAR, tick, CRASHED);
    stepScore(s, car, FAR, tick + 5, CRASHED);
    expect(s.lastMultiplierLossTick).toBe(tick);
    // Recovering from the hit: driving straight for the lockout, then the next drift starts a fresh combo.
    const upright = straight(sliding());
    for (let i = 0; i < RECOVER_TICKS; i++) stepScore(s, upright, FAR, tick + 6 + i, CLEAN);
    expect(isRecovering(s)).toBe(false);
    const points = s.points;
    stepScore(s, car, FAR, tick + 6 + RECOVER_TICKS, CLEAN);
    expect(s.multiplier).toBeCloseTo(1 + MULTIPLIER_RATE * DT, 12);
    expect(s.combo).toBeCloseTo(s.points - points, 9);
  });
});

describe('recovering after a crash', () => {
  it(`scores nothing for ${RECOVER_TICKS} ticks while the wreck slides along the wall it hit`, () => {
    const s = createScoreState();
    const car = sliding();
    let tick = run(s, car, 2 * SIM_HZ, 1);
    stepScore(s, car, PROXIMITY_NEAR, tick++, { crashed: true, lost: false });
    const points = s.points;
    // The wreck keeps sliding at a drift angle right on the wall: none of it counts.
    for (let i = 0; i < 5 * SIM_HZ; i++) {
      stepScore(s, car, PROXIMITY_NEAR, tick++, CLEAN);
      expect(s.points).toBe(points);
      expect(s.multiplier).toBe(1);
      expect(s.drifting).toBe(false);
    }
    expect(isRecovering(s)).toBe(true);
    // It ends only after the car has stopped sliding for a moment.
    const upright = straight(sliding());
    for (let i = 0; i < RECOVER_CLEAN_TICKS - 1; i++) stepScore(s, upright, FAR, tick++, CLEAN);
    expect(isRecovering(s)).toBe(true);
    stepScore(s, upright, FAR, tick++, CLEAN);
    expect(isRecovering(s)).toBe(false);
    stepScore(s, car, FAR, tick++, CLEAN);
    expect(s.points).toBeGreaterThan(points);
    expect(s.drifting).toBe(true);
  });

  it('applies after a fall or reset too, but not after a spin', () => {
    const s = createScoreState();
    const car = sliding();
    let tick = run(s, car, SIM_HZ, 1);
    stepScore(s, car, FAR, tick++, LOST);
    expect(isRecovering(s)).toBe(true);
    resetScore(s);
    expect(isRecovering(s)).toBe(false);
    tick = run(s, car, SIM_HZ, FAR, tick);
    stepScore(s, sliding(20, SPIN_ANGLE + 0.01), FAR, tick++, CLEAN);
    expect(s.multiplier).toBe(1);
    expect(isRecovering(s)).toBe(false);
    const points = s.points;
    stepScore(s, car, FAR, tick++, CLEAN);
    expect(s.points).toBeGreaterThan(points);
  });
});

describe('close calls', () => {
  it(`are stamped when the proximity rises through ${CLOSE_PROXIMITY}, once per approach`, () => {
    const s = createScoreState();
    const car = sliding();
    run(s, car, 10, 3);
    expect(s.lastCloseTick).toBe(-1);
    run(s, car, 10, 1, 10);
    expect(s.lastCloseTick).toBe(10);
    run(s, car, 10, 0.5, 20);
    expect(s.lastCloseTick).toBe(10);
    run(s, car, 10, 3.5, 30);
    run(s, car, 10, 0.8, 40);
    expect(s.lastCloseTick).toBe(40);
  });
});

describe('resetScore', () => {
  it('brings everything back to a fresh run', () => {
    const s = createScoreState();
    run(s, sliding(), 5 * SIM_HZ, 0.3);
    stepScore(s, sliding(), 0, 999, CRASHED);
    resetScore(s);
    expect(s).toEqual(createScoreState());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The run mode applies the rules
// ---------------------------------------------------------------------------------------------------------------

interface StubWorld extends World {
  wallDistance: number;
  offTrack: boolean;
}

/**
 * A world without physics: the car only coasts along its velocity, and the test writes the derived fields the
 * scoring rules read. That pins the rules to exact numbers, which a real slide never gives.
 */
function stubWorld(level: Level): StubWorld {
  const car = createCarState(level.start);
  return {
    level,
    params: cloneParams(DEFAULT_CAR_PARAMS),
    car,
    tick: 0,
    lastCollision: null,
    wallDistance: Infinity,
    offTrack: false,
    groundHeight(): number {
      return 0;
    },
    step(): void {
      car.x += car.vx * DT;
      car.z += car.vz * DT;
      this.tick++;
    },
    placeCar(pose: Pose): void {
      resetCarState(car, pose);
      car.y = pose.y ?? 0;
      this.lastCollision = null;
      this.offTrack = false;
    },
    snapshot(): number[] {
      return [this.tick, car.x, car.z];
    },
  };
}

function start(level: Level = makeStraightLevel(200, 8)): { world: StubWorld; run: RunMode } {
  const world = stubWorld(level);
  const mode = createRunMode(world);
  for (let i = 0; i < COUNTDOWN_TICKS; i++) mode.step(IDLE);
  return { world, run: mode };
}

function slide(world: World, speed = SLIDE_SPEED, angle = SLIDE_ANGLE): void {
  world.car.speed = speed;
  world.car.forwardSpeed = speed * Math.cos(angle);
  world.car.driftAngle = angle;
}

function steps(mode: RunMode, count: number): void {
  for (let i = 0; i < count; i++) mode.step(IDLE);
}

function hit(impact: number): CollisionEvent {
  return { x: 0, z: 0, nx: 0, nz: 1, impact };
}

describe('scoring in the run mode', () => {
  it('scores nothing during the countdown or after the finish', () => {
    const level = makeStraightLevel(200, 8);
    level.checkpoints = [];
    const world = stubWorld(level);
    const mode = createRunMode(world);
    slide(world);
    steps(mode, COUNTDOWN_TICKS - 1);
    expect(mode.state.score.points).toBe(0);
    mode.step(IDLE);
    steps(mode, SIM_HZ);
    expect(mode.state.score.points).toBeGreaterThan(0);
    world.car.x = 199.95;
    world.car.vx = 20;
    mode.step(IDLE);
    expect(mode.state.phase).toBe('finished');
    const points = mode.state.score.points;
    expect(mode.state.score.drifting).toBe(false);
    slide(world);
    steps(mode, SIM_HZ);
    expect(mode.state.score.points).toBe(points);
  });

  it('reads the world wall distance for the proximity bonus', () => {
    const near = start();
    const far = start();
    slide(near.world);
    slide(far.world);
    near.world.wallDistance = 0.3;
    steps(near.run, SIM_HZ);
    steps(far.run, SIM_HZ);
    expect(near.run.state.score.proximity).toBe(1);
    expect(far.run.state.score.proximity).toBe(0);
    expect(near.run.state.score.points).toBeGreaterThan(3 * far.run.state.score.points);
  });

  it(`loses the multiplier on a hit of ${LOSS_IMPACT} m/s, not on a lighter scrape, and keeps the points`, () => {
    const { world, run: mode } = start();
    slide(world);
    world.wallDistance = 0.2;
    steps(mode, 2 * SIM_HZ);
    world.lastCollision = hit(LOSS_IMPACT - 0.01);
    mode.step(IDLE);
    expect(mode.state.score.multiplier).toBeGreaterThan(3);
    const points = mode.state.score.points;
    world.lastCollision = hit(LOSS_IMPACT);
    mode.step(IDLE);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.combo).toBe(0);
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.lastMultiplierLossTick).toBe(mode.state.ticks);
  });

  it('loses the multiplier on a reset, keeping the points', () => {
    const { world, run: mode } = start();
    slide(world);
    steps(mode, 2 * SIM_HZ);
    const points = mode.state.score.points;
    mode.step(RESET);
    expect(mode.state.resets).toBe(1);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.points).toBeGreaterThanOrEqual(points);
    expect(mode.state.score.lastMultiplierLossTick).toBe(mode.state.ticks);
  });

  it('loses the multiplier on a fall, keeping the points', () => {
    const { world, run: mode } = start();
    slide(world);
    steps(mode, 2 * SIM_HZ);
    const points = mode.state.score.points;
    world.offTrack = true;
    world.car.y = TERRAIN_Y;
    mode.step(IDLE);
    expect(mode.state.falls).toBe(1);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.lastMultiplierLossTick).toBe(mode.state.ticks);
  });
});

describe('drift scoring with the real car', () => {
  it('scores a handbrake slide, keeps the points through a crash into the wall and loses only the multiplier', () => {
    const world = createWorld(makeOpenLevel(120));
    const mode = createRunMode(world);
    const score = mode.state.score;
    let drifted = 0;
    const drive = (seconds: number, input: Partial<InputState>, until?: () => boolean): void => {
      for (let i = 0; i < seconds * SIM_HZ && !until?.(); i++) {
        mode.step({ ...IDLE, ...input });
        if (score.drifting) drifted++;
      }
    };
    drive(3, {});
    drive(2.5, { throttle: 1 });
    drive(0.6, { steer: 1, handbrake: true, throttle: 0.5 });
    expect(drifted).toBeGreaterThan(10);
    expect(score.points).toBeGreaterThan(0);
    expect(score.multiplier).toBeGreaterThan(1);

    // Straight on into the wall: the multiplier goes, the points stay.
    let pointsBefore = 0;
    drive(5, { throttle: 1 }, () => {
      const hard = world.lastCollision !== null && world.lastCollision.impact >= LOSS_IMPACT;
      if (!hard) pointsBefore = score.points;
      return hard;
    });
    expect(world.lastCollision?.impact).toBeGreaterThanOrEqual(LOSS_IMPACT);
    expect(score.lastMultiplierLossTick).toBe(mode.state.ticks);
    expect(score.multiplier).toBe(1);
    expect(score.combo).toBe(0);
    expect(score.points).toBe(pointsBefore);
    expect(score.points).toBeGreaterThan(10);
  });
});

describe('a real crash into the wall in the run mode', () => {
  it('earns nothing while the wreck bounces and slides along the wall afterwards, hands off', () => {
    let crashes = 0;
    for (const runUp of [1.5, 2, 2.5, 3]) {
      for (const steer of [0.3, 0.4, 0.5]) {
        const world = createWorld(makeStraightLevel(400, 7));
        const mode = createRunMode(world);
        for (let i = 0; i < COUNTDOWN_TICKS; i++) mode.step(IDLE);
        for (let i = 0; i < runUp / DT; i++) mode.step({ ...IDLE, throttle: 1 });
        let crashedAt = -1;
        for (let i = 0; i < 4 / DT && crashedAt < 0; i++) {
          mode.step({ ...IDLE, throttle: 1, steer });
          const hit = world.lastCollision;
          if (hit && hit.impact >= LOSS_IMPACT) crashedAt = mode.state.ticks;
        }
        if (crashedAt < 0) continue;
        crashes++;
        const points = mode.state.score.points;
        for (let i = 0; i < 5 / DT; i++) {
          mode.step(IDLE);
          // Hands off, the car never straightens into a drift of its own: nothing it does now is driving.
          if (world.lastCollision && world.lastCollision.impact >= LOSS_IMPACT) continue;
          expect(mode.state.score.multiplier).toBe(1);
        }
        expect(mode.state.score.points).toBe(points);
      }
    }
    expect(crashes).toBeGreaterThan(6);
  });
});
