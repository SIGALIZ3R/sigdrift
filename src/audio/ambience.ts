import type { CarState } from '../types';
import { ambienceMix, createAmbienceMix } from './mapping';
import { createGlide } from './param';

/** Wind over the body and the rumble of the tyres on the road: felt more than heard, but missed when absent. */
export interface AmbienceVoice {
  /** `now` is the AudioContext time. `active = false` fades it out. */
  update(car: CarState, active: boolean, now: number): void;
  dispose(): void;
}

/** Wind has no deep bass; this keeps it out of the engine's way. */
export const WIND_FLOOR_HZ = 180;

const SMOOTH = 0.12;
const FADE_SMOOTH = 0.09;

export function createAmbienceVoice(ctx: BaseAudioContext, noise: AudioBuffer, destination: AudioNode): AmbienceVoice {
  const windSource = ctx.createBufferSource();
  windSource.buffer = noise;
  windSource.loop = true;
  const roadSource = ctx.createBufferSource();
  roadSource.buffer = noise;
  roadSource.loop = true;
  // Played slower, the same noise has its energy lower down and does not line up with the other readers.
  roadSource.playbackRate.value = 0.5;

  // Wind: noise -> high-pass (fixed) -> low-pass (opens with speed) -> gain -> destination.
  const windFloor = ctx.createBiquadFilter();
  windFloor.type = 'highpass';
  windFloor.frequency.value = WIND_FLOOR_HZ;
  windFloor.Q.value = -3;
  const windTop = ctx.createBiquadFilter();
  windTop.type = 'lowpass';
  windTop.frequency.value = 350;
  windTop.Q.value = -3;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  windSource.connect(windFloor).connect(windTop).connect(windGain).connect(destination);

  // Road: noise -> low-pass (rises a little with speed) -> gain -> destination.
  const roadTop = ctx.createBiquadFilter();
  roadTop.type = 'lowpass';
  roadTop.frequency.value = 70;
  roadTop.Q.value = 2;
  const roadGain = ctx.createGain();
  roadGain.gain.value = 0;
  roadSource.connect(roadTop).connect(roadGain).connect(destination);

  const startAt = ctx.currentTime;
  windSource.start(startAt, 0.71);
  roadSource.start(startAt, 1.53);

  const windLevel = createGlide(windGain.gain);
  const windCutoff = createGlide(windTop.frequency);
  const roadLevel = createGlide(roadGain.gain);
  const roadCutoff = createGlide(roadTop.frequency);
  const mix = createAmbienceMix();

  return {
    update(car, active, now) {
      ambienceMix(car.speed, car.airborne === true, mix);
      const smooth = active ? SMOOTH : FADE_SMOOTH;
      windLevel.to(active ? mix.windGain : 0, now, smooth);
      roadLevel.to(active ? mix.roadGain : 0, now, active && mix.roadGain > 0 ? SMOOTH : FADE_SMOOTH);
      windCutoff.to(mix.windHz, now, SMOOTH);
      roadCutoff.to(mix.roadHz, now, SMOOTH);
    },
    dispose() {
      windSource.stop();
      roadSource.stop();
      windGain.disconnect();
      roadGain.disconnect();
    },
  };
}
