/**
 * One run in progress, whichever mode it belongs to. The game drives a `Session` without knowing the rules behind
 * it: it steps it, restarts it, asks which phase it is in and lets it report its own ending. Everything that
 * differs between a weekly run and an endless one lives in the two implementations below.
 */
import type { GameAudio } from './audio/mixer';
import { createEndlessMode } from './modes/endless';
import { createRunMode } from './modes/run';
import { createWorld } from './sim/world';
import { PHYSICS_VERSION, SIM_HZ } from './types';
import type {
  BestRecord,
  CarParams,
  Difficulty,
  EndlessBest,
  EndlessMode,
  EndlessState,
  GameRenderer,
  InputState,
  Level,
  RunMode,
  RunState,
  SimBase,
} from './types';
import type { EndlessHudInfo, Hud, HudInfo } from './ui/hud';
import type { FinishResult, GameOverResult, Menu } from './ui/menu';
import { loadBest, loadEndlessBest, saveBest, saveEndlessBest } from './ui/storage';

/** `over` covers a finished weekly run and a dead endless one: no more player input, no pausing. */
export type SessionPhase = 'countdown' | 'running' | 'over';

export interface SessionDeps {
  renderer: GameRenderer;
  audio: GameAudio;
  /** The game's one long-lived tuning object; every world uses it as given. */
  params: CarParams;
}

interface SessionBase {
  readonly world: SimBase;
  readonly phase: SessionPhase;
  /** Ticks left before the lights go out (0 once running). */
  readonly countdownTicks: number;
  /** What the renderer is told about the run: exactly one of these two is non-null. */
  readonly run: RunState | null;
  readonly endless: EndlessState | null;
  /** False once the engine should fall silent although the car may still be rolling. */
  readonly engineRunning: boolean;
  /** How long the car is left on screen after the run ends before its result screen covers it. */
  readonly endScreenDelayTicks: number;
  /**
   * Advance one tick and play the mode's own cues. Returns true when the car was teleported, so that the caller
   * does not interpolate across the jump.
   */
  step(input: InputState): boolean;
  /** The same road again from its start line, with a fresh countdown. */
  restart(): void;
  /** Call once, on the tick the phase becomes `over`: saves the record (unless `tuned`) and keeps the result. */
  end(tuned: boolean): void;
  /** Opens the result screen for the run `end` closed. */
  showEndScreen(menu: Menu): void;
  updateHud(hud: Hud): void;
}

export interface WeeklySession extends SessionBase {
  readonly kind: 'weekly';
  readonly mode: RunMode;
  readonly level: Level;
}

export interface EndlessSession extends SessionBase {
  readonly kind: 'endless';
  readonly mode: EndlessMode;
  readonly difficulty: Difficulty;
  readonly seed: string;
}

export type Session = WeeklySession | EndlessSession;

const FINISH_SCREEN_DELAY_TICKS = Math.round(1.2 * SIM_HZ);
/** A little longer than a finish: the crash or the fall has to be seen before the screen covers it. */
const GAME_OVER_SCREEN_DELAY_TICKS = Math.round(1.4 * SIM_HZ);

// ---- Weekly run -------------------------------------------------------------------------------------------------

class WeeklyRun implements WeeklySession {
  readonly kind = 'weekly';
  readonly mode: RunMode;
  readonly level: Level;
  readonly endless = null;
  readonly engineRunning = true;
  readonly endScreenDelayTicks = FINISH_SCREEN_DELAY_TICKS;

  private readonly audio: GameAudio;
  private readonly hudInfo: HudInfo;
  /** Best time for this level, kept current when a run beats it. */
  private best: BestRecord | null;
  private result: FinishResult | null = null;

  constructor(level: Level, deps: SessionDeps) {
    this.level = level;
    this.audio = deps.audio;
    this.mode = createRunMode(createWorld(level, deps.params));
    this.best = loadBest(level.id);
    this.hudInfo = { levelId: level.id, best: this.best };
  }

  get world(): SimBase {
    return this.mode.world;
  }

  get phase(): SessionPhase {
    const phase = this.mode.state.phase;
    return phase === 'finished' ? 'over' : phase;
  }

  get countdownTicks(): number {
    return this.mode.state.countdownTicks;
  }

  get run(): RunState {
    return this.mode.state;
  }

  step(input: InputState): boolean {
    const state = this.mode.state;
    const resetsBefore = state.resets;
    const checkpointBefore = state.lastCheckpointTick;
    this.mode.step(input);

    const respawned = state.resets !== resetsBefore;
    if (respawned) this.audio.blip('reset');
    if (state.phase !== 'finished' && state.lastCheckpointTick !== checkpointBefore && state.lastCheckpointTick >= 0) {
      this.audio.blip('checkpoint');
    }
    return respawned;
  }

  restart(): void {
    this.result = null;
    this.mode.restart();
  }

  end(tuned: boolean): void {
    const state = this.mode.state;
    const previous = this.best;
    const record: BestRecord = { ticks: state.ticks, driftScore: state.driftScore, physicsVersion: PHYSICS_VERSION };
    const isNewBest = !tuned && (previous === null || record.ticks < previous.ticks);
    if (!tuned) saveBest(this.level.id, record);
    if (isNewBest) {
      this.best = record;
      this.hudInfo.best = record;
    }
    this.result = {
      levelId: this.level.id,
      ticks: record.ticks,
      driftScore: record.driftScore,
      resets: state.resets,
      best: previous,
      isNewBest,
      tuned,
    };
    this.audio.blip('finish');
  }

  showEndScreen(menu: Menu): void {
    if (this.result) menu.showFinish(this.result);
  }

  updateHud(hud: Hud): void {
    hud.update(this.mode.state, this.mode.world.car, this.hudInfo);
  }
}

// ---- Endless run ------------------------------------------------------------------------------------------------

class EndlessRun implements EndlessSession {
  readonly kind = 'endless';
  readonly mode: EndlessMode;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly run = null;
  readonly endScreenDelayTicks = GAME_OVER_SCREEN_DELAY_TICKS;

  private readonly audio: GameAudio;
  private readonly renderer: GameRenderer;
  private readonly hudInfo: EndlessHudInfo;
  /** Longest run on this difficulty, kept current when a run beats it. */
  private best: EndlessBest | null;
  private result: GameOverResult | null = null;
  /**
   * The chunks the renderer has been given. Live chunks are consecutive, so an inclusive range of indices says
   * exactly which they are; an empty range has `shownLast < shownFirst`.
   */
  private shownFirst = 0;
  private shownLast = -1;

  constructor(seed: string, difficulty: Difficulty, deps: SessionDeps) {
    this.seed = seed;
    this.difficulty = difficulty;
    this.audio = deps.audio;
    this.renderer = deps.renderer;
    this.mode = createEndlessMode(seed, difficulty, deps.params);
    this.best = loadEndlessBest(difficulty);
    this.hudInfo = { best: this.best };
    this.renderer.beginEndless();
    this.syncChunks();
  }

  get world(): SimBase {
    return this.mode.world;
  }

  get phase(): SessionPhase {
    const phase = this.mode.state.phase;
    return phase === 'dead' ? 'over' : phase;
  }

  get countdownTicks(): number {
    return this.mode.state.countdownTicks;
  }

  get endless(): EndlessState {
    return this.mode.state;
  }

  get engineRunning(): boolean {
    return this.mode.state.phase !== 'dead';
  }

  step(input: InputState): boolean {
    const crashBefore = this.mode.state.lastCrashTick;
    const landingBefore = this.mode.state.lastLandingTick;
    this.mode.step(input);
    this.syncChunks();

    const state = this.mode.state;
    if (state.lastCrashTick !== crashBefore && state.lastCrashTick >= 0) this.audio.blip('crash');
    if (state.lastLandingTick !== landingBefore && state.lastLandingTick >= 0) this.audio.blip('land');
    return false;
  }

  restart(): void {
    this.result = null;
    this.mode.restart();
    // The same seed gives the same road, so chunks still on screen from the first stretch stay as they are.
    this.syncChunks();
  }

  end(tuned: boolean): void {
    const state = this.mode.state;
    const previous = this.best;
    const record: EndlessBest = {
      distance: state.distance,
      driftScore: state.driftScore,
      physicsVersion: PHYSICS_VERSION,
    };
    const isNewBest = !tuned && record.distance > 0 && (previous === null || record.distance > previous.distance);
    if (!tuned) saveEndlessBest(this.difficulty, record);
    if (isNewBest) {
      this.best = record;
      this.hudInfo.best = record;
    }
    this.result = {
      difficulty: this.difficulty,
      distance: record.distance,
      driftScore: record.driftScore,
      ticks: state.ticks,
      cause: state.deathCause ?? 'crashes',
      best: previous,
      isNewBest,
      tuned,
    };
    this.audio.blip('death');
  }

  showEndScreen(menu: Menu): void {
    if (this.result) menu.showGameOver(this.result);
  }

  updateHud(hud: Hud): void {
    hud.updateEndless(this.mode.state, this.mode.world.car, this.hudInfo);
  }

  /**
   * Makes the renderer show exactly the world's live chunks. Runs every tick; on all but the few ticks where the
   * mode streamed a chunk in or out it is two comparisons and nothing else.
   */
  private syncChunks(): void {
    const chunks = this.mode.world.chunks;
    const count = chunks.length;
    const first = count > 0 ? chunks[0].index : 0;
    const last = count > 0 ? chunks[count - 1].index : -1;
    const shownFirst = this.shownFirst;
    const shownLast = this.shownLast;
    if (first === shownFirst && last === shownLast) return;

    for (let index = shownFirst; index <= shownLast; index++) {
      if (index < first || index > last) this.renderer.removeChunk(index);
    }
    for (let i = 0; i < count; i++) {
      const chunk = chunks[i];
      if (chunk.index < shownFirst || chunk.index > shownLast) this.renderer.addChunk(chunk);
    }
    this.shownFirst = first;
    this.shownLast = last;
  }
}

// ---- Factories --------------------------------------------------------------------------------------------------

export function createWeeklySession(level: Level, deps: SessionDeps): WeeklySession {
  return new WeeklyRun(level, deps);
}

/**
 * Builds the road's first chunks and puts them on screen in place of whatever the renderer showed before.
 * `seed` decides the whole road: the same seed and difficulty are the same run.
 */
export function createEndlessSession(seed: string, difficulty: Difficulty, deps: SessionDeps): EndlessSession {
  return new EndlessRun(seed, difficulty, deps);
}
