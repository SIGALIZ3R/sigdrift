/**
 * The garage cars: each must be drivable by the same scripted keyboard drivers the stock car is tuned against
 * (handlingDrivers.ts), and each must feel different in the way its card says.
 */
import { describe, expect, it } from 'vitest';
import { HALF_PI } from '../../src/core/fixedMath';
import { CARS, DEFAULT_CAR, carsUnlockedBy, getCar, isCarId } from '../../src/sim/cars';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import { generateLevelFor, LEVELS } from '../../src/gen/levels';
import { createBot } from '../../src/modes/bot';
import { COUNTDOWN_TICKS, createRunMode } from '../../src/modes/run';
import { quantizeInput } from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import { ASSIST_STRENGTH, cloneParams } from '../../src/sim/params';
import { SIM_HZ } from '../../src/types';
import {
  CORNER_DRIVER,
  driveCorner,
  measureHandbrakeTap,
  measureLaunchLine,
  measureSustained,
  measureTurnIn,
  variations,
} from './handlingDrivers';

const viper = getCar('viper').params;
const brute = getCar('brute').params;
const ronin = getCar('ronin').params;
const halo = getCar('halo').params;
const kaiju = getCar('kaiju').params;

describe('garage data', () => {
  it('has six cars, the first being the stock car', () => {
    expect(CARS.map((car) => car.id)).toEqual(['phantom', 'viper', 'brute', 'ronin', 'halo', 'kaiju']);
    expect(new Set(CARS.map((car) => car.name)).size).toBe(6);
    expect(CARS[0].params).toBe(DEFAULT_CAR_PARAMS);
    expect(DEFAULT_CAR).toBe('phantom');
  });

  it('unlocks the Viper and Ronin with level 3, the Brute, Halo and Kaiju with level 5', () => {
    expect(CARS.filter((car) => car.unlockLevel === 'L3').map((car) => car.id)).toEqual(['viper', 'ronin']);
    expect(CARS.filter((car) => car.unlockLevel === 'L5').map((car) => car.id)).toEqual(['brute', 'halo', 'kaiju']);
    expect(carsUnlockedBy([])).toEqual(['phantom']);
    expect(carsUnlockedBy(['L1', 'L2'])).toEqual(['phantom']);
    expect(carsUnlockedBy(['L3'])).toEqual(['phantom', 'viper', 'ronin']);
    expect(carsUnlockedBy(['L5'])).toEqual(['phantom', 'brute', 'halo', 'kaiju']);
    expect(carsUnlockedBy(['L1', 'L2', 'L3', 'L4', 'L5'])).toEqual(['phantom', 'viper', 'brute', 'ronin', 'halo', 'kaiju']);
  });

  it('only accepts known ids, and falls back to the stock car', () => {
    expect(isCarId('viper')).toBe(true);
    expect(isCarId('tank')).toBe(false);
    expect(isCarId(3)).toBe(false);
    expect(getCar('tank').id).toBe('phantom');
  });

  it('keeps every car frozen, with steering assist left to the setting', () => {
    for (const car of CARS) {
      expect(Object.isFrozen(car.params)).toBe(true);
      expect(car.params.steerAssist).toBe(0);
      for (const value of Object.values(car.stats)) expect(value).toBeGreaterThanOrEqual(1);
      for (const value of Object.values(car.stats)) expect(value).toBeLessThanOrEqual(5);
    }
  });

  it('gives each car its own handling', () => {
    expect(viper.gripRear).toBeGreaterThan(DEFAULT_CAR_PARAMS.gripRear);
    expect(viper.steerRate).toBeGreaterThan(DEFAULT_CAR_PARAMS.steerRate);
    expect(brute.gripRear).toBeLessThan(DEFAULT_CAR_PARAMS.gripRear);
    expect(brute.powerSlip).toBeGreaterThan(DEFAULT_CAR_PARAMS.powerSlip);
    expect(brute.mass).toBeGreaterThan(DEFAULT_CAR_PARAMS.mass);
  });
});

describe.each(CARS.map((car) => [car.name, car.params] as const))('%s handling', (_name, params) => {
  it('runs straight from rest on full throttle', () => {
    const m = measureLaunchLine(true, params);
    expect(m.maxNose).toBeLessThan(0.05);
    expect(m.timeTo25).toBeLessThan(6);
  });

  it('turns in at speed: the tail swings out and the assist catches it', () => {
    const m = measureTurnIn(25, Infinity, true, params);
    expect(m.timeTo035).toBeLessThanOrEqual(0.9);
    expect(m.peakNose).toBeLessThan(1.25);
    expect(m.endSpeed).toBeGreaterThan(0.75 * 25);
  });

  it('holds a drift for 5 s without spinning', () => {
    const m = measureSustained(20, 0.75, 8, 0.1, true, 0.5, 1.0, params);
    expect(m.spun).toBe(false);
    expect(m.longest).toBeGreaterThanOrEqual(5);
  });

  it('drifts round a 90-degree corner in most of 30 keyboard runs', () => {
    const corner = { approach: 40, radius: 25, turn: HALF_PI, exit: 40 };
    let passed = 0;
    for (const v of variations('garage corner', 30, 24)) {
      const r = driveCorner(corner, v.speed, v.lag, true, CORNER_DRIVER, params);
      if (!r.spun && r.finished && r.maxOff <= 7) passed++;
    }
    expect(passed).toBeGreaterThanOrEqual(24);
  });

  it('lets the level bot finish level 1', () => {
    const level = generateLevelFor(LEVELS[0]);
    const carParams = cloneParams(params);
    carParams.steerAssist = ASSIST_STRENGTH;
    const world = createWorld(level, carParams);
    const run = createRunMode(world);
    const bot = createBot(level);
    const limit = COUNTDOWN_TICKS + 180 * SIM_HZ;
    for (let i = 0; i < limit && run.state.phase !== 'finished'; i++) run.step(quantizeInput(bot(world, run.state)));
    expect(run.state.phase).toBe('finished');
  });
});

describe('the cars differ the way their cards say', () => {
  it('the Brute launches hardest and the Viper beats the Phantom off the line', () => {
    const t = (p: typeof DEFAULT_CAR_PARAMS): number => measureLaunchLine(true, p).timeTo25;
    expect(t(brute)).toBeLessThan(t(DEFAULT_CAR_PARAMS));
    expect(t(viper)).toBeLessThan(t(DEFAULT_CAR_PARAMS));
  });

  it('the Brute slides wider than the Viper in the same held drift', () => {
    const angle = (p: typeof DEFAULT_CAR_PARAMS): number => measureTurnIn(25, Infinity, true, p).peakNose;
    expect(angle(brute)).toBeGreaterThan(angle(viper));
  });

  it('the Halo launches harder than the Phantom and holds the road like the Viper', () => {
    const t = (p: typeof DEFAULT_CAR_PARAMS): number => measureLaunchLine(true, p).timeTo25;
    expect(t(halo)).toBeLessThan(t(DEFAULT_CAR_PARAMS));
    expect(halo.gripRear).toBeGreaterThan(DEFAULT_CAR_PARAMS.gripRear);
  });

  it('the Ronin swings round on a handbrake tap faster than the heavy Kaiju', () => {
    expect(measureHandbrakeTap(25, 0.3, true, ronin).timeTo06).toBeLessThan(measureHandbrakeTap(25, 0.3, true, kaiju).timeTo06);
  });

  it('the Kaiju is the slowest to turn in and the heaviest', () => {
    const turnIn = (p: typeof DEFAULT_CAR_PARAMS): number => measureTurnIn(25, Infinity, true, p).timeTo035;
    expect(turnIn(kaiju)).toBeGreaterThan(turnIn(viper));
    expect(Math.max(...CARS.map((car) => car.params.mass))).toBe(kaiju.mass);
  });
});
