import { describe, expect, it } from 'vitest';
import { createKeyboard } from '../../src/input/keyboard';

type Listener = (event: unknown) => void;

/** Just enough of a window for the keyboard device: it only ever adds and removes listeners. */
class FakeWindow {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface KeyOptions {
  target?: { tagName: string; type?: string; isContentEditable?: boolean };
  repeat?: boolean;
  metaKey?: boolean;
  key?: string;
}

function setup() {
  const win = new FakeWindow();
  let activity = 0;
  const keyboard = createKeyboard(win as unknown as Window, () => activity++);
  const send = (type: 'keydown' | 'keyup', code: string, options: KeyOptions = {}): { prevented: boolean } => {
    const result = { prevented: false };
    win.dispatch(type, {
      code,
      key: options.key ?? code,
      repeat: options.repeat ?? false,
      ctrlKey: false,
      altKey: false,
      metaKey: options.metaKey ?? false,
      target: options.target ?? { tagName: 'BODY' },
      preventDefault: () => {
        result.prevented = true;
      },
    });
    return result;
  };
  return { win, keyboard, send, activity: () => activity };
}

const BUTTON = { tagName: 'BUTTON', type: 'button' };
const CHECKBOX = { tagName: 'INPUT', type: 'checkbox' };
const RANGE = { tagName: 'INPUT', type: 'range' };
const TEXT = { tagName: 'INPUT', type: 'text' };

describe('keyboard', () => {
  it('maps the driving keys to held input and releases them on keyup', () => {
    const { keyboard, send } = setup();
    send('keydown', 'KeyW');
    send('keydown', 'KeyD');
    send('keydown', 'Space');
    expect(keyboard.held).toMatchObject({ throttle: 1, steer: 1, handbrake: true });
    send('keyup', 'KeyD');
    send('keydown', 'ArrowLeft');
    expect(keyboard.held.steer).toBe(-1);
    send('keyup', 'KeyW');
    send('keyup', 'Space');
    expect(keyboard.held).toMatchObject({ throttle: 0, handbrake: false });
  });

  it('stops Space and the arrows from scrolling the page while driving', () => {
    const { send } = setup();
    expect(send('keydown', 'Space').prevented).toBe(true);
    expect(send('keydown', 'ArrowDown').prevented).toBe(true);
    expect(send('keydown', 'KeyW').prevented).toBe(false);
  });

  it.each([
    ['a switch', CHECKBOX],
    ['a slider', RANGE],
  ])('keeps the menu keys working while %s has focus', (_name, target) => {
    const { keyboard, send } = setup();
    send('keydown', 'Enter', { target });
    send('keydown', 'KeyP', { target });
    send('keydown', 'Backspace', { target });
    expect(keyboard.pressed).toMatchObject({ confirm: true, pause: true, restart: true });
  });

  it('leaves the keys a slider or switch uses to that control', () => {
    const { keyboard, send } = setup();
    expect(send('keydown', 'ArrowRight', { target: RANGE }).prevented).toBe(false);
    expect(send('keydown', 'Space', { target: CHECKBOX }).prevented).toBe(false);
    expect(keyboard.held).toMatchObject({ steer: 0, handbrake: false });
  });

  it('takes nothing but Escape from a text field', () => {
    const { keyboard, send } = setup();
    send('keydown', 'Enter', { target: TEXT });
    send('keydown', 'KeyW', { target: TEXT });
    send('keydown', 'Backspace', { target: { tagName: 'TEXTAREA' } });
    send('keydown', 'KeyP', { target: { tagName: 'DIV', isContentEditable: true } });
    expect(keyboard.pressed).toMatchObject({ confirm: false, pause: false, restart: false });
    expect(keyboard.held.throttle).toBe(0);
    send('keydown', 'Escape', { target: TEXT });
    expect(keyboard.pressed.pause).toBe(true);
  });

  it('raises toggleMute once per press of M, in menus and while driving', () => {
    const { keyboard, send, activity } = setup();
    expect(keyboard.pressed.toggleMute).toBe(false);
    // While driving: other keys are held and stay held.
    send('keydown', 'KeyW');
    const before = activity();
    expect(send('keydown', 'KeyM').prevented).toBe(false);
    expect(keyboard.pressed.toggleMute).toBe(true);
    expect(keyboard.held.throttle).toBe(1);
    expect(activity()).toBe(before + 1);
    // The flag is an edge: once the caller clears it, holding the key (auto-repeat) does not raise it again.
    keyboard.pressed.toggleMute = false;
    send('keydown', 'KeyM', { repeat: true });
    expect(keyboard.pressed.toggleMute).toBe(false);
    send('keyup', 'KeyM');
    expect(keyboard.pressed.toggleMute).toBe(false);
    send('keydown', 'KeyM');
    expect(keyboard.pressed.toggleMute).toBe(true);
    // M touches no other flag and no driving input.
    expect(keyboard.pressed).toMatchObject({ pause: false, restart: false, confirm: false, toggleTuning: false });
    expect(keyboard.held).toMatchObject({ steer: 0, brake: 0, handbrake: false, reset: false });
  });

  it.each([
    ['a button', BUTTON],
    ['a switch', CHECKBOX],
    ['a slider', RANGE],
  ])('still mutes with M while %s has focus', (_name, target) => {
    const { keyboard, send } = setup();
    send('keydown', 'KeyM', { target });
    expect(keyboard.pressed.toggleMute).toBe(true);
  });

  it.each([
    ['a text input', TEXT],
    ['an input with no type', { tagName: 'INPUT' }],
    ['a textarea', { tagName: 'TEXTAREA' }],
    ['a select', { tagName: 'SELECT' }],
    ['editable content', { tagName: 'DIV', isContentEditable: true }],
  ])('ignores M while typing in %s', (_name, target) => {
    const { keyboard, send, activity } = setup();
    send('keydown', 'KeyM', { target });
    expect(keyboard.pressed.toggleMute).toBe(false);
    expect(activity()).toBe(0);
  });

  it('leaves Cmd+M and Ctrl+M to the browser', () => {
    const { keyboard, send } = setup();
    send('keydown', 'KeyM', { metaKey: true });
    expect(keyboard.pressed.toggleMute).toBe(false);
  });

  it('lets Space reach a focused button so the browser can click it', () => {
    const { keyboard, send } = setup();
    expect(send('keydown', 'Space', { target: BUTTON }).prevented).toBe(false);
    expect(keyboard.held.handbrake).toBe(false);
    // Enter still confirms, and the other driving keys are unaffected.
    send('keydown', 'Enter', { target: BUTTON });
    send('keydown', 'KeyW', { target: BUTTON });
    expect(keyboard.pressed.confirm).toBe(true);
    expect(keyboard.held.throttle).toBe(1);
  });

  it('drops every held key when the window loses focus, and restores one that is still down on its next repeat', () => {
    const { win, keyboard, send, activity } = setup();
    send('keydown', 'KeyW');
    win.dispatch('blur');
    expect(keyboard.held.throttle).toBe(0);
    const before = activity();
    send('keydown', 'KeyW', { repeat: true });
    expect(keyboard.held.throttle).toBe(1);
    // A repeat is not a fresh press: no activity, and no menu key edge.
    expect(activity()).toBe(before);
    send('keydown', 'Enter', { repeat: true });
    expect(keyboard.pressed.confirm).toBe(false);
  });

  it('does not leave a key stuck when macOS swallows its keyup under Command', () => {
    const { keyboard, send } = setup();
    send('keydown', 'KeyW');
    send('keydown', 'KeyD');
    send('keydown', 'MetaLeft', { key: 'Meta', metaKey: true });
    // W is released here, but with Command down the browser never hears about it. D stays held.
    send('keydown', 'KeyD', { repeat: true, metaKey: true });
    send('keyup', 'MetaLeft', { key: 'Meta' });
    expect(keyboard.held).toMatchObject({ throttle: 0, steer: 0 });
    send('keydown', 'KeyD', { repeat: true });
    expect(keyboard.held).toMatchObject({ throttle: 0, steer: 1 });
  });

  it('releases everything and stops listening when disposed', () => {
    const { keyboard, send } = setup();
    send('keydown', 'KeyW');
    keyboard.dispose();
    expect(keyboard.held.throttle).toBe(0);
    send('keydown', 'KeyW');
    expect(keyboard.held.throttle).toBe(0);
  });
});
