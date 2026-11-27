import type { CarState } from '../types';
import { createTyreMix, tyreMix } from './mapping';
import { createGlide } from './param';

export interface TireVoice {
  /** `now` is the AudioContext time. `active = false` fades the tyres out. */
  update(car: CarState, active: boolean, now: number): void;
  dispose(): void;
}

/** Wide band for the scrub: it should roar, not sing. */
export const SCRUB_Q = 0.8;
/** A band-pass that wide lets a lot of hiss through above it; rubber on tarmac has very little up there. */
export const SCRUB_TOP_HZ = 3000;
/**
 * The squeal is noise through two identical narrow band-passes in series. Noise that narrow is very nearly a
 * tone, but one whose loudness and pitch never quite hold still, which is exactly what a squealing tyre does.
 */
export const SQUEAL_Q = 14;
/** A second, weaker resonance above the main one keeps the squeal from sounding like a whistle. */
export const SQUEAL_OVERTONE = 2.04;
export const SQUEAL_OVERTONE_LEVEL = 0.3;
/**
 * Narrow-band noise is quiet; this brings the squeal up to just under the level of a full scrub. It sits where
 * hearing is keenest, so it carries without being as loud.
 */
export const SQUEAL_MAKEUP = 1.4;

const WOBBLE_HZ = 6.5;
/** Share of the wobble that is a steady warble; the rest wanders at random. */
const WOBBLE_STEADY = 0.45;
const WANDER_RATE = 9;
const SMOOTH = 0.05;
const FADE_SMOOTH = 0.08;
const MAX_STEP = 0.1;

/** Mono white noise, long enough that the loop point is not heard as a rhythm. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

function bandPass(ctx: BaseAudioContext, hz: number, q: number): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = hz;
  filter.Q.value = q;
  return filter;
}

function silentGain(ctx: BaseAudioContext): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  return gain;
}

export function createTireVoice(ctx: BaseAudioContext, noise: AudioBuffer, destination: AudioNode): TireVoice {
  // Two readers of the same noise, started far apart so the layers are not copies of each other.
  const scrubSource = ctx.createBufferSource();
  scrubSource.buffer = noise;
  scrubSource.loop = true;
  const squealSource = ctx.createBufferSource();
  squealSource.buffer = noise;
  squealSource.loop = true;

  // Scrub: noise -> wide band-pass -> low-pass (fixed) -> gain -> destination.
  const scrubBand = bandPass(ctx, 500, SCRUB_Q);
  const scrubTop = ctx.createBiquadFilter();
  scrubTop.type = 'lowpass';
  scrubTop.frequency.value = SCRUB_TOP_HZ;
  scrubTop.Q.value = -3;
  const scrubGain = silentGain(ctx);
  scrubSource.connect(scrubBand).connect(scrubTop).connect(scrubGain).connect(destination);

  // Squeal: noise -> narrow band-pass -> narrow band-pass -> gain -> destination,
  //         and from the first band-pass's input a parallel overtone band-pass -> its level -> the same gain.
  const squealFirst = bandPass(ctx, 800, SQUEAL_Q);
  const squealSecond = bandPass(ctx, 800, SQUEAL_Q);
  const squealOvertone = bandPass(ctx, 800 * SQUEAL_OVERTONE, SQUEAL_Q * 1.5);
  const overtoneLevel = ctx.createGain();
  overtoneLevel.gain.value = SQUEAL_OVERTONE_LEVEL;
  const squealMakeup = ctx.createGain();
  squealMakeup.gain.value = SQUEAL_MAKEUP;
  const squealGain = silentGain(ctx);
  squealSource.connect(squealFirst).connect(squealSecond).connect(squealMakeup);
  squealSource.connect(squealOvertone).connect(overtoneLevel).connect(squealMakeup);
  squealMakeup.connect(squealGain).connect(destination);

  const startAt = ctx.currentTime;
  scrubSource.start(startAt, 0.11);
  squealSource.start(startAt, 1.03);

  const scrubLevel = createGlide(scrubGain.gain);
  const scrubCentre = createGlide(scrubBand.frequency);
  const squealLevel = createGlide(squealGain.gain);
  const squealCentreFirst = createGlide(squealFirst.frequency);
  const squealCentreSecond = createGlide(squealSecond.frequency);
  const squealCentreOvertone = createGlide(squealOvertone.frequency);

  const mix = createTyreMix();
  let wander = 0;
  let lastNow = -1;

  return {
    update(car, active, now) {
      const dt = lastNow < 0 ? 0 : Math.min(Math.max(now - lastNow, 0), MAX_STEP);
      lastNow = now;
      // A random walk pulled back to zero, mixed with a steady warble.
      wander += (Math.random() * 2 - 1 - wander) * Math.min(1, WANDER_RATE * dt);
      const wobble = WOBBLE_STEADY * Math.sin(now * WOBBLE_HZ * 2 * Math.PI) + (1 - WOBBLE_STEADY) * wander;

      tyreMix(
        car.speed,
        car.rearSlide,
        car.frontSlide,
        car.driftAngle,
        car.handbrake === true,
        car.airborne === true,
        wobble,
        mix,
      );

      const smooth = active ? SMOOTH : FADE_SMOOTH;
      scrubLevel.to(active ? mix.scrubGain : 0, now, smooth);
      squealLevel.to(active ? mix.squealGain : 0, now, smooth);
      scrubCentre.to(mix.scrubHz, now, SMOOTH);
      squealCentreFirst.to(mix.squealHz, now, SMOOTH);
      squealCentreSecond.to(mix.squealHz, now, SMOOTH);
      squealCentreOvertone.to(mix.squealHz * SQUEAL_OVERTONE, now, SMOOTH);
    },
    dispose() {
      scrubSource.stop();
      squealSource.stop();
      scrubGain.disconnect();
      squealGain.disconnect();
    },
  };
}
