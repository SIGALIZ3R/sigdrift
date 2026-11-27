import { describe, expect, it } from 'vitest';
import { createInput } from '../../src/input/actions';
import { createGamepad } from '../../src/input/gamepad';

type Listener = (event: unknown) => void;

interface PadButton {
  pressed: boolean;
  value: number;
}

/** A window with key events, a clock, and (optionally) one standard-layout gamepad. */
class FakeWindow {
  private readonly listeners = new Map<string, Set<Listener>>();
  nowMs = 0;
  readonly performance = { now: (): number => this.nowMs };
  readonly buttons: PadButton[] = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  readonly navigator: { getGamepads?: () => unknown[] } = {};

  constructor(withPad: boolean) {
    if (withPad) {
      const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: this.buttons };
      this.navigator.getGamepads = () => [pad];
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  key(code: string, repeat = false): void {
    const event = {
      code,
      key: code,
      repeat,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      target: { tagName: 'BODY' },
      preventDefault: () => {},
    };
    for (const listener of this.listeners.get('keydown') ?? []) listener(event);
  }

  press(index: number, down: boolean): void {
    this.buttons[index].pressed = down;
    this.buttons[index].value = down ? 1 : 0;
    this.nowMs += 20;
  }
}

describe('input actions', () => {
  it('reports M as toggleMute for exactly one meta() call', () => {
    const win = new FakeWindow(false);
    const input = createInput(win as unknown as Window);
    expect(input.meta().toggleMute).toBe(false);
    win.key('KeyM');
    expect(input.meta()).toEqual({
      pause: false,
      restart: false,
      toggleTuning: false,
      confirm: false,
      toggleMute: true,
    });
    expect(input.meta().toggleMute).toBe(false);
    // Held down: auto-repeat is not a second press.
    win.key('KeyM', true);
    expect(input.meta().toggleMute).toBe(false);
    input.dispose();
  });

  it('keeps toggleMute apart from the other meta keys', () => {
    const win = new FakeWindow(false);
    const input = createInput(win as unknown as Window);
    win.key('KeyP');
    win.key('Enter');
    expect(input.meta()).toMatchObject({ pause: true, confirm: true, toggleMute: false });
    win.key('KeyM');
    win.key('Backspace');
    expect(input.meta()).toMatchObject({ pause: false, confirm: false, restart: true, toggleMute: true });
    input.dispose();
  });

  it('has no mute control on the gamepad: no button ever raises it', () => {
    const win = new FakeWindow(true);
    const pad = createGamepad(win as unknown as Window);
    expect(pad.pressed.toggleMute).toBe(false);
    for (let index = 0; index < win.buttons.length; index++) {
      win.press(index, true);
      pad.poll();
      win.press(index, false);
      pad.poll();
    }
    // The pad was read: its real controls did register.
    expect(pad.pressed).toMatchObject({ pause: true, restart: true, confirm: true });
    expect(pad.pressed.toggleMute).toBe(false);

    const input = createInput(win as unknown as Window);
    win.press(9, true);
    expect(input.meta()).toMatchObject({ pause: true, toggleMute: false });
    input.dispose();
  });
});
