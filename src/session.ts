/**
 * One run in progress, whichever mode it belongs to. The game drives a `Session` without knowing the rules behind
 * it: it steps it, restarts it, asks which phase it is in and lets it report its own ending. Everything that
 * differs between a track run (this week's or one of the five levels) and an endless one lives in the two
 * implementations below.
 */
import type { GameAudio } from './audio/mixer';
import { DriveCues } from './cues';
import { createEndlessMode } from './modes/endless';
import { createRunMode } from './modes/run';
import { createWorld } from './sim/world';
import { PHYSICS_VERSION, SIM_HZ } from './types';
import type {
  CarParams,
  Difficulty,
  EndlessMode,
  EndlessRecords,
  EndlessState,
  GameRenderer,
  InputState,
  Level,
  RunMode,
  RunRecords,
  RunState,
  ScoreState,
  SimBase,
} from './types';
import type { EndlessHudInfo, Hud, HudInfo } from './ui/hud';
import type { FinishResult, GameOverResult, Menu } from './ui/menu';
import { getCar } from './sim/cars';
import { loadEndlessRecords, loadRunRecords, markLevelCompleted, saveEndlessRecord, saveRunRecord } from './ui/storage';

/** `over` covers a finished track run and a dead endless one: no more player input, no pausing. */
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
  readonly score: ScoreState;
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

/** What a track session needs to know about the track besides the level itself. */
export interface TrackInfo {
  kind: 'weekly' | 'level';
  /** Week id or level id: the storage key for records. */
  trackId: string;
  /** Level name, or the week id. */
  trackName: string;
  /** The level after this one (L1..L4), or null. */
  nextLevelId: string | null;
}

export interface TrackSession extends SessionBase {
  readonly kind: 'weekly' | 'level';
  readonly mode: RunMode;
  readonly level: Level;
  readonly info: TrackInfo;
}

export interface EndlessSession extends SessionBase {
  readonly kind: 'endless';
  readonly mode: EndlessMode;
  readonly difficulty: Difficulty;
  readonly seed: string;
}

export type Session = TrackSession | EndlessSession;

const FINISH_SCREEN_DELAY_TICKS = Math.round(1.2 * SIM_HZ);
/** A little longer than a finish: the crash or the fall has to be seen before the screen covers it. */
const GAME_OVER_SCREEN_DELAY_TICKS = Math.round(1.6 * SIM_HZ);

/** Records keep whole points. */
function wholePoints(points: number): number {
  return Number.isFinite(points) && points > 0 ? Math.floor(points) : 0;
}

// ---- Weekly run or level ------------------------------------------------------------------------------------------

class TrackRun implements TrackSession {
  readonly kind: 'weekly' | 'level';
  readonly mode: RunMode;
  readonly level: Level;
  readonly info: TrackInfo;
  readonly endless = null;
  readonly engineRunning = true;
  readonly endScreenDelayTicks = FINISH_SCREEN_DELAY_TICKS;

  private readonly audio: GameAudio;
  private readonly cues: DriveCues;
  private readonly hudInfo: HudInfo;
  private records: RunRecords;
  private result: FinishResult | null = null;

  constructor(level: Level, info: TrackInfo, deps: SessionDeps) {
    this.kind = info.kind;
    this.level = level;
    this.info = info;
    this.audio = deps.audio;
    this.cues = new DriveCues(deps.audio);
    this.mode = createRunMode(createWorld(level, deps.params));
    this.records = loadRunRecords(info.trackId);
    this.hudInfo = { trackName: info.trackName, records: this.records };
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

  get score(): ScoreState {
    return this.mode.state.score;
  }

  step(input: InputState): boolean {
    const state = this.mode.state;
    const world = this.mode.world;
    const resetsBefore = state.resets;
    const checkpointBefore = state.lastCheckpointTick;
    const fallBefore = state.lastFallTick;
    const waitingBefore = state.respawnInTicks;
    const worldTickBefore = world.tick;
    this.cues.before(state.score);
    this.mode.step(input);
    this.cues.after(world, state.score, world.tick !== worldTickBefore);

    if (state.lastFallTick !== fallBefore && state.lastFallTick >= 0) this.cues.modeFall();
    const reset = state.resets !== resetsBefore;
    if (reset) this.audio.blip('reset');
    if (state.phase !== 'finished' && state.lastCheckpointTick !== checkpointBefore && state.lastCheckpointTick >= 0) {
      this.audio.blip('checkpoint');
    }
    // Put back after a fall: the wait ran out this tick.
    const putBack = waitingBefore > 0 && state.respawnInTicks <= 0;
    if (reset || putBack) this.cues.reset();
    return reset || putBack;
  }

  restart(): void {
    this.result = null;
    this.cues.reset();
    this.mode.restart();
  }

  end(tuned: boolean): void {
    const state = this.mode.state;
    const trackId = this.info.trackId;
    const previousBest = this.records.bestTime;
    const score = wholePoints(state.score.points);
    // Finishing a level counts towards the garage whatever the car or its tuning. Marked before the record is
    // saved: a stored best time also counts as finished, and would hide that this finish is the one that unlocked.
    const unlocked = this.kind === 'level' ? markLevelCompleted(trackId) : [];
    const saved = tuned
      ? null
      : saveRunRecord(trackId, {
          ticks: state.ticks,
          score,
          date: new Date().toISOString(),
          physicsVersion: PHYSICS_VERSION,
        });
    this.records = loadRunRecords(trackId);
    this.hudInfo.records = this.records;
    this.result = {
      mode: this.kind,
      trackId,
      trackName: this.info.trackName,
      ticks: state.ticks,
      score,
      peakMultiplier: state.score.peakMultiplier,
      falls: state.falls,
      resets: state.resets,
      previousBest,
      saved,
      highScores: this.records.highScores,
      nextLevelId: this.info.nextLevelId,
      tuned,
      unlockedCars: unlocked.map((id) => getCar(id).name),
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

// ---- Endless run --------------------------------------------------------------------------------------------------

class EndlessRun implements EndlessSession {
  readonly kind = 'endless';
  readonly mode: EndlessMode;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly run = null;
  readonly endScreenDelayTicks = GAME_OVER_SCREEN_DELAY_TICKS;

  private readonly audio: GameAudio;
  private readonly renderer: GameRenderer;
  private readonly cues: DriveCues;
  private readonly hudInfo: EndlessHudInfo;
  private records: EndlessRecords;
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
    this.cues = new DriveCues(deps.audio);
    this.mode = createEndlessMode(seed, difficulty, deps.params);
    this.records = loadEndlessRecords(difficulty);
    this.hudInfo = { records: this.records };
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

  get score(): ScoreState {
    return this.mode.state.score;
  }

  get engineRunning(): boolean {
    return this.mode.state.phase !== 'dead';
  }

  step(input: InputState): boolean {
    const state = this.mode.state;
    const world = this.mode.world;
    const crashBefore = state.lastCrashTick;
    const phaseBefore = state.phase;
    const worldTickBefore = world.tick;
    this.cues.before(state.score);
    this.mode.step(input);
    this.syncChunks();
    this.cues.after(world, state.score, world.tick !== worldTickBefore);

    if (state.lastCrashTick !== crashBefore && state.lastCrashTick >= 0) this.audio.blip('crash');
    if (phaseBefore !== 'dead' && state.phase === 'dead' && state.deathCause === 'offTrack') this.cues.modeFall();
    return false;
  }

  restart(): void {
    this.result = null;
    this.cues.reset();
    this.mode.restart();
    // The same seed gives the same road, so chunks still on screen from the first stretch stay as they are.
    this.syncChunks();
  }

  end(tuned: boolean): void {
    const state = this.mode.state;
    const previousBest = this.records.bestDistance;
    const score = wholePoints(state.score.points);
    // A run that went nowhere and scored nothing (straight off the start) would only clutter the table.
    const empty = state.distance <= 0 && score === 0;
    const saved =
      tuned || empty
        ? null
        : saveEndlessRecord(this.difficulty, {
          distance: state.distance,
          score,
          ticks: state.ticks,
          date: new Date().toISOString(),
          physicsVersion: PHYSICS_VERSION,
        });
    this.records = loadEndlessRecords(this.difficulty);
    this.hudInfo.records = this.records;
    this.result = {
      difficulty: this.difficulty,
      distance: state.distance,
      score,
      peakMultiplier: state.score.peakMultiplier,
      ticks: state.ticks,
      cause: state.deathCause ?? 'crashes',
      previousBest,
      saved,
      highScores: this.records.highScores,
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

// ---- Factories ----------------------------------------------------------------------------------------------------

/** A weekly run or a level on `level`, which the caller has already put on screen. */
export function createTrackSession(level: Level, info: TrackInfo, deps: SessionDeps): TrackSession {
  return new TrackRun(level, info, deps);
}

/**
 * Builds the road's first chunks and puts them on screen in place of whatever the renderer showed before.
 * `seed` decides the whole road: the same seed and difficulty are the same run.
 */
export function createEndlessSession(seed: string, difficulty: Difficulty, deps: SessionDeps): EndlessSession {
  return new EndlessRun(seed, difficulty, deps);
}
