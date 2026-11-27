import { MAX_GRADE } from '../types';
import { IDLE_RPM, REDLINE_RPM } from './rpm';

/**
 * Pure mappings from the car and powertrain to synthesis parameters, and the fixed tables (harmonic spectra,
 * waveshaper curves) the voices are built from. No WebAudio in here, so all of it can be unit-tested.
 */

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------------------------
// Engine spectra
// ---------------------------------------------------------------------------------------------------------------

/**
 * The engine oscillators run at the frequency of one full four-stroke cycle (two crank turns, rpm / 120), so
 * harmonic k of their wave is engine order k / 2: harmonic 2 is the crank (1st order), harmonic 4 the firing
 * frequency of four cylinders (2nd order), harmonic 8 the 4th order, and the odd harmonics are the half orders
 * that only exist because no two cylinders burn quite alike.
 */
export const ENGINE_HARMONICS = 128;
export const FIRING_HARMONIC = 4;

/**
 * - `load`: on the throttle. Firing order and its multiples dominate, with a long bright tail.
 * - `coast`: off the throttle. Duller, with relatively more crank order and half-order lumpiness.
 * - `pulse`: not heard directly; it gates the combustion noise once per firing, slightly unevenly.
 */
export type EngineWaveKind = 'load' | 'coast' | 'pulse';

export interface WaveTable {
  /** Cosine terms; index 0 (DC) is always 0. */
  real: Float32Array;
  /** Sine terms. */
  imag: Float32Array;
}

/** Relative strength of harmonic `k` (1-based) of the engine cycle. */
export function engineHarmonicLevel(kind: EngineWaveKind, k: number): number {
  const order = k / 2;
  if (kind === 'pulse') {
    if (k === 4) return 1;
    if (k === 8) return 0.35;
    if (k === 12) return 0.12;
    if (k === 2) return 0.22;
    return k === 1 ? 0.1 : 0;
  }
  const load = kind === 'load';
  if (k % 4 === 0) {
    // Multiples of the firing frequency: orders 2, 4, 6, 8 ...
    const m = k / 4;
    if (load) return m === 1 ? 1 : m === 2 ? 0.72 : 1.3 / Math.pow(m, 1.1);
    return m === 1 ? 0.8 : 0.8 / (m * Math.sqrt(m));
  }
  if (k % 2 === 0) {
    // The remaining whole orders: 1, 3, 5 ...
    if (load) return order === 1 ? 0.42 : 0.5 / (order * Math.sqrt(Math.sqrt(order)));
    return order === 1 ? 0.6 : 0.6 / (order * Math.sqrt(order));
  }
  // Half orders: 0.5, 1.5, 2.5 ...
  const o = Math.max(1, order);
  return load ? 0.1 / Math.sqrt(o) : 0.16 / o;
}

const GOLDEN = 0.6180339887498949;

/** Fourier tables for `createPeriodicWave`. */
export function engineWave(kind: EngineWaveKind, harmonics = ENGINE_HARMONICS): WaveTable {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    const level = engineHarmonicLevel(kind, k);
    if (k % FIRING_HARMONIC === 0) {
      // A sine series of the firing multiples is a train of sharp-edged pulses, one per combustion.
      imag[k] = level;
    } else {
      // Everything between the firing multiples gets a fixed scattered phase: it should blur the pulses, not
      // line up into a pulse train of its own.
      const phase = 2 * Math.PI * ((k * GOLDEN) % 1);
      real[k] = level * Math.cos(phase);
      imag[k] = level * Math.sin(phase);
    }
  }
  return { real, imag };
}

/**
 * Soft saturation for the engine: nearly linear for small signals, rounding off towards full scale, and slightly
 * lopsided so it adds even harmonics as well as odd ones. Maps [-1, 1] onto a curve inside [-1, 1].
 */
export function gritCurve(samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const k = 2;
  const bias = 0.1;
  const offset = Math.tanh(k * bias);
  const scale = 1 / Math.max(Math.tanh(k * (1 + bias)) - offset, offset - Math.tanh(k * (bias - 1)));
  for (let i = 0; i < samples; i++) {
    const x = (2 * i) / (samples - 1) - 1;
    curve[i] = (Math.tanh(k * (x + bias)) - offset) * scale;
  }
  return curve;
}

/** Below this the master clipper leaves the signal alone. */
export const CLIP_KNEE = 0.75;
/** The largest value the master clipper can output. */
export const CLIP_CEILING = CLIP_KNEE + (1 - CLIP_KNEE) * Math.tanh(1);

/**
 * Last stage of the master chain: transparent below CLIP_KNEE, then bending over so that nothing, however loud,
 * leaves above CLIP_CEILING. (A WaveShaper clamps its input to [-1, 1] first, so the ends of the curve are hard
 * limits.)
 */
export function clipCurve(samples = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const span = 1 - CLIP_KNEE;
  for (let i = 0; i < samples; i++) {
    const x = (2 * i) / (samples - 1) - 1;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE ? a : CLIP_KNEE + span * Math.tanh((a - CLIP_KNEE) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// ---------------------------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------------------------

export interface EngineTone {
  /** Frequency of the harmonic oscillators: one four-stroke cycle. */
  cycleHz: number;
  /** rpm / 60 * 2: four cylinders firing over two crank turns. */
  firingHz: number;
  /** Mix of the on-throttle and off-throttle spectra. */
  loadGain: number;
  coastGain: number;
  /** Combustion noise, pulsed at the firing frequency. */
  noiseGain: number;
  /** Gain into the waveshaper: more means more grit. */
  drive: number;
  /** Cutoff of the low-pass after the exhaust body, Hz. */
  cutoff: number;
  /** The clean synth layer (detuned saws at the firing frequency). */
  sawGain: number;
  sawCutoff: number;
  /** Output gain of the whole voice. */
  level: number;
}

export function createEngineTone(): EngineTone {
  return {
    cycleHz: IDLE_RPM / 120,
    firingHz: IDLE_RPM / 30,
    loadGain: 0,
    coastGain: 0,
    noiseGain: 0,
    drive: 0,
    cutoff: 600,
    sawGain: 0,
    sawCutoff: 300,
    level: 0,
  };
}

/**
 * Output gain of the engine voice. Most of the difference in loudness between idling, coasting and pulling comes
 * from the signal itself (how hard the waveshaper is driven and how far the low-pass is open), not from this.
 */
export const ENGINE_LEVEL = 0.3;

/** How much louder (as a share) the engine gets at full strain: pulling up the steepest climb. */
export const STRAIN_LEVEL = 0.14;
/** How much quieter it gets at full negative strain: rolling down the steepest descent off the throttle. */
export const EASE_LEVEL = 0.06;

/**
 * How hard the road's slope makes the engine work, -1..1: positive pulling uphill (more so on the throttle),
 * negative running downhill off the throttle (the engine is being pushed, not pushing). 0 in the air, on the flat,
 * and for anything that is not a number (a car state from before slopes existed).
 *
 * @param pitchSlope rise over run along the car's heading (CarState.pitchSlope), + = uphill.
 * @param throttle 0..1 pedal as applied.
 */
export function slopeStrain(pitchSlope: number, throttle: number, airborne: boolean): number {
  if (airborne || !Number.isFinite(pitchSlope)) return 0;
  const grade = clamp(pitchSlope / MAX_GRADE, -1, 1);
  const pedal = Number.isFinite(throttle) ? clamp01(throttle) : 0;
  if (grade >= 0) return grade * (0.35 + 0.65 * pedal);
  return grade * 0.6 * (1 - 0.7 * pedal);
}

/**
 * @param torque 0..1 how hard the engine is working (Powertrain.torque).
 * @param gate 0..1 loudness dip for shifts and the limiter (Powertrain.gate).
 * @param flutter random 0..1, fresh on every call: the unevenness of an engine on the overrun.
 * @param strain -1..1 from `slopeStrain`: uphill the engine labours (more grit, more combustion noise, a little
 *   louder); downhill off the throttle it eases off. 0 = flat road, the original sound exactly.
 */
export function engineTone(
  rpm: number,
  torque: number,
  gate: number,
  flutter: number,
  out: EngineTone,
  strain = 0,
): EngineTone {
  const t = clamp01(torque);
  const s = clamp(Number.isFinite(strain) ? strain : 0, -1, 1);
  const up = s > 0 ? s : 0;
  const down = s < 0 ? -s : 0;
  const rev = clamp01((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
  // Off the throttle with the revs up, the engine pops and burbles instead of pulling.
  const overrun = (1 - t) * (1 - t) * smoothstep(1500, 3200, rpm);
  const burble = overrun * clamp01(flutter);

  out.cycleHz = rpm / 120;
  out.firingHz = rpm / 30;
  out.loadGain = 0.1 + 0.9 * t + 0.12 * up;
  out.coastGain = 0.75 - 0.6 * t + 0.1 * down;
  out.noiseGain = (0.35 + 0.95 * t + 0.4 * rev + 1.1 * burble * burble) * (1 + 0.35 * up - 0.2 * down);
  out.drive = 0.36 + 0.22 * t + 0.06 * rev + 0.1 * up;
  // Labouring is darker than revving: the extra load comes with the low-pass closing a little.
  out.cutoff = (600 + 1300 * t + 2200 * rev + 1500 * t * rev) * (1 - 0.08 * up);
  out.sawGain = 0.018 + 0.05 * t + 0.02 * rev;
  out.sawCutoff = 320 + 1300 * t + 800 * rev;
  // Near idle nearly everything the engine produces is below the exhaust resonances; make up for it.
  const idle = 1 - smoothstep(IDLE_RPM, 2200, rpm);
  out.level =
    ENGINE_LEVEL *
    (0.9 + 0.1 * t + 0.7 * idle) *
    clamp01(gate) *
    (1 - 0.3 * burble) *
    (1 + STRAIN_LEVEL * up - EASE_LEVEL * down);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------------------------------------------

export interface TyreMix {
  /** Broadband scrub: rubber dragged sideways across the road. */
  scrubGain: number;
  scrubHz: number;
  /** Tonal squeal: rubber that is only just letting go. */
  squealGain: number;
  squealHz: number;
}

export function createTyreMix(): TyreMix {
  return { scrubGain: 0, scrubHz: 500, squealGain: 0, squealHz: 800 };
}

/** Tyres make no noise below this speed (m/s) and reach full volume TYRE_SPEED_RANGE above it. */
export const TYRE_QUIET_SPEED = 2;
export const TYRE_SPEED_RANGE = 10;
export const SQUEAL_MIN_HZ = 700;
export const SQUEAL_MAX_HZ = 1300;
export const SCRUB_LEVEL = 0.58;
export const SQUEAL_LEVEL = 1;

/**
 * @param driftAngle signed angle between heading and travel, rad.
 * @param wobble -1..1 slow random drift, so the squeal never sits on one note.
 */
export function tyreMix(
  speed: number,
  rearSlide: number,
  frontSlide: number,
  driftAngle: number,
  handbrake: boolean,
  airborne: boolean,
  wobble: number,
  out: TyreMix,
): TyreMix {
  const slide = clamp01(Math.max(rearSlide, frontSlide));
  const rolling = clamp01((speed - TYRE_QUIET_SPEED) / TYRE_SPEED_RANGE);
  const fast = clamp01(speed / 40);
  // 1 when the tyres have stopped gripping altogether: locked by the handbrake, or sliding and well sideways.
  const sideways = smoothstep(0.6, 1, slide) * smoothstep(0.35, 0.95, Math.abs(driftAngle));
  const harsh = handbrake ? 1 : sideways;
  const contact = airborne ? 0 : rolling;

  out.squealGain = SQUEAL_LEVEL * contact * smoothstep(0.06, 0.4, slide) * (1 - 0.82 * harsh);
  out.scrubGain = SCRUB_LEVEL * contact * (0.22 * slide + 0.78 * harsh) * (0.6 + 0.4 * fast);
  out.squealHz = clamp(SQUEAL_MIN_HZ + 360 * fast + 200 * slide + 45 * wobble, SQUEAL_MIN_HZ, SQUEAL_MAX_HZ);
  out.scrubHz = 420 + 480 * fast + 260 * harsh;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Wind and road
// ---------------------------------------------------------------------------------------------------------------

export interface AmbienceMix {
  windGain: number;
  windHz: number;
  roadGain: number;
  roadHz: number;
}

export function createAmbienceMix(): AmbienceMix {
  return { windGain: 0, windHz: 350, roadGain: 0, roadHz: 70 };
}

/** Speed (m/s) at which wind and road noise stop growing. */
export const AMBIENCE_FULL_SPEED = 45;

export function ambienceMix(speed: number, airborne: boolean, out: AmbienceMix): AmbienceMix {
  const s = clamp01(speed / AMBIENCE_FULL_SPEED);
  // Wind pressure goes with the square of the speed; the tyres' rumble on the road only with the speed itself.
  out.windGain = 0.15 * s * s * (airborne ? 1.3 : 1);
  out.windHz = 350 + 1900 * s;
  out.roadGain = airborne ? 0 : 0.22 * s;
  out.roadHz = 70 + 130 * s;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Master output
// ---------------------------------------------------------------------------------------------------------------

/**
 * Fixed trim on everything the game plays, after the limiter and clipper: "the sound is great, make it ten percent
 * quieter". Applied last so the mix and the limiter's behaviour are exactly as before, only 10 % lower.
 */
export const OUTPUT_TRIM = 0.9;

// ---------------------------------------------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------------------------------------------

/**
 * A bit-crusher's transfer curve: each half of [-1, 1] quantised to `steps` levels above zero (steps >= 1), the
 * grainy sound of a signal squeezed through too few bits. Odd symmetric, and never outside [-1, 1].
 */
export function crushCurve(steps: number, samples = 512): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.floor(Number.isFinite(steps) ? steps : 1));
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (2 * i) / (samples - 1) - 1;
    const q = Math.round(Math.abs(x) * n) / n;
    curve[i] = x < 0 ? -q : q;
  }
  return curve;
}

/**
 * Minimum time between two plays of the same cue, s. A cue asked for again sooner is dropped. Cues not listed here
 * always play. 'close' (a close-to-the-wall moment starting) is at most four a second so it never turns into a
 * rattle; the interface ticks are thinned out only when something calls them every frame.
 */
export const CUE_MIN_GAP: Readonly<Partial<Record<string, number>>> = {
  close: 0.25,
  multiplier: 0.08,
  comboLost: 0.2,
  fall: 0.5,
  uiMove: 0.03,
  uiGlitch: 0.05,
};

/** True when a cue last played at `last` (s, -Infinity for never) may play again at `now`. */
export function cueReady(kind: string, now: number, last: number): boolean {
  const gap = CUE_MIN_GAP[kind];
  return gap === undefined || !(now - last < gap);
}

// ---------------------------------------------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------------------------------------------

/** Softer hits than this (m/s) make no sound. */
export const MIN_IMPACT = 0.6;
/** Closing speed (m/s) that gives the loudest thump. */
export const FULL_IMPACT = 14;

/** 0..1 strength of a hit, or 0 for one too soft to hear (or not a number at all). */
export function impactStrength(impact: number): number {
  if (!(impact >= MIN_IMPACT)) return 0;
  return clamp01(impact / FULL_IMPACT);
}
