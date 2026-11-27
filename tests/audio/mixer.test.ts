import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAudio } from '../../src/audio/mixer';
import type { BlipKind, GameAudio } from '../../src/audio/mixer';
import { CLIP_CEILING } from '../../src/audio/mapping';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import type { CarState } from '../../src/types';
import { FakeAudioContext, FakeNode } from './fakeAudio';
import type { FakeParam } from './fakeAudio';

type Listener = () => void;

/** Just enough of `document` for the audio's tab-visibility handling. */
class FakeDocument {
  hidden = false;
  readonly listeners = new Set<Listener>();

  addEventListener(type: string, listener: Listener): void {
    if (type === 'visibilitychange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'visibilitychange') this.listeners.delete(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of [...this.listeners]) listener();
  }
}

const scope = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown; document?: unknown };
let fakeDocument: FakeDocument;

beforeEach(() => {
  FakeAudioContext.instances = [];
  scope.AudioContext = FakeAudioContext;
  fakeDocument = new FakeDocument();
  scope.document = fakeDocument;
});

afterEach(() => {
  delete scope.AudioContext;
  delete scope.webkitAudioContext;
  delete scope.document;
});

function car(overrides: Partial<CarState> = {}): CarState {
  return {
    x: 0,
    z: 0,
    heading: 0,
    vx: 0,
    vz: 0,
    yawRate: 0,
    steerAngle: 0,
    reversing: false,
    speed: 0,
    forwardSpeed: 0,
    lateralSpeed: 0,
    driftAngle: 0,
    slipFront: 0,
    slipRear: 0,
    rearSlide: 0,
    frontSlide: 0,
    accelLong: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    y: 0,
    vy: 0,
    airborne: false,
    ...overrides,
  };
}

function started(): { audio: GameAudio; ctx: FakeAudioContext } {
  const audio = createAudio();
  audio.resume();
  expect(FakeAudioContext.instances).toHaveLength(1);
  return { audio, ctx: FakeAudioContext.instances[0] };
}

/** The fixed end of the graph, found by walking back from the speakers. */
interface MasterChain {
  clipper: FakeNode;
  limiter: FakeNode;
  mute: FakeNode;
  master: FakeNode;
}

function masterChain(ctx: FakeAudioContext): MasterChain {
  expect(ctx.destination.inputs).toHaveLength(1);
  const clipper = ctx.destination.inputs[0];
  expect(clipper.inputs).toHaveLength(1);
  const limiter = clipper.inputs[0];
  expect(limiter.inputs).toHaveLength(1);
  const mute = limiter.inputs[0];
  expect(mute.inputs).toHaveLength(1);
  const master = mute.inputs[0];
  return { clipper, limiter, mute, master };
}

function gain(node: FakeNode): FakeParam {
  return node.params.gain;
}

/** Run `frames` rendered frames of `state`, 1/60 s apart. */
function drive(audio: GameAudio, ctx: FakeAudioContext, state: CarState, frames: number, active = true): void {
  for (let i = 0; i < frames; i++) {
    ctx.currentTime += 1 / 60;
    audio.update(state, DEFAULT_CAR_PARAMS, active);
  }
}

const ALL_BLIPS: BlipKind[] = ['countdown', 'go', 'checkpoint', 'finish', 'reset', 'crash', 'death', 'land'];

describe('audio without WebAudio', () => {
  it('is a silent no-op when there is no AudioContext at all', () => {
    delete scope.AudioContext;
    const audio = createAudio();
    expect(() => {
      audio.resume();
      audio.update(car(), DEFAULT_CAR_PARAMS, true);
      audio.collision(10);
      for (const kind of ALL_BLIPS) audio.blip(kind);
      audio.setVolume(0.3);
      audio.setMuted(true);
      audio.setMuted(false);
      audio.dispose();
    }).not.toThrow();
  });

  it('uses the prefixed constructor where that is all there is', () => {
    delete scope.AudioContext;
    scope.webkitAudioContext = FakeAudioContext;
    createAudio().resume();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('does nothing before resume()', () => {
    const audio = createAudio();
    audio.update(car({ speed: 20, throttle: 1 }), DEFAULT_CAR_PARAMS, true);
    audio.collision(10);
    for (const kind of ALL_BLIPS) audio.blip(kind);
    audio.setVolume(0.8);
    audio.setMuted(true);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('gives up quietly if the context cannot be built', () => {
    scope.AudioContext = class {
      constructor() {
        throw new Error('no audio device');
      }
    };
    const audio = createAudio();
    expect(() => {
      audio.resume();
      audio.update(car(), DEFAULT_CAR_PARAMS, true);
      audio.blip('go');
      audio.setMuted(true);
      audio.resume();
    }).not.toThrow();
  });
});

describe('audio graph', () => {
  it('ends in volume -> mute -> limiter -> clipper -> speakers, with no way round', () => {
    const { ctx } = started();
    const { clipper, limiter, mute, master } = masterChain(ctx);
    expect(clipper.kind).toBe('waveShaper');
    expect(limiter.kind).toBe('compressor');
    expect(mute.kind).toBe('gain');
    expect(master.kind).toBe('gain');
    expect(gain(master).value).toBe(0.5);
    expect(gain(mute).value).toBe(1);
    // The clipper's curve cannot output more than its ceiling, so nothing can clip the speakers.
    const curve = clipper.curve;
    expect(curve).not.toBeNull();
    if (curve) for (const y of curve) expect(Math.abs(y)).toBeLessThanOrEqual(CLIP_CEILING + 1e-6);
    // Everything else has to go through the volume control.
    for (const node of ctx.nodes) {
      if (node === master || node === mute || node === limiter || node === clipper) continue;
      for (const output of node.outputs) {
        expect(output).not.toBe(mute);
        expect(output).not.toBe(limiter);
        expect(output).not.toBe(clipper);
        expect(output).not.toBe(ctx.destination);
      }
    }
  });

  it('leaves no node dangling: every source is running and heard, every node is fed and leads to the speakers', () => {
    const { ctx } = started();
    const sources = ctx.nodes.filter((node) => node.isSource);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.started).toBe(true);
      expect(source.stopped).toBe(false);
      expect(source.reaches(ctx.destination)).toBe(true);
      if (source.kind === 'bufferSource') {
        expect(source.loop).toBe(true);
        expect(source.buffer).not.toBeNull();
      }
    }
    for (const node of ctx.nodes) {
      expect(node.reaches(ctx.destination)).toBe(true);
      if (!node.isSource) expect(node.inputs.length).toBeGreaterThan(0);
    }
  });

  it('builds the engine from three in-phase cycle oscillators and two detuned saws', () => {
    const { ctx } = started();
    const oscillators = ctx.ofKind('oscillator');
    const custom = oscillators.filter((o) => o.type === 'custom');
    const saws = oscillators.filter((o) => o.type === 'sawtooth');
    expect(custom).toHaveLength(3);
    expect(saws).toHaveLength(2);
    expect(oscillators).toHaveLength(5);
    // Same start, same frequency: they can never drift apart.
    expect(new Set(custom.map((o) => o.startTime)).size).toBe(1);
    expect(new Set(custom.map((o) => o.params.frequency.value)).size).toBe(1);
    expect(new Set(custom.map((o) => o.wave)).size).toBe(3);
    // The saws sit at the firing frequency, four times the cycle frequency, a few cents apart.
    for (const saw of saws) expect(saw.params.frequency.value).toBeCloseTo(custom[0].params.frequency.value * 4, 9);
    const detunes = saws.map((s) => s.params.detune.value).sort((a, b) => a - b);
    expect(detunes[0]).toBeLessThan(0);
    expect(detunes[1]).toBe(-detunes[0]);
    expect(detunes[1]).toBeLessThan(20);

    // Two of the cycle oscillators are heard; the third only modulates the gain that pulses the combustion noise.
    const modulators = custom.filter((o) =>
      o.outputs.every((out) => !(out instanceof FakeNode) || out.kind === 'gain'),
    );
    const pulse = custom.find((o) => {
      const depth = o.outputs[0];
      return depth instanceof FakeNode && depth.outputs.length === 1 && !(depth.outputs[0] instanceof FakeNode);
    });
    expect(modulators).toHaveLength(3);
    expect(pulse).toBeDefined();
    if (!pulse) return;
    const depth = pulse.outputs[0] as FakeNode;
    const pulsed = (depth.outputs[0] as FakeParam).owner;
    expect(pulsed.kind).toBe('gain');
    // Base 0.5 plus a swing of 0.5: the gain runs between 0 and 1.
    expect(gain(pulsed).value).toBe(0.5);
    expect(gain(depth).value).toBe(0.5);
    // What it pulses is band-passed noise.
    expect(pulsed.inputs).toHaveLength(1);
    expect(pulsed.inputs[0]).toMatchObject({ kind: 'biquad', type: 'bandpass' });
    expect(pulsed.inputs[0].inputs[0].kind).toBe('bufferSource');
  });

  it('runs the combustion through a waveshaper, a bank of fixed resonances, a low-pass and a rumble filter', () => {
    const { ctx } = started();
    const { clipper } = masterChain(ctx);
    const shapers = ctx.ofKind('waveShaper').filter((node) => node !== clipper);
    expect(shapers).toHaveLength(1);
    const shaper = shapers[0];
    expect(shaper.oversample).toBe('2x');
    expect(shaper.curve?.length).toBeGreaterThan(256);
    // In: one drive gain, fed by the two harmonic levels and the noise level.
    expect(shaper.inputs).toHaveLength(1);
    const driveGain = shaper.inputs[0];
    expect(driveGain.kind).toBe('gain');
    expect(driveGain.inputs).toHaveLength(3);
    for (const input of driveGain.inputs) expect(input.kind).toBe('gain');
    // Out: a dry path and at least three band-passes at different, fixed frequencies...
    const formants = shaper.outputs.filter((o): o is FakeNode => o instanceof FakeNode && o.kind === 'biquad');
    const dry = shaper.outputs.filter((o): o is FakeNode => o instanceof FakeNode && o.kind === 'gain');
    expect(formants.length).toBeGreaterThanOrEqual(3);
    expect(dry).toHaveLength(1);
    expect(gain(dry[0]).value).toBeLessThan(0.5);
    const centres = formants.map((f) => f.params.frequency.value);
    expect(new Set(centres).size).toBe(formants.length);
    for (const formant of formants) {
      expect(formant.type).toBe('bandpass');
      expect(formant.params.frequency.value).toBeGreaterThan(100);
      expect(formant.params.frequency.value).toBeLessThan(4000);
      expect(formant.params.Q.value).toBeGreaterThan(0.7);
      expect(formant.params.Q.value).toBeLessThan(6);
    }
    // ...all meeting again in one low-pass, then a high-pass, then the engine's output gain.
    const tone = (dry[0].outputs[0] as FakeNode) ?? null;
    expect(tone).toMatchObject({ kind: 'biquad', type: 'lowpass' });
    for (const formant of formants) {
      const level = formant.outputs[0] as FakeNode;
      expect(level.kind).toBe('gain');
      expect(level.outputs[0]).toBe(tone);
    }
    expect(tone.inputs).toHaveLength(formants.length + 1);
    const rumble = tone.outputs[0] as FakeNode;
    expect(rumble).toMatchObject({ kind: 'biquad', type: 'highpass' });
    const output = rumble.outputs[0] as FakeNode;
    expect(output.kind).toBe('gain');
    expect(output.outputs[0]).toBe(masterChain(ctx).master);
    // The saw layer joins at the output through its own low-pass: it is not distorted with the engine.
    const sawFilter = output.inputs.find((node) => node !== rumble);
    expect(sawFilter).toMatchObject({ kind: 'biquad', type: 'lowpass' });
    expect(sawFilter?.inputs[0].inputs.every((node) => node.type === 'sawtooth')).toBe(true);
  });

  it('is silent until the first update: every voice enters the master through a closed gain', () => {
    const { ctx } = started();
    const { master } = masterChain(ctx);
    // Engine, tyre scrub, tyre squeal, wind, road.
    expect(master.inputs).toHaveLength(5);
    for (const voice of master.inputs) {
      expect(voice.kind).toBe('gain');
      expect(gain(voice).value).toBe(0);
    }
  });
});

describe('audio.update', () => {
  it('tunes the oscillators to the revs: cycle = rpm / 120, saws at the firing frequency', () => {
    const { audio, ctx } = started();
    drive(audio, ctx, car({ speed: 15, forwardSpeed: 15, throttle: 1 }), 120);
    const oscillators = ctx.ofKind('oscillator');
    const custom = oscillators.filter((o) => o.type === 'custom');
    const saws = oscillators.filter((o) => o.type === 'sawtooth');
    const cycle = custom[0].params.frequency.settled;
    // 15 m/s is second gear, mid-range. (The pitch wanders by a fraction of a percent, never more.)
    expect(cycle * 120).toBeGreaterThan(4000);
    expect(cycle * 120).toBeLessThan(7400);
    for (const o of custom) {
      expect(o.params.frequency.settled).toBe(cycle);
      expect(o.params.frequency.events).toEqual(custom[0].params.frequency.events);
    }
    for (const saw of saws) expect(saw.params.frequency.settled).toBeCloseTo(cycle * 4, 6);
    const settledEvents = custom[0].params.frequency.events.length;
    drive(audio, ctx, car({ speed: 15, forwardSpeed: 15, throttle: 1 }), 120);
    const pitches = custom[0].params.frequency.events.slice(settledEvents).map((event) => event.value);
    expect(pitches.length).toBeGreaterThan(5);
    expect(Math.max(...pitches) / Math.min(...pitches)).toBeGreaterThan(1.001);
    expect(Math.max(...pitches) / Math.min(...pitches)).toBeLessThan(1.006);
  });

  it('idles at 900 rpm with the car at rest', () => {
    const { audio, ctx } = started();
    drive(audio, ctx, car(), 30);
    const custom = ctx.ofKind('oscillator').filter((o) => o.type === 'custom');
    expect(custom[0].params.frequency.settled * 120).toBeGreaterThan(900 * 0.997);
    expect(custom[0].params.frequency.settled * 120).toBeLessThan(900 * 1.003);
    const { master } = masterChain(ctx);
    const engineOut = master.inputs[0];
    expect(gain(engineOut).settled).toBeGreaterThan(0.02);
  });

  it('opens up and gets louder with the throttle', () => {
    const { audio, ctx } = started();
    const { master } = masterChain(ctx);
    const engineOut = master.inputs[0];
    const tone = ctx.nodes.find((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.inputs.length >= 4);
    expect(tone).toBeDefined();
    if (!tone) return;
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20 }), 60);
    const coastLevel = gain(engineOut).settled;
    const coastCutoff = tone.params.frequency.settled;
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 60);
    expect(gain(engineOut).settled).toBeGreaterThan(coastLevel);
    expect(tone.params.frequency.settled).toBeGreaterThan(coastCutoff + 500);
  });

  it('only ever schedules smooth glides with sane values', () => {
    const { audio, ctx } = started();
    const states = [
      car(),
      car({ speed: 8, forwardSpeed: 8, throttle: 1, rearSlide: 0.6, driftAngle: 0.3 }),
      car({ speed: 30, forwardSpeed: 24, throttle: 1, rearSlide: 1, driftAngle: 0.9 }),
      car({ speed: 30, forwardSpeed: 28, handbrake: true, rearSlide: 1 }),
      car({ speed: 25, forwardSpeed: 25, throttle: 1, airborne: true, y: 1.2, vy: 3 }),
      car({ speed: 4, forwardSpeed: -4, brake: 1, reversing: true }),
      car({ speed: 40, forwardSpeed: 40 }),
    ];
    for (const state of states) drive(audio, ctx, state, 45);
    drive(audio, ctx, states[2], 20, false);
    let events = 0;
    for (const node of ctx.nodes) {
      for (const param of Object.values(node.params)) {
        for (const event of param.events) {
          events++;
          expect(event.kind).toBe('target');
          expect(event.timeConstant).toBeGreaterThan(0.005);
          expect(event.timeConstant).toBeLessThan(0.2);
          if (node.kind === 'biquad' && param.name === 'frequency') {
            expect(event.value).toBeGreaterThan(30);
            expect(event.value).toBeLessThan(12000);
          }
          if (node.kind === 'oscillator' && param.name === 'frequency') {
            expect(event.value).toBeGreaterThanOrEqual((900 / 120) * 0.997);
            expect(event.value).toBeLessThanOrEqual((7500 / 30) * 1.003);
          }
          if (param.name === 'gain') {
            expect(event.value).toBeGreaterThanOrEqual(0);
            expect(event.value).toBeLessThan(3);
          }
        }
      }
    }
    expect(events).toBeGreaterThan(100);
  });

  it('schedules nothing while nothing changes', () => {
    const { audio, ctx } = started();
    const count = (): number =>
      ctx.nodes.reduce((sum, node) => {
        let total = sum;
        for (const param of Object.values(node.params)) total += param.events.length;
        return total;
      }, 0);
    // Paused in a menu: the car is frozen and so, after the fade is scheduled, is every parameter but the
    // squeal's wandering pitch (three filters).
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 60);
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 5, false);
    const before = count();
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 100, false);
    expect(count() - before).toBeLessThanOrEqual(300);
  });

  it('fades every voice out when inactive and holds the revs', () => {
    const { audio, ctx } = started();
    const { master } = masterChain(ctx);
    const sliding = car({ speed: 30, forwardSpeed: 26, throttle: 1, rearSlide: 0.5, driftAngle: 0.3 });
    drive(audio, ctx, sliding, 90);
    const loud = master.inputs.map((voice) => gain(voice).settled);
    // Engine, squeal, wind and road are all sounding (scrub needs a bigger slide).
    expect(loud.filter((level) => level > 0).length).toBeGreaterThanOrEqual(4);
    const cycle = ctx.ofKind('oscillator')[0].params.frequency.settled;
    drive(audio, ctx, car(), 30, false);
    for (const voice of master.inputs) expect(gain(voice).settled).toBe(0);
    // (To within the pitch wander, which stops while inactive.)
    expect(Math.abs(ctx.ofKind('oscillator')[0].params.frequency.settled / cycle - 1)).toBeLessThan(0.003);
    // And back.
    drive(audio, ctx, sliding, 5);
    expect(master.inputs.filter((voice) => gain(voice).settled > 0).length).toBeGreaterThanOrEqual(4);
  });

  it('silences the tyres and the road in the air, but not the engine or the wind', () => {
    const { audio, ctx } = started();
    const { master } = masterChain(ctx);
    const sliding = car({ speed: 30, forwardSpeed: 22, throttle: 1, rearSlide: 1, driftAngle: 0.7 });
    drive(audio, ctx, sliding, 60);
    const grounded = master.inputs.map((voice) => gain(voice).settled);
    expect(grounded.every((level) => level > 0)).toBe(true);
    drive(audio, ctx, { ...sliding, airborne: true, y: 1 }, 10);
    const flying = master.inputs.map((voice) => gain(voice).settled);
    expect(flying.filter((level) => level === 0)).toHaveLength(3);
    expect(flying.filter((level) => level > 0)).toHaveLength(2);
    // The engine is the first voice built.
    expect(flying[0]).toBeGreaterThan(0);
  });

  it('does nothing while the context is suspended', () => {
    const { audio, ctx } = started();
    ctx.setState('suspended');
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 10);
    audio.collision(12);
    for (const node of ctx.nodes) for (const param of Object.values(node.params)) expect(param.events).toHaveLength(0);
    expect(ctx.running).toHaveLength(ctx.nodes.filter((n) => n.isSource).length);
  });
});

describe('volume and mute', () => {
  it('fades to exact silence and back in about 40 ms, leaving the volume alone', () => {
    const { audio, ctx } = started();
    const { master, mute } = masterChain(ctx);
    audio.setVolume(0.8);
    const volumeEvents = gain(master).events.length;
    ctx.currentTime = 2;
    audio.setMuted(true);
    const fade = gain(mute).events.find((event) => event.kind === 'target');
    expect(fade).toMatchObject({ value: 0, time: 2 });
    // Three time constants is 95 % of the way.
    expect((fade?.timeConstant ?? 0) * 3).toBeGreaterThan(0.025);
    expect((fade?.timeConstant ?? 0) * 3).toBeLessThan(0.06);
    expect(gain(mute).settled).toBe(0);
    expect(gain(master).events).toHaveLength(volumeEvents);
    expect(gain(master).settled).toBe(0.8);

    ctx.currentTime = 5;
    audio.setMuted(false);
    expect(gain(mute).settled).toBe(1);
    const back = gain(mute).events.filter((event) => event.kind === 'target').pop();
    expect(back).toMatchObject({ value: 1, time: 5 });
    expect(gain(master).settled).toBe(0.8);
  });

  it('survives being toggled faster than the fade', () => {
    const { audio, ctx } = started();
    const { mute } = masterChain(ctx);
    ctx.currentTime = 1;
    audio.setMuted(true);
    ctx.currentTime = 1.02;
    audio.setMuted(false);
    // The pin to zero that the first call left for t = 1.12 must be gone, or the sound would cut out again.
    const pins = gain(mute).events.filter((event) => event.kind === 'set');
    expect(pins).toHaveLength(1);
    expect(pins[0].value).toBe(1);
    expect(gain(mute).settled).toBe(1);
  });

  it('schedules nothing when the state does not change', () => {
    const { audio, ctx } = started();
    const { mute } = masterChain(ctx);
    audio.setMuted(false);
    expect(gain(mute).events).toHaveLength(0);
    audio.setMuted(true);
    const count = gain(mute).events.length;
    audio.setMuted(true);
    expect(gain(mute).events).toHaveLength(count);
  });

  it('keeps volume changes off the mute switch', () => {
    const { audio, ctx } = started();
    const { master, mute } = masterChain(ctx);
    audio.setMuted(true);
    const count = gain(mute).events.length;
    audio.setVolume(1);
    audio.setVolume(0);
    audio.setVolume(Number.NaN);
    expect(gain(mute).events).toHaveLength(count);
    expect(gain(mute).settled).toBe(0);
    expect(gain(master).settled).toBe(0.5);
    audio.setVolume(7);
    expect(gain(master).settled).toBe(1);
  });

  it('remembers a mute and a volume set before the context exists', () => {
    const audio = createAudio();
    audio.setMuted(true);
    audio.setVolume(0.9);
    audio.resume();
    const ctx = FakeAudioContext.instances[0];
    const { master, mute } = masterChain(ctx);
    expect(gain(mute).value).toBe(0);
    expect(gain(master).value).toBe(0.9);
    // resume() again (every input event calls it) changes nothing.
    audio.resume();
    audio.resume();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(gain(mute).settled).toBe(0);
    audio.setMuted(false);
    expect(gain(mute).settled).toBe(1);
  });

  it('stays muted through a suspend and resume', () => {
    const { audio, ctx } = started();
    const { mute } = masterChain(ctx);
    audio.setMuted(true);
    fakeDocument.setHidden(true);
    expect(ctx.state).toBe('suspended');
    fakeDocument.setHidden(false);
    audio.resume();
    expect(ctx.state).toBe('running');
    expect(gain(mute).settled).toBe(0);
  });
});

describe('cues', () => {
  it.each(ALL_BLIPS)('%s: every source starts, stops, is enveloped and cleans up after itself', (kind) => {
    const { audio, ctx } = started();
    const { master } = masterChain(ctx);
    const voices = master.inputs.length;
    const existing = new Set(ctx.nodes);
    ctx.currentTime = 3;
    audio.blip(kind);
    const created = ctx.nodes.filter((node) => !existing.has(node));
    const sources = created.filter((node) => node.isSource);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.started).toBe(true);
      expect(source.stopped).toBe(true);
      expect(source.startTime).toBeGreaterThanOrEqual(3);
      expect(source.stopTime).toBeGreaterThan(source.startTime);
      expect(source.reaches(ctx.destination)).toBe(true);
      expect(source.reaches(master)).toBe(true);
    }
    // Each one enters the master through its own envelope: up from near-silence, then an exponential decay.
    const envelopes = master.inputs.slice(voices);
    expect(envelopes).toHaveLength(sources.length);
    for (const envelope of envelopes) {
      const events = gain(envelope).events;
      const kinds = events.map((event) => event.kind);
      // (A sustained tone holds its peak with one more 'set' before the decay.)
      if (kinds.length === 4) {
        expect(kinds).toEqual(['set', 'linear', 'set', 'exponential']);
        expect(events[2].value).toBe(events[1].value);
        expect(events[2].time).toBeGreaterThan(events[1].time);
        expect(events[2].time).toBeLessThan(events[3].time);
      } else {
        expect(kinds).toEqual(['set', 'linear', 'exponential']);
      }
      const [from, peak] = events;
      const to = events[events.length - 1];
      expect(from.value).toBeLessThan(0.001);
      expect(peak.value).toBeGreaterThan(0.05);
      expect(peak.value).toBeLessThan(2.5);
      expect(peak.time - from.time).toBeLessThan(0.02);
      expect(to.value).toBeLessThan(0.001);
      expect(to.time).toBeGreaterThan(peak.time);
    }
    for (const node of created) expect(node.reaches(ctx.destination)).toBe(true);
    // When they end, nothing of the cue is left on the master.
    ctx.currentTime = 10;
    ctx.finishEnded();
    expect(master.inputs).toHaveLength(voices);
  });

  function cueSources(kind: BlipKind): { ctx: FakeAudioContext; sources: FakeNode[] } {
    const { audio, ctx } = started();
    const existing = new Set(ctx.nodes);
    audio.blip(kind);
    return { ctx, sources: ctx.nodes.filter((node) => !existing.has(node) && node.isSource) };
  }

  const glide = (node: FakeNode): { from: number; to: number } => {
    const events = node.params.frequency.events;
    return { from: events[0].value, to: events[events.length - 1].value };
  };

  it('crash is a short, harsh, falling stab', () => {
    const { ctx, sources } = cueSources('crash');
    const tones = sources.filter((s) => s.kind === 'oscillator');
    expect(tones.length).toBeGreaterThanOrEqual(2);
    for (const tone of tones) {
      expect(['sawtooth', 'square']).toContain(tone.type);
      expect(glide(tone).to).toBeLessThan(glide(tone).from * 0.5);
    }
    expect(sources.some((s) => s.kind === 'bufferSource')).toBe(true);
    expect(Math.max(...sources.map((s) => s.stopTime)) - ctx.currentTime).toBeLessThan(0.4);
  });

  it('death is a long fall', () => {
    const { ctx, sources } = cueSources('death');
    const tones = sources.filter((s) => s.kind === 'oscillator');
    expect(tones.length).toBeGreaterThanOrEqual(1);
    for (const tone of tones) expect(glide(tone).to).toBeLessThan(glide(tone).from * 0.25);
    const length = Math.max(...sources.map((s) => s.stopTime)) - ctx.currentTime;
    expect(length).toBeGreaterThan(1);
    expect(length).toBeLessThan(2.5);
    // It is held at full level for a good part of that, so the fall is heard and not just scheduled.
    const sustained = tones.filter((tone) => {
      const envelope = tone.outputs[0] as FakeNode;
      const holds = envelope.params.gain.events.filter((event) => event.kind === 'set');
      return holds.length === 2 && holds[1].time - holds[0].time > 0.3;
    });
    expect(sustained.length).toBeGreaterThanOrEqual(1);
  });

  it('land is a low thud followed by short creaks of narrow-band noise', () => {
    const { ctx, sources } = cueSources('land');
    const thud = sources.find((s) => s.kind === 'oscillator' && s.type === 'sine');
    expect(thud).toBeDefined();
    if (thud) {
      expect(glide(thud).from).toBeLessThan(150);
      expect(glide(thud).to).toBeLessThan(glide(thud).from);
      expect(thud.startTime).toBe(ctx.currentTime);
    }
    const creaks = sources.filter((s) => {
      const filter = s.outputs[0];
      return s.kind === 'bufferSource' && filter instanceof FakeNode && filter.type === 'bandpass';
    });
    expect(creaks.length).toBeGreaterThanOrEqual(2);
    for (const creak of creaks) {
      const filter = creak.outputs[0] as FakeNode;
      expect(filter.params.Q.value).toBeGreaterThan(4);
      expect(creak.startTime).toBeGreaterThan(ctx.currentTime);
      expect(creak.stopTime - creak.startTime).toBeLessThan(0.2);
    }
    expect(Math.max(...sources.map((s) => s.stopTime)) - ctx.currentTime).toBeLessThan(0.5);
  });

  it('keeps the interface chimes as clean triangle notes', () => {
    for (const kind of ['countdown', 'go', 'checkpoint', 'finish', 'reset'] as BlipKind[]) {
      FakeAudioContext.instances = [];
      const { sources } = cueSources(kind);
      for (const source of sources) expect(source).toMatchObject({ kind: 'oscillator', type: 'triangle' });
    }
  });

  it('plays a cue asked for while the context is still starting, if it starts soon enough', () => {
    const audio = createAudio();
    audio.resume();
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended';
    const before = ctx.nodes.length;
    audio.blip('go');
    expect(ctx.nodes).toHaveLength(before);
    ctx.setState('running');
    expect(ctx.nodes.length).toBeGreaterThan(before);
    // Only once.
    const after = ctx.nodes.length;
    ctx.setState('suspended');
    ctx.setState('running');
    expect(ctx.nodes).toHaveLength(after);
  });
});

describe('collisions', () => {
  function thump(impact: number): { ctx: FakeAudioContext; created: FakeNode[]; master: FakeNode } {
    const { audio, ctx } = started();
    const existing = new Set(ctx.nodes);
    ctx.currentTime = 1;
    audio.collision(impact);
    return { ctx, created: ctx.nodes.filter((node) => !existing.has(node)), master: masterChain(ctx).master };
  }

  it('is a falling low sine plus filtered noise', () => {
    const { ctx, created } = thump(10);
    const body = created.filter((n) => n.kind === 'oscillator');
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe('sine');
    const events = body[0].params.frequency.events;
    expect(events[0].value).toBeLessThan(200);
    expect(events[events.length - 1].value).toBeLessThan(events[0].value * 0.5);
    const noise = created.filter((n) => n.kind === 'bufferSource');
    expect(noise.length).toBeGreaterThanOrEqual(1);
    for (const source of noise) expect((source.outputs[0] as FakeNode).kind).toBe('biquad');
    for (const source of created.filter((n) => n.isSource)) {
      expect(source.stopped).toBe(true);
      expect(source.stopTime - ctx.currentTime).toBeLessThan(0.5);
      expect(source.reaches(ctx.destination)).toBe(true);
    }
  });

  it('scales with the impact', () => {
    const peak = (impact: number): number => {
      FakeAudioContext.instances = [];
      const { created, master } = thump(impact);
      const envelopes = created.filter((n) => n.kind === 'gain' && n.outputs[0] === master);
      return envelopes.reduce((sum, env) => sum + gain(env).events[1].value, 0);
    };
    const soft = peak(1.5);
    const medium = peak(6);
    const hard = peak(14);
    expect(medium).toBeGreaterThan(soft * 1.3);
    expect(hard).toBeGreaterThan(medium * 1.3);
    // Beyond "full" it does not keep growing.
    expect(peak(60)).toBe(hard);
    // Summed peaks of the loudest thump stay within what the limiter and clipper are there for.
    expect(hard).toBeLessThan(2.5);
  });

  it('ignores touches and nonsense', () => {
    for (const impact of [0, 0.3, -4, Number.NaN]) {
      FakeAudioContext.instances = [];
      expect(thump(impact).created).toHaveLength(0);
    }
  });

  it('is rate-limited, so scraping a wall is not a machine gun', () => {
    const { audio, ctx } = started();
    const before = ctx.nodes.length;
    ctx.currentTime = 1;
    audio.collision(8);
    const one = ctx.nodes.length - before;
    expect(one).toBeGreaterThan(0);
    for (let i = 0; i < 9; i++) {
      ctx.currentTime += 1 / 120;
      audio.collision(8);
    }
    expect(ctx.nodes.length - before).toBe(one);
    ctx.currentTime = 1.2;
    audio.collision(8);
    expect(ctx.nodes.length - before).toBe(one * 2);
  });
});

describe('lifecycle', () => {
  it('suspends when the tab is hidden and wakes when it is shown again', () => {
    const { ctx } = started();
    fakeDocument.setHidden(true);
    expect(ctx.state).toBe('suspended');
    fakeDocument.setHidden(false);
    expect(ctx.state).toBe('running');
  });

  it('dispose stops every source, closes the context, drops its listeners, and makes everything a no-op', () => {
    const { audio, ctx } = started();
    drive(audio, ctx, car({ speed: 20, forwardSpeed: 20, throttle: 1 }), 10);
    expect(fakeDocument.listeners.size).toBe(1);
    expect(ctx.listenerCount).toBe(1);
    audio.dispose();
    for (const source of ctx.nodes.filter((node) => node.isSource)) expect(source.stopped).toBe(true);
    expect(ctx.running).toHaveLength(0);
    expect(ctx.state).toBe('closed');
    expect(fakeDocument.listeners.size).toBe(0);
    expect(ctx.listenerCount).toBe(0);
    const { master } = masterChain(ctx);
    expect(master.inputs).toHaveLength(0);

    const nodes = ctx.nodes.length;
    expect(() => {
      audio.resume();
      audio.update(car(), DEFAULT_CAR_PARAMS, true);
      audio.collision(10);
      audio.blip('finish');
      audio.setVolume(1);
      audio.setMuted(true);
      audio.dispose();
    }).not.toThrow();
    expect(ctx.nodes).toHaveLength(nodes);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});
