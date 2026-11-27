import { describe, expect, it } from 'vitest';
import type { InputState, Level, World } from '../../src/types';
import { DT } from '../../src/types';
import { hashNumbers } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';
import { cloneParams } from '../../src/sim/params';
import { PLANTED_PARAMS as DEFAULT_CAR_PARAMS, plantedParams } from '../helpers/testCar';
import {
  BRAKE_STEPS,
  STEER_STEPS,
  THROTTLE_STEPS,
  decodeInput,
  encodeInput,
  quantizeInput,
  runReplay,
} from '../../src/sim/replay';
import { createWorld } from '../../src/sim/world';
import { makeOpenLevel } from '../helpers/handLevel';

/** Small enough that a random driver keeps hitting the walls and the pillars. */
const LEVEL: Level = {
  ...makeOpenLevel(160),
  props: [
    { kind: 'pillar', x: 30, z: 6, y: 0, radius: 1.5, height: 4, hue: 0 },
    { kind: 'pillar', x: -20, z: -25, y: 0, radius: 2.5, height: 4, hue: 1 },
    { kind: 'pillar', x: 10, z: 40, y: 0, radius: 1, height: 4, hue: 2 },
  ],
};

function input(partial: Partial<InputState>): InputState {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, ...partial };
}

/** Raw analogue input as a gamepad would give it, changing a few times a second. */
function randomInputs(seed: string, ticks: number): InputState[] {
  const rng = new Rng(seed);
  const inputs: InputState[] = [];
  let held = input({});
  for (let i = 0; i < ticks; i++) {
    if (i % 40 === 0) {
      held = input({
        steer: rng.range(-1, 1),
        throttle: rng.chance(0.85) ? rng.next() : 0,
        brake: rng.chance(0.15) ? rng.next() : 0,
        handbrake: rng.chance(0.15),
        reset: rng.chance(0.02),
      });
    }
    inputs.push(held);
  }
  return inputs;
}

function drive(inputs: readonly InputState[]): { world: World; contacts: number } {
  const world = createWorld(LEVEL, plantedParams());
  let contacts = 0;
  for (const raw of inputs) {
    world.step(quantizeInput(raw));
    if (world.lastCollision) contacts++;
  }
  return { world, contacts };
}

describe('quantizeInput', () => {
  it('snaps each axis to its grid', () => {
    const q = quantizeInput(input({ steer: 0.5, throttle: 0.5, brake: 0.5 }));
    expect(q.steer).toBe(Math.round(0.5 * STEER_STEPS) / STEER_STEPS);
    expect(q.throttle).toBe(Math.round(0.5 * THROTTLE_STEPS) / THROTTLE_STEPS);
    expect(q.brake).toBe(Math.round(0.5 * BRAKE_STEPS) / BRAKE_STEPS);
  });

  it('keeps the values a keyboard produces exactly', () => {
    for (const steer of [-1, 0, 1]) {
      for (const pedal of [0, 1]) {
        const raw = input({ steer, throttle: pedal, brake: 1 - pedal, handbrake: pedal === 1, reset: pedal === 0 });
        expect(quantizeInput(raw)).toEqual(raw);
      }
    }
  });

  it('is idempotent', () => {
    for (const raw of randomInputs('idempotent', 4000)) {
      const once = quantizeInput(raw);
      expect(quantizeInput(once)).toEqual(once);
    }
  });

  it('moves no axis by more than half a step', () => {
    for (const raw of randomInputs('half-step', 4000)) {
      const q = quantizeInput(raw);
      expect(Math.abs(q.steer - raw.steer)).toBeLessThanOrEqual(0.5 / STEER_STEPS + 1e-12);
      expect(Math.abs(q.throttle - raw.throttle)).toBeLessThanOrEqual(0.5 / THROTTLE_STEPS + 1e-12);
      expect(Math.abs(q.brake - raw.brake)).toBeLessThanOrEqual(0.5 / BRAKE_STEPS + 1e-12);
    }
  });

  it('limits out-of-range values and treats garbage as centred', () => {
    expect(quantizeInput(input({ steer: 7, throttle: 3, brake: -2 }))).toEqual(input({ steer: 1, throttle: 1 }));
    expect(quantizeInput(input({ steer: -7 })).steer).toBe(-1);
    expect(quantizeInput(input({ steer: NaN, throttle: NaN, brake: NaN }))).toEqual(input({}));
  });

  it('never produces a negative zero', () => {
    const q = quantizeInput(input({ steer: -0.001 }));
    expect(Object.is(q.steer, 0)).toBe(true);
  });
});

describe('encodeInput / decodeInput', () => {
  it('fits in 16 bits', () => {
    for (const raw of randomInputs('16-bit', 4000)) {
      const code = encodeInput(raw);
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(0xffff);
    }
    const everything = input({ steer: 1, throttle: 1, brake: 1, handbrake: true, reset: true });
    expect(encodeInput(everything)).toBeLessThanOrEqual(0xffff);
  });

  it('round-trips every quantized input', () => {
    for (const raw of randomInputs('round-trip', 4000)) {
      const q = quantizeInput(raw);
      expect(decodeInput(encodeInput(q))).toEqual(q);
    }
  });

  it('round-trips every code that encodeInput can produce', () => {
    const seen = new Set<number>();
    for (let code = 0; code <= 0xffff; code++) {
      const again = encodeInput(decodeInput(code));
      seen.add(again);
      // The one steering value the encoder never emits decodes to full right lock.
      if ((code & 0x7f) <= 2 * STEER_STEPS) expect(again).toBe(code);
    }
    expect(seen.size).toBe((2 * STEER_STEPS + 1) * (THROTTLE_STEPS + 1) * (BRAKE_STEPS + 1) * 4);
  });

  it('gives distinct inputs distinct codes', () => {
    const a = encodeInput(input({ steer: 1 / STEER_STEPS }));
    const b = encodeInput(input({ steer: 2 / STEER_STEPS }));
    const c = encodeInput(input({ handbrake: true }));
    const d = encodeInput(input({ reset: true }));
    expect(new Set([a, b, c, d, encodeInput(input({}))]).size).toBe(5);
  });
});

describe('determinism', () => {
  const inputs = randomInputs('replay', Math.round(40 / DT));

  it('gives the same state hash for the same inputs', () => {
    const first = drive(inputs);
    const second = drive(inputs);
    // The run is only a meaningful check if it exercised collisions too.
    expect(first.contacts).toBeGreaterThan(20);
    expect(first.world.tick).toBe(inputs.length);
    expect(hashNumbers(second.world.snapshot())).toBe(hashNumbers(first.world.snapshot()));
  });

  it('gives a different hash when one input differs', () => {
    const altered = inputs.slice();
    altered[100] = input({ ...altered[100], steer: -altered[100].steer || 1 });
    expect(hashNumbers(drive(altered).world.snapshot())).not.toBe(hashNumbers(drive(inputs).world.snapshot()));
  });

  it('reproduces a recorded run from its codes', () => {
    const live = createWorld(LEVEL, plantedParams());
    const codes: number[] = [];
    const hashes: string[] = [];
    for (const raw of inputs) {
      const q = quantizeInput(raw);
      codes.push(encodeInput(q));
      live.step(q);
      if (live.tick % 600 === 0) hashes.push(hashNumbers(live.snapshot()));
    }

    const replayed = runReplay(LEVEL, DEFAULT_CAR_PARAMS, codes);
    expect(replayed.tick).toBe(codes.length);
    expect(replayed.snapshot()).toEqual(live.snapshot());
    expect(hashNumbers(replayed.snapshot())).toBe(hashNumbers(live.snapshot()));

    // Every prefix matches as well, not just the end state.
    const prefixes = hashes.map((_, i) => {
      const partial = runReplay(LEVEL, DEFAULT_CAR_PARAMS, codes.slice(0, (i + 1) * 600));
      return hashNumbers(partial.snapshot());
    });
    expect(prefixes).toEqual(hashes);
  });

  it('survives the codes being stored as 16-bit integers', () => {
    const codes = inputs.map(encodeInput);
    const stored = Array.from(new Uint16Array(codes));
    expect(stored).toEqual(codes);
  });

  it('replays with the given tuning without touching it', () => {
    const tuned = cloneParams(DEFAULT_CAR_PARAMS);
    tuned.engineForce = 5000;
    const before = { ...tuned };
    const codes = inputs.slice(0, 1200).map(encodeInput);
    const slow = runReplay(LEVEL, tuned, codes);
    const stock = runReplay(LEVEL, DEFAULT_CAR_PARAMS, codes);
    expect(tuned).toEqual(before);
    expect(slow.params).not.toBe(tuned);
    expect(hashNumbers(slow.snapshot())).not.toBe(hashNumbers(stock.snapshot()));
  });
});
