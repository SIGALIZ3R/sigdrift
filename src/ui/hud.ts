import { SIM_HZ } from '../types';
import type { CarState, Difficulty, EndlessRecords, EndlessState, RunRecords, RunState, ScoreState } from '../types';
import { formatDistance, formatMultiplier, formatScore, formatTime } from './format';
import { markGlitch, markGlitchUnder } from './glitch';
import { el, injectStyles, replayAnimation } from './styles';

/** What the weekly / level HUD shows besides the run itself. */
export interface HudInfo {
  /** The level's name ("Neon Spine") or the week id ("2026-W48"). */
  trackName: string;
  /** Stored records for this track (loadRunRecords). The HUD shows the best time and the top score. */
  records: RunRecords;
}

export interface EndlessHudInfo {
  /** Stored records for this difficulty (loadEndlessRecords). */
  records: EndlessRecords;
}

export interface Hud {
  /** Weekly run or level. Call every rendered frame. Only writes to the DOM when a displayed value has changed. */
  update(run: RunState, car: CarState, info: HudInfo): void;
  /** Endless mode: the same contract as `update`. Calling one after the other swaps the layout. */
  updateEndless(state: EndlessState, car: CarState, info: EndlessHudInfo): void;
  setVisible(visible: boolean): void;
  /**
   * Forget which countdown number is showing, so the next update pops the current one afresh. Call it when a run
   * begins and when it resumes (the number is only visible while its one-second pop plays, in real time).
   */
  resetCountdown(): void;
  dispose(): void;
}

const MS_TO_KMH = 3.6;
/** How long "GO" stays up once the run has started. */
const GO_TICKS = Math.round(SIM_HZ * 0.8);
const COUNT_GO = 0;
const COUNT_NONE = -1;
const RUN_HINT = 'WASD / Arrows drive  ·  Space handbrake  ·  R reset  ·  Esc pause';
/** No R here: endless has no checkpoints to reset to. */
const ENDLESS_HINT = 'WASD / Arrows drive  ·  Space handbrake  ·  Backspace restart  ·  Esc pause';
/** The same hints for the on-screen touch controls (shown instead while they are up, by CSS). */
const TOUCH_RUN_HINT = 'Left pad steers  ·  GAS  ·  DRIFT handbrake  ·  ↺ reset';
const TOUCH_ENDLESS_HINT = 'Left pad steers  ·  GAS  ·  DRIFT handbrake  ·  ❚❚ pause';
const METER_CELLS = 8;
const METRES_PER_KM = 1000;
/** The proximity bar moves in steps this fine (1/40 of its length). */
const PROX_STEPS = 40;
const CLOSE_AT = 0.5;
const RAZOR_AT = 0.8;
/** Multiplier at which the badge stops growing. */
const MULT_SCALE_TOP = 8;
const MULT_HOT = 3;
const MULT_BLAZING = 6;

const LAYOUT_NONE = 0;
const LAYOUT_RUN = 1;
const LAYOUT_ENDLESS = 2;
type Layout = typeof LAYOUT_NONE | typeof LAYOUT_RUN | typeof LAYOUT_ENDLESS;

/** What the countdown needs: both modes' states have it. */
interface Paced {
  phase: string;
  countdownTicks: number;
  ticks: number;
}

interface HudView {
  root: HTMLElement;
  // Weekly / level.
  top: HTMLElement;
  track: HTMLElement;
  timer: HTMLElement;
  checkpoint: HTMLElement;
  best: HTMLElement;
  fell: HTMLElement;
  // Endless.
  endlessTop: HTMLElement;
  difficulty: HTMLElement;
  meter: HTMLElement[];
  distance: HTMLElement;
  distanceValue: HTMLElement;
  distanceUnit: HTMLElement;
  endlessBest: HTMLElement;
  lives: HTMLElement;
  air: HTMLElement;
  // Shared.
  flash: HTMLElement;
  flashTitle: HTMLElement;
  flashTime: HTMLElement;
  count: HTMLElement;
  hint: HTMLElement;
  scorePanel: HTMLElement;
  score: HTMLElement;
  topScore: HTMLElement;
  mult: HTMLElement;
  multLost: HTMLElement;
  prox: HTMLElement;
  proxFill: HTMLElement;
  callout: HTMLElement;
  combo: HTMLElement;
  comboValue: HTMLElement;
  speed: HTMLElement;
}

/** The values currently on screen, kept as numbers so an unchanged frame costs comparisons only. */
interface Shown {
  layout: Layout;
  // Weekly / level.
  trackName: string | null;
  bestTicks: number;
  ticks: number;
  final: boolean;
  nextCheckpoint: number;
  checkpointCount: number;
  checkpointTick: number;
  fell: boolean;
  // Endless.
  difficulty: Difficulty | null;
  meterCells: number;
  distance: number;
  distanceInKm: boolean;
  dead: boolean;
  bestDistance: number;
  crashes: number;
  maxCrashes: number;
  crashTick: number;
  air: boolean;
  // Shared.
  count: number;
  hint: boolean;
  topScore: number;
  points: number;
  multTenths: number;
  multWhole: number;
  multLossTick: number;
  drifting: boolean;
  proxStep: number;
  proxTier: number;
  closeTick: number;
  razorShown: boolean;
  combo: number;
  kmh: number;
}

// ---- Build ----------------------------------------------------------------------------------------------------

function buildTop(view: Partial<HudView>): HTMLElement {
  const top = el('div', 'sd-hud-top');
  // The glitcher only ever plays its gentlest effects on the readouts ("soft"), and none that would need their text.
  view.track = markGlitch(el('div', 'sd-label sd-hud-track'), 'soft');
  view.timer = markGlitch(el('div', 'sd-num sd-hud-timer', formatTime(0)), 'soft');
  const meta = el('div', 'sd-hud-meta');
  view.checkpoint = el('span', 'sd-label sd-hud-cp');
  view.best = el('span', 'sd-label');
  meta.append(view.checkpoint, view.best);
  top.append(view.track, view.timer, meta);
  view.top = top;
  return top;
}

function buildEndlessTop(view: Partial<HudView>): HTMLElement {
  const top = el('div', 'sd-hud-top sd-hud-etop sd-hidden');
  const level = el('div', 'sd-hud-level');
  view.difficulty = el('span', 'sd-label');
  const meter = el('span', 'sd-hud-meter');
  view.meter = [];
  for (let i = 0; i < METER_CELLS; i++) {
    const cell = el('i');
    meter.appendChild(cell);
    view.meter.push(cell);
  }
  level.append(view.difficulty, meter);
  view.distanceValue = el('span', '', '0');
  view.distanceUnit = el('span', 'sd-hud-unit', 'm');
  view.distance = markGlitch(el('div', 'sd-num sd-hud-timer sd-hud-dist'), 'soft');
  view.distance.append(view.distanceValue, view.distanceUnit);
  view.endlessBest = el('div', 'sd-label');
  top.append(level, view.distance, view.endlessBest);
  view.endlessTop = top;
  return top;
}

function buildFlash(view: Partial<HudView>): HTMLElement {
  const flash = el('div', 'sd-hud-flash');
  view.flashTitle = el('div', 'sd-label');
  view.flashTime = el('div', 'sd-num');
  flash.append(view.flashTitle, view.flashTime);
  view.flash = flash;
  return flash;
}

function buildCentre(view: Partial<HudView>): HTMLElement {
  const centre = el('div', 'sd-hud-centre');
  view.count = el('div', 'sd-num sd-hud-count');
  view.hint = el('div', 'sd-label sd-hud-hint sd-hidden', RUN_HINT);
  view.hint.dataset.touch = TOUCH_RUN_HINT;
  centre.append(view.count, view.hint);
  return centre;
}

function buildFell(view: Partial<HudView>): HTMLElement {
  const fell = el('div', 'sd-hud-fell');
  fell.append(el('span', '', 'Fell'), el('i'), el('span', '', 'Back to checkpoint'));
  view.fell = fell;
  return fell;
}

function buildScore(view: Partial<HudView>): HTMLElement {
  const panel = markGlitch(el('div', 'sd-panel sd-hud-score'), 'soft', { kind: 'panel' });

  const head = el('div', 'sd-hud-score-head');
  view.topScore = el('span', 'sd-label sd-hud-topscore');
  head.append(el('span', 'sd-label', 'Score'), view.topScore);

  const row = el('div', 'sd-hud-score-row');
  view.score = markGlitch(el('span', 'sd-num sd-hud-points', '0'), 'soft');
  view.mult = el('span', 'sd-num sd-hud-mult', formatMultiplier(1));
  row.append(view.score, view.mult);

  const prox = el('div', 'sd-hud-prox');
  view.proxFill = el('i', 'sd-hud-prox-fill');
  view.callout = el('span', 'sd-hud-callout');
  prox.append(view.proxFill, view.callout);
  view.prox = prox;

  view.comboValue = el('span', 'sd-num', '+0');
  view.combo = el('div', 'sd-hud-combo is-empty');
  view.combo.append(el('span', 'sd-label', 'Combo'), view.comboValue);

  view.multLost = el('div', 'sd-label sd-hud-lost', 'Multiplier lost');
  panel.append(head, row, prox, view.combo, view.multLost);
  view.scorePanel = panel;
  return panel;
}

function buildSpeed(view: Partial<HudView>): HTMLElement {
  const speed = el('div', 'sd-panel sd-hud-speed');
  view.speed = markGlitch(el('span', 'sd-num sd-hud-speed-value', '0'), 'soft');
  speed.append(view.speed, el('span', 'sd-label', 'km/h'));
  return speed;
}

function buildView(): HudView {
  const view: Partial<HudView> = {};
  // Under a pause or result menu the readouts are dimmed: no glitch is spent on them there.
  const root = markGlitchUnder(el('div', 'sd-ui sd-hud'));
  view.lives = markGlitch(el('div', 'sd-hud-lives sd-hidden'), 'soft');
  view.air = el('div', 'sd-hud-air sd-hidden', 'AIR');
  root.append(
    buildTop(view),
    buildEndlessTop(view),
    view.lives,
    buildFlash(view),
    buildFell(view),
    buildCentre(view),
    view.air,
    buildScore(view),
    buildSpeed(view),
  );
  view.root = root;
  return view as HudView;
}

function freshShown(): Shown {
  return {
    layout: LAYOUT_NONE,
    trackName: null,
    bestTicks: NaN,
    ticks: 0,
    final: false,
    nextCheckpoint: -1,
    checkpointCount: -1,
    checkpointTick: -1,
    fell: false,
    difficulty: null,
    meterCells: 0,
    distance: 0,
    distanceInKm: false,
    dead: false,
    bestDistance: NaN,
    crashes: 0,
    maxCrashes: 0,
    crashTick: -1,
    air: false,
    count: COUNT_NONE,
    hint: false,
    topScore: NaN,
    points: 0,
    multTenths: 10,
    multWhole: 1,
    multLossTick: -1,
    drifting: false,
    proxStep: 0,
    proxTier: 0,
    closeTick: -1,
    razorShown: false,
    combo: 0,
    kmh: 0,
  };
}

/** Restarts the CSS animation tied to `className` (like replayAnimation, for classes other than is-on). */
function replayClass(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

// ---- Layout ---------------------------------------------------------------------------------------------------

function syncLayout(view: HudView, shown: Shown, layout: Layout): void {
  if (layout === shown.layout) return;
  shown.layout = layout;
  const endless = layout === LAYOUT_ENDLESS;
  view.top.classList.toggle('sd-hidden', endless);
  view.endlessTop.classList.toggle('sd-hidden', !endless);
  view.lives.classList.toggle('sd-hidden', !endless);
  view.air.classList.toggle('sd-hidden', !endless);
  view.hint.textContent = endless ? ENDLESS_HINT : RUN_HINT;
  view.hint.dataset.touch = endless ? TOUCH_ENDLESS_HINT : TOUCH_RUN_HINT;
  // The flash line is shared, and whatever the other mode last announced means nothing here.
  view.flash.classList.remove('is-on');
  view.flash.classList.toggle('is-crash', endless);
  view.fell.classList.remove('is-on');
  shown.fell = false;
  shown.topScore = NaN;
}

// ---- Weekly / level -------------------------------------------------------------------------------------------

function syncHeader(view: HudView, shown: Shown, info: HudInfo): void {
  if (info.trackName !== shown.trackName) {
    shown.trackName = info.trackName;
    view.track.textContent = info.trackName;
  }
  const bestTicks = info.records.bestTime ? info.records.bestTime.ticks : -1;
  if (bestTicks !== shown.bestTicks) {
    shown.bestTicks = bestTicks;
    view.best.textContent = bestTicks < 0 ? 'Best --' : `Best ${formatTime(bestTicks)}`;
  }
}

function syncTimer(view: HudView, shown: Shown, run: RunState): void {
  const ticks = run.phase === 'countdown' ? 0 : run.ticks;
  if (ticks !== shown.ticks) {
    shown.ticks = ticks;
    view.timer.textContent = formatTime(ticks);
  }
  const final = run.phase === 'finished';
  if (final !== shown.final) {
    shown.final = final;
    view.timer.classList.toggle('is-final', final);
  }
}

function syncProgress(view: HudView, shown: Shown, run: RunState): void {
  if (run.nextCheckpoint === shown.nextCheckpoint && run.checkpointCount === shown.checkpointCount) return;
  shown.nextCheckpoint = run.nextCheckpoint;
  shown.checkpointCount = run.checkpointCount;
  view.checkpoint.textContent = `CP ${Math.min(run.nextCheckpoint, run.checkpointCount)}/${run.checkpointCount}`;
}

function syncCheckpointFlash(view: HudView, shown: Shown, run: RunState): void {
  if (run.lastCheckpointTick === shown.checkpointTick) return;
  shown.checkpointTick = run.lastCheckpointTick;
  // The goal is announced by the finish screen, and a restart (-1) must not flash.
  if (run.lastCheckpointTick < 0 || run.phase !== 'running') {
    view.flash.classList.remove('is-on');
    return;
  }
  const splits = run.splits;
  view.flashTitle.textContent = `Checkpoint ${run.nextCheckpoint}/${run.checkpointCount}`;
  view.flashTime.textContent = formatTime(splits.length > 0 ? splits[splits.length - 1] : run.ticks);
  replayAnimation(view.flash);
}

function syncFell(view: HudView, shown: Shown, run: RunState): void {
  const fell = run.respawnInTicks > 0 && run.phase === 'running';
  if (fell === shown.fell) return;
  shown.fell = fell;
  if (fell) replayAnimation(view.fell);
  else view.fell.classList.remove('is-on');
}

// ---- Endless --------------------------------------------------------------------------------------------------

function syncLevel(view: HudView, shown: Shown, state: EndlessState): void {
  if (state.difficulty !== shown.difficulty) {
    shown.difficulty = state.difficulty;
    view.difficulty.textContent = state.difficulty;
  }
  const cells = Math.min(METER_CELLS, Math.max(0, Math.round(state.intensity * METER_CELLS)));
  if (cells !== shown.meterCells) {
    shown.meterCells = cells;
    for (let i = 0; i < METER_CELLS; i++) view.meter[i].classList.toggle('is-on', i < cells);
  }
}

function syncDistance(view: HudView, shown: Shown, state: EndlessState, info: EndlessHudInfo): void {
  // Rounded down to the readout's own resolution first, so the text is only rebuilt when it would differ.
  const metres = state.distance > 0 ? state.distance : 0;
  const distance = metres < METRES_PER_KM ? Math.floor(metres) : Math.floor(metres / 10) * 10;
  if (distance !== shown.distance) {
    shown.distance = distance;
    const text = formatDistance(distance);
    view.distanceValue.textContent = text.slice(0, text.lastIndexOf(' '));
    const inKm = distance >= METRES_PER_KM;
    if (inKm !== shown.distanceInKm) {
      shown.distanceInKm = inKm;
      view.distanceUnit.textContent = inKm ? 'km' : 'm';
    }
  }
  const dead = state.phase === 'dead';
  if (dead !== shown.dead) {
    shown.dead = dead;
    view.distance.classList.toggle('is-final', dead);
  }
  const best = info.records.bestDistance;
  const bestDistance = best ? best.distance : -1;
  if (bestDistance !== shown.bestDistance) {
    shown.bestDistance = bestDistance;
    view.endlessBest.textContent = bestDistance < 0 ? 'Best --' : `Best ${formatDistance(bestDistance)}`;
  }
}

function buildLifePip(): HTMLElement {
  const pip = el('span', 'sd-life');
  pip.append(el('i'), el('i'));
  return pip;
}

/** One pip per allowed crash. They break from the right; the last one standing pulses. */
function syncLives(view: HudView, shown: Shown, state: EndlessState): void {
  if (state.crashes === shown.crashes && state.maxCrashes === shown.maxCrashes) return;
  if (state.maxCrashes !== shown.maxCrashes) {
    const pips: HTMLElement[] = [];
    for (let i = 0; i < state.maxCrashes; i++) pips.push(buildLifePip());
    view.lives.replaceChildren(...pips);
  }
  shown.crashes = state.crashes;
  shown.maxCrashes = state.maxCrashes;
  const left = Math.max(0, state.maxCrashes - state.crashes);
  const pips = view.lives.children;
  for (let i = 0; i < pips.length; i++) {
    pips[i].classList.toggle('is-broken', i >= left);
    pips[i].classList.toggle('is-last', left === 1 && i === 0);
  }
}

function syncCrashFlash(view: HudView, shown: Shown, state: EndlessState): void {
  if (state.lastCrashTick === shown.crashTick) return;
  shown.crashTick = state.lastCrashTick;
  // The final crash is announced by the game over screen, and a restart (-1) must not flash.
  if (state.lastCrashTick < 0 || state.phase !== 'running') {
    view.flash.classList.remove('is-on');
    return;
  }
  const left = Math.max(0, state.maxCrashes - state.crashes);
  view.flashTitle.textContent = `Crash ${state.crashes}/${state.maxCrashes}`;
  view.flashTime.textContent = left === 1 ? 'Last life' : `${left} lives left`;
  replayAnimation(view.flash);
}

function syncAir(view: HudView, shown: Shown, car: CarState): void {
  const air = car.airborne === true;
  if (air === shown.air) return;
  shown.air = air;
  view.air.classList.toggle('is-on', air);
}

// ---- Shared ---------------------------------------------------------------------------------------------------

/** Whole seconds left on the countdown, COUNT_GO just after the start, COUNT_NONE otherwise. */
function countdownStep(pace: Paced): number {
  if (pace.phase === 'countdown') return Math.max(1, Math.ceil(pace.countdownTicks / SIM_HZ));
  if (pace.phase === 'running' && pace.ticks < GO_TICKS) return COUNT_GO;
  return COUNT_NONE;
}

function syncCountdown(view: HudView, shown: Shown, pace: Paced): void {
  const count = countdownStep(pace);
  if (count !== shown.count) {
    shown.count = count;
    if (count === COUNT_NONE) {
      view.count.classList.remove('is-on');
    } else {
      view.count.textContent = count === COUNT_GO ? 'GO' : String(count);
      view.count.classList.toggle('is-go', count === COUNT_GO);
      replayAnimation(view.count);
    }
  }
  const hint = pace.phase === 'countdown';
  if (hint !== shown.hint) {
    shown.hint = hint;
    view.hint.classList.toggle('sd-hidden', !hint);
  }
}

function syncTopScore(view: HudView, shown: Shown, top: number): void {
  if (top === shown.topScore) return;
  shown.topScore = top;
  view.topScore.textContent = top > 0 ? `Top ${formatScore(top)}` : '';
}

function syncMultiplier(view: HudView, shown: Shown, score: ScoreState, running: boolean): void {
  if (score.lastMultiplierLossTick !== shown.multLossTick) {
    const lost = score.lastMultiplierLossTick >= 0 && running && shown.multTenths > 10;
    if (lost) {
      // The old value breaks apart while the new x1.0 settles in beneath it.
      view.mult.setAttribute('data-shard', view.mult.textContent ?? '');
      replayClass(view.mult, 'is-shatter');
      replayAnimation(view.multLost);
    }
    shown.multLossTick = score.lastMultiplierLossTick;
  }
  const tenths = Number.isFinite(score.multiplier) && score.multiplier > 1 ? Math.floor(score.multiplier * 10 + 1e-6) : 10;
  if (tenths !== shown.multTenths) {
    shown.multTenths = tenths;
    const value = tenths / 10;
    view.mult.textContent = formatMultiplier(value);
    const grow = Math.min(1, (value - 1) / (MULT_SCALE_TOP - 1));
    view.mult.style.setProperty('--mult-scale', (1 + grow * 0.55).toFixed(3));
    view.mult.classList.toggle('is-hot', value >= MULT_HOT && value < MULT_BLAZING);
    view.mult.classList.toggle('is-blazing', value >= MULT_BLAZING);
    view.mult.classList.toggle('is-one', tenths <= 10);
    const whole = Math.floor(value);
    if (whole > shown.multWhole) replayClass(view.mult, 'is-up');
    shown.multWhole = whole;
  }
}

function syncProximity(view: HudView, shown: Shown, score: ScoreState, running: boolean): void {
  const proximity = score.drifting && Number.isFinite(score.proximity) ? Math.min(1, Math.max(0, score.proximity)) : 0;
  const step = Math.round(proximity * PROX_STEPS);
  if (step !== shown.proxStep) {
    shown.proxStep = step;
    view.proxFill.style.transform = `scaleX(${(step / PROX_STEPS).toFixed(3)})`;
  }
  const tier = proximity > RAZOR_AT ? 2 : proximity > CLOSE_AT ? 1 : 0;
  if (tier !== shown.proxTier) {
    shown.proxTier = tier;
    view.prox.classList.toggle('is-close', tier === 1);
    view.prox.classList.toggle('is-razor', tier === 2);
  }
  if (score.lastCloseTick !== shown.closeTick) {
    shown.closeTick = score.lastCloseTick;
    shown.razorShown = false;
    if (score.lastCloseTick >= 0 && running) {
      view.callout.textContent = tier === 2 ? 'Razor' : 'Close';
      view.callout.classList.toggle('is-razor', tier === 2);
      shown.razorShown = tier === 2;
      replayAnimation(view.callout);
    } else {
      view.callout.classList.remove('is-on');
    }
  } else if (tier === 2 && !shown.razorShown && running && shown.closeTick >= 0) {
    // The same close moment got closer still: upgrade the call-out.
    shown.razorShown = true;
    view.callout.textContent = 'Razor';
    view.callout.classList.add('is-razor');
    replayAnimation(view.callout);
  }
}

function syncScore(view: HudView, shown: Shown, score: ScoreState, phase: string): void {
  const running = phase === 'running';
  const points = Number.isFinite(score.points) ? Math.floor(score.points) : 0;
  if (points !== shown.points) {
    shown.points = points;
    view.score.textContent = formatScore(points);
  }
  syncMultiplier(view, shown, score, running);
  syncProximity(view, shown, score, running);
  const combo = Number.isFinite(score.combo) ? Math.floor(score.combo) : 0;
  if (combo !== shown.combo) {
    const wasEmpty = shown.combo <= 0;
    shown.combo = combo;
    view.comboValue.textContent = `+${formatScore(combo)}`;
    if (wasEmpty !== combo <= 0) view.combo.classList.toggle('is-empty', combo <= 0);
  }
  if (score.drifting !== shown.drifting) {
    shown.drifting = score.drifting;
    view.scorePanel.classList.toggle('is-live', score.drifting);
  }
}

function syncSpeed(view: HudView, shown: Shown, car: CarState): void {
  const kmh = Math.round(car.speed * MS_TO_KMH);
  if (kmh === shown.kmh) return;
  shown.kmh = kmh;
  view.speed.textContent = String(kmh);
}

function topOf(table: readonly { score: number }[]): number {
  return table.length > 0 ? table[0].score : 0;
}

export function createHud(root: HTMLElement): Hud {
  injectStyles();
  const view = buildView();
  const shown = freshShown();
  root.appendChild(view.root);

  return {
    update(run, car, info) {
      syncLayout(view, shown, LAYOUT_RUN);
      syncHeader(view, shown, info);
      syncTimer(view, shown, run);
      syncProgress(view, shown, run);
      syncCheckpointFlash(view, shown, run);
      syncFell(view, shown, run);
      syncCountdown(view, shown, run);
      syncTopScore(view, shown, topOf(info.records.highScores));
      syncScore(view, shown, run.score, run.phase);
      syncSpeed(view, shown, car);
    },
    updateEndless(state, car, info) {
      syncLayout(view, shown, LAYOUT_ENDLESS);
      syncLevel(view, shown, state);
      syncDistance(view, shown, state, info);
      syncLives(view, shown, state);
      syncCrashFlash(view, shown, state);
      syncAir(view, shown, car);
      syncCountdown(view, shown, state);
      syncTopScore(view, shown, topOf(info.records.highScores));
      syncScore(view, shown, state.score, state.phase);
      syncSpeed(view, shown, car);
    },
    setVisible(visible) {
      view.root.classList.toggle('sd-hidden', !visible);
    },
    resetCountdown() {
      shown.count = COUNT_NONE;
      view.count.classList.remove('is-on');
    },
    dispose() {
      view.root.remove();
    },
  };
}
