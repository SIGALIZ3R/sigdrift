import type { CarParams, CarState } from '../types';
import { createEngineVoice } from './engine';
import type { EngineVoice } from './engine';
import { createNoiseBuffer, createTireVoice } from './tires';
import type { TireVoice } from './tires';

export type BlipKind = 'countdown' | 'go' | 'checkpoint' | 'finish' | 'reset';

export interface GameAudio {
  /**
   * Creates or resumes the AudioContext; safe to call repeatedly. Before the page's first user gesture this only
   * notes that sound is wanted, so call it again from input events.
   */
  resume(): void;
  /** Once per rendered frame. `active = false` fades engine and tyres out (menus, pause). */
  update(car: CarState, params: CarParams, active: boolean): void;
  /** `impact` is the closing speed in m/s. */
  collision(impact: number): void;
  blip(kind: BlipKind): void;
  /** 0..1 */
  setVolume(v: number): void;
  dispose(): void;
}

interface Note {
  freq: number;
  /** Start offset, s. */
  at: number;
  /** Time to fade out, s. */
  dur: number;
}

const BLIPS: Record<BlipKind, readonly Note[]> = {
  countdown: [{ freq: 440, at: 0, dur: 0.14 }],
  go: [
    { freq: 587.33, at: 0, dur: 0.12 },
    { freq: 880, at: 0.09, dur: 0.4 },
  ],
  checkpoint: [
    { freq: 783.99, at: 0, dur: 0.09 },
    { freq: 1174.66, at: 0.07, dur: 0.2 },
  ],
  finish: [
    { freq: 523.25, at: 0, dur: 0.14 },
    { freq: 659.25, at: 0.1, dur: 0.14 },
    { freq: 783.99, at: 0.2, dur: 0.14 },
    { freq: 1046.5, at: 0.3, dur: 0.6 },
  ],
  reset: [
    { freq: 392, at: 0, dur: 0.09 },
    { freq: 293.66, at: 0.07, dur: 0.18 },
  ],
};

const DEFAULT_VOLUME = 0.5;
const VOLUME_SMOOTH = 0.03;
const BLIP_LEVEL = 0.2;
const ATTACK = 0.008;
/** exponentialRampToValueAtTime cannot reach zero, so envelopes end here (-66 dB). */
const SILENCE = 0.0005;
/** Softer hits than this (m/s) make no sound. */
const MIN_IMPACT = 0.6;
/** Closing speed (m/s) that gives the loudest thump. */
const FULL_IMPACT = 14;
/** Scraping along a wall reports a hit every tick; this keeps the thumps apart. */
const THUMP_GAP = 0.09;
/** A blip requested while the context is still starting is played if it starts within this window. */
const QUEUED_BLIP_WINDOW_MS = 400;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
  engine: EngineVoice;
  tires: TireVoice;
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

function buildGraph(Context: ContextConstructor, volume: number): Graph {
  const ctx = new Context({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(createLimiter(ctx)).connect(ctx.destination);
  const noise = createNoiseBuffer(ctx);
  return {
    ctx,
    master,
    noise,
    engine: createEngineVoice(ctx, master),
    tires: createTireVoice(ctx, noise, master),
  };
}

/** A gain node that jumps to `peak` and dies away exponentially, detached again when `source` ends. */
function decayingGain(
  graph: Graph,
  source: AudioScheduledSourceNode,
  peak: number,
  start: number,
  decay: number,
): GainNode {
  const gain = graph.ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, start);
  gain.gain.linearRampToValueAtTime(peak, start + ATTACK);
  gain.gain.exponentialRampToValueAtTime(SILENCE, start + ATTACK + decay);
  gain.connect(graph.master);
  source.onended = () => gain.disconnect();
  source.start(start);
  source.stop(start + ATTACK + decay + 0.02);
  return gain;
}

function playNote(graph: Graph, note: Note, now: number): void {
  const oscillator = graph.ctx.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.value = note.freq;
  oscillator.connect(decayingGain(graph, oscillator, BLIP_LEVEL, now + note.at, note.dur));
}

function playBlip(graph: Graph, kind: BlipKind): void {
  const now = graph.ctx.currentTime;
  for (const note of BLIPS[kind]) playNote(graph, note, now);
}

/** Low-passed noise for the crunch plus a falling sine for the body of the hit. */
function playThump(graph: Graph, strength: number, now: number): void {
  const { ctx } = graph;
  const peak = 0.25 + 0.6 * strength;
  const decay = 0.1 + 0.16 * strength;

  const crunch = ctx.createBufferSource();
  crunch.buffer = graph.noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 280 + 900 * strength;
  crunch.connect(filter).connect(decayingGain(graph, crunch, peak, now, decay));

  const body = ctx.createOscillator();
  body.frequency.setValueAtTime(110, now);
  body.frequency.exponentialRampToValueAtTime(42, now + decay);
  body.connect(decayingGain(graph, body, peak * 0.8, now, decay));
}

export function createAudio(): GameAudio {
  let graph: Graph | null = null;
  let unavailable = contextConstructor() === undefined;
  let volume = DEFAULT_VOLUME;
  /** True once the game asked for sound, so a tab coming back to the foreground may restart it. */
  let wanted = false;
  let lastThump = -Infinity;
  let queuedBlip: BlipKind | null = null;
  let queuedBlipMs = 0;

  function start(): void {
    const Context = contextConstructor();
    if (!Context) {
      unavailable = true;
      return;
    }
    try {
      graph = buildGraph(Context, volume);
      graph.ctx.addEventListener('statechange', onStateChange);
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
    if (performance.now() - queuedBlipMs < QUEUED_BLIP_WINDOW_MS) playBlip(graph, queuedBlip);
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
    },
    collision(impact) {
      if (!graph || graph.ctx.state !== 'running' || !(impact >= MIN_IMPACT)) return;
      const now = graph.ctx.currentTime;
      if (now - lastThump < THUMP_GAP) return;
      lastThump = now;
      playThump(graph, clamp01(impact / FULL_IMPACT), now);
    },
    blip(kind) {
      if (!graph) return;
      if (graph.ctx.state === 'running') {
        playBlip(graph, kind);
        return;
      }
      queuedBlip = kind;
      queuedBlipMs = performance.now();
    },
    setVolume(v) {
      volume = clamp01(Number.isFinite(v) ? v : DEFAULT_VOLUME);
      if (graph) graph.master.gain.setTargetAtTime(volume, graph.ctx.currentTime, VOLUME_SMOOTH);
    },
    dispose() {
      unavailable = true;
      wanted = false;
      if (!graph) return;
      const { ctx, engine, tires } = graph;
      graph = null;
      ctx.removeEventListener('statechange', onStateChange);
      globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
      engine.dispose();
      tires.dispose();
      ctx.close().catch(() => {});
    },
  };
}
