/**
 * On-screen driving controls for phones and tablets.
 *
 *   [❚❚] [↺]                                       (mute button, top right)
 *
 *   ( ◀    steer pad    ▶ )            [DRIFT] [ GAS ]
 *                                              [BRAKE]
 *
 * The steer pad is analogue: how far the finger is from its centre is how hard the car steers, and the finger can
 * slide across without lifting. GAS, BRAKE (reverse when stopped) and DRIFT (handbrake) are held buttons. Every
 * control tracks its own pointers, so any combination can be held with several fingers at once.
 *
 * The controls only show while a run is being driven, and only once the device has been used by touch: a primary
 * coarse pointer at start-up, or any touch later. A key press hands control back to the keyboard and hides them.
 */
import type { InputState, MetaInput } from '../types';
import { createMetaInput } from '../input/keyboard';
import { el, injectStyles } from './styles';

/** Share of the pad's half width from its centre at which steering is full. */
const FULL_STEER_AT = 0.6;
/** Share of the pad's half width around its centre that steers nothing. */
const DEAD_ZONE = 0.1;

export interface TouchControls {
  /** Held state, read with the keyboard's and the gamepad's. */
  readonly held: InputState;
  /** Edge flags since the game last took them (pause, reset). */
  readonly pressed: MetaInput;
  /** Whether the device is being played by touch. */
  readonly enabled: boolean;
  /** Shows the controls while a run is driven (and the device is in touch mode); hides and releases them otherwise. */
  setDriving(driving: boolean): void;
  dispose(): void;
}

/** Steering for a finger at `x` on a pad spanning `left`..`left + width`: -1 (full left) .. 1 (full right). */
export function padSteer(x: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  const half = width / 2;
  const offset = (x - (left + half)) / half;
  const magnitude = Math.abs(offset);
  if (magnitude <= DEAD_ZONE) return 0;
  const steer = Math.min(1, (magnitude - DEAD_ZONE) / (FULL_STEER_AT - DEAD_ZONE));
  return offset < 0 ? -steer : steer;
}

/** Whether this device should start in touch mode: its main pointer is a finger. */
function prefersTouch(): boolean {
  try {
    return globalThis.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Keeps a finger's events coming to `node` after it slides off. Never fails the press if the browser refuses. */
function capture(node: HTMLElement, pointerId: number): void {
  try {
    node.setPointerCapture(pointerId);
  } catch {
    // An unknown or already-lifted pointer: the press still counts, it just ends where the finger leaves.
  }
}

type ButtonKind = 'throttle' | 'brake' | 'handbrake';

export function createTouchControls(root: HTMLElement, target: Window = window): TouchControls {
  injectStyles();
  const held: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  const pressed = createMetaInput();
  let enabled = prefersTouch();
  let driving = false;

  const layer = el('div', 'sd-ui sd-touch sd-hidden');
  layer.setAttribute('aria-hidden', 'true');

  // ---- Steer pad ----
  const pad = el('div', 'sd-touch-pad');
  const knob = el('i', 'sd-touch-knob');
  pad.append(el('span', 'sd-touch-arrow', '◀'), knob, el('span', 'sd-touch-arrow', '▶'));
  const padPointers = new Map<number, number>();

  function updateSteer(): void {
    // The newest finger on the pad wins.
    let steer = 0;
    for (const value of padPointers.values()) steer = value;
    held.steer = steer;
    knob.style.transform = `translateX(${(steer * 2.2).toFixed(2)}em)`;
    pad.classList.toggle('is-held', padPointers.size > 0);
  }

  function padMove(event: PointerEvent): void {
    if (!padPointers.has(event.pointerId)) return;
    const box = pad.getBoundingClientRect();
    padPointers.set(event.pointerId, padSteer(event.clientX, box.left, box.width));
    updateSteer();
  }

  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    capture(pad, event.pointerId);
    padPointers.set(event.pointerId, 0);
    padMove(event);
  });
  pad.addEventListener('pointermove', padMove);
  const padUp = (event: PointerEvent): void => {
    if (padPointers.delete(event.pointerId)) updateSteer();
  };
  pad.addEventListener('pointerup', padUp);
  pad.addEventListener('pointercancel', padUp);
  pad.addEventListener('lostpointercapture', padUp);

  // ---- Held buttons ----
  const buttonPointers: Record<ButtonKind, Set<number>> = {
    throttle: new Set(),
    brake: new Set(),
    handbrake: new Set(),
  };

  function applyButton(kind: ButtonKind): void {
    const down = buttonPointers[kind].size > 0;
    if (kind === 'handbrake') held.handbrake = down;
    else held[kind] = down ? 1 : 0;
  }

  function holdButton(kind: ButtonKind, label: string, className: string): HTMLElement {
    const node = el('div', `sd-touch-btn ${className}`, label);
    const pointers = buttonPointers[kind];
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      capture(node, event.pointerId);
      pointers.add(event.pointerId);
      node.classList.add('is-held');
      applyButton(kind);
    });
    const up = (event: PointerEvent): void => {
      if (!pointers.delete(event.pointerId)) return;
      node.classList.toggle('is-held', pointers.size > 0);
      applyButton(kind);
    };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);
    return node;
  }

  const pedals = el('div', 'sd-touch-pedals');
  const drift = holdButton('handbrake', 'Drift', 'sd-touch-drift');
  const gas = holdButton('throttle', 'Gas', 'sd-touch-gas');
  const brake = holdButton('brake', 'Brake', 'sd-touch-brake');
  pedals.append(drift, gas, brake);

  // ---- Taps: pause and reset ----
  function tapButton(label: string, className: string, aria: string, flag: 'pause' | 'reset'): HTMLButtonElement {
    const node = el('button', `sd-touch-tap ${className}`, label);
    node.type = 'button';
    node.setAttribute('aria-label', aria);
    node.tabIndex = -1;
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (flag === 'pause') pressed.pause = true;
      else held.reset = true;
      node.classList.add('is-held');
    });
    const up = (): void => {
      if (flag === 'reset') held.reset = false;
      node.classList.remove('is-held');
    };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('pointerleave', up);
    return node;
  }
  const taps = el('div', 'sd-touch-taps');
  taps.append(tapButton('❚❚', 'sd-touch-pause', 'Pause', 'pause'), tapButton('↺', 'sd-touch-reset', 'Back to checkpoint', 'reset'));

  layer.append(taps, pad, pedals);
  // Keep the browser from scrolling, zooming or opening a context menu under a held thumb.
  layer.addEventListener('contextmenu', (event) => event.preventDefault());
  root.appendChild(layer);

  function releaseAll(): void {
    padPointers.clear();
    updateSteer();
    for (const kind of Object.keys(buttonPointers) as ButtonKind[]) {
      buttonPointers[kind].clear();
      applyButton(kind);
    }
    held.reset = false;
    for (const node of layer.querySelectorAll('.is-held')) node.classList.remove('is-held');
  }

  function refresh(): void {
    const show = enabled && driving;
    if (!show) releaseAll();
    layer.classList.toggle('sd-hidden', !show);
    root.classList.toggle('sd-touch-on', show);
  }

  const onPointer = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || enabled) return;
    enabled = true;
    refresh();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!enabled || event.ctrlKey || event.metaKey || event.altKey) return;
    enabled = false;
    refresh();
  };
  target.addEventListener('pointerdown', onPointer, true);
  target.addEventListener('keydown', onKey, true);
  // Fingers lifted while the page was away never send their pointerup.
  const onBlur = (): void => releaseAll();
  target.addEventListener('blur', onBlur);

  return {
    held,
    pressed,
    get enabled() {
      return enabled;
    },
    setDriving(next) {
      if (next === driving) return;
      driving = next;
      refresh();
    },
    dispose() {
      target.removeEventListener('pointerdown', onPointer, true);
      target.removeEventListener('keydown', onKey, true);
      target.removeEventListener('blur', onBlur);
      root.classList.remove('sd-touch-on');
      layer.remove();
    },
  };
}
