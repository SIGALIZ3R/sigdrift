import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accumulator, createFixedLoop } from '../../src/core/loop';

const DT = 1 / 120;

describe('Accumulator', () => {
  it('runs one step per dt of frame time', () => {
    const accumulator = new Accumulator(DT);
    expect(accumulator.advance(DT)).toBe(1);
    expect(accumulator.advance(2 * DT)).toBe(2);
    expect(accumulator.advance(0)).toBe(0);
    expect(accumulator.alpha).toBe(0);
  });

  it('carries the leftover into the next frame', () => {
    const accumulator = new Accumulator(0.25, 1);
    expect(accumulator.advance(0.125)).toBe(0);
    expect(accumulator.alpha).toBe(0.5);
    expect(accumulator.advance(0.125)).toBe(1);
    expect(accumulator.alpha).toBe(0);
    expect(accumulator.advance(0.375)).toBe(1);
    expect(accumulator.alpha).toBe(0.5);
  });

  it('runs two steps per frame at 60 Hz and one at 120 Hz', () => {
    const sixty = new Accumulator(DT);
    const oneTwenty = new Accumulator(DT);
    for (let frame = 0; frame < 600; frame++) {
      expect(sixty.advance(1 / 60)).toBe(2);
      expect(oneTwenty.advance(DT)).toBe(1);
    }
  });

  it('keeps the long-run step count in line with elapsed time', () => {
    const accumulator = new Accumulator(DT);
    const frameSeconds = 1 / 144;
    let steps = 0;
    for (let frame = 0; frame < 1440; frame++) {
      const now = accumulator.advance(frameSeconds);
      expect(now === 0 || now === 1).toBe(true);
      expect(accumulator.alpha).toBeGreaterThanOrEqual(0);
      expect(accumulator.alpha).toBeLessThan(1);
      steps += now;
    }
    // 10 seconds at 120 Hz.
    expect(Math.abs(steps - 1200)).toBeLessThanOrEqual(1);
  });

  it('clamps long frames to the default 0.1 s', () => {
    const accumulator = new Accumulator(0.025);
    expect(accumulator.advance(5)).toBe(4);
    expect(accumulator.alpha).toBe(0);
    expect(new Accumulator(DT).advance(5)).toBe(12);
  });

  it('clamps to a custom maximum', () => {
    const accumulator = new Accumulator(0.25, 1);
    expect(accumulator.advance(60)).toBe(4);
    expect(accumulator.alpha).toBe(0);
    expect(accumulator.advance(0.75)).toBe(3);
  });

  it('ignores negative and NaN frame times', () => {
    const accumulator = new Accumulator(0.25, 1);
    accumulator.advance(0.125);
    expect(accumulator.advance(-3)).toBe(0);
    expect(accumulator.advance(Number.NaN)).toBe(0);
    expect(accumulator.alpha).toBe(0.5);
  });

  it('reset drops the leftover', () => {
    const accumulator = new Accumulator(0.25, 1);
    accumulator.advance(0.2);
    expect(accumulator.alpha).toBeGreaterThan(0);
    accumulator.reset();
    expect(accumulator.alpha).toBe(0);
    expect(accumulator.advance(0.2)).toBe(0);
  });

  it('rejects a dt that could never finish a step', () => {
    expect(() => new Accumulator(0)).toThrow(RangeError);
    expect(() => new Accumulator(-1)).toThrow(RangeError);
    expect(() => new Accumulator(Number.NaN)).toThrow(RangeError);
    expect(() => new Accumulator(Infinity)).toThrow(RangeError);
  });
});

/** Minimal stand-ins for the browser clock, frame scheduler and document. */
function fakeBrowser() {
  let now = 1000;
  let nextHandle = 1;
  const frames = new Map<number, (time: number) => void>();
  const listeners = new Set<() => void>();
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    frames.set(nextHandle, callback);
    return nextHandle++;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));

  return {
    /** Advance the clock and run every pending frame callback once. */
    frame(elapsedMs: number): void {
      now += elapsedMs;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(now);
    },
    /** Pass time with the tab hidden (no frames), then show it again. */
    hideFor(elapsedMs: number): void {
      fakeDocument.visibilityState = 'hidden';
      for (const listener of listeners) listener();
      now += elapsedMs;
      fakeDocument.visibilityState = 'visible';
      for (const listener of listeners) listener();
    },
    pendingFrames: () => frames.size,
    listenerCount: () => listeners.size,
  };
}

describe('createFixedLoop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('steps at the fixed rate and renders once per frame', () => {
    const browser = fakeBrowser();
    let steps = 0;
    const renders: Array<[number, number]> = [];
    const loop = createFixedLoop({
      step: () => steps++,
      render: (alpha, frameSeconds) => renders.push([alpha, frameSeconds]),
      dt: 0.0625,
    });

    expect(loop.running).toBe(false);
    loop.start();
    expect(loop.running).toBe(true);

    browser.frame(31.25);
    expect(steps).toBe(0);
    browser.frame(31.25);
    expect(steps).toBe(1);
    browser.frame(625);
    // The simulation sees this long frame clamped to 0.1 s (one step and 0.0375 s over); render gets the real time.
    expect(steps).toBe(2);
    expect(renders.map(([, frameSeconds]) => frameSeconds)).toEqual([0.03125, 0.03125, 0.625]);
    expect(renders[0][0]).toBe(0.5);
    expect(renders[1][0]).toBe(0);
    expect(renders[2][0]).toBeCloseTo(0.6, 12);
  });

  it('stops requesting frames after stop and can start again', () => {
    const browser = fakeBrowser();
    let renders = 0;
    const loop = createFixedLoop({ step: () => {}, render: () => renders++, dt: DT });

    loop.start();
    loop.start();
    expect(browser.pendingFrames()).toBe(1);
    browser.frame(16);
    expect(renders).toBe(1);

    loop.stop();
    expect(loop.running).toBe(false);
    expect(browser.pendingFrames()).toBe(0);
    expect(browser.listenerCount()).toBe(0);
    browser.frame(16);
    expect(renders).toBe(1);

    loop.start();
    browser.frame(16);
    expect(renders).toBe(2);
  });

  it('does not simulate the time spent in a hidden tab', () => {
    const browser = fakeBrowser();
    let steps = 0;
    const loop = createFixedLoop({ step: () => steps++, render: () => {}, dt: 0.01 });

    loop.start();
    browser.frame(5);
    expect(steps).toBe(0);
    browser.hideFor(60000);
    browser.frame(5);
    // Without the reset, the 5 ms left over from before would complete a step here.
    expect(steps).toBe(0);
    browser.frame(5);
    expect(steps).toBe(1);
  });

  it('stops cleanly when a callback calls stop', () => {
    const browser = fakeBrowser();
    let steps = 0;
    let renders = 0;
    const loop = createFixedLoop({
      step: () => {
        steps++;
        loop.stop();
      },
      render: () => renders++,
      dt: 0.01,
    });

    loop.start();
    browser.frame(50);
    expect(steps).toBe(1);
    expect(renders).toBe(0);
    expect(browser.pendingFrames()).toBe(0);
  });
});
