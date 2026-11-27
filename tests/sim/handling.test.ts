/**
 * How the car feels, held inside the bands the handling is tuned for. The scripted drivers that produce the numbers
 * are in handlingScenarios.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CarParams } from '../../src/types';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { createWorld } from '../../src/sim/world';
import {
  ARENA,
  IDLE,
  SMALL_ARENA,
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
  it('corners without sliding when driven gently', () => {
    const m = measureGripCorner();
    expect(m.maxDrift).toBeLessThan(0.12);
    expect(m.maxRearSlide).toBeLessThan(0.2);
    expect(m.minYaw).toBeGreaterThan(0.2);
    // Steady: the yaw rate settles instead of hunting.
    expect(m.maxYaw - m.minYaw).toBeLessThan(0.25 * m.maxYaw);
  });

  it('wags its tail but does not spin when flicked about at speed', () => {
    const m = measureSlalom();
    expect(m.maxDrift).toBeGreaterThan(0.1);
    expect(m.maxDrift).toBeLessThan(0.5);
    expect(m.speed).toBeGreaterThan(35);
  });

  it.each([20, 23, 26])('stays hooked up through a 90-degree bend taken on the keys from %d m/s with the throttle held', (speed) => {
    // Radius 24 m is more than the tyres can do at this speed: the car must run wide, nose first, not swap ends.
    const assisted = measureBend(true, DEFAULT_CAR_PARAMS, speed);
    expect(assisted.maxDrift).toBeLessThan(0.25);
    expect(assisted.endDrift).toBeLessThan(0.15);
    expect(assisted.widest).toBeGreaterThan(5);
    // It got round and carried on down the road after the bend.
    expect(assisted.along).toBeGreaterThan(110);
    expect(assisted.speed).toBeGreaterThan(speed);
  });

  it.each([20, 23, 26])('does not spin in the same bend from %d m/s with the assist off', (speed) => {
    const unaided = measureBend(false, DEFAULT_CAR_PARAMS, speed);
    expect(unaided.maxDrift).toBeLessThan(0.6);
    expect(unaided.maxYawRate).toBeLessThan(1.5);
    expect(unaided.along).toBeGreaterThan(110);
  });

  it('only eases its line when the throttle is snapped shut mid-corner', () => {
    // Lift-off oversteer is there to be used, but it is mild: a tightening of the line, not a slide.
    for (const assisted of [false, true]) {
      const m = measureLiftOff(DEFAULT_CAR_PARAMS, assisted);
      expect(m.before).toBeLessThan(0.2);
      expect(m.after).toBeLessThan(0.3);
      expect(m.after - m.before).toBeLessThan(0.12);
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

  it('starts with steering and power alone at low speed, progressively', () => {
    const m = measurePowerOver();
    expect(m.maxRearSlide).toBeGreaterThan(0.5);
    expect(m.maxDrift).toBeGreaterThan(0.3);
    // The tail takes its time: nothing much in the first 0.8 s, properly out between 1.2 and 2.5 s.
    expect(m.earlyDrift).toBeLessThan(0.35);
    expect(m.timeToDrift).toBeGreaterThan(1.2);
    expect(m.timeToDrift).toBeLessThan(2.5);
  });

  it.each([14, 15, 17])('powers over from %d m/s as well, just as gradually', (speed) => {
    const m = measurePowerOver(DEFAULT_CAR_PARAMS, speed);
    expect(m.earlyDrift).toBeLessThan(0.35);
    expect(m.timeToDrift).toBeGreaterThan(0.9);
    expect(m.timeToDrift).toBeLessThan(3);
  });

  it.each([0.6, 0.7, 0.9])('can be held with countersteer and throttle (driver aiming for %f rad)', (target) => {
    const m = measureSustainedDrift(target);
    expect(m.longestHold).toBeGreaterThan(3);
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.minSpeed).toBeGreaterThan(9);
  });

  it.each([0.7, 0.75, 0.8])('does not drag: a drift held for 3 s keeps its speed (driver aiming for %f rad)', (target) => {
    const m = measureDriftSpeed(target);
    // The driver settles a little short of what it aims for: these are drifts of 0.5 to 0.7 rad.
    expect(m.meanDrift).toBeGreaterThan(0.5);
    expect(m.meanDrift).toBeLessThan(0.7);
    expect(m.kept).toBeGreaterThan(0.85);
    // Not even the entry, handbrake and all, takes it far below the speed it arrived with.
    expect(m.minKept).toBeGreaterThan(0.8);
  });

  it('recovers when the driver lifts off and centres the wheel', () => {
    const m = measureRecovery();
    expect(m.startDrift).toBeGreaterThan(0.6);
    expect(m.startDrift).toBeLessThan(0.85);
    expect(m.settleTime).toBeLessThan(2);
    expect(m.overshoot).toBeLessThan(0.5 * m.startDrift);
    expect(m.lateDrift).toBeLessThan(0.08);
  });

  it('spins when everything is held at once, then calms down', () => {
    const m = measureSpin();
    expect(m.maxDrift).toBeGreaterThan(1.6);
    expect(m.maxYawRate).toBeLessThan(6);
    expect(m.endYawRate).toBeLessThan(0.5);
    expect(m.endSpeed).toBeLessThan(25);
  });

  it('punishes flooring it in a slide and holding opposite lock too long', () => {
    const m = measureMistakes();
    expect(m.flooredMaxDrift).toBeGreaterThan(1.6);
    expect(m.before).toBeGreaterThan(0.35);
    expect(m.swungTo).toBeGreaterThan(1);
  });

  it('does not spin with full steering assist and no manual countersteer', () => {
    const m = measureAssist();
    expect(m.maxDrift).toBeLessThan(1.6);
    expect(m.maxYawRate).toBeLessThan(6);
  });

  it('is caught by the steering assist when full lock and full throttle are simply held', () => {
    const unaided = measureHeldPowerSlide(0);
    const assisted = measureHeldPowerSlide(ASSIST_STRENGTH);
    expect(unaided.maxDrift).toBeGreaterThan(1.6);
    expect(assisted.maxDrift).toBeGreaterThan(0.3);
    expect(assisted.maxDrift).toBeLessThan(1.2);
    expect(assisted.speed).toBeGreaterThan(20);
  });
});

/**
 * The game ships with the steering assist on, and most players drive it with on/off keys. Everything here runs at
 * ASSIST_STRENGTH, the value the game really applies, with digital inputs only.
 */
describe('keyboard driving with the assist setting on', () => {
  const SPEEDS = [8, 12, 16, 20, 24, 28];

  it('ships the assist at full strength', () => {
    // Anything less leaves the front tyres on their grip peak in a slide: see ASSIST_STRENGTH in src/sim/params.ts.
    expect(ASSIST_STRENGTH).toBe(1);
  });

  it.each(SPEEDS)('does not spin when throttle and full lock are simply held from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 8, () => ({ steer: 1, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.speed).toBeGreaterThan(20);
  });

  it.each(SPEEDS)('straightens up after a corner taken with the throttle held from %d m/s', (speed) => {
    // The novice corner: throttle down throughout, steer for a second and a half, then let go of the steering.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
    expect(m.speed).toBeGreaterThan(25);
  });

  it.each([20, 24, 28])('does not step out at all in that corner from %d m/s', (speed) => {
    // At road speeds power alone no longer breaks the tail loose: it takes the handbrake (or a wall) to start a slide.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(0.25);
    expect(m.drifting).toBe(0);
  });

  it.each(SPEEDS)('catches a handbrake entry from %d m/s with nothing but the throttle', (speed) => {
    const m = measureKeyboard(speed, 5, (time) => (time < 0.3 ? { steer: 1, handbrake: true } : { throttle: 1 }));
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([12, 16, 20, 24])('holds a real drift after a handbrake entry from %d m/s with the keys held', (speed) => {
    // Being catchable must not mean being dull: the same keys still give a long, deep slide.
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

  it.each([25, 30, 35, 40, 44])('keeps its tail in when the brake is brushed with a steering key held from %d m/s', (speed) => {
    // The ordinary way into a corner on a keyboard: turn in, add the brake, then let go of both and floor it.
    // With the weight following the brakes all the way forward this threw the tail out 0.5 to 0.8 rad.
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.5 ? { steer: 1 } : time < 1.2 ? { steer: 1, brake: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(0.4);
    expect(m.endDrift).toBeLessThan(0.05);
    // The same keys with nothing pressed afterwards.
    const coasting = measureKeyboard(speed, 5, (time) => (time < 0.5 ? { steer: 1 } : time < 1.2 ? { steer: 1, brake: 1 } : {}));
    expect(coasting.maxDrift).toBeLessThan(0.4);
  });

  it.each([30, 35, 40, 44])('keeps its tail in when the steering is added to a held brake from %d m/s', (speed) => {
    const m = measureKeyboard(speed, 5, (time) =>
      time < 0.3 ? { brake: 1 } : time < 1 ? { steer: 1, brake: 1 } : { throttle: 1 },
    );
    expect(m.maxDrift).toBeLessThan(0.4);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([16, 20, 24, 28, 32, 36, 40, 44])('still starts a drift by braking into a turn and getting on the power, from %d m/s', (speed) => {
    // Weight transfer is still a way into a slide: keep the key held and feed the power after the brake.
    const best = [0.4, 0.7, 1].map((braking) =>
      measureKeyboard(speed, 5, (time) =>
        time < 0.5 ? { steer: 1 } : time < 0.5 + braking ? { steer: 1, brake: 1 } : { steer: 1, throttle: 1 },
      ),
    );
    expect(best.some((m) => m.maxDrift > 0.5 && m.drifting > 1)).toBe(true);
    for (const m of best) expect(m.maxDrift).toBeLessThan(1.2);
  });

  it.each([12, 16])('still spins the same held corner from %d m/s with the assist off', (speed) => {
    // The assist is what makes the keys forgiving. Without it the slide has to be caught by hand.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }), false);
    expect(m.maxDrift).toBeGreaterThan(1.6);
  });

  it.each([20, 24, 28])('needs no catching in that corner from %d m/s even with the assist off', (speed) => {
    // This used to spin at every speed. Now the car is planted at road speeds until it is provoked.
    const m = measureKeyboard(speed, 6, (time) => ({ steer: time < 1.5 ? 1 : 0, throttle: 1 }), false);
    expect(m.maxDrift).toBeLessThan(0.25);
    expect(m.endDrift).toBeLessThan(0.05);
  });

  it.each([12, 16, 20, 24])('can be saved from %d m/s with the assist off by lifting off in time', (speed) => {
    const m = measureKeyboard(speed, 6, (time) => (time < 1.5 ? { steer: 1, throttle: 1 } : {}), false);
    // Only the slower corners have a slide to save by then.
    if (speed <= 12) expect(m.maxDrift).toBeGreaterThan(0.35);
    expect(m.maxDrift).toBeLessThan(1.2);
    expect(m.endDrift).toBeLessThan(0.05);
  });
});

describe('stability', () => {
  it.each(['chaos-1', 'chaos-2', 'chaos-3', 'chaos-4'])('stays finite and bounded under random inputs (%s)', (seed) => {
    const m = measureRandomDriving(seed);
    expect(m.finite).toBe(true);
    expect(m.maxSpeed).toBeLessThan(60);
    expect(m.maxYawRate).toBeLessThan(8);
    expect(m.maxOutside).toBeLessThan(0);
    // The arena is small enough that a minute of this always finds a wall.
    expect(m.wallHits).toBeGreaterThan(0);
    // A fixed level is flat: the wheels never leave y = 0.
    expect(m.airborne).toBe(false);
  });

  it('stays exactly still at rest', () => {
    const world = rolling(0);
    drive(world, 5, () => IDLE);
    expect(world.car.x).toBe(ARENA.start.x);
    expect(world.car.z).toBe(ARENA.start.z);
    expect(world.car.heading).toBe(ARENA.start.heading);
    expect(world.car.speed).toBe(0);
  });

  it('stays still at rest while the wheel is turned and the handbrake held', () => {
    const world = rolling(0);
    drive(world, 2, () => ({ steer: 1, handbrake: true }));
    expect(world.car.x).toBe(ARENA.start.x);
    expect(world.car.z).toBe(ARENA.start.z);
    expect(world.car.heading).toBe(ARENA.start.heading);
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
    expect(car.yawRate).toBeGreaterThan(0.85 * expected);
    expect(car.yawRate).toBeLessThan(1.1 * expected);
    // No tick-to-tick chatter in the yaw rate.
    expect(roughest).toBeLessThan(0.02);
  });

  it.each([NaN, 0, -1, Infinity])('stays finite when any one tuning value is %f', (bad) => {
    for (const key of Object.keys(DEFAULT_CAR_PARAMS) as (keyof CarParams)[]) {
      const params = cloneParams(DEFAULT_CAR_PARAMS);
      params[key] = bad;
      const world = createWorld(SMALL_ARENA, params);
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
