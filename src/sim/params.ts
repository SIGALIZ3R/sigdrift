import type { CarParams } from '../types';

/**
 * The one car: a light rear-wheel-drive drift coupe. The front axle grips harder than the rear (1.6 against 1.2,
 * and the throttle loosens the rear further), so turning in at speed swings the tail out and the car rotates into
 * the corner instead of washing wide; the lock stays big at speed (0.65 rad falling to 0.5). Tuned by the scripted
 * keyboard drivers in tests/sim/drift.test.ts (feel targets) and tests/sim/handling.test.ts (everything else).
 *
 * `engineForce` is the thrust off the line; how it tapers with speed, and how the throttle loosens the rear tyres,
 * is set by ENGINE in car.ts. Drag and rolling resistance are low on purpose (the car coasts freely): the top
 * speed comes from the rev limit, not from the air.
 */
export const DEFAULT_CAR_PARAMS: CarParams = Object.freeze({
  mass: 1000,
  inertia: 920,
  cgToFront: 1.15,
  cgToRear: 1.25,
  cgHeight: 0.45,
  weightTransfer: 0.5,
  cornerStiffFront: 12,
  cornerStiffRear: 12,
  gripFront: 1.6,
  gripRear: 1.2,
  handbrakeGrip: 0.1,
  powerSlip: 0.38,
  slideGrip: 0.85,
  engineForce: 8900,
  reverseForce: 4000,
  brakeForce: 12000,
  handbrakeForce: 4000,
  drag: 0.72,
  rollingResistance: 5,
  maxSteer: 0.65,
  maxSteerAtSpeed: 0.5,
  steerSpeedRef: 40,
  steerRate: 4.5,
  steerReturnRate: 6,
  yawDamping: 0.3,
  steerAssist: 0,
  collisionRadius: 0.9,
  halfLength: 2.1,
  halfWidth: 0.9,
  restitution: 0.2,
  wallFriction: 0.35,
});

/**
 * `steerAssist` the game applies while the player's steering-assist setting is on (it is 0 while the setting is off).
 *
 * The assist (driftAssist in car.ts) only acts in a slide: it steers the front wheels so the drift angle follows the
 * keys (steer in = more angle, centred = eases off, countersteer = out) and guards against spins. It never takes
 * away a rotation the driver starts. Partial strengths blend it with the raw steering.
 */
export const ASSIST_STRENGTH = 1;

/** A mutable copy, e.g. for the tuning panel. */
export function cloneParams(p: CarParams): CarParams {
  return { ...p };
}
