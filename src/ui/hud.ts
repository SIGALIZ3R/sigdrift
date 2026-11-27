import { SIM_HZ } from '../types';
import type { BestRecord, CarState, Difficulty, EndlessBest, EndlessState, RunState } from '../types';
import { formatDistance, formatScore, formatTime } from './format';
import { el, injectStyles, replayAnimation } from './styles';

export interface HudInfo {
  levelId: string;
  best: BestRecord | null;
}

export interface EndlessHudInfo {
  best: EndlessBest | null;
}

export interface Hud {
  /** Weekly run. Call every rendered frame. Only writes to the DOM when a displayed value has changed. */
  update(run: RunState, car: CarState, info: HudInfo): void;
  /** Endless mode: the same contract as `update`. Calling one after the other swaps the layout. */
  updateEndless(state: EndlessState, car: CarState, info: EndlessHudInfo): void;
  setVisible(visible: boolean): void;
  /**
   * Forget which countdown number is showing, so the next update pops the current one afresh. The number is only
   * visible while its one-second pop plays, in real time; a countdown that was paused, or started again within
   * the same second, would otherwise sit on a number whose pop is long over and show nothing. Call it when a run
   * begins and when it resumes.
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
const METER_CELLS = 8;
const METRES_PER_KM = 1000;

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

/** Drift scoring, which means the same in both modes. */
interface Drifting {
  driftScore: number;
  chainScore: number;
  multiplier: number;
  drifting: boolean;
  lastChainBreakTick: number;
}

interface HudView {
  root: HTMLElement;
  // Weekly run only.
  top: HTMLElement;
  week: HTMLElement;
  timer: HTMLElement;
  checkpoint: HTMLElement;
  best: HTMLElement;
  // Endless only.
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
  drift: HTMLElement;
  chain: HTMLElement;
  chainPoints: HTMLElement;
  multiplier: HTMLElement;
  banked: HTMLElement;
  chainLost: HTMLElement;
  speed: HTMLElement;
}

/** The values currently on screen, kept as numbers so an unchanged frame costs comparisons only. */
interface Shown {
  layout: Layout;
  // Weekly run.
  levelId: string | null;
  bestTicks: number;
  ticks: number;
  final: boolean;
  nextCheckpoint: number;
  checkpointCount: number;
  checkpointTick: number;
  // Endless.
  difficulty: Difficulty | null;
  meterCells: number;
  /** Displayed distance in metres, already rounded down to what the readout can show. */
  distance: number;
  distanceInKm: boolean;
  dead: boolean;
  bestDistance: number;
  crashes: number;
  maxCrashes: number;
  crashTick: number;
  air: boolean;
  // Shared.
  chainBreakTick: number;
  count: number;
  hint: boolean;
  chain: number;
  multiplierTenths: number;
  banked: number;
  drifting: boolean;
  kmh: number;
}

// ---- Build ----------------------------------------------------------------------------------------------------

function buildTop(view: Partial<HudView>): HTMLElement {
  const top = el('div', 'sd-hud-top');
  view.week = el('div', 'sd-label');
  view.timer = el('div', 'sd-num sd-hud-timer', formatTime(0));
  const meta = el('div', 'sd-hud-meta');
  view.checkpoint = el('span', 'sd-label sd-hud-cp');
  view.best = el('span', 'sd-label');
  meta.append(view.checkpoint, view.best);
  top.append(view.week, view.timer, meta);
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
  view.distance = el('div', 'sd-num sd-hud-timer sd-hud-dist');
  view.distance.append(view.distanceValue, view.distanceUnit);
  view.endlessBest = el('div', 'sd-label');
  top.append(level, view.distance, view.endlessBest);
  view.endlessTop = top;
  return top;
}

function buildLives(view: Partial<HudView>): HTMLElement {
  view.lives = el('div', 'sd-hud-lives sd-hidden');
  return view.lives;
}

function buildAir(view: Partial<HudView>): HTMLElement {
  view.air = el('div', 'sd-hud-air sd-hidden', 'AIR');
  return view.air;
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
  centre.append(view.count, view.hint);
  return centre;
}

function buildDrift(view: Partial<HudView>): HTMLElement {
  const drift = el('div', 'sd-panel sd-hud-drift');
  const chain = el('div', 'sd-hud-chain is-empty');
  view.chainPoints = el('span', 'sd-num sd-hud-chain-pts', '0');
  view.multiplier = el('span', 'sd-num sd-hud-mult', '×1.0');
  chain.append(view.chainPoints, view.multiplier);
  const bank = el('div', 'sd-hud-bank');
  view.banked = el('span', 'sd-num', '0');
  bank.append(el('span', 'sd-label', 'Score'), view.banked);
  view.chainLost = el('div', 'sd-label sd-hud-lost', 'Chain lost');
  drift.append(el('div', 'sd-label', 'Drift'), chain, bank, view.chainLost);
  view.chain = chain;
  view.drift = drift;
  return drift;
}

function buildSpeed(view: Partial<HudView>): HTMLElement {
  const speed = el('div', 'sd-panel sd-hud-speed');
  view.speed = el('span', 'sd-num sd-hud-speed-value', '0');
  speed.append(view.speed, el('span', 'sd-label', 'km/h'));
  return speed;
}

function buildView(): HudView {
  const view: Partial<HudView> = {};
  const root = el('div', 'sd-ui sd-hud');
  root.append(
    buildTop(view),
    buildEndlessTop(view),
    buildLives(view),
    buildFlash(view),
    buildCentre(view),
    buildAir(view),
    buildDrift(view),
    buildSpeed(view),
  );
  view.root = root;
  return view as HudView;
}

function freshShown(): Shown {
  return {
    layout: LAYOUT_NONE,
    levelId: null,
    bestTicks: NaN,
    ticks: 0,
    final: false,
    nextCheckpoint: -1,
    checkpointCount: -1,
    checkpointTick: -1,
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
    chainBreakTick: -1,
    count: COUNT_NONE,
    hint: false,
    chain: 0,
    multiplierTenths: 10,
    banked: 0,
    drifting: false,
    kmh: 0,
  };
}

// ---- Layout ---------------------------------------------------------------------------------------------------

/** Shows one mode's readouts and hides the other's. Costs one comparison on every frame after the swap. */
function syncLayout(view: HudView, shown: Shown, layout: Layout): void {
  if (layout === shown.layout) return;
  shown.layout = layout;
  const endless = layout === LAYOUT_ENDLESS;
  view.top.classList.toggle('sd-hidden', endless);
  view.endlessTop.classList.toggle('sd-hidden', !endless);
  view.lives.classList.toggle('sd-hidden', !endless);
  view.air.classList.toggle('sd-hidden', !endless);
  view.hint.textContent = endless ? ENDLESS_HINT : RUN_HINT;
  // The flash line is shared, and whatever the other mode last announced means nothing here.
  view.flash.classList.remove('is-on');
  view.flash.classList.toggle('is-crash', endless);
}

// ---- Weekly run -----------------------------------------------------------------------------------------------

function syncHeader(view: HudView, shown: Shown, info: HudInfo): void {
  if (info.levelId !== shown.levelId) {
    shown.levelId = info.levelId;
    view.week.textContent = info.levelId;
  }
  const bestTicks = info.best ? info.best.ticks : -1;
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
  const bestDistance = info.best ? info.best.distance : -1;
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
  // Compared as a strict boolean: a car state from a flat world may not carry the field at all.
  const air = car.airborne === true;
  if (air === shown.air) return;
  shown.air = air;
  view.air.classList.toggle('is-on', air);
}

// ---- Shared ---------------------------------------------------------------------------------------------------

function syncChainBreak(view: HudView, shown: Shown, drift: Drifting): void {
  if (drift.lastChainBreakTick === shown.chainBreakTick) return;
  shown.chainBreakTick = drift.lastChainBreakTick;
  if (drift.lastChainBreakTick < 0) view.chainLost.classList.remove('is-on');
  else replayAnimation(view.chainLost);
}

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

function syncDrift(view: HudView, shown: Shown, drift: Drifting): void {
  const chain = Math.round(drift.chainScore);
  if (chain !== shown.chain) {
    shown.chain = chain;
    view.chainPoints.textContent = formatScore(chain);
    view.chain.classList.toggle('is-empty', chain === 0);
  }
  const multiplierTenths = Math.round(drift.multiplier * 10);
  if (multiplierTenths !== shown.multiplierTenths) {
    shown.multiplierTenths = multiplierTenths;
    view.multiplier.textContent = `×${(multiplierTenths / 10).toFixed(1)}`;
  }
  const banked = Math.round(drift.driftScore);
  if (banked !== shown.banked) {
    shown.banked = banked;
    view.banked.textContent = formatScore(banked);
  }
  if (drift.drifting !== shown.drifting) {
    shown.drifting = drift.drifting;
    view.drift.classList.toggle('is-live', drift.drifting);
  }
}

function syncSpeed(view: HudView, shown: Shown, car: CarState): void {
  const kmh = Math.round(car.speed * MS_TO_KMH);
  if (kmh === shown.kmh) return;
  shown.kmh = kmh;
  view.speed.textContent = String(kmh);
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
      syncChainBreak(view, shown, run);
      syncCountdown(view, shown, run);
      syncDrift(view, shown, run);
      syncSpeed(view, shown, car);
    },
    updateEndless(state, car, info) {
      syncLayout(view, shown, LAYOUT_ENDLESS);
      syncLevel(view, shown, state);
      syncDistance(view, shown, state, info);
      syncLives(view, shown, state);
      syncCrashFlash(view, shown, state);
      syncAir(view, shown, car);
      syncChainBreak(view, shown, state);
      syncCountdown(view, shown, state);
      syncDrift(view, shown, state);
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
