import type { BestRecord, Quality, Settings } from '../types';
import { formatDelta, formatScore, formatTime } from './format';
import { el, injectStyles } from './styles';

export interface MenuCallbacks {
  onPlay(weekId: string): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  /** Called with a fresh object every time the player changes a setting. */
  onSettings(settings: Settings): void;
}

export interface TitleData {
  currentWeek: string;
  pastWeeks: string[];
  bests: Record<string, BestRecord | null>;
  settings: Settings;
}

export interface FinishResult {
  levelId: string;
  ticks: number;
  driftScore: number;
  resets: number;
  /** The record to compare against: the best time before this run. */
  best: BestRecord | null;
  isNewBest: boolean;
  /** The run was driven with tuning-panel edits, so its time was not saved. */
  tuned?: boolean;
}

export interface Menu {
  showTitle(data: TitleData): void;
  showPause(settings: Settings): void;
  showFinish(result: FinishResult): void;
  hide(): void;
  readonly isOpen: boolean;
  /** Activates the primary button of the current screen (Enter / gamepad A). */
  confirm(): void;
  dispose(): void;
}

interface Screen {
  content: HTMLElement;
  primary: HTMLButtonElement;
  label: string;
  narrow: boolean;
  /** How long after the screen appears confirm() stays inert. */
  confirmGuardMs: number;
}

/**
 * Enter on a focused button clicks it natively and also reaches the game as "confirm" a frame later.
 * Without a guard that second signal would press the primary button of whatever screen the click opened.
 */
const CONFIRM_GUARD_MS = 250;
/** Longer on the finish screen: gamepad confirm is the handbrake button, which players mash over the line. */
const FINISH_CONFIRM_GUARD_MS = 700;

const QUALITIES: readonly Quality[] = ['low', 'high'];
const NO_TIME = '--';

const CONTROLS: readonly (readonly [action: string, keyboard: string, gamepad: string])[] = [
  ['Steer', 'A / D or ← →', 'Left stick'],
  ['Throttle', 'W or ↑', 'Right trigger'],
  ['Brake / reverse', 'S or ↓', 'Left trigger'],
  ['Handbrake', 'Space', 'A / Cross'],
  ['Reset to checkpoint', 'R', 'Y / Triangle'],
  ['Restart run', 'Backspace', 'Back / Share'],
  ['Pause', 'Esc or P', 'Start / Options'],
];

function bestText(best: BestRecord | null | undefined): string {
  return best ? formatTime(best.ticks) : NO_TIME;
}

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const node = el('button', variant ? `sd-btn ${variant}` : 'sd-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function section(title: string, ...children: Node[]): HTMLElement {
  const node = el('section', 'sd-section');
  node.append(el('h2', 'sd-label', title), ...children);
  return node;
}

// ---- Settings -------------------------------------------------------------------------------------------------

function qualityRow(current: Settings, emit: () => void): HTMLElement {
  const group = el('div', 'sd-seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Quality');
  const buttons = QUALITIES.map((quality) =>
    button(quality, () => select(quality), 'sd-btn-small'),
  );

  function mark(): void {
    buttons.forEach((node, i) => node.setAttribute('aria-pressed', String(QUALITIES[i] === current.quality)));
  }
  function select(quality: Quality): void {
    if (quality === current.quality) return;
    current.quality = quality;
    mark();
    emit();
  }

  mark();
  group.append(...buttons);
  const row = el('div', 'sd-setting');
  row.append(el('span', '', 'Quality'), group);
  return row;
}

function volumeRow(current: Settings, emit: () => void): HTMLElement {
  const slider = el('input', 'sd-range');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(Math.round(current.volume * 100));
  const readout = el('span', 'sd-num', `${slider.value}%`);
  slider.addEventListener('input', () => {
    current.volume = slider.valueAsNumber / 100;
    readout.textContent = `${slider.value}%`;
    emit();
  });

  const control = el('span', 'sd-setting-control');
  control.append(slider, readout);
  const row = el('label', 'sd-setting');
  row.append(el('span', '', 'Volume'), control);
  return row;
}

function switchRow(label: string, on: boolean, onToggle: (on: boolean) => void): HTMLElement {
  const box = el('input', 'sd-switch');
  box.type = 'checkbox';
  box.checked = on;
  box.addEventListener('change', () => onToggle(box.checked));
  const row = el('label', 'sd-setting');
  row.append(el('span', '', label), box);
  return row;
}

function settingsSection(initial: Settings, onChange: (settings: Settings) => void): HTMLElement {
  const current: Settings = { ...initial };
  const emit = (): void => onChange({ ...current });
  return section(
    'Settings',
    qualityRow(current, emit),
    volumeRow(current, emit),
    switchRow('Steering assist', current.assist, (on) => {
      current.assist = on;
      emit();
    }),
    switchRow('Reduced flash', current.reducedFlash, (on) => {
      current.reducedFlash = on;
      emit();
    }),
  );
}

// ---- Title ----------------------------------------------------------------------------------------------------

function logo(): HTMLElement {
  const header = el('header');
  const name = el('h1', 'sd-logo', 'Sig');
  name.setAttribute('aria-label', 'SigDRIFT');
  name.append(el('b', '', 'DRIFT'));
  header.append(name, el('p', 'sd-label sd-tagline', 'One car · one neon city · a new run every week'));
  return header;
}

function featuredRun(week: string, best: BestRecord | null | undefined, drive: HTMLButtonElement): HTMLElement {
  const record = el('div');
  record.append(el('div', 'sd-label', 'Best'), el('div', 'sd-num sd-feature-time', bestText(best)));
  const row = el('div', 'sd-feature-row');
  row.append(record, drive);
  const box = el('section', 'sd-section sd-feature');
  box.append(el('h2', 'sd-label', `This week's run — ${week}`), row);
  return box;
}

function pastWeeks(data: TitleData, onPlay: (weekId: string) => void): HTMLElement {
  const list = el('div', 'sd-weeks');
  for (const week of data.pastWeeks) {
    const row = el('button', 'sd-week');
    row.type = 'button';
    row.append(el('span', 'sd-num', week), el('span', 'sd-num', bestText(data.bests[week])));
    row.addEventListener('click', () => onPlay(week));
    list.appendChild(row);
  }
  return section('Past weeks', list);
}

function controlsSection(): HTMLElement {
  const table = el('table', 'sd-controls');
  const head = table.createTHead().insertRow();
  for (const title of ['Action', 'Keyboard', 'Gamepad']) {
    const cell = el('th', '', title);
    cell.scope = 'col';
    head.appendChild(cell);
  }
  const body = table.createTBody();
  for (const cells of CONTROLS) {
    const row = body.insertRow();
    for (const text of cells) row.insertCell().textContent = text;
  }
  return section('Controls', table);
}

function titleScreen(
  data: TitleData,
  onPlay: (weekId: string) => void,
  onSettings: (settings: Settings) => void,
): Screen {
  const drive = button('Drive', () => onPlay(data.currentWeek), 'sd-btn-primary');
  const runs = el('div', 'sd-col');
  runs.append(featuredRun(data.currentWeek, data.bests[data.currentWeek], drive));
  if (data.pastWeeks.length > 0) runs.append(pastWeeks(data, onPlay));
  const reference = el('div', 'sd-col');
  reference.append(settingsSection(data.settings, onSettings), controlsSection());
  const grid = el('div', 'sd-title-grid');
  grid.append(runs, reference);
  const content = el('div', 'sd-screen');
  content.append(logo(), grid);
  return { content, primary: drive, label: 'SigDRIFT', narrow: false, confirmGuardMs: CONFIRM_GUARD_MS };
}

// ---- Pause ----------------------------------------------------------------------------------------------------

function pauseScreen(
  settings: Settings,
  callbacks: Pick<MenuCallbacks, 'onResume' | 'onRestart' | 'onQuit'>,
  onSettings: (settings: Settings) => void,
): Screen {
  const resume = button('Resume', callbacks.onResume, 'sd-btn-primary');
  const actions = el('div', 'sd-actions');
  actions.append(resume, button('Restart', callbacks.onRestart), button('Quit to menu', callbacks.onQuit));
  const content = el('div', 'sd-screen');
  content.append(el('h1', 'sd-heading', 'Paused'), actions, settingsSection(settings, onSettings));
  return { content, primary: resume, label: 'Paused', narrow: true, confirmGuardMs: CONFIRM_GUARD_MS };
}

// ---- Finish ---------------------------------------------------------------------------------------------------

function stat(label: string, value: string, valueClass = ''): HTMLElement {
  const row = el('div', 'sd-stat');
  row.append(el('dt', 'sd-label', label), el('dd', valueClass ? `sd-num ${valueClass}` : 'sd-num', value));
  return row;
}

/** The record this run is measured against, or null when there is nothing meaningful to compare with. */
function previousBest(result: FinishResult): BestRecord | null {
  // Tolerates a caller that passes the record this very run just set: comparing a run with itself says nothing.
  const isOwnRecord = result.isNewBest && result.best !== null && result.best.ticks === result.ticks;
  return isOwnRecord ? null : result.best;
}

function finishStats(result: FinishResult): HTMLElement {
  const stats = el('dl', 'sd-stats');
  const previous = previousBest(result);
  if (previous) {
    const delta = result.ticks - previous.ticks;
    stats.append(
      stat('Vs previous best', formatDelta(delta), delta < 0 ? 'sd-delta is-faster' : 'sd-delta is-slower'),
      stat('Previous best', formatTime(previous.ticks)),
    );
  }
  stats.append(stat('Drift score', formatScore(result.driftScore)), stat('Resets', String(result.resets)));
  return stats;
}

function finishScreen(result: FinishResult, callbacks: Pick<MenuCallbacks, 'onRestart' | 'onQuit'>): Screen {
  const head = el('div', 'sd-finish-head');
  head.append(el('h1', 'sd-label', `Run complete — ${result.levelId}`));
  if (result.tuned) head.append(el('span', 'sd-badge sd-badge-muted', 'TUNED CAR — TIME NOT SAVED'));
  else if (result.isNewBest) head.append(el('span', 'sd-badge', 'NEW BEST'));
  const retry = button('Retry', callbacks.onRestart, 'sd-btn-primary');
  const actions = el('div', 'sd-actions');
  actions.append(retry, button('Menu', callbacks.onQuit));
  const content = el('div', 'sd-screen');
  content.append(head, el('div', 'sd-num sd-finish-time', formatTime(result.ticks)), finishStats(result), actions);
  return { content, primary: retry, label: 'Run complete', narrow: true, confirmGuardMs: FINISH_CONFIRM_GUARD_MS };
}

// ---- Menu -----------------------------------------------------------------------------------------------------

export function createMenu(root: HTMLElement, callbacks: MenuCallbacks): Menu {
  injectStyles();
  const overlay = el('div', 'sd-ui sd-menu sd-hidden');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const panel = el('div', 'sd-panel sd-menu-panel');
  overlay.appendChild(panel);
  root.appendChild(overlay);

  let open = false;
  let primary: HTMLButtonElement | null = null;
  let confirmBlockedUntil = 0;
  // Space is the handbrake and is often still held when a screen appears and focus lands on its primary button.
  // Only a press that began on this screen may activate a button.
  let spacePressedHere = false;

  function blockConfirm(ms: number): void {
    confirmBlockedUntil = Math.max(confirmBlockedUntil, performance.now() + ms);
  }

  overlay.addEventListener('click', () => blockConfirm(CONFIRM_GUARD_MS), true);
  overlay.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !event.repeat) spacePressedHere = true;
  });
  overlay.addEventListener('keyup', (event) => {
    if (event.code === 'Space' && !spacePressedHere) event.preventDefault();
  });

  function hide(): void {
    if (!open) return;
    open = false;
    primary = null;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && overlay.contains(focused)) focused.blur();
    overlay.classList.add('sd-hidden');
    panel.replaceChildren();
  }

  function show(screen: Screen): void {
    panel.replaceChildren(screen.content);
    panel.classList.toggle('is-narrow', screen.narrow);
    panel.scrollTop = 0;
    overlay.setAttribute('aria-label', screen.label);
    overlay.classList.remove('sd-hidden');
    open = true;
    primary = screen.primary;
    spacePressedHere = false;
    blockConfirm(screen.confirmGuardMs);
    primary.focus({ preventScroll: true });
  }

  function applyCalm(settings: Settings): void {
    // The HUD has no settings channel of its own: its flashes follow this class on the shared root.
    root.classList.toggle('sd-calm', settings.reducedFlash);
  }

  function changeSettings(settings: Settings): void {
    applyCalm(settings);
    callbacks.onSettings(settings);
  }

  // Every action closes the menu before its callback runs, so the callback is free to open another screen.
  const actions: MenuCallbacks = {
    onPlay(weekId) {
      hide();
      callbacks.onPlay(weekId);
    },
    onResume() {
      hide();
      callbacks.onResume();
    },
    onRestart() {
      hide();
      callbacks.onRestart();
    },
    onQuit() {
      hide();
      callbacks.onQuit();
    },
    onSettings: changeSettings,
  };

  return {
    showTitle(data) {
      applyCalm(data.settings);
      show(titleScreen(data, actions.onPlay, actions.onSettings));
    },
    showPause(settings) {
      applyCalm(settings);
      show(pauseScreen(settings, actions, actions.onSettings));
    },
    showFinish(result) {
      show(finishScreen(result, actions));
    },
    hide,
    get isOpen() {
      return open;
    },
    confirm() {
      if (!open || !primary || performance.now() < confirmBlockedUntil) return;
      primary.click();
    },
    dispose() {
      hide();
      overlay.remove();
    },
  };
}
