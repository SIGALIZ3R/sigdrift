import type { InputState, MetaInput } from '../types';
import { createGamepad } from './gamepad';
import { createKeyboard, createMetaInput } from './keyboard';

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

/** Any other control surface (the on-screen touch controls): held state plus edge flags the input takes and clears. */
export interface InputSource {
  readonly held: InputState;
  readonly pressed: MetaInput;
}

export interface GameInput {
  /** Current held state. Call once per sim tick. Returns a reused object. */
  sample(): InputState;
  /**
   * Edge-triggered flags since the last call, then cleared. Returns a reused object.
   *
   * Some physical controls raise more than one flag; the game picks the one that fits the screen it is on:
   * - Escape raises both `pause` and `back`; Backspace raises both `restart` and `back`. In a menu, treat either as
   *   `back` (and ignore `pause` / `restart`); while driving, use `pause` / `restart` and ignore `back`.
   * - The arrows and W/A/S/D (keyboard) and the d-pad (gamepad) drive the car through sample() AND raise the nav
   *   flags here. Use the nav flags only while a menu is open. Holding a key or the d-pad / left stick repeats the nav
   *   flag (keyboard: the OS auto-repeat; gamepad: after 400 ms, every 120 ms).
   * - Gamepad A (button 0) is both the handbrake and `confirm`; gamepad B (button 1) is `back`.
   */
  meta(): MetaInput;
  readonly lastDevice: InputDevice;
  dispose(): void;
}

function largerMagnitude(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

export function createInput(target: Window, extra?: InputSource): GameInput {
  let lastDevice: InputDevice = 'keyboard';
  const keyboard = createKeyboard(target, () => {
    lastDevice = 'keyboard';
  });
  const gamepad = createGamepad(target);
  const state: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  const flags: MetaInput = createMetaInput();

  function pollGamepad(): void {
    if (gamepad.poll()) lastDevice = 'gamepad';
  }

  function take(flag: keyof MetaInput): void {
    flags[flag] = keyboard.pressed[flag] || gamepad.pressed[flag] || (extra?.pressed[flag] ?? false);
    keyboard.pressed[flag] = false;
    gamepad.pressed[flag] = false;
    if (extra) extra.pressed[flag] = false;
  }

  /** Touch counts as the device in use while any of its controls is held. */
  function noteExtra(): void {
    if (!extra) return;
    const h = extra.held;
    if (h.steer !== 0 || h.throttle > 0 || h.brake > 0 || h.handbrake || h.reset) lastDevice = 'touch';
  }

  return {
    sample() {
      pollGamepad();
      const keys = keyboard.held;
      const pad = gamepad.held;
      state.steer = largerMagnitude(keys.steer, pad.steer);
      state.throttle = Math.max(keys.throttle, pad.throttle);
      state.brake = Math.max(keys.brake, pad.brake);
      state.handbrake = keys.handbrake || pad.handbrake;
      state.reset = keys.reset || pad.reset;
      if (extra) {
        noteExtra();
        const touch = extra.held;
        state.steer = largerMagnitude(state.steer, touch.steer);
        state.throttle = Math.max(state.throttle, touch.throttle);
        state.brake = Math.max(state.brake, touch.brake);
        state.handbrake = state.handbrake || touch.handbrake;
        state.reset = state.reset || touch.reset;
      }
      return state;
    },
    meta() {
      pollGamepad();
      take('pause');
      take('restart');
      take('toggleTuning');
      take('confirm');
      take('toggleMute');
      take('navUp');
      take('navDown');
      take('navLeft');
      take('navRight');
      take('back');
      return flags;
    },
    get lastDevice() {
      return lastDevice;
    },
    dispose() {
      keyboard.dispose();
    },
  };
}
