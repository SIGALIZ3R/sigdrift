/**
 * How the car feels, held inside the bands the handling is tuned for. The scripted drivers that produce the numbers
 * are in handlingScenarios.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CarParams } from '../../src/types';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import {
  IDLE,
  createFlatWorld,
  drive,
  isFiniteState,
  measureAssist,
  measureBend,
  measureCoast,
  measureDriftSpeed,
  measureFlicks,
  measureGripCorner,
  measureHandbrakeEntry,
  measureHeldPowerSlide,
  measureKeyboard,
  measureLaunch,
  measureLiftOff,
  measureMistakes,
  measurePowerOver,
  measureRandomDriving,
  measureRecovery,
  measureSlalom,
  measureSpin,
  measureStraight,
  measureSustainedDrift,
  assistedParams,
  rolling,
} from './handlingScenarios';

describe('straight line', () => {
  const m = measureStraight();

  it('is punchy off the line: 15 m/s in 1.6 to 2.1 s', () => {
    expect(m.timeTo15).toBeGreaterThan(1.6);
    expect(m.timeTo15).toBeLessThan(2.1);
  });

  it('reaches 25 m/s in 3.0 to 3.7 s', () => {
    expect(m.timeTo25).toBeGreaterThan(3.0);
    expect(m.timeTo25).toBeLessThan(3.7);
  });

  it('pulls hardest at low speed and tapers, like a geared engine', () => {
    const accelAt = (speed: number): number => {
      const world = rolling(speed);
      drive(world, 0.5, () => ({ throttle: 1 }));
      return (world.car.speed - speed) / 0.5;
    };
    const [low, mid, high, top] = [5, 20, 32, 44].map(accelAt);
    expect(low).toBeGreaterThan(8);
    expect(low).toBeLessThan(10.5);
    expect(mid).toBeLessThan(0.9 * low);
    expect(mid).toBeGreaterThan(0.55 * low);
    expect(high).toBeLessThan(0.75 * mid);
    expect(high).toBeGreaterThan(2);
    expect(top).toBeLessThan(0.4 * high);
  });

  it('tops out between 42 and 48 m/s', () => {
    expect(m.topSpeed).toBeGreaterThan(42);
    expect(m.topSpeed).toBeLessThan(48);
  });

  it('tracks straight', () => {
    expect(m.headingDrift).toBeLessThan(0.01);
    expect(m.z).toBeLessThan(0.01);
  });

  it.each([false, true])('does not fishtail off the line, even with a dab of steering (assist %s)', (assisted) => {
    const launch = measureLaunch(DEFAULT_CAR_PARAMS, assisted);
    expect(launch.maxDrift).toBeLessThan(0.3);
    expect(launch.maxYawRate).toBeLessThan(1);
    // Two seconds in it is running dead straight again, and it is well on its way.
    expect(launch.lateDrift).toBeLessThan(0.01);
    expect(launch.lateYawRate).toBeLessThan(0.01);
    expect(launch.speed).toBeGreaterThan(25);
  });

  it('coasts freely: lifting off at 30 m/s costs no more than 3.5 m/s in 3 s', () => {
    const coast = measureCoast();
    expect(coast.lost).toBeLessThan(3.5);
    // Free, not frictionless.
    expect(coast.lost).toBeGreaterThan(1.5);
  });
});

describe('grip', () => {
  it.each([false, true])('corners without sliding when driven gently (assist %s)', (assisted) => {
    // A quarter of the lock at 12 m/s on a light throttle: well inside what the tyres can do.
    const m = measureGripCorner(assisted ? assistedParams() : DEFAULT_CAR_PARAMS, 0.25);
    expect(m.maxDrift).toBeLessThan(0.12);
    expect(m.maxRearSlide).toBeLessThan(0.2);
    expect(m.minYaw).toBeGreaterThan(0.2);
    // Steady: the yaw rate settles instead of hunting.
    if (assisted) expect(m.maxYaw - m.minYaw).toBeLessThan(0.25 * m.maxYaw);
  });

  it('wags its tail but does not spin when flicked about at speed', () => {
    // Half lock at 35 m/s is far past the limit: the tail swings out each way, the car does not swap ends.
    const m = measureSlalom();
    expect(m.maxDrift).toBeGreaterThan(0.1);
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.speed).toBeGreaterThan(28);
  });

  it.each([20, 23, 26])('drifts round a 90-degree bend taken on the keys from %d m/s with the throttle held', (speed) => {
    // Radius 24 m is more than the tyres can do at this speed: the tail comes out and the car goes round sideways
    // (it used to run wide nose first). The lazy driver never brakes, so it does run wide; see drift.test.ts (b)
    // for a driver that holds the line.
    const assisted = measureBend(true, DEFAULT_CAR_PARAMS, speed);
    expect(assisted.maxDrift).toBeGreaterThan(0.5);
    expect(assisted.maxDrift).toBeLessThan(1.2);
    // It got round and carried on down the road after the bend, still quick.
    expect(assisted.along).toBeGreaterThan(110);
    expect(assisted.speed).toBeGreaterThan(speed);
  });

  it('loses it in the same bend from 26 m/s with the assist off and nobody catching the slide', () => {
    const unaided = measureBend(false, DEFAULT_CAR_PARAMS, 26);
    expect(unaided.maxDrift).toBeGreaterThan(1.6);
  });

  it('only eases its line when the throttle is snapped shut in a fast grip corner', () => {
    // Steady grip cornering at 24 m/s (a touch of analogue steering), then a lift: a tightening, not a slide.
    for (const assisted of [false, true]) {
      const m = measureLiftOff(DEFAULT_CAR_PARAMS, assisted);
      expect(m.before).toBeLessThan(0.15);
      expect(m.after).toBeLessThan(0.2);
      expect(m.after - m.before).toBeLessThan(0.05);
      expect(m.maxYawRate).toBeLessThan(1.2);
    }
  });
});

describe('drift', () => {
  it('starts with a handbrake tap while turning in', () => {
    const m = measureHandbrakeEntry({ steer: 1, throttle: 0.6 });
    expect(m.peakDrift).toBeGreaterThan(0.45);
    expect(m.peakDrift).toBeLessThan(1.2);
  });

  it('keeps coming round after the tap even with every control released', () => {
    const m = measureHandbrakeEntry({});
    expect(m.peakDrift).toBeGreaterThan(0.45);
    expect(m.peakDrift).toBeLessThan(1.2);
  });

  it.each([14, 15, 16, 17])('steps out promptly with steering and power alone from %d m/s', (speed) => {
    // Full lock and full throttle, no assist: the tail is out within 0.8 s (it used to take 1.2 to 2.5 s), and with
    // nobody catching it the car goes on round.
    const m = measurePowerOver(DEFAULT_CAR_PARAMS, speed);
    expect(m.maxRearSlide).toBeGreaterThan(0.5);
    expect(m.timeToDrift).toBeLessThan(0.8);
    expect(m.earlyDrift).toBeGreaterThan(0.35);
    expect(m.maxDrift).toBeGreaterThan(1.6);
  });

  it.each([0.6, 0.7, 0.9])('can be held on the keys after a handbrake entry (driver aiming for %f rad)', (target) => {
    for (const params of [assistedParams(), DEFAULT_CAR_PARAMS]) {
      const m = measureSustainedDrift(target, 6, params);
      expect(m.longestHold).toBeGreaterThan(5);
      expect(m.maxDrift).toBeLessThan(1.2);
      expect(m.minSpeed).toBeGreaterThan(15);
    }
  });

  it.each([0.6, 0.7, 0.8])('does not drag: a drift held for 3 s keeps its speed (driver aiming for %f rad)', (target) => {
    for (const params of [assistedParams(), DEFAULT_CAR_PARAMS]) {
      const m = measureDriftSpeed(target, params);
      expect(m.meanDrift).toBeGreaterThan(target - 0.1);
      expect(m.meanDrift).toBeLessThan(target + 0.05);
      expect(m.kept).toBeGreaterThan(0.95);
      // Not even the entry, handbrake and all, takes it far below the speed it arrived with.
      expect(m.minKept).toBeGreaterThan(0.8);
    }
  });

  it.each([true, false])('recovers when the driver lifts off and centres the wheel (assist %s)', (assisted) => {
    const m = measureRecovery(assisted ? assistedParams() : DEFAULT_CAR_PARAMS);
    expect(m.startDrift).toBeGreaterThan(0.6);
    expect(m.settleTime).toBeLessThan(1.5);
    expect(m.overshoot).toBeLessThan(0.1);
    expect(m.lateDrift).toBeLessThan(0.08);
  });

  it('spins when everything is held at once, then calms down', () => {
    const m = measureSpin();
    expect(m.maxDrift).toBeGreaterThan(1.6);
    expect(m.maxYawRate).toBeLessThan(6);
    expect(m.endYawRate).toBeLessThan(0.5);
    expect(m.endSpeed).toBeLessThan(25);
  });

  it('punishes flooring it with the key held into the slide, and holding opposite lock too long (assist off)', () => {
    const m = measureMistakes();
    expect(m.flooredMaxDrift).toBeGreaterThan(1.6);
    expect(m.before).toBeGreaterThan(0.35);
    expect(m.swungTo).toBeGreaterThan(1);
  });

  it('does not spin with full steering assist and no manual countersteer', () => {
    const m = measureAssist();
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.maxYawRate).toBeLessThan(6);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it('is caught by the steering assist when full lock and full throttle are simply held', () => {
    const unaided = measureHeldPowerSlide(0);
    const assisted = measureHeldPowerSlide(ASSIST_STRENGTH);
    expect(unaided.maxDrift).toBeGreaterThan(1.6);
    expect(assisted.maxDrift).toBeGreaterThan(0.6);
    expect(assisted.maxDrift).toBeLessThan(1.2);
    expect(assisted.speed).toBeGreaterThan(15);
  });
});

/**
 * The game ships with the steering assist on, and most players drive it with on/off keys. Everything here runs at
 * ASSIST_STRENGTH, the value the game really applies, with digital inputs only.
 *
 * Physics v3 turned this from a planted grip car into a drift car. Tests whose premise was "planted" were replaced:
 * - "does not step out at all in that corner from 20-28 m/s" -> "steps out into a drift in that corner";
 * - "keeps its tail in when the brake is brushed / steering added to a held brake" -> "drifts but does not spin";
 * - "needs no catching in that corner from 20-28 m/s with the assist off" -> "caught by the wheels' caster up to
 *   24 m/s, lost at 28";
 * - "still spins the same held corner from 12/16 m/s with the assist off" -> moved to 28 m/s (the caster now
 *   catches the slower ones).
 */
describe('keyboard driving with the assist setting on', () => {
  const SPEEDS = [8, 12, 16, 20, 24, 28];

  it.each(SPEEDS)('does not spin when throttle and full lock are simply held from %d m/s (a donut)', (speed) => {
    const m = measureKeyboard(speed, 8, () => ({ steer: 1, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.drifting).toBeGreaterThan(6);
    expect(m.speed).toBeGreaterThan(10);
  });

  it.each(SPEEDS)('straightens up after a corner taken with the throttle held from %d m/s', (speed) => {
    // The novice corner: throttle down throughout, steer for a second and a half, then let go of the steering.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
    expect(m.speed).toBeGreaterThan(25);
  });

  it.each([20, 24, 28])('steps out into a drift in that corner from %d m/s', (speed) => {
    // A drift game: at road speed the steering key alone swings the tail out.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }));
    expect(m.maxDrift).toBeGreaterThan(0.6);
    expect(m.drifting).toBeGreaterThan(1);
  });

  it.each(SPEEDS)('catches a handbrake entry from %d m/s with nothing but the throttle', (speed) => {
    const m = measureKeyboard(speed, 5, (time) => (time < 0.3 ? { steer: 1, handbrake: true } : { throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([12, 16, 20, 24])('holds a real drift after a handbrake entry from %d m/s with the keys held', (speed) => {
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.3 ? { steer: 1, handbrake: true } : { steer: 1, throttle: 1 },
    );
    expect(m.maxDrift).toBeGreaterThan(0.6);
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.drifting).toBeGreaterThan(1.5);
  });

  it.each([12, 16, 20, 24])('survives a late, clumsy stab of opposite lock from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 6, (time) =>
      time < 1.5 ? { steer: 1, throttle: 1 } : time < 1.8 ? { steer: -1, throttle: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2])(
    'never spins when the keys are flicked left, right, left at 25 m/s with the throttle pinned (%f s each)',
    (hold) => {
      const m = measureFlicks(hold);
      expect(m.maxDrift).toBeLessThan(1.2);
      expect(m.maxYawRate).toBeLessThan(3);
      expect(m.endDrift).toBeLessThan(0.05);
      expect(m.speed).toBeGreaterThan(30);
    },
  );

  it.each([20, 30, 35])('never spins in the same flicks from %d m/s', (speed) => {
    for (const hold of [0.2, 0.3, 0.45, 0.6, 0.8, 1]) {
      const m = measureFlicks(hold, true, DEFAULT_CAR_PARAMS, speed);
      expect(m.maxDrift).toBeLessThan(1.2);
      expect(m.endDrift).toBeLessThan(0.05);
    }
  });

  it.each([25, 30, 35, 40, 44])('drifts but does not spin when the brake is brushed with a steering key held from %d m/s', (speed) => {
    // The ordinary way into a corner on a keyboard: turn in, add the brake, then let go of both and floor it.
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.5 ? { steer: 1 } : time < 1.2 ? { steer: 1, brake: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
    // The same keys with nothing pressed afterwards.
    const coasting = measureKeyboard(speed, 5, (time) => (time < 0.5 ? { steer: 1 } : time < 1.2 ? { steer: 1, brake: 1 } : {}));
    expect(coasting.maxDrift).toBeLessThan(1.2);
    expect(coasting.endDrift).toBeLessThan(0.05);
  });

  it.each([30, 35, 40, 44])('drifts but does not spin when the steering is added to a held brake from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.3 ? { brake: 1 } : time < 1 ? { steer: 1, brake: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([20, 24, 28, 32, 36, 40, 44])('starts and holds a drift by braking into a turn and getting on the power, from %d m/s', (speed) => {
    const all = [0.4, 0.7, 1].map((braking) =>
      measureKeyboard(speed, 5, (time) =>
        time < 0.5 ? { steer: 1 } : time < 0.5 + braking ? { steer: 1, brake: 1 } : { steer: 1, throttle: 1 },
      ),
    );
    for (const m of all) {
      expect(m.maxDrift).toBeGreaterThan(0.5);
      expect(m.drifting).toBeGreaterThan(1);
      expect(m.maxDrift).toBeLessThan(1.3);
    }
  });

  it('can still be spun by braking to a crawl with full lock held (the assist fades out below walking pace)', () => {
    const m = measureKeyboard(16, 5, (time) =>
      time < 0.5 ? { steer: 1 } : time < 1.5 ? { steer: 1, brake: 1 } : { steer: 1, throttle: 1 },
    );
    expect(m.maxDrift).toBeGreaterThan(1.2);
  });

  it('spins the same held corner from 28 m/s with the assist off', () => {
    // The assist is what makes the keys forgiving at speed. Without it the slide has to be caught by hand.
    const m = measureKeyboard(28, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }), false);
    expect(m.maxDrift).toBeGreaterThan(1.6);
  });

  it.each([8, 12, 16, 20, 24])('is caught by the wheels\' caster in that corner from %d m/s with the assist off', (speed) => {
    // Let go of the key mid-slide and the front wheels point themselves down the road, as a real car's do.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }), false);
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([8, 12, 16, 20, 24])('can be saved from %d m/s with the assist off by lifting off in time', (speed) => {
    const m = measureKeyboard(speed, 6, (time) => (time < 1.5 ? { steer: 1, throttle: 1 } : {}), false);
    expect(m.maxDrift).toBeGreaterThan(0.35);
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.endDrift).toBeLessThan(0.05);
  });
});

describe('stability', () => {
  it.each(['chaos-1', 'chaos-2', 'chaos-3', 'chaos-4'])('stays finite and bounded under random inputs (%s)', (seed) => {
    const m = measureRandomDriving(seed);
    expect(m.finite).toBe(true);
    expect(m.maxSpeed).toBeLessThan(60);
    expect(m.maxYawRate).toBeLessThan(8);
    // Flat ground: the wheels never leave y = 0.
    expect(m.airborne).toBe(false);
  });

  it('stays exactly still at rest', () => {
    const world = rolling(0);
    drive(world, 5, () => IDLE);
    expect(world.car.x).toBe(world.start.x);
    expect(world.car.z).toBe(world.start.z);
    expect(world.car.heading).toBe(world.start.heading);
    expect(world.car.speed).toBe(0);
  });

  it('stays still at rest while the wheel is turned and the handbrake held', () => {
    const world = rolling(0);
    drive(world, 2, () => ({ steer: 1, handbrake: true }));
    expect(world.car.x).toBe(world.start.x);
    expect(world.car.z).toBe(world.start.z);
    expect(world.car.heading).toBe(world.start.heading);
    expect(world.car.steerAngle).toBeCloseTo(DEFAULT_CAR_PARAMS.maxSteer, 9);
  });

  it('coasts to a complete stop', () => {
    const world = rolling(3);
    drive(world, 10, () => IDLE);
    expect(world.car.speed).toBe(0);
    const x = world.car.x;
    drive(world, 1, () => IDLE);
    expect(world.car.x).toBe(x);
  });

  it('comes to a complete stop from a handbrake slide', () => {
    const world = rolling(15);
    drive(world, 5, () => ({ steer: 1, handbrake: true }));
    expect(world.car.speed).toBe(0);
    expect(world.car.yawRate).toBe(0);
    expect(world.car.rearSlide).toBe(0);
  });

  it('brakes to a stop without shaking, then reverses', () => {
    const world = rolling(20);
    let reversedAt = Infinity;
    drive(
      world,
      6,
      () => ({ brake: 1 }),
      (car, time) => {
        if (car.forwardSpeed < -0.1 && time < reversedAt) reversedAt = time;
      },
    );
    expect(reversedAt).toBeGreaterThan(1);
    expect(reversedAt).toBeLessThan(4);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
    expect(world.car.forwardSpeed).toBeGreaterThan(-15);
    expect(Math.abs(world.car.heading)).toBeLessThan(1e-9);
  });

  it('brakes a car that is rolling backwards to a stop, and only then reverses', () => {
    // The aftermath of a spin: rolling backwards with the nose pointing up the road.
    const world = rolling(-12);
    let stoppedAt = Infinity;
    let fastestBackwards = 0;
    drive(
      world,
      2.5,
      () => ({ brake: 1 }),
      (car, time) => {
        fastestBackwards = Math.max(fastestBackwards, -car.forwardSpeed);
        if (car.speed < 0.6 && time < stoppedAt) stoppedAt = time;
      },
    );
    // The pedal never pushes the car further back than it was already going.
    expect(fastestBackwards).toBeLessThanOrEqual(12);
    expect(stoppedAt).toBeLessThan(2);
    expect(world.car.x).toBeGreaterThan(-16);
    drive(world, 3, () => ({ brake: 1 }));
    expect(world.car.reversing).toBe(true);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
  });

  it.each([
    [10, 3, 6],
    [20, 12, 19],
    [30, 25, 36],
    [46, 45, 58],
  ])('stops from %d m/s in %d to %d m', (speed, least, most) => {
    // The weekly levels end in a 60 m run-off, built for a car that crossed the line flat out: 46 m/s is a little
    // more than this car can do. The brakes must not be grabby at town speeds to manage it.
    const world = rolling(speed);
    // Like the roll-out after a finish: the brake until it is nearly stopped, then the handbrake to hold it.
    drive(world, 6, (car) => (Math.abs(car.vx) > 1 ? { brake: 1 } : { handbrake: true }));
    expect(world.car.speed).toBe(0);
    expect(world.car.x).toBeGreaterThan(least);
    expect(world.car.x).toBeLessThan(most);
    expect(Math.abs(world.car.z)).toBeLessThan(1e-6);
  });

  it('brakes just as hard backwards as forwards', () => {
    const stoppingDistance = (speed: number): number => {
      const world = rolling(speed);
      drive(world, 4, (car) => (car.speed > 0.6 ? { brake: 1 } : { handbrake: true }));
      expect(world.car.speed).toBe(0);
      return Math.abs(world.car.x);
    };
    const forwards = stoppingDistance(12);
    const backwards = stoppingDistance(-12);
    expect(backwards).toBeGreaterThan(0.8 * forwards);
    expect(backwards).toBeLessThan(1.25 * forwards);
  });

  it('does not select reverse while the car is still sliding sideways', () => {
    const world = rolling(0);
    world.car.vz = 15;
    let reversedWhileSliding = false;
    drive(
      world,
      6,
      () => ({ brake: 1 }),
      (car) => {
        if (car.reversing && car.speed > 1.5 && car.forwardSpeed > -0.5) reversedWhileSliding = true;
      },
    );
    expect(reversedWhileSliding).toBe(false);
    // Once it has stopped, the held pedal backs it up as usual.
    expect(world.car.reversing).toBe(true);
    expect(world.car.forwardSpeed).toBeLessThan(-2);
  });

  it('keeps reverse selected while the pedal is feathered, and drops it for the throttle', () => {
    const world = rolling(0);
    drive(world, 2, () => ({ brake: 1 }));
    const backing = world.car.forwardSpeed;
    expect(backing).toBeLessThan(-3);
    drive(world, 0.3, () => IDLE);
    expect(world.car.reversing).toBe(true);
    // Pressing again drives on backwards rather than slamming the brakes on.
    drive(world, 0.5, () => ({ brake: 1 }));
    expect(world.car.forwardSpeed).toBeLessThan(backing);
    drive(world, 0.1, () => ({ throttle: 1 }));
    expect(world.car.reversing).toBe(false);
    // Out of reverse and still rolling back, the pedal is a brake again.
    world.car.vx = -8;
    world.car.vz = 0;
    drive(world, 0.2, () => ({ brake: 1 }));
    expect(world.car.forwardSpeed).toBeGreaterThan(-7);
    expect(world.car.reversing).toBe(false);
  });

  it('steers the expected way in reverse', () => {
    const world = rolling(0);
    drive(world, 3, () => ({ brake: 0.6, steer: 1 }));
    // Backing up with the wheels turned right swings the tail right, so the nose turns left.
    expect(world.car.forwardSpeed).toBeLessThan(-1);
    expect(world.car.heading).toBeLessThan(-0.3);
    expect(world.car.z).toBeGreaterThan(0.5);
    expect(world.car.x).toBeLessThan(0);
  });

  it('follows the wheels at walking pace', () => {
    const world = rolling(0);
    let roughest = 0;
    let previousYaw = 0;
    drive(
      world,
      4,
      () => ({ throttle: 0.2, steer: 1 }),
      (car) => {
        roughest = Math.max(roughest, Math.abs(car.yawRate - previousYaw));
        previousYaw = car.yawRate;
      },
    );
    const car = world.car;
    const wheelbase = DEFAULT_CAR_PARAMS.cgToFront + DEFAULT_CAR_PARAMS.cgToRear;
    // Kinematic turn: yaw rate = speed * tan(steer) / wheelbase, within a few percent while the tyres grip.
    const expected = (car.forwardSpeed * Math.tan(car.steerAngle)) / wheelbase;
    expect(car.forwardSpeed).toBeGreaterThan(0.5);
    expect(car.forwardSpeed).toBeLessThan(5);
    expect(car.yawRate).toBeGreaterThan(0.8 * expected);
    expect(car.yawRate).toBeLessThan(1.1 * expected);
    // No tick-to-tick chatter in the yaw rate.
    expect(roughest).toBeLessThan(0.02);
  });

  it.each([NaN, 0, -1, Infinity])('stays finite when any one tuning value is %f', (bad) => {
    for (const key of Object.keys(DEFAULT_CAR_PARAMS) as (keyof CarParams)[]) {
      const params = cloneParams(DEFAULT_CAR_PARAMS);
      params[key] = bad;
      const world = createFlatWorld(params);
      world.car.vx = 15;
      let finite = true;
      drive(
        world,
        3,
        (_car, time) => ({ steer: time < 1.5 ? 1 : -1, throttle: 1, brake: time > 2.5 ? 1 : 0, handbrake: time > 2 }),
        (car) => {
          finite = finite && isFiniteState(car);
        },
      );
      expect(finite, key).toBe(true);
    }
  });

  it('ignores garbage input', () => {
    const world = rolling(10);
    drive(world, 1, () => ({ steer: NaN, throttle: Infinity, brake: -Infinity }));
    expect(isFiniteState(world.car)).toBe(true);
    expect(world.car.steerAngle).toBe(0);
    expect(world.car.throttle).toBe(1);
    expect(world.car.brake).toBe(0);
  });
});
