import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BURST_SLACK_MS,
  CALM_CLASS,
  FLICKER_COOLDOWN_MS,
  GLITCH_CLASS,
  MAX_BURST_MS,
  MAX_DIPS,
  MAX_INTERVAL_MS,
  MAX_TRANSITION_MS,
  MIN_BURST_MS,
  MIN_TRANSITION_MS,
  ROW_FLICKER_MAX_MS,
  ROW_FLICKER_MIN_MS,
  SIGNAL_LOSS_MAX_DELAY_MS,
  SIGNAL_LOSS_MIN_DELAY_MS,
  MIN_INTERVAL_MS,
  SOFT_MAX_BURST_MS,
  SOFT_MAX_OFFSET_PX,
  allowedVariants,
  bandClip,
  createGlitcher,
  markGlitch,
  markGlitchCover,
  markGlitchUnder,
  nextDelayMs,
  notchClip,
  pickWeighted,
  planBurst,
  planRowFlicker,
  planSignalLoss,
  planTransition,
  sliceBands,
} from '../../src/ui/glitch';
import type { GlitchKind, GlitchLevel, GlitchTraits } from '../../src/ui/glitch';

/** Small deterministic generator, so a failure can be reproduced. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function traits(level: GlitchLevel, kind: GlitchKind = 'text', extra: Partial<GlitchTraits> = {}): GlitchTraits {
  return { level, kind, hasText: true, canFlicker: true, ...extra };
}

const KINDS: readonly GlitchKind[] = ['text', 'panel', 'frame'];
const LEVELS: readonly GlitchLevel[] = ['soft', 'full'];
const ROUNDS = 400;

// ---- Pure parts -------------------------------------------------------------------------------------------------

describe('allowedVariants', () => {
  it('gives readouts only the RGB split and the flicker', () => {
    expect(allowedVariants(traits('soft')).sort()).toEqual(['flicker', 'rgb']);
  });

  it('never slices or skews anything soft', () => {
    for (const kind of KINDS) {
      const variants = allowedVariants(traits('soft', kind));
      expect(variants).not.toContain('slice');
      expect(variants).not.toContain('skew');
    }
  });

  it('offers full text every effect but the scanline', () => {
    expect(allowedVariants(traits('full')).sort()).toEqual(['flicker', 'rgb', 'skew', 'slice']);
  });

  it('only slices text that has a copy to displace', () => {
    expect(allowedVariants(traits('full', 'text', { hasText: false }))).not.toContain('slice');
    expect(allowedVariants(traits('full', 'panel', { hasText: false }))).toContain('slice');
  });

  it('never dims or filters a whole menu frame', () => {
    for (const level of LEVELS) {
      const variants = allowedVariants(traits(level, 'frame'));
      expect(variants).not.toContain('flicker');
      expect(variants).not.toContain('rgb');
    }
  });

  it('holds the flicker back while it is cooling down', () => {
    expect(allowedVariants(traits('full', 'text', { canFlicker: false }))).not.toContain('flicker');
    expect(allowedVariants(traits('soft', 'text', { canFlicker: false }))).toEqual(['rgb']);
  });

  it('always leaves something to play', () => {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        expect(allowedVariants(traits(level, kind, { hasText: false, canFlicker: false })).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('planBurst', () => {
  it('keeps every burst between 90 and 320 ms and inside what the element allows', () => {
    const random = seeded(11);
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        const subject = traits(level, kind);
        const allowed = allowedVariants(subject);
        for (let i = 0; i < ROUNDS; i++) {
          const plan = planBurst(subject, random);
          expect(allowed).toContain(plan.variant);
          expect(plan.durationMs).toBeGreaterThanOrEqual(MIN_BURST_MS);
          expect(plan.durationMs).toBeLessThanOrEqual(MAX_BURST_MS);
          expect(plan.props['--g-dur']).toBe(`${plan.durationMs}ms`);
          expect(plan.dips).toBeLessThanOrEqual(MAX_DIPS);
        }
      }
    }
  });

  it('keeps soft bursts short and their offsets within a pixel and a half', () => {
    const random = seeded(12);
    for (const kind of KINDS) {
      for (let i = 0; i < ROUNDS; i++) {
        const plan = planBurst(traits('soft', kind), random);
        expect(plan.variant).not.toBe('slice');
        expect(plan.durationMs).toBeLessThanOrEqual(SOFT_MAX_BURST_MS);
        expect(plan.offsetPx).toBeLessThanOrEqual(SOFT_MAX_OFFSET_PX);
        const shift = plan.props['--g-x'];
        if (shift !== undefined) expect(Math.abs(parseFloat(shift))).toBeLessThanOrEqual(SOFT_MAX_OFFSET_PX);
      }
    }
  });

  it('plays every allowed effect sooner or later, and not the same numbers twice', () => {
    const random = seeded(13);
    const seen = new Set<string>();
    const fingerprints = new Set<string>();
    for (let i = 0; i < ROUNDS; i++) {
      const plan = planBurst(traits('full'), random);
      seen.add(plan.variant);
      fingerprints.add(JSON.stringify(plan.props));
    }
    expect([...seen].sort()).toEqual(['flicker', 'rgb', 'skew', 'slice']);
    expect(fingerprints.size).toBeGreaterThan(ROUNDS * 0.9);
  });

  it('uses the outline slice for boxes and the text slice for text', () => {
    const random = seeded(14);
    for (let i = 0; i < ROUNDS; i++) {
      const text = planBurst(traits('full', 'text'), random);
      if (text.variant === 'slice') expect(text.className).toBe('sd-g-slice');
      const box = planBurst(traits('full', 'panel'), random);
      if (box.variant === 'slice') expect(box.className).toBe('sd-g-pslice');
    }
  });

  it('cuts small print once only', () => {
    const random = seeded(15);
    for (let i = 0; i < ROUNDS; i++) {
      const plan = planBurst(traits('full', 'text', { heightPx: 14 }), random);
      if (plan.variant !== 'slice') continue;
      expect(plan.props['--g-u2']).toBe('0.0%');
      expect(plan.props['--g-u3']).toBe('0.0%');
    }
  });

  it('survives a generator that returns its extremes', () => {
    for (const edge of [0, 0.999999]) {
      for (const kind of KINDS) {
        for (const level of LEVELS) expect(() => planBurst(traits(level, kind), () => edge)).not.toThrow();
      }
    }
  });
});

describe('sliceBands', () => {
  it('returns one to three bands, in order, inside the element and apart from each other', () => {
    const random = seeded(21);
    const counts = new Set<number>();
    for (let i = 0; i < ROUNDS; i++) {
      const bands = sliceBands(random, 14, 34);
      counts.add(bands.length);
      let floor = 0;
      for (const band of bands) {
        expect(band.top).toBeGreaterThanOrEqual(floor);
        expect(band.bottom).toBeGreaterThan(band.top);
        expect(band.bottom).toBeLessThanOrEqual(100);
        floor = band.bottom;
      }
    }
    expect([...counts].sort()).toEqual([1, 2, 3]);
  });
});

describe('slice clips', () => {
  const bands = [
    { top: 10, bottom: 20, dir: 1 as const },
    { top: 50, bottom: 60, dir: -1 as const },
  ];

  it('notches the left edge of a band pushed right and the right edge of one pushed left', () => {
    const clip = notchClip(bands, 4);
    expect(clip.startsWith('polygon(')).toBe(true);
    expect(clip).toContain('4.00px 10.0%');
    expect(clip).toContain('4.00px 20.0%');
    expect(clip).toContain('calc(100% - 4.00px) 50.0%');
    expect(clip).toContain('calc(100% - 4.00px) 60.0%');
  });

  it('leaves the outline whole when there is no band', () => {
    expect(notchClip([], 4)).not.toContain('px');
  });

  it('shows nothing of a ghost that has no band', () => {
    expect(bandClip([])).toBe('inset(50%)');
    expect(bandClip(bands)).toContain('10.0%');
  });
});

describe('nextDelayMs', () => {
  it('stays between 1.0 and 2.4 seconds', () => {
    expect(nextDelayMs(() => 0)).toBe(MIN_INTERVAL_MS);
    expect(nextDelayMs(() => 0.999999)).toBeLessThanOrEqual(MAX_INTERVAL_MS);
    const random = seeded(31);
    for (let i = 0; i < ROUNDS; i++) {
      const delay = nextDelayMs(random);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2400);
    }
  });
});

describe('pickWeighted', () => {
  it('favours the heavier entry in proportion', () => {
    const random = seeded(41);
    const hits = [0, 0, 0];
    for (let i = 0; i < 6000; i++) hits[pickWeighted([1, 3, 1], random())]++;
    expect(hits[1]).toBeGreaterThan(hits[0] * 2.4);
    expect(hits[1]).toBeGreaterThan(hits[2] * 2.4);
  });

  it('stays in range at the extremes', () => {
    expect(pickWeighted([1, 1], 0)).toBe(0);
    expect(pickWeighted([1, 1], 0.999999)).toBe(1);
    expect(pickWeighted([2], 1)).toBe(0);
  });
});

// ---- Scheduler, on a stand-in DOM ---------------------------------------------------------------------------------

class FakeClassList {
  readonly names = new Set<string>();
  onChange: (() => void) | null = null;

  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
    this.onChange?.();
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
    this.onChange?.();
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly attributes = new Map<string, string>();
  readonly props = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.props.set(name, value);
    },
    removeProperty: (name: string): void => {
      this.props.delete(name);
    },
  };
  isConnected = true;
  pressed = false;
  box = { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 };
  /** Every glitch class the element has been given, in order. */
  readonly history: string[] = [];
  /** How many times a burst began while another was still on. */
  overlaps = 0;
  /** The clock reading when the latest burst began. */
  startedAt = -1;

  constructor() {
    const add = this.classList.add.bind(this.classList);
    this.classList.add = (...names: string[]) => {
      if (this.classList.contains(GLITCH_CLASS)) this.overlaps++;
      this.history.push(...names.filter((name) => name !== GLITCH_CLASS));
      add(...names);
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  querySelector(_selector?: string): FakeElement | null {
    return null;
  }

  /** The layer the element sits in, when it has one: all `closest` is asked for here. */
  layer: FakeElement | null = null;

  closest(selector: string): FakeElement | null {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    return attribute !== undefined && this.layer?.hasAttribute(attribute) ? this.layer : null;
  }

  matches(selector: string): boolean {
    return selector === ':active' && this.pressed;
  }

  /** Called with each measurement, so a test can see what was on the page when it was taken. */
  onMeasure: (() => void) | null = null;

  getBoundingClientRect(): FakeElement['box'] {
    this.onMeasure?.();
    return this.box;
  }

  get glitching(): boolean {
    return [...this.classList.names].some((name) => name.startsWith(GLITCH_CLASS));
  }

  hide(): void {
    this.box = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

class FakeRoot extends FakeElement {
  targets: FakeElement[] = [];
  /** Layers that are not targets themselves: a menu overlay, the HUD. */
  layers: FakeElement[] = [];

  querySelectorAll(): FakeElement[] {
    return this.targets;
  }

  /** Understands `[attribute]` and `[attribute]:not(.class)`, which is all the glitcher asks the root. */
  override querySelector(selector = ''): FakeElement | null {
    const parts = /^\[([\w-]+)\](?::not\(\.([\w-]+)\))?$/.exec(selector);
    if (!parts) return null;
    const [, attribute, excluded] = parts;
    return (
      this.layers.find((layer) => layer.hasAttribute(attribute) && !(excluded && layer.classList.contains(excluded))) ??
      null
    );
  }
}

interface FakePage {
  root: FakeRoot;
  document: { hidden: boolean; listeners: Set<() => void> };
  motion: { matches: boolean; listeners: Set<() => void> };
  observers: Set<() => void>;
  /** Stand-in for the browser telling everyone that something changed. */
  notify(listeners: Set<() => void>): void;
  add(level: GlitchLevel, kind?: GlitchKind, text?: string): FakeElement;
  start(seed?: number): { dispose(): void };
}

let clock = 0;

function fakePage(): FakePage {
  const root = new FakeRoot();
  const documentListeners = new Set<() => void>();
  const motionListeners = new Set<() => void>();
  const observers = new Set<() => void>();
  const fakeDocument = {
    hidden: false,
    listeners: documentListeners,
    addEventListener: (_type: string, listener: () => void) => documentListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => documentListeners.delete(listener),
  };
  const motion = {
    matches: false,
    listeners: motionListeners,
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => motionListeners.delete(listener),
  };
  class FakeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      observers.add(this.callback);
    }
    disconnect(): void {
      observers.delete(this.callback);
    }
  }
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('matchMedia', () => motion);
  vi.stubGlobal('MutationObserver', FakeObserver);
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 720);

  return {
    root,
    document: fakeDocument,
    motion,
    observers,
    notify(listeners) {
      for (const listener of [...listeners]) listener();
    },
    add(level, kind = 'text', text) {
      const node = markGlitch(new FakeElement() as unknown as HTMLElement, level, { kind, text });
      root.targets.push(node as unknown as FakeElement);
      return node as unknown as FakeElement;
    },
    start(seed = 1) {
      return createGlitcher(root as unknown as HTMLElement, { random: seeded(seed), now: () => clock });
    },
  };
}

/** Moves the fake timers and the glitcher's own clock on together. */
function advance(msToRun: number): void {
  clock += msToRun;
  vi.advanceTimersByTime(msToRun);
}

/** Runs up to the moment the element's next burst begins. Fails the test if none comes in time. */
function advanceToBurst(node: FakeElement): void {
  for (let waited = 0; waited <= MAX_INTERVAL_MS && !node.glitching; waited += 10) advance(10);
  expect(node.glitching).toBe(true);
}

function setCalm(page: FakePage, calm: boolean): void {
  if (calm) page.root.classList.add(CALM_CLASS);
  else page.root.classList.remove(CALM_CLASS);
  page.notify(page.observers);
}

describe('createGlitcher', () => {
  let page: FakePage;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    page = fakePage();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits at least a second, then glitches one or two elements within 2.4 s', () => {
    const nodes = [page.add('full'), page.add('full'), page.add('soft'), page.add('full', 'panel')];
    page.start();
    advance(MIN_INTERVAL_MS - 1);
    expect(nodes.some((node) => node.glitching)).toBe(false);
    advance(MAX_INTERVAL_MS - MIN_INTERVAL_MS + 1);
    const count = nodes.filter((node) => node.history.length > 0).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
  });

  it('removes the classes and properties when a burst is over', () => {
    const node = page.add('full', 'text', 'Drive');
    page.start();
    advanceToBurst(node);
    expect(node.props.size).toBeGreaterThan(0);
    advance(MAX_BURST_MS + BURST_SLACK_MS);
    expect(node.glitching).toBe(false);
    expect(node.props.size).toBe(0);
  });

  it('keeps going, one or two at a time, with never two bursts on one element', () => {
    const nodes = [page.add('full', 'text', 'A'), page.add('soft'), page.add('full', 'panel'), page.add('full', 'frame')];
    page.start(5);
    let busiest = 0;
    for (let t = 0; t < 120_000; t += 10) {
      advance(10);
      busiest = Math.max(busiest, nodes.filter((node) => node.glitching).length);
    }
    const bursts = nodes.reduce((sum, node) => sum + node.history.length, 0);
    // 120 s of rounds 1.0 to 2.4 s apart, one or two bursts each.
    expect(bursts).toBeGreaterThanOrEqual(120_000 / MAX_INTERVAL_MS - 1);
    expect(bursts).toBeLessThanOrEqual((120_000 / MIN_INTERVAL_MS) * 2);
    expect(busiest).toBeGreaterThanOrEqual(1);
    expect(busiest).toBeLessThanOrEqual(2);
    for (const node of nodes) {
      expect(node.history.length).toBeGreaterThan(0);
      expect(node.overlaps).toBe(0);
    }
    expect(new Set(nodes.flatMap((node) => node.history)).size).toBeGreaterThanOrEqual(5);
  });

  it('gives soft elements nothing but the gentle effects', () => {
    const node = page.add('soft', 'text', 'never sliced');
    page.start(6);
    advance(200_000);
    expect(node.history.length).toBeGreaterThan(50);
    expect(new Set(node.history)).toEqual(new Set(['sd-g-rgb', 'sd-g-flicker']));
  });

  it('never lets an element flicker twice within a second', () => {
    const node = page.add('soft');
    page.start(7);
    let lastEnd = -Infinity;
    let wasFlickering = false;
    let flickers = 0;
    for (let t = 0; t < 200_000; t += 5) {
      advance(5);
      const flickering = node.classList.contains('sd-g-flicker');
      if (flickering && !wasFlickering) {
        flickers++;
        expect(clock - lastEnd).toBeGreaterThanOrEqual(FLICKER_COOLDOWN_MS);
      }
      if (!flickering && wasFlickering) lastEnd = clock;
      wasFlickering = flickering;
    }
    expect(flickers).toBeGreaterThan(5);
  });

  it('picks a heavier element more often', () => {
    const logo = page.add('full');
    logo.setAttribute('data-glitch-weight', '3');
    const others = [page.add('full'), page.add('full'), page.add('full')];
    page.start(8);
    advance(600_000);
    for (const other of others) expect(logo.history.length).toBeGreaterThan(other.history.length * 1.5);
  });

  it('skips elements that cannot be seen or are being pressed', () => {
    const hidden = page.add('full');
    hidden.hide();
    const detached = page.add('full');
    detached.isConnected = false;
    const offscreen = page.add('full');
    offscreen.box = { left: 10, top: 900, right: 110, bottom: 940, width: 100, height: 40 };
    const pressed = page.add('full');
    pressed.pressed = true;
    const shown = page.add('full');
    page.start(9);
    advance(60_000);
    expect(hidden.history).toEqual([]);
    expect(detached.history).toEqual([]);
    expect(offscreen.history).toEqual([]);
    expect(pressed.history).toEqual([]);
    expect(shown.history.length).toBeGreaterThan(10);
  });

  it('tidies an element that left the page in the middle of its burst', () => {
    const node = page.add('full', 'text', 'Gone');
    page.start();
    advanceToBurst(node);
    node.isConnected = false;
    page.root.targets = [];
    advance(MAX_BURST_MS + BURST_SLACK_MS);
    expect(node.glitching).toBe(false);
    expect(node.props.size).toBe(0);
  });

  it('leaves the HUD alone while a menu covers it, and comes back to it when the menu closes', () => {
    const menu = markGlitchCover(new FakeElement() as unknown as HTMLElement) as unknown as FakeElement;
    const hud = markGlitchUnder(new FakeElement() as unknown as HTMLElement) as unknown as FakeElement;
    page.root.layers.push(menu, hud);
    const readout = page.add('soft');
    readout.layer = hud;
    const heading = page.add('full');
    heading.layer = menu;
    const corner = page.add('soft');
    page.start(10);
    advance(60_000);
    expect(readout.history).toEqual([]);
    expect(heading.history.length).toBeGreaterThan(5);
    expect(corner.history.length).toBeGreaterThan(5);
    menu.classList.add('sd-hidden');
    advance(60_000);
    expect(readout.history.length).toBeGreaterThan(5);
  });

  it('measures every element of a round before it writes to any', () => {
    const nodes = [page.add('full'), page.add('full'), page.add('full'), page.add('full')];
    let dirtyReads = 0;
    let doubles = 0;
    for (const node of nodes) {
      node.onMeasure = () => {
        // A burst that began in this very round shows as a class that was not there when the round started.
        if (nodes.some((other) => other.glitching && other.startedAt === clock)) dirtyReads++;
      };
      const add = node.classList.add;
      node.classList.add = (...names: string[]) => {
        if (nodes.some((other) => other !== node && other.startedAt === clock)) doubles++;
        node.startedAt = clock;
        add(...names);
      };
    }
    page.start(11);
    advance(120_000);
    expect(doubles).toBeGreaterThan(5);
    expect(dirtyReads).toBe(0);
  });

  it('keeps its rhythm when a round fails on a broken element', () => {
    const node = page.add('full');
    let failures = 0;
    node.getBoundingClientRect = () => {
      if (failures++ === 0) throw new Error('gone wrong');
      return node.box;
    };
    page.start(12);
    expect(() => advance(MAX_INTERVAL_MS)).toThrow('gone wrong');
    expect(vi.getTimerCount()).toBe(1);
    advance(MAX_INTERVAL_MS);
    expect(node.history.length).toBe(1);
  });

  it('schedules nothing in calm mode', () => {
    const node = page.add('full');
    page.root.classList.add(CALM_CLASS);
    page.start();
    expect(vi.getTimerCount()).toBe(0);
    advance(30_000);
    expect(node.history).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules nothing when the system asks for reduced motion', () => {
    const node = page.add('full');
    page.motion.matches = true;
    page.start();
    expect(vi.getTimerCount()).toBe(0);
    advance(30_000);
    expect(node.history).toEqual([]);
  });

  it('stops at once when calm mode is switched on, burst in flight included', () => {
    const node = page.add('full', 'text', 'Drive');
    page.start();
    advanceToBurst(node);
    setCalm(page, true);
    expect(node.glitching).toBe(false);
    expect(node.props.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const before = node.history.length;
    advance(30_000);
    expect(node.history.length).toBe(before);
  });

  it('starts again when calm mode is switched off, with one chain only', () => {
    const node = page.add('full');
    page.root.classList.add(CALM_CLASS);
    page.start();
    setCalm(page, false);
    // An unrelated class change on the root must not start a second chain.
    page.notify(page.observers);
    expect(vi.getTimerCount()).toBe(1);
    advance(MAX_INTERVAL_MS);
    expect(node.history.length).toBe(1);
  });

  it('follows the reduced-motion preference when it changes', () => {
    const node = page.add('full');
    page.start();
    page.motion.matches = true;
    page.notify(page.motion.listeners);
    expect(vi.getTimerCount()).toBe(0);
    page.motion.matches = false;
    page.notify(page.motion.listeners);
    advance(MAX_INTERVAL_MS);
    expect(node.history.length).toBe(1);
  });

  it('does nothing while the page is hidden and picks up again when it shows', () => {
    const node = page.add('full');
    page.start();
    page.document.hidden = true;
    page.notify(page.document.listeners);
    expect(vi.getTimerCount()).toBe(0);
    advance(30_000);
    expect(node.history).toEqual([]);
    page.document.hidden = false;
    page.notify(page.document.listeners);
    advance(MAX_INTERVAL_MS);
    expect(node.history.length).toBe(1);
  });

  it('cleans up on dispose', () => {
    const node = page.add('full', 'text', 'Drive');
    const glitcher = page.start();
    advanceToBurst(node);
    glitcher.dispose();
    expect(node.glitching).toBe(false);
    expect(node.props.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(page.observers.size).toBe(0);
    expect(page.document.listeners.size).toBe(0);
    expect(page.motion.listeners.size).toBe(0);
    const before = node.history.length;
    advance(30_000);
    expect(node.history.length).toBe(before);
    glitcher.dispose();
  });
});

describe('screen transitions, row flicker and signal loss (plans)', () => {
  it('plans a 180-260 ms transition with every property it needs', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const plan = planTransition(seeded(seed));
      expect(plan.durationMs).toBeGreaterThanOrEqual(MIN_TRANSITION_MS);
      expect(plan.durationMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
      expect(plan.offsetPx).toBeGreaterThan(0);
      expect(plan.offsetPx).toBeLessThanOrEqual(9);
      expect(Object.keys(plan.props).sort()).toEqual(['--tx-b', '--tx-dur', '--tx-t', '--tx-x']);
      const top = parseFloat(plan.props['--tx-t']);
      const bottom = parseFloat(plan.props['--tx-b']);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeGreaterThanOrEqual(0);
      expect(top + bottom).toBeLessThan(100);
    }
  });

  it('plans row flickers within the soft limits', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const plan = planRowFlicker(seeded(seed));
      expect(plan.variant).toBe('flicker');
      expect(plan.dips).toBeLessThanOrEqual(MAX_DIPS);
      expect(plan.durationMs).toBeLessThanOrEqual(SOFT_MAX_BURST_MS);
      expect(parseFloat(plan.props['--g-dip'])).toBeGreaterThanOrEqual(0.68);
    }
    // One row at a time, never sooner than the per-element cooldown allows a second flicker in the same second.
    expect(ROW_FLICKER_MIN_MS).toBeGreaterThanOrEqual(500);
    expect(ROW_FLICKER_MAX_MS).toBeGreaterThan(ROW_FLICKER_MIN_MS);
  });

  it('plans a signal loss every 6-10 s, short, with two tear bands', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const plan = planSignalLoss(seeded(seed));
      expect(plan.delayMs).toBeGreaterThanOrEqual(SIGNAL_LOSS_MIN_DELAY_MS);
      expect(plan.delayMs).toBeLessThanOrEqual(SIGNAL_LOSS_MAX_DELAY_MS);
      expect(plan.durationMs).toBeGreaterThanOrEqual(360);
      expect(plan.durationMs).toBeLessThanOrEqual(520);
      expect(plan.tearPx).toBeGreaterThanOrEqual(10);
      expect(plan.tearPx).toBeLessThanOrEqual(22);
      for (const i of [1, 2]) {
        const top = parseFloat(plan.props[`--sl-t${i}`]);
        const bottom = parseFloat(plan.props[`--sl-u${i}`]);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeGreaterThan(top);
        expect(bottom).toBeLessThanOrEqual(100);
      }
    }
  });
});
