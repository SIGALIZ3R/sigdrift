import type { CarParams } from '../types';
import { DEFAULT_CAR_PARAMS } from './params';

/**
 * The garage: three cars, each with its own handling. The first is the stock car every record before the garage
 * was set with; the other two unlock by finishing levels (see storage.ts, unlockedCarIds).
 *
 * Only the handling numbers differ. The top speed is the engine's rev limit (ENGINE in car.ts) and is the same for
 * all three, so a car is quicker by how it gets there: launch, grip, and how long it can hold a slide.
 */

export type CarId = 'phantom' | 'viper' | 'brute';

export interface CarDef {
  id: CarId;
  name: string;
  /** One line for the garage card. */
  tagline: string;
  /** The level that has to be finished to drive it, or null for the stock car. */
  unlockLevel: string | null;
  /** 1..5 bars on the garage card: speed off the line, grip, how readily it slides. */
  stats: { launch: number; grip: number; drift: number };
  /** Frozen. `steerAssist` is 0 here; the game sets it from the drift-assist setting. */
  params: Readonly<CarParams>;
}

function tuned(changes: Partial<CarParams>): Readonly<CarParams> {
  return Object.freeze({ ...DEFAULT_CAR_PARAMS, ...changes });
}

export const CARS: readonly CarDef[] = Object.freeze([
  {
    id: 'phantom',
    name: 'Phantom',
    tagline: 'Balanced rear-drive coupe. Turns in, swings out, holds a line.',
    unlockLevel: null,
    stats: { launch: 3, grip: 3, drift: 3 },
    params: DEFAULT_CAR_PARAMS,
  },
  {
    // A light wedge: more grip at both ends and quick steering, so it rotates late and sharp and snaps back
    // straight. Harder to keep sideways, faster through tight sections.
    id: 'viper',
    name: 'Viper',
    tagline: 'Light wedge with sticky tyres. Sharp, fast, short snappy drifts.',
    unlockLevel: 'L3',
    stats: { launch: 4, grip: 5, drift: 2 },
    params: tuned({
      mass: 880,
      inertia: 720,
      cgHeight: 0.38,
      gripFront: 1.8,
      gripRear: 1.42,
      powerSlip: 0.3,
      slideGrip: 0.9,
      engineForce: 9400,
      brakeForce: 13000,
      maxSteer: 0.6,
      maxSteerAtSpeed: 0.46,
      steerRate: 5.6,
      steerReturnRate: 7.5,
      yawDamping: 0.36,
      halfLength: 2.0,
      halfWidth: 0.94,
      cgToFront: 1.1,
      cgToRear: 1.2,
    }),
  },
  {
    // A heavy muscle car: big torque and a loose rear, long lazy slides that need opposite lock early.
    id: 'brute',
    name: 'Brute',
    tagline: 'Heavy muscle car. Huge torque, loose tail, long smoky slides.',
    unlockLevel: 'L5',
    stats: { launch: 5, grip: 2, drift: 5 },
    params: tuned({
      mass: 1250,
      inertia: 1300,
      cgHeight: 0.5,
      gripFront: 1.55,
      gripRear: 1.05,
      powerSlip: 0.48,
      slideGrip: 0.82,
      engineForce: 12600,
      brakeForce: 14000,
      handbrakeForce: 4600,
      maxSteer: 0.7,
      maxSteerAtSpeed: 0.54,
      steerRate: 4,
      steerReturnRate: 5.2,
      yawDamping: 0.26,
      halfLength: 2.3,
      halfWidth: 0.96,
      cgToFront: 1.25,
      cgToRear: 1.35,
      collisionRadius: 0.95,
    }),
  },
] satisfies CarDef[]);

export const DEFAULT_CAR: CarId = 'phantom';

export function isCarId(value: unknown): value is CarId {
  return CARS.some((car) => car.id === value);
}

/** The car with this id, or the stock car. */
export function getCar(id: string): CarDef {
  return CARS.find((car) => car.id === id) ?? CARS[0];
}

/** The cars a player who has finished `completedLevels` may drive, in garage order. */
export function carsUnlockedBy(completedLevels: readonly string[]): CarId[] {
  return CARS.filter((car) => car.unlockLevel === null || completedLevels.includes(car.unlockLevel)).map((car) => car.id);
}
