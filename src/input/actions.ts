import type { InputState, MetaInput } from '../types';
import { createGamepad } from './gamepad';
import { createKeyboard } from './keyboard';

export type InputDevice = 'keyboard' | 'gamepad';

export interface GameInput {
  /** Current held state. Call once per sim tick. Returns a reused object. */
  sample(): InputState;
  /** Edge-triggered flags since the last call, then cleared. Returns a reused object. */
  meta(): MetaInput;
  readonly lastDevice: InputDevice;
  dispose(): void;
}

function largerMagnitude(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

export function createInput(target: Window): GameInput {
  let lastDevice: InputDevice = 'keyboard';
  const keyboard = createKeyboard(target, () => {
    lastDevice = 'keyboard';
  });
  const gamepad = createGamepad(target);
  const state: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  const flags: MetaInput = { pause: false, restart: false, toggleTuning: false, confirm: false, toggleMute: false };

  function pollGamepad(): void {
    if (gamepad.poll()) lastDevice = 'gamepad';
  }

  function take(flag: keyof MetaInput): void {
    flags[flag] = keyboard.pressed[flag] || gamepad.pressed[flag];
    keyboard.pressed[flag] = false;
    gamepad.pressed[flag] = false;
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
      return state;
    },
    meta() {
      pollGamepad();
      take('pause');
      take('restart');
      take('toggleTuning');
      take('confirm');
      take('toggleMute');
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
