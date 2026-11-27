import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlipKind, GameAudio } from '../src/audio/mixer';
import { CHUNKS_AHEAD, CHUNKS_BEHIND, ENDLESS_MAX_CRASHES } from '../src/modes/endless';
import { COUNTDOWN_TICKS } from '../src/modes/run';
import { createEndlessSession, createWeeklySession } from '../src/session';
import type { EndlessSession, Session, SessionDeps } from '../src/session';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../src/sim/params';
import { PHYSICS_VERSION, SIM_HZ } from '../src/types';
import type { EndlessWorld, GameRenderer, Gate, InputState, Level, TrackChunk } from '../src/types';
import type { Hud } from '../src/ui/hud';
import type { FinishResult, GameOverResult, Menu } from '../src/ui/menu';
import { loadBest, loadEndlessBest, saveEndlessBest } from '../src/ui/storage';
import { makeStraightLevel } from './helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const FULL_THROTTLE: InputState = { ...IDLE, throttle: 1 };
const RESET: InputState = { ...IDLE, reset: true };

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

/** Keeps the chunks it was given and refuses the mistakes a real renderer would silently pay for. */
class FakeRenderer {
  readonly shown = new Map<number, TrackChunk>();
  begun = 0;
  added = 0;
  removed = 0;

  beginEndless(): void {
    this.begun++;
    this.shown.clear();
  }
  addChunk(chunk: TrackChunk): void {
    if (this.shown.has(chunk.index)) throw new Error(`chunk ${chunk.index} added twice`);
    this.shown.set(chunk.index, chunk);
    this.added++;
  }
  removeChunk(index: number): void {
    if (!this.shown.delete(index)) throw new Error(`chunk ${index} removed but never shown`);
    this.removed++;
  }
  indices(): number[] {
    return [...this.shown.keys()].sort((a, b) => a - b);
  }
}

interface Rig {
  deps: SessionDeps;
  renderer: FakeRenderer;
  blips: BlipKind[];
}

function rig(): Rig {
  const renderer = new FakeRenderer();
  const blips: BlipKind[] = [];
  const audio = { blip: (kind: BlipKind) => blips.push(kind) } as unknown as GameAudio;
  return {
    deps: { renderer: renderer as unknown as GameRenderer, audio, params: cloneParams(DEFAULT_CAR_PARAMS) },
    renderer,
    blips,
  };
}

function count(blips: BlipKind[], kind: BlipKind): number {
  return blips.filter((blip) => blip === kind).length;
}

function liveIndices(world: EndlessWorld): number[] {
  return world.chunks.map((chunk) => chunk.index);
}

function runCountdown(session: Session): void {
  for (let i = 0; i < COUNTDOWN_TICKS && session.phase === 'countdown'; i++) session.step(IDLE);
}

/** Puts the car at rest on the first point of the chunk after the one it is on, facing along the road. */
function hopToNextChunk(session: EndlessSession): void {
  const world = session.mode.world;
  const next = world.chunks.find((chunk) => chunk.index === world.chunkIndex + 1);
  if (!next) throw new Error('no chunk ahead of the car');
  const [a, b] = next.path;
  // A few metres in, so the car is unambiguously on the new chunk and not on the seam.
  const at = next.path[2];
  world.placeCar({ x: at.x, z: at.z, heading: Math.atan2(b.z - a.z, b.x - a.x) });
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endless session', () => {
  it('shows the first chunks as soon as it exists', () => {
    const { deps, renderer } = rig();
    const session = createEndlessSession('first-road', 'medium', deps);
    expect(renderer.begun).toBe(1);
    expect(renderer.indices()).toEqual(liveIndices(session.mode.world));
    expect(renderer.indices()).toEqual(Array.from({ length: CHUNKS_AHEAD + 1 }, (_, i) => i));
    expect(session.kind).toBe('endless');
    expect(session.phase).toBe('countdown');
    expect(session.run).toBeNull();
    expect(session.endless).toBe(session.mode.state);
    expect(session.world.params).toBe(deps.params);
  });

  it('keeps the renderer on exactly the live chunks as the road streams past', () => {
    const { deps, renderer } = rig();
    const session = createEndlessSession('stream', 'easy', deps);
    runCountdown(session);
    expect(session.phase).toBe('running');
    const world = session.mode.world;

    const hops = CHUNKS_BEHIND + 6;
    for (let hop = 0; hop < hops; hop++) {
      hopToNextChunk(session);
      session.step(IDLE);
      expect(session.phase).toBe('running');
      expect(renderer.indices()).toEqual(liveIndices(world));
      for (const chunk of world.chunks) expect(renderer.shown.get(chunk.index)).toBe(chunk);
    }
    expect(world.chunkIndex).toBe(hops);
    expect(renderer.shown.has(0)).toBe(false);
    expect(renderer.removed).toBe(hops - CHUNKS_BEHIND);
    // One chunk in per hop: nothing is rebuilt along the way.
    expect(renderer.added).toBe(CHUNKS_AHEAD + 1 + hops);
    expect(renderer.begun).toBe(1);
  });

  it('touches the renderer only on the ticks a chunk comes or goes', () => {
    const { deps, renderer } = rig();
    const session = createEndlessSession('steady', 'easy', deps);
    runCountdown(session);
    const before = renderer.added + renderer.removed;
    for (let i = 0; i < SIM_HZ; i++) session.step(IDLE);
    expect(renderer.added + renderer.removed).toBe(before);
  });

  it('restarts on the same road and puts its first stretch back on screen', () => {
    const { deps, renderer } = rig();
    const session = createEndlessSession('again', 'hard', deps);
    const world = session.mode.world;
    const firstRoad = world.chunks.map((chunk) => chunk.path[chunk.path.length - 1]);
    runCountdown(session);
    for (let hop = 0; hop < CHUNKS_BEHIND + 4; hop++) {
      hopToNextChunk(session);
      session.step(IDLE);
    }
    expect(renderer.shown.has(0)).toBe(false);

    session.restart();
    expect(session.phase).toBe('countdown');
    expect(session.countdownTicks).toBe(COUNTDOWN_TICKS);
    expect(renderer.indices()).toEqual(liveIndices(world));
    expect(renderer.indices()[0]).toBe(0);
    expect(world.chunks.map((chunk) => chunk.path[chunk.path.length - 1])).toEqual(firstRoad);
    // Still correct on the first tick of the new attempt, and after streaming resumes.
    runCountdown(session);
    hopToNextChunk(session);
    session.step(IDLE);
    expect(renderer.indices()).toEqual(liveIndices(world));
  });

  it('leaves alone the chunks that survive a restart near the start', () => {
    const { deps, renderer } = rig();
    const session = createEndlessSession('near', 'easy', deps);
    runCountdown(session);
    hopToNextChunk(session);
    session.step(IDLE);
    const added = renderer.added;
    session.restart();
    expect(renderer.added).toBe(added);
    expect(renderer.indices()).toEqual(liveIndices(session.mode.world));
  });

  it('ends a run that comes down off the road, saves it and shows the game-over screen', () => {
    const { deps, blips } = rig();
    const session = createEndlessSession('fall', 'medium', deps);
    runCountdown(session);
    hopToNextChunk(session);
    session.step(IDLE);
    const distance = session.mode.state.distance;
    expect(distance).toBeGreaterThan(0);

    const car = session.world.car;
    session.mode.world.placeCar({ x: car.x + 5000, z: car.z + 5000, heading: 0 });
    session.step(IDLE);
    expect(session.phase).toBe('over');
    expect(session.engineRunning).toBe(false);
    expect(count(blips, 'death')).toBe(0);

    session.end(false);
    expect(count(blips, 'death')).toBe(1);
    expect(loadEndlessBest('medium')).toEqual({ distance, driftScore: 0, physicsVersion: PHYSICS_VERSION });
    expect(loadEndlessBest('easy')).toBeNull();

    const showGameOver = vi.fn<(result: GameOverResult) => void>();
    session.showEndScreen({ showGameOver } as unknown as Menu);
    expect(showGameOver).toHaveBeenCalledOnce();
    expect(showGameOver.mock.calls[0][0]).toEqual({
      difficulty: 'medium',
      distance,
      driftScore: 0,
      ticks: session.mode.state.ticks,
      cause: 'offTrack',
      best: null,
      isNewBest: true,
      tuned: false,
    });

    const updateEndless = vi.fn();
    session.updateHud({ updateEndless } as unknown as Hud);
    expect(updateEndless).toHaveBeenCalledWith(session.mode.state, car, { best: loadEndlessBest('medium') });
  });

  it('does not save a tuned run, or one that fell short of the record', () => {
    const record = { distance: 1e6, driftScore: 7, physicsVersion: PHYSICS_VERSION };
    saveEndlessBest('hard', record);
    for (const tuned of [true, false]) {
      const { deps } = rig();
      const session = createEndlessSession('short', 'hard', deps);
      runCountdown(session);
      hopToNextChunk(session);
      session.step(IDLE);
      const car = session.world.car;
      session.mode.world.placeCar({ x: car.x + 5000, z: car.z, heading: 0 });
      session.step(IDLE);
      session.end(tuned);

      const showGameOver = vi.fn<(result: GameOverResult) => void>();
      session.showEndScreen({ showGameOver } as unknown as Menu);
      const result = showGameOver.mock.calls[0][0];
      expect(result.tuned).toBe(tuned);
      expect(result.isNewBest).toBe(false);
      expect(result.best).toEqual(record);
      expect(loadEndlessBest('hard')).toEqual(record);
    }
  });

  it('announces every counted crash once, and nothing else, on the way to a wreck', () => {
    const { deps, blips } = rig();
    const session = createEndlessSession('wreck', 'hard', deps);
    runCountdown(session);
    // Foot down and a locked wheel: sooner or later that is three walls.
    const reckless: InputState = { ...FULL_THROTTLE, steer: 1 };
    for (let i = 0; i < 120 * SIM_HZ && session.phase !== 'over'; i++) {
      reckless.steer = Math.floor(i / (3 * SIM_HZ)) % 2 === 0 ? 0.35 : -0.35;
      session.step(reckless);
    }
    const state = session.mode.state;
    expect(count(blips, 'crash')).toBe(state.crashes);
    if (state.lastLandingTick < 0) expect(count(blips, 'land')).toBe(0);
    if (session.phase === 'over' && state.deathCause === 'crashes') {
      expect(state.crashes).toBe(ENDLESS_MAX_CRASHES);
    }
    expect(state.crashes).toBeGreaterThan(0);
    // After the end the wreck rolls out under the mode's own control without any new cue.
    const cues = blips.length;
    for (let i = 0; i < SIM_HZ; i++) session.step(FULL_THROTTLE);
    if (session.phase === 'over') expect(blips.length).toBe(cues);
  });
});

describe('weekly session', () => {
  const HALF_WIDTH = 8;
  const GOAL_X = 200;

  function gateAcross(level: Level, x: number): Gate {
    const pathIndex = level.path.findIndex((p) => p.x >= x);
    return { ax: x, az: -HALF_WIDTH, bx: x, bz: HALF_WIDTH, pathIndex, respawn: { x, z: 0, heading: 0 } };
  }

  function straightLevel(): Level {
    const level = makeStraightLevel(GOAL_X, HALF_WIDTH);
    level.checkpoints = [50, 100, 150].map((x) => gateAcross(level, x));
    return level;
  }

  it('wraps a run on the level it was given', () => {
    const { deps, renderer } = rig();
    const level = straightLevel();
    const session = createWeeklySession(level, deps);
    expect(session.kind).toBe('weekly');
    expect(session.level).toBe(level);
    expect(session.phase).toBe('countdown');
    expect(session.countdownTicks).toBe(COUNTDOWN_TICKS);
    expect(session.run).toBe(session.mode.state);
    expect(session.endless).toBeNull();
    expect(session.engineRunning).toBe(true);
    expect(session.world.params).toBe(deps.params);
    expect(renderer.begun + renderer.added).toBe(0);
  });

  it('reports a respawn as a teleport and plays the checkpoint, reset and finish cues', () => {
    const { deps, blips } = rig();
    const level = straightLevel();
    const session = createWeeklySession(level, deps);
    runCountdown(session);
    expect(session.phase).toBe('running');

    let teleports = 0;
    for (let i = 0; i < 4 * SIM_HZ; i++) if (session.step(FULL_THROTTLE)) teleports++;
    expect(teleports).toBe(0);
    expect(session.step(RESET)).toBe(true);
    expect(session.step(RESET)).toBe(false);
    expect(count(blips, 'reset')).toBe(1);

    for (let i = 0; i < 60 * SIM_HZ && session.phase !== 'over'; i++) session.step(FULL_THROTTLE);
    expect(session.phase).toBe('over');
    expect(count(blips, 'checkpoint')).toBe(level.checkpoints.length);
    expect(count(blips, 'finish')).toBe(0);

    const state = session.mode.state;
    session.end(false);
    expect(count(blips, 'finish')).toBe(1);
    expect(loadBest(level.id)).toEqual({ ticks: state.ticks, driftScore: state.driftScore, physicsVersion: PHYSICS_VERSION });

    const showFinish = vi.fn<(result: FinishResult) => void>();
    session.showEndScreen({ showFinish } as unknown as Menu);
    expect(showFinish.mock.calls[0][0]).toMatchObject({
      levelId: level.id,
      ticks: state.ticks,
      resets: 1,
      best: null,
      isNewBest: true,
      tuned: false,
    });

    const update = vi.fn();
    session.updateHud({ update } as unknown as Hud);
    expect(update).toHaveBeenCalledWith(state, session.world.car, { levelId: level.id, best: loadBest(level.id) });
  });

  it('does not save a tuned run and restarts clean', () => {
    const { deps } = rig();
    const level = straightLevel();
    const session = createWeeklySession(level, deps);
    runCountdown(session);
    for (let i = 0; i < 60 * SIM_HZ && session.phase !== 'over'; i++) session.step(FULL_THROTTLE);
    session.end(true);
    expect(loadBest(level.id)).toBeNull();

    session.restart();
    expect(session.phase).toBe('countdown');
    const showFinish = vi.fn();
    session.showEndScreen({ showFinish } as unknown as Menu);
    expect(showFinish).not.toHaveBeenCalled();
  });
});
