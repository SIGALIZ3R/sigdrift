import { createAudio } from './audio/mixer';
import type { GameAudio } from './audio/mixer';
import { lerp, lerpAngle } from './core/fixedMath';
import { createFixedLoop } from './core/loop';
import type { FixedLoop } from './core/loop';
import { generateLevel } from './gen/trackGen';
import { validateLevel } from './gen/validate';
import { previousWeekIds } from './gen/weeklySeed';
import { createInput } from './input/actions';
import type { GameInput } from './input/actions';
import { createRunMode } from './modes/run';
import { createRenderer } from './render/renderer';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from './sim/params';
import { decodeInput, encodeInput } from './sim/replay';
import { createWorld } from './sim/world';
import { DT, PHYSICS_VERSION, SIM_HZ } from './types';
import type {
  BestRecord,
  CarParams,
  GameRenderer,
  InputState,
  Level,
  Pose,
  RenderFrame,
  RunMode,
  RunPhase,
  Settings,
  World,
} from './types';
import { createHud } from './ui/hud';
import type { Hud, HudInfo } from './ui/hud';
import { createMenu } from './ui/menu';
import type { FinishResult, Menu, TitleData } from './ui/menu';
import { loadBest, loadSettings, saveBest, saveSettings } from './ui/storage';
import { createTuningPanel } from './ui/tuning';
import type { TuningPanel } from './ui/tuning';

export interface GameOptions {
  /** Receives the canvas. */
  app: HTMLElement;
  /** Receives the HUD, menus and tuning panel. */
  ui: HTMLElement;
  /** The week shown on the title screen as "this week". */
  weekId: string;
}

/** `results` is the finish screen; the car keeps coasting behind it. */
type Screen = 'title' | 'driving' | 'paused' | 'results';

interface Session {
  world: World;
  run: RunMode;
  /** Best time for this level, kept current when a run beats it. */
  best: BestRecord | null;
}

const PAST_WEEKS = 8;
/** Closing speed (m/s) below which a wall touch makes no sound. */
const MIN_AUDIBLE_IMPACT = 2;
const FINISH_SCREEN_DELAY_TICKS = Math.round(1.2 * SIM_HZ);
const WEBGL_MESSAGE =
  'SigDRIFT needs WebGL 2, which this browser or device could not provide. ' +
  'Try a current browser with hardware acceleration switched on.';

const NEUTRAL_INPUT: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

function openRenderer(app: HTMLElement, settings: Settings): GameRenderer {
  try {
    return createRenderer(app, settings);
  } catch (cause) {
    throw new Error(WEBGL_MESSAGE, { cause });
  }
}

/** True when every tuning value matches. Steering assist included: both sides follow the player's setting. */
function sameParams(a: CarParams, b: CarParams): boolean {
  for (const key of Object.keys(a) as (keyof CarParams)[]) if (a[key] !== b[key]) return false;
  return true;
}

function copyPose(into: Pose, from: Pose): void {
  into.x = from.x;
  into.z = from.z;
  into.heading = from.heading;
}

/** Calls `onChange` whenever the window moves to a screen with a different pixel density, or the page is zoomed. */
function watchPixelRatio(onChange: () => void): void {
  const listen = (): void => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        onChange();
        listen();
      },
      { once: true },
    );
  };
  listen();
}

export class Game {
  /** One object for the whole session, shared by every world and the tuning panel. */
  readonly params: CarParams = cloneParams(DEFAULT_CAR_PARAMS);
  readonly renderer: GameRenderer;

  private readonly app: HTMLElement;
  private readonly currentWeek: string;
  private readonly input: GameInput;
  private readonly audio: GameAudio;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly tuning: TuningPanel;
  private readonly loop: FixedLoop;
  /** What "Reset to defaults" in the tuning panel restores; its steering assist follows the setting. */
  private readonly tuningDefaults: CarParams = cloneParams(DEFAULT_CAR_PARAMS);

  private settings: Settings;
  private screen: Screen = 'title';
  private session: Session;
  /** The level the renderer currently shows. */
  private shownLevel: Level | null = null;

  private readonly prevPose: Pose = { x: 0, z: 0, heading: 0 };
  private readonly renderFrame: RenderFrame;
  private readonly hudInfo: HudInfo = { levelId: '', best: null };
  private alpha = 0;

  private inputCode = -1;
  private simInput: InputState = NEUTRAL_INPUT;
  /** The countdown number last announced with a blip. */
  private countdownSecond = 0;
  private finish: FinishResult | null = null;
  private finishDelayTicks = 0;
  /**
   * True once the current run has been driven, even for a moment, with a car that is not the stock one. Such a
   * run is not saved as a best: its time means nothing next to the stock car's. Set by any tuning-panel edit and
   * by starting a run with edited values; a value changed and put back mid-run still counts.
   */
  private runTuned = false;

  constructor(opts: GameOptions) {
    this.app = opts.app;
    this.currentWeek = opts.weekId;
    this.settings = loadSettings();
    this.renderer = openRenderer(opts.app, this.settings);
    this.input = createInput(window);
    this.audio = createAudio();
    this.hud = createHud(opts.ui);
    this.menu = createMenu(opts.ui, {
      onPlay: (weekId) => this.play(weekId),
      onResume: () => this.resume(),
      onRestart: () => this.restartRun(),
      onQuit: () => this.showTitle(),
      onSettings: (settings) => {
        saveSettings(settings);
        this.applySettings(settings);
      },
    });
    this.tuning = createTuningPanel(opts.ui, {
      getParams: () => this.params,
      defaults: this.tuningDefaults,
      onChange: () => {
        this.runTuned = true;
      },
    });
    this.applySettings(this.settings);

    this.session = this.createSession(this.currentWeek);
    this.renderFrame = {
      pose: { x: 0, z: 0, heading: 0 },
      car: this.session.world.car,
      params: this.params,
      run: this.session.run.state,
      dt: 0,
    };
    this.hud.setVisible(false);

    this.loop = createFixedLoop({
      dt: DT,
      step: () => this.tick(),
      render: (alpha, frameSeconds) => this.frame(alpha, frameSeconds),
    });
    this.listenToWindow();
  }

  get world(): World {
    return this.session.world;
  }

  get run(): RunMode {
    return this.session.run;
  }

  get level(): Level {
    return this.session.world.level;
  }

  start(): void {
    this.loop.start();
  }

  /** The title screen over this week's level, with the car parked on the start line. */
  showTitle(): void {
    this.session = this.createSession(this.currentWeek);
    this.renderer.clearEffects();
    this.hud.setVisible(false);
    this.screen = 'title';
    this.menu.showTitle(this.titleData());
  }

  play(weekId: string): void {
    try {
      this.session = this.createSession(weekId);
    } catch (error) {
      console.error(`SigDRIFT: could not build the level for ${weekId}`, error);
      this.showTitle();
      return;
    }
    this.beginRun();
  }

  // ---- Levels and runs ------------------------------------------------------------------------------------------

  private createSession(weekId: string): Session {
    const world = createWorld(this.levelFor(weekId), this.params);
    this.hudInfo.levelId = weekId;
    this.hudInfo.best = loadBest(weekId);
    copyPose(this.prevPose, world.car);
    return { world, run: createRunMode(world), best: this.hudInfo.best };
  }

  /** Generates the level and hands it to the renderer, unless it is the one already on screen. */
  private levelFor(weekId: string): Level {
    if (this.shownLevel?.id === weekId) return this.shownLevel;
    const level = generateLevel(weekId);
    const check = validateLevel(level);
    if (!check.ok) console.warn(`SigDRIFT: level ${weekId} failed validation`, check.errors);
    this.renderer.setLevel(level);
    this.shownLevel = level;
    return level;
  }

  /** Common to a fresh level and a restart: the run mode is already at the start line with a full countdown. */
  private beginRun(): void {
    this.menu.hide();
    this.finish = null;
    this.finishDelayTicks = 0;
    this.countdownSecond = 0;
    // A fresh run is clean only if it starts on the stock car ("Reset to defaults" followed by a restart).
    this.runTuned = !sameParams(this.params, this.tuningDefaults);
    copyPose(this.prevPose, this.session.world.car);
    this.renderer.clearEffects();
    this.hud.setVisible(true);
    this.screen = 'driving';
    this.audio.resume();
  }

  private restartRun(): void {
    this.session.run.restart();
    this.beginRun();
  }

  private canPause(): boolean {
    return this.screen === 'driving' && this.session.run.state.phase !== 'finished';
  }

  private pause(): void {
    if (!this.canPause()) return;
    this.screen = 'paused';
    this.menu.showPause(this.settings);
  }

  private resume(): void {
    this.menu.hide();
    this.screen = 'driving';
  }

  private titleData(): TitleData {
    const pastWeeks = previousWeekIds(this.currentWeek, PAST_WEEKS);
    const bests: Record<string, BestRecord | null> = { [this.currentWeek]: loadBest(this.currentWeek) };
    for (const id of pastWeeks) bests[id] = loadBest(id);
    return { currentWeek: this.currentWeek, pastWeeks, bests, settings: this.settings };
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.renderer.applySettings(settings);
    this.audio.setVolume(settings.volume);
    const assist = settings.assist ? ASSIST_STRENGTH : 0;
    this.params.steerAssist = assist;
    this.tuningDefaults.steerAssist = assist;
  }

  // ---- Simulation tick ------------------------------------------------------------------------------------------

  private isSimulating(): boolean {
    return this.screen === 'driving' || this.screen === 'results';
  }

  private tick(): void {
    if (!this.isSimulating()) return;
    const { world, run } = this.session;
    const state = run.state;
    const phaseBefore = state.phase;
    const resetsBefore = state.resets;
    const checkpointBefore = state.lastCheckpointTick;
    const worldTickBefore = world.tick;

    copyPose(this.prevPose, world.car);
    run.step(phaseBefore === 'finished' ? NEUTRAL_INPUT : this.sampleInput());

    // The world is not necessarily stepped on every run tick; an old collision must not be replayed.
    const collision = world.tick !== worldTickBefore ? world.lastCollision : null;
    this.renderer.onSimTick(world.car, world.params, collision);
    if (collision && collision.impact > MIN_AUDIBLE_IMPACT) this.audio.collision(collision.impact);

    if (state.resets !== resetsBefore) this.onRespawn();
    this.announcePhase(phaseBefore);
    if (state.phase !== 'finished' && state.lastCheckpointTick !== checkpointBefore && state.lastCheckpointTick >= 0) {
      this.audio.blip('checkpoint');
    }
  }

  /**
   * The simulation only ever sees input that a replay could store. Decoding again only when the code changes
   * gives the same values as quantising every tick, without a new object per tick.
   */
  private sampleInput(): InputState {
    const code = encodeInput(this.input.sample());
    if (code !== this.inputCode) {
      this.inputCode = code;
      this.simInput = decodeInput(code);
    }
    return this.simInput;
  }

  private onRespawn(): void {
    // Interpolating across the teleport would draw the car streaking back to the checkpoint.
    copyPose(this.prevPose, this.session.world.car);
    this.audio.blip('reset');
  }

  private announcePhase(phaseBefore: RunPhase): void {
    const state = this.session.run.state;
    if (state.phase === 'countdown') {
      this.announceCountdown(state.countdownTicks);
    } else if (phaseBefore === 'countdown') {
      this.audio.blip('go');
    } else if (state.phase === 'finished') {
      if (phaseBefore !== 'finished') this.onFinish();
      else this.advanceFinishDelay();
    }
  }

  /** Blips when the number the HUD shows changes. */
  private announceCountdown(ticksLeft: number): void {
    const second = Math.max(1, Math.ceil(ticksLeft / SIM_HZ));
    if (second === this.countdownSecond) return;
    this.countdownSecond = second;
    this.audio.blip('countdown');
  }

  private onFinish(): void {
    const state = this.session.run.state;
    const previous = this.session.best;
    const record: BestRecord = { ticks: state.ticks, driftScore: state.driftScore, physicsVersion: PHYSICS_VERSION };
    const tuned = this.runTuned;
    const isNewBest = !tuned && (previous === null || record.ticks < previous.ticks);
    if (!tuned) saveBest(this.level.id, record);
    if (isNewBest) {
      this.session.best = record;
      this.hudInfo.best = record;
    }
    this.finish = {
      levelId: this.level.id,
      ticks: record.ticks,
      driftScore: record.driftScore,
      resets: state.resets,
      best: previous,
      isNewBest,
      tuned,
    };
    this.finishDelayTicks = FINISH_SCREEN_DELAY_TICKS;
    this.audio.blip('finish');
  }

  private advanceFinishDelay(): void {
    if (this.finish === null || --this.finishDelayTicks > 0) return;
    this.screen = 'results';
    this.menu.showFinish(this.finish);
    this.finish = null;
  }

  // ---- Rendered frame -------------------------------------------------------------------------------------------

  private frame(alpha: number, frameSeconds: number): void {
    this.handleMeta();
    // While nothing is stepping the loop's alpha keeps cycling; holding the last one keeps the car still.
    if (this.isSimulating()) this.alpha = alpha;

    const { world, run } = this.session;
    const car = world.car;
    const frame = this.renderFrame;
    frame.pose.x = lerp(this.prevPose.x, car.x, this.alpha);
    frame.pose.z = lerp(this.prevPose.z, car.z, this.alpha);
    frame.pose.heading = lerpAngle(this.prevPose.heading, car.heading, this.alpha);
    frame.car = car;
    frame.params = world.params;
    frame.run = run.state;
    // Zero time freezes smoke, sparks and the camera along with the simulation.
    frame.dt = this.screen === 'paused' ? 0 : frameSeconds;
    this.renderer.render(frame);

    if (this.screen !== 'title') this.hud.update(run.state, car, this.hudInfo);
    this.tuning.update(car);
    this.audio.update(car, world.params, this.screen === 'driving');
  }

  private handleMeta(): void {
    const meta = this.input.meta();
    if (meta.toggleTuning) this.tuning.toggle();
    if (meta.pause) {
      if (this.screen === 'paused') this.resume();
      else this.pause();
    }
    if (meta.restart && this.screen !== 'title') this.restartRun();
    if (meta.confirm && this.menu.isOpen) this.menu.confirm();
  }

  // ---- Window ---------------------------------------------------------------------------------------------------

  private listenToWindow(): void {
    const resize = (): void => this.renderer.resize(this.app.clientWidth, this.app.clientHeight);
    window.addEventListener('resize', resize);
    watchPixelRatio(resize);
    resize();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    // Losing focus drops every held key (see keyboard.ts), so the clock must not keep running on a car nobody
    // can steer: alt-tab to a window beside this one, a click on the address bar, a system dialog.
    window.addEventListener('blur', () => this.pause());
    // The same goes for the pad that was doing the driving being unplugged or running out of battery.
    window.addEventListener('gamepaddisconnected', () => {
      if (this.input.lastDevice === 'gamepad') this.pause();
    });
    // While driving nothing on the page can take focus, so Tab (right beside Q, W and A) would hand it to the
    // browser's own controls. In menus Tab keeps its normal job.
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Tab' && this.screen === 'driving') event.preventDefault();
    });

    // Menus can be confirmed from the frame loop (Enter, gamepad), which is not a user gesture as far as the
    // browser's autoplay rules go. Waking audio straight from the event keeps sound working on those paths.
    const wakeAudio = (): void => this.audio.resume();
    window.addEventListener('pointerdown', wakeAudio);
    window.addEventListener('keydown', wakeAudio);
  }
}
