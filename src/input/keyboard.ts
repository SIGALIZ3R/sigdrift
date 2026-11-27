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

/** Input types that are not text entry. They use a few keys themselves (arrows, Space) and nothing else. */
const CONTROL_INPUT_TYPES: ReadonlySet<string> = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'image',
]);

/**
 * What the key event's target does with keys of its own:
 * - `text`: typing goes into it, so the game takes nothing but Escape.
 * - `control`: a slider or switch. It needs the arrows and Space; menu keys (Enter, P, Backspace) still work, so
 *   a menu stays usable after its volume slider or assist switch has been clicked and kept focus.
 * - `button`: Space is its activation key and must reach it untouched.
 */
type TargetKind = 'none' | 'text' | 'control' | 'button';

function targetKind(target: EventTarget | null): TargetKind {
  const element = target as Partial<HTMLInputElement> | null;
  if (!element || typeof element.tagName !== 'string') return 'none';
  if (element.isContentEditable === true) return 'text';
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  if (tag === 'BUTTON') return 'button';
  if (tag !== 'INPUT') return 'none';
  const type = typeof element.type === 'string' ? element.type.toLowerCase() : 'text';
  return CONTROL_INPUT_TYPES.has(type) ? 'control' : 'text';
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

  function releaseAll(): void {
    down.clear();
    refreshHeld();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Browser shortcuts (Cmd+R, Alt+Left, ...) belong to the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const code = event.code;
    const kind = targetKind(event.target);
    // Escape still works from a form field: the pause menu must stay closable from the keyboard.
    if (kind === 'text' && code !== 'Escape') return;
    const metaFlag = META_CODES.get(code);
    // A slider or switch keeps the driving keys for itself, and a focused button keeps Space: cancelling that
    // keydown would stop the browser from clicking the button on release.
    const drives = DRIVE_CODES.has(code) && kind !== 'control' && !(kind === 'button' && code === 'Space');
    if (!drives && metaFlag === undefined) return;
    if (BLOCKED_DEFAULTS.has(code)) event.preventDefault();
    // Auto-repeat counts for held keys: a key that is still physically down after its state was dropped (window
    // blur, the Command key on macOS) comes back with its next repeat instead of staying dead until re-pressed.
    if (drives && !down.has(code)) {
      down.add(code);
      refreshHeld();
    }
    if (event.repeat) return;
    if (metaFlag !== undefined) pressed[metaFlag] = true;
    onActivity();
  }

  // Releases are always honoured, even while a form field has focus, so a key can never stick.
  function onKeyUp(event: KeyboardEvent): void {
    // macOS never delivers the keyup of a key released while Command is down, which would leave it stuck on.
    // When Command itself comes up, drop everything; keys that are really still held return by auto-repeat.
    if (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight') releaseAll();
    else if (down.delete(event.code)) refreshHeld();
  }

  function onBlur(): void {
    releaseAll();
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
