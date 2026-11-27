import { markGlitch } from './glitch';
import { el, injectStyles } from './styles';

export interface MuteButtonOptions {
  muted: boolean;
  /** Called with the new state when the player clicks the button. Not called by `set`. */
  onToggle(muted: boolean): void;
}

export interface MuteButton {
  /** Show a state that changed elsewhere (the M key, the Sound switch in a menu). */
  set(muted: boolean): void;
  dispose(): void;
}

// ---- Shared mute state ----------------------------------------------------------------------------------------
// The corner button and the Sound switch in the menus show the same setting but are built separately, and either
// can change while the other is on screen. They keep each other honest through this channel, so neither depends
// on the game remembering to forward every change both ways.

export type MuteListener = (muted: boolean) => void;

const muteListeners = new Set<MuteListener>();

/** Hear about mute changes announced by other controls. Returns the function that stops listening. */
export function onMuteChange(listener: MuteListener): () => void {
  muteListeners.add(listener);
  return () => {
    muteListeners.delete(listener);
  };
}

/** Tell every other mute control what the state is now. `source` is the announcer's own listener, which is skipped. */
export function announceMute(muted: boolean, source?: MuteListener): void {
  for (const listener of muteListeners) {
    if (listener !== source) listener(muted);
  }
}

// ---- Icon -----------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPEAKER = 'M3.5 9.4h3.4l4.6-3.9v13l-4.6-3.9H3.5z';
const WAVE_NEAR = 'M15 9.3a3.9 3.9 0 0 1 0 5.4';
const WAVE_FAR = 'M17.6 6.6a7.7 7.7 0 0 1 0 10.8';
const SLASH = 'M4.2 3.8l15.6 16.4';
/** Painted under the slash in the button's own background colour, so the slash reads as a cut through the speaker. */
const SLASH_GAP_COLOUR = '#05070f';

function path(d: string, className?: string): SVGPathElement {
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('d', d);
  if (className) node.setAttribute('class', className);
  return node;
}

function group(className: string, ...children: SVGElement[]): SVGGElement {
  const node = document.createElementNS(SVG_NS, 'g');
  node.setAttribute('class', className);
  node.append(...children);
  return node;
}

/** One drawing holding both states; the stylesheet shows the waves or the slash from the button's aria-pressed. */
function speakerIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const gap = path(SLASH);
  gap.setAttribute('stroke', SLASH_GAP_COLOUR);
  gap.setAttribute('stroke-width', '5');
  svg.append(
    path(SPEAKER, 'sd-mute-body'),
    group('sd-mute-on', path(WAVE_NEAR), path(WAVE_FAR)),
    group('sd-mute-off', gap, path(SLASH)),
  );
  return svg;
}

// ---- Button ---------------------------------------------------------------------------------------------------

/**
 * The always-visible mute toggle in the top right corner, above the HUD and every menu.
 * It never has keyboard focus: Space and Enter belong to the handbrake and the menus. It is out of the tab order
 * (it is the last element in the document, and a button that Tab had reached would swallow the next Space as a
 * click, and take an Enter meant for the menu as well); the M key is its keyboard route.
 */
export function createMuteButton(root: HTMLElement, opts: MuteButtonOptions): MuteButton {
  injectStyles();
  let muted = !opts.muted;
  const button = markGlitch(el('button', 'sd-ui sd-mute'), 'soft');
  button.type = 'button';
  button.tabIndex = -1;
  button.appendChild(speakerIcon());

  function show(next: boolean): void {
    if (next === muted) return;
    muted = next;
    const action = muted ? 'Unmute sound' : 'Mute sound';
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', action);
    button.title = `${action} (M)`;
  }

  // A press must not move focus here in the first place (a held Space would then "click" the button on release) ...
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    show(!muted);
    // ... and a click that arrived by keyboard gives focus straight back.
    button.blur();
    announceMute(muted, show);
    opts.onToggle(muted);
  });

  show(opts.muted);
  const stopListening = onMuteChange(show);
  root.appendChild(button);

  return {
    set(next) {
      show(next);
      announceMute(next, show);
    },
    dispose() {
      stopListening();
      button.remove();
    },
  };
}
