import type { InputState, MetaInput } from '../types';

export interface KeyboardDevice {
  /** Current held state, kept up to date by key events. */
  readonly held: InputState;
  /** Edge flags that accumulate until the caller clears them. */
  readonly pressed: MetaInput;
  dispose(): void;
}

const DRIVE_CODES: ReadonlySet<string> = new Set([
  'KeyA',
  'KeyD',
  'KeyW',
  'KeyS',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'KeyR',
]);

const META_CODES: ReadonlyMap<string, keyof MetaInput> = new Map([
  ['Escape', 'pause'],
  ['KeyP', 'pause'],
  ['Backspace', 'restart'],
  ['Enter', 'confirm'],
  ['Backquote', 'toggleTuning'],
]);

/** Keys whose browser default would scroll the page or navigate back. */
const BLOCKED_DEFAULTS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'Backspace',
]);

const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isEditing(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return EDITABLE_TAGS.has(element.tagName.toUpperCase()) || element.isContentEditable === true;
}

/** `onActivity` fires for every fresh press of a key the game uses. */
export function createKeyboard(target: Window, onActivity: () => void): KeyboardDevice {
  const down = new Set<string>();
  const held: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  const pressed: MetaInput = { pause: false, restart: false, toggleTuning: false, confirm: false };

  function either(a: string, b: string): number {
    return down.has(a) || down.has(b) ? 1 : 0;
  }

  function refreshHeld(): void {
    held.steer = either('KeyD', 'ArrowRight') - either('KeyA', 'ArrowLeft');
    held.throttle = either('KeyW', 'ArrowUp');
    held.brake = either('KeyS', 'ArrowDown');
    held.handbrake = down.has('Space');
    held.reset = down.has('KeyR');
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Browser shortcuts (Cmd+R, Alt+Left, ...) belong to the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const code = event.code;
    // Escape still works from a form field: a menu's slider or switch keeps focus once clicked, and the
    // pause menu must stay closable from the keyboard.
    if (code !== 'Escape' && isEditing(event.target)) return;
    const metaFlag = META_CODES.get(code);
    const drives = DRIVE_CODES.has(code);
    if (!drives && metaFlag === undefined) return;
    if (BLOCKED_DEFAULTS.has(code)) event.preventDefault();
    if (event.repeat) return;
    if (drives) {
      down.add(code);
      refreshHeld();
    }
    if (metaFlag !== undefined) pressed[metaFlag] = true;
    onActivity();
  }

  // Releases are always honoured, even while a form field has focus, so a key can never stick.
  function onKeyUp(event: KeyboardEvent): void {
    if (down.delete(event.code)) refreshHeld();
  }

  function onBlur(): void {
    down.clear();
    refreshHeld();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    held,
    pressed,
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      onBlur();
    },
  };
}
