/**
 * Text scramble: when a menu screen appears its headings and button labels flicker through glyphs and resolve to
 * their real text from left to right in about 300 ms.
 *
 * Nothing about the element's layout changes: the real text stays where it is but is painted transparent
 * (`sd-scr`), and the scrambled copy is drawn over it from the `data-scr` attribute by a pseudo-element (see
 * "Scramble" in styles.ts). Elements opt in with `data-scramble` and must hold plain text only.
 * Nothing runs while reduced flash (`sd-calm`) is on or the system asks for reduced motion.
 */

export const SCRAMBLE_GLYPHS = '#%$01<>/\\_=+*!?[]{}';
export const SCRAMBLE_MS = 300;
/** Later elements on a screen start a little after the first, so the screen resolves as a wave. */
export const SCRAMBLE_STAGGER_MS = 28;
const MAX_STAGGER_MS = 160;
/** Glyphs are redrawn at most this often, so the cycling reads as flicker rather than noise. */
const FRAME_MS = 40;
export const SCRAMBLE_ATTR = 'data-scramble';
const OVERLAY_ATTR = 'data-scr';
const ACTIVE_CLASS = 'sd-scr';

/**
 * One frame of the scramble. `progress` 0..1: characters before `progress * length` are resolved, the rest are
 * random glyphs. Whitespace is never scrambled, and the length never changes. `random` returns [0, 1).
 */
export function scrambleFrame(text: string, progress: number, random: () => number, glyphs = SCRAMBLE_GLYPHS): string {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1;
  if (p >= 1 || glyphs.length === 0) return text;
  const resolved = Math.floor(p * text.length);
  let out = text.slice(0, resolved);
  for (let i = resolved; i < text.length; i++) {
    const ch = text[i];
    out += ch.trim() === '' ? ch : glyphs[Math.min(glyphs.length - 1, Math.floor(random() * glyphs.length))];
  }
  return out;
}

/** Ease-out: most characters resolve early, the last few hang on a little. */
export function scrambleProgress(elapsedMs: number, durationMs = SCRAMBLE_MS): number {
  if (!(durationMs > 0) || elapsedMs >= durationMs) return 1;
  if (elapsedMs <= 0) return 0;
  const t = elapsedMs / durationMs;
  return 1 - (1 - t) * (1 - t);
}

/** Start delay of the `index`-th element on a screen. */
export function scrambleDelay(index: number): number {
  return Math.min(MAX_STAGGER_MS, Math.max(0, index) * SCRAMBLE_STAGGER_MS);
}

// ---- DOM ------------------------------------------------------------------------------------------------------

export interface ScrambleHandle {
  /** Stops at once and shows the real text. */
  cancel(): void;
}

function blocked(root: Element): boolean {
  if (root.classList.contains('sd-calm')) return true;
  try {
    return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Scrambles every `[data-scramble]` element inside `container` once. `root` is the UI root whose `sd-calm` class
 * turns it off. Safe to cancel at any point, more than once.
 */
export function scrambleIn(container: ParentNode, root: Element, random: () => number = Math.random): ScrambleHandle {
  const nodes: { node: HTMLElement; text: string; delay: number }[] = [];
  if (!blocked(root)) {
    let index = 0;
    for (const node of container.querySelectorAll<HTMLElement>(`[${SCRAMBLE_ATTR}]`)) {
      const text = node.textContent ?? '';
      if (text.trim() === '') continue;
      nodes.push({ node, text, delay: scrambleDelay(index++) });
    }
  }
  let frame = 0;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let start = -1;
  let lastDraw = -Infinity;
  let done = nodes.length === 0;

  function finish(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (fallback !== null) clearTimeout(fallback);
    fallback = null;
    for (const { node } of nodes) {
      node.classList.remove(ACTIVE_CLASS);
      node.removeAttribute(OVERLAY_ATTR);
    }
    done = true;
  }

  function draw(now: number): void {
    frame = 0;
    if (done) return;
    if (start < 0) start = now;
    const elapsed = now - start;
    const redraw = now - lastDraw >= FRAME_MS;
    if (redraw) lastDraw = now;
    let running = false;
    for (const item of nodes) {
      const progress = scrambleProgress(elapsed - item.delay);
      if (progress >= 1) {
        if (item.node.classList.contains(ACTIVE_CLASS)) {
          item.node.classList.remove(ACTIVE_CLASS);
          item.node.removeAttribute(OVERLAY_ATTR);
        }
        continue;
      }
      running = true;
      if (redraw) item.node.setAttribute(OVERLAY_ATTR, scrambleFrame(item.text, progress, random));
    }
    if (running) frame = requestAnimationFrame(draw);
    else finish();
  }

  if (!done) {
    for (const item of nodes) {
      item.node.setAttribute(OVERLAY_ATTR, scrambleFrame(item.text, 0, random));
      item.node.classList.add(ACTIVE_CLASS);
    }
    frame = requestAnimationFrame(draw);
    // Animation frames stop in a hidden tab: the real text must come back regardless.
    const last = nodes[nodes.length - 1];
    fallback = setTimeout(finish, (last ? last.delay : 0) + SCRAMBLE_MS + 120);
  }

  return {
    cancel() {
      if (!done) finish();
    },
  };
}
