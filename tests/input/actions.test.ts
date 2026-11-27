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
  readonly axes: number[] = [0, 0, 0, 0];
  readonly navigator: { getGamepads?: () => unknown[] } = {};

  constructor(withPad: boolean) {
    if (withPad) {
      const pad = { connected: true, mapping: 'standard', axes: this.axes, buttons: this.buttons };
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
      navUp: false,
      navDown: false,
      navLeft: false,
      navRight: false,
      back: false,
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

  it('passes the nav and back flags through meta() once each, from keyboard and pad alike', () => {
    const win = new FakeWindow(true);
    const input = createInput(win as unknown as Window);
    win.key('ArrowDown');
    win.key('KeyA');
    expect(input.meta()).toMatchObject({ navDown: true, navLeft: true, navUp: false, navRight: false, back: false });
    expect(input.meta()).toMatchObject({ navDown: false, navLeft: false });
    win.key('Escape');
    expect(input.meta()).toMatchObject({ back: true, pause: true });
    expect(input.meta().back).toBe(false);
    win.press(1, true);
    expect(input.meta()).toMatchObject({ back: true, pause: false });
    win.press(1, false);
    win.press(12, true);
    expect(input.meta()).toMatchObject({ navUp: true, back: false });
    expect(input.meta().navUp).toBe(false);
    input.dispose();
  });
});

describe('gamepad menu navigation', () => {
  function setup() {
    const win = new FakeWindow(true);
    const pad = createGamepad(win as unknown as Window);
    /** Advance the clock by `ms`, poll, and return (and clear) the nav flags raised. */
    const step = (ms: number): string[] => {
      win.nowMs += ms;
      pad.poll();
      const raised: string[] = [];
      for (const flag of ['navUp', 'navDown', 'navLeft', 'navRight', 'back'] as const) {
        if (pad.pressed[flag]) raised.push(flag);
        pad.pressed[flag] = false;
      }
      return raised;
    };
    return { win, pad, step };
  }

  it.each([
    [12, 'navUp'],
    [13, 'navDown'],
    [14, 'navLeft'],
    [15, 'navRight'],
  ])('d-pad button %i raises %s once per press', (button, flag) => {
    const { win, step } = setup();
    win.buttons[button].pressed = true;
    expect(step(16)).toEqual([flag]);
    expect(step(16)).toEqual([]);
    win.buttons[button].pressed = false;
    expect(step(16)).toEqual([]);
    win.buttons[button].pressed = true;
    expect(step(16)).toEqual([flag]);
  });

  it('repeats a held direction after 400 ms, then every 120 ms, and stops on release', () => {
    const { win, step } = setup();
    win.buttons[13].pressed = true;
    const times: number[] = [];
    for (let t = 16; t <= 1000; t += 16) if (step(16).includes('navDown')) times.push(t);
    // First press at 16 ms; repeats from 416 ms; then every ~120 ms (a frame late at most).
    expect(times[0]).toBe(16);
    expect(times[1]).toBeGreaterThanOrEqual(416);
    expect(times[1]).toBeLessThan(416 + 16);
    for (let i = 2; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(120);
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(120 + 16);
    }
    expect(times.length).toBeGreaterThanOrEqual(6);
    win.buttons[13].pressed = false;
    for (let i = 0; i < 40; i++) expect(step(16)).toEqual([]);
  });

  it('does not release a burst of repeats after a stalled frame', () => {
    const { win, step } = setup();
    win.buttons[15].pressed = true;
    step(16);
    expect(step(2000)).toEqual(['navRight']);
    expect(step(16)).toEqual([]);
  });

  it('turns left-stick flicks into nav edges, using the dominant axis and a release threshold', () => {
    const { win, step } = setup();
    win.axes[1] = -0.9;
    expect(step(16)).toEqual(['navUp']);
    // Easing off to 0.4 keeps the direction held: no new edge.
    win.axes[1] = -0.4;
    expect(step(16)).toEqual([]);
    win.axes[1] = 0;
    expect(step(16)).toEqual([]);
    win.axes[1] = 0.8;
    expect(step(16)).toEqual(['navDown']);
    win.axes[1] = 0;
    step(16);
    // A sloppy diagonal is one direction: the bigger one.
    win.axes[0] = 0.9;
    win.axes[1] = 0.6;
    expect(step(16)).toEqual(['navRight']);
    win.axes[0] = 0;
    win.axes[1] = 0;
    step(16);
    // Small wobbles are not flicks.
    win.axes[0] = 0.45;
    expect(step(16)).toEqual([]);
    win.axes[0] = -0.7;
    expect(step(16)).toEqual(['navLeft']);
  });

  it('repeats a held stick like a held d-pad', () => {
    const { win, step } = setup();
    win.axes[0] = 1;
    let count = 0;
    for (let t = 0; t < 1000; t += 16) if (step(16).includes('navRight')) count++;
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it('B (button 1) is back, and only back', () => {
    const { win, pad, step } = setup();
    win.buttons[1].pressed = true;
    expect(step(16)).toEqual(['back']);
    expect(pad.pressed).toMatchObject({ confirm: false, pause: false, restart: false });
    expect(pad.held).toMatchObject({ handbrake: false, reset: false, throttle: 0, brake: 0 });
    expect(step(16)).toEqual([]);
  });

  it('counts menu navigation as using the pad, and forgets held directions when the pad goes away', () => {
    const { win, pad, step } = setup();
    win.nowMs += 16;
    pad.poll();
    win.buttons[12].pressed = true;
    win.nowMs += 16;
    expect(pad.poll()).toBe(true);
    pad.pressed.navUp = false;
    // Unplugged and plugged back in with the button still down: that is a fresh press.
    const getPads = win.navigator.getGamepads;
    win.navigator.getGamepads = () => [];
    step(16);
    win.navigator.getGamepads = getPads;
    expect(step(16)).toEqual(['navUp']);
  });
});
