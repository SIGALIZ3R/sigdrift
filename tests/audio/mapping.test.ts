import { describe, expect, it } from 'vitest';
import {
  AMBIENCE_FULL_SPEED,
  CLIP_CEILING,
  CLIP_KNEE,
  ENGINE_HARMONICS,
  FIRING_HARMONIC,
  FULL_IMPACT,
  MIN_IMPACT,
  SQUEAL_MAX_HZ,
  SQUEAL_MIN_HZ,
  ambienceMix,
  clipCurve,
  createAmbienceMix,
  createEngineTone,
  createTyreMix,
  engineHarmonicLevel,
  engineTone,
  engineWave,
  gritCurve,
  impactStrength,
  smoothstep,
  tyreMix,
} from '../../src/audio/mapping';
import type { EngineWaveKind, TyreMix } from '../../src/audio/mapping';
import { IDLE_RPM, LIMITER_RPM, REDLINE_RPM } from '../../src/audio/rpm';
import { SQUEAL_MAKEUP } from '../../src/audio/tires';

/** Amplitude of harmonic k of a table. */
function magnitude(table: { real: Float32Array; imag: Float32Array }, k: number): number {
  return Math.hypot(table.real[k], table.imag[k]);
}

/** One period of the waveform a table describes. */
function render(table: { real: Float32Array; imag: Float32Array }, samples = 2048): Float64Array {
  const wave = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const angle = (2 * Math.PI * i) / samples;
    let value = 0;
    for (let k = 1; k < table.real.length; k++) {
      value += table.real[k] * Math.cos(k * angle) + table.imag[k] * Math.sin(k * angle);
    }
    wave[i] = value;
  }
  return wave;
}

function tone(rpm: number, torque: number, gate = 1, flutter = 0.5) {
  return engineTone(rpm, torque, gate, flutter, createEngineTone());
}

describe('engine spectra', () => {
  it('has no DC and as many harmonics as it says', () => {
    for (const kind of ['load', 'coast', 'pulse'] as EngineWaveKind[]) {
      const table = engineWave(kind);
      expect(table.real).toHaveLength(ENGINE_HARMONICS + 1);
      expect(table.imag).toHaveLength(ENGINE_HARMONICS + 1);
      expect(table.real[0]).toBe(0);
      expect(table.imag[0]).toBe(0);
      for (let k = 1; k <= ENGINE_HARMONICS; k++) {
        expect(Number.isFinite(table.real[k]) && Number.isFinite(table.imag[k])).toBe(true);
        expect(magnitude(table, k)).toBeCloseTo(engineHarmonicLevel(kind, k), 5);
      }
    }
  });

  it('is built on the firing frequency: 2nd engine order strongest, then the 4th and the 1st', () => {
    const table = engineWave('load');
    const firing = magnitude(table, FIRING_HARMONIC);
    for (let k = 1; k <= ENGINE_HARMONICS; k++) {
      if (k !== FIRING_HARMONIC) expect(magnitude(table, k)).toBeLessThan(firing);
    }
    const crank = magnitude(table, 2);
    const fourth = magnitude(table, 8);
    // Nothing else comes close to those three.
    for (let k = 1; k <= ENGINE_HARMONICS; k++) {
      if (k === 2 || k === 4 || k === 8) continue;
      expect(magnitude(table, k)).toBeLessThan(Math.min(crank, fourth));
    }
  });

  it('keeps the half orders weak: present for roughness, never louder than the whole orders beside them', () => {
    for (const kind of ['load', 'coast'] as EngineWaveKind[]) {
      const table = engineWave(kind);
      for (let k = 1; k <= 15; k += 2) {
        const half = magnitude(table, k);
        expect(half).toBeGreaterThan(0.01);
        expect(half).toBeLessThan(0.2);
        expect(half).toBeLessThan(magnitude(table, k + 1));
        if (k > 1) expect(half).toBeLessThan(magnitude(table, k - 1) + 1e-6);
      }
    }
  });

  it('is brighter on the throttle than off it', () => {
    const upperShare = (kind: EngineWaveKind): number => {
      let upper = 0;
      let total = 0;
      for (let k = 1; k <= ENGINE_HARMONICS; k++) {
        const power = engineHarmonicLevel(kind, k) ** 2;
        total += power;
        if (k > 16) upper += power;
      }
      return upper / total;
    };
    expect(upperShare('load')).toBeGreaterThan(upperShare('coast') * 3);
  });

  it('makes a waveform that repeats once per firing apart from the half-order roughness', () => {
    const wave = render(engineWave('load'));
    const quarter = wave.length / 4;
    let same = 0;
    let energy = 0;
    for (let i = 0; i < wave.length; i++) {
      same += wave[i] * wave[(i + quarter) % wave.length];
      energy += wave[i] * wave[i];
    }
    // Strongly, but not perfectly, periodic at the firing frequency.
    expect(same / energy).toBeGreaterThan(0.6);
    expect(same / energy).toBeLessThan(0.98);
  });

  it('pulses the combustion noise once per firing', () => {
    const table = engineWave('pulse');
    for (let k = 1; k <= ENGINE_HARMONICS; k++) {
      if (k !== FIRING_HARMONIC) expect(magnitude(table, k)).toBeLessThan(magnitude(table, FIRING_HARMONIC) * 0.5);
    }
  });
});

describe('waveshaper curves', () => {
  it('grit: monotonic, inside [-1, 1], through zero, nearly linear for small signals, lopsided for big ones', () => {
    const curve = gritCurve(1025);
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    expect(curve[0]).toBeGreaterThanOrEqual(-1);
    expect(curve[curve.length - 1]).toBeLessThanOrEqual(1);
    expect(Math.max(-curve[0], curve[curve.length - 1])).toBeCloseTo(1, 5);
    const mid = (curve.length - 1) / 2;
    expect(curve[mid]).toBeCloseTo(0, 6);
    // Small signals: the slope at 0.05 is within 15 % of the slope at 0.
    const slope = (a: number, b: number): number => (curve[b] - curve[a]) / (((b - a) * 2) / (curve.length - 1));
    expect(slope(mid + 20, mid + 30) / slope(mid - 2, mid + 2)).toBeGreaterThan(0.85);
    // Large signals are squashed, and not equally in both directions.
    expect(slope(curve.length - 11, curve.length - 1) / slope(mid - 2, mid + 2)).toBeLessThan(0.2);
    expect(Math.abs(curve[0] + curve[curve.length - 1])).toBeGreaterThan(0.02);
  });

  it('clip: transparent below the knee, never above the ceiling, symmetric', () => {
    const curve = clipCurve(2001);
    const x = (i: number): number => (2 * i) / (curve.length - 1) - 1;
    expect(CLIP_CEILING).toBeLessThan(1);
    expect(CLIP_CEILING).toBeGreaterThan(CLIP_KNEE);
    for (let i = 0; i < curve.length; i++) {
      if (Math.abs(x(i)) <= CLIP_KNEE) expect(curve[i]).toBeCloseTo(x(i), 6);
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(CLIP_CEILING + 1e-6);
      expect(curve[i]).toBeCloseTo(-curve[curve.length - 1 - i], 6);
      if (i > 0) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    }
    expect(curve[curve.length - 1]).toBeCloseTo(CLIP_CEILING, 6);
  });
});

describe('engineTone', () => {
  it('puts the firing frequency at rpm / 60 x 2 and the oscillators a quarter of that', () => {
    expect(tone(900, 0).firingHz).toBeCloseTo(30, 9);
    expect(tone(6000, 1).firingHz).toBeCloseTo(200, 9);
    expect(tone(7500, 1).firingHz).toBeCloseTo(250, 9);
    for (const rpm of [900, 3210, 7400]) {
      const mix = tone(rpm, 0.5);
      expect(mix.cycleHz * FIRING_HARMONIC).toBeCloseTo(mix.firingHz, 9);
    }
  });

  it('is fuller, brighter and louder on the throttle', () => {
    for (const rpm of [IDLE_RPM, 2500, 4500, 7000]) {
      const off = tone(rpm, 0, 1, 0);
      const half = tone(rpm, 0.5, 1, 0);
      const on = tone(rpm, 1, 1, 0);
      for (const [low, high] of [
        [off, half],
        [half, on],
      ]) {
        expect(high.loadGain).toBeGreaterThan(low.loadGain);
        expect(high.coastGain).toBeLessThan(low.coastGain);
        expect(high.drive).toBeGreaterThan(low.drive);
        expect(high.cutoff).toBeGreaterThan(low.cutoff);
        expect(high.noiseGain).toBeGreaterThan(low.noiseGain);
        expect(high.sawGain).toBeGreaterThan(low.sawGain);
        expect(high.level).toBeGreaterThan(low.level);
      }
      // On the throttle the firing-order spectrum leads; off it the coasting one does.
      expect(on.loadGain).toBeGreaterThan(on.coastGain * 3);
      expect(off.coastGain).toBeGreaterThan(off.loadGain * 3);
    }
  });

  it('opens the filters as the revs rise', () => {
    for (const torque of [0, 0.5, 1]) {
      let last = tone(IDLE_RPM, torque);
      for (let rpm = IDLE_RPM + 300; rpm <= LIMITER_RPM; rpm += 300) {
        const next = tone(rpm, torque);
        expect(next.cutoff).toBeGreaterThan(last.cutoff);
        expect(next.sawCutoff).toBeGreaterThan(last.sawCutoff);
        expect(next.firingHz).toBeGreaterThan(last.firingHz);
        last = next;
      }
    }
  });

  it('scales the level, and nothing else, with the shift and limiter gate', () => {
    const open = tone(6000, 1, 1);
    const dipped = tone(6000, 1, 0.45);
    expect(dipped.level).toBeCloseTo(open.level * 0.45, 9);
    expect(dipped.cutoff).toBe(open.cutoff);
    expect(dipped.firingHz).toBe(open.firingHz);
    expect(tone(6000, 1, 0).level).toBe(0);
    expect(tone(6000, 1, 7).level).toBe(open.level);
  });

  it('burbles on the overrun only: flutter matters off the throttle with the revs up, nowhere else', () => {
    const calm = tone(5500, 0, 1, 0);
    const pop = tone(5500, 0, 1, 1);
    expect(pop.level).toBeLessThan(calm.level * 0.9);
    expect(pop.level).toBeGreaterThan(calm.level * 0.5);
    expect(pop.noiseGain).toBeGreaterThan(calm.noiseGain * 1.3);
    // Pulling: no flutter at all.
    expect(tone(5500, 1, 1, 1)).toEqual(tone(5500, 1, 1, 0));
    // Idling: none either.
    expect(tone(IDLE_RPM, 0, 1, 1)).toEqual(tone(IDLE_RPM, 0, 1, 0));
  });

  it('keeps the saw layer well under the engine itself', () => {
    for (const rpm of [IDLE_RPM, 3000, REDLINE_RPM]) {
      for (const torque of [0, 1]) {
        const mix = tone(rpm, torque);
        // Two saws against harmonics that peak at loadGain + coastGain before the body filters.
        expect(mix.sawGain * 2).toBeLessThan((mix.loadGain + mix.coastGain) * mix.drive * 0.7);
      }
    }
  });

  it('stays in a range the filters and the waveshaper can take, for any input', () => {
    for (const rpm of [0, IDLE_RPM, 2000, 5000, REDLINE_RPM, 9000]) {
      for (const torque of [-1, 0, 0.3, 1, 4]) {
        for (const flutter of [-1, 0, 0.5, 1, 3]) {
          const mix = tone(rpm, torque, 1, flutter);
          for (const value of Object.values(mix)) expect(Number.isFinite(value)).toBe(true);
          expect(mix.cutoff).toBeGreaterThanOrEqual(300);
          expect(mix.cutoff).toBeLessThanOrEqual(8000);
          expect(mix.sawCutoff).toBeGreaterThanOrEqual(200);
          expect(mix.sawCutoff).toBeLessThanOrEqual(4000);
          // The harmonics peak at 1 each; with the drive they must not slam the ends of the shaper curve.
          expect((mix.loadGain + mix.coastGain) * mix.drive).toBeLessThanOrEqual(0.8);
          expect(mix.level).toBeGreaterThanOrEqual(0);
          expect(mix.level).toBeLessThanOrEqual(0.6);
          expect(mix.loadGain).toBeGreaterThanOrEqual(0);
          expect(mix.coastGain).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('writes into the object it is given', () => {
    const out = createEngineTone();
    expect(engineTone(4000, 0.5, 1, 0.5, out)).toBe(out);
  });
});

describe('tyreMix', () => {
  /**
   * How loud each layer is per unit of gain: RMS of white noise (uniform, +-1) after the layer's filters, measured
   * by rendering the filter chains offline. The squeal figure is before its make-up gain.
   */
  const SCRUB_RMS = 0.14;
  const SQUEAL_RMS = 0.033 * SQUEAL_MAKEUP;

  interface Options {
    front?: number;
    handbrake?: boolean;
    airborne?: boolean;
    wobble?: number;
  }

  function mix(speed: number, rear: number, drift: number, options: Options = {}): TyreMix {
    return tyreMix(
      speed,
      rear,
      options.front ?? 0,
      drift,
      options.handbrake ?? false,
      options.airborne ?? false,
      options.wobble ?? 0,
      createTyreMix(),
    );
  }
  const scrub = (m: TyreMix): number => m.scrubGain * SCRUB_RMS;
  const squeal = (m: TyreMix): number => m.squealGain * SQUEAL_RMS;

  it('is silent with no slide, when stopped, and in the air', () => {
    expect(mix(30, 0, 0)).toMatchObject({ scrubGain: 0, squealGain: 0 });
    expect(mix(0, 1, 1)).toMatchObject({ scrubGain: 0, squealGain: 0 });
    expect(mix(1.5, 1, 1, { handbrake: true })).toMatchObject({ scrubGain: 0, squealGain: 0 });
    expect(mix(30, 1, 0.8, { airborne: true })).toMatchObject({ scrubGain: 0, squealGain: 0 });
    expect(mix(30, 1, 0.8, { airborne: true, handbrake: true })).toMatchObject({ scrubGain: 0, squealGain: 0 });
  });

  it('squeals at a moderate slide', () => {
    for (const speed of [12, 20, 35]) {
      for (const slide of [0.3, 0.45, 0.6]) {
        const m = mix(speed, slide, 0.15);
        expect(squeal(m)).toBeGreaterThan(scrub(m) * 3);
        expect(squeal(m)).toBeGreaterThan(0.01);
      }
    }
    // The front tyres squeal as well (understeer).
    const front = mix(20, 0, 0.05, { front: 0.5 });
    expect(squeal(front)).toBeGreaterThan(scrub(front) * 3);
  });

  it('scrubs when fully sideways', () => {
    for (const speed of [12, 20, 35]) {
      const m = mix(speed, 1, 1.1);
      expect(scrub(m)).toBeGreaterThan(squeal(m) * 3);
      expect(scrub(m)).toBeGreaterThan(0.03);
    }
  });

  it('scrubs on the handbrake, whatever the angle', () => {
    for (const drift of [0, 0.3, 1.2]) {
      const m = mix(25, 1, drift, { handbrake: true });
      expect(scrub(m)).toBeGreaterThan(squeal(m) * 3);
    }
  });

  it('moves from squeal to scrub as a slide turns into going sideways', () => {
    let last = mix(25, 1, 0.3);
    expect(squeal(last)).toBeGreaterThan(scrub(last));
    for (let drift = 0.4; drift <= 1.01; drift += 0.1) {
      const next = mix(25, 1, drift);
      expect(next.scrubGain).toBeGreaterThanOrEqual(last.scrubGain);
      expect(next.squealGain).toBeLessThanOrEqual(last.squealGain);
      last = next;
    }
    expect(scrub(last)).toBeGreaterThan(squeal(last));
    // Left and right slides sound the same.
    expect(mix(25, 1, -0.7)).toEqual(mix(25, 1, 0.7));
  });

  it('gets louder with speed and with slide', () => {
    expect(mix(8, 0.5, 0.2).squealGain).toBeGreaterThan(mix(4, 0.5, 0.2).squealGain);
    expect(mix(20, 0.3, 0.2).squealGain).toBeGreaterThan(mix(20, 0.15, 0.2).squealGain);
    expect(mix(30, 1, 1).scrubGain).toBeGreaterThan(mix(10, 1, 1).scrubGain);
  });

  it('keeps the squeal between 700 and 1300 Hz, higher with speed and slide, nudged by the wobble', () => {
    expect(mix(30, 0.5, 0.2).squealHz).toBeGreaterThan(mix(10, 0.5, 0.2).squealHz);
    expect(mix(20, 0.9, 0.2).squealHz).toBeGreaterThan(mix(20, 0.3, 0.2).squealHz);
    expect(mix(20, 0.5, 0.2, { wobble: 1 }).squealHz).toBeGreaterThan(mix(20, 0.5, 0.2, { wobble: -1 }).squealHz);
    expect(mix(20, 0.5, 0.2, { wobble: 1 }).squealHz - mix(20, 0.5, 0.2, { wobble: -1 }).squealHz).toBeLessThan(120);
    for (const speed of [0, 5, 20, 45, 200]) {
      for (const slide of [0, 0.5, 1, 3]) {
        for (const wobble of [-1, 0, 1]) {
          const m = mix(speed, slide, 0.5, { wobble });
          expect(m.squealHz).toBeGreaterThanOrEqual(SQUEAL_MIN_HZ);
          expect(m.squealHz).toBeLessThanOrEqual(SQUEAL_MAX_HZ);
          expect(m.scrubHz).toBeGreaterThan(300);
          expect(m.scrubHz).toBeLessThan(1500);
          expect(m.scrubGain).toBeLessThanOrEqual(0.6);
          expect(m.squealGain).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('ambienceMix', () => {
  const mix = (speed: number, airborne = false) => ambienceMix(speed, airborne, createAmbienceMix());

  it('is silent at rest and grows with speed up to a limit', () => {
    expect(mix(0)).toMatchObject({ windGain: 0, roadGain: 0 });
    let last = mix(0);
    for (let speed = 5; speed <= AMBIENCE_FULL_SPEED; speed += 5) {
      const next = mix(speed);
      expect(next.windGain).toBeGreaterThan(last.windGain);
      expect(next.windHz).toBeGreaterThan(last.windHz);
      expect(next.roadGain).toBeGreaterThan(last.roadGain);
      expect(next.roadHz).toBeGreaterThan(last.roadHz);
      last = next;
    }
    expect(mix(500)).toEqual(mix(AMBIENCE_FULL_SPEED));
  });

  it('stays subtle', () => {
    expect(mix(AMBIENCE_FULL_SPEED).windGain).toBeLessThanOrEqual(0.2);
    expect(mix(AMBIENCE_FULL_SPEED).roadGain).toBeLessThanOrEqual(0.3);
    // At town speeds there is next to no wind.
    expect(mix(12).windGain).toBeLessThan(mix(AMBIENCE_FULL_SPEED).windGain * 0.1);
  });

  it('loses the road, but not the wind, in the air', () => {
    expect(mix(30, true).roadGain).toBe(0);
    expect(mix(30, true).windGain).toBeGreaterThan(mix(30).windGain);
  });
});

describe('helpers', () => {
  it('smoothstep', () => {
    expect(smoothstep(1, 3, 0)).toBe(0);
    expect(smoothstep(1, 3, 2)).toBe(0.5);
    expect(smoothstep(1, 3, 9)).toBe(1);
  });

  it('impactStrength: nothing for a touch, full for a big hit, zero for nonsense', () => {
    expect(impactStrength(MIN_IMPACT * 0.9)).toBe(0);
    expect(impactStrength(MIN_IMPACT)).toBeGreaterThan(0);
    expect(impactStrength(FULL_IMPACT / 2)).toBeCloseTo(0.5, 9);
    expect(impactStrength(FULL_IMPACT * 3)).toBe(1);
    expect(impactStrength(Number.NaN)).toBe(0);
    expect(impactStrength(-5)).toBe(0);
  });
});
