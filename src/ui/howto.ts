/**
 * The HOW TO PLAY cards: a title, one big diagram drawn in inline SVG, and a line or two of text each.
 * The diagrams take their colours from the stylesheet (classes `hw-*`, see "How to play" in styles.ts).
 */

export interface HowToCard {
  title: string;
  lines: readonly string[];
  /** Inline SVG markup (static, written here: never built from data). */
  svg: string;
}

const VIEW = 'viewBox="0 0 320 150" role="img" focusable="false"';

function key(x: number, y: number, label: string, w = 34): string {
  return `<g class="hw-key"><rect x="${x}" y="${y}" width="${w}" height="34" rx="3"/><text x="${x + w / 2}" y="${y + 23}" text-anchor="middle">${label}</text></g>`;
}

/** A car seen from above, nose along +x, centred on (x, y), turned by `deg`. */
function car(x: number, y: number, deg: number, extra = ''): string {
  return `<g class="hw-car ${extra}" transform="translate(${x} ${y}) rotate(${deg})"><rect x="-14" y="-7" width="28" height="14" rx="2"/><rect class="hw-nose" x="7" y="-6" width="6" height="12" rx="1"/></g>`;
}

const DRIVE = `<svg ${VIEW} aria-label="W A S D keys or the arrow keys drive the car">
  ${key(73, 18, 'W')}${key(35, 56, 'A')}${key(73, 56, 'S')}${key(111, 56, 'D')}
  <text class="hw-or" x="160" y="78" text-anchor="middle">or</text>
  ${key(213, 18, '↑')}${key(175, 56, '←')}${key(213, 56, '↓')}${key(251, 56, '→')}
  <text class="hw-cap hw-cyan" x="90" y="112" text-anchor="middle">W  THROTTLE</text>
  <text class="hw-cap" x="90" y="128" text-anchor="middle">S  BRAKE / REVERSE</text>
  <text class="hw-cap" x="90" y="144" text-anchor="middle">A D  STEER</text>
  <text class="hw-cap hw-cyan" x="230" y="112" text-anchor="middle">↑  THROTTLE</text>
  <text class="hw-cap" x="230" y="128" text-anchor="middle">↓  BRAKE / REVERSE</text>
  <text class="hw-cap" x="230" y="144" text-anchor="middle">← →  STEER</text>
</svg>`;

function tag(x: number, y: number, n: number, extra = ''): string {
  return `<g class="hw-tag ${extra}"><circle cx="${x}" cy="${y}" r="7"/><text x="${x}" y="${y + 3.5}" text-anchor="middle">${n}</text></g>`;
}

const DRIFT = `<svg ${VIEW} aria-label="Turn in, the tail slides out, countersteer and throttle hold the drift">
  <defs><marker id="hw-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8z" class="hw-tipfill"/></marker></defs>
  <path class="hw-road" d="M22 150 C 22 76, 70 36, 150 36 L 320 36"/>
  <path class="hw-trail" d="M22 124 C 26 96, 40 78, 56 66 S 110 42, 146 40"/>
  ${car(22, 122, -90)}
  ${car(56, 66, -8, 'hw-hot')}
  ${car(146, 40, 24, 'hw-hot')}
  ${car(256, 36, 0)}
  <path class="hw-arrow" d="M150 44 l 34 -4" marker-end="url(#hw-tip)"/>
  ${tag(40, 132, 1)}${tag(76, 88, 2, 'hw-tag-hot')}${tag(146, 9, 3, 'hw-tag-hot')}${tag(256, 9, 4)}
  <text class="hw-cap" x="124" y="80">1  TURN IN AT SPEED</text>
  <text class="hw-cap hw-magenta" x="124" y="94">2  THE TAIL STEPS OUT</text>
  <text class="hw-cap hw-cyan" x="124" y="108">3  COUNTERSTEER + THROTTLE</text>
  <text class="hw-cap" x="124" y="122">4  HOLD THE ANGLE</text>
  <g class="hw-key hw-key-wide"><rect x="124" y="130" width="52" height="18" rx="2"/><text x="150" y="143" text-anchor="middle">SPACE</text></g>
  <text class="hw-cap hw-amber" x="184" y="143">HANDBRAKE KICKS IT</text>
</svg>`;

const SCORE = `<svg ${VIEW} aria-label="Drift close to a wall for more points and a faster multiplier">
  <rect class="hw-wall" x="10" y="14" width="300" height="8"/>
  <g class="hw-prox">
    <rect x="60" y="26" width="200" height="6" class="hw-p3"/>
    <rect x="60" y="34" width="200" height="6" class="hw-p2"/>
    <rect x="60" y="42" width="200" height="6" class="hw-p1"/>
  </g>
  <path class="hw-trail" d="M20 70 C 80 58, 120 40, 190 40"/>
  ${car(190, 40, 28, 'hw-hot')}
  <text class="hw-pts" x="214" y="80">+480</text>
  <g class="hw-badge"><rect x="236" y="96" width="66" height="30" rx="2"/><text x="269" y="117" text-anchor="middle">x4.2</text></g>
  <text class="hw-cap hw-cyan" x="20" y="104">CLOSER TO THE WALL</text>
  <text class="hw-cap" x="20" y="120">= MORE POINTS</text>
  <text class="hw-cap hw-magenta" x="20" y="136">= MULTIPLIER CLIMBS FASTER</text>
</svg>`;

const CRASH = `<svg ${VIEW} aria-label="A crash resets the multiplier but keeps the points">
  <rect class="hw-wall" x="150" y="10" width="8" height="90"/>
  ${car(128, 55, -15)}
  <path class="hw-spark" d="M146 40 l 18 -14 M150 56 l 22 2 M146 70 l 16 14 M150 48 l 20 -6 M150 64 l 18 8"/>
  <g class="hw-badge hw-broken"><rect x="200" y="22" width="66" height="30" rx="2"/><text x="233" y="43" text-anchor="middle">x4.2</text>
  <path d="M196 54 L 272 20"/></g>
  <text class="hw-arrowtext" x="233" y="72" text-anchor="middle">↓</text>
  <g class="hw-badge hw-one"><rect x="200" y="78" width="66" height="30" rx="2"/><text x="233" y="99" text-anchor="middle">x1.0</text></g>
  <text class="hw-cap hw-red" x="20" y="124">HIT SOMETHING = MULTIPLIER LOST</text>
  <text class="hw-cap hw-cyan" x="20" y="142">12,480 POINTS — KEPT</text>
</svg>`;

const DANGER = `<svg ${VIEW} aria-label="Edges with hazard stripes have no barrier: you can fall off">
  <defs><pattern id="hw-haz" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" class="hw-hazfill"/></pattern></defs>
  <rect class="hw-deck" x="10" y="20" width="170" height="52"/>
  <rect x="10" y="66" width="170" height="8" fill="url(#hw-haz)"/>
  <rect class="hw-wall" x="10" y="14" width="170" height="6"/>
  <line class="hw-floor" x1="0" y1="134" x2="320" y2="134"/>
  <text class="hw-cap hw-dim" x="252" y="147">CITY FLOOR</text>
  ${car(150, 50, 35, 'hw-hot')}
  <path class="hw-fall" d="M166 64 C 196 80, 232 98, 248 122"/>
  ${car(254, 120, 70, 'hw-ghost')}
  <text class="hw-cap hw-amber" x="16" y="94">NO BARRIER</text>
  <text class="hw-cap" x="16" y="110">FALL = BACK TO CHECKPOINT</text>
  <text class="hw-cap hw-red" x="16" y="126">ENDLESS: FALL = RUN OVER</text>
</svg>`;

const MODES = `<svg ${VIEW} aria-label="Three ways to play: this week, levels, endless">
  <g class="hw-mode"><rect x="10" y="14" width="92" height="92" rx="2"/>
    <rect class="hw-cal" x="36" y="36" width="40" height="36"/><line class="hw-cal" x1="36" y1="46" x2="76" y2="46"/>
    <text x="56" y="66" text-anchor="middle" class="hw-small">W48</text></g>
  <g class="hw-mode hw-mode-mid"><rect x="114" y="14" width="92" height="92" rx="2"/>
    <rect class="hw-pip on" x="126" y="54" width="10" height="14"/><rect class="hw-pip on" x="140" y="54" width="10" height="14"/>
    <rect class="hw-pip on" x="154" y="54" width="10" height="14"/><rect class="hw-pip" x="168" y="54" width="10" height="14"/>
    <rect class="hw-pip" x="182" y="54" width="10" height="14"/></g>
  <g class="hw-mode hw-mode-end"><rect x="218" y="14" width="92" height="92" rx="2"/>
    <text x="264" y="74" text-anchor="middle" class="hw-inf">∞</text></g>
  <text class="hw-cap hw-cyan" x="56" y="126" text-anchor="middle">THIS WEEK</text>
  <text class="hw-cap" x="56" y="142" text-anchor="middle">NEW TRACK WEEKLY</text>
  <text class="hw-cap hw-cyan" x="160" y="126" text-anchor="middle">LEVELS</text>
  <text class="hw-cap" x="160" y="142" text-anchor="middle">FIVE TRACKS</text>
  <text class="hw-cap hw-magenta" x="264" y="126" text-anchor="middle">ENDLESS</text>
  <text class="hw-cap" x="264" y="142" text-anchor="middle">HOW FAR?</text>
</svg>`;

export const HOWTO_CARDS: readonly HowToCard[] = [
  { title: 'Drive', lines: ['W / ↑ to go, S / ↓ to brake and reverse, A D / ← → to steer.', 'Gamepad: triggers and left stick.'], svg: DRIVE },
  {
    title: 'Drift',
    lines: ['Turn in at speed and the tail steps out. Catch it with countersteer, hold it on the throttle.', 'Space (handbrake) kicks a drift.'],
    svg: DRIFT,
  },
  { title: 'Score', lines: ['Points flow while you drift. The closer to a wall, the more points — and the faster your multiplier climbs.'], svg: SCORE },
  { title: 'Crashes', lines: ['Hit something and your multiplier drops back to x1. The points you already have stay.'], svg: CRASH },
  {
    title: 'Danger',
    lines: ['Hazard-striped edges have no barrier. Fall off and you are put back at the last checkpoint.', 'In Endless a fall ends the run — and so do three crashes.'],
    svg: DANGER,
  },
  { title: 'Modes', lines: ['A new track every week, five fixed levels, and an endless road.'], svg: MODES },
];

/** Parses one card's diagram into an element. */
export function diagram(svg: string): Element {
  const template = document.createElement('template');
  template.innerHTML = svg.trim();
  const node = template.content.firstElementChild;
  if (!node) throw new Error('empty diagram');
  node.setAttribute('class', 'sd-howto-svg');
  node.setAttribute('aria-hidden', 'false');
  return node;
}
