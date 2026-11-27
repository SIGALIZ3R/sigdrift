/**
 * The car: a bicycle model (one front and one rear tyre) integrated in the car's own frame.
 *
 * Car frame: forward = (cos h, sin h), right = (-sin h, cos h). Positive yaw rate, steer angle, lateral speed and
 * drift angle all mean "to the right". `stepCar` knows nothing about walls; see collision.ts.
 */
import type { CarParams, CarState, InputState, Pose } from '../types';
import { HALF_PI, PI, atan2, clamp, cos, lerp, moveTowards, sin, smoothstep, wrapAngle } from '../core/fixedMath';
import { PEAK_SLIP_RATIO, lateralForceCoefficient } from './tire';

const GRAVITY = 9.81;

/** Hard limits that no sane tune reaches. They only keep a broken tune or a freak collision finite. */
export const MAX_SPEED = 80;
export const MAX_YAW_RATE = 7;

/** With no pedal pressed, a car slower than this is put to rest so it cannot creep forever. */
const REST_SPEED = 0.3;
const REST_YAW_RATE = 0.3;

/** The brake pedal turns into reverse below this forward speed. */
const REVERSE_ENGAGE_SPEED = 0.5;
const REVERSE_TOP_SPEED = 11;

const DRIFT_ANGLE_MIN_SPEED = 1;

/** Off the throttle the engine drags on the driven wheels with this share of its full force. */
const ENGINE_BRAKING = 0.12;

/** Weight transfer follows acceleration with this rate (1/s): the body takes a moment to pitch. */
const LOAD_RESPONSE = 12;

/** Travel-direction steering help (countersteer lock, assist) fades in over this speed range. */
const TRAVEL_FADE_START = 2;
const TRAVEL_FADE_END = 5;

/** Slide indicators fade in over this speed range so a parked or crawling car never reports a slide. */
const SLIDE_FADE_START = 0.5;
const SLIDE_FADE_END = 3;

/** Normalised slip (see tire.ts) at which a tyre starts and finishes counting as sliding. */
const SLIDE_START = 0.8 * PEAK_SLIP_RATIO;
const SLIDE_FULL = 1.6 * PEAK_SLIP_RATIO;

export function resetCarState(car: CarState, pose: Pose): void {
  car.x = pose.x;
  car.z = pose.z;
  car.heading = pose.heading;
  car.vx = 0;
  car.vz = 0;
  car.yawRate = 0;
  car.steerAngle = 0;
  car.speed = 0;
  car.forwardSpeed = 0;
  car.lateralSpeed = 0;
  car.driftAngle = 0;
  car.slipFront = 0;
  car.slipRear = 0;
  car.rearSlide = 0;
  car.frontSlide = 0;
  car.accelLong = 0;
  car.throttle = 0;
  car.brake = 0;
  car.handbrake = false;
}

export function createCarState(pose: Pose): CarState {
  const car = {} as CarState;
  resetCarState(car, pose);
  return car;
}

/** Recomputes the fields that follow from pose and velocity alone. Call after changing either from outside. */
export function updateKinematics(car: CarState): void {
  const cosH = cos(car.heading);
  const sinH = sin(car.heading);
  const forward = car.vx * cosH + car.vz * sinH;
  const lateral = car.vz * cosH - car.vx * sinH;
  const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz);
  car.forwardSpeed = forward;
  car.lateralSpeed = lateral;
  car.speed = speed;
  car.driftAngle = speed > DRIFT_ANGLE_MIN_SPEED ? atan2(lateral, forward) : 0;
}

function pedal(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

function steerInput(value: number): number {
  return value >= -1 && value <= 1 ? value : value > 1 ? 1 : value < -1 ? -1 : 0;
}

/** Limits `value` to ±limit. Not-a-number becomes 0, so one bad tuning value cannot poison the state. */
function limitMagnitude(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value === value ? value : 0;
}

/**
 * Turns the front wheels towards the requested angle.
 *
 * The speed-reduced lock is widened on the countersteer side by the car's drift angle: catching a slide needs far
 * more lock than cornering does.
 *
 * The assist, while the rear slides, adds the front axle's direction of travel to the request, so a centred stick
 * points the wheels where the car is going and the rear tyres pull it straight. It also takes authority away from
 * steering into the slide as the drift angle nears full lock, which is the angle past which no countersteer could
 * save it.
 */
function updateSteering(
  car: CarState,
  params: CarParams,
  steer: number,
  forward: number,
  lateral: number,
  speed: number,
  dt: number,
): void {
  const maxSteer = params.maxSteer;
  const speedShare = params.steerSpeedRef > 0 ? clamp(speed / params.steerSpeedRef, 0, 1) : 1;
  const lock = lerp(maxSteer, params.maxSteerAtSpeed, speedShare);
  const fade = forward > 0 ? smoothstep(TRAVEL_FADE_START, TRAVEL_FADE_END, speed) : 0;
  let target = steer * lock;
  if (fade > 0) {
    const travel = atan2(lateral, forward) * fade;
    const depth = Math.abs(travel);
    if (steer * travel > 0) target = steer * Math.min(maxSteer, lock + depth);
    const assist = params.steerAssist * car.rearSlide * fade;
    if (assist > 0) {
      if (steer * travel < 0) target *= 1 - assist * (depth < maxSteer ? depth / maxSteer : 1);
      target += assist * atan2(lateral + car.yawRate * params.cgToFront, forward);
    }
  }
  target = limitMagnitude(target, maxSteer);

  const angle = car.steerAngle;
  const returning = angle * target < 0 || Math.abs(target) < Math.abs(angle);
  const rate = returning ? params.steerReturnRate : params.steerRate;
  car.steerAngle = limitMagnitude(moveTowards(angle, target, rate * dt), HALF_PI);
}

/**
 * Share (0..1) of the engine's force that is left over to spin the rear wheels. Near top speed the engine is busy
 * fighting drag, so full throttle no longer loosens the rear the way it does in the mid range.
 */
function wheelspin(params: CarParams, throttle: number, forward: number): number {
  if (!(params.engineForce > 0)) return 0;
  const absForward = Math.abs(forward);
  const resistance = (params.rollingResistance + params.drag * absForward) * absForward;
  return throttle * clamp(1 - resistance / params.engineForce, 0, 1);
}

/** Engine, engine braking, brakes, reverse, rolling resistance and drag, along the car's nose. */
function longitudinalForce(
  params: CarParams,
  throttle: number,
  brake: number,
  handbrake: boolean,
  forward: number,
  dt: number,
): number {
  const absForward = Math.abs(forward);
  let force = params.engineForce * throttle - (params.rollingResistance + params.drag * absForward) * forward;
  let braking = params.engineForce * ENGINE_BRAKING * (1 - throttle);
  if (handbrake) braking += params.handbrakeForce;
  if (brake > 0) {
    if (forward > REVERSE_ENGAGE_SPEED) braking += params.brakeForce * brake;
    else force -= params.reverseForce * brake * clamp(1 + forward / REVERSE_TOP_SPEED, 0, 1);
  }
  // Brakes can stop the wheels within the tick but never push the car the other way.
  const stopping = (params.mass * absForward) / dt;
  if (braking > stopping) braking = stopping;
  return forward < 0 ? force + braking : force - braking;
}

/** 0..1: how far past its peak a tyre is. */
function slideAmount(slip: number, stiffness: number, grip: number): number {
  const ratio = (Math.abs(slip) * stiffness) / grip;
  return ratio >= SLIDE_FULL ? 1 : ratio > SLIDE_START ? smoothstep(SLIDE_START, SLIDE_FULL, ratio) : 0;
}

/** Load on the front axle, with last tick's acceleration shifting weight between the axles. */
function frontAxleLoad(car: CarState, params: CarParams): number {
  const wheelbase = params.cgToFront + params.cgToRear;
  const transfer = (params.weightTransfer * car.accelLong * params.cgHeight) / wheelbase;
  return clamp(params.mass * ((GRAVITY * params.cgToRear) / wheelbase - transfer), 0, params.mass * GRAVITY);
}

/**
 * Sideways force of one axle, in the direction its tyres point their right side.
 *
 * `sideSpeed` is how fast the tyre is moving sideways and `arm` its distance from the centre of mass. A tyre can
 * at most stop its own sideways motion within one tick: without that cap the stiff tyre forces overshoot at low
 * speed and the car shakes; with it they behave like static friction, so they need no fading out near standstill.
 */
function axleForce(
  params: CarParams,
  load: number,
  slip: number,
  stiffness: number,
  grip: number,
  sideSpeed: number,
  arm: number,
  dt: number,
): number {
  const stopping = Math.abs(sideSpeed) / (dt * (1 / params.mass + (arm * arm) / params.inertia));
  return -limitMagnitude(load * lateralForceCoefficient(slip, stiffness, grip, params.slideGrip), stopping);
}

/**
 * Stops creep at rest (when `coasting`) and keeps a broken tune finite. Runs on velocities, before they move the car.
 */
export function settleVelocity(car: CarState, coasting: boolean): void {
  const speedSq = car.vx * car.vx + car.vz * car.vz;
  const finite = speedSq < Infinity && car.yawRate === car.yawRate && car.accelLong === car.accelLong;
  const resting = coasting && speedSq < REST_SPEED * REST_SPEED && Math.abs(car.yawRate) < REST_YAW_RATE;
  if (!finite || resting) {
    car.vx = 0;
    car.vz = 0;
    car.yawRate = 0;
    car.accelLong = 0;
  } else if (speedSq > MAX_SPEED * MAX_SPEED) {
    const scale = MAX_SPEED / Math.sqrt(speedSq);
    car.vx *= scale;
    car.vz *= scale;
  }
}

/** Advances the car by `dt` on an empty plane. */
export function stepCar(car: CarState, params: CarParams, input: InputState, dt: number): void {
  const throttle = pedal(input.throttle);
  const brake = pedal(input.brake);
  const handbrake = input.handbrake === true;

  const cosH = cos(car.heading);
  const sinH = sin(car.heading);
  const forward = car.vx * cosH + car.vz * sinH;
  const lateral = car.vz * cosH - car.vx * sinH;
  const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz);

  updateSteering(car, params, steerInput(input.steer), forward, lateral, speed, dt);
  const steerAngle = car.steerAngle;
  const cosS = cos(steerAngle);
  const sinS = sin(steerAngle);

  const toFront = params.cgToFront;
  const toRear = params.cgToRear;
  const absForward = Math.abs(forward);
  const lateralFront = lateral + car.yawRate * toFront;
  const lateralRear = lateral - car.yawRate * toRear;
  // Rolling backwards, the same wheel angle turns the tyre the other way relative to its direction of travel.
  const slipFront = atan2(lateralFront, absForward) - (forward < 0 ? -steerAngle : steerAngle);
  const slipRear = atan2(lateralRear, absForward);
  const gripFront = params.gripFront;
  const powerGrip = 1 - params.powerSlip * wheelspin(params, throttle, forward);
  const gripRear = params.gripRear * (handbrake ? params.handbrakeGrip : 1) * powerGrip;

  const loadFront = frontAxleLoad(car, params);
  const loadRear = params.mass * GRAVITY - loadFront;
  const wheelSideSpeed = lateralFront * cosS - forward * sinS;
  const stiffFront = params.cornerStiffFront;
  const stiffRear = params.cornerStiffRear;
  const forceFront = axleForce(params, loadFront, slipFront, stiffFront, gripFront, wheelSideSpeed, toFront, dt);
  const forceRear = axleForce(params, loadRear, slipRear, stiffRear, gripRear, lateralRear, toRear, dt);

  // The front tyres push at right angles to the steered wheels, so part of their force slows the car.
  const forceLong = longitudinalForce(params, throttle, brake, handbrake, forward, dt) - forceFront * sinS;
  const forceLat = forceFront * cosS + forceRear;
  const yawAccel = (toFront * forceFront * cosS - toRear * forceRear) / params.inertia;
  const dtOverMass = dt / params.mass;

  car.vx += (forceLong * cosH - forceLat * sinH) * dtOverMass;
  car.vz += (forceLong * sinH + forceLat * cosH) * dtOverMass;
  car.yawRate = limitMagnitude((car.yawRate + yawAccel * dt) / (1 + params.yawDamping * dt), MAX_YAW_RATE);
  car.accelLong += (forceLong / params.mass - car.accelLong) * Math.min(1, LOAD_RESPONSE * dt);
  settleVelocity(car, throttle === 0 && brake === 0);

  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.heading = wrapAngle(car.heading + car.yawRate * dt);

  updateKinematics(car);
  const slideFade = smoothstep(SLIDE_FADE_START, SLIDE_FADE_END, car.speed);
  car.slipFront = limitMagnitude(slipFront, PI);
  car.slipRear = limitMagnitude(slipRear, PI);
  // Locked rear wheels are sliding whatever their slip angle says.
  car.rearSlide = slideFade * (handbrake ? 1 : slideAmount(slipRear, stiffRear, gripRear));
  car.frontSlide = slideFade * slideAmount(slipFront, stiffFront, gripFront);
  car.throttle = throttle;
  car.brake = brake;
  car.handbrake = handbrake;
}
