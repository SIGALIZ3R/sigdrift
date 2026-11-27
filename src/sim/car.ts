/**
 * The car: a bicycle model (one front and one rear tyre) integrated in the car's own frame.
 *
 * Car frame: forward = (cos h, sin h), right = (-sin h, cos h). Positive yaw rate, steer angle, lateral speed and
 * drift angle all mean "to the right". `stepCar` knows nothing about walls; see collision.ts.
 */
import type { CarParams, CarState, InputState, Pose } from '../types';
import { HALF_PI, PI, atan2, clamp, cos, lerp, moveTowards, sin, smoothstep, wrapAngle } from '../core/fixedMath';
import { PEAK_SLIP_RATIO, lateralForceCoefficient } from './tire';

export const GRAVITY = 9.81;

/** Hard limits that no sane tune reaches. They only keep a broken tune or a freak collision finite. */
export const MAX_SPEED = 80;
export const MAX_YAW_RATE = 7;

/** With no pedal pressed, a car slower than this is put to rest so it cannot creep forever. */
const REST_SPEED = 0.3;
const REST_YAW_RATE = 0.3;

/**
 * The brake pedal selects reverse once the car is this slow along its nose and this slow overall. The second limit
 * keeps a car that is sliding sideways (no forward speed, plenty of speed) on its brakes.
 */
const REVERSE_ENGAGE_SPEED = 0.5;
const REVERSE_SELECT_SPEED = 1;
const REVERSE_TOP_SPEED = 11;

const DRIFT_ANGLE_MIN_SPEED = 1;

/**
 * The engine and its gearing, as shares of `params.engineForce` (the thrust off the line).
 *
 * Up to `peakSpeed` the tyres are the limit and the thrust is flat. Above it the engine is giving all the power
 * it has, so thrust falls as 1 / speed. From `redlineStart` the top gear runs out of revs and the thrust fades to
 * nothing at `redlineEnd`: that, not drag, is what sets the top speed, which lets the drag be low enough for the
 * car to coast freely.
 *
 * `braking` is the engine's drag on the driven wheels off the throttle, as a share of the launch thrust.
 *
 * `spinCurve` and `spinHold` shape how the throttle loosens the rear tyres (see `wheelspin`): a tyre that still
 * grips gives up cornering grip faster than in proportion to how hard it is driven (0 = in proportion, 1 = with
 * the square, like a friction circle), and a tyre that has already let go is kept spinning by the throttle even
 * where the thrust alone could no longer break it loose (0 = not at all, 1 = at any speed).
 */
export const ENGINE = Object.freeze({
  peakSpeed: 16.4,
  redlineStart: 40.5,
  redlineEnd: 50,
  braking: 0.03,
  spinCurve: 0.32,
  spinHold: 0.32,
});

/**
 * Steering and drift-assist feel that is not in CarParams.
 * - `rateAtSpeed`: share of `steerRate` left at `steerSpeedRef` and above when turning in. Countersteer, and
 *   winding lock off, are never slowed.
 * - `counterLock`: opposite lock (rad) the wheels may reach while catching a slide, beyond the cornering lock (drift
 *   cars run about 60 degrees).
 * - `assistStart`..`assistFull`: drift angle (rad) over which the assist, and the wheels' caster in a slide, take
 *   over. Below it, turn-in is the car's own.
 * - `assistLock`, `assistRate`: extra lock (rad) and wheel speed (rad/s) the assist may use.
 * - `rateIn`, `rateOut`: how fast (rad/s) the assist swings the drift angle in when the driver steers into the
 *   drift, and out when they countersteer. `holdPower` / `holdLift`: time constant (s) of the angle easing off with
 *   the steering centred, on and off the throttle.
 * - `assistGain`, `counterGain`, `holdGain`: how hard (1/s) the assist closes the gap to that rate when steering in,
 *   countersteering and centred. The centred gain is low so that a rotation the driver started carries on.
 * - Spin guard (assist only, never with the handbrake held): past `guardAngle` the assist winds the angle back at
 *   `guardRate` rad/s per rad over, and adds up to `guardDamping` (1/s, full at `guardRange` over) of yaw damping
 *   while the nose is still swinging out.
 */
export const STEERING = Object.freeze({
  rateAtSpeed: 0.83,
  counterLock: 1.05,
  assistStart: 0.05,
  assistFull: 0.2,
  assistLock: 0.5,
  assistRate: 8,
  rateIn: 2.2,
  rateOut: 2.5,
  holdPower: 0.55,
  holdLift: 0.4,
  assistGain: 8,
  counterGain: 8,
  holdGain: 1.5,
  guardAngle: 0.95,
  guardRate: 6,
  guardRange: 0.3,
  guardDamping: 8,
});

/**
 * Arcade drift handling that is part of the car itself, assist or not. Each fades in with the drift angle over
 * `tractionStart`..`tractionFull` rad.
 * - `traction`: a push (in g) at right angles to the travel, towards the side the nose points to. It bends the path
 *   the way the car is pointing and costs no speed: a drift goes round the corner instead of just sliding.
 * - `noseDamping`: damping (1/s) of the nose's swing relative to the travel, so a drift settles instead of
 *   see-sawing. It never resists the car turning with its path.
 * - `driveFloor`: rear tyres busy holding the car sideways have less left to drive it (friction circle), but never
 *   less than this share of the engine's thrust. This is what keeps the speed roughly level in a held drift.
 */
export const DRIFT = Object.freeze({
  traction: 0.35,
  noseDamping: 3,
  tractionStart: 0.08,
  tractionFull: 0.35,
  driveFloor: 0.4,
});

/** The front tyres keep this share of their peak grip however far past it they are pushed (no wash-out). */
export const FRONT_SLIDE_GRIP = 0.95;

/**
 * The brakes bite harder the faster the car is going, by this many newtons per (m/s)2, as downforce would have
 * it. The car has little drag to help it stop, and the run-offs beyond the weekly levels' finish lines are 60 m
 * long: this is what stops a car that crosses the line flat out inside them without making the brakes grabby in
 * town.
 */
export const BRAKE_DOWNFORCE = 6.5;

/**
 * Braking moves weight onto the front tyres only up to this much deceleration, m/s2. The brakes themselves go on
 * to well over twice that at speed (see BRAKE_DOWNFORCE), and if the weight went all the way with them the rear
 * axle would lose a third of its load: brushing the brake with a steering key held, the ordinary way into a
 * corner on a keyboard, threw the tail out 40 degrees. Up to the limit the transfer is untouched, so braking into
 * a turn still loosens the rear enough to start a drift on the power.
 */
export const BRAKE_TRANSFER_LIMIT = 6;

/** Following the ground would take more downward pull than this before the wheels leave it (suspension droop). */
const LAUNCH_ACCEL = 1.15 * GRAVITY;
/** Tyre load over a crest or through a dip, as a multiple of the car's weight, is kept within these. */
const MIN_VERTICAL_LOAD = 0.3;
const MAX_VERTICAL_LOAD = 1.6;
/** In the air the car's spin dies away at this rate (1/s). */
const AIR_YAW_DAMPING = 0.4;
/** A landing harder than this (m/s, downwards) costs speed: `LANDING_SCRUB` per m/s over, at most `MAX_LANDING_SCRUB`. */
const HARD_LANDING = 4;
const LANDING_SCRUB = 0.02;
const MAX_LANDING_SCRUB = 0.12;

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
  car.reversing = false;
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
  car.y = 0;
  car.vy = 0;
  car.airborne = false;
  car.pitchSlope = 0;
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
 * The lock shrinks only mildly with speed (a drift car keeps its lock). On the countersteer side it is widened by
 * the drift angle, up to STEERING.counterLock: catching a slide needs far more lock than cornering does. In a slide,
 * whatever share of the wheel the driver is not holding casters along the front axle's direction of travel, so
 * letting go of the keys mid-drift is a catch, not a spin. `assistTarget` / `assistBlend` come from `driftAssist`.
 */
function updateSteering(
  car: CarState,
  params: CarParams,
  steer: number,
  forward: number,
  lateral: number,
  speed: number,
  dt: number,
  assistTarget: number,
  assistBlend: number,
): void {
  const maxSteer = params.maxSteer;
  const speedShare = params.steerSpeedRef > 0 ? clamp(speed / params.steerSpeedRef, 0, 1) : 1;
  const lock = lerp(maxSteer, params.maxSteerAtSpeed, speedShare);
  const fade = forward > 0 ? smoothstep(TRAVEL_FADE_START, TRAVEL_FADE_END, speed) : 0;
  let target = steer * lock;
  let countering = false;
  let limit = maxSteer;
  if (fade > 0) {
    const travel = atan2(lateral, forward) * fade;
    countering = steer * travel > 0;
    const counterLock = maxSteer > STEERING.counterLock ? maxSteer : STEERING.counterLock;
    if (countering) {
      // Drift cars have far more lock than cornering needs: opposite lock may follow the slide out to counterLock.
      target = steer * Math.min(counterLock, lock + Math.abs(travel));
      limit = counterLock;
    }
    // Caster: in a slide, wheels that are not held point themselves down the road (along the front axle's travel),
    // as a real car's do when the driver lets the wheel run through their hands.
    const free = 1 - Math.abs(steer);
    const rearTravel = Math.abs(atan2(lateral - car.yawRate * params.cgToRear, forward)) * fade;
    const caster = free * smoothstep(STEERING.assistStart, STEERING.assistFull, rearTravel);
    if (caster > 0) {
      const travelFront = limitMagnitude(atan2(lateral + car.yawRate * params.cgToFront, forward) * fade, counterLock);
      target += travelFront * caster;
      if (Math.abs(travelFront) > limit) limit = Math.abs(travelFront);
    }
  }
  if (assistBlend > 0) {
    target += (assistTarget - target) * assistBlend;
    limit += assistBlend * STEERING.assistLock;
  }
  target = limitMagnitude(target, limit);

  const angle = car.steerAngle;
  const returning = angle * target < 0 || Math.abs(target) < Math.abs(angle);
  // Turning in gets slower with speed, so a stab at the key is not a flick of the whole car. Catching a slide does not.
  const turnIn = countering ? params.steerRate : params.steerRate * lerp(1, STEERING.rateAtSpeed, speedShare);
  let rate = returning ? params.steerReturnRate : turnIn;
  if (assistBlend > 0 && rate < STEERING.assistRate) rate += (STEERING.assistRate - rate) * assistBlend;
  car.steerAngle = limitMagnitude(moveTowards(angle, target, rate * dt), HALF_PI);
}

/** Output of `driftAssist`: the wheel angle it wants and how much say it has (0..1). Reused, never reallocated. */
const ASSIST = { target: 0, blend: 0 };

/**
 * The drift assist. In a slide it steers the front wheels so that the nose angle (heading relative to travel)
 * follows what the keys ask for:
 * - steering INTO the drift: the nose swings further in at `rateIn` (partial steering asks for less, with the
 *   square of the input), up to the spin guard; with the handbrake pulled it never slows a swing down;
 * - centred: the angle eases off with time constant `holdPower` on the throttle and `holdLift` off it, so a drift
 *   is kept on the power and straightens smoothly when the driver lifts;
 * - countersteering: the angle comes off at `rateOut`.
 * Past `guardAngle` it winds the angle back (not while the handbrake is held: a spin can still be provoked).
 * The front tyres can only do what their grip allows, so the rear's grip and the throttle still decide what is
 * possible. Below `assistStart` of slip at the rear axle it has no say at all: turn-in is the car's own.
 */
function driftAssist(
  car: CarState,
  params: CarParams,
  steer: number,
  throttle: number,
  handbrake: boolean,
  forward: number,
  lateral: number,
  speed: number,
  forceRear: number,
  forceLong: number,
  loadFront: number,
  traction: number,
): void {
  ASSIST.blend = 0;
  ASSIST.target = 0;
  const strength = params.steerAssist > 0 ? (params.steerAssist < 1 ? params.steerAssist : 1) : 0;
  if (!(strength > 0) || !(forward > 0) || !(loadFront > 0)) return;
  const nose = -atan2(lateral, forward);
  const depth = Math.abs(nose);
  // A slide is measured at the rear axle: a car turning on grip has no slip there, however tight the turn.
  const rearDepth = Math.abs(atan2(lateral - car.yawRate * params.cgToRear, forward));
  const blend =
    strength *
    smoothstep(TRAVEL_FADE_START, TRAVEL_FADE_END, speed) *
    smoothstep(STEERING.assistStart, STEERING.assistFull, rearDepth);
  if (!(blend > 0)) return;
  const side = nose > 0 ? 1 : -1;
  const toFront = params.cgToFront;
  const mass = params.mass;
  const inertia = params.inertia;
  // How fast the nose is swinging away from the direction of travel right now (front tyres left out).
  const speedSq = forward * forward + lateral * lateral;
  const travelRate = (forward * forceRear - lateral * forceLong) / (mass * speedSq) + traction / speed;
  const noseRate = car.yawRate - travelRate;
  // What the keys ask for, as a rate of change of the drift depth.
  const into = steer * side;
  const hold = lerp(STEERING.holdLift, STEERING.holdPower, throttle);
  const ease = -depth / hold;
  let want = into >= 0 ? lerp(ease, STEERING.rateIn, into * into) : lerp(ease, -STEERING.rateOut, -into);
  // With the handbrake pulled the assist only ever adds rotation: the swing the driver is asking for is not slowed.
  if (handbrake && into > 0 && side * noseRate > want) want = side * noseRate;
  const over = depth - STEERING.guardAngle;
  if (over > 0 && !handbrake) want = Math.min(want, -over * STEERING.guardRate);
  // The front force that gives the yaw acceleration closing the gap within 1 / gain seconds.
  const gain = into > 0 ? STEERING.assistGain : lerp(STEERING.holdGain, STEERING.counterGain, -into);
  const yawAccel = gain * (side * want - noseRate);
  const cosS = cos(car.steerAngle);
  const settle =
    DRIFT.noseDamping *
    smoothstep(TRAVEL_FADE_START, TRAVEL_FADE_END, speed) *
    smoothstep(DRIFT.tractionStart, DRIFT.tractionFull, rearDepth) *
    noseRate;
  let forceFront =
    (inertia * (yawAccel + params.yawDamping * car.yawRate + settle) + params.cgToRear * forceRear) /
    (toFront * (cosS > 0.3 ? cosS : 0.3));
  const peakForce = params.gripFront * loadFront;
  if (!(peakForce > 0)) return;
  // Just short of the peak, so the inversion below stays on the rising side of the tyre curve.
  forceFront = limitMagnitude(forceFront, 0.98 * peakForce);
  // Invert the rising side of the tyre curve (see tire.ts): force share c needs normalised slip 2 - 2 sqrt(1 - c).
  const share = Math.abs(forceFront) / peakForce;
  const ratio = PEAK_SLIP_RATIO - PEAK_SLIP_RATIO * Math.sqrt(1 - (share < 1 ? share : 1));
  const slip = (ratio * params.gripFront) / params.cornerStiffFront;
  // forceFront = -coefficient(travelFront - wheel): a force to the right needs the wheel right of the front axle's travel.
  const travelFront = atan2(lateral + car.yawRate * toFront, forward);
  const wheel = travelFront + (forceFront > 0 ? slip : -slip);
  if (!(wheel === wheel)) return;
  ASSIST.target = wheel;
  ASSIST.blend = blend;
}

/**
 * Thrust at the driven wheels with the throttle wide open, as a share (0..1) of `params.engineForce`.
 * See ENGINE: flat while the tyres are the limit, then constant power, then the rev limit.
 */
export function thrustShare(forward: number): number {
  const absForward = Math.abs(forward);
  let share = absForward > ENGINE.peakSpeed ? ENGINE.peakSpeed / absForward : 1;
  if (absForward > ENGINE.redlineStart) share *= 1 - smoothstep(ENGINE.redlineStart, ENGINE.redlineEnd, absForward);
  return share;
}

/**
 * How far (0..1) the throttle is loosening the rear tyres; `powerSlip` times this is the share of rear grip lost.
 *
 * It follows the thrust the engine has to spare at this speed (see ENGINE), so full throttle breaks the tail loose
 * at low speed and cannot at road speed. Once the tyres are sliding (`rearSlide`, last tick's) the throttle goes on
 * holding them loose: a slide that was provoked can be kept alive on the power at speeds where power alone would
 * never have started it.
 */
function wheelspin(params: CarParams, throttle: number, forward: number, rearSlide: number): number {
  if (!(params.engineForce > 0)) return 0;
  const absForward = Math.abs(forward);
  const resistance = (params.rollingResistance + params.drag * absForward) * absForward;
  const spare = clamp(thrustShare(forward) - resistance / params.engineForce, 0, 1);
  const gripping = spare * (1 - ENGINE.spinCurve + ENGINE.spinCurve * spare);
  const sliding = spare + ENGINE.spinHold * (1 - spare);
  return throttle * throttle * (gripping + (sliding - gripping) * rearSlide);
}

/**
 * The reverse gear is a latch, not a function of the current speed: a car rolling backwards after a spin must be
 * stopped by the brake pedal, not driven further back by it. Checked every tick, so braking to a stop with the
 * pedal held flows straight on into reverse. Releasing the pedal keeps the gear, so reverse speed can be feathered.
 */
function selectReverse(car: CarState, throttle: number, brake: number, forward: number, speed: number): boolean {
  if (throttle > 0 || forward > REVERSE_ENGAGE_SPEED) return false;
  if (brake > 0 && forward >= -REVERSE_ENGAGE_SPEED && speed <= REVERSE_SELECT_SPEED) return true;
  return car.reversing === true;
}

/** Engine, engine braking, brakes, reverse, rolling resistance and drag, along the car's nose. */
function longitudinalForce(
  params: CarParams,
  driveShare: number,
  throttle: number,
  brake: number,
  handbrake: boolean,
  reversing: boolean,
  forward: number,
  dt: number,
): number {
  const absForward = Math.abs(forward);
  const drive = params.engineForce * thrustShare(forward) * throttle * driveShare;
  let force = drive - (params.rollingResistance + params.drag * absForward) * forward;
  let braking = params.engineForce * ENGINE.braking * (1 - throttle);
  if (handbrake) braking += params.handbrakeForce;
  if (brake > 0) {
    if (reversing) force -= params.reverseForce * brake * clamp(1 + forward / REVERSE_TOP_SPEED, 0, 1);
    else braking += (params.brakeForce + BRAKE_DOWNFORCE * forward * forward) * brake;
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

/**
 * Load on the front axle, with last tick's acceleration shifting weight between the axles (under braking, only as
 * far as BRAKE_TRANSFER_LIMIT).
 */
function frontAxleLoad(car: CarState, params: CarParams): number {
  const wheelbase = params.cgToFront + params.cgToRear;
  const accel = car.accelLong < -BRAKE_TRANSFER_LIMIT ? -BRAKE_TRANSFER_LIMIT : car.accelLong;
  const transfer = (params.weightTransfer * accel * params.cgHeight) / wheelbase;
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
  slideGrip: number,
  sideSpeed: number,
  arm: number,
  dt: number,
): number {
  const stopping = Math.abs(sideSpeed) / (dt * (1 / params.mass + (arm * arm) / params.inertia));
  return -limitMagnitude(load * lateralForceCoefficient(slip, stiffness, grip, slideGrip), stopping);
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

/**
 * One tick off the ground: gravity, a little air drag, and nothing else on the trajectory. The front wheels still
 * follow the stick so they are where the driver wants them at touchdown, and the car keeps most of its spin.
 */
function stepFlight(
  car: CarState,
  params: CarParams,
  input: InputState,
  forward: number,
  lateral: number,
  speed: number,
  ground: number,
  dt: number,
): void {
  updateSteering(car, params, steerInput(input.steer), forward, lateral, speed, dt, 0, 0);
  const keep = 1 / (1 + ((params.drag * speed) / params.mass) * dt);
  car.vx *= keep;
  car.vz *= keep;
  car.yawRate = limitMagnitude(car.yawRate / (1 + AIR_YAW_DAMPING * dt), MAX_YAW_RATE);
  car.accelLong -= car.accelLong * Math.min(1, LOAD_RESPONSE * dt);
  car.vy -= GRAVITY * dt;
  car.y += car.vy * dt;
  if (!(car.y > ground)) {
    // Touchdown. The scrub comes before the car is moved, so that this tick's move is still velocity x dt, which
    // is what the collision code relies on to know where the car came from.
    const closing = -car.vy;
    if (closing > HARD_LANDING) {
      const scrub = 1 - Math.min(MAX_LANDING_SCRUB, LANDING_SCRUB * (closing - HARD_LANDING));
      car.vx *= scrub;
      car.vz *= scrub;
    }
    car.y = ground;
    car.vy = 0;
    car.airborne = false;
  }
  settleVelocity(car, false);

  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.heading = wrapAngle(car.heading + car.yawRate * dt);

  updateKinematics(car);
  car.slipFront = 0;
  car.slipRear = 0;
  car.rearSlide = 0;
  car.frontSlide = 0;
  car.throttle = pedal(input.throttle);
  car.brake = pedal(input.brake);
  car.handbrake = input.handbrake === true;
}

/**
 * Advances the car by `dt`. It knows nothing about walls.
 *
 * `ground` is the height of the ground where the car will be at the end of this tick (its position plus
 * velocity x dt is close enough). On a flat track leave it out: the car then stays at y = 0, never leaves the
 * ground, and every tyre carries exactly its static load.
 *
 * On the ground the car follows it, and the tyres carry more in a dip and less over a crest. When following the
 * ground would take a harder downward pull than gravity (plus a little suspension droop) can give, the car takes
 * off with the vertical speed it has and flies until it meets the ground again.
 */
export function stepCar(car: CarState, params: CarParams, input: InputState, dt: number, ground = 0): void {
  const cosH = cos(car.heading);
  const sinH = sin(car.heading);
  const forward = car.vx * cosH + car.vz * sinH;
  const lateral = car.vz * cosH - car.vx * sinH;
  const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz);

  if (!(ground > -Infinity && ground < Infinity)) ground = car.y;
  let vertical = 1;
  if (!car.airborne) {
    const follow = (ground - car.y) / dt;
    const pull = (follow - car.vy) / dt;
    if (pull < -LAUNCH_ACCEL) {
      car.airborne = true;
    } else {
      vertical = clamp(1 + pull / GRAVITY, MIN_VERTICAL_LOAD, MAX_VERTICAL_LOAD);
      car.y = ground;
      car.vy = follow;
    }
  }
  if (car.airborne) {
    stepFlight(car, params, input, forward, lateral, speed, ground, dt);
    return;
  }

  const throttle = pedal(input.throttle);
  const brake = pedal(input.brake);
  const handbrake = input.handbrake === true;

  car.reversing = selectReverse(car, throttle, brake, forward, speed);
  const steer = steerInput(input.steer);

  const toFront = params.cgToFront;
  const toRear = params.cgToRear;
  const absForward = Math.abs(forward);
  const lateralRear = lateral - car.yawRate * toRear;
  const slipRear = atan2(lateralRear, absForward);
  const gripFront = params.gripFront;
  const powerGrip = 1 - params.powerSlip * wheelspin(params, throttle, forward, car.rearSlide);
  const gripRear = params.gripRear * (handbrake ? params.handbrakeGrip : 1) * powerGrip;

  const staticFront = frontAxleLoad(car, params);
  const loadFront = staticFront * vertical;
  const loadRear = (params.mass * GRAVITY - staticFront) * vertical;
  const stiffFront = params.cornerStiffFront;
  const stiffRear = params.cornerStiffRear;
  const forceRear = axleForce(params, loadRear, slipRear, stiffRear, gripRear, params.slideGrip, lateralRear, toRear, dt);
  // Friction circle: rear tyres busy holding the car sideways have less left to drive it forwards.
  const rearCapacity = params.gripRear * loadRear;
  const used = rearCapacity > 0 ? Math.min(1, Math.abs(forceRear) / rearCapacity) : 0;
  const driveShare = Math.max(DRIFT.driveFloor, Math.sqrt(1 - used * used));
  const forceDrive = longitudinalForce(params, driveShare, throttle, brake, handbrake, car.reversing, forward, dt);
  // How much of a drift the car is in (see DRIFT), measured at the rear axle: a car turning on grip has no slip
  // there, however tight the turn. Faded out at walking pace.
  const slideShare = forward > 0
    ? smoothstep(TRAVEL_FADE_START, TRAVEL_FADE_END, speed) * smoothstep(DRIFT.tractionStart, DRIFT.tractionFull, Math.abs(slipRear))
    : 0;
  // Drift traction: a push at right angles to the travel, towards the side the nose points to.
  const traction = DRIFT.traction * GRAVITY * vertical * slideShare * (lateralRear < 0 ? 1 : -1);

  driftAssist(car, params, steer, throttle, handbrake, forward, lateral, speed, forceRear, forceDrive, loadFront, traction);
  updateSteering(car, params, steer, forward, lateral, speed, dt, ASSIST.target, ASSIST.blend);
  const steerAngle = car.steerAngle;
  const cosS = cos(steerAngle);
  const sinS = sin(steerAngle);
  const lateralFront = lateral + car.yawRate * toFront;
  // Rolling backwards, the same wheel angle turns the tyre the other way relative to its direction of travel.
  const slipFront = atan2(lateralFront, absForward) - (forward < 0 ? -steerAngle : steerAngle);
  const wheelSideSpeed = lateralFront * cosS - forward * sinS;
  const forceFront = axleForce(params, loadFront, slipFront, stiffFront, gripFront, FRONT_SLIDE_GRIP, wheelSideSpeed, toFront, dt);

  // The front tyres push at right angles to the steered wheels, so part of their force slows the car.
  const forceLong = forceDrive - forceFront * sinS;
  const forceLat = forceFront * cosS + forceRear;
  let yawAccel = (toFront * forceFront * cosS - toRear * forceRear) / params.inertia;
  let ax = (forceLong * cosH - forceLat * sinH) / params.mass;
  let az = (forceLong * sinH + forceLat * cosH) / params.mass;
  if (traction !== 0) {
    ax -= (traction * car.vz) / speed;
    az += (traction * car.vx) / speed;
  }
  // Slide damping (arcade): in a slide the nose's swing relative to the travel is damped, so a drift settles
  // instead of see-sawing. It does not resist the car turning with its path.
  const settle = DRIFT.noseDamping * slideShare;
  if (settle > 0) yawAccel -= settle * (car.yawRate - (car.vx * az - car.vz * ax) / (speed * speed));
  let yawDamping = params.yawDamping;
  // Spin guard (assist only, never with the handbrake held): past guardAngle of drift, damp the yaw while the nose
  // is still swinging further away from the direction of travel.
  const depth = absForward > 0 || lateral !== 0 ? Math.abs(atan2(lateral, absForward)) : 0;
  const guardOver = depth - STEERING.guardAngle;
  if (guardOver > 0 && !handbrake && params.steerAssist > 0 && speed > TRAVEL_FADE_END) {
    const travelRate = (car.vx * az - car.vz * ax) / (speed * speed);
    const side = lateral < 0 ? 1 : -1;
    if ((car.yawRate - travelRate) * side > 0) {
      yawDamping += STEERING.guardDamping * clamp(params.steerAssist, 0, 1) * Math.min(1, guardOver / STEERING.guardRange);
    }
  }

  car.vx += ax * dt;
  car.vz += az * dt;
  car.yawRate = limitMagnitude((car.yawRate + yawAccel * dt) / (1 + yawDamping * dt), MAX_YAW_RATE);
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
