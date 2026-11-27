import type { CarParams } from '../types';

/**
 * The one car: a light, loose, rear-wheel-drive coupe. Tuned by the scripted drivers in tests/sim/handling.test.ts;
 * change a value here and those tests say which part of the feel moved.
 */
export const DEFAULT_CAR_PARAMS: CarParams = Object.freeze({
  mass: 1000,
  inertia: 1200,
  cgToFront: 1.15,
  cgToRear: 1.25,
  cgHeight: 0.45,
  weightTransfer: 0.5,
  cornerStiffFront: 11,
  cornerStiffRear: 12,
  gripFront: 1.25,
  gripRear: 1.45,
  handbrakeGrip: 0.3,
  powerSlip: 0.55,
  slideGrip: 0.8,
  engineForce: 7500,
  reverseForce: 4000,
  brakeForce: 11000,
  handbrakeForce: 4000,
  drag: 3.4,
  rollingResistance: 30,
  maxSteer: 0.6,
  maxSteerAtSpeed: 0.22,
  steerSpeedRef: 35,
  steerRate: 3.5,
  steerReturnRate: 6,
  yawDamping: 0.5,
  steerAssist: 0,
  collisionRadius: 0.9,
  halfLength: 2.1,
  halfWidth: 0.9,
  restitution: 0.2,
  wallFriction: 0.35,
});

/** A mutable copy, e.g. for the tuning panel. */
export function cloneParams(p: CarParams): CarParams {
  return { ...p };
}
