import type { CarParams, CarState } from '../types';
import { createMusicVoice } from './music';
import type { MusicVoice } from './music';
import { createAmbienceVoice } from './ambience';
import type { AmbienceVoice } from './ambience';
import { createEngineVoice } from './engine';
import type { EngineVoice } from './engine';
import { OUTPUT_TRIM, clipCurve, crushCurve, cueReady, impactStrength } from './mapping';
import { createNoiseBuffer, createTireVoice } from './tires';
import type { TireVoice } from './tires';

export type BlipKind =
  | 'countdown'
  | 'go'
  | 'checkpoint'
  | 'finish'
  | 'reset'
  | 'crash'
  | 'death'
  | 'land'
  | 'fall'
  | 'close'
  | 'multiplier'
  | 'comboLost'
  | 'uiMove'
  | 'uiSelect'
  | 'uiBack'
  | 'uiGlitch';

/** Every cue, in a fixed order (for menus of sounds, tests, preloading). */
export const BLIP_KINDS: readonly BlipKind[] = [
  'countdown',
  'go',
  'checkpoint',
  'finish',
  'reset',
  'crash',
  'death',
  'land',
  'fall',
  'close',
  'multiplier',
  'comboLost',
  'uiMove',
  'uiSelect',
  'uiBack',
  'uiGlitch',
];

export interface GameAudio {
  /**
   * Creates or resumes the AudioContext; safe to call repeatedly. Before the page's first user gesture this only
   * notes that sound is wanted, so call it again from input events.
   */
  resume(): void;
  /** Once per rendered frame. `active = false` fades engine, tyres and wind out (menus, pause). */
  update(car: CarState, params: CarParams, active: boolean): void;
  /** `impact` is the closing speed in m/s. */
  collision(impact: number): void;
  /**
   * One-shot cues.
   * - Driving: 'crash' = a life lost, 'death' = the run is over, 'land' = the car came back down from a jump,
   *   'fall' = the car went over an edge (a falling whoosh, then the thud of the floor about 0.75 s later).
   * - Scoring: 'close' = a close-to-the-wall moment starts (quiet; at most four a second, extra calls are dropped),
   *   'multiplier' = the multiplier crossed a whole number, 'comboLost' = the multiplier was lost.
   * - Interface: 'uiMove' = the selection moved, 'uiSelect' = confirm, 'uiBack' = back out, 'uiGlitch' = a tiny
   *   crushed burst for screen transitions; plus the race chimes 'countdown', 'go', 'checkpoint', 'finish', 'reset'.
   * Nothing plays while muted. Calling a cue every frame is safe: the frequent ones are rate-limited.
   */
  blip(kind: BlipKind): void;
  /** 0..1 */
  setVolume(v: number): void;
  /**
   * Silence everything, or bring it back, with a short fade. Independent of setVolume, and remembered whether or
   * not the AudioContext exists yet.
   */
  setMuted(muted: boolean): void;
  /**
   * Background music: fades over to song `song` (0..SONGS.length - 1), or out with -1. Remembered until the
   * AudioContext exists. Goes through the volume and the mute switch like everything else.
   */
  playMusic(song: number): void;
  /** The song asked for last, -1 for none. */
  readonly musicSong: number;
  dispose(): void;
}

/** One oscillator of a cue: a pitch (optionally gliding to another) under a decaying envelope. */
interface Tone {
  freq: number;
  /** Frequency reached at the end of `dur`, Hz. Omitted = steady. */
  to?: number;
  /** Start offset, s. */
  at: number;
  /** Time to fade out, s. */
  dur: number;
  /** Part of `dur` spent at full level before the fade starts, s. Omitted = fades from the start. */
  hold?: number;
  wave?: OscillatorType;
  level?: number;
  /**
   * Instead of a glide: jump through these frequencies, one every `stepGap` seconds (a sample-and-hold glitch).
   * `freq` is ignored when set.
   */
  steps?: readonly number[];
  stepGap?: number;
}

/** One burst of filtered noise in a cue. */
interface Burst {
  filter: BiquadFilterType;
  freq: number;
  to?: number;
  q: number;
  at: number;
  dur: number;
  level: number;
  /** Time at full level before the fade starts, s. */
  hold?: number;
  /** Bit-crush the filtered noise to this many levels each side of zero (1..8): grainy, broken, digital. */
  crush?: number;
}

interface Cue {
  tones: readonly Tone[];
  bursts?: readonly Burst[];
}

const BLIP_LEVEL = 0.2;

const CUES: Record<BlipKind, Cue> = {
  countdown: { tones: [{ freq: 440, at: 0, dur: 0.14 }] },
  go: {
    tones: [
      { freq: 587.33, at: 0, dur: 0.12 },
      { freq: 880, at: 0.09, dur: 0.4 },
    ],
  },
  checkpoint: {
    tones: [
      { freq: 783.99, at: 0, dur: 0.09 },
      { freq: 1174.66, at: 0.07, dur: 0.2 },
    ],
  },
  finish: {
    tones: [
      { freq: 523.25, at: 0, dur: 0.14 },
      { freq: 659.25, at: 0.1, dur: 0.14 },
      { freq: 783.99, at: 0.2, dur: 0.14 },
      { freq: 1046.5, at: 0.3, dur: 0.6 },
    ],
  },
  reset: {
    tones: [
      { freq: 392, at: 0, dur: 0.09 },
      { freq: 293.66, at: 0.07, dur: 0.18 },
    ],
  },
  // A life lost: two saws a tritone apart dropping fast, with a snap of noise on the front. Short and ugly.
  crash: {
    tones: [
      { freq: 466.16, to: 116.54, at: 0, dur: 0.2, wave: 'sawtooth', level: 0.17 },
      { freq: 659.25, to: 155.56, at: 0, dur: 0.16, wave: 'square', level: 0.09 },
    ],
    bursts: [{ filter: 'bandpass', freq: 2200, to: 700, q: 0.8, at: 0, dur: 0.11, level: 0.5 }],
  },
  // The run is over: one long fall of three octaves, with a duller voice an octave below trailing after it.
  death: {
    tones: [
      { freq: 392, to: 49, at: 0, dur: 1.15, hold: 0.45, wave: 'triangle', level: 0.22 },
      { freq: 196, to: 24.5, at: 0.05, dur: 1.3, hold: 0.5, wave: 'sawtooth', level: 0.06 },
      { freq: 587.33, to: 73.42, at: 0, dur: 0.5, wave: 'triangle', level: 0.1 },
    ],
  },
  // Back on the ground: the thud of the tyres, then the springs complaining twice as they take the weight.
  land: {
    tones: [
      { freq: 96, to: 36, at: 0, dur: 0.2, wave: 'sine', level: 0.45 },
      { freq: 84, to: 57, at: 0.04, dur: 0.15, wave: 'sawtooth', level: 0.07 },
    ],
    bursts: [
      { filter: 'lowpass', freq: 600, to: 160, q: 0, at: 0, dur: 0.1, level: 0.8 },
      { filter: 'bandpass', freq: 560, to: 380, q: 9, at: 0.035, dur: 0.07, level: 2.2 },
      { filter: 'bandpass', freq: 400, to: 470, q: 9, at: 0.115, dur: 0.09, level: 1.5 },
    ],
  },
  // Over the edge: air rushing past as a band of noise sweeping down, a whistle falling with it, and the floor.
  fall: {
    tones: [
      { freq: 880, to: 110, at: 0, dur: 0.75, hold: 0.25, wave: 'triangle', level: 0.09 },
      { freq: 92, to: 34, at: 0.74, dur: 0.3, wave: 'sine', level: 0.42 },
    ],
    bursts: [
      { filter: 'bandpass', freq: 2600, to: 240, q: 1.1, at: 0, dur: 0.78, hold: 0.32, level: 0.85 },
      { filter: 'lowpass', freq: 520, to: 140, q: 0, at: 0.74, dur: 0.14, level: 0.7 },
    ],
  },
  // Brushing a wall: a glint, not a bell. Quiet and very short, because it can come four times a second.
  close: {
    tones: [
      { freq: 2349.32, at: 0, dur: 0.06, wave: 'sine', level: 0.07 },
      { freq: 3520, at: 0.022, dur: 0.09, wave: 'sine', level: 0.055 },
    ],
  },
  // Multiplier up: one small upward flick and the octave above it.
  multiplier: {
    tones: [
      { freq: 659.25, to: 1318.51, at: 0, dur: 0.09, level: 0.12 },
      { freq: 1318.51, at: 0.07, dur: 0.13, wave: 'sine', level: 0.08 },
    ],
  },
  // Multiplier lost: the combo breaks up on the way down, in steps, with a crackle of crushed noise on top.
  comboLost: {
    tones: [
      {
        freq: 740,
        steps: [740, 523.25, 622.25, 369.99, 415.3, 233.08, 261.63, 146.83],
        stepGap: 0.028,
        at: 0,
        dur: 0.25,
        wave: 'square',
        level: 0.07,
      },
      { freq: 369.99, to: 46.25, at: 0, dur: 0.26, wave: 'sawtooth', level: 0.06 },
    ],
    bursts: [{ filter: 'bandpass', freq: 2400, to: 500, q: 0.9, at: 0, dur: 0.12, level: 0.55, crush: 2 }],
  },
  uiMove: { tones: [{ freq: 1567.98, at: 0, dur: 0.035, wave: 'sine', level: 0.08 }] },
  uiSelect: {
    tones: [
      { freq: 1046.5, at: 0, dur: 0.06, level: 0.15 },
      { freq: 1567.98, at: 0.045, dur: 0.14, level: 0.13 },
    ],
  },
  uiBack: { tones: [{ freq: 587.33, to: 392, at: 0, dur: 0.1, level: 0.14 }] },
  uiGlitch: {
    tones: [
      { freq: 1900, steps: [1900, 620, 2780, 410, 1340], stepGap: 0.012, at: 0, dur: 0.06, wave: 'square', level: 0.06 },
    ],
    bursts: [{ filter: 'highpass', freq: 1800, q: 0.7, at: 0, dur: 0.05, level: 0.3, crush: 3 }],
  },
};

/** Length of the shared noise loop: long enough that no voice reading it is heard to repeat. */
const NOISE_SECONDS = 4;
const DEFAULT_VOLUME = 0.5;
const VOLUME_SMOOTH = 0.03;
/** Time constant of the mute fade: 95 % of the way there after about 40 ms. */
const MUTE_SMOOTH = 0.013;
/** After this long the mute fade is close enough to its target to be pinned to it exactly. */
const MUTE_SETTLE = 0.12;
const ATTACK = 0.008;
/** exponentialRampToValueAtTime cannot reach zero, so envelopes end here (-66 dB). */
const SILENCE = 0.0005;
/** Scraping along a wall reports a hit every tick; this keeps the thumps apart. */
const THUMP_GAP = 0.09;
/** A blip requested while the context is still starting is played if it starts within this window. */
const QUEUED_BLIP_WINDOW_MS = 400;

interface Graph {
  ctx: AudioContext;
  /** Everything audible is connected to this; its gain is the volume setting. */
  master: GainNode;
  /** 1 or 0: the mute switch, after the volume so the two never fight over one parameter. */
  mute: GainNode;
  /** OUTPUT_TRIM, after the clipper: the overall level of the game. */
  trim: GainNode;
  noise: AudioBuffer;
  engine: EngineVoice;
  tires: TireVoice;
  ambience: AmbienceVoice;
  /** Built the first time a song is asked for. */
  music: MusicVoice | null;
}

type ContextConstructor = typeof AudioContext;

function contextConstructor(): ContextConstructor | undefined {
  const scope = globalThis as { AudioContext?: ContextConstructor; webkitAudioContext?: ContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/**
 * False only when the browser reports that the page has not had a user gesture yet. A context created then starts
 * suspended and logs an autoplay warning, so creation waits for the next call that follows a gesture.
 */
function gestureSeen(): boolean {
  return globalThis.navigator?.userActivation?.hasBeenActive !== false;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function createLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.18;
  return limiter;
}

/** The compressor needs a few milliseconds to react; this catches whatever gets past it in that time. */
function createClipper(ctx: AudioContext): WaveShaperNode {
  const clipper = ctx.createWaveShaper();
  clipper.curve = clipCurve();
  return clipper;
}

/** voices -> master (volume) -> mute -> limiter -> clipper -> trim -> speakers */
function buildGraph(Context: ContextConstructor, volume: number, muted: boolean): Graph {
  const ctx = new Context({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.gain.value = volume;
  const mute = ctx.createGain();
  mute.gain.value = muted ? 0 : 1;
  const trim = ctx.createGain();
  trim.gain.value = OUTPUT_TRIM;
  master.connect(mute).connect(createLimiter(ctx)).connect(createClipper(ctx)).connect(trim).connect(ctx.destination);
  const noise = createNoiseBuffer(ctx, NOISE_SECONDS);
  return {
    ctx,
    master,
    mute,
    trim,
    noise,
    engine: createEngineVoice(ctx, noise, master),
    tires: createTireVoice(ctx, noise, master),
    ambience: createAmbienceVoice(ctx, noise, master),
    music: null,
  };
}

/**
 * Starts `source` through a gain that rises to `peak` in a few milliseconds, stays there for `hold` seconds and
 * has died away exponentially `decay` seconds after the rise; the gain is detached again when `source` ends.
 * Returns the gain for the caller to feed.
 */
function decayingGain(
  graph: Graph,
  source: AudioScheduledSourceNode,
  peak: number,
  start: number,
  decay: number,
  hold = 0,
): GainNode {
  const gain = graph.ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, start);
  gain.gain.linearRampToValueAtTime(peak, start + ATTACK);
  if (hold > 0) gain.gain.setValueAtTime(peak, start + ATTACK + Math.min(hold, decay * 0.9));
  gain.gain.exponentialRampToValueAtTime(SILENCE, start + ATTACK + decay);
  gain.connect(graph.master);
  source.onended = () => gain.disconnect();
  source.start(start);
  source.stop(start + ATTACK + decay + 0.02);
  return gain;
}

/** oscillator -> decaying gain -> master */
function playTone(graph: Graph, tone: Tone, now: number): void {
  const start = now + tone.at;
  const oscillator = graph.ctx.createOscillator();
  oscillator.type = tone.wave ?? 'triangle';
  if (tone.steps !== undefined && tone.steps.length > 0) {
    const gap = tone.stepGap ?? tone.dur / tone.steps.length;
    for (let i = 0; i < tone.steps.length; i++) oscillator.frequency.setValueAtTime(tone.steps[i], start + i * gap);
  } else {
    oscillator.frequency.setValueAtTime(tone.freq, start);
    if (tone.to !== undefined) oscillator.frequency.exponentialRampToValueAtTime(tone.to, start + tone.dur);
  }
  oscillator.connect(decayingGain(graph, oscillator, tone.level ?? BLIP_LEVEL, start, tone.dur, tone.hold));
}

const crushCurves = new Map<number, Float32Array<ArrayBuffer>>();

function cachedCrushCurve(steps: number): Float32Array<ArrayBuffer> {
  let curve = crushCurves.get(steps);
  if (!curve) {
    curve = crushCurve(steps);
    crushCurves.set(steps, curve);
  }
  return curve;
}

/** noise -> filter -> (bit-crusher) -> decaying gain -> master */
function playBurst(graph: Graph, burst: Burst, now: number): void {
  const start = now + burst.at;
  const source = graph.ctx.createBufferSource();
  source.buffer = graph.noise;
  source.loop = true;
  const filter = graph.ctx.createBiquadFilter();
  filter.type = burst.filter;
  filter.Q.value = burst.q;
  filter.frequency.setValueAtTime(burst.freq, start);
  if (burst.to !== undefined) filter.frequency.exponentialRampToValueAtTime(burst.to, start + burst.dur);
  source.connect(filter);
  let last: AudioNode = filter;
  if (burst.crush !== undefined) {
    const crusher = graph.ctx.createWaveShaper();
    crusher.curve = cachedCrushCurve(Math.round(burst.crush));
    last = last.connect(crusher);
  }
  last.connect(decayingGain(graph, source, burst.level, start, burst.dur, burst.hold));
}

function playCue(graph: Graph, kind: BlipKind): void {
  const now = graph.ctx.currentTime;
  const cue = CUES[kind];
  for (const tone of cue.tones) playTone(graph, tone, now);
  if (cue.bursts) for (const burst of cue.bursts) playBurst(graph, burst, now);
}

const thumpBody: Tone = { freq: 120, to: 40, at: 0, dur: 0, wave: 'sine', level: 0 };
const thumpThud: Burst = { filter: 'lowpass', freq: 0, q: 0, at: 0, dur: 0, level: 0 };
const thumpCrunch: Burst = { filter: 'bandpass', freq: 0, to: 0, q: 0.9, at: 0, dur: 0, level: 0 };

/**
 * A hit, scaled by `strength` (0..1): a falling sine for the weight of the car, low-passed noise for the thud of
 * the panel, and a shorter, brighter band of noise for the crunch, which grows fastest with the impact.
 */
function playThump(graph: Graph, strength: number, now: number): void {
  const decay = 0.1 + 0.16 * strength;

  thumpBody.dur = decay;
  thumpBody.level = 0.2 + 0.36 * strength;
  playTone(graph, thumpBody, now);

  thumpThud.freq = 240 + 320 * strength;
  thumpThud.dur = decay;
  thumpThud.level = 0.3 + 0.45 * strength;
  playBurst(graph, thumpThud, now);

  thumpCrunch.freq = 900 + 1700 * strength;
  thumpCrunch.to = 500 + 500 * strength;
  thumpCrunch.dur = 0.05 + 0.09 * strength;
  thumpCrunch.level = 0.08 + 0.45 * strength * strength;
  playBurst(graph, thumpCrunch, now);
}

function playSong(graph: Graph, song: number): void {
  if (!graph.music) {
    if (song < 0) return;
    graph.music = createMusicVoice(graph.ctx, graph.noise, graph.master);
  }
  graph.music.play(song);
}

export function createAudio(): GameAudio {
  let graph: Graph | null = null;
  let unavailable = contextConstructor() === undefined;
  let volume = DEFAULT_VOLUME;
  let muted = false;
  /** True once the game asked for sound, so a tab coming back to the foreground may restart it. */
  let wanted = false;
  let lastThump = -Infinity;
  let queuedBlip: BlipKind | null = null;
  let queuedBlipMs = 0;
  let song = -1;
  /** Context time each cue last played, for the rate limits. */
  const lastCue = new Map<BlipKind, number>();

  function start(): void {
    const Context = contextConstructor();
    if (!Context) {
      unavailable = true;
      return;
    }
    try {
      graph = buildGraph(Context, volume, muted);
      graph.ctx.addEventListener('statechange', onStateChange);
      playSong(graph, song);
      globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
    } catch {
      unavailable = true;
    }
  }

  function wake(): void {
    if (!graph || graph.ctx.state === 'running' || graph.ctx.state === 'closed') return;
    graph.ctx.resume().catch(() => {});
  }

  function onStateChange(): void {
    if (!graph || graph.ctx.state !== 'running' || queuedBlip === null) return;
    if (performance.now() - queuedBlipMs < QUEUED_BLIP_WINDOW_MS) playCue(graph, queuedBlip);
    queuedBlip = null;
  }

  // A hidden tab stops rendering, so update() no longer runs and the engine would drone on at its last level.
  function onVisibilityChange(): void {
    if (!graph) return;
    if (document.hidden) graph.ctx.suspend().catch(() => {});
    else if (wanted) wake();
  }

  return {
    resume() {
      if (unavailable) return;
      wanted = true;
      if (!graph && gestureSeen()) start();
      wake();
    },
    update(car, params, active) {
      if (!graph || graph.ctx.state !== 'running') return;
      const now = graph.ctx.currentTime;
      graph.engine.update(car, params, active, now);
      graph.tires.update(car, active, now);
      graph.ambience.update(car, active, now);
    },
    collision(impact) {
      if (!graph || graph.ctx.state !== 'running' || muted) return;
      const strength = impactStrength(impact);
      if (strength <= 0) return;
      const now = graph.ctx.currentTime;
      if (now - lastThump < THUMP_GAP) return;
      lastThump = now;
      playThump(graph, strength, now);
    },
    blip(kind) {
      if (!graph || muted || CUES[kind] === undefined) return;
      if (graph.ctx.state === 'running') {
        const now = graph.ctx.currentTime;
        if (!cueReady(kind, now, lastCue.get(kind) ?? -Infinity)) return;
        lastCue.set(kind, now);
        playCue(graph, kind);
        return;
      }
      queuedBlip = kind;
      queuedBlipMs = performance.now();
    },
    setVolume(v) {
      volume = clamp01(Number.isFinite(v) ? v : DEFAULT_VOLUME);
      if (graph) graph.master.gain.setTargetAtTime(volume, graph.ctx.currentTime, VOLUME_SMOOTH);
    },
    setMuted(value) {
      const next = value === true;
      if (next === muted) return;
      muted = next;
      if (!graph) return;
      // Drop the pin left by the previous toggle, glide from wherever the gain is now, then pin the new value:
      // a glide only ever approaches its target, and "muted" should mean exactly zero.
      const gain = graph.mute.gain;
      const now = graph.ctx.currentTime;
      const target = muted ? 0 : 1;
      gain.cancelScheduledValues(now);
      gain.setTargetAtTime(target, now, MUTE_SMOOTH);
      gain.setValueAtTime(target, now + MUTE_SETTLE);
    },
    get musicSong() {
      return song;
    },
    playMusic(next) {
      song = next;
      if (graph) playSong(graph, next);
    },
    dispose() {
      unavailable = true;
      wanted = false;
      if (!graph) return;
      const { ctx, engine, tires, ambience, music } = graph;
      graph = null;
      ctx.removeEventListener('statechange', onStateChange);
      globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
      engine.dispose();
      tires.dispose();
      ambience.dispose();
      music?.dispose();
      ctx.close().catch(() => {});
    },
  };
}
