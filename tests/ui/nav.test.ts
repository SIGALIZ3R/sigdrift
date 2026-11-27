import { describe, expect, it } from 'vitest';
import { listIndex, nextIndex, spatialIndex } from '../../src/ui/nav';
import type { NavRect } from '../../src/ui/nav';

function box(left: number, top: number, width = 100, height = 40): NavRect {
  return { left, top, width, height };
}

/** A vertical list of four buttons, like the main menu. */
const column = [box(0, 0), box(0, 50), box(0, 100), box(0, 150)];
/** Three cards side by side above a back button on the left. */
const grid = [box(0, 0, 40, 30), box(0, 50, 100, 120), box(110, 50, 100, 120), box(220, 50, 100, 120)];

describe('listIndex', () => {
  it('steps and wraps', () => {
    expect(listIndex(4, 0, 'down')).toBe(1);
    expect(listIndex(4, 3, 'down')).toBe(0);
    expect(listIndex(4, 0, 'up')).toBe(3);
    expect(listIndex(4, 2, 'left')).toBe(1);
    expect(listIndex(4, 2, 'right')).toBe(3);
  });

  it('starts at an end when nothing is focused, and is -1 for an empty list', () => {
    expect(listIndex(4, -1, 'down')).toBe(0);
    expect(listIndex(4, -1, 'up')).toBe(3);
    expect(listIndex(0, -1, 'down')).toBe(-1);
  });
});

describe('spatialIndex', () => {
  it('moves along a column', () => {
    expect(spatialIndex(column, 0, 'down')).toBe(1);
    expect(spatialIndex(column, 2, 'up')).toBe(1);
  });

  it('finds nothing beyond the ends', () => {
    expect(spatialIndex(column, 3, 'down')).toBe(-1);
    expect(spatialIndex(column, 0, 'up')).toBe(-1);
    expect(spatialIndex(column, 1, 'left')).toBe(-1);
  });

  it('moves across a row of cards', () => {
    expect(spatialIndex(grid, 1, 'right')).toBe(2);
    expect(spatialIndex(grid, 2, 'right')).toBe(3);
    expect(spatialIndex(grid, 3, 'left')).toBe(2);
  });

  it('prefers what is in line over what is nearer but off to the side', () => {
    // From the right-hand card, up goes to the back button (the only thing above).
    expect(spatialIndex(grid, 3, 'up')).toBe(0);
    // From the back button, down goes to the card straight beneath it, not the others.
    expect(spatialIndex(grid, 0, 'down')).toBe(1);
  });

  it('treats items level with each other as not beyond', () => {
    const row = [box(0, 0), box(120, 2)];
    expect(spatialIndex(row, 0, 'down')).toBe(-1);
    expect(spatialIndex(row, 0, 'right')).toBe(1);
  });

  it('skips empty boxes', () => {
    const rects = [box(0, 0), box(0, 50, 0, 0), box(0, 100)];
    expect(spatialIndex(rects, 0, 'down')).toBe(2);
  });
});

describe('nextIndex', () => {
  it('wraps round in list order when nothing lies that way', () => {
    expect(nextIndex(column, 3, 'down')).toBe(0);
    expect(nextIndex(column, 0, 'up')).toBe(3);
    expect(nextIndex(column, 1, 'right')).toBe(2);
  });

  it('goes to the first control when nothing is focused', () => {
    expect(nextIndex(column, -1, 'down')).toBe(0);
    expect(nextIndex(column, 99, 'right')).toBe(0);
    expect(nextIndex(column, -1, 'up')).toBe(3);
  });

  it('is -1 only without controls, and stays put with a single one', () => {
    expect(nextIndex([], 0, 'down')).toBe(-1);
    expect(nextIndex([box(0, 0)], 0, 'down')).toBe(0);
  });

  it('always lands on a valid index', () => {
    for (const rects of [column, grid]) {
      for (let from = -1; from < rects.length; from++) {
        for (const dir of ['up', 'down', 'left', 'right'] as const) {
          const to = nextIndex(rects, from, dir);
          expect(to).toBeGreaterThanOrEqual(0);
          expect(to).toBeLessThan(rects.length);
        }
      }
    }
  });
});
