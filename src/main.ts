import { Game } from './game';
import { LEVELS, getLevelDef } from './gen/levels';
import { currentWeekId, parseWeekId } from './gen/weeklySeed';
import type { CarParams, Difficulty, EndlessMode, EndlessWorld, GameMode, GameRenderer, Level, RunMode, World } from './types';
import { DIFFICULTIES, loadEndlessDifficulty } from './ui/storage';

interface DebugHandle {
  readonly mode: GameMode;
  /** The weekly run or level, or null in endless mode. */
  readonly run: RunMode | null;
  /** The endless run, or null otherwise. */
  readonly endless: EndlessMode | null;
  readonly world: World | EndlessWorld;
  /** The level being driven or parked behind the menus, or null in endless mode. */
  readonly level: Level | null;
  params: CarParams;
  renderer: GameRenderer;
  /** The whole game, for driving its loop by hand in tests. */
  game: Game;
}

declare global {
  interface Window {
    __sigdrift?: DebugHandle;
  }
}

const MODES: readonly GameMode[] = ['weekly', 'level', 'endless'];

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`DriftNeo: the page has no #${id} element`);
  return element;
}

/** `?week=2026-W48` picks the week; anything that is not a real week falls back to today's. */
function chosenWeek(query: URLSearchParams): string {
  const requested = query.get('week');
  if (requested !== null) {
    if (parseWeekId(requested)) return requested;
    console.warn(`DriftNeo: ignoring ?week=${requested}, which is not an ISO week such as 2026-W48`);
  }
  return currentWeekId(new Date());
}

/** `?difficulty=hard` for an endless autostart; otherwise the one last picked in the menus. */
function chosenDifficulty(query: URLSearchParams): Difficulty {
  const requested = query.get('difficulty');
  const match = DIFFICULTIES.find((difficulty) => difficulty === requested);
  if (match) return match;
  if (requested !== null) {
    console.warn(`DriftNeo: ignoring ?difficulty=${requested}; it can be ${DIFFICULTIES.join(', ')}`);
  }
  return loadEndlessDifficulty();
}

/** `?mode=weekly|level|endless`; `?level=L3` alone implies level mode. Default: weekly. */
function chosenMode(query: URLSearchParams): GameMode {
  const requested = query.get('mode');
  const match = MODES.find((mode) => mode === requested);
  if (match) return match;
  if (requested !== null) console.warn(`DriftNeo: ignoring ?mode=${requested}; it can be ${MODES.join(', ')}`);
  return query.get('level') !== null ? 'level' : 'weekly';
}

/** `?level=L3` (case-insensitive); otherwise the first level. */
function chosenLevel(query: URLSearchParams): string {
  const requested = query.get('level');
  if (requested !== null) {
    const def = getLevelDef(requested.toUpperCase());
    if (def) return def.id;
    console.warn(`DriftNeo: ignoring ?level=${requested}; it can be ${LEVELS.map((d) => d.id).join(', ')}`);
  }
  return LEVELS[0].id;
}

function exposeForDebugging(game: Game): void {
  window.__sigdrift = {
    get mode() {
      return game.mode;
    },
    get run() {
      return game.run;
    },
    get endless() {
      return game.endless;
    },
    get world() {
      return game.world;
    },
    get level() {
      return game.currentLevel;
    },
    params: game.params,
    renderer: game.renderer,
    game,
  };
}

/** A plain message that does not depend on the game's stylesheet or on WebGL. */
function showBootError(ui: HTMLElement, error: unknown): void {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:12px;padding:24px;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#e8ecff;background:#05060d;';
  const title = document.createElement('strong');
  title.textContent = 'DriftNeo could not start';
  const detail = document.createElement('span');
  detail.style.maxWidth = '34em';
  detail.textContent = error instanceof Error ? error.message : String(error);
  box.append(title, detail);
  ui.replaceChildren(box);
}

function boot(): void {
  const ui = requireElement('ui');
  try {
    const query = new URLSearchParams(window.location.search);
    const weekId = chosenWeek(query);
    // `?seed=abc` gives every endless run the same road. `?autostart=1` skips the menus into the chosen mode.
    const game = new Game({ app: requireElement('app'), ui, weekId, endlessSeed: query.get('seed') });
    if (import.meta.env.DEV) exposeForDebugging(game);
    if (query.get('autostart') !== '1') {
      game.showTitle();
    } else {
      const mode = chosenMode(query);
      if (mode === 'endless') game.playEndless(chosenDifficulty(query));
      else if (mode === 'level') game.playLevel(chosenLevel(query));
      else game.playWeekly(weekId);
    }
    game.start();
  } catch (error) {
    console.error(error);
    showBootError(ui, error);
  }
}

boot();
