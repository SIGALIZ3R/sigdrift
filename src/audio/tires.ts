import type { CarState } from '../types';

export interface TireVoice {
  /** `now` is the AudioContext time. `active = false` fades the tyres out. */
  update(car: CarState, active: boolean, now: number): void;
  dispose(): void;
}

/** Tyres make no noise below this speed (m/s) and reach full volume `SPEED_RANGE` above it. */
const QUIET_SPEED = 2;
const SPEED_RANGE = 10;
const MAX_LEVEL = 0.9;
/** Drift angle (rad) at which the squeal stops rising in pitch. */
const MAX_DRIFT = 1.2;
const WOBBLE_HZ = 6.5;
const SMOOTH = 0.05;
const FADE_SMOOTH = 0.08;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Mono white noise, long enough that the loop point is not heard as a rhythm. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createTireVoice(ctx: BaseAudioContext, noise: AudioBuffer, destination: AudioNode): TireVoice {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  filter.Q.value = 3;
  const output = ctx.createGain();
  output.gain.value = 0;
  source.connect(filter).connect(output).connect(destination);
  source.start();

  return {
    update(car, active, now) {
      const slide = clamp01(Math.max(car.rearSlide, car.frontSlide));
      const speed = clamp01((car.speed - QUIET_SPEED) / SPEED_RANGE);
      // Slightly convex so a light slide whispers and a full slide howls.
      const level = active ? MAX_LEVEL * speed * slide * (0.4 + 0.6 * slide) : 0;
      output.gain.setTargetAtTime(level, now, active ? SMOOTH : FADE_SMOOTH);

      const drift = Math.min(Math.abs(car.driftAngle), MAX_DRIFT);
      const wobble = Math.sin(now * WOBBLE_HZ * 2 * Math.PI) * drift;
      filter.frequency.setTargetAtTime(880 + 460 * drift + 6 * car.speed + 90 * wobble, now, SMOOTH);
      filter.Q.setTargetAtTime(3 + 3 * drift + 1.2 * wobble, now, SMOOTH);
    },
    dispose() {
      source.stop();
      output.disconnect();
    },
  };
}
