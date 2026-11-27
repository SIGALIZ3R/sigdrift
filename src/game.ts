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
import { createRenderer } from './render/renderer';
import { createEndlessSession, createWeeklySession } from './session';
import type { Session, SessionDeps, SessionPhase } from './session';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from './sim/params';
import { decodeInput, encodeInput } from './sim/replay';
import { DT, SIM_HZ } from './types';
import type {
  BestRecord,
  CarParams,
  Difficulty,
  EndlessBest,
  EndlessMode,
  EndlessWorld,
  GameRenderer,
  InputState,
  Level,
  Pose,
  RenderFrame,
  RunMode,
  Settings,
  World,
} from './types';
import { createHud } from './ui/hud';
import type { Hud } from './ui/hud';
import { createMenu } from './ui/menu';
import type { Menu, TitleData } from './ui/menu';
import { createMuteButton } from './ui/muteButton';
import type { MuteButton } from './ui/muteButton';
import { DIFFICULTIES, loadBest, loadEndlessBest, loadSettings, saveSettings } from './ui/storage';
import { createTuningPanel } from './ui/tuning';
import type { TuningPanel } from './ui/tuning';

export interface GameOptions {
  /** Receives the canvas. */
  app: HTMLElement;
  /** Receives the HUD, menus, mute button and tuning panel. */
  ui: HTMLElement;
  /** The week shown on the title screen as "this week". */
  weekId: string;
  /** Gives every endless run this road, for testing. Left out, each run from the title or RETRY gets a new one. */
  endlessSeed?: string | null;
}

export type GameMode = Session['kind'];

/** `results` is the finish or game-over screen; the car keeps coasting behind it. */
type Screen = 'title' | 'driving' | 'paused' | 'results';

const PAST_WEEKS = 8;
/** Closing speed (m/s) below which a wall touch makes no sound. */
const MIN_AUDIBLE_IMPACT = 2;
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

/** A road nobody has driven before. Only ever used as a generator seed, so any unpredictable string will do. */
function randomSeed(): string {
  const words = new Uint32Array(2);
  try {
    globalThis.crypto.getRandomValues(words);
  } catch {
    words[0] = Math.random() * 0x100000000;
    words[1] = Math.random() * 0x100000000;
  }
  return words[0].toString(36) + words[1].toString(36);
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
  private readonly fixedEndlessSeed: string | null;
  private readonly input: GameInput;
  private readonly audio: GameAudio;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly muteButton: MuteButton;
  private readonly tuning: TuningPanel;
  private readonly loop: FixedLoop;
  private readonly sessionDeps: SessionDeps;
  /** What "Reset to defaults" in the tuning panel restores; its steering assist follows the setting. */
  private readonly tuningDefaults: CarParams = cloneParams(DEFAULT_CAR_PARAMS);

  private settings: Settings;
  private screen: Screen = 'title';
  /** The run in progress, or the one parked behind the title screen. */
  private session: Session;
  /** The weekly level generated last, kept so that returning to it does not generate it again. */
  private level: Level | null = null;
  /** Whether `level` is what the renderer shows; false while an endless road has taken its place. */
  private levelOnScreen = false;

  private readonly prevPose: Pose = { x: 0, z: 0, heading: 0 };
  private prevHeight = 0;
  private readonly renderFrame: RenderFrame;
  private alpha = 0;

  private inputCode = -1;
  private simInput: InputState = NEUTRAL_INPUT;
  /** The countdown number last announced with a blip. */
  private countdownSecond = 0;
  /** Ticks until the result screen opens; counts only once the run is over. */
  private endScreenDelayTicks = 0;
  /**
   * True once the current run has been driven, even for a moment, with a car that is not the stock one. Such a
   * run is not saved as a best: its time or distance means nothing next to the stock car's. Set by any
   * tuning-panel edit and by starting a run with edited values; a value changed and put back mid-run still counts.
   */
  private runTuned = false;

  constructor(opts: GameOptions) {
    this.app = opts.app;
    this.currentWeek = opts.weekId;
    this.fixedEndlessSeed = opts.endlessSeed || null;
    this.settings = loadSettings();
    this.renderer = openRenderer(opts.app, this.settings);
    this.input = createInput(window);
    this.audio = createAudio();
    this.sessionDeps = { renderer: this.renderer, audio: this.audio, params: this.params };
    this.hud = createHud(opts.ui);
    this.menu = createMenu(opts.ui, {
      onPlay: (weekId) => this.play(weekId),
      onPlayEndless: (difficulty) => this.playEndless(difficulty),
      onResume: () => this.resume(),
      onRestart: () => this.onMenuRestart(),
      onQuit: () => this.showTitle(),
      onSettings: (settings) => {
        saveSettings(settings);
        this.applySettings(settings);
      },
    });
    // The button and the menus' Sound switch tell each other about changes; the game only hears the outcome.
    this.muteButton = createMuteButton(opts.ui, {
      muted: this.settings.muted,
      onToggle: (muted) => this.setMuted(muted),
    });
    this.tuning = createTuningPanel(opts.ui, {
      getParams: () => this.params,
      defaults: this.tuningDefaults,
      onChange: () => {
        this.runTuned = true;
      },
    });
    // Includes the mute state, so a game that starts muted is silent before its first sound.
    this.applySettings(this.settings);

    this.session = this.weeklySession(this.currentWeek);
    this.renderFrame = {
      pose: { x: 0, z: 0, heading: 0 },
      car: this.session.world.car,
      params: this.params,
      run: this.session.run,
      endless: this.session.endless,
      height: 0,
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

  // ---- For the debug hook ---------------------------------------------------------------------------------------

  get mode(): GameMode {
    return this.session.kind;
  }

  get world(): World | EndlessWorld {
    return this.session.mode.world;
  }

  /** The weekly run in progress, or null in endless mode. */
  get run(): RunMode | null {
    return this.session.kind === 'weekly' ? this.session.mode : null;
  }

  /** The endless run in progress, or null in a weekly run. */
  get endless(): EndlessMode | null {
    return this.session.kind === 'endless' ? this.session.mode : null;
  }

  /** The weekly level being driven, or null in endless mode. */
  get currentLevel(): Level | null {
    return this.session.kind === 'weekly' ? this.session.level : null;
  }

  // ---- Screens --------------------------------------------------------------------------------------------------

  start(): void {
    this.loop.start();
  }

  /** The title screen over this week's level, with the car parked on the start line. */
  showTitle(): void {
    this.adopt(this.weeklySession(this.currentWeek));
    this.renderer.clearEffects();
    this.hud.setVisible(false);
    this.screen = 'title';
    this.menu.showTitle(this.titleData());
  }

  play(weekId: string): void {
    try {
      this.adopt(this.weeklySession(weekId));
    } catch (error) {
      console.error(`SigDRIFT: could not build the level for ${weekId}`, error);
      this.showTitle();
      return;
    }
    this.beginRun();
  }

  /** A new endless run on a road of its own (or on the fixed test seed). */
  playEndless(difficulty: Difficulty): void {
    const seed = this.fixedEndlessSeed ?? randomSeed();
    // Whether or not the road gets built, the renderer may already have let go of the weekly level.
    this.levelOnScreen = false;
    try {
      this.adopt(createEndlessSession(seed, difficulty, this.sessionDeps));
    } catch (error) {
      console.error(`SigDRIFT: could not build the ${difficulty} endless road for seed ${seed}`, error);
      this.showTitle();
      return;
    }
    this.beginRun();
  }

  // ---- Sessions and runs ----------------------------------------------------------------------------------------

  private weeklySession(weekId: string): Session {
    return createWeeklySession(this.levelFor(weekId), this.sessionDeps);
  }

  /** Generates the level and hands it to the renderer, unless it is the one already on screen. */
  private levelFor(weekId: string): Level {
    let level = this.level;
    if (level === null || level.id !== weekId) {
      level = generateLevel(weekId);
      const check = validateLevel(level);
      if (!check.ok) console.warn(`SigDRIFT: level ${weekId} failed validation`, check.errors);
      this.level = level;
      this.levelOnScreen = false;
    }
    if (!this.levelOnScreen) {
      this.renderer.setLevel(level);
      this.levelOnScreen = true;
    }
    return level;
  }

  private adopt(session: Session): void {
    this.session = session;
    this.snapCar();
  }

  /** Makes the car's current position the one to interpolate from: nothing is drawn sliding in from elsewhere. */
  private snapCar(): void {
    const car = this.session.world.car;
    copyPose(this.prevPose, car);
    this.prevHeight = car.y;
  }

  /** Common to a fresh session and a restart: the mode is already at the start line with a full countdown. */
  private beginRun(): void {
    this.menu.hide();
    this.endScreenDelayTicks = 0;
    this.countdownSecond = 0;
    // A fresh run is clean only if it starts on the stock car ("Reset to defaults" followed by a restart).
    this.runTuned = !sameParams(this.params, this.tuningDefaults);
    this.snapCar();
    this.renderer.clearEffects();
    this.hud.setVisible(true);
    // A restart inside the same second of the countdown shows the same number: it must pop again.
    this.hud.resetCountdown();
    this.screen = 'driving';
    this.audio.resume();
  }

  /** The same road again from the start: the restart key at any time, and Restart in the pause menu. */
  private restartRun(): void {
    this.session.restart();
    this.beginRun();
  }

  /**
   * Restart from a menu. On the pause screen that is the run in progress again. RETRY after an endless run is a
   * new run instead, and so a new road: the road is different every time.
   */
  private onMenuRestart(): void {
    const session = this.session;
    if (session.kind === 'endless' && this.screen === 'results') this.playEndless(session.difficulty);
    else this.restartRun();
  }

  private canPause(): boolean {
    return this.screen === 'driving' && this.session.phase !== 'over';
  }

  private pause(): void {
    if (!this.canPause()) return;
    this.screen = 'paused';
    this.menu.showPause(this.settings);
  }

  private resume(): void {
    this.menu.hide();
    // The countdown stood still while paused but its number's pop did not: show the number again.
    this.hud.resetCountdown();
    this.screen = 'driving';
  }

  private titleData(): TitleData {
    const pastWeeks = previousWeekIds(this.currentWeek, PAST_WEEKS);
    const bests: Record<string, BestRecord | null> = { [this.currentWeek]: loadBest(this.currentWeek) };
    for (const id of pastWeeks) bests[id] = loadBest(id);
    const endlessBests = {} as Record<Difficulty, EndlessBest | null>;
    for (const difficulty of DIFFICULTIES) endlessBests[difficulty] = loadEndlessBest(difficulty);
    return { currentWeek: this.currentWeek, pastWeeks, bests, endlessBests, settings: this.settings };
  }

  // ---- Settings and sound ---------------------------------------------------------------------------------------

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.renderer.applySettings(settings);
    this.audio.setVolume(settings.volume);
    this.audio.setMuted(settings.muted);
    const assist = settings.assist ? ASSIST_STRENGTH : 0;
    this.params.steerAssist = assist;
    this.tuningDefaults.steerAssist = assist;
  }

  /** A mute change that did not come through a menu: the corner button or the M key. */
  private setMuted(muted: boolean): void {
    if (muted === this.settings.muted) return;
    this.settings = { ...this.settings, muted };
    saveSettings(this.settings);
    this.audio.setMuted(muted);
  }

  private toggleMute(): void {
    const muted = !this.settings.muted;
    this.setMuted(muted);
    // The button passes the news on to an open menu's Sound switch.
    this.muteButton.set(muted);
  }

  // ---- Simulation tick ------------------------------------------------------------------------------------------

  private isSimulating(): boolean {
    return this.screen === 'driving' || this.screen === 'results';
  }

  private tick(): void {
    if (!this.isSimulating()) return;
    const session = this.session;
    const phaseBefore = session.phase;
    const worldTickBefore = session.world.tick;

    this.snapCar();
    const teleported = session.step(phaseBefore === 'over' ? NEUTRAL_INPUT : this.sampleInput());

    // The world is not stepped on every mode tick (countdown, a car that came down off the road). On those the
    // car state is whatever the last real step left: laying marks and smoke from it, or replaying its collision,
    // would repeat that one moment for as long as the car stands still.
    const world = session.world;
    if (world.tick !== worldTickBefore) {
      const collision = world.lastCollision;
      this.renderer.onSimTick(world.car, world.params, collision);
      if (collision && collision.impact > MIN_AUDIBLE_IMPACT) this.audio.collision(collision.impact);
    }

    // Interpolating across a respawn would draw the car streaking back to the checkpoint.
    if (teleported) this.snapCar();
    this.announcePhase(phaseBefore);
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

  private announcePhase(phaseBefore: SessionPhase): void {
    const session = this.session;
    const phase = session.phase;
    if (phase === 'countdown') {
      this.announceCountdown(session.countdownTicks);
    } else if (phaseBefore === 'countdown') {
      this.audio.blip('go');
    }
    if (phase !== 'over') return;
    if (phaseBefore !== 'over') {
      session.end(this.runTuned);
      this.endScreenDelayTicks = session.endScreenDelayTicks;
    } else if (this.screen === 'driving' && --this.endScreenDelayTicks <= 0) {
      this.screen = 'results';
      session.showEndScreen(this.menu);
    }
  }

  /** Blips when the number the HUD shows changes. */
  private announceCountdown(ticksLeft: number): void {
    const second = Math.max(1, Math.ceil(ticksLeft / SIM_HZ));
    if (second === this.countdownSecond) return;
    this.countdownSecond = second;
    this.audio.blip('countdown');
  }

  // ---- Rendered frame -------------------------------------------------------------------------------------------

  private frame(alpha: number, frameSeconds: number): void {
    this.handleMeta();
    // While nothing is stepping the loop's alpha keeps cycling; holding the last one keeps the car still.
    if (this.isSimulating()) this.alpha = alpha;

    const session = this.session;
    const world = session.world;
    const car = world.car;
    const frame = this.renderFrame;
    frame.pose.x = lerp(this.prevPose.x, car.x, this.alpha);
    frame.pose.z = lerp(this.prevPose.z, car.z, this.alpha);
    frame.pose.heading = lerpAngle(this.prevPose.heading, car.heading, this.alpha);
    // Always zero in a weekly run: its road is flat and the car never leaves it.
    frame.height = lerp(this.prevHeight, car.y, this.alpha);
    frame.car = car;
    frame.params = world.params;
    frame.run = session.run;
    frame.endless = session.endless;
    // Zero time freezes smoke, sparks and the camera along with the simulation.
    frame.dt = this.screen === 'paused' ? 0 : frameSeconds;
    this.renderer.render(frame);

    if (this.screen !== 'title') session.updateHud(this.hud);
    this.tuning.update(car);
    this.audio.update(car, world.params, this.screen === 'driving' && session.engineRunning);
  }

  private handleMeta(): void {
    const meta = this.input.meta();
    if (meta.toggleMute) this.toggleMute();
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
