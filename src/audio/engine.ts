import type { CarParams, CarState } from '../types';
import { createEngineTone, engineTone, engineWave, gritCurve } from './mapping';
import type { EngineWaveKind } from './mapping';
import { createGlide } from './param';
import { IDLE_RPM, createDriveInput, createPowertrain, readDrive, stepPowertrain } from './rpm';

export interface EngineVoice {
  /** `now` is the AudioContext time. `active = false` fades the engine out and freezes the revs. */
  update(car: CarState, params: CarParams, active: boolean, now: number): void;
  /** Engine speed and gear (0-based, -1 = reverse) as last updated. */
  readonly rpm: number;
  readonly gear: number;
  dispose(): void;
}

/**
 * The exhaust and body of the car: fixed resonances that every engine speed is heard through. Because they stay
 * put while the harmonics sweep past them, the engine sounds like one object revving, not a tone sliding in pitch.
 */
export const EXHAUST_BODY: readonly { hz: number; q: number; gain: number }[] = [
  { hz: 170, q: 1.3, gain: 0.85 },
  { hz: 480, q: 2, gain: 0.85 },
  { hz: 1300, q: 2.4, gain: 1 },
  { hz: 2700, q: 3, gain: 0.6 },
];
/** Share of the unfiltered signal mixed in with the resonances. */
export const BODY_DRY = 0.25;
/** Band of the combustion noise before it is pulsed at the firing frequency. */
export const NOISE_BAND_HZ = 1100;
export const NOISE_BAND_Q = 0.7;
/** The two saws of the synth layer sit this many cents either side of the firing frequency and beat slowly. */
export const SAW_DETUNE_CENTS = 9;
/** Below this nothing is audible on any speaker; it would only eat headroom. */
export const RUMBLE_CUT_HZ = 40;
/** Resonance of the low-pass filters, dB (0 dB is already a slight peak; -3 dB is flat). */
export const TONE_Q_DB = -1;
export const SAW_Q_DB = 1.4;

const PITCH_SMOOTH = 0.016;
const TONE_SMOOTH = 0.03;
/** Fast enough to follow a 90 ms shift and the limiter's stutter, slow enough not to click. */
const LEVEL_SMOOTH = 0.012;
const FADE_SMOOTH = 0.09;
/** A frame longer than this (tab switch, breakpoint) is not simulated in one go. */
const MAX_STEP = 0.1;
/** Seconds between changes of the overrun flutter: 12 to 25 pops a second. */
const FLUTTER_MIN = 0.04;
const FLUTTER_SPREAD = 0.045;
/**
 * No engine holds its speed to the last rev. A quarter of a percent of wander (a few cents) is too little to hear
 * as vibrato and enough to stop a steady note from sounding like a test tone.
 */
const PITCH_WANDER = 0.005;

function periodicWave(ctx: BaseAudioContext, kind: EngineWaveKind): PeriodicWave {
  const table = engineWave(kind);
  // Normalised by the browser: every wave peaks at 1 whatever its spectrum.
  return ctx.createPeriodicWave(table.real, table.imag);
}

export function createEngineVoice(ctx: BaseAudioContext, noise: AudioBuffer, destination: AudioNode): EngineVoice {
  const sources: AudioScheduledSourceNode[] = [];

  // ---- output: everything -> output gain -> destination -------------------------------------------------------
  const output = ctx.createGain();
  output.gain.value = 0;
  output.connect(destination);

  // ---- combustion: harmonics + pulsed noise -> drive -> waveshaper ---------------------------------------------
  const drive = ctx.createGain();
  drive.gain.value = 0.3;
  const shaper = ctx.createWaveShaper();
  shaper.curve = gritCurve();
  shaper.oversample = '2x';
  drive.connect(shaper);

  function cycleOscillator(kind: EngineWaveKind): OscillatorNode {
    const oscillator = ctx.createOscillator();
    oscillator.setPeriodicWave(periodicWave(ctx, kind));
    oscillator.frequency.value = IDLE_RPM / 120;
    sources.push(oscillator);
    return oscillator;
  }

  const loadOsc = cycleOscillator('load');
  const loadGain = ctx.createGain();
  loadGain.gain.value = 0;
  loadOsc.connect(loadGain).connect(drive);

  const coastOsc = cycleOscillator('coast');
  const coastGain = ctx.createGain();
  coastGain.gain.value = 0;
  coastOsc.connect(coastGain).connect(drive);

  // Noise -> band-pass -> a gain that swings between 0 and 1 once per firing -> level -> drive.
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noise;
  noiseSource.loop = true;
  sources.push(noiseSource);
  const noiseBand = ctx.createBiquadFilter();
  noiseBand.type = 'bandpass';
  noiseBand.frequency.value = NOISE_BAND_HZ;
  noiseBand.Q.value = NOISE_BAND_Q;
  const noisePulse = ctx.createGain();
  noisePulse.gain.value = 0.5;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noiseSource.connect(noiseBand).connect(noisePulse).connect(noiseGain).connect(drive);
  const pulseOsc = cycleOscillator('pulse');
  const pulseDepth = ctx.createGain();
  pulseDepth.gain.value = 0.5;
  pulseOsc.connect(pulseDepth).connect(noisePulse.gain);

  // ---- exhaust body: shaper -> (dry + resonances) -> low-pass -> rumble cut -> output --------------------------
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 600;
  tone.Q.value = TONE_Q_DB;
  const rumbleCut = ctx.createBiquadFilter();
  rumbleCut.type = 'highpass';
  rumbleCut.frequency.value = RUMBLE_CUT_HZ;
  rumbleCut.Q.value = -3;
  tone.connect(rumbleCut).connect(output);

  const dry = ctx.createGain();
  dry.gain.value = BODY_DRY;
  shaper.connect(dry).connect(tone);
  for (const formant of EXHAUST_BODY) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = formant.hz;
    filter.Q.value = formant.q;
    const gain = ctx.createGain();
    gain.gain.value = formant.gain;
    shaper.connect(filter).connect(gain).connect(tone);
  }

  // ---- synth layer: two detuned saws at the firing frequency -> gain -> low-pass -> output ----------------------
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0;
  const sawFilter = ctx.createBiquadFilter();
  sawFilter.type = 'lowpass';
  sawFilter.frequency.value = 300;
  sawFilter.Q.value = SAW_Q_DB;
  sawGain.connect(sawFilter).connect(output);

  function saw(detuneCents: number): OscillatorNode {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = IDLE_RPM / 30;
    oscillator.detune.value = detuneCents;
    oscillator.connect(sawGain);
    sources.push(oscillator);
    return oscillator;
  }
  const sawLow = saw(-SAW_DETUNE_CENTS);
  const sawHigh = saw(SAW_DETUNE_CENTS);

  // One start time for all of them: the three cycle oscillators must stay in phase with each other.
  const startAt = ctx.currentTime;
  noiseSource.start(startAt, 0.37);
  for (const source of sources) if (source !== noiseSource) source.start(startAt);

  const loadPitch = createGlide(loadOsc.frequency);
  const coastPitch = createGlide(coastOsc.frequency);
  const pulsePitch = createGlide(pulseOsc.frequency);
  const sawLowPitch = createGlide(sawLow.frequency);
  const sawHighPitch = createGlide(sawHigh.frequency);
  const loadLevel = createGlide(loadGain.gain);
  const coastLevel = createGlide(coastGain.gain);
  const noiseLevel = createGlide(noiseGain.gain);
  const driveLevel = createGlide(drive.gain);
  const toneCutoff = createGlide(tone.frequency);
  const sawLevel = createGlide(sawGain.gain);
  const sawCutoff = createGlide(sawFilter.frequency);
  const outputLevel = createGlide(output.gain);

  const powertrain = createPowertrain();
  const driveInput = createDriveInput();
  const mix = createEngineTone();
  let lastNow = -1;
  let flutter = 0;
  let flutterUntil = 0;

  return {
    update(car, params, active, now) {
      const dt = lastNow < 0 ? 0 : Math.min(Math.max(now - lastNow, 0), MAX_STEP);
      lastNow = now;
      if (active) stepPowertrain(powertrain, readDrive(car, params, driveInput), dt);
      if (now >= flutterUntil) {
        flutter = Math.random();
        flutterUntil = now + FLUTTER_MIN + FLUTTER_SPREAD * Math.random();
      }
      engineTone(powertrain.rpm, powertrain.torque, powertrain.gate, flutter, mix);

      const wander = active ? 1 + PITCH_WANDER * (flutter - 0.5) : 1;
      const cycleHz = mix.cycleHz * wander;
      const firingHz = mix.firingHz * wander;
      loadPitch.to(cycleHz, now, PITCH_SMOOTH);
      coastPitch.to(cycleHz, now, PITCH_SMOOTH);
      pulsePitch.to(cycleHz, now, PITCH_SMOOTH);
      sawLowPitch.to(firingHz, now, PITCH_SMOOTH);
      sawHighPitch.to(firingHz, now, PITCH_SMOOTH);

      loadLevel.to(mix.loadGain, now, TONE_SMOOTH);
      coastLevel.to(mix.coastGain, now, TONE_SMOOTH);
      noiseLevel.to(mix.noiseGain, now, TONE_SMOOTH);
      driveLevel.to(mix.drive, now, TONE_SMOOTH);
      toneCutoff.to(mix.cutoff, now, TONE_SMOOTH);
      sawLevel.to(mix.sawGain, now, TONE_SMOOTH);
      sawCutoff.to(mix.sawCutoff, now, TONE_SMOOTH);
      outputLevel.to(active ? mix.level : 0, now, active ? LEVEL_SMOOTH : FADE_SMOOTH);
    },
    get rpm() {
      return powertrain.rpm;
    },
    get gear() {
      return powertrain.gear;
    },
    dispose() {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        source.disconnect();
      }
      output.disconnect();
    },
  };
}
