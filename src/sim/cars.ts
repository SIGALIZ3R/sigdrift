import type { CarParams } from '../types';
import { DEFAULT_CAR_PARAMS } from './params';

/**
 * The garage: six cars, each with its own handling (and, in render/carStyles.ts and audio/engineSounds.ts, its own
 * look and engine). The first is the stock car every record before the garage was set with; finishing level 3
 * unlocks the Viper and the Ronin, finishing level 5 the Brute, the Halo and the Kaiju (storage.ts, unlockedCarIds).
 *
 * Only the handling numbers differ. The top speed is the engine's rev limit (ENGINE in car.ts) and is the same for
 * every car, so a car is quicker by how it gets there: launch, grip, and how long it can hold a slide.
 */

export type CarId = 'phantom' | 'viper' | 'brute' | 'ronin' | 'halo' | 'kaiju';

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
  {
    // A short rally hatch: tiny wheelbase and a handbrake that bites, so it flicks into slides and out again.
    id: 'ronin',
    name: 'Ronin',
    tagline: 'Short rally hatch. Flicks sideways on a handbrake tap, buzzes like a hornet.',
    unlockLevel: 'L3',
    stats: { launch: 3, grip: 4, drift: 4 },
    params: tuned({
      mass: 940,
      inertia: 690,
      cgHeight: 0.5,
      gripFront: 1.7,
      gripRear: 1.24,
      handbrakeGrip: 0.08,
      handbrakeForce: 3600,
      powerSlip: 0.42,
      slideGrip: 0.88,
      engineForce: 9100,
      maxSteer: 0.7,
      maxSteerAtSpeed: 0.55,
      steerRate: 5.2,
      steerReturnRate: 6.6,
      yawDamping: 0.28,
      halfLength: 1.85,
      halfWidth: 0.86,
      cgToFront: 1.02,
      cgToRear: 1.1,
      collisionRadius: 0.85,
    }),
  },
  {
    // An electric hypercar: instant torque, a low battery-pack centre of gravity, planted and precise.
    id: 'halo',
    name: 'Halo',
    tagline: 'Silent electric hypercar. Instant torque, planted and precise. Just a rising whine.',
    unlockLevel: 'L5',
    stats: { launch: 5, grip: 4, drift: 2 },
    params: tuned({
      mass: 1150,
      inertia: 1000,
      cgHeight: 0.34,
      weightTransfer: 0.42,
      gripFront: 1.72,
      gripRear: 1.34,
      powerSlip: 0.33,
      slideGrip: 0.9,
      engineForce: 11800,
      brakeForce: 14000,
      maxSteer: 0.62,
      maxSteerAtSpeed: 0.48,
      steerRate: 4.8,
      steerReturnRate: 6.5,
      yawDamping: 0.34,
      halfLength: 2.15,
      halfWidth: 0.95,
      cgToFront: 1.2,
      cgToRear: 1.28,
    }),
  },
  {
    // An armoured hauler: huge, slow to turn, but once its weight swings round it slides forever.
    id: 'kaiju',
    name: 'Kaiju',
    tagline: 'Armoured street hauler. Slow to turn in, then the weight swings and it slides forever.',
    unlockLevel: 'L5',
    stats: { launch: 3, grip: 2, drift: 4 },
    params: tuned({
      mass: 1500,
      inertia: 1700,
      cgHeight: 0.6,
      weightTransfer: 0.55,
      gripFront: 1.5,
      gripRear: 1.1,
      powerSlip: 0.44,
      slideGrip: 0.8,
      engineForce: 14500,
      brakeForce: 15500,
      handbrakeForce: 5200,
      maxSteer: 0.68,
      maxSteerAtSpeed: 0.5,
      steerRate: 3.6,
      steerReturnRate: 4.8,
      yawDamping: 0.24,
      halfLength: 2.45,
      halfWidth: 1.0,
      cgToFront: 1.35,
      cgToRear: 1.45,
      collisionRadius: 1.0,
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
