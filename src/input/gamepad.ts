import type { InputState, MetaInput } from '../types';

export interface GamepadDevice {
  /** Held state as of the last poll. Neutral while no pad is connected. */
  readonly held: InputState;
  /** Edge flags that accumulate until the caller clears them. */
  readonly pressed: MetaInput;
  /** Refresh `held` and `pressed`. Returns true when the player touched the pad since the previous poll. */
  poll(): boolean;
}

const STICK_DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;
/** Share of the stick response that is linear; the rest is quadratic for finer control near the centre. */
const STICK_LINEARITY = 0.55;
/** How far an analogue value must move before it counts as the player using the pad. */
const ACTIVITY_DELTA = 0.1;
/** The pad cannot change faster than this, and several sim ticks may run in one frame. */
const MIN_POLL_INTERVAL_MS = 4;

const BUTTON_HANDBRAKE = 0;
const BUTTON_RESET = 3;
const BUTTON_BRAKE = 6;
const BUTTON_THROTTLE = 7;
const BUTTON_RESTART = 8;
const BUTTON_PAUSE = 9;

const BIT_HANDBRAKE = 1;
const BIT_RESET = 2;
const BIT_RESTART = 4;
const BIT_PAUSE = 8;

function shapeStick(raw: number): number {
  const magnitude = Math.abs(raw);
  if (!(magnitude > STICK_DEADZONE)) return 0;
  const m = Math.min(1, (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return Math.sign(raw) * m * (STICK_LINEARITY + (1 - STICK_LINEARITY) * m);
}

function shapeTrigger(button: GamepadButton | undefined): number {
  const value = button ? button.value : 0;
  if (!(value > TRIGGER_DEADZONE)) return 0;
  return Math.min(1, (value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));
}

function isDown(button: GamepadButton | undefined): boolean {
  return button !== undefined && button.pressed;
}

function buttonMask(buttons: readonly GamepadButton[]): number {
  return (
    (isDown(buttons[BUTTON_HANDBRAKE]) ? BIT_HANDBRAKE : 0) |
    (isDown(buttons[BUTTON_RESET]) ? BIT_RESET : 0) |
    (isDown(buttons[BUTTON_RESTART]) ? BIT_RESTART : 0) |
    (isDown(buttons[BUTTON_PAUSE]) ? BIT_PAUSE : 0)
  );
}

/** First connected pad, preferring one the browser could remap to the standard layout. */
function pickPad(pads: ArrayLike<Gamepad | null>): Gamepad | null {
  let fallback: Gamepad | null = null;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || !pad.connected) continue;
    if (pad.mapping === 'standard') return pad;
    fallback ??= pad;
  }
  return fallback;
}

export function createGamepad(target: Window): GamepadDevice {
  const held: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  const pressed: MetaInput = { pause: false, restart: false, toggleTuning: false, confirm: false };
  let available = typeof target.navigator?.getGamepads === 'function';
  let lastPollMs = -Infinity;
  let lastMask = 0;
  let seenSteer = 0;
  let seenThrottle = 0;
  let seenBrake = 0;

  function readPad(): Gamepad | null {
    try {
      return pickPad(target.navigator.getGamepads());
    } catch {
      // Blocked by permissions policy: the pad will never become readable on this page.
      available = false;
      return null;
    }
  }

  function release(): void {
    held.steer = 0;
    held.throttle = 0;
    held.brake = 0;
    held.handbrake = false;
    held.reset = false;
    lastMask = 0;
    seenSteer = 0;
    seenThrottle = 0;
    seenBrake = 0;
  }

  function analogueMoved(): boolean {
    const moved =
      Math.abs(held.steer - seenSteer) > ACTIVITY_DELTA ||
      Math.abs(held.throttle - seenThrottle) > ACTIVITY_DELTA ||
      Math.abs(held.brake - seenBrake) > ACTIVITY_DELTA;
    if (moved) {
      seenSteer = held.steer;
      seenThrottle = held.throttle;
      seenBrake = held.brake;
    }
    return moved;
  }

  function poll(): boolean {
    if (!available) return false;
    const nowMs = target.performance.now();
    if (nowMs - lastPollMs < MIN_POLL_INTERVAL_MS) return false;
    lastPollMs = nowMs;

    const pad = readPad();
    if (!pad) {
      release();
      return false;
    }

    const mask = buttonMask(pad.buttons);
    const justPressed = mask & ~lastMask;
    const buttonsChanged = mask !== lastMask;
    lastMask = mask;

    held.steer = shapeStick(pad.axes[0] ?? 0);
    held.throttle = shapeTrigger(pad.buttons[BUTTON_THROTTLE]);
    held.brake = shapeTrigger(pad.buttons[BUTTON_BRAKE]);
    held.handbrake = (mask & BIT_HANDBRAKE) !== 0;
    held.reset = (mask & BIT_RESET) !== 0;

    if (justPressed & BIT_PAUSE) pressed.pause = true;
    if (justPressed & BIT_RESTART) pressed.restart = true;
    // The handbrake button doubles as "confirm" in menus.
    if (justPressed & BIT_HANDBRAKE) pressed.confirm = true;

    return analogueMoved() || buttonsChanged;
  }

  return { held, pressed, poll };
}
