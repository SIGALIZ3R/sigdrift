/**
 * A fixed, planted car for tests of the WORLD (surfaces, slopes, falls, walls, progress tracking), so they do not
 * move whenever the car's handling is retuned. The handling itself is pinned down by tests/sim/handling*.ts against
 * the live DEFAULT_CAR_PARAMS.
 */
import type { CarParams } from '../../src/types';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';

/** The tune the game shipped with before the drift retune: grippy, hard to spin with plain steering. */
export const PLANTED_PARAMS: CarParams = Object.freeze({
  ...DEFAULT_CAR_PARAMS,
  mass: 1000,
  inertia: 1200,
  cgToFront: 1.15,
  cgToRear: 1.25,
  cgHeight: 0.45,
  weightTransfer: 0.5,
  cornerStiffFront: 12,
  cornerStiffRear: 15.7,
  gripFront: 1.24,
  gripRear: 1.48,
  handbrakeGrip: 0.16,
  powerSlip: 0.58,
  slideGrip: 0.78,
  engineForce: 8900,
  reverseForce: 4000,
  brakeForce: 12000,
  handbrakeForce: 4000,
  drag: 0.72,
  rollingResistance: 5,
  maxSteer: 0.6,
  maxSteerAtSpeed: 0.22,
  steerSpeedRef: 35,
  steerRate: 3.65,
  steerReturnRate: 6,
  yawDamping: 0.64,
  steerAssist: 0,
  collisionRadius: 0.9,
  halfLength: 2.1,
  halfWidth: 0.9,
  restitution: 0.2,
  wallFriction: 0.35,
});

/** A mutable copy of PLANTED_PARAMS for one world. */
export function plantedParams(): CarParams {
  return { ...PLANTED_PARAMS };
}
