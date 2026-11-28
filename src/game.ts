import { createAudio } from './audio/mixer';
import type { GameAudio } from './audio/mixer';
import { engineSoundFor } from './audio/engineSounds';
import { SONGS } from './audio/music';
import { lerp, lerpAngle } from './core/fixedMath';
import { createFixedLoop } from './core/loop';
import type { FixedLoop } from './core/loop';
import { LEVELS, generateLevelFor, getLevelDef } from './gen/levels';
import { generateLevel } from './gen/trackGen';
import { previousWeekIds } from './gen/weeklySeed';
import { createInput } from './input/actions';
import type { GameInput } from './input/actions';
import { openRenderer, randomSeed, startsFromTitle, watchPixelRatio } from './platform';
import { createEndlessSession, createTrackSession } from './session';
import type { Session, SessionDeps, SessionPhase, TrackInfo } from './session';
import { getCar } from './sim/cars';
import type { CarId } from './sim/cars';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from './sim/params';
import { decodeInput, encodeInput } from './sim/replay';
import { DT, SIM_HZ } from './types';
import type {
  CarParams,
  Difficulty,
  EndlessMode,
  EndlessWorld,
  GameMode,
  GameRenderer,
  InputState,
  Level,
  MetaInput,
  Pose,
  RenderFrame,
  RunMode,
  Settings,
  World,
} from './types';
import { createGlitcher } from './ui/glitch';
import { createHud } from './ui/hud';
import type { Hud } from './ui/hud';
import { createMenu } from './ui/menu';
import type { Menu, UiSound } from './ui/menu';
import { createMuteButton } from './ui/muteButton';
import type { MuteButton } from './ui/muteButton';
import { loadCar, loadSettings, saveSettings } from './ui/storage';
import { createTouchControls } from './ui/touchControls';
import type { TouchControls } from './ui/touchControls';
import { createTuningPanel } from './ui/tuning';
import type { TuningPanel } from './ui/tuning';

export type { GameMode } from './types';

export interface GameOptions {
  /** Receives the canvas. */
  app: HTMLElement;
  /** Receives the HUD, menus, mute button and tuning panel. */
  ui: HTMLElement;
  /** The week shown in the menus as "this week". */
  weekId: string;
  /** Gives every endless run this road, for testing. Left out, each run gets a new one. */
  endlessSeed?: string | null;
}

/**
 * `menu`: title, main menu and the select screens, with this week's level parked behind them.
 * `results`: the finish or game-over screen; the car keeps coasting behind it.
 */
type Screen = 'menu' | 'driving' | 'paused' | 'results';

const PAST_WEEKS = 8;
/** Closing speed (m/s) below which a wall touch makes no sound. */
const MIN_AUDIBLE_IMPACT = 2;
/** A car that moved further than this in one tick was put somewhere: never draw it streaking there. */
const TELEPORT_DISTANCE = 6;
/** On the endless road the background music changes after this much driving, s. */
const ENDLESS_SONG_SECONDS = 120;
const UI_BLIPS = { move: 'uiMove', select: 'uiSelect', back: 'uiBack' } as const;

const NEUTRAL_INPUT: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };

/** True when every tuning value matches. Steering assist included: both sides follow the player's setting. */
function sameParams(a: CarParams, b: CarParams): boolean {
  for (const key of Object.keys(a) as (keyof CarParams)[]) if (a[key] !== b[key]) return false;
  return true;
}

/** The level after `id` among the five, or null. */
function nextLevelOf(id: string): string | null {
  const index = LEVELS.findIndex((def) => def.id === id);
  return index >= 0 && index + 1 < LEVELS.length ? LEVELS[index + 1].id : null;
}

export class Game {
  /** One object for the whole session, shared by every world and the tuning panel. */
  readonly params: CarParams = cloneParams(DEFAULT_CAR_PARAMS);
  readonly renderer: GameRenderer;

  private readonly app: HTMLElement;
  private readonly currentWeek: string;
  private readonly fixedEndlessSeed: string | null;
  private readonly input: GameInput;
  private readonly touch: TouchControls;
  private readonly audio: GameAudio;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly muteButton: MuteButton;
  private readonly tuning: TuningPanel;
  private readonly loop: FixedLoop;
  private readonly sessionDeps: SessionDeps;
  /** What "Reset to defaults" in the tuning panel restores; its steering assist follows the setting. */
  private readonly tuningDefaults: CarParams = cloneParams(DEFAULT_CAR_PARAMS);
  /** Levels generated so far, by week id or level id: going back to one never generates it again. */
  private readonly levels = new Map<string, Level>();

  private settings: Settings;
  private screen: Screen = 'menu';
  /** The run in progress, or the one parked behind the menus. */
  private session: Session;
  /** Id of the level the renderer shows, or null while an endless road has taken its place. */
  private levelOnScreen: string | null = null;

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
  /** Set when a key left the title screen: that key's menu flags, read next frame, must not act on the main menu. */
  private swallowMeta = false;
  /**
   * Set when a menu opens over a car that was being driven (pause, result screen). The driving keys double as menu
   * navigation and a held key auto-repeats, so a throttle still held when the finish screen appears would walk the
   * focus away from RETRY. Nav is ignored until the driving controls have been let go.
   */
  private navHeld = false;
  /** Driving time since the current song was picked, s. */
  private songSeconds = 0;
  /**
   * True once the current run has been driven, even for a moment, with a car that is not the stock one. Such a
   * run is not saved: its time or score means nothing next to the stock car's. Set by any tuning-panel edit and by
   * starting a run with edited values; a value changed and put back mid-run still counts.
   */
  private runTuned = false;

  constructor(opts: GameOptions) {
    this.app = opts.app;
    this.currentWeek = opts.weekId;
    this.fixedEndlessSeed = opts.endlessSeed || null;
    this.settings = loadSettings();
    this.renderer = openRenderer(opts.app, this.settings);
    this.touch = createTouchControls(opts.ui);
    this.input = createInput(window, this.touch);
    this.audio = createAudio();
    this.sessionDeps = { renderer: this.renderer, audio: this.audio, params: this.params };
    this.hud = createHud(opts.ui);
    this.menu = createMenu(
      opts.ui,
      {
        onPlayWeekly: (weekId) => this.playWeekly(weekId),
        onPlayLevel: (levelId) => this.playLevel(levelId),
        onPlayEndless: (difficulty) => this.playEndless(difficulty),
        onResume: () => this.resume(),
        onRestart: () => this.onMenuRestart(),
        onQuit: () => this.showMainMenu(),
        onNextLevel: (levelId) => this.playLevel(levelId),
        onSettings: (settings) => {
          saveSettings(settings);
          this.applySettings(settings);
        },
        onSelectCar: (id) => this.applyCar(id),
        onUiSound: (kind: UiSound) => this.audio.blip(UI_BLIPS[kind]),
      },
      { currentWeek: this.currentWeek, pastWeeks: previousWeekIds(this.currentWeek, PAST_WEEKS), levels: LEVELS },
    );
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
    // The garage pick, before the settings put the steering assist on top of it.
    this.applyCar(loadCar());
    // Glitch accents on whatever UI is on screen. Like the rest of the game, it lives as long as the page does.
    createGlitcher(opts.ui);
    // Includes the mute state, so a game that starts muted is silent before its first sound.
    this.applySettings(this.settings);

    this.session = this.weeklySession(this.currentWeek);
    this.renderFrame = {
      pose: { x: 0, z: 0, heading: 0, y: 0 },
      car: this.session.world.car,
      params: this.params,
      run: this.session.run,
      endless: this.session.endless,
      height: 0,
      dt: 0,
    };
    this.snapCar();
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

  /** The weekly run or level in progress, or null in endless mode. */
  get run(): RunMode | null {
    return this.session.kind === 'endless' ? null : this.session.mode;
  }

  /** The endless run in progress, or null otherwise. */
  get endless(): EndlessMode | null {
    return this.session.kind === 'endless' ? this.session.mode : null;
  }

  /** The level being driven (or parked behind the menus), or null in endless mode. */
  get currentLevel(): Level | null {
    return this.session.kind === 'endless' ? null : this.session.level;
  }

  // ---- Screens --------------------------------------------------------------------------------------------------

  start(): void {
    this.loop.start();
  }

  /** The title screen over this week's level, with the car parked on the start line. */
  showTitle(): void {
    this.parkBehindMenu();
    this.menu.showTitle();
  }

  /** The main menu over this week's level: where QUIT TO MENU and MENU lead. */
  showMainMenu(): void {
    this.parkBehindMenu();
    this.menu.showMain();
  }

  playWeekly(weekId: string): void {
    this.startTrack(weekId, () =>
      createTrackSession(this.levelFor(weekId, () => generateLevel(weekId)), this.weeklyInfo(weekId), this.sessionDeps),
    );
  }

  playLevel(levelId: string): void {
    const def = getLevelDef(levelId);
    if (!def) {
      console.warn(`DriftNeo: there is no level ${levelId}`);
      this.showMainMenu();
      return;
    }
    const info: TrackInfo = { kind: 'level', trackId: def.id, trackName: def.name, nextLevelId: nextLevelOf(def.id) };
    this.startTrack(levelId, () => createTrackSession(this.levelFor(def.id, () => generateLevelFor(def)), info, this.sessionDeps));
  }

  /** A new endless run on a road of its own (or on the fixed test seed). */
  playEndless(difficulty: Difficulty): void {
    const seed = this.fixedEndlessSeed ?? randomSeed();
    // Whether or not the road gets built, the renderer may already have let go of the level.
    this.levelOnScreen = null;
    this.startTrack(`the ${difficulty} endless road (seed ${seed})`, () =>
      createEndlessSession(seed, difficulty, this.sessionDeps),
    );
  }

  // ---- Sessions and runs ----------------------------------------------------------------------------------------

  private startTrack(what: string, build: () => Session): void {
    try {
      this.adopt(build());
    } catch (error) {
      console.error(`DriftNeo: could not build ${what}`, error);
      this.showMainMenu();
      return;
    }
    this.pickSong();
    this.beginRun();
  }

  /** A different background song from the last one, chosen at random; its two-minute clock starts again. */
  private pickSong(): void {
    const last = this.audio.musicSong;
    let next = Math.floor(Math.random() * SONGS.length);
    if (SONGS.length > 1 && next === last) next = (next + 1 + Math.floor(Math.random() * (SONGS.length - 1))) % SONGS.length;
    this.audio.playMusic(next);
    this.songSeconds = 0;
  }

  private weeklyInfo(weekId: string): TrackInfo {
    return { kind: 'weekly', trackId: weekId, trackName: weekId, nextLevelId: null };
  }

  private weeklySession(weekId: string): Session {
    return createTrackSession(this.levelFor(weekId, () => generateLevel(weekId)), this.weeklyInfo(weekId), this.sessionDeps);
  }

  /** Generates the level once and hands it to the renderer, unless it is the one already on screen. */
  private levelFor(id: string, generate: () => Level): Level {
    let level = this.levels.get(id);
    if (!level) {
      level = generate();
      this.levels.set(id, level);
    }
    if (this.levelOnScreen !== id) {
      this.renderer.setLevel(level);
      this.levelOnScreen = id;
    }
    return level;
  }

  /** This week's level behind the menus, the car resting on its start line. */
  private parkBehindMenu(): void {
    const session = this.session;
    const parked = session.kind === 'weekly' && session.info.trackId === this.currentWeek && this.levelOnScreen === this.currentWeek;
    if (parked) session.restart();
    else this.adopt(this.weeklySession(this.currentWeek));
    this.snapCar();
    this.renderer.clearEffects();
    this.hud.setVisible(false);
    this.screen = 'menu';
  }

  private adopt(session: Session): void {
    this.session = session;
    this.snapCar();
  }

  /** Makes the car's current position the one to interpolate from: nothing is drawn sliding in from elsewhere. */
  private snapCar(): void {
    const car = this.session.world.car;
    this.prevPose.x = car.x;
    this.prevPose.z = car.z;
    this.prevPose.heading = car.heading;
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

  /** The same road again from the start: the restart key while driving, and RESTART in the pause menu. */
  private restartRun(): void {
    this.session.restart();
    this.beginRun();
  }

  /**
   * RESTART / RETRY from a menu. On the pause screen that is the run in progress again. RETRY after an endless run
   * is a new run instead, and so a new road: the road is different every time.
   */
  private onMenuRestart(): void {
    const session = this.session;
    if (session.kind === 'endless' && this.screen === 'results') this.playEndless(session.difficulty);
    else this.restartRun();
  }

  private pause(): void {
    if (this.screen !== 'driving' || this.session.phase === 'over') return;
    this.screen = 'paused';
    this.navHeld = true;
    this.menu.showPause();
  }

  private resume(): void {
    if (this.screen !== 'paused') return;
    this.menu.hide();
    // The countdown stood still while paused but its number's pop did not: show the number again.
    this.hud.resetCountdown();
    this.screen = 'driving';
  }

  // ---- Settings and sound ---------------------------------------------------------------------------------------

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.renderer.applySettings(settings);
    this.audio.setVolume(settings.volume);
    this.audio.setMusicVolume(settings.musicVolume);
    this.audio.setMuted(settings.muted);
    this.menu.setSettings(settings);
    const assist = settings.assist ? ASSIST_STRENGTH : 0;
    this.params.steerAssist = assist;
    this.tuningDefaults.steerAssist = assist;
  }

  /**
   * Drives garage car `id` from now on: its handling goes into the one shared params object (so the world parked
   * behind the menu and the next run both use it) and becomes what the tuning panel resets to.
   */
  private applyCar(id: CarId): void {
    const car = getCar(id);
    const assist = this.params.steerAssist;
    Object.assign(this.params, car.params, { steerAssist: assist });
    Object.assign(this.tuningDefaults, car.params, { steerAssist: assist });
    this.renderer.setCarStyle(car.id);
    this.audio.setEngineSound(engineSoundFor(car.id));
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
    // On the endless road the music moves on to another song every two minutes of driving.
    if (session.kind === 'endless' && this.screen === 'driving' && session.phase === 'running') {
      this.songSeconds += DT;
      if (this.songSeconds >= ENDLESS_SONG_SECONDS) this.pickSong();
    }
    const phaseBefore = session.phase;
    const world = session.world;
    const worldTickBefore = world.tick;

    this.snapCar();
    let teleported = session.step(phaseBefore === 'over' ? NEUTRAL_INPUT : this.sampleInput());

    // The world is not stepped on every mode tick (countdown, waiting to be put back after a fall). On those the
    // car state is whatever the last real step left: laying marks and smoke from it, or replaying its collision,
    // would repeat that one moment for as long as the car stands still.
    const car = world.car;
    if (world.tick !== worldTickBefore) {
      const collision = world.lastCollision;
      this.renderer.onSimTick(car, world.params, collision);
      if (collision && collision.impact > MIN_AUDIBLE_IMPACT) this.audio.collision(collision.impact);
    }

    // Interpolating across a respawn would draw the car streaking back to the checkpoint.
    const dx = car.x - this.prevPose.x;
    const dz = car.z - this.prevPose.z;
    if (dx * dx + dz * dz > TELEPORT_DISTANCE * TELEPORT_DISTANCE) teleported = true;
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
      this.navHeld = true;
      this.audio.blip('uiGlitch');
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
    this.handleMeta(this.input.meta());
    // While nothing is stepping the loop's alpha keeps cycling; holding the last one keeps the car still.
    if (this.isSimulating()) this.alpha = alpha;

    const session = this.session;
    const world = session.world;
    const car = world.car;
    const frame = this.renderFrame;
    const height = lerp(this.prevHeight, car.y, this.alpha);
    frame.pose.x = lerp(this.prevPose.x, car.x, this.alpha);
    frame.pose.z = lerp(this.prevPose.z, car.z, this.alpha);
    frame.pose.heading = lerpAngle(this.prevPose.heading, car.heading, this.alpha);
    frame.pose.y = height;
    frame.height = height;
    frame.car = car;
    frame.params = world.params;
    frame.run = session.run;
    frame.endless = session.endless;
    // Zero time freezes smoke, sparks and the camera along with the simulation.
    frame.dt = this.screen === 'paused' ? 0 : frameSeconds;
    this.renderer.render(frame);

    if (this.screen !== 'menu') session.updateHud(this.hud);
    this.touch.setDriving(this.screen === 'driving');
    this.tuning.update(car);
    this.audio.update(car, world.params, this.screen === 'driving' && session.engineRunning);
  }

  // ---- Meta input -----------------------------------------------------------------------------------------------

  private handleMeta(meta: MetaInput): void {
    if (meta.toggleMute) this.toggleMute();
    if (meta.toggleTuning) this.tuning.toggle();
    if (this.swallowMeta) {
      this.swallowMeta = false;
      return;
    }
    if (this.menu.isOpen) this.menuMeta(meta);
    else if (this.screen === 'driving') {
      // Escape / P / Start pause, Backspace / Back restart; the arrows and WASD are just driving here.
      if (meta.pause) this.pause();
      else if (meta.restart) this.restartRun();
    }
  }

  /** While a menu is up the nav flags move its focus and Escape / Backspace go back. */
  private menuMeta(meta: MetaInput): void {
    const menu = this.menu;
    if (menu.screen === 'title') {
      if (meta.confirm) menu.confirm();
      else if (meta.navUp || meta.navDown || meta.navLeft || meta.navRight || meta.back || meta.pause || meta.restart) {
        this.leaveTitle();
      }
      return;
    }
    if (meta.back) {
      menu.back();
      return;
    }
    if (meta.pause) {
      // Start / P on its own (Escape raises `back` as well and went above).
      if (this.screen === 'paused' && menu.screen === 'pause') this.resume();
      else menu.back();
      return;
    }
    if (this.navHeld && this.drivingControlsHeld()) {
      if (meta.confirm) menu.confirm();
      return;
    }
    this.navHeld = false;
    if (meta.navUp) menu.nav('up');
    else if (meta.navDown) menu.nav('down');
    else if (meta.navLeft) menu.nav('left');
    else if (meta.navRight) menu.nav('right');
    if (meta.confirm) menu.confirm();
  }

  /** Steering, throttle or brake held past the point where a stick flick counts as menu navigation. */
  private drivingControlsHeld(): boolean {
    const held = this.input.sample();
    return Math.abs(held.steer) > 0.5 || held.throttle > 0.5 || held.brake > 0.5;
  }

  private leaveTitle(): void {
    this.audio.blip('uiSelect');
    this.menu.showMain();
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
    window.addEventListener('keydown', (event) => {
      // While driving nothing on the page can take focus, so Tab (right beside Q, W and A) would hand it to the
      // browser's own controls. In menus Tab keeps its normal job.
      if (event.code === 'Tab' && this.screen === 'driving') event.preventDefault();
      // Any key leaves the title screen (Enter and Space reach its focused button natively).
      if (this.menu.screen === 'title' && startsFromTitle(event)) {
        this.audio.resume();
        this.leaveTitle();
        this.swallowMeta = true;
      }
    });

    // Menus can be confirmed from the frame loop (Enter, gamepad), which is not a user gesture as far as the
    // browser's autoplay rules go. Waking audio straight from the event keeps sound working on those paths.
    const wakeAudio = (): void => this.audio.resume();
    window.addEventListener('pointerdown', wakeAudio);
    window.addEventListener('keydown', wakeAudio);
  }
}
