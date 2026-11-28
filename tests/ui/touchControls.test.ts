// @vitest-environment happy-dom
/** The on-screen touch controls (touchControls.ts) and how createInput merges them with the keyboard. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInput } from '../../src/input/actions';
import { createTouchControls, padSteer } from '../../src/ui/touchControls';
import type { TouchControls } from '../../src/ui/touchControls';

function touch(node: Element, type: string, pointerId: number, clientX = 0): void {
  node.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId, clientX, clientY: 0, bubbles: true, cancelable: true }));
}

/** Pretends the pad sits at x 100..300 on screen. */
function placePad(pad: HTMLElement): void {
  pad.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 80, right: 300, bottom: 80, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
}

let root: HTMLElement;
let controls: TouchControls;

function q(selector: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  controls?.dispose();
  root.remove();
  vi.unstubAllGlobals();
});

describe('padSteer', () => {
  it('steers nothing in the dead zone and full lock from 60% out', () => {
    expect(padSteer(200, 100, 200)).toBe(0);
    expect(padSteer(205, 100, 200)).toBe(0);
    expect(padSteer(260, 100, 200)).toBe(1);
    expect(padSteer(300, 100, 200)).toBe(1);
    expect(padSteer(100, 100, 200)).toBe(-1);
    expect(padSteer(400, 100, 200)).toBe(1);
  });

  it('is proportional in between and symmetric', () => {
    const right = padSteer(235, 100, 200);
    expect(right).toBeGreaterThan(0);
    expect(right).toBeLessThan(1);
    expect(padSteer(165, 100, 200)).toBeCloseTo(-right);
  });

  it('is zero for a pad with no size (hidden)', () => {
    expect(padSteer(150, 0, 0)).toBe(0);
  });
});

describe('touch controls', () => {
  it('stay hidden on a mouse-and-keyboard device until the screen is touched', () => {
    controls = createTouchControls(root, window);
    controls.setDriving(true);
    expect(controls.enabled).toBe(false);
    expect(q('.sd-touch').classList.contains('sd-hidden')).toBe(true);
    touch(document.body, 'pointerdown', 1);
    expect(controls.enabled).toBe(true);
    expect(q('.sd-touch').classList.contains('sd-hidden')).toBe(false);
    expect(root.classList.contains('sd-touch-on')).toBe(true);
  });

  it('start enabled on a phone (coarse pointer) but only show while driving', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    controls = createTouchControls(root, window);
    expect(controls.enabled).toBe(true);
    expect(q('.sd-touch').classList.contains('sd-hidden')).toBe(true);
    controls.setDriving(true);
    expect(q('.sd-touch').classList.contains('sd-hidden')).toBe(false);
  });

  it('ignore mouse clicks for switching on', () => {
    controls = createTouchControls(root, window);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    expect(controls.enabled).toBe(false);
  });

  it('hand back to the keyboard on a key press', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    controls = createTouchControls(root, window);
    controls.setDriving(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(controls.enabled).toBe(false);
    expect(q('.sd-touch').classList.contains('sd-hidden')).toBe(true);
    expect(root.classList.contains('sd-touch-on')).toBe(false);
  });

  describe('while driving', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      controls = createTouchControls(root, window);
      controls.setDriving(true);
      placePad(q('.sd-touch-pad'));
    });

    it('hold GAS, BRAKE and DRIFT for as long as a finger is down', () => {
      touch(q('.sd-touch-gas'), 'pointerdown', 1);
      touch(q('.sd-touch-brake'), 'pointerdown', 2);
      touch(q('.sd-touch-drift'), 'pointerdown', 3);
      expect(controls.held).toMatchObject({ throttle: 1, brake: 1, handbrake: true });
      expect(q('.sd-touch-gas').classList.contains('is-held')).toBe(true);
      touch(q('.sd-touch-gas'), 'pointerup', 1);
      touch(q('.sd-touch-brake'), 'pointercancel', 2);
      touch(q('.sd-touch-drift'), 'pointerup', 3);
      expect(controls.held).toMatchObject({ throttle: 0, brake: 0, handbrake: false });
    });

    it('keep GAS held while a second finger on it lifts', () => {
      touch(q('.sd-touch-gas'), 'pointerdown', 1);
      touch(q('.sd-touch-gas'), 'pointerdown', 2);
      touch(q('.sd-touch-gas'), 'pointerup', 2);
      expect(controls.held.throttle).toBe(1);
      touch(q('.sd-touch-gas'), 'pointerup', 1);
      expect(controls.held.throttle).toBe(0);
    });

    it('steer by where the finger is on the pad, following a slide', () => {
      const pad = q('.sd-touch-pad');
      touch(pad, 'pointerdown', 5, 290);
      expect(controls.held.steer).toBe(1);
      touch(pad, 'pointermove', 5, 110);
      expect(controls.held.steer).toBe(-1);
      touch(pad, 'pointermove', 5, 200);
      expect(controls.held.steer).toBe(0);
      touch(pad, 'pointerup', 5, 200);
      expect(controls.held.steer).toBe(0);
    });

    it('ignore pad moves from a finger that is not on the pad', () => {
      touch(q('.sd-touch-pad'), 'pointermove', 9, 290);
      expect(controls.held.steer).toBe(0);
    });

    it('raise pause as an edge flag and hold reset only while pressed', () => {
      touch(q('.sd-touch-pause'), 'pointerdown', 1);
      expect(controls.pressed.pause).toBe(true);
      touch(q('.sd-touch-reset'), 'pointerdown', 2);
      expect(controls.held.reset).toBe(true);
      touch(q('.sd-touch-reset'), 'pointerup', 2);
      expect(controls.held.reset).toBe(false);
    });

    it('let go of everything when driving stops or the window loses focus', () => {
      touch(q('.sd-touch-gas'), 'pointerdown', 1);
      touch(q('.sd-touch-pad'), 'pointerdown', 2, 290);
      controls.setDriving(false);
      expect(controls.held).toMatchObject({ steer: 0, throttle: 0, handbrake: false });
      expect(root.querySelectorAll('.is-held')).toHaveLength(0);
      controls.setDriving(true);
      touch(q('.sd-touch-drift'), 'pointerdown', 3);
      window.dispatchEvent(new Event('blur'));
      expect(controls.held.handbrake).toBe(false);
    });

    it('are removed from the page by dispose()', () => {
      controls.dispose();
      expect(root.querySelector('.sd-touch')).toBeNull();
      expect(root.classList.contains('sd-touch-on')).toBe(false);
    });
  });
});

describe('createInput with touch', () => {
  it('merges touch with the keyboard and names touch as the device in use', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    controls = createTouchControls(root, window);
    controls.setDriving(true);
    placePad(q('.sd-touch-pad'));
    const input = createInput(window, controls);
    expect(input.sample().throttle).toBe(0);
    touch(q('.sd-touch-gas'), 'pointerdown', 1);
    touch(q('.sd-touch-pad'), 'pointerdown', 2, 120);
    const state = input.sample();
    expect(state.throttle).toBe(1);
    expect(state.steer).toBe(-1);
    expect(input.lastDevice).toBe('touch');
    input.dispose();
  });

  it('passes the pause button through meta() once', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    controls = createTouchControls(root, window);
    controls.setDriving(true);
    const input = createInput(window, controls);
    touch(q('.sd-touch-pause'), 'pointerdown', 1);
    expect(input.meta().pause).toBe(true);
    expect(input.meta().pause).toBe(false);
    input.dispose();
  });
});
