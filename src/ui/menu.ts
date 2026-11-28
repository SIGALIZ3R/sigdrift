/**
 * The menus: one overlay that shows one screen at a time.
 *
 * FLOW
 *   TITLE (logo, tagline, PRESS ENTER) -> MAIN (PLAY, HOW TO PLAY, SETTINGS, CONTROLS)
 *   PLAY -> [HOW TO PLAY, the first time only] -> MODE SELECT (THIS WEEK, LEVELS, ENDLESS)
 *     THIS WEEK -> weekly card (DRIVE, PAST WEEKS -> list of past weeks)       -> onPlayWeekly(weekId)
 *     LEVELS    -> five level cards                                             -> onPlayLevel(levelId)
 *     ENDLESS   -> EASY / MEDIUM / HARD                                         -> onPlayEndless(difficulty)
 *   PAUSE (RESUME, RESTART, SETTINGS, CONTROLS, QUIT TO MENU); SETTINGS / CONTROLS opened from it come back to it.
 *   FINISH (weekly / level) and GAME OVER (endless): results, badges, top-five table, RETRY / NEXT LEVEL / MENU.
 *
 * USE FROM game.ts
 *   const menu = createMenu(uiRoot, callbacks, { currentWeek, pastWeeks, levels: LEVELS });
 *   menu.setSettings(settings)      once at start (applies reduced flash to the UI root) and whenever settings change
 *                                   outside the menu. The menu calls onSettings itself for changes made in it.
 *   menu.showTitle()                at boot and on quit (callbacks.onQuit means "go to the menu": call showMain()).
 *   menu.showPause() / showFinish(result) / showGameOver(result)    as the game requires.
 *   Every frame, from MetaInput while menu.isOpen:
 *     navUp/Down/Left/Right -> menu.nav('up' | ...)     moves focus (spatial), adjusts a focused volume slider
 *     confirm               -> menu.confirm()           activates the focused control (guarded, see below)
 *     back                  -> menu.back()              one screen back; on PAUSE it resumes (onResume), on FINISH /
 *                                                       GAME OVER it quits (onQuit), on TITLE it does nothing.
 *                                                       Returns false when it did nothing.
 *   Pressing Escape while paused: if menu.screen === 'pause' resume, otherwise call menu.back().
 *   Every action button hides the menu BEFORE its callback runs, so a callback may open another screen at once.
 *   onUiSound('move' | 'select' | 'back') is called for focus moves, activations and going back.
 *
 * Records shown on the select screens are read from storage.ts directly; results are passed in by the game (it saves
 * the run first with saveRunRecord / saveEndlessRecord and hands over what came back).
 *
 * CONFIRM GUARD: Enter on a focused button clicks it natively and reaches the game as "confirm" a frame later; the
 * gamepad's confirm is the handbrake button, which players mash at the end of a run. confirm() is therefore inert for
 * a moment after any click and after a screen appears (longer on result screens).
 */
import { CARS } from '../sim/cars';
import type { CarId } from '../sim/cars';
import type { DeathCause, Difficulty, EndlessRecord, LevelDef, Quality, RunRecord, Settings } from '../types';
import { formatDate, formatDelta, formatDistance, formatMultiplier, formatRank, formatScore, formatTime } from './format';
import { markGlitch, markGlitchCover, playTransition, startRowFlicker, startSignalLoss } from './glitch';
import { HOWTO_CARDS, diagram } from './howto';
import { announceMute, onMuteChange } from './muteButton';
import { moveFocus } from './nav';
import type { NavDir } from './nav';
import { SCRAMBLE_ATTR, scrambleIn } from './scramble';
import type { ScrambleHandle } from './scramble';
import {
  DEFAULT_SETTINGS,
  DIFFICULTIES,
  bestEndlessOverall,
  countCompleted,
  loadEndlessDifficulty,
  loadEndlessRecords,
  loadCar,
  loadHowToSeen,
  loadRunRecords,
  saveCar,
  unlockedCarIds,
  saveEndlessDifficulty,
  saveHowToSeen,
} from './storage';
import type { EndlessSaveResult, RunSaveResult } from './storage';
import { el, injectStyles } from './styles';

export type { NavDir } from './nav';
export type UiSound = 'move' | 'select' | 'back';
export type MenuScreen =
  | 'title'
  | 'main'
  | 'modes'
  | 'weekly'
  | 'weeks'
  | 'levels'
  | 'endless'
  | 'howto'
  | 'garage'
  | 'settings'
  | 'controls'
  | 'pause'
  | 'finish'
  | 'gameover';
/** Where SETTINGS / CONTROLS were opened from, and so where BACK goes. */
export type MenuOrigin = 'main' | 'pause';

export interface MenuCallbacks {
  onPlayWeekly(weekId: string): void;
  onPlayLevel(levelId: string): void;
  onPlayEndless(difficulty: Difficulty): void;
  onResume(): void;
  /** RESTART on the pause screen, RETRY on the result screens: the same track again. */
  onRestart(): void;
  /** QUIT TO MENU / MENU: the game tidies up and calls showMain() (or showTitle()). */
  onQuit(): void;
  /** NEXT LEVEL on the finish screen of L1..L4. */
  onNextLevel(levelId: string): void;
  /** A car picked in the garage (only ever an unlocked one). */
  onSelectCar?(id: CarId): void;
  /** A fresh object every time the player changes a setting; already applied to the UI (reduced flash, mute). */
  onSettings(settings: Settings): void;
  onUiSound?(kind: UiSound): void;
}

/** One level as its card shows it. LevelDef fits. */
export type LevelCard = Pick<LevelDef, 'id' | 'name' | 'blurb' | 'difficulty'>;

export interface MenuCatalog {
  /** This week's id, "2026-W48". */
  currentWeek: string;
  /** Earlier weeks, newest first. */
  pastWeeks: readonly string[];
  /** The five levels, in order. */
  levels: readonly LevelCard[];
}

export interface FinishResult {
  mode: 'weekly' | 'level';
  /** Week id or level id: the storage key. */
  trackId: string;
  /** Level name or week id, for the headline. */
  trackName: string;
  ticks: number;
  score: number;
  peakMultiplier: number;
  falls: number;
  resets: number;
  /** The fastest time stored BEFORE this run, or null. */
  previousBest: RunRecord | null;
  /** What saveRunRecord returned, or null when the run was not saved (tuned car). */
  saved: RunSaveResult | null;
  /** The top five after saving (loadRunRecords(trackId).highScores). */
  highScores: readonly RunRecord[];
  /** The level after this one (L1..L4), or null. */
  nextLevelId: string | null;
  /** Driven with tuning-panel edits, so nothing was saved. */
  tuned: boolean;
  /** Names of the cars this finish unlocked in the garage (usually none). */
  unlockedCars?: readonly string[];
}

export interface GameOverResult {
  difficulty: Difficulty;
  distance: number;
  score: number;
  peakMultiplier: number;
  ticks: number;
  cause: DeathCause;
  /** The furthest run stored BEFORE this one, or null. */
  previousBest: EndlessRecord | null;
  /** What saveEndlessRecord returned, or null when not saved (tuned car). */
  saved: EndlessSaveResult | null;
  highScores: readonly EndlessRecord[];
  tuned: boolean;
}

export interface Menu {
  /** Applies reduced flash to the UI and remembers the settings the SETTINGS screen starts from. */
  setSettings(settings: Settings): void;
  setCatalog(catalog: MenuCatalog): void;
  showTitle(): void;
  showMain(): void;
  showModeSelect(): void;
  showLevelSelect(): void;
  showEndlessSelect(): void;
  /** The weekly card for `weekId` (default: this week). */
  showWeekly(weekId?: string): void;
  showHowTo(firstTime: boolean): void;
  showGarage(): void;
  showSettings(settings: Settings, from: MenuOrigin): void;
  showControls(from: MenuOrigin): void;
  showPause(): void;
  showFinish(result: FinishResult): void;
  showGameOver(result: GameOverResult): void;
  hide(): void;
  readonly isOpen: boolean;
  /** The screen on show, or null when closed. */
  readonly screen: MenuScreen | null;
  /** One screen back. Returns false when there was nowhere to go (the title, or the menu is closed). */
  back(): boolean;
  /** Moves focus one control in `dir`. */
  nav(dir: NavDir): void;
  /** Activates the focused control (or the screen's main one). Enter / gamepad A. */
  confirm(): void;
  dispose(): void;
}

interface Screen {
  id: MenuScreen;
  content: HTMLElement;
  /** Focused when the screen appears (unless a remembered control is asked for). */
  primary: HTMLElement;
  label: string;
  width: 'narrow' | 'medium' | 'wide' | 'bare';
  /** How long after the screen appears confirm() stays inert. */
  confirmGuardMs: number;
  /** BACK. Absent: back does nothing. */
  back?: () => void;
  setMuted?(muted: boolean): void;
  /** Runs once the screen is on the page; returns what stops its ambient effects. */
  start?(): () => void;
}

const CONFIRM_GUARD_MS = 250;
const RESULT_CONFIRM_GUARD_MS = 700;
const QUALITIES: readonly Quality[] = ['low', 'high'];
const NO_VALUE = '--';
const SLIDER_STEP = 5;
/** A native arrow-key change on a focused slider within this long means the nav signal for it is a duplicate. */
const NATIVE_KEY_WINDOW_MS = 150;
const PRIMARY = 'sd-btn-primary';

const CONTROLS: readonly (readonly [action: string, keyboard: string, gamepad: string, touch: string])[] = [
  ['Steer', 'A / D or ← →', 'Left stick', 'Left pad: slide'],
  ['Throttle', 'W or ↑', 'Right trigger', 'GAS'],
  ['Brake / reverse', 'S or ↓', 'Left trigger', 'BRAKE'],
  ['Handbrake', 'Space', 'A / Cross', 'DRIFT'],
  ['Reset to checkpoint', 'R', 'Y / Triangle', '↺'],
  ['Restart run', 'Backspace', 'Back / Share', 'Pause → Restart'],
  ['Pause', 'Esc or P', 'Start / Options', '❚❚'],
  ['Mute', 'M', '—', 'Speaker, top right'],
  ['Menus: move', 'Arrows', 'D-pad / left stick', '—'],
  ['Menus: select', 'Enter', 'A / Cross', 'Tap'],
  ['Menus: back', 'Esc / Backspace', 'B / Circle', 'Back arrow'],
];

const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easy: 'Wide roads, gentle hills, barriers almost everywhere.',
  medium: 'Tighter turns, overpasses and the odd open edge.',
  hard: 'Narrow, steep and wide open. One slip and you drop.',
};

const DEATH_HEADLINES: Record<DeathCause, string> = { offTrack: 'Off the road', crashes: 'Wrecked' };
const DEATH_REASONS: Record<DeathCause, string> = {
  offTrack: 'You fell off the road',
  crashes: 'Three crashes — the car is done',
};

// ---- Small builders -------------------------------------------------------------------------------------------

/** Text that scrambles in when its screen appears. */
function scrambled<T extends HTMLElement>(node: T): T {
  node.setAttribute(SCRAMBLE_ATTR, '');
  return node;
}

function button(label: string, onClick: () => void, variant = '', key?: string): HTMLButtonElement {
  const node = el('button', variant ? `sd-btn ${variant}` : 'sd-btn');
  node.type = 'button';
  node.append(scrambled(el('span', 'sd-btn-label', label)));
  node.addEventListener('click', onClick);
  if (key) node.dataset.key = key;
  if (variant.includes(PRIMARY)) markGlitch(node, 'full', { kind: 'panel' });
  return node;
}

function backButton(onClick: () => void): HTMLButtonElement {
  const node = button('Back', onClick, 'sd-btn-small sd-btn-back', 'back');
  node.dataset.sound = 'back';
  return node;
}

/** A heading the glitcher may pick. */
function heading<K extends 'h1' | 'h2' | 'h3'>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  return scrambled(markGlitch(el(tag, className, text), 'full', { text }));
}

/** A screen's header: a back button (optional) and its title. */
function screenHead(title: string, onBack?: () => void, kicker?: string): HTMLElement {
  const head = el('header', 'sd-screen-head');
  if (onBack) head.append(backButton(onBack));
  const titles = el('div', 'sd-screen-titles');
  if (kicker) titles.append(el('p', 'sd-label', kicker));
  titles.append(heading('h1', 'sd-heading', title));
  head.append(titles);
  return head;
}

/** A big selectable card: title, one line, and up to two stat lines. */
function card(
  title: string,
  line: string,
  stats: readonly (readonly [label: string, value: string])[],
  onClick: () => void,
  key: string,
  extra = '',
): HTMLButtonElement {
  const node = el('button', `sd-card ${extra}`.trim());
  node.type = 'button';
  node.dataset.key = key;
  node.append(scrambled(el('span', 'sd-card-title', title)), el('span', 'sd-card-line', line));
  if (stats.length > 0) {
    const list = el('span', 'sd-card-stats');
    for (const [label, value] of stats) {
      const stat = el('span', 'sd-card-stat');
      stat.append(el('span', 'sd-label', label), el('span', 'sd-num', value));
      list.append(stat);
    }
    node.append(list);
  }
  node.addEventListener('click', onClick);
  return node;
}

function pips(count: number, filled: number): HTMLElement {
  const row = el('span', 'sd-pips');
  row.setAttribute('aria-label', `Difficulty ${filled} of ${count}`);
  for (let i = 0; i < count; i++) row.append(el('i', i < filled ? 'is-on' : ''));
  return row;
}

function bestTimeText(rec: RunRecord | null): string {
  return rec ? formatTime(rec.ticks) : NO_VALUE;
}

function topScoreText(table: readonly { score: number }[]): string {
  return table.length > 0 ? formatScore(table[0].score) : NO_VALUE;
}

function stat(label: string, value: string, valueClass = ''): HTMLElement {
  const row = el('div', 'sd-stat');
  row.append(el('dt', 'sd-label', label), el('dd', valueClass ? `sd-num ${valueClass}` : 'sd-num', value));
  return row;
}

function badge(text: string, variant = ''): HTMLElement {
  return markGlitch(el('span', `sd-badge ${variant}`.trim(), text), 'full', { text });
}

/** A row of mutually exclusive buttons. `onSelect` only fires when the choice changes. */
function segmented<T extends string>(label: string, options: readonly T[], initial: T, onSelect: (value: T) => void): HTMLElement {
  let selected = initial;
  const group = el('div', 'sd-seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const buttons = options.map((option) => {
    const node = el('button', 'sd-btn sd-btn-small', option);
    node.type = 'button';
    node.addEventListener('click', () => select(option));
    return node;
  });
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

// ---- High score table -----------------------------------------------------------------------------------------

interface TableRow {
  score: number;
  /** Time or distance, already formatted. */
  detail: string;
  date: string;
}

function scoreTable(title: string, detailTitle: string, rows: readonly TableRow[], highlight: number | null): HTMLElement {
  const box = el('section', 'sd-section');
  box.append(heading('h2', 'sd-label', title));
  if (rows.length === 0) {
    box.append(el('p', 'sd-muted', 'No scores yet.'));
    return box;
  }
  const table = el('table', 'sd-table sd-scores');
  const head = table.createTHead().insertRow();
  for (const text of ['#', 'Score', detailTitle, 'Date']) {
    const cell = el('th', '', text);
    cell.scope = 'col';
    head.appendChild(cell);
  }
  const body = table.createTBody();
  rows.forEach((row, i) => {
    const tr = body.insertRow();
    tr.className = 'sd-row';
    if (highlight === i + 1) tr.classList.add('is-new');
    for (const text of [String(i + 1), formatScore(row.score), row.detail, formatDate(row.date)]) {
      const cell = tr.insertCell();
      cell.textContent = text;
    }
  });
  box.append(table);
  return box;
}

// ---- Settings & controls --------------------------------------------------------------------------------------

function settingsRows(
  initial: Settings,
  onChange: (settings: Settings) => void,
): { node: HTMLElement; setMuted(muted: boolean): void } {
  const current: Settings = { ...initial };
  const emit = (): void => onChange({ ...current });

  const quality = el('div', 'sd-setting');
  quality.append(
    el('span', '', 'Quality'),
    segmented('Quality', QUALITIES, current.quality, (value) => {
      current.quality = value;
      emit();
    }),
  );

  function sliderRow(label: string, value: number, onInput: (value: number) => void): HTMLElement {
    const slider = el('input', 'sd-range');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(value * 100));
    slider.setAttribute('aria-label', label);
    const readout = el('span', 'sd-num', `${slider.value}%`);
    slider.addEventListener('input', () => {
      readout.textContent = `${slider.value}%`;
      onInput(slider.valueAsNumber / 100);
    });
    const control = el('span', 'sd-setting-control');
    control.append(slider, readout);
    const row = el('label', 'sd-setting');
    row.append(el('span', '', label), control);
    return row;
  }
  const volume = sliderRow('Volume', current.volume, (value) => {
    current.volume = value;
    emit();
  });
  const music = sliderRow('Music', current.musicVolume, (value) => {
    current.musicVolume = value;
    emit();
  });

  function switchRow(label: string, on: boolean, onToggle: (on: boolean) => void): { row: HTMLElement; box: HTMLInputElement } {
    const box = el('input', 'sd-switch');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => onToggle(box.checked));
    const row = el('label', 'sd-setting');
    row.append(el('span', '', label), box);
    return { row, box };
  }

  // The slider keeps working while muted (the level is remembered for later); it only looks switched off.
  function showMuted(): void {
    volume.classList.toggle('is-off', current.muted);
    music.classList.toggle('is-off', current.muted);
  }
  const sound = switchRow('Sound', !current.muted, (on) => {
    current.muted = !on;
    showMuted();
    emit();
  });
  const assist = switchRow('Drift assist', current.assist, (on) => {
    current.assist = on;
    emit();
  });
  const calm = switchRow('Reduced flash', current.reducedFlash, (on) => {
    current.reducedFlash = on;
    emit();
  });
  showMuted();

  const node = el('div', 'sd-settings');
  node.append(quality, sound.row, volume, music, assist.row, calm.row);
  return {
    node,
    setMuted(muted) {
      if (muted === current.muted) return;
      current.muted = muted;
      sound.box.checked = !muted;
      showMuted();
    },
  };
}

function controlsTable(): HTMLElement {
  const table = el('table', 'sd-table sd-controls');
  const head = table.createTHead().insertRow();
  for (const title of ['Action', 'Keyboard', 'Gamepad', 'Touch']) {
    const cell = el('th', '', title);
    cell.scope = 'col';
    head.appendChild(cell);
  }
  const body = table.createTBody();
  for (const cells of CONTROLS) {
    const row = body.insertRow();
    row.className = 'sd-row';
    for (const text of cells) row.insertCell().textContent = text;
  }
  return table;
}

// ---- Logo -----------------------------------------------------------------------------------------------------

function logo(big: boolean): HTMLElement {
  const name = el('h1', big ? 'sd-logo sd-logo-big' : 'sd-logo');
  name.setAttribute('aria-label', 'DriftNeo');
  // Both halves carry their own text, so a slice band can cross the whole name.
  for (const [tag, text] of [['span', 'Drift'], ['b', 'NEO']] as const) {
    const half = el(tag, '', text);
    half.setAttribute('data-text', text);
    name.appendChild(half);
  }
  return markGlitch(name, 'full', { weight: 3 });
}

// ---- Menu -----------------------------------------------------------------------------------------------------

export function createMenu(root: HTMLElement, callbacks: MenuCallbacks, initialCatalog: MenuCatalog): Menu {
  injectStyles();
  let catalog: MenuCatalog = initialCatalog;
  // While a menu is up the HUD behind it is dimmed, so the glitcher leaves the HUD's readouts alone.
  const overlay = markGlitchCover(el('div', 'sd-ui sd-menu sd-hidden'));
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // The frame is the box the player sees; the panel inside it scrolls when a screen is taller than the window.
  const frame = markGlitch(el('div', 'sd-panel sd-menu-frame'), 'full', { kind: 'frame' });
  const panel = el('div', 'sd-menu-panel');
  frame.append(panel, el('div', 'sd-tx-sweep'));
  overlay.appendChild(frame);
  root.appendChild(overlay);

  let settings: Settings | null = null;
  let current: Screen | null = null;
  let stopAmbient: (() => void) | null = null;
  let stopTransition: (() => void) | null = null;
  let scramble: ScrambleHandle | null = null;
  let confirmBlockedUntil = 0;
  let lastNativeArrowAt = -Infinity;
  // Space is the handbrake and is often still held when a screen appears and focus lands on a button.
  // Only a press that began on this screen may activate a button.
  let spacePressedHere = false;

  const sound = (kind: UiSound): void => callbacks.onUiSound?.(kind);

  function blockConfirm(ms: number): void {
    confirmBlockedUntil = Math.max(confirmBlockedUntil, performance.now() + ms);
  }

  overlay.addEventListener(
    'click',
    (event) => {
      blockConfirm(CONFIRM_GUARD_MS);
      const target = event.target instanceof Element ? event.target.closest('button, input') : null;
      if (target && overlay.contains(target) && !target.matches('input[type="range"]')) {
        sound(target.getAttribute('data-sound') === 'back' ? 'back' : 'select');
      }
    },
    true,
  );
  overlay.addEventListener('click', (event) => {
    // The title screen starts on a click anywhere.
    if (current?.id === 'title') {
      if (!(event.target instanceof Element && event.target.closest('button'))) sound('select');
      showMain();
    }
  });
  overlay.addEventListener(
    'keydown',
    (event) => {
      const target = event.target;
      const onSlider = target instanceof HTMLInputElement && target.type === 'range';
      if ((event.code === 'Enter' || event.code === 'Space' || event.code === 'NumpadEnter') && event.repeat) {
        // A held key must not walk on through every screen it opens.
        event.preventDefault();
        return;
      }
      if (event.code === 'Space' && !event.repeat) spacePressedHere = true;
      if (event.key.startsWith('Arrow')) {
        // Arrows move focus (through menu.nav); only a slider keeps its own left / right.
        if (onSlider && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) lastNativeArrowAt = performance.now();
        else event.preventDefault();
      }
    },
    true,
  );
  overlay.addEventListener('keyup', (event) => {
    if (event.code === 'Space' && !spacePressedHere) event.preventDefault();
  });
  // The mouse and the keyboard share one highlight: pointing at a control focuses it.
  overlay.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.sd-btn, .sd-card, .sd-week') : null;
    if (target && target !== document.activeElement && panel.contains(target)) target.focus({ preventScroll: true });
  });

  // Sound can be switched from outside the menu while it is open (the corner button, the M key).
  function muteChangedElsewhere(muted: boolean): void {
    if (settings) settings = { ...settings, muted };
    current?.setMuted?.(muted);
  }
  const stopMuteListening = onMuteChange(muteChangedElsewhere);

  function applyCalm(next: Settings): void {
    // The HUD and the glitcher follow this class on the shared root.
    root.classList.toggle('sd-calm', next.reducedFlash);
  }

  function changeSettings(next: Settings): void {
    settings = { ...next };
    applyCalm(next);
    announceMute(next.muted, muteChangedElsewhere);
    callbacks.onSettings(next);
  }

  function teardown(): void {
    stopAmbient?.();
    stopAmbient = null;
    stopTransition?.();
    stopTransition = null;
    scramble?.cancel();
    scramble = null;
  }

  function hide(): void {
    if (!current) return;
    teardown();
    current = null;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && overlay.contains(focused)) focused.blur();
    overlay.classList.add('sd-hidden');
    panel.replaceChildren();
  }

  function show(screen: Screen, focusKey?: string): void {
    teardown();
    panel.replaceChildren(screen.content);
    frame.classList.toggle('is-narrow', screen.width === 'narrow');
    frame.classList.toggle('is-medium', screen.width === 'medium');
    frame.classList.toggle('is-bare', screen.width === 'bare');
    overlay.classList.toggle('is-title', screen.id === 'title');
    panel.scrollTop = 0;
    overlay.setAttribute('aria-label', screen.label);
    overlay.classList.remove('sd-hidden');
    current = screen;
    spacePressedHere = false;
    blockConfirm(screen.confirmGuardMs);
    const remembered = focusKey ? screen.content.querySelector<HTMLElement>(`[data-key="${focusKey}"]`) : null;
    (remembered ?? screen.primary).focus({ preventScroll: true });
    stopTransition = playTransition(frame);
    scramble = scrambleIn(screen.content, root);
    stopAmbient = screen.start?.() ?? null;
  }

  /** Every action closes the menu before its callback runs, so the callback is free to open another screen. */
  function act(run: () => void): () => void {
    return () => {
      hide();
      run();
    };
  }

  // ---- Screens ------------------------------------------------------------------------------------------------

  function titleScreen(): Screen {
    const name = logo(true);
    const prompt = el('button', 'sd-press');
    prompt.type = 'button';
    prompt.append(el('span', '', 'Press Enter / Tap to start'));
    const content = el('div', 'sd-screen sd-title');
    content.append(name, el('p', 'sd-label sd-tagline', 'Drift the neon city. Kiss the walls. Don’t fall.'), prompt);
    return {
      id: 'title',
      content,
      primary: prompt,
      label: 'DriftNeo',
      width: 'bare',
      confirmGuardMs: CONFIRM_GUARD_MS,
      start: () => startSignalLoss(name, root),
    };
  }

  function showMain(focusKey?: string): void {
    const play = button('Play', onPlay, `${PRIMARY} sd-btn-big`, 'play');
    const list = el('div', 'sd-main-list');
    list.append(
      play,
      button('Garage', () => showGarage(), 'sd-btn-big', 'garage'),
      button('How to play', () => showHowTo(false), 'sd-btn-big', 'howto'),
      button('Settings', () => showSettings(currentSettings(), 'main'), 'sd-btn-big', 'settings'),
      button('Controls', () => showControls('main'), 'sd-btn-big', 'controls'),
    );
    const content = el('div', 'sd-screen sd-main');
    content.append(logo(false), list);
    show(
      { id: 'main', content, primary: play, label: 'Main menu', width: 'narrow', confirmGuardMs: CONFIRM_GUARD_MS, back: showTitle },
      focusKey,
    );
  }

  function onPlay(): void {
    if (loadHowToSeen()) showModeSelect();
    else showHowTo(true);
  }

  function showTitle(): void {
    show(titleScreen());
  }

  function showModeSelect(focusKey?: string): void {
    const week = loadRunRecords(catalog.currentWeek);
    const completed = countCompleted(catalog.levels.map((level) => level.id));
    const endless = bestEndlessOverall();
    const weekly = card(
      'This week',
      `Track ${catalog.currentWeek}`,
      [
        ['Best', bestTimeText(week.bestTime)],
        ['High score', topScoreText(week.highScores)],
      ],
      () => showWeekly(catalog.currentWeek),
      'weekly',
      'sd-card-cyan',
    );
    const cards = el('div', 'sd-cards sd-cards-3');
    cards.append(
      weekly,
      card(
        'Levels',
        `${completed} of ${catalog.levels.length} completed`,
        [],
        () => showLevelSelect(),
        'levels',
        'sd-card-amber',
      ),
      card(
        'Endless',
        endless ? `Best ${formatDistance(endless.record.distance)} (${endless.difficulty})` : 'No run yet',
        [],
        () => showEndlessSelect(),
        'endless',
        'sd-card-magenta',
      ),
    );
    const content = el('div', 'sd-screen');
    content.append(screenHead('Play', () => showMain('play'), 'Choose a mode'), cards);
    show(
      { id: 'modes', content, primary: weekly, label: 'Choose a mode', width: 'wide', confirmGuardMs: CONFIRM_GUARD_MS, back: () => showMain('play') },
      focusKey,
    );
  }

  function showWeekly(weekId: string = catalog.currentWeek, focusKey?: string): void {
    const records = loadRunRecords(weekId);
    const isCurrent = weekId === catalog.currentWeek;
    const drive = button('Drive', act(() => callbacks.onPlayWeekly(weekId)), `${PRIMARY} sd-btn-big`, 'drive');
    const box = el('div', 'sd-week-card');
    const stats = el('dl', 'sd-stats');
    stats.append(stat('Best time', bestTimeText(records.bestTime)), stat('Top score', topScoreText(records.highScores)));
    box.append(el('div', 'sd-num sd-week-id', weekId), stats);
    const actions = el('div', 'sd-actions');
    actions.append(drive);
    if (isCurrent && catalog.pastWeeks.length > 0) {
      actions.append(button('Past weeks', () => showPastWeeks(), 'sd-btn-small', 'past'));
    }
    const back = isCurrent ? () => showModeSelect('weekly') : () => showPastWeeks(weekId);
    const content = el('div', 'sd-screen');
    content.append(screenHead(isCurrent ? 'This week' : 'Past week', back, isCurrent ? 'Weekly run' : 'Replay'), box, actions);
    show(
      { id: 'weekly', content, primary: drive, label: 'Weekly run', width: 'narrow', confirmGuardMs: CONFIRM_GUARD_MS, back },
      focusKey,
    );
  }

  function showPastWeeks(focusKey?: string): void {
    const list = el('div', 'sd-weeks');
    for (const week of catalog.pastWeeks) {
      const records = loadRunRecords(week);
      const row = el('button', 'sd-week');
      row.type = 'button';
      row.dataset.key = week;
      row.append(
        el('span', 'sd-num', week),
        el('span', 'sd-num sd-dim', bestTimeText(records.bestTime)),
        el('span', 'sd-num sd-dim', topScoreText(records.highScores)),
      );
      row.addEventListener('click', () => showWeekly(week));
      list.appendChild(row);
    }
    const back = (): void => showWeekly(catalog.currentWeek, 'past');
    const content = el('div', 'sd-screen');
    content.append(screenHead('Past weeks', back, 'Weekly run'), list);
    const first = list.querySelector<HTMLElement>('.sd-week') ?? content.querySelector<HTMLElement>('.sd-btn-back');
    show(
      {
        id: 'weeks',
        content,
        primary: first ?? content,
        label: 'Past weeks',
        width: 'narrow',
        confirmGuardMs: CONFIRM_GUARD_MS,
        back,
        start: () => startRowFlicker(content, root, '.sd-week'),
      },
      focusKey,
    );
  }

  function showLevelSelect(focusKey?: string): void {
    const cards = el('div', 'sd-cards sd-cards-levels');
    let firstOpen: HTMLElement | null = null;
    catalog.levels.forEach((level, i) => {
      const records = loadRunRecords(level.id);
      const node = card(
        `${i + 1}  ${level.name}`,
        level.blurb,
        [
          ['Best', bestTimeText(records.bestTime)],
          ['High score', topScoreText(records.highScores)],
        ],
        act(() => callbacks.onPlayLevel(level.id)),
        level.id,
        `sd-card-d${Math.max(1, Math.min(5, Math.round(level.difficulty)))}${records.bestTime ? ' is-done' : ''}`,
      );
      node.insertBefore(pips(5, Math.max(1, Math.min(5, Math.round(level.difficulty)))), node.children[1] ?? null);
      // The first level not yet finished is where the player most likely wants to go.
      if (!firstOpen && !records.bestTime) firstOpen = node;
      cards.append(node);
    });
    const back = (): void => showModeSelect('levels');
    const content = el('div', 'sd-screen');
    content.append(screenHead('Levels', back, 'Pick a track'), cards);
    const primary = firstOpen ?? cards.querySelector<HTMLElement>('.sd-card') ?? content;
    show({ id: 'levels', content, primary, label: 'Levels', width: 'wide', confirmGuardMs: CONFIRM_GUARD_MS, back }, focusKey);
  }

  function showEndlessSelect(): void {
    const last = loadEndlessDifficulty();
    const cards = el('div', 'sd-cards sd-cards-3');
    let primary: HTMLElement | null = null;
    for (const difficulty of DIFFICULTIES) {
      const records = loadEndlessRecords(difficulty);
      const node = card(
        difficulty,
        DIFFICULTY_TEXT[difficulty],
        [
          ['Best', records.bestDistance ? formatDistance(records.bestDistance.distance) : NO_VALUE],
          ['High score', topScoreText(records.highScores)],
        ],
        act(() => {
          saveEndlessDifficulty(difficulty);
          callbacks.onPlayEndless(difficulty);
        }),
        difficulty,
        `sd-card-${difficulty}`,
      );
      if (difficulty === last) primary = node;
      cards.append(node);
    }
    const back = (): void => showModeSelect('endless');
    const content = el('div', 'sd-screen');
    const note = el('p', 'sd-muted', 'The road never ends. Fall off or crash three times and the run is over.');
    content.append(screenHead('Endless', back, 'Pick a difficulty'), cards, note);
    show({
      id: 'endless',
      content,
      primary: primary ?? cards.querySelector<HTMLElement>('.sd-card') ?? content,
      label: 'Endless',
      width: 'wide',
      confirmGuardMs: CONFIRM_GUARD_MS,
      back,
    });
  }

  function showHowTo(firstTime: boolean, startAt = 0): void {
    let index = Math.max(0, Math.min(HOWTO_CARDS.length - 1, startAt));
    const titleNode = scrambled(markGlitch(el('h1', 'sd-heading sd-howto-title'), 'full'));
    const counter = el('p', 'sd-label sd-howto-count');
    const art = el('div', 'sd-howto-art');
    const text = el('div', 'sd-howto-text');
    const dots = el('div', 'sd-dots');
    const dotNodes = HOWTO_CARDS.map(() => dots.appendChild(el('i')));
    const cardBox = el('div', 'sd-howto-card');
    const head = el('div', 'sd-screen-titles');
    head.append(counter, titleNode);
    cardBox.append(art, text);

    const prev = button('Back', () => step(-1), 'sd-btn-small', 'prev');
    prev.dataset.sound = 'back';
    const next = button('Next', () => step(1), `${PRIMARY}`, 'next');
    const skip = button('Skip', finish, 'sd-btn-small sd-btn-ghost', 'skip');
    const actions = el('div', 'sd-howto-actions');
    actions.append(prev, next, skip);

    let cardScramble: ScrambleHandle | null = null;

    function render(): void {
      const item = HOWTO_CARDS[index];
      titleNode.textContent = item.title;
      titleNode.setAttribute('data-text', item.title);
      counter.textContent = `How to play · ${index + 1} / ${HOWTO_CARDS.length}`;
      art.replaceChildren(diagram(item.svg));
      text.replaceChildren(...item.lines.map((line) => el('p', '', line)));
      dotNodes.forEach((dot, i) => dot.classList.toggle('is-on', i === index));
      const last = index === HOWTO_CARDS.length - 1;
      const label = next.querySelector('.sd-btn-label');
      if (label) label.textContent = last ? (firstTime ? 'Let’s drive' : 'Done') : 'Next';
      prev.disabled = index === 0;
      prev.classList.toggle('is-disabled', index === 0);
    }

    function step(delta: number): void {
      const to = index + delta;
      if (to >= HOWTO_CARDS.length) {
        finish();
        return;
      }
      if (to < 0) return;
      index = to;
      render();
      playTransition(cardBox);
      cardScramble?.cancel();
      cardScramble = scrambleIn(head, root);
      if (document.activeElement === prev && prev.disabled) next.focus({ preventScroll: true });
    }

    function finish(): void {
      saveHowToSeen();
      if (firstTime) showModeSelect();
      else showMain('howto');
    }

    render();
    const content = el('div', 'sd-screen sd-howto');
    const top = el('header', 'sd-screen-head');
    top.append(head);
    content.append(top, cardBox, dots, actions);
    show({
      id: 'howto',
      content,
      primary: next,
      label: 'How to play',
      width: 'medium',
      confirmGuardMs: CONFIRM_GUARD_MS,
      back: () => {
        if (index > 0) step(-1);
        else showMain(firstTime ? 'play' : 'howto');
      },
      start: () => () => cardScramble?.cancel(),
    });
  }

  function statBars(label: string, value: number): HTMLElement {
    const row = el('span', 'sd-car-stat');
    const bars = el('span', 'sd-pips');
    bars.setAttribute('aria-label', `${label} ${value} of 5`);
    for (let i = 0; i < 5; i++) bars.append(el('i', i < value ? 'is-on' : ''));
    row.append(el('span', 'sd-label', label), bars);
    return row;
  }

  function showGarage(fromFinish = false, focusKey?: string): void {
    const unlocked = new Set(unlockedCarIds());
    let selected = loadCar();
    const cards = el('div', 'sd-cards sd-cards-3 sd-garage');
    const nodes: HTMLButtonElement[] = [];
    let primary: HTMLElement | null = null;
    const levelName = (id: string): string => {
      const index = catalog.levels.findIndex((level) => level.id === id);
      return index >= 0 ? `level ${index + 1}` : id;
    };
    function mark(): void {
      for (const node of nodes) {
        const on = node.dataset.key === selected;
        node.classList.toggle('is-selected', on);
        node.setAttribute('aria-pressed', String(on));
      }
    }
    for (const car of CARS) {
      const open = unlocked.has(car.id);
      const line = open ? car.tagline : `Locked. Finish ${levelName(car.unlockLevel ?? '')} to unlock.`;
      const node = card(
        car.name,
        line,
        [],
        () => {
          if (!unlocked.has(car.id)) return;
          if (selected === car.id) return;
          selected = car.id;
          saveCar(car.id);
          mark();
          callbacks.onSelectCar?.(car.id);
        },
        car.id,
        `sd-car sd-car-${car.id}${open ? '' : ' is-locked'}`,
      );
      if (!open) node.dataset.sound = 'back';
      const stats = el('span', 'sd-car-stats');
      stats.append(statBars('Launch', car.stats.launch), statBars('Grip', car.stats.grip), statBars('Drift', car.stats.drift));
      node.append(stats, el('span', 'sd-car-tag sd-label', open ? 'Selected' : 'Locked'));
      if (car.id === selected) primary = node;
      nodes.push(node);
      cards.append(node);
    }
    mark();
    // From a finish screen BACK leaves the finished run the way MENU does.
    const back = fromFinish ? act(callbacks.onQuit) : (): void => showMain('garage');
    const content = el('div', 'sd-screen');
    const note = el('p', 'sd-muted', 'Every car has the same top speed. Each one looks, sounds and slides its own way.');
    content.append(screenHead('Garage', back, 'Pick a car'), cards, note);
    show(
      {
        id: 'garage',
        content,
        primary: primary ?? nodes[0] ?? content,
        label: 'Garage',
        width: 'wide',
        confirmGuardMs: CONFIRM_GUARD_MS,
        back,
      },
      focusKey,
    );
  }

  function currentSettings(): Settings {
    return settings ? { ...settings } : { ...DEFAULT_SETTINGS };
  }

  function originBack(from: MenuOrigin, key: string): () => void {
    return from === 'pause' ? () => showPause(key) : () => showMain(key);
  }

  function showSettings(initial: Settings, from: MenuOrigin): void {
    settings = { ...initial };
    applyCalm(initial);
    const rows = settingsRows(initial, changeSettings);
    const back = originBack(from, 'settings');
    const content = el('div', 'sd-screen');
    content.append(screenHead('Settings', back, from === 'pause' ? 'Paused' : undefined), rows.node);
    const primary = rows.node.querySelector<HTMLElement>('[aria-pressed="true"]') ?? rows.node.querySelector<HTMLElement>('button, input') ?? content;
    show({
      id: 'settings',
      content,
      primary,
      label: 'Settings',
      width: 'narrow',
      confirmGuardMs: CONFIRM_GUARD_MS,
      back,
      setMuted: rows.setMuted,
      start: () => startRowFlicker(content, root, '.sd-setting'),
    });
  }

  function showControls(from: MenuOrigin): void {
    const back = originBack(from, 'controls');
    const content = el('div', 'sd-screen');
    content.append(screenHead('Controls', back, from === 'pause' ? 'Paused' : undefined), controlsTable());
    const primary = content.querySelector<HTMLElement>('.sd-btn-back') ?? content;
    show({
      id: 'controls',
      content,
      primary,
      label: 'Controls',
      width: 'wide',
      confirmGuardMs: CONFIRM_GUARD_MS,
      back,
      start: () => startRowFlicker(content, root, '.sd-row'),
    });
  }

  function showPause(focusKey?: string): void {
    const resume = button('Resume', act(callbacks.onResume), `${PRIMARY} sd-btn-big`, 'resume');
    const list = el('div', 'sd-main-list');
    list.append(
      resume,
      button('Restart', act(callbacks.onRestart), 'sd-btn-big', 'restart'),
      button('Settings', () => showSettings(currentSettings(), 'pause'), 'sd-btn-big', 'settings'),
      button('Controls', () => showControls('pause'), 'sd-btn-big', 'controls'),
      button('Quit to menu', act(callbacks.onQuit), 'sd-btn-big', 'quit'),
    );
    const content = el('div', 'sd-screen');
    content.append(heading('h1', 'sd-heading', 'Paused'), list);
    show(
      {
        id: 'pause',
        content,
        primary: resume,
        label: 'Paused',
        width: 'narrow',
        confirmGuardMs: CONFIRM_GUARD_MS,
        back: act(callbacks.onResume),
      },
      focusKey,
    );
  }

  function resultBadges(saved: { newHighScore: boolean } | null, newBest: boolean, bestText: string, tuned: boolean): HTMLElement {
    const row = el('div', 'sd-badges');
    if (tuned) row.append(badge('Tuned car — not saved', 'sd-badge-muted'));
    else {
      if (newBest) row.append(badge(bestText));
      if (saved?.newHighScore) row.append(badge('New high score', 'sd-badge-cyan'));
    }
    return row;
  }

  function rankLine(saved: { rank: number | null; failed?: true } | null, tuned: boolean): HTMLElement | null {
    if (tuned || !saved) return null;
    if (saved.failed) return el('p', 'sd-muted sd-rank', 'Could not save this run');
    return el('p', 'sd-muted sd-rank', saved.rank ? `${formatRank(saved.rank)} place on the board` : 'Outside the top five this time');
  }

  function showFinish(result: FinishResult): void {
    const head = el('div', 'sd-finish-head');
    head.append(el('p', 'sd-label', result.mode === 'level' ? 'Level complete' : 'Run complete'), heading('h1', 'sd-heading', result.trackName));
    const big = markGlitch(el('div', 'sd-num sd-finish-time', formatTime(result.ticks)), 'full', { text: formatTime(result.ticks) });
    const stats = el('dl', 'sd-stats');
    stats.append(
      stat('Score', formatScore(result.score), 'sd-strong'),
      stat('Peak multiplier', formatMultiplier(result.peakMultiplier)),
      stat('Falls / resets', `${result.falls} / ${result.resets}`),
    );
    const previous = result.previousBest;
    if (previous) {
      const delta = result.ticks - previous.ticks;
      stats.append(stat('Vs best', formatDelta(delta), delta < 0 ? 'sd-delta is-faster' : 'sd-delta is-slower'));
    }
    const rows: TableRow[] = result.highScores.map((rec) => ({ score: rec.score, detail: formatTime(rec.ticks), date: rec.date }));
    const table = scoreTable('High scores', 'Time', rows, result.tuned ? null : (result.saved?.rank ?? null));
    const retry = button('Retry', act(callbacks.onRestart), PRIMARY, 'retry');
    const actions = el('div', 'sd-actions sd-actions-row');
    actions.append(retry);
    const nextId = result.nextLevelId;
    if (nextId) actions.append(button('Next level', act(() => callbacks.onNextLevel(nextId)), '', 'next'));
    actions.append(button('Menu', act(callbacks.onQuit), '', 'menu'));
    const content = el('div', 'sd-screen');
    content.append(
      head,
      resultBadges(result.saved, result.saved?.newBestTime === true, 'New best time', result.tuned),
      big,
      stats,
    );
    const rank = rankLine(result.saved, result.tuned);
    if (rank) content.append(rank);
    const unlockedCars = result.unlockedCars ?? [];
    if (unlockedCars.length > 0) {
      const row = el('div', 'sd-badges sd-unlocks');
      for (const name of unlockedCars) row.append(badge(`New car unlocked: ${name}`, 'sd-badge-lime'));
      row.append(button('Garage', act(() => showGarage(true)), 'sd-btn-small', 'garage'));
      content.append(row);
    }
    content.append(table, actions);
    show({
      id: 'finish',
      content,
      primary: retry,
      label: 'Run complete',
      width: 'medium',
      confirmGuardMs: RESULT_CONFIRM_GUARD_MS,
      back: act(callbacks.onQuit),
    });
  }

  function showGameOver(result: GameOverResult): void {
    const head = el('div', 'sd-finish-head');
    head.append(el('p', 'sd-label', `Endless — ${result.difficulty}`));
    const headline = heading('h1', 'sd-over-title', DEATH_HEADLINES[result.cause]);
    headline.classList.toggle('is-off-road', result.cause === 'offTrack');
    const over = el('div', 'sd-over');
    over.append(headline, el('p', 'sd-label', DEATH_REASONS[result.cause]));
    const distance = formatDistance(result.distance);
    const big = markGlitch(el('div', 'sd-num sd-finish-time', distance), 'full', { text: distance });
    const stats = el('dl', 'sd-stats');
    stats.append(
      stat('Score', formatScore(result.score), 'sd-strong'),
      stat('Peak multiplier', formatMultiplier(result.peakMultiplier)),
      stat('Time', formatTime(result.ticks)),
    );
    const previous = result.previousBest;
    if (previous) {
      // `previous` is the record from before this run: once this run beat it, it is only the previous best.
      const label = result.saved?.newBestDistance ? 'Previous best' : 'Best distance';
      stats.append(stat(label, formatDistance(previous.distance)));
    }
    const rows: TableRow[] = result.highScores.map((rec) => ({ score: rec.score, detail: formatDistance(rec.distance), date: rec.date }));
    const table = scoreTable('High scores', 'Distance', rows, result.tuned ? null : (result.saved?.rank ?? null));
    const retry = button('Retry', act(callbacks.onRestart), PRIMARY, 'retry');
    const actions = el('div', 'sd-actions sd-actions-row');
    actions.append(retry, button('Menu', act(callbacks.onQuit), '', 'menu'));
    const content = el('div', 'sd-screen');
    content.append(
      head,
      over,
      resultBadges(result.saved, result.saved?.newBestDistance === true, 'New best distance', result.tuned),
      big,
      stats,
    );
    const rank = rankLine(result.saved, result.tuned);
    if (rank) content.append(rank);
    content.append(table, actions);
    show({
      id: 'gameover',
      content,
      primary: retry,
      label: 'Game over',
      width: 'medium',
      confirmGuardMs: RESULT_CONFIRM_GUARD_MS,
      back: act(callbacks.onQuit),
    });
  }

  // ---- Input --------------------------------------------------------------------------------------------------

  function nudgeSlider(slider: HTMLInputElement, dir: NavDir): void {
    // A keyboard arrow already moved it natively; this nav signal is the same key press seen by the game.
    if (performance.now() - lastNativeArrowAt < NATIVE_KEY_WINDOW_MS) return;
    const value = Math.max(0, Math.min(100, slider.valueAsNumber + (dir === 'right' ? SLIDER_STEP : -SLIDER_STEP)));
    if (value === slider.valueAsNumber) return;
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    sound('move');
  }

  return {
    setSettings(next) {
      settings = { ...next };
      applyCalm(next);
      current?.setMuted?.(next.muted);
    },
    setCatalog(next) {
      catalog = next;
    },
    showTitle,
    showMain: () => showMain(),
    showModeSelect: () => showModeSelect(),
    showLevelSelect: () => showLevelSelect(),
    showEndlessSelect,
    showWeekly: (weekId) => showWeekly(weekId ?? catalog.currentWeek),
    showHowTo: (firstTime) => showHowTo(firstTime),
    showGarage: () => showGarage(),
    showSettings,
    showControls,
    showPause: () => showPause(),
    showFinish,
    showGameOver,
    hide,
    get isOpen() {
      return current !== null;
    },
    get screen() {
      return current ? current.id : null;
    },
    back() {
      if (!current?.back) return false;
      sound('back');
      current.back();
      return true;
    },
    nav(dir) {
      if (!current || current.id === 'title') return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === 'range' && panel.contains(active) && (dir === 'left' || dir === 'right')) {
        nudgeSlider(active, dir);
        return;
      }
      if (moveFocus(panel, dir)) sound('move');
    },
    confirm() {
      if (!current || performance.now() < confirmBlockedUntil) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === 'range' && panel.contains(active)) return;
      const target = active instanceof HTMLElement && panel.contains(active) ? active : current.primary;
      target.click();
    },
    dispose() {
      hide();
      stopMuteListening();
      overlay.remove();
    },
  };
}
