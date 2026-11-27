import { SIM_HZ } from '../types';
import type { BestRecord, CarState, RunState } from '../types';
import { formatScore, formatTime } from './format';
import { el, injectStyles, replayAnimation } from './styles';

export interface HudInfo {
  levelId: string;
  best: BestRecord | null;
}

export interface Hud {
  /** Call every rendered frame. Only writes to the DOM when a displayed value has changed. */
  update(run: RunState, car: CarState, info: HudInfo): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const MS_TO_KMH = 3.6;
/** How long "GO" stays up once the run has started. */
const GO_TICKS = Math.round(SIM_HZ * 0.8);
const COUNT_GO = 0;
const COUNT_NONE = -1;
const CONTROLS_HINT = 'WASD / Arrows drive  ·  Space handbrake  ·  R reset  ·  Esc pause';

interface HudView {
  root: HTMLElement;
  week: HTMLElement;
  timer: HTMLElement;
  checkpoint: HTMLElement;
  best: HTMLElement;
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
  levelId: string | null;
  bestTicks: number;
  ticks: number;
  final: boolean;
  nextCheckpoint: number;
  checkpointCount: number;
  checkpointTick: number;
  chainBreakTick: number;
  count: number;
  hint: boolean;
  chain: number;
  multiplierTenths: number;
  banked: number;
  drifting: boolean;
  kmh: number;
}

function buildTop(view: Partial<HudView>): HTMLElement {
  const top = el('div', 'sd-hud-top');
  view.week = el('div', 'sd-label');
  view.timer = el('div', 'sd-num sd-hud-timer', formatTime(0));
  const meta = el('div', 'sd-hud-meta');
  view.checkpoint = el('span', 'sd-label sd-hud-cp');
  view.best = el('span', 'sd-label');
  meta.append(view.checkpoint, view.best);
  top.append(view.week, view.timer, meta);
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
  view.hint = el('div', 'sd-label sd-hud-hint sd-hidden', CONTROLS_HINT);
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
  root.append(buildTop(view), buildFlash(view), buildCentre(view), buildDrift(view), buildSpeed(view));
  view.root = root;
  return view as HudView;
}

function freshShown(): Shown {
  return {
    levelId: null,
    bestTicks: NaN,
    ticks: 0,
    final: false,
    nextCheckpoint: -1,
    checkpointCount: -1,
    checkpointTick: -1,
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

function syncChainBreak(view: HudView, shown: Shown, run: RunState): void {
  if (run.lastChainBreakTick === shown.chainBreakTick) return;
  shown.chainBreakTick = run.lastChainBreakTick;
  if (run.lastChainBreakTick < 0) view.chainLost.classList.remove('is-on');
  else replayAnimation(view.chainLost);
}

/** Whole seconds left on the countdown, COUNT_GO just after the start, COUNT_NONE otherwise. */
function countdownStep(run: RunState): number {
  if (run.phase === 'countdown') return Math.max(1, Math.ceil(run.countdownTicks / SIM_HZ));
  if (run.phase === 'running' && run.ticks < GO_TICKS) return COUNT_GO;
  return COUNT_NONE;
}

function syncCountdown(view: HudView, shown: Shown, run: RunState): void {
  const count = countdownStep(run);
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
  const hint = run.phase === 'countdown';
  if (hint !== shown.hint) {
    shown.hint = hint;
    view.hint.classList.toggle('sd-hidden', !hint);
  }
}

function syncDrift(view: HudView, shown: Shown, run: RunState): void {
  const chain = Math.round(run.chainScore);
  if (chain !== shown.chain) {
    shown.chain = chain;
    view.chainPoints.textContent = formatScore(chain);
    view.chain.classList.toggle('is-empty', chain === 0);
  }
  const multiplierTenths = Math.round(run.multiplier * 10);
  if (multiplierTenths !== shown.multiplierTenths) {
    shown.multiplierTenths = multiplierTenths;
    view.multiplier.textContent = `×${(multiplierTenths / 10).toFixed(1)}`;
  }
  const banked = Math.round(run.driftScore);
  if (banked !== shown.banked) {
    shown.banked = banked;
    view.banked.textContent = formatScore(banked);
  }
  if (run.drifting !== shown.drifting) {
    shown.drifting = run.drifting;
    view.drift.classList.toggle('is-live', run.drifting);
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
      syncHeader(view, shown, info);
      syncTimer(view, shown, run);
      syncProgress(view, shown, run);
      syncCheckpointFlash(view, shown, run);
      syncChainBreak(view, shown, run);
      syncCountdown(view, shown, run);
      syncDrift(view, shown, run);
      syncSpeed(view, shown, car);
    },
    setVisible(visible) {
      view.root.classList.toggle('sd-hidden', !visible);
    },
    dispose() {
      view.root.remove();
    },
  };
}
