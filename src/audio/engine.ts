import type { CarParams, CarState } from '../types';

export interface EngineVoice {
  /** `now` is the AudioContext time. `active = false` fades the engine out. */
  update(car: CarState, params: CarParams, active: boolean, now: number): void;
  dispose(): void;
}

/** Top speed of each gear as a fraction of the car's estimated top speed. */
const GEAR_TOPS = [0.2, 0.37, 0.57, 0.79, 1.06];
const UPSHIFT_REV = 0.95;
/** Shift down once the lower gear would sit below this share of its range. */
const DOWNSHIFT_REV = 0.78;

const IDLE_HZ = 58;
const REDLINE_HZ = 228;
const MAX_REV = 1.08;
/** Below this speed (m/s) the throttle revs the engine freely, as if the clutch were slipping. */
const LAUNCH_SPEED = 6;
const LAUNCH_REV = 0.34;
/** Extra revs from spinning rear wheels at full throttle and full slide. */
const WHEELSPIN_REV = 0.16;
const THROTTLE_PITCH = 0.05;

const MIN_TOP_SPEED = 25;
const MAX_TOP_SPEED = 70;

const PITCH_SMOOTH = 0.055;
const TONE_SMOOTH = 0.07;
const FADE_SMOOTH = 0.09;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Speed at which engine force balances drag and rolling resistance, kept within a sane range. */
function estimateTopSpeed(params: CarParams): number {
  const drag = params.drag;
  const rolling = params.rollingResistance;
  const force = params.engineForce;
  let speed = MAX_TOP_SPEED;
  if (drag > 1e-6) speed = (Math.sqrt(rolling * rolling + 4 * drag * force) - rolling) / (2 * drag);
  else if (rolling > 1e-6) speed = force / rolling;
  return clamp(speed, MIN_TOP_SPEED, MAX_TOP_SPEED);
}

function createOscillator(
  ctx: BaseAudioContext,
  type: OscillatorType,
  detuneCents: number,
  level: number,
  destination: AudioNode,
): OscillatorNode {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = IDLE_HZ;
  oscillator.detune.value = detuneCents;
  gain.gain.value = level;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  return oscillator;
}

export function createEngineVoice(ctx: BaseAudioContext, destination: AudioNode): EngineVoice {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 300;
  filter.Q.value = 1.4;
  const output = ctx.createGain();
  output.gain.value = 0;
  filter.connect(output).connect(destination);

  // Two slightly detuned saws beat against each other; the square an octave down adds body.
  const upper = createOscillator(ctx, 'sawtooth', -11, 0.5, filter);
  const lower = createOscillator(ctx, 'sawtooth', 13, 0.5, filter);
  const sub = createOscillator(ctx, 'square', 0, 0.3, filter);

  let gear = 0;

  /** Engine speed 0..MAX_REV for the current gear, shifting gear when it leaves the gear's range. */
  function revFromSpeed(speed: number, topSpeed: number): number {
    if (gear < GEAR_TOPS.length - 1 && speed > GEAR_TOPS[gear] * topSpeed * UPSHIFT_REV) gear++;
    else if (gear > 0 && speed < GEAR_TOPS[gear - 1] * topSpeed * DOWNSHIFT_REV) gear--;
    return speed / (GEAR_TOPS[gear] * topSpeed);
  }

  return {
    update(car, params, active, now) {
      const throttle = clamp(car.throttle, 0, 1);
      const launch = throttle * LAUNCH_REV * (1 - clamp(car.speed / LAUNCH_SPEED, 0, 1));
      const wheelspin = throttle * car.rearSlide * WHEELSPIN_REV;
      const road = revFromSpeed(car.speed, estimateTopSpeed(params));
      const rev = clamp(Math.max(road, launch) + wheelspin, 0, MAX_REV);

      const pitch = (IDLE_HZ + (REDLINE_HZ - IDLE_HZ) * rev) * (1 + THROTTLE_PITCH * throttle);
      upper.frequency.setTargetAtTime(pitch, now, PITCH_SMOOTH);
      lower.frequency.setTargetAtTime(pitch, now, PITCH_SMOOTH);
      sub.frequency.setTargetAtTime(pitch * 0.5, now, PITCH_SMOOTH);

      filter.frequency.setTargetAtTime(320 + 1500 * throttle + 700 * rev, now, TONE_SMOOTH);
      const level = active ? 0.07 + 0.13 * throttle + 0.04 * rev : 0;
      output.gain.setTargetAtTime(level, now, active ? TONE_SMOOTH : FADE_SMOOTH);
    },
    dispose() {
      upper.stop();
      lower.stop();
      sub.stop();
      output.disconnect();
    },
  };
}
