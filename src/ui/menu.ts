import type { BestRecord, DeathCause, Difficulty, EndlessBest, Quality, Settings } from '../types';
import { formatDelta, formatDistance, formatScore, formatTime } from './format';
import { markGlitch, markGlitchCover } from './glitch';
import { announceMute, onMuteChange } from './muteButton';
import { DIFFICULTIES, loadEndlessDifficulty, saveEndlessDifficulty } from './storage';
import { el, injectStyles } from './styles';

export interface MenuCallbacks {
  onPlay(weekId: string): void;
  /** Start an endless run on the difficulty picked on the title screen. */
  onPlayEndless(difficulty: Difficulty): void;
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
  endlessBests: Record<Difficulty, EndlessBest | null>;
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

export interface GameOverResult {
  difficulty: Difficulty;
  /** Distance reached, m. */
  distance: number;
  driftScore: number;
  /** Ticks survived. */
  ticks: number;
  cause: DeathCause;
  /** The record to compare against: the best distance before this run. */
  best: EndlessBest | null;
  isNewBest: boolean;
  /** The run was driven with tuning-panel edits, so its distance was not saved. */
  tuned: boolean;
}

export interface Menu {
  showTitle(data: TitleData): void;
  showPause(settings: Settings): void;
  showFinish(result: FinishResult): void;
  /** The end of an endless run. */
  showGameOver(result: GameOverResult): void;
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
  /** Present on screens with a settings block: shows a mute state that changed outside the menu. */
  setMuted?(muted: boolean): void;
}

/**
 * Enter on a focused button clicks it natively and also reaches the game as "confirm" a frame later.
 * Without a guard that second signal would press the primary button of whatever screen the click opened.
 */
const CONFIRM_GUARD_MS = 250;
/** Longer where a run has just ended: gamepad confirm is the handbrake button, which players mash to the end. */
const FINISH_CONFIRM_GUARD_MS = 700;

const QUALITIES: readonly Quality[] = ['low', 'high'];
const NO_TIME = '--';
const ENDLESS_PITCH = "The road never ends. Three crashes and you're out. Fly off the road and it's over.";

const CONTROLS: readonly (readonly [action: string, keyboard: string, gamepad: string])[] = [
  ['Steer', 'A / D or ← →', 'Left stick'],
  ['Throttle', 'W or ↑', 'Right trigger'],
  ['Brake / reverse', 'S or ↓', 'Left trigger'],
  ['Handbrake', 'Space', 'A / Cross'],
  ['Reset to checkpoint (weekly)', 'R', 'Y / Triangle'],
  ['Restart run', 'Backspace', 'Back / Share'],
  ['Pause', 'Esc or P', 'Start / Options'],
  ['Mute', 'M', '—'],
];

/** The main action of a screen. The glitcher may pick these buttons; the lesser ones it leaves alone. */
const PRIMARY_BUTTON = 'sd-btn-primary';
/** How much more often the logo glitches than any other element on the screen. */
const LOGO_GLITCH_WEIGHT = 3;

const DEATH_HEADLINES: Record<DeathCause, string> = { offTrack: 'Off the road', crashes: 'Wrecked' };
const DEATH_REASONS: Record<DeathCause, string> = {
  offTrack: 'You landed outside the road',
  crashes: 'One crash too many',
};

function bestText(best: BestRecord | null | undefined): string {
  return best ? formatTime(best.ticks) : NO_TIME;
}

function bestDistanceText(best: EndlessBest | null | undefined): string {
  return best ? formatDistance(best.distance) : NO_TIME;
}

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const node = el('button', variant ? `sd-btn ${variant}` : 'sd-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  if (variant === PRIMARY_BUTTON) markGlitch(node, 'full', { text: label });
  return node;
}

/** A heading the glitcher may pick. Its text never changes, so the slice effect can copy it. */
function glitchHeading<K extends 'h1' | 'h2' | 'h3'>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  return markGlitch(el(tag, className, text), 'full', { text });
}

function section(title: string, ...children: Node[]): HTMLElement {
  const node = el('section', 'sd-section');
  node.append(glitchHeading('h2', 'sd-label', title), ...children);
  return node;
}

/** A row of mutually exclusive buttons. Returns the group; `onSelect` only fires when the choice changes. */
function segmented<T extends string>(
  label: string,
  options: readonly T[],
  initial: T,
  onSelect: (value: T) => void,
  className = 'sd-seg',
): HTMLElement {
  let selected = initial;
  const group = el('div', className);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const buttons = options.map((option) => button(option, () => select(option), 'sd-btn-small'));

  function mark(): void {
    buttons.forEach((node, i) => node.setAttribute('aria-pressed', String(options[i] === selected)));
  }
  function select(option: T): void {
    if (option === selected) return;
    selected = option;
    mark();
    onSelect(option);
  }

  mark();
  group.append(...buttons);
  return group;
}

// ---- Settings -------------------------------------------------------------------------------------------------

function qualityRow(current: Settings, emit: () => void): HTMLElement {
  const group = segmented('Quality', QUALITIES, current.quality, (quality) => {
    current.quality = quality;
    emit();
  });
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

function switchRow(label: string, on: boolean, onToggle: (on: boolean) => void): { row: HTMLElement; box: HTMLInputElement } {
  const box = el('input', 'sd-switch');
  box.type = 'checkbox';
  box.checked = on;
  box.addEventListener('change', () => onToggle(box.checked));
  const row = el('label', 'sd-setting');
  row.append(el('span', '', label), box);
  return { row, box };
}

function settingsSection(
  initial: Settings,
  onChange: (settings: Settings) => void,
): { node: HTMLElement; setMuted(muted: boolean): void } {
  const current: Settings = { ...initial };
  const emit = (): void => onChange({ ...current });
  const volume = volumeRow(current, emit);

  // The slider keeps working while muted (the level is remembered for later); it only looks switched off.
  function showMuted(): void {
    volume.classList.toggle('is-off', current.muted);
  }

  const sound = switchRow('Sound', !current.muted, (on) => {
    current.muted = !on;
    showMuted();
    emit();
  });
  const assist = switchRow('Steering assist', current.assist, (on) => {
    current.assist = on;
    emit();
  });
  const calm = switchRow('Reduced flash', current.reducedFlash, (on) => {
    current.reducedFlash = on;
    emit();
  });
  showMuted();

  return {
    node: section('Settings', qualityRow(current, emit), sound.row, volume, assist.row, calm.row),
    setMuted(muted) {
      if (muted === current.muted) return;
      current.muted = muted;
      sound.box.checked = !muted;
      showMuted();
    },
  };
}

// ---- Title ----------------------------------------------------------------------------------------------------

function logo(): HTMLElement {
  const header = el('header');
  const name = el('h1', 'sd-logo');
  name.setAttribute('aria-label', 'SigDRIFT');
  // Both halves carry their own text, so a slice band can cross the whole name. It glitches more than the rest.
  for (const [tag, text] of [['span', 'Sig'], ['b', 'DRIFT']] as const) {
    const half = el(tag, '', text);
    half.setAttribute('data-text', text);
    name.appendChild(half);
  }
  markGlitch(name, 'full', { weight: LOGO_GLITCH_WEIGHT });
  header.append(name, el('p', 'sd-label sd-tagline', 'One car · one neon city · a new run every week'));
  return header;
}

function modeHead(title: string, detail?: string): HTMLElement {
  const head = el('div', 'sd-mode-head');
  head.append(glitchHeading('h2', 'sd-label', title));
  if (detail) head.append(el('span', 'sd-num', detail));
  return head;
}

/** "Best" over a large value, beside the button that starts the mode. Returns the value node too. */
function featureRow(value: string, go: HTMLButtonElement): { row: HTMLElement; value: HTMLElement } {
  const valueNode = el('div', 'sd-num sd-feature-time', value);
  const record = el('div');
  record.append(el('div', 'sd-label', 'Best'), valueNode);
  const row = el('div', 'sd-feature-row');
  row.append(record, go);
  return { row, value: valueNode };
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
  const box = el('div', 'sd-section');
  box.append(glitchHeading('h3', 'sd-label', 'Past weeks'), list);
  return box;
}

function weeklyMode(data: TitleData, drive: HTMLButtonElement, onPlay: (weekId: string) => void): HTMLElement {
  const body = el('div', 'sd-mode-body');
  if (data.pastWeeks.length > 0) body.append(pastWeeks(data, onPlay));
  const box = markGlitch(el('section', 'sd-mode'), 'full', { kind: 'panel' });
  box.append(modeHead('Weekly run', data.currentWeek), body, featureRow(bestText(data.bests[data.currentWeek]), drive).row);
  return box;
}

function endlessMode(data: TitleData, onPlayEndless: (difficulty: Difficulty) => void): HTMLElement {
  let difficulty = loadEndlessDifficulty();
  const go = button('Go endless', () => onPlayEndless(difficulty), PRIMARY_BUTTON);
  const feature = featureRow(bestDistanceText(data.endlessBests[difficulty]), go);
  const picker = segmented(
    'Difficulty',
    DIFFICULTIES,
    difficulty,
    (picked) => {
      difficulty = picked;
      saveEndlessDifficulty(picked);
      feature.value.textContent = bestDistanceText(data.endlessBests[picked]);
    },
    'sd-seg sd-seg-wide',
  );
  const body = el('div', 'sd-mode-body');
  body.append(el('p', 'sd-mode-text', ENDLESS_PITCH), picker);
  const box = markGlitch(el('section', 'sd-mode sd-mode-endless'), 'full', { kind: 'panel' });
  box.append(modeHead('Endless'), body, feature.row);
  return box;
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
  callbacks: Pick<MenuCallbacks, 'onPlay' | 'onPlayEndless'>,
  onSettings: (settings: Settings) => void,
): Screen {
  const drive = button('Drive', () => callbacks.onPlay(data.currentWeek), PRIMARY_BUTTON);
  const modes = el('div', 'sd-title-grid');
  modes.append(weeklyMode(data, drive, callbacks.onPlay), endlessMode(data, callbacks.onPlayEndless));
  const settings = settingsSection(data.settings, onSettings);
  const reference = el('div', 'sd-title-grid');
  reference.append(settings.node, controlsSection());
  const content = el('div', 'sd-screen');
  content.append(logo(), modes, reference);
  return {
    content,
    primary: drive,
    label: 'SigDRIFT',
    narrow: false,
    confirmGuardMs: CONFIRM_GUARD_MS,
    setMuted: settings.setMuted,
  };
}

// ---- Pause ----------------------------------------------------------------------------------------------------

function pauseScreen(
  initial: Settings,
  callbacks: Pick<MenuCallbacks, 'onResume' | 'onRestart' | 'onQuit'>,
  onSettings: (settings: Settings) => void,
): Screen {
  const resume = button('Resume', callbacks.onResume, PRIMARY_BUTTON);
  const actions = el('div', 'sd-actions');
  actions.append(resume, button('Restart', callbacks.onRestart), button('Quit to menu', callbacks.onQuit));
  const settings = settingsSection(initial, onSettings);
  const content = el('div', 'sd-screen');
  content.append(glitchHeading('h1', 'sd-heading', 'Paused'), actions, settings.node);
  return {
    content,
    primary: resume,
    label: 'Paused',
    narrow: true,
    confirmGuardMs: CONFIRM_GUARD_MS,
    setMuted: settings.setMuted,
  };
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

/** Retry (primary) and Menu, as they close both a finished weekly run and a dead endless one. */
function endOfRunActions(callbacks: Pick<MenuCallbacks, 'onRestart' | 'onQuit'>): {
  node: HTMLElement;
  retry: HTMLButtonElement;
} {
  const retry = button('Retry', callbacks.onRestart, PRIMARY_BUTTON);
  const node = el('div', 'sd-actions');
  node.append(retry, button('Menu', callbacks.onQuit));
  return { node, retry };
}

/** The big time or distance a result screen is about. */
function headlineValue(text: string): HTMLElement {
  return markGlitch(el('div', 'sd-num sd-finish-time', text), 'full', { text });
}

function finishScreen(result: FinishResult, callbacks: Pick<MenuCallbacks, 'onRestart' | 'onQuit'>): Screen {
  const head = el('div', 'sd-finish-head');
  head.append(glitchHeading('h1', 'sd-label', `Run complete — ${result.levelId}`));
  if (result.tuned) head.append(el('span', 'sd-badge sd-badge-muted', 'TUNED CAR — TIME NOT SAVED'));
  else if (result.isNewBest) head.append(el('span', 'sd-badge', 'NEW BEST'));
  const actions = endOfRunActions(callbacks);
  const content = el('div', 'sd-screen');
  content.append(head, headlineValue(formatTime(result.ticks)), finishStats(result), actions.node);
  return {
    content,
    primary: actions.retry,
    label: 'Run complete',
    narrow: true,
    confirmGuardMs: FINISH_CONFIRM_GUARD_MS,
  };
}

// ---- Game over (endless) --------------------------------------------------------------------------------------

function previousEndlessBest(result: GameOverResult): EndlessBest | null {
  // Same tolerance as previousBest: a record equal to this very run is not a "previous" one.
  const isOwnRecord = result.isNewBest && result.best !== null && result.best.distance === result.distance;
  return isOwnRecord ? null : result.best;
}

function distanceDelta(metres: number): string {
  return `${metres < 0 ? '-' : '+'}${formatDistance(Math.abs(metres))}`;
}

function gameOverStats(result: GameOverResult): HTMLElement {
  const stats = el('dl', 'sd-stats');
  const previous = previousEndlessBest(result);
  if (previous) {
    const delta = result.distance - previous.distance;
    stats.append(
      // Further is better here, so the colours are the other way round from a time.
      stat('Vs previous best', distanceDelta(delta), delta > 0 ? 'sd-delta is-faster' : 'sd-delta is-slower'),
      stat('Previous best', formatDistance(previous.distance)),
    );
  }
  stats.append(stat('Time survived', formatTime(result.ticks)), stat('Drift score', formatScore(result.driftScore)));
  return stats;
}

function gameOverScreen(result: GameOverResult, callbacks: Pick<MenuCallbacks, 'onRestart' | 'onQuit'>): Screen {
  const head = el('div', 'sd-finish-head');
  head.append(el('p', 'sd-label', `Endless — ${result.difficulty}`));
  if (result.tuned) head.append(el('span', 'sd-badge sd-badge-muted', 'TUNED CAR — NOT SAVED'));
  else if (result.isNewBest) head.append(el('span', 'sd-badge', 'NEW BEST'));

  const headline = glitchHeading('h1', 'sd-over-title', DEATH_HEADLINES[result.cause]);
  headline.classList.toggle('is-off-road', result.cause === 'offTrack');
  const over = el('div', 'sd-over');
  over.append(headline, el('p', 'sd-label', DEATH_REASONS[result.cause]));

  const actions = endOfRunActions(callbacks);
  const content = el('div', 'sd-screen');
  content.append(
    head,
    over,
    headlineValue(formatDistance(result.distance)),
    gameOverStats(result),
    actions.node,
  );
  return {
    content,
    primary: actions.retry,
    label: 'Game over',
    narrow: true,
    confirmGuardMs: FINISH_CONFIRM_GUARD_MS,
  };
}

// ---- Menu -----------------------------------------------------------------------------------------------------

export function createMenu(root: HTMLElement, callbacks: MenuCallbacks): Menu {
  injectStyles();
  // While a menu is up the HUD behind it is dimmed, so the glitcher leaves the HUD's readouts alone.
  const overlay = markGlitchCover(el('div', 'sd-ui sd-menu sd-hidden'));
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // The frame is the box the player sees; the panel inside it is what scrolls when a screen is taller than the window.
  const frame = markGlitch(el('div', 'sd-panel sd-menu-frame'), 'full', { kind: 'frame' });
  const panel = el('div', 'sd-menu-panel');
  frame.appendChild(panel);
  overlay.appendChild(frame);
  root.appendChild(overlay);

  let open = false;
  let primary: HTMLButtonElement | null = null;
  let showMutedOnScreen: ((muted: boolean) => void) | null = null;
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

  // Sound can be switched from outside the menu while it is open (the corner button, the M key).
  function muteChangedElsewhere(muted: boolean): void {
    showMutedOnScreen?.(muted);
  }
  const stopMuteListening = onMuteChange(muteChangedElsewhere);

  function hide(): void {
    if (!open) return;
    open = false;
    primary = null;
    showMutedOnScreen = null;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && overlay.contains(focused)) focused.blur();
    overlay.classList.add('sd-hidden');
    panel.replaceChildren();
  }

  function show(screen: Screen): void {
    panel.replaceChildren(screen.content);
    frame.classList.toggle('is-narrow', screen.narrow);
    panel.scrollTop = 0;
    overlay.setAttribute('aria-label', screen.label);
    overlay.classList.remove('sd-hidden');
    open = true;
    primary = screen.primary;
    showMutedOnScreen = screen.setMuted ?? null;
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
    announceMute(settings.muted, muteChangedElsewhere);
    callbacks.onSettings(settings);
  }

  // Every action closes the menu before its callback runs, so the callback is free to open another screen.
  const actions: MenuCallbacks = {
    onPlay(weekId) {
      hide();
      callbacks.onPlay(weekId);
    },
    onPlayEndless(difficulty) {
      hide();
      callbacks.onPlayEndless(difficulty);
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
      show(titleScreen(data, actions, actions.onSettings));
    },
    showPause(settings) {
      applyCalm(settings);
      show(pauseScreen(settings, actions, actions.onSettings));
    },
    showFinish(result) {
      show(finishScreen(result, actions));
    },
    showGameOver(result) {
      show(gameOverScreen(result, actions));
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
      stopMuteListening();
      overlay.remove();
    },
  };
}
