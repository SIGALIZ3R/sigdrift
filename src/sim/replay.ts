/**
 * Input quantisation and replays.
 *
 * A run is reproducible only if the simulation is fed exactly what was recorded, so input is snapped to a small
 * grid before it reaches the simulation and each tick is stored as one 16-bit code:
 *
 *   bits 0-6   steer + 63      (-63..63 sixty-thirds of full lock)
 *   bits 7-10  throttle        (0..15 fifteenths)
 *   bits 11-13 brake           (0..7 sevenths)
 *   bit  14    handbrake
 *   bit  15    reset
 */
import type { CarParams, InputState, Level, World } from '../types';
import { cloneParams } from './params';
import { createWorld } from './world';

export const STEER_STEPS = 63;
export const THROTTLE_STEPS = 15;
export const BRAKE_STEPS = 7;

const STEER_MASK = 0x7f;
const THROTTLE_SHIFT = 7;
const THROTTLE_MASK = 0xf;
const BRAKE_SHIFT = 11;
const BRAKE_MASK = 0x7;
const HANDBRAKE_BIT = 1 << 14;
const RESET_BIT = 1 << 15;

/** Nearest whole step of `value * steps`, limited to lo..hi. Anything that is not a number counts as 0. */
function toSteps(value: number, steps: number, lo: number, hi: number): number {
  const rounded = Math.round(value * steps);
  return rounded >= lo && rounded <= hi ? rounded : rounded > hi ? hi : rounded < lo ? lo : 0;
}

export function encodeInput(input: InputState): number {
  return (
    (toSteps(input.steer, STEER_STEPS, -STEER_STEPS, STEER_STEPS) + STEER_STEPS) |
    (toSteps(input.throttle, THROTTLE_STEPS, 0, THROTTLE_STEPS) << THROTTLE_SHIFT) |
    (toSteps(input.brake, BRAKE_STEPS, 0, BRAKE_STEPS) << BRAKE_SHIFT) |
    (input.handbrake ? HANDBRAKE_BIT : 0) |
    (input.reset ? RESET_BIT : 0)
  );
}

function decodeInto(code: number, input: InputState): void {
  const steerSteps = Math.min(code & STEER_MASK, 2 * STEER_STEPS) - STEER_STEPS;
  const throttleSteps = (code >> THROTTLE_SHIFT) & THROTTLE_MASK;
  const brakeSteps = (code >> BRAKE_SHIFT) & BRAKE_MASK;
  // 0 / n is +0 for positive n, so a centred stick decodes to +0, never -0.
  input.steer = steerSteps / STEER_STEPS;
  input.throttle = throttleSteps / THROTTLE_STEPS;
  input.brake = brakeSteps / BRAKE_STEPS;
  input.handbrake = (code & HANDBRAKE_BIT) !== 0;
  input.reset = (code & RESET_BIT) !== 0;
}

export function decodeInput(code: number): InputState {
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  decodeInto(code, input);
  return input;
}

/** The input the simulation should actually be stepped with: exactly what `encodeInput` can store. */
export function quantizeInput(input: InputState): InputState {
  return decodeInput(encodeInput(input));
}

/** Replays recorded codes on a fresh world with its own copy of `params`, one step per code. */
export function runReplay(level: Level, params: CarParams, codes: readonly number[]): World {
  const world = createWorld(level, cloneParams(params));
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  for (let i = 0; i < codes.length; i++) {
    decodeInto(codes[i], input);
    world.step(input);
  }
  return world;
}
