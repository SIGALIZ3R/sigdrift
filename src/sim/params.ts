import type { CarParams } from '../types';

/**
 * The one car: a light rear-wheel-drive coupe that is planted until it is provoked. Tuned by the scripted drivers
 * in tests/sim/handling.test.ts; change a value here and those tests say which part of the feel moved.
 *
 * `engineForce` is the thrust off the line; how it tapers with speed, and how the throttle loosens the rear tyres,
 * is set by ENGINE in car.ts. Drag and rolling resistance are low on purpose (the car coasts freely): the top
 * speed comes from the rev limit, not from the air.
 */
export const DEFAULT_CAR_PARAMS: CarParams = Object.freeze({
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

/**
 * `steerAssist` the game applies while the player's steering-assist setting is on (it is 0 while the setting is off).
 *
 * Full strength on purpose. The assist works by pointing the front wheels along their direction of travel; a
 * partial blend leaves them at a slip angle of (1 - assist) x travel angle, which for anything from 0.3 to 0.9
 * parks the front tyres on their grip peak and feeds a spin harder than no assist at all. Only 1 takes the front
 * slip to zero, which is what lets a slide be caught with on/off keys.
 */
export const ASSIST_STRENGTH = 1;

/** A mutable copy, e.g. for the tuning panel. */
export function cloneParams(p: CarParams): CarParams {
  return { ...p };
}
