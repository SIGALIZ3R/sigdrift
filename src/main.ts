import { Game } from './game';
import { currentWeekId, parseWeekId } from './gen/weeklySeed';
import type { GameRenderer, Level, CarParams, RunMode, World } from './types';

interface DebugHandle {
  readonly run: RunMode;
  readonly world: World;
  readonly level: Level;
  params: CarParams;
  renderer: GameRenderer;
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

function exposeForDebugging(game: Game): void {
  window.__sigdrift = {
    get run() {
      return game.run;
    },
    get world() {
      return game.world;
    },
    get level() {
      return game.level;
    },
    params: game.params,
    renderer: game.renderer,
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
    const game = new Game({ app: requireElement('app'), ui, weekId });
    if (import.meta.env.DEV) exposeForDebugging(game);
    if (query.get('autostart') === '1') game.play(weekId);
    else game.showTitle();
    game.start();
  } catch (error) {
    console.error(error);
    showBootError(ui, error);
  }
}

boot();
