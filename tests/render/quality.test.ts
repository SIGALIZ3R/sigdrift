import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, ResolutionWatchdog, budgetPixelRatio } from '../../src/render/quality';

describe('pixel budget', () => {
  it('leaves ordinary windows at the ratio that was asked for', () => {
    expect(budgetPixelRatio(1920, 1080, 1)).toBe(1);
    expect(budgetPixelRatio(1280, 720, 2)).toBe(2);
    expect(budgetPixelRatio(2560, 1440, 1)).toBe(1);
  });

  it.each([
    ['4K at 150% scaling', 2560, 1440, 1.5],
    ['4K at 100%', 3840, 2160, 1],
    ['a 5K retina panel', 2560, 1440, 2],
    ['an ultrawide', 3440, 1440, 1],
  ])('never draws more than the budget for %s', (_name, width, height, wanted) => {
    const ratio = budgetPixelRatio(width, height, wanted);
    expect(ratio).toBeLessThan(wanted);
    expect(width * height * ratio * ratio).toBeLessThanOrEqual(MAX_PIXELS * 1.000001);
    expect(width * height * ratio * ratio).toBeGreaterThan(MAX_PIXELS * 0.999);
  });

  it('survives a window with no size', () => {
    expect(budgetPixelRatio(0, 0, 2)).toBe(2);
  });
});

describe('resolution watchdog', () => {
  /** Feeds `count` frames; `frameTime` may depend on the watchdog's current scale. Returns how often it changed. */
  function feed(dog: ResolutionWatchdog, count: number, frameTime: (scale: number) => number): number {
    let changes = 0;
    for (let i = 0; i < count; i++) if (dog.frame(frameTime(dog.scale))) changes++;
    return changes;
  }

  it('leaves a fast machine alone', () => {
    const dog = new ResolutionWatchdog();
    expect(feed(dog, 2000, () => 1 / 60)).toBe(0);
    expect(dog.scale).toBe(1);
  });

  it('steps the resolution down while frames are slow and pixels are the reason', () => {
    const dog = new ResolutionWatchdog();
    // Fill-rate bound: 30 ms at full resolution, falling with the pixel count.
    feed(dog, 2000, (scale) => 0.03 * scale * scale);
    expect(dog.scale).toBeLessThan(1);
    expect(dog.scale).toBeGreaterThan(0.5);
    // It stopped as soon as the frame time was back under 20 ms, not at the floor.
    expect(0.03 * dog.scale * dog.scale).toBeLessThan(1 / 50);
    expect(dog.scale).toBeGreaterThan(0.7);
  });

  it('never goes below about half resolution', () => {
    const dog = new ResolutionWatchdog();
    const changes = feed(dog, 5000, (scale) => 0.08 * scale * scale);
    expect(changes).toBe(3);
    expect(dog.scale).toBeCloseTo(0.512, 9);
  });

  it('undoes its step and gives up when lower resolution does not help (30 Hz display, throttled tab)', () => {
    const dog = new ResolutionWatchdog();
    expect(feed(dog, 5000, () => 1 / 30)).toBe(2);
    expect(dog.scale).toBe(1);
  });

  it('ignores paused frames and stalls', () => {
    const dog = new ResolutionWatchdog();
    expect(feed(dog, 3000, (_scale) => 0)).toBe(0);
    expect(feed(dog, 3000, (_scale) => 0.1)).toBe(0);
    expect(dog.scale).toBe(1);
  });

  it('starts again from full resolution after a reset', () => {
    const dog = new ResolutionWatchdog();
    feed(dog, 2000, (scale) => 0.03 * scale * scale);
    dog.reset();
    expect(dog.scale).toBe(1);
    expect(feed(dog, 2000, () => 1 / 60)).toBe(0);
  });
});
