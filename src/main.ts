import { Game } from './game';
import type { GameMode } from './game';
import { currentWeekId, parseWeekId } from './gen/weeklySeed';
import type { CarParams, Difficulty, EndlessMode, EndlessWorld, GameRenderer, Level, RunMode, World } from './types';
import { DIFFICULTIES, loadEndlessDifficulty } from './ui/storage';

interface DebugHandle {
  readonly mode: GameMode;
  /** The weekly run, or null in endless mode. */
  readonly run: RunMode | null;
  /** The endless run, or null in a weekly run. */
  readonly endless: EndlessMode | null;
  readonly world: World | EndlessWorld;
  /** The weekly level, or null in endless mode. */
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

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`SigDRIFT: the page has no #${id} element`);
  return element;
}

/** `?week=2026-W48` picks the week; anything that is not a real week falls back to today's. */
function chosenWeek(query: URLSearchParams): string {
  const requested = query.get('week');
  if (requested !== null) {
    if (parseWeekId(requested)) return requested;
    console.warn(`SigDRIFT: ignoring ?week=${requested}, which is not an ISO week such as 2026-W48`);
  }
  return currentWeekId(new Date());
}

/** `?difficulty=hard` for an endless autostart; otherwise the one last picked on the title screen. */
function chosenDifficulty(query: URLSearchParams): Difficulty {
  const requested = query.get('difficulty');
  const match = DIFFICULTIES.find((difficulty) => difficulty === requested);
  if (match) return match;
  if (requested !== null) {
    console.warn(`SigDRIFT: ignoring ?difficulty=${requested}; it can be ${DIFFICULTIES.join(', ')}`);
  }
  return loadEndlessDifficulty();
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
  title.textContent = 'SigDRIFT could not start';
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
    // `?seed=abc` gives every endless run the same road. `?mode=endless&autostart=1` skips the title into one.
    const game = new Game({ app: requireElement('app'), ui, weekId, endlessSeed: query.get('seed') });
    if (import.meta.env.DEV) exposeForDebugging(game);
    if (query.get('autostart') !== '1') game.showTitle();
    else if (query.get('mode') === 'endless') game.playEndless(chosenDifficulty(query));
    else game.play(weekId);
    game.start();
  } catch (error) {
    console.error(error);
    showBootError(ui, error);
  }
}

boot();
