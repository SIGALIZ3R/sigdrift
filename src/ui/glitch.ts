/**
 * Glitch accents for the DOM UI: every second or two, one or two visible elements marked `data-glitch` play a
 * short burst. A burst is a class plus a few custom properties; the stylesheet (see "Glitch bursts" in styles.ts)
 * does the rest with transform, opacity, clip-path and filter only, so nothing is laid out again and nothing moves.
 *
 * Nothing is scheduled while the page is hidden, while the reduced-flash setting is on (`sd-calm` on the root) or
 * while the system asks for reduced motion.
 */

export type GlitchLevel = 'soft' | 'full';
/**
 * What the element is, which decides the effects that suit it: a piece of text, a small box that can host
 * pseudo-elements (`panel`), or a large one (`frame`) that must not be dimmed or filtered as a whole.
 */
export type GlitchKind = 'text' | 'panel' | 'frame';
export type GlitchVariant = 'rgb' | 'slice' | 'flicker' | 'scan' | 'skew';

export interface GlitchTraits {
  level: GlitchLevel;
  kind: GlitchKind;
  /** The element, or a direct child, carries `data-text`: the copy the text slice displaces. */
  hasText: boolean;
  /** False while the element's last flicker is too recent for another one. */
  canFlicker: boolean;
  /** Height on screen, px, when known. Small text is sliced once, not shredded. */
  heightPx?: number;
}

export interface BurstPlan {
  variant: GlitchVariant;
  /** The class that selects the effect; `GLITCH_CLASS` goes on beside it. */
  className: string;
  durationMs: number;
  /** The largest sideways displacement the burst uses, px. */
  offsetPx: number;
  /** Opacity dips in the burst: each one is a drop and a return. */
  dips: number;
  /** Custom properties to set for the burst and remove after it. */
  props: Record<string, string>;
}

export interface GlitchMark {
  kind?: GlitchKind;
  /** The element's own text, for the slice effect. Only for text that never changes. */
  text?: string;
  /** How often it is picked next to the others (1 when left out). */
  weight?: number;
}

export interface GlitcherOptions {
  random?: () => number;
  /** A millisecond clock. */
  now?: () => number;
}

export interface Glitcher {
  dispose(): void;
}

export const GLITCH_CLASS = 'sd-g';
export const CALM_CLASS = 'sd-calm';
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 2400;
export const MIN_BURST_MS = 90;
export const MAX_BURST_MS = 320;
/** Limits for readouts the player reads while driving. */
export const SOFT_MAX_BURST_MS = 140;
export const SOFT_MAX_OFFSET_PX = 1.5;
/** No element dims more than this many times in a burst ... */
export const MAX_DIPS = 3;
/** ... and it does not flicker again until this long after, so no second ever holds more than MAX_DIPS flashes. */
export const FLICKER_COOLDOWN_MS = 1000;
/** The class outlives its animation by a couple of frames, so the animation is never cut short. */
export const BURST_SLACK_MS = 34;

const DOUBLE_BURST_CHANCE = 0.35;
const TARGET_SELECTOR = '[data-glitch]';
const COVER_ATTR = 'data-glitch-cover';
const UNDER_ATTR = 'data-glitch-under';
/** A cover that is on screen: the UI hides its layers with `sd-hidden`. Read from the DOM alone, no layout. */
const OPEN_COVER_SELECTOR = `[${COVER_ATTR}]:not(.sd-hidden)`;
const UNDER_SELECTOR = `[${UNDER_ATTR}]`;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** How far past its box a sliced element may still paint (its glow, a displaced edge). */
const CLIP_MARGIN = '4em';
const CLIP_NONE = 'inset(50%)';
/** Text shorter than this on screen counts as small print. */
const SMALL_TEXT_PX = 30;

const VARIANTS: Record<GlitchKind, Record<GlitchLevel, readonly GlitchVariant[]>> = {
  text: { soft: ['rgb', 'flicker'], full: ['rgb', 'slice', 'flicker', 'skew'] },
  panel: { soft: ['rgb', 'flicker', 'scan'], full: ['rgb', 'slice', 'scan', 'skew'] },
  frame: { soft: ['scan'], full: ['slice', 'scan', 'skew'] },
};

// ---- Marking ----------------------------------------------------------------------------------------------------

/** Makes an element a glitch target. Returns it, so a call can wrap the expression that builds the element. */
export function markGlitch<T extends Element>(node: T, level: GlitchLevel, mark: GlitchMark = {}): T {
  node.setAttribute('data-glitch', mark.kind ?? 'text');
  node.setAttribute('data-glitch-level', level);
  if (mark.text !== undefined) node.setAttribute('data-text', mark.text);
  if (mark.weight !== undefined) node.setAttribute('data-glitch-weight', String(mark.weight));
  return node;
}

/**
 * Marks a layer that dims what lies beneath it while it is shown (a menu over the HUD). While one is open, nothing
 * inside a layer marked with `markGlitchUnder` is picked: a burst there would be spent where it can barely be seen.
 */
export function markGlitchCover<T extends Element>(node: T): T {
  node.setAttribute(COVER_ATTR, '');
  return node;
}

/** Marks a layer whose targets rest while a cover is open. */
export function markGlitchUnder<T extends Element>(node: T): T {
  node.setAttribute(UNDER_ATTR, '');
  return node;
}

// ---- Planning (pure) --------------------------------------------------------------------------------------------

/** The effects an element may play. Never empty. */
export function allowedVariants(traits: GlitchTraits): GlitchVariant[] {
  return VARIANTS[traits.kind][traits.level].filter((variant) => {
    if (variant === 'flicker') return traits.canFlicker;
    // A text slice needs the copy; a box is sliced by its outline.
    if (variant === 'slice') return traits.kind !== 'text' || traits.hasText;
    return true;
  });
}

/** Time until the next round of bursts. `random` is a number in [0, 1). */
export function nextDelayMs(random: () => number): number {
  return MIN_INTERVAL_MS + random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/** Index into `weights`, chosen in proportion to them. `roll` is a number in [0, 1). */
export function pickWeighted(weights: readonly number[], roll: number): number {
  let total = 0;
  for (const weight of weights) total += weight;
  let left = roll * total;
  for (let i = 0; i < weights.length; i++) {
    left -= weights[i];
    if (left < 0) return i;
  }
  return weights.length - 1;
}

function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

function sign(random: () => number): 1 | -1 {
  return random() < 0.5 ? -1 : 1;
}

function px(value: number): string {
  return `${value.toFixed(2)}px`;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

/** A horizontal band of an element, in percent of its height, and the way it is displaced. */
export interface SliceBand {
  top: number;
  bottom: number;
  dir: 1 | -1;
}

/** Up to `maxCount` bands (three at most) that do not touch: each keeps to its own share of the height. */
export function sliceBands(random: () => number, minHeight: number, maxHeight: number, maxCount = 3): SliceBand[] {
  const count = 1 + Math.min(maxCount - 1, Math.floor(random() * maxCount));
  const zone = 100 / count;
  const bands: SliceBand[] = [];
  for (let i = 0; i < count; i++) {
    const height = between(random, minHeight, Math.min(maxHeight, zone * 0.7));
    const top = zone * i + between(random, 0, zone - height);
    bands.push({ top, bottom: top + height, dir: sign(random) });
  }
  return bands;
}

/**
 * The outline of a box whose bands have been pushed sideways by `depth` px: each band loses that much on the side
 * it moved away from. Everywhere else the outline keeps clear of the box, so its glow is not cut off.
 */
export function notchClip(bands: readonly SliceBand[], depth: number): string {
  const far = `calc(100% + ${CLIP_MARGIN})`;
  const near = `-${CLIP_MARGIN}`;
  const points = [`${near} ${near}`, `${far} ${near}`];
  for (const band of bands) {
    if (band.dir > 0) continue;
    const cut = `calc(100% - ${px(depth)})`;
    points.push(`${far} ${percent(band.top)}`, `${cut} ${percent(band.top)}`);
    points.push(`${cut} ${percent(band.bottom)}`, `${far} ${percent(band.bottom)}`);
  }
  points.push(`${far} ${far}`, `${near} ${far}`);
  for (let i = bands.length - 1; i >= 0; i--) {
    const band = bands[i];
    if (band.dir < 0) continue;
    points.push(`${near} ${percent(band.bottom)}`, `${px(depth)} ${percent(band.bottom)}`);
    points.push(`${px(depth)} ${percent(band.top)}`, `${near} ${percent(band.top)}`);
  }
  return `polygon(${points.join(', ')})`;
}

/** A clip that shows only the given bands, with room at both ends for what is displaced. */
export function bandClip(bands: readonly SliceBand[]): string {
  if (bands.length === 0) return CLIP_NONE;
  const far = `calc(100% + ${CLIP_MARGIN})`;
  const near = `-${CLIP_MARGIN}`;
  const points: string[] = [];
  for (const band of bands) {
    points.push(`${near} ${percent(band.top)}`, `${far} ${percent(band.top)}`);
    points.push(`${far} ${percent(band.bottom)}`, `${near} ${percent(band.bottom)}`);
  }
  return `polygon(${points.join(', ')})`;
}

function planRgb(traits: GlitchTraits, random: () => number): BurstPlan {
  const soft = traits.level === 'soft';
  const offset = soft ? between(random, 0.8, SOFT_MAX_OFFSET_PX) : between(random, 1.5, 3.5);
  const lift = soft ? 0 : between(random, -1, 1);
  const duration = soft ? between(random, MIN_BURST_MS, SOFT_MAX_BURST_MS) : between(random, 110, 220);
  return {
    variant: 'rgb',
    className: 'sd-g-rgb',
    durationMs: Math.round(duration),
    offsetPx: offset,
    dips: 0,
    props: { '--g-dur': ms(duration), '--g-x': px(offset * sign(random)), '--g-y': px(lift) },
  };
}

function planFlicker(traits: GlitchTraits, random: () => number): BurstPlan {
  const soft = traits.level === 'soft';
  const dips = soft || random() < 0.5 ? 2 : MAX_DIPS;
  const duration = soft ? between(random, 110, SOFT_MAX_BURST_MS) : between(random, 160, MAX_BURST_MS);
  const low = soft ? 0.68 : 0.4;
  const high = soft ? 0.82 : 0.7;
  return {
    variant: 'flicker',
    className: 'sd-g-flicker',
    durationMs: Math.round(duration),
    offsetPx: 0,
    dips,
    props: {
      '--g-dur': ms(duration),
      '--g-name': `sd-g-flicker-${dips}`,
      '--g-dip': between(random, low, high).toFixed(2),
      '--g-dip2': between(random, low, high).toFixed(2),
    },
  };
}

function planSkew(traits: GlitchTraits, random: () => number): BurstPlan {
  // The bigger the box, the smaller the angle: a degree on a tall panel moves its corners a long way.
  const text = traits.kind === 'text';
  const frame = traits.kind === 'frame';
  const offset = text ? between(random, 1.5, 4) : frame ? between(random, 1, 2) : between(random, 1, 3);
  const angle = text ? between(random, 3, 7) : frame ? between(random, 0.15, 0.4) : between(random, 0.4, 1.2);
  const duration = between(random, MIN_BURST_MS, 180);
  return {
    variant: 'skew',
    className: 'sd-g-skew',
    durationMs: Math.round(duration),
    offsetPx: offset,
    dips: 0,
    props: {
      '--g-dur': ms(duration),
      '--g-x': px(offset * sign(random)),
      '--g-skew': `${(angle * sign(random)).toFixed(2)}deg`,
    },
  };
}

function planScan(traits: GlitchTraits, random: () => number): BurstPlan {
  const soft = traits.level === 'soft';
  const duration = soft ? between(random, 120, SOFT_MAX_BURST_MS) : between(random, 200, MAX_BURST_MS);
  return {
    variant: 'scan',
    className: 'sd-g-scan',
    durationMs: Math.round(duration),
    offsetPx: 0,
    dips: 0,
    props: { '--g-dur': ms(duration), '--g-a': soft ? '0.5' : between(random, 0.7, 0.95).toFixed(2) },
  };
}

function planTextSlice(traits: GlitchTraits, random: () => number): BurstPlan {
  // A line of small print keeps most of itself in place: one band, where a headline can take three.
  const small = traits.heightPx !== undefined && traits.heightPx < SMALL_TEXT_PX;
  const bands = small ? sliceBands(random, 30, 45, 1) : sliceBands(random, 14, 34);
  const first = bands[0];
  const offset = between(random, 2, 5);
  const duration = between(random, 120, 260);
  const props: Record<string, string> = {
    '--g-dur': ms(duration),
    // The first band has a copy of its own; the others share the second copy, which moves the other way.
    '--g-x1': px(offset * first.dir),
    '--g-x2': px(between(random, 2, offset) * -first.dir),
    '--g-t1': percent(first.top),
    '--g-u1': percent(first.bottom),
  };
  for (let i = 1; i <= 2; i++) {
    const band = bands[i];
    props[`--g-t${i + 1}`] = percent(band ? band.top : 0);
    props[`--g-u${i + 1}`] = percent(band ? band.bottom : 0);
  }
  return { variant: 'slice', className: 'sd-g-slice', durationMs: Math.round(duration), offsetPx: offset, dips: 0, props };
}

function planBoxSlice(traits: GlitchTraits, random: () => number): BurstPlan {
  const bands = traits.kind === 'frame' ? sliceBands(random, 3, 9) : sliceBands(random, 6, 16);
  const offset = between(random, 3, 6);
  const duration = between(random, 120, 260);
  return {
    variant: 'slice',
    className: 'sd-g-pslice',
    durationMs: Math.round(duration),
    offsetPx: offset,
    dips: 0,
    props: {
      '--g-dur': ms(duration),
      '--g-px': px(offset),
      '--g-clip': notchClip(bands, offset),
      '--g-clip2': notchClip(bands, offset * 0.4),
      '--g-bands-r': bandClip(bands.filter((band) => band.dir > 0)),
      '--g-bands-l': bandClip(bands.filter((band) => band.dir < 0)),
    },
  };
}

/** Chooses an effect the element may play and the numbers that make this burst unlike the last. */
export function planBurst(traits: GlitchTraits, random: () => number): BurstPlan {
  const variants = allowedVariants(traits);
  const variant = variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))];
  switch (variant) {
    case 'flicker':
      return planFlicker(traits, random);
    case 'skew':
      return planSkew(traits, random);
    case 'scan':
      return planScan(traits, random);
    case 'slice':
      return traits.kind === 'text' ? planTextSlice(traits, random) : planBoxSlice(traits, random);
    default:
      return planRgb(traits, random);
  }
}

// ---- Reading the page -------------------------------------------------------------------------------------------

function levelOf(node: Element): GlitchLevel {
  // Anything not plainly marked "full" gets the gentle treatment.
  return node.getAttribute('data-glitch-level') === 'full' ? 'full' : 'soft';
}

function kindOf(node: Element): GlitchKind {
  const kind = node.getAttribute('data-glitch');
  return kind === 'panel' || kind === 'frame' ? kind : 'text';
}

function weightOf(node: Element): number {
  const weight = Number(node.getAttribute('data-glitch-weight'));
  return weight > 0 ? weight : 1;
}

function viewportSize(): { width: number; height: number } {
  const width = globalThis.innerWidth;
  const height = globalThis.innerHeight;
  return {
    width: typeof width === 'number' ? width : Infinity,
    height: typeof height === 'number' ? height : Infinity,
  };
}

/**
 * The element's height on screen, or 0 when it cannot be seen: off the page, hidden by itself or an ancestor,
 * without a size, or wholly outside the window.
 */
function visibleHeight(node: HTMLElement): number {
  if (!node.isConnected) return 0;
  if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ visibilityProperty: true })) return 0;
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return 0;
  const viewport = viewportSize();
  const inView = box.bottom > 0 && box.right > 0 && box.top < viewport.height && box.left < viewport.width;
  return inView ? box.height : 0;
}

function reducedMotionQuery(): MediaQueryList | null {
  try {
    return globalThis.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

// ---- Scheduler --------------------------------------------------------------------------------------------------

interface ActiveBurst {
  plan: BurstPlan;
  timer: ReturnType<typeof setTimeout>;
}

export function createGlitcher(root: HTMLElement, options: GlitcherOptions = {}): Glitcher {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());
  const active = new Map<HTMLElement, ActiveBurst>();
  const flickerEnd = new WeakMap<HTMLElement, number>();
  const motion = reducedMotionQuery();
  let next: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function mayRun(): boolean {
    return !disposed && !document.hidden && !root.classList.contains(CALM_CLASS) && motion?.matches !== true;
  }

  function end(node: HTMLElement): void {
    const burst = active.get(node);
    if (!burst) return;
    active.delete(node);
    clearTimeout(burst.timer);
    // The element may have left the page meanwhile; it is tidied all the same, in case it comes back.
    node.classList.remove(GLITCH_CLASS, burst.plan.className);
    for (const name in burst.plan.props) node.style.removeProperty(name);
    if (burst.plan.variant === 'flicker') flickerEnd.set(node, now());
  }

  function start(node: HTMLElement, heightPx: number): void {
    const lastFlicker = flickerEnd.get(node);
    const plan = planBurst(
      {
        level: levelOf(node),
        kind: kindOf(node),
        hasText: node.hasAttribute('data-text') || node.querySelector(':scope > [data-text]') !== null,
        canFlicker: lastFlicker === undefined || now() - lastFlicker >= FLICKER_COOLDOWN_MS,
        heightPx,
      },
      random,
    );
    for (const name in plan.props) node.style.setProperty(name, plan.props[name]);
    node.classList.add(GLITCH_CLASS, plan.className);
    active.set(node, { plan, timer: setTimeout(() => end(node), plan.durationMs + BURST_SLACK_MS) });
  }

  function fire(): void {
    const covered = root.querySelector(OPEN_COVER_SELECTOR) !== null;
    const pool: HTMLElement[] = [];
    const weights: number[] = [];
    for (const node of root.querySelectorAll<HTMLElement>(TARGET_SELECTOR)) {
      // An element only ever plays one burst at a time; one being pressed is left alone.
      if (active.has(node) || node.matches(':active')) continue;
      if (covered && node.closest(UNDER_SELECTOR) !== null) continue;
      pool.push(node);
      weights.push(weightOf(node));
    }
    const wanted = random() < DOUBLE_BURST_CHANCE ? 2 : 1;
    // Visibility is only measured for the elements that come up, not for the whole list, and every measurement is
    // taken before the first burst is written: a write in between would have the browser lay the page out again.
    const picked: { node: HTMLElement; height: number }[] = [];
    while (picked.length < wanted && pool.length > 0) {
      const index = pickWeighted(weights, random());
      const node = pool[index];
      pool.splice(index, 1);
      weights.splice(index, 1);
      const height = visibleHeight(node);
      if (height > 0) picked.push({ node, height });
    }
    for (const { node, height } of picked) start(node, height);
  }

  function tick(): void {
    next = null;
    if (!mayRun()) return;
    try {
      fire();
    } finally {
      // Whatever a round runs into, the chain goes on: one bad element must not end the glitches for good.
      next = setTimeout(tick, nextDelayMs(random));
    }
  }

  /** Starts or stops the chain to match the page, the setting and the system preference as they are now. */
  function sync(): void {
    if (mayRun()) {
      if (next === null) next = setTimeout(tick, nextDelayMs(random));
      return;
    }
    if (next !== null) clearTimeout(next);
    next = null;
    for (const node of [...active.keys()]) end(node);
  }

  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', sync);
  motion?.addEventListener('change', sync);
  sync();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      sync();
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      motion?.removeEventListener('change', sync);
    },
  };
}
