import type { InputState, MetaInput } from '../types';
import { createMetaInput } from './keyboard';

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

/** Menu navigation repeats after a direction has been held this long, ms... */
export const NAV_REPEAT_DELAY_MS = 400;
/** ...and then every this many ms. */
export const NAV_REPEAT_INTERVAL_MS = 120;
/** The left stick counts as a nav flick past this deflection, and lets go again below NAV_STICK_RELEASE. */
export const NAV_STICK_PRESS = 0.5;
export const NAV_STICK_RELEASE = 0.35;

const BUTTON_HANDBRAKE = 0;
const BUTTON_BACK = 1;
const BUTTON_RESET = 3;
const BUTTON_BRAKE = 6;
const BUTTON_THROTTLE = 7;
const BUTTON_RESTART = 8;
const BUTTON_PAUSE = 9;
const BUTTON_UP = 12;
const BUTTON_DOWN = 13;
const BUTTON_LEFT = 14;
const BUTTON_RIGHT = 15;

const BIT_HANDBRAKE = 1;
const BIT_RESET = 2;
const BIT_RESTART = 4;
const BIT_PAUSE = 8;
const BIT_BACK = 16;
const BIT_UP = 32;
const BIT_DOWN = 64;
const BIT_LEFT = 128;
const BIT_RIGHT = 256;

/** Nav directions in a fixed order: up, down, left, right. */
const NAV_FLAGS = ['navUp', 'navDown', 'navLeft', 'navRight'] as const;
const NAV_BITS: readonly number[] = [BIT_UP, BIT_DOWN, BIT_LEFT, BIT_RIGHT];

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
    (isDown(buttons[BUTTON_PAUSE]) ? BIT_PAUSE : 0) |
    (isDown(buttons[BUTTON_BACK]) ? BIT_BACK : 0) |
    (isDown(buttons[BUTTON_UP]) ? BIT_UP : 0) |
    (isDown(buttons[BUTTON_DOWN]) ? BIT_DOWN : 0) |
    (isDown(buttons[BUTTON_LEFT]) ? BIT_LEFT : 0) |
    (isDown(buttons[BUTTON_RIGHT]) ? BIT_RIGHT : 0)
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
  // The pad has no mute control: `toggleMute` stays false.
  const pressed: MetaInput = createMetaInput();
  let available = typeof target.navigator?.getGamepads === 'function';
  let lastPollMs = -Infinity;
  let lastMask = 0;
  let seenSteer = 0;
  let seenThrottle = 0;
  let seenBrake = 0;
  /** Which way the left stick is flicked for menu purposes: a mask of the NAV bits, at most one per axis. */
  let stickMask = 0;
  /** Per nav direction: when it next repeats (ms), or -1 while it is not held. */
  const navNextMs = [-1, -1, -1, -1];

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
    stickMask = 0;
    for (let i = 0; i < navNextMs.length; i++) navNextMs[i] = -1;
  }

  /**
   * The stick as a d-pad. Only the dominant axis counts when it is first pushed, so a sloppy diagonal is one
   * direction; once a direction is engaged it holds until the stick comes back under NAV_STICK_RELEASE.
   */
  function readStick(x: number, y: number): number {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    let mask = 0;
    const horizontal = stickMask & (BIT_LEFT | BIT_RIGHT);
    if (horizontal !== 0 && ax > NAV_STICK_RELEASE && Math.sign(x) === (horizontal === BIT_RIGHT ? 1 : -1)) {
      mask |= horizontal;
    } else if (ax > NAV_STICK_PRESS && ax >= ay) {
      mask |= x > 0 ? BIT_RIGHT : BIT_LEFT;
    }
    const vertical = stickMask & (BIT_UP | BIT_DOWN);
    if (vertical !== 0 && ay > NAV_STICK_RELEASE && Math.sign(y) === (vertical === BIT_DOWN ? 1 : -1)) {
      mask |= vertical;
    } else if (ay > NAV_STICK_PRESS && ay > ax) {
      // Gamepad Y axes point down.
      mask |= y > 0 ? BIT_DOWN : BIT_UP;
    }
    return mask;
  }

  /** Raise a nav edge when a direction is first held, then again after the repeat delay and at the repeat rate. */
  function updateNav(held: number, nowMs: number): boolean {
    let raised = false;
    for (let i = 0; i < NAV_BITS.length; i++) {
      if ((held & NAV_BITS[i]) === 0) {
        navNextMs[i] = -1;
        continue;
      }
      if (navNextMs[i] < 0) {
        navNextMs[i] = nowMs + NAV_REPEAT_DELAY_MS;
      } else if (nowMs >= navNextMs[i]) {
        // From now, not from when it was due: a stalled frame must not release a burst of repeats.
        navNextMs[i] = nowMs + NAV_REPEAT_INTERVAL_MS;
      } else {
        continue;
      }
      pressed[NAV_FLAGS[i]] = true;
      raised = true;
    }
    return raised;
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
    if (justPressed & BIT_BACK) pressed.back = true;

    stickMask = readStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const navRaised = updateNav(mask | stickMask, nowMs);

    return analogueMoved() || buttonsChanged || navRaised;
  }

  return { held, pressed, poll };
}
