/**
 * Moving focus between a menu's controls with the arrow keys, the d-pad or the left stick.
 *
 * The choice is spatial: from the focused control, the nearest control whose centre lies in the pressed direction,
 * favouring ones in line with it. When nothing lies that way, focus wraps round in list (document) order: down or
 * right past the last control goes to the first, up or left before the first goes to the last.
 * The pure part (`nextIndex`) works on plain rectangles so it can be tested without a page.
 */

export type NavDir = 'up' | 'down' | 'left' | 'right';

export interface NavRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How much a sideways offset counts against a candidate, relative to its distance along the direction. */
const CROSS_WEIGHT = 2;
/** Centres closer than this along the direction (px) count as level with each other, not "beyond". */
const LEVEL_SLACK = 4;

function centreX(r: NavRect): number {
  return r.left + r.width / 2;
}

function centreY(r: NavRect): number {
  return r.top + r.height / 2;
}

/** The index of the control in `dir` from `from`, or -1 when nothing lies that way. */
export function spatialIndex(rects: readonly NavRect[], from: number, dir: NavDir): number {
  const origin = rects[from];
  if (!origin) return -1;
  const ox = centreX(origin);
  const oy = centreY(origin);
  const vertical = dir === 'up' || dir === 'down';
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const r = rects[i];
    if (r.width <= 0 && r.height <= 0) continue;
    const dx = centreX(r) - ox;
    const dy = centreY(r) - oy;
    const along = (vertical ? dy : dx) * sign;
    if (along <= LEVEL_SLACK) continue;
    // Sideways offset, measured to the candidate's nearest edge so a wide card straight below counts as in line.
    let cross: number;
    if (vertical) {
      cross = ox < r.left ? r.left - ox : ox > r.left + r.width ? ox - (r.left + r.width) : 0;
    } else {
      cross = oy < r.top ? r.top - oy : oy > r.top + r.height ? oy - (r.top + r.height) : 0;
    }
    const score = along + cross * CROSS_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Previous / next in list order, wrapping. */
export function listIndex(count: number, from: number, dir: NavDir): number {
  if (count <= 0) return -1;
  if (from < 0 || from >= count) return dir === 'up' || dir === 'left' ? count - 1 : 0;
  const step = dir === 'up' || dir === 'left' ? -1 : 1;
  return (from + step + count) % count;
}

/**
 * Where focus goes from control `from` (-1 when nothing is focused) when `dir` is pressed. Returns -1 only when
 * there are no controls. Nothing focused: the first control (or the last one, for up / left).
 */
export function nextIndex(rects: readonly NavRect[], from: number, dir: NavDir): number {
  if (rects.length === 0) return -1;
  if (from < 0 || from >= rects.length) return listIndex(rects.length, -1, dir);
  const spatial = spatialIndex(rects, from, dir);
  return spatial >= 0 ? spatial : listIndex(rects.length, from, dir);
}

// ---- DOM ------------------------------------------------------------------------------------------------------

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [data-nav]';

/** The controls focus can move between inside `container`, in document order. Hidden ones are left out. */
export function navItems(container: ParentNode): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const node of container.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (node.getAttribute('data-nav') === 'skip') continue;
    if (node.closest('.sd-hidden')) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 && box.height <= 0) continue;
    items.push(node);
  }
  return items;
}

/**
 * Moves focus inside `container` one step in `dir`. Returns the newly focused control, or null when focus did not
 * move (no controls, or only the one already focused).
 */
export function moveFocus(container: ParentNode, dir: NavDir): HTMLElement | null {
  const items = navItems(container);
  if (items.length === 0) return null;
  const active = document.activeElement;
  const from = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const rects = items.map((node) => node.getBoundingClientRect());
  const to = nextIndex(rects, from, dir);
  if (to < 0 || to === from) return null;
  const target = items[to];
  target.focus({ preventScroll: false });
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return target;
}
