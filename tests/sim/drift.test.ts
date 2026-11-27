/**
 * The drift feel targets (physics v3), measured with scripted KEYBOARD drivers (steer -1 / 0 / +1, throttle on/off,
 * handbrake on/off) on the bare car on flat ground. The drivers and measurements are in handlingDrivers.ts.
 *
 * What the player asked for: turning in at speed should start a real drift and take the car round in that direction,
 * not slide wide; the handbrake is an entry tool, not a brake; drifts are smooth, controllable and keep their speed
 * (in the spirit of Absolute Drift). The assist (shipped on) helps hold a drift and stops spins without ever
 * cancelling a rotation the driver starts; without it the car is looser but still driftable by a skilled driver.
 */
import { describe, expect, it } from 'vitest';
import { HALF_PI, PI } from '../../src/core/fixedMath';
import { ASSIST_STRENGTH } from '../../src/sim/params';
import {
  CORNER_DRIVER,
  driveCorner,
  measureAllHeld,
  measureCoastLoss,
  measureGentle,
  measureHandbrakeTap,
  measureKeyRelease,
  measureLaunchLine,
  measureRandomKeys,
  measureRecoveryFrom,
  measureSustained,
  measureSwitchback,
  measureTurnIn,
  flat,
  run,
  variations,
} from './handlingDrivers';

const ENTRY_SPEEDS = [18, 25, 32];

describe('(a) turn-in commits', () => {
  it('ships the assist at full strength', () => {
    expect(ASSIST_STRENGTH).toBe(1);
  });

  it.each(ENTRY_SPEEDS)('a 0.4 s stab of steering at %d m/s on the throttle swings the tail out within 0.7 s', (speed) => {
    // The key is released after 0.4 s: the car has committed by then and carries on rotating into the turn.
    const m = measureTurnIn(speed, 0.4);
    expect(m.timeTo035).toBeLessThanOrEqual(0.7);
  });

  it.each(ENTRY_SPEEDS)('holding the key at %d m/s rotates the car into the turn and takes it round', (speed) => {
    const m = measureTurnIn(speed, Infinity);
    expect(m.timeTo035).toBeLessThanOrEqual(0.7);
    expect(m.peakYaw).toBeGreaterThan(1.2);
    // It really goes "more in that direction": the path bends, it does not slide wide in a straight line.
    expect(m.travelDeg12).toBeGreaterThan(25);
    // The REAR lets go, not the front.
    expect(m.meanFront).toBeLessThan(m.meanRear);
    expect(m.frontAtCommit).toBeLessThan(m.rearAtCommit);
    // And it is caught: no spin with the assist on, the speed is kept.
    expect(m.peakNose).toBeLessThan(1.2);
    expect(m.endSpeed).toBeGreaterThan(0.85 * speed);
  });

  it.each(ENTRY_SPEEDS)('commits just the same without the assist at %d m/s (skilled driver catches it)', (speed) => {
    const m = measureTurnIn(speed, Infinity, false, undefined, 0.35);
    expect(m.timeTo035).toBeLessThanOrEqual(0.7);
    expect(m.peakYaw).toBeGreaterThan(1.2);
    expect(m.travelDeg12).toBeGreaterThan(25);
    expect(m.peakNose).toBeLessThan(1.2);
  });
});

describe('(b) a held drift takes real corners', () => {
  const corners = [
    { name: '90 degrees, radius 25 m, entered at 24 m/s', corner: { approach: 40, radius: 25, turn: HALF_PI, exit: 40 }, speed: 24 },
    { name: '180-degree hairpin, radius 24 m, entered at 20 m/s', corner: { approach: 40, radius: 24, turn: PI, exit: 40 }, speed: 20 },
  ];

  it.each(corners)('$name: >= 90% of 50 keyboard runs get round without spinning, on the line, with speed', ({ name, corner, speed }) => {
    let passed = 0;
    let drifted = 0;
    for (const v of variations(name, 50, speed)) {
      const r = driveCorner(corner, v.speed, v.lag, true, CORNER_DRIVER);
      if (r.maxNose > 0.5) drifted++;
      if (!r.spun && r.finished && r.exitSpeed >= 0.7 * v.speed && r.maxOff <= 6) passed++;
    }
    expect(passed).toBeGreaterThanOrEqual(45);
    // ...and it is drifted round, not gripped round.
    expect(drifted).toBeGreaterThanOrEqual(45);
  });
});

describe('(c) drifts are sustainable', () => {
  it.each([16, 20, 25])('a drift from %d m/s is held at 0.5-1.0 rad for 6 s on on/off keys and keeps >= 13 m/s', (speed) => {
    const m = measureSustained(speed, 0.75, 8, 0.1);
    expect(m.spun).toBe(false);
    expect(m.longest).toBeGreaterThanOrEqual(6);
    expect(m.minSpeed).toBeGreaterThanOrEqual(13);
  });

  it('keeps its speed in a held drift on the throttle (within about 2 m/s per second)', () => {
    const m = measureSustained(20, 0.75, 6, 0.1);
    expect(Math.abs(m.endSpeed - 20) / 6).toBeLessThan(2);
  });

  it.each([16, 20, 25])('a skilled driver holds one from %d m/s without the assist as well', (speed) => {
    const m = measureSustained(speed, 0.75, 8, 0.1, false);
    expect(m.spun).toBe(false);
    expect(m.longest).toBeGreaterThanOrEqual(6);
    expect(m.minSpeed).toBeGreaterThanOrEqual(13);
  });
});

describe('(d) the handbrake is an entry tool', () => {
  it.each([25, 30])('a 0.3 s tap with steering at %d m/s swings the car past 0.6 rad within 0.6 s for < 12%% speed', (speed) => {
    const m = measureHandbrakeTap(speed);
    expect(m.timeTo06).toBeLessThanOrEqual(0.6);
    expect(m.speedLoss).toBeLessThan(0.12);
    // After the tap it keeps rotating into the turn: it does not straighten up or just slow down.
    expect(m.minAfter).toBeGreaterThanOrEqual(m.atRelease);
    expect(m.maxAfter).toBeGreaterThan(m.atRelease + 0.4);
    expect(m.peakNose).toBeLessThan(1.2);
  });

  it('works the same without the assist', () => {
    const m = measureHandbrakeTap(25, 0.3, false);
    expect(m.timeTo06).toBeLessThanOrEqual(0.6);
    expect(m.speedLoss).toBeLessThan(0.12);
    expect(m.peakNose).toBeLessThan(1.2);
  });
});

describe('(e) transitions', () => {
  it('a switchback swings into a drift the other way within 1 s without spinning, in >= 90% of 50 runs', () => {
    let passed = 0;
    for (const v of variations('switchback', 50, 22)) {
      const m = measureSwitchback(v.speed, 1.2 + 0.8 * v.extra, v.lag);
      if (m.rightPeak > 0.5 && !m.spun && m.swapTime <= 1.0) passed++;
    }
    expect(passed).toBeGreaterThanOrEqual(45);
  });
});

describe('(f) control and limits', () => {
  it('runs dead straight from rest on full throttle', () => {
    const m = measureLaunchLine();
    expect(m.maxNose).toBeLessThan(0.08);
    expect(m.z).toBeLessThan(0.01);
  });

  it.each([8, 11])('grips under gentle analogue steering at %d m/s', (speed) => {
    const m = measureGentle(speed, 0.3);
    expect(m.maxNose).toBeLessThan(0.1);
    expect(m.maxRear).toBeLessThan(0.3);
    expect(m.minYaw).toBeGreaterThan(0.3);
  });

  it('half steering at 15 m/s on a light throttle is a slight slide at most (< 13 degrees)', () => {
    expect(measureGentle(15, 0.5).maxNose).toBeLessThan(0.23);
  });

  it.each([18, 24])('lifting off and centring recovers from a 0.7 rad drift at %d m/s within 1.5 s, no snap back', (speed) => {
    const m = measureRecoveryFrom(speed);
    expect(m.start).toBeGreaterThan(0.6);
    expect(m.settle).toBeLessThan(1.5);
    expect(m.overshoot).toBeLessThan(0.1);
    expect(m.late).toBeLessThan(0.1);
  });

  it.each([18, 24])('letting go of the steering with the throttle on exits smoothly at %d m/s', (speed) => {
    const m = measureKeyRelease(speed, 1);
    expect(m.start).toBeGreaterThan(0.6);
    expect(m.settle).toBeLessThan(2);
    expect(m.overshoot).toBeLessThan(0.1);
  });

  it('spins when steering, throttle and handbrake are all held for 2 s at 25 m/s, with the yaw bounded', () => {
    const m = measureAllHeld(25);
    expect(m.maxNose).toBeGreaterThan(1.6);
    expect(m.maxYaw).toBeLessThan(6);
    expect(m.endYaw).toBeLessThan(0.5);
  });
});

describe('(g) the assist helps and never fights', () => {
  it.each(ENTRY_SPEEDS)('rotates the car into the turn at least as fast as the bare car does at %d m/s', (speed) => {
    const assisted = measureTurnIn(speed, Infinity, true);
    const bare = measureTurnIn(speed, Infinity, false);
    expect(assisted.timeTo035).toBeLessThanOrEqual(bare.timeTo035 + 0.05);
  });

  it.each([12, 20, 28])('stops full lock and full throttle held at %d m/s turning into a spin (a donut instead)', (speed) => {
    const assisted = flat(speed, true);
    let maxNose = 0;
    run(assisted, 8, () => ({ steer: 1, throttle: 1 }), 0, (car) => {
      maxNose = Math.max(maxNose, Math.abs(car.driftAngle));
    });
    expect(maxNose).toBeLessThan(1.2);
    expect(maxNose).toBeGreaterThan(0.6);
    // The bare car does spin: the assist is what makes the keys forgiving.
    const bare = flat(speed, false);
    let bareNose = 0;
    run(bare, 8, () => ({ steer: 1, throttle: 1 }), 0, (car) => {
      bareNose = Math.max(bareNose, Math.abs(car.driftAngle));
    });
    expect(bareNose).toBeGreaterThan(1.6);
  });
});

describe('(h) launch and coast', () => {
  const m = measureLaunchLine();

  it('reaches 25 m/s in 3.0 to 3.8 s and tops out at 42 to 48 m/s', () => {
    expect(m.timeTo25).toBeGreaterThan(3.0);
    expect(m.timeTo25).toBeLessThan(3.8);
    expect(m.top).toBeGreaterThan(42);
    expect(m.top).toBeLessThan(48);
  });

  it('coasts freely: less than 4 m/s lost from 30 m/s in 3 s', () => {
    expect(measureCoastLoss()).toBeLessThan(4);
  });
});

describe('(i) stability', () => {
  it.each(['keys-1', 'keys-2', 'keys-3'])('a minute of random keys stays finite and bounded (%s)', (seed) => {
    for (const assisted of [true, false]) {
      const m = measureRandomKeys(seed, 60, assisted);
      expect(m.finite).toBe(true);
      expect(m.maxSpeed).toBeLessThan(60);
      expect(m.maxYaw).toBeLessThan(8);
    }
  });

  it('is deterministic', () => {
    expect(measureRandomKeys('same', 30).hash).toBe(measureRandomKeys('same', 30).hash);
  });

  it('reverses on the brake from rest', () => {
    const sim = flat(0);
    run(sim, 3, () => ({ steer: 0, throttle: 0, brake: 1 }));
    expect(sim.car.reversing).toBe(true);
    expect(sim.car.forwardSpeed).toBeLessThan(-2);
  });
});
