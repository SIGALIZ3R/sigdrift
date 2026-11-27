import { describe, expect, it } from 'vitest';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import {
  DOWNSHIFT_RPM,
  GEAR_RATIOS,
  IDLE_RPM,
  LIMITER_RPM,
  REDLINE_RPM,
  REVERSE_GEAR,
  SHIFT_TIME,
  TOP_GEAR,
  UPSHIFT_RPM,
  createDriveInput,
  createPowertrain,
  estimateTopSpeed,
  gearSpeedAt,
  readDrive,
  rpmPerSpeed,
  stepPowertrain,
} from '../../src/audio/rpm';
import type { DriveInput, Powertrain } from '../../src/audio/rpm';
import { thrustShare } from '../../src/sim/car';
import type { CarState } from '../../src/types';

const TOP_SPEED = 42.8;
const DT = 1 / 120;

function setup(): { pt: Powertrain; drive: DriveInput } {
  const drive = createDriveInput();
  drive.topSpeed = TOP_SPEED;
  return { pt: createPowertrain(), drive };
}

function setSpeed(drive: DriveInput, speed: number): void {
  drive.forwardSpeed = speed;
  drive.speed = Math.abs(speed);
}

interface Sample {
  t: number;
  speed: number;
  rpm: number;
  gear: number;
  torque: number;
  gate: number;
  limiting: boolean;
}

/** Drive `speedAt(t)` for `seconds`, recording every step. */
function run(
  pt: Powertrain,
  drive: DriveInput,
  seconds: number,
  speedAt: (t: number) => number,
  dt = DT,
): Sample[] {
  const samples: Sample[] = [];
  const steps = Math.round(seconds / dt);
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;
    setSpeed(drive, speedAt(t));
    stepPowertrain(pt, drive, dt);
    samples.push({
      t,
      speed: drive.forwardSpeed,
      rpm: pt.rpm,
      gear: pt.gear,
      torque: pt.torque,
      gate: pt.gate,
      limiting: pt.limiting,
    });
  }
  return samples;
}

/** Speed of a car pulling away at full throttle: quick at first, flattening out at the top speed. */
function accelerating(t: number): number {
  return TOP_SPEED * 0.99 * (1 - 2 ** (-t / 2.6));
}

/** Indices at which the gear differs from the step before. */
function shiftIndices(samples: Sample[]): number[] {
  const indices: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].gear !== samples[i - 1].gear) indices.push(i);
  return indices;
}

/** Bring the powertrain to a steady state in whatever gear suits `speed`. */
function settleAt(pt: Powertrain, drive: DriveInput, speed: number, seconds = 3): void {
  run(pt, drive, seconds, (t) => Math.min(speed, t * 30));
}

describe('gearing', () => {
  it('has six close ratios, each a realistic step from the last', () => {
    expect(GEAR_RATIOS).toHaveLength(6);
    for (let g = 1; g < GEAR_RATIOS.length; g++) {
      const step = GEAR_RATIOS[g - 1] / GEAR_RATIOS[g];
      expect(step).toBeGreaterThan(1.15);
      expect(step).toBeLessThan(1.7);
      // Steps get closer towards the top, as in a real gearbox.
      if (g > 1) expect(step).toBeLessThanOrEqual(GEAR_RATIOS[g - 2] / GEAR_RATIOS[g - 1]);
    }
  });

  it('idles near 900 rpm and redlines near 7500, with the limiter and shift points in order', () => {
    expect(IDLE_RPM).toBe(900);
    expect(REDLINE_RPM).toBe(7500);
    expect(LIMITER_RPM).toBeLessThanOrEqual(REDLINE_RPM);
    expect(UPSHIFT_RPM).toBeLessThan(LIMITER_RPM);
    // Wide enough that the revs after any upshift are still above the downshift point of the new gear.
    for (let g = 1; g <= TOP_GEAR; g++) {
      const afterUpshift = (UPSHIFT_RPM * GEAR_RATIOS[g]) / GEAR_RATIOS[g - 1];
      expect(afterUpshift).toBeGreaterThan(4000);
      expect(DOWNSHIFT_RPM).toBeLessThan(UPSHIFT_RPM * 0.8);
    }
  });

  it('never runs out of revs in top gear at the top speed', () => {
    expect(gearSpeedAt(TOP_GEAR, UPSHIFT_RPM, TOP_SPEED)).toBeGreaterThan(TOP_SPEED);
    expect(TOP_SPEED * rpmPerSpeed(GEAR_RATIOS[TOP_GEAR], TOP_SPEED)).toBeGreaterThan(6000);
  });

  it('estimates the top speed from the physics, within sane limits', () => {
    const top = estimateTopSpeed(DEFAULT_CAR_PARAMS);
    expect(top).toBeGreaterThan(30);
    expect(top).toBeLessThan(60);
    // It really is where the car stops gaining speed: thrust beats resistance just below it and not just above.
    const net = (v: number): number =>
      DEFAULT_CAR_PARAMS.engineForce * thrustShare(v) -
      (DEFAULT_CAR_PARAMS.rollingResistance + DEFAULT_CAR_PARAMS.drag * v) * v;
    expect(net(top - 0.5)).toBeGreaterThan(0);
    expect(net(top + 0.5)).toBeLessThan(0);
    // More power or less drag never lowers it; no engine at all gives the floor.
    expect(estimateTopSpeed({ ...DEFAULT_CAR_PARAMS, engineForce: 0 })).toBe(25);
    expect(estimateTopSpeed({ ...DEFAULT_CAR_PARAMS, engineForce: Number.NaN })).toBe(25);
    const slippery = estimateTopSpeed({ ...DEFAULT_CAR_PARAMS, drag: 0, rollingResistance: 0 });
    expect(slippery).toBeGreaterThanOrEqual(top);
    expect(slippery).toBeLessThanOrEqual(70);
    expect(estimateTopSpeed({ ...DEFAULT_CAR_PARAMS, drag: DEFAULT_CAR_PARAMS.drag * 4 })).toBeLessThan(top);
    // Asking again (as the engine voice does every frame) gives the same answer.
    expect(estimateTopSpeed(DEFAULT_CAR_PARAMS)).toBe(top);
  });

  it('spreads the six gears over the speed the car can actually reach', () => {
    const top = estimateTopSpeed(DEFAULT_CAR_PARAMS);
    // Flat out the car is in top gear, in the upper part of the rev range and short of the limiter.
    expect(gearSpeedAt(TOP_GEAR - 1, UPSHIFT_RPM, top)).toBeLessThan(top);
    const flatOut = top * rpmPerSpeed(GEAR_RATIOS[TOP_GEAR], top);
    expect(flatOut).toBeGreaterThan(6000);
    expect(flatOut).toBeLessThan(LIMITER_RPM);
    // First gear is short: it is done within a second or two of pulling away.
    expect(gearSpeedAt(0, UPSHIFT_RPM, top)).toBeLessThan(top * 0.3);
  });
});

describe('powertrain', () => {
  it('idles in first when standing still', () => {
    const { pt, drive } = setup();
    const samples = run(pt, drive, 1, () => 0);
    const last = samples[samples.length - 1];
    expect(last).toMatchObject({ rpm: IDLE_RPM, gear: 0, torque: 0, gate: 1, limiting: false });
    expect(pt.shifts).toBe(0);
  });

  it('flares the revs off the line, then settles onto the wheels as the clutch bites', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    const samples = run(pt, drive, 1.2, (t) => 7.5 * t);
    // The flare: well above idle within a third of a second, far faster than the wheels alone would manage.
    const early = samples.filter((s) => s.t <= 0.35);
    const flare = Math.max(...early.map((s) => s.rpm));
    const flareAt = early.find((s) => s.rpm === flare)?.t ?? 0;
    expect(flare).toBeGreaterThan(3200);
    expect(flare).toBeLessThan(5200);
    const wheelsAtFlare = 7.5 * flareAt * rpmPerSpeed(GEAR_RATIOS[0], TOP_SPEED);
    expect(flare).toBeGreaterThan(wheelsAtFlare * 2);
    // The settle: revs come back down by a few hundred rpm while the car is still gaining speed...
    const after = samples.filter((s) => s.t > flareAt && s.t <= 0.9);
    const dip = Math.min(...after.map((s) => s.rpm));
    expect(flare - dip).toBeGreaterThan(200);
    expect(flare - dip).toBeLessThan(1500);
    // ...and from then on they are simply the wheels' revs.
    const last = samples[samples.length - 1];
    expect(last.gear).toBe(0);
    expect(last.rpm).toBeCloseTo(last.speed * rpmPerSpeed(GEAR_RATIOS[0], TOP_SPEED), 0);
    expect(last.rpm).toBeGreaterThan(flare);
    expect(pt.clutch).toBe(1);
  });

  it('does not flare without throttle', () => {
    const { pt, drive } = setup();
    const samples = run(pt, drive, 1, (t) => 2 * t);
    for (const s of samples) expect(s.rpm).toBeLessThan(1500);
  });

  it('follows road speed exactly once the clutch has locked: rpm = speed x ratio', () => {
    for (const speed of [12, 20, 27, 34, 41]) {
      const { pt, drive } = setup();
      drive.throttle = 0.6;
      settleAt(pt, drive, speed);
      expect(pt.gear).toBeGreaterThan(0);
      expect(pt.rpm).toBeCloseTo(speed * rpmPerSpeed(GEAR_RATIOS[pt.gear], TOP_SPEED), 3);
      expect(pt.rpm).toBeGreaterThan(DOWNSHIFT_RPM / 1.7);
      expect(pt.rpm).toBeLessThan(UPSHIFT_RPM + 1);
    }
  });

  it('changes up through all six gears near the redline, without ever touching the limiter', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    const samples = run(pt, drive, 20, accelerating);
    const shifts = shiftIndices(samples);
    expect(shifts).toHaveLength(5);
    shifts.forEach((index, n) => {
      expect(samples[index - 1].gear).toBe(n);
      expect(samples[index].gear).toBe(n + 1);
      // Shift point: close to the redline but below the limiter.
      expect(samples[index - 1].rpm).toBeGreaterThan(UPSHIFT_RPM - 150);
      expect(samples[index - 1].rpm).toBeLessThan(LIMITER_RPM);
      // Once the shift is over the revs have dropped by the ratio step.
      const settled = samples.find((s) => s.t > samples[index].t + SHIFT_TIME + 0.02);
      expect(settled).toBeDefined();
      if (!settled) return;
      const expected = settled.speed * rpmPerSpeed(GEAR_RATIOS[n + 1], TOP_SPEED);
      expect(settled.rpm).toBeCloseTo(expected, 0);
      expect(settled.rpm).toBeLessThan(samples[index - 1].rpm * 0.9);
    });
    expect(samples.some((s) => s.limiting)).toBe(false);
    expect(samples[samples.length - 1].gear).toBe(TOP_GEAR);
    expect(pt.shifts).toBe(5);
  });

  it('dips the torque and the level for about 90 ms on each upshift, and lets the revs fall smoothly', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    const samples = run(pt, drive, 6, accelerating);
    const first = shiftIndices(samples)[0];
    let end = first;
    while (samples[end].gate < 1) end++;
    const dip = samples.slice(first, end);
    const duration = dip.length * DT;
    expect(duration).toBeGreaterThan(SHIFT_TIME - 0.02);
    expect(duration).toBeLessThan(SHIFT_TIME + 0.02);
    for (const s of dip.slice(0, Math.floor(SHIFT_TIME / DT) - 1)) {
      expect(s.gate).toBeGreaterThan(0.2);
      expect(s.gate).toBeLessThan(0.7);
      expect(s.torque).toBeLessThan(0.3);
    }
    // The drop is spread over the shift: no single step takes more than a small slice of it.
    const before = samples[first - 1].rpm;
    const after = samples[first + Math.round(SHIFT_TIME / DT) + 1].rpm;
    expect(before - after).toBeGreaterThan(1500);
    for (let i = first; i <= first + Math.round(SHIFT_TIME / DT); i++) {
      const step = samples[i - 1].rpm - samples[i].rpm;
      // (Once the revs have landed on the new gear they start climbing with the car again.)
      expect(step).toBeGreaterThan(-60);
      expect(step).toBeLessThan((before - after) * 0.2);
    }
    // And then full torque is back.
    expect(samples[first + Math.round(0.15 / DT)]).toMatchObject({ torque: 1, gate: 1 });
  });

  it('changes down as the revs fall, one gear at a time when slowing gently', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    run(pt, drive, 20, accelerating);
    expect(pt.gear).toBe(TOP_GEAR);
    drive.throttle = 0;
    const samples = run(pt, drive, 12, (t) => Math.max(0, 42 - 4 * t));
    const shifts = shiftIndices(samples);
    expect(shifts).toHaveLength(5);
    shifts.forEach((index, n) => {
      expect(samples[index].gear).toBe(TOP_GEAR - 1 - n);
      // It changes down when the lower gear would no longer be near its redline.
      const lower = samples[index].speed * rpmPerSpeed(GEAR_RATIOS[samples[index].gear], TOP_SPEED);
      expect(lower).toBeLessThan(DOWNSHIFT_RPM + 1);
      expect(lower).toBeGreaterThan(DOWNSHIFT_RPM - 250);
      // The revs rise into the lower gear.
      const settled = samples[index + Math.round((SHIFT_TIME + 0.02) / DT)];
      expect(settled.rpm).toBeGreaterThan(samples[index - 1].rpm);
    });
    expect(samples[samples.length - 1]).toMatchObject({ gear: 0, rpm: IDLE_RPM });
  });

  it('does not hunt between gears when the speed hovers around a shift point', () => {
    for (let gear = 0; gear < TOP_GEAR; gear++) {
      const { pt, drive } = setup();
      drive.throttle = 1;
      const shiftSpeed = gearSpeedAt(gear, UPSHIFT_RPM, TOP_SPEED);
      settleAt(pt, drive, shiftSpeed * 0.97, 4);
      expect(pt.gear).toBe(gear);
      const before = pt.shifts;
      // +-4 % around the upshift speed, ten times a second, with the throttle pumping as well.
      const samples = run(pt, drive, 5, (t) => {
        drive.throttle = Math.floor(t * 7) % 2;
        return shiftSpeed * (1 + 0.04 * Math.sin(t * 20 * Math.PI));
      });
      expect(pt.shifts - before).toBe(1);
      expect(samples[samples.length - 1].gear).toBe(gear + 1);
    }
  });

  it('holds the gear and bounces off the limiter when the rear wheels spin up in a slide', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    // Near the top of second gear, not yet fast enough to change up.
    const speed = gearSpeedAt(1, UPSHIFT_RPM, TOP_SPEED) * 0.96;
    settleAt(pt, drive, speed);
    expect(pt.gear).toBe(1);
    expect(pt.limiting).toBe(false);
    const gripping = pt.rpm;

    drive.rearSlide = 1;
    drive.speed = speed * 1.2;
    const samples: Sample[] = [];
    for (let i = 0; i < 240; i++) {
      stepPowertrain(pt, drive, DT);
      samples.push({ t: i * DT, speed, rpm: pt.rpm, gear: 1, torque: pt.torque, gate: pt.gate, limiting: pt.limiting });
    }
    const settled = samples.slice(60);
    expect(pt.gear).toBe(1);
    // Wheelspin took the revs up to the limiter...
    expect(Math.max(...settled.map((s) => s.rpm))).toBe(LIMITER_RPM);
    expect(Math.min(...settled.map((s) => s.rpm))).toBeGreaterThan(gripping);
    expect(Math.min(...settled.map((s) => s.rpm))).toBeGreaterThan(LIMITER_RPM - 400);
    // ...where the fuel cut stutters at a rate that is heard as a rattle, not a tone and not a tremolo.
    let cuts = 0;
    for (let i = 1; i < settled.length; i++) if (settled[i].limiting && !settled[i - 1].limiting) cuts++;
    const rate = cuts / (settled.length * DT);
    expect(rate).toBeGreaterThan(8);
    expect(rate).toBeLessThan(25);
    for (const s of settled) {
      if (s.limiting) {
        expect(s.torque).toBe(0);
        expect(s.gate).toBeLessThan(0.6);
        expect(s.gate).toBeGreaterThan(0.2);
      } else {
        expect(s.torque).toBe(1);
        expect(s.gate).toBe(1);
      }
    }
    const cutShare = settled.filter((s) => s.limiting).length / settled.length;
    expect(cutShare).toBeGreaterThan(0.25);
    expect(cutShare).toBeLessThan(0.65);

    // Grip again: straight back to the wheels' revs, limiter off.
    drive.rearSlide = 0;
    drive.speed = speed;
    for (let i = 0; i < 30; i++) stepPowertrain(pt, drive, DT);
    expect(pt.limiting).toBe(false);
    expect(pt.rpm).toBeCloseTo(gripping, 3);
  });

  it('keeps a light slide in the middle of a gear well clear of the limiter', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    settleAt(pt, drive, 20);
    const gripping = pt.rpm;
    drive.rearSlide = 0.5;
    const samples = run(pt, drive, 2, () => 20);
    expect(samples.some((s) => s.limiting)).toBe(false);
    expect(pt.rpm).toBeGreaterThan(gripping);
    expect(pt.rpm).toBeLessThan(gripping + 600);
  });

  it('lets the revs run up freely in the air while the throttle is held, and sink slowly when it is not', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    settleAt(pt, drive, 26);
    const gear = pt.gear;
    const onGround = pt.rpm;
    const shifts = pt.shifts;
    expect(onGround).toBeLessThan(LIMITER_RPM - 1000);

    drive.airborne = true;
    const up = run(pt, drive, 0.12, () => 26);
    for (let i = 1; i < up.length; i++) expect(up[i].rpm).toBeGreaterThanOrEqual(up[i - 1].rpm);
    expect(up[up.length - 1].rpm).toBeGreaterThan(onGround + 500);
    // Held long enough it reaches the limiter, in the same gear: the gearbox waits for the wheels to land.
    const held = run(pt, drive, 1.5, () => 26);
    expect(held.some((s) => s.limiting)).toBe(true);
    expect(Math.max(...held.map((s) => s.rpm))).toBe(LIMITER_RPM);
    expect(pt.gear).toBe(gear);
    expect(pt.shifts).toBe(shifts);

    drive.throttle = 0;
    const down = run(pt, drive, 0.5, () => 26);
    const fallen = down[0].rpm - down[down.length - 1].rpm;
    expect(fallen).toBeGreaterThan(100);
    expect(fallen).toBeLessThan(1200);
    expect(down[down.length - 1].rpm).toBeGreaterThanOrEqual(onGround - 1);

    // Landing: the wheels bite and the revs come back to the road speed within a few hundredths of a second.
    drive.airborne = false;
    run(pt, drive, 0.3, () => 26);
    expect(pt.rpm).toBeCloseTo(26 * rpmPerSpeed(GEAR_RATIOS[pt.gear], TOP_SPEED), 3);
  });

  it('frees the engine from the wheels on the handbrake, without hitting the limiter', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    settleAt(pt, drive, 20);
    const locked = pt.rpm;
    drive.handbrake = true;
    drive.rearSlide = 1;
    const samples = run(pt, drive, 1, () => 20);
    expect(pt.clutch).toBe(0);
    expect(pt.rpm).toBeGreaterThan(locked);
    expect(samples.some((s) => s.limiting)).toBe(false);
    drive.throttle = 0;
    run(pt, drive, 2.5, () => 20);
    expect(pt.rpm).toBe(IDLE_RPM);
    drive.handbrake = false;
    drive.rearSlide = 0;
    run(pt, drive, 0.3, () => 20);
    expect(pt.rpm).toBeCloseTo(locked, 3);
  });

  it('drops straight to first after a sudden stop, with the revs falling instead of jumping', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    run(pt, drive, 20, accelerating);
    expect(pt.gear).toBe(TOP_GEAR);
    const shifts = pt.shifts;
    drive.throttle = 0;
    const samples = run(pt, drive, 2.5, () => 0);
    expect(samples[0].gear).toBe(0);
    expect(pt.shifts).toBe(shifts + 1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].rpm).toBeLessThanOrEqual(samples[i - 1].rpm);
      expect(samples[i - 1].rpm - samples[i].rpm).toBeLessThan(700);
    }
    expect(pt.rpm).toBe(IDLE_RPM);
  });

  it('revs with the pedal in reverse and comes back to first when driving forwards again', () => {
    const { pt, drive } = setup();
    drive.reverse = true;
    drive.throttle = 1;
    const samples = run(pt, drive, 2, (t) => -Math.min(10, 4 * t));
    expect(pt.gear).toBe(REVERSE_GEAR);
    expect(pt.rpm).toBeGreaterThan(4500);
    expect(samples.some((s) => s.limiting)).toBe(false);
    drive.reverse = false;
    run(pt, drive, 0.5, () => -3);
    // Still rolling backwards in a forward gear: the clutch slips, the engine does not turn backwards.
    expect(pt.gear).toBe(0);
    expect(pt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
    expect(pt.rpm).toBeLessThanOrEqual(5200);
  });

  it('gives the same shifts whatever the frame rate', () => {
    const counts: number[] = [];
    const finals: number[] = [];
    for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30]) {
      const { pt, drive } = setup();
      drive.throttle = 1;
      run(pt, drive, 20, accelerating, dt);
      counts.push(pt.shifts);
      finals.push(pt.rpm);
    }
    expect(counts).toEqual([5, 5, 5, 5]);
    for (const rpm of finals) expect(rpm).toBeCloseTo(finals[0], 0);
  });

  it('ignores a zero or negative time step', () => {
    const { pt, drive } = setup();
    drive.throttle = 1;
    setSpeed(drive, 30);
    stepPowertrain(pt, drive, 0);
    stepPowertrain(pt, drive, -1);
    stepPowertrain(pt, drive, Number.NaN);
    expect(pt).toMatchObject({ rpm: IDLE_RPM, gear: 0, shifts: 0 });
  });

  it('stays finite and inside idle..limiter for any input', { timeout: 60_000 }, () => {
    let seed = 0x1234abcd;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const { pt, drive } = setup();
    for (let i = 0; i < 40000; i++) {
      if (i % 37 === 0) {
        drive.forwardSpeed = random() * 90 - 20;
        drive.speed = Math.abs(drive.forwardSpeed) + random() * 20;
        drive.throttle = random() * 1.4 - 0.2;
        drive.rearSlide = random() * 1.4 - 0.2;
        drive.handbrake = random() < 0.2;
        drive.airborne = random() < 0.2;
        drive.reverse = random() < 0.2;
        drive.topSpeed = 25 + random() * 45;
      }
      stepPowertrain(pt, drive, [1 / 240, 1 / 120, 1 / 60, 0.1][i % 4]);
      expect(Number.isFinite(pt.rpm)).toBe(true);
      expect(pt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
      expect(pt.rpm).toBeLessThanOrEqual(LIMITER_RPM);
      expect(pt.torque).toBeGreaterThanOrEqual(0);
      expect(pt.torque).toBeLessThanOrEqual(1);
      expect(pt.gate).toBeGreaterThan(0);
      expect(pt.gate).toBeLessThanOrEqual(1);
      expect(pt.gear).toBeGreaterThanOrEqual(REVERSE_GEAR);
      expect(pt.gear).toBeLessThanOrEqual(TOP_GEAR);
    }
  });
});

describe('readDrive', () => {
  const car = {
    forwardSpeed: 12,
    speed: 13,
    throttle: 0.7,
    brake: 0.2,
    rearSlide: 0.4,
    handbrake: false,
    airborne: false,
    reversing: false,
  } as CarState;

  it('reads the throttle going forwards and the brake pedal in reverse', () => {
    const drive = readDrive(car, DEFAULT_CAR_PARAMS, createDriveInput());
    expect(drive).toMatchObject({ forwardSpeed: 12, speed: 13, throttle: 0.7, rearSlide: 0.4, reverse: false });
    expect(drive.topSpeed).toBe(estimateTopSpeed(DEFAULT_CAR_PARAMS));
    const reversing = readDrive({ ...car, reversing: true, forwardSpeed: -4 }, DEFAULT_CAR_PARAMS, createDriveInput());
    expect(reversing).toMatchObject({ throttle: 0.2, reverse: true, forwardSpeed: -4 });
  });

  it('passes the airborne and handbrake flags on, and survives a car state without them', () => {
    const drive = readDrive({ ...car, airborne: true, handbrake: true }, DEFAULT_CAR_PARAMS, createDriveInput());
    expect(drive).toMatchObject({ airborne: true, handbrake: true });
    const old = { ...car } as Partial<CarState>;
    delete old.airborne;
    expect(readDrive(old as CarState, DEFAULT_CAR_PARAMS, createDriveInput()).airborne).toBe(false);
  });

  it('clamps the pedals and the slide, and reads bad numbers as zero', () => {
    const drive = readDrive(
      { ...car, throttle: 3, rearSlide: -1, forwardSpeed: Number.NaN, speed: Number.POSITIVE_INFINITY },
      DEFAULT_CAR_PARAMS,
      createDriveInput(),
    );
    expect(drive).toMatchObject({ throttle: 1, rearSlide: 0, forwardSpeed: 0, speed: 0 });
  });
});
