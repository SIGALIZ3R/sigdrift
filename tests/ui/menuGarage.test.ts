// @vitest-environment happy-dom
/** The garage screen, the music slider and the unlock badge in the menus (menu.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVELS } from '../../src/gen/levels';
import { createMenu } from '../../src/ui/menu';
import type { FinishResult, Menu, MenuCallbacks } from '../../src/ui/menu';
import { DEFAULT_SETTINGS, markLevelCompleted } from '../../src/ui/storage';

let root: HTMLElement;
let menu: Menu;
let callbacks: { [K in keyof MenuCallbacks]-?: ReturnType<typeof vi.fn> };

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

function card(id: string): HTMLButtonElement {
  return q<HTMLButtonElement>(`.sd-car[data-key="${id}"]`);
}

function finish(overrides: Partial<FinishResult> = {}): FinishResult {
  return {
    mode: 'level',
    trackId: 'L3',
    trackName: 'Vertigo',
    ticks: 9000,
    score: 1200,
    peakMultiplier: 2,
    falls: 0,
    resets: 0,
    previousBest: null,
    saved: { newBestTime: true, newHighScore: true, rank: 1 },
    highScores: [],
    nextLevelId: 'L4',
    tuned: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  root = document.createElement('div');
  document.body.appendChild(root);
  callbacks = {
    onPlayWeekly: vi.fn(),
    onPlayLevel: vi.fn(),
    onPlayEndless: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onQuit: vi.fn(),
    onNextLevel: vi.fn(),
    onSelectCar: vi.fn(),
    onSettings: vi.fn(),
    onUiSound: vi.fn(),
  };
  menu = createMenu(root, callbacks as unknown as MenuCallbacks, { currentWeek: '2026-W48', pastWeeks: [], levels: LEVELS });
});

afterEach(() => {
  menu.dispose();
  root.remove();
  vi.unstubAllGlobals();
});

describe('garage', () => {
  it('is on the main menu', () => {
    menu.showMain();
    q('[data-key="garage"]').click();
    expect(menu.screen).toBe('garage');
  });

  it('shows the six cars, the stock car picked and the others locked for a new player', () => {
    menu.showGarage();
    expect([...root.querySelectorAll('.sd-car')].map((n) => (n as HTMLElement).dataset.key)).toEqual([
      'phantom',
      'viper',
      'brute',
      'ronin',
      'halo',
      'kaiju',
    ]);
    expect(root.querySelectorAll('.sd-car.is-locked')).toHaveLength(5);
    expect(card('ronin').textContent).toContain('Finish level 3 to unlock');
    expect(card('halo').textContent).toContain('Finish level 5 to unlock');
    expect(card('kaiju').textContent).toContain('Finish level 5 to unlock');
    expect(card('phantom').classList.contains('is-selected')).toBe(true);
    expect(card('phantom').getAttribute('aria-pressed')).toBe('true');
    expect(card('viper').classList.contains('is-locked')).toBe(true);
    expect(card('viper').textContent).toContain('Finish level 3 to unlock');
    expect(card('brute').textContent).toContain('Finish level 5 to unlock');
  });

  it('will not pick a locked car', () => {
    menu.showGarage();
    card('brute').click();
    expect(callbacks.onSelectCar).not.toHaveBeenCalled();
    expect(localStorage.getItem('sigdrift:car')).toBeNull();
    expect(card('phantom').classList.contains('is-selected')).toBe(true);
    // A locked card answers with the "back" blip, not "select".
    expect(callbacks.onUiSound).toHaveBeenLastCalledWith('back');
  });

  it('picks an unlocked car, remembers it and tells the game', () => {
    markLevelCompleted('L3');
    menu.showGarage();
    expect(card('viper').classList.contains('is-locked')).toBe(false);
    card('viper').click();
    expect(callbacks.onSelectCar).toHaveBeenCalledWith('viper');
    expect(JSON.parse(localStorage.getItem('sigdrift:car') ?? 'null')).toBe('viper');
    expect(card('viper').classList.contains('is-selected')).toBe(true);
    expect(card('phantom').classList.contains('is-selected')).toBe(false);
    // Picking the car already picked does nothing more.
    card('viper').click();
    expect(callbacks.onSelectCar).toHaveBeenCalledTimes(1);
  });

  it('opens on the picked car next time', () => {
    markLevelCompleted('L3');
    markLevelCompleted('L5');
    menu.showGarage();
    card('brute').click();
    menu.showMain();
    menu.showGarage();
    expect(card('brute').classList.contains('is-selected')).toBe(true);
  });

  it('goes back to the main menu', () => {
    menu.showGarage();
    expect(menu.back()).toBe(true);
    expect(menu.screen).toBe('main');
  });
});

describe('finish screen unlocks', () => {
  it('announces a new car and links to the garage, whose BACK leaves the run', () => {
    menu.showFinish(finish({ unlockedCars: ['Viper', 'Ronin'] }));
    expect(q('.sd-unlocks').textContent).toContain('New car unlocked: Viper');
    expect(q('.sd-unlocks').textContent).toContain('New car unlocked: Ronin');
    q('.sd-unlocks [data-key="garage"]').click();
    expect(menu.screen).toBe('garage');
    menu.back();
    expect(callbacks.onQuit).toHaveBeenCalled();
  });

  it('shows no unlock row when nothing was unlocked', () => {
    menu.showFinish(finish());
    expect(root.querySelector('.sd-unlocks')).toBeNull();
    menu.showFinish(finish({ unlockedCars: [] }));
    expect(root.querySelector('.sd-unlocks')).toBeNull();
  });
});

describe('music slider', () => {
  it('sits under Volume and reports its own level', () => {
    menu.showSettings({ ...DEFAULT_SETTINGS }, 'main');
    const labels = [...root.querySelectorAll('.sd-setting > span:first-child')].map((n) => n.textContent);
    expect(labels.indexOf('Music')).toBe(labels.indexOf('Volume') + 1);
    const music = q<HTMLInputElement>('input[aria-label="Music"]');
    expect(music.value).toBe('70');
    music.value = '25';
    music.dispatchEvent(new Event('input', { bubbles: true }));
    const last = callbacks.onSettings.mock.calls.at(-1)?.[0];
    expect(last.musicVolume).toBe(0.25);
    expect(last.volume).toBe(DEFAULT_SETTINGS.volume);
    expect(music.closest('.sd-setting')?.textContent).toContain('25%');
  });

  it('looks switched off along with Volume while muted', () => {
    menu.showSettings({ ...DEFAULT_SETTINGS, muted: true }, 'main');
    const row = q<HTMLInputElement>('input[aria-label="Music"]').closest('.sd-setting');
    expect(row?.classList.contains('is-off')).toBe(true);
  });

  it('moves with left / right while focused, like the volume slider', () => {
    menu.showSettings({ ...DEFAULT_SETTINGS }, 'main');
    const music = q<HTMLInputElement>('input[aria-label="Music"]');
    music.focus();
    menu.nav('left');
    expect(callbacks.onSettings.mock.calls.at(-1)?.[0].musicVolume).toBe(0.65);
  });
});

describe('controls screen', () => {
  it('lists the touch controls', () => {
    menu.showControls('main');
    const heads = [...root.querySelectorAll('.sd-controls th')].map((n) => n.textContent);
    expect(heads).toEqual(['Action', 'Keyboard', 'Gamepad', 'Touch']);
    expect(q('.sd-controls').textContent).toContain('GAS');
  });
});
