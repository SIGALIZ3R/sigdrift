/** Small browser helpers for game.ts: renderer start-up, pixel-density changes, fresh seeds. */
import { createRenderer } from './render/renderer';
import type { GameRenderer, Settings } from './types';

const WEBGL_MESSAGE =
  'SigDRIFT needs WebGL 2, which this browser or device could not provide. ' +
  'Try a current browser with hardware acceleration switched on.';

/** The renderer, or an error whose message the boot screen can show as it is. */
export function openRenderer(app: HTMLElement, settings: Settings): GameRenderer {
  try {
    return createRenderer(app, settings);
  } catch (cause) {
    throw new Error(WEBGL_MESSAGE, { cause });
  }
}

/** A road nobody has driven before. Only ever used as a generator seed, so any unpredictable string will do. */
export function randomSeed(): string {
  const words = new Uint32Array(2);
  try {
    globalThis.crypto.getRandomValues(words);
  } catch {
    words[0] = Math.random() * 0x100000000;
    words[1] = Math.random() * 0x100000000;
  }
  return words[0].toString(36) + words[1].toString(36);
}

/** Calls `onChange` whenever the window moves to a screen with a different pixel density, or the page is zoomed. */
export function watchPixelRatio(onChange: () => void): void {
  const listen = (): void => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        onChange();
        listen();
      },
      { once: true },
    );
  };
  listen();
}

/**
 * Keys that start the game from the title screen by themselves (through the window listener). Enter and Space are
 * left to the focused PRESS ENTER button, M mutes, and modifiers, Tab and function keys belong to the browser.
 */
export function startsFromTitle(event: KeyboardEvent): boolean {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
  const code = event.code;
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || code === 'KeyM' || code === 'Tab') return false;
  if (/^(Shift|Control|Alt|Meta|OS|CapsLock|ContextMenu|F\d+$)/.test(code)) return false;
  return code !== '';
}
