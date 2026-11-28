import { Color } from 'three';

/**
 * Colours for the whole renderer. Hex values are sRGB; `Color` stores them in the linear working space, which is
 * also what vertex colours and instance colours expect.
 *
 * There is no tone mapping: anything brighter than 1 simply clips on screen, so an emissive colour is authored as
 * a displayable hue times an intensity. Bloom reads the unclipped value, which is what makes the glow selective.
 */

export const BACKGROUND = 0x05060d;

/** Matt, non-glowing surfaces. All of them sit far below the bloom threshold. */
export const SURFACE = {
  /** The city floor, far below the roads: a touch above black so the shadows of the decks read on it. */
  ground: new Color(0x0a0c16),
  grid: new Color(0x1d2446),
  /** Clearly lighter than the ground and a shade towards violet, so the drivable area reads at a glance. */
  road: new Color(0x1c1e33),
  laneDash: new Color(0x363c62),
  startMark: new Color(0x464e74),
  wall: new Color(0x161927),
  post: new Color(0x1c2031),
  /** Pillars are hazards standing on the road: their body has to stand out from it, not merge with it. */
  pillar: new Color(0x3b4166),
  pillarCap: new Color(0x4a5180),
  decor: new Color(0x10121d),
} as const;

export interface Accent {
  readonly name: string;
  /** Displayable hue, every channel <= 1. */
  readonly base: Color;
  /** Emissive colour, brighter than 1 so bloom picks it up. */
  readonly glow: Color;
}

function accent(name: string, hex: number, intensity: number): Accent {
  const base = new Color(hex);
  return { name, base, glow: base.clone().multiplyScalar(intensity) };
}

/**
 * The six accent hues. Intensities differ because bloom thresholds on luminance, where blue and magenta weigh
 * little, and because a hue with two strong channels (amber, lime) turns yellow or white if it clips too far.
 */
export const ACCENTS: readonly Accent[] = [
  accent('cyan', 0x20e5ff, 2.2),
  accent('magenta', 0xff1fd0, 3.0),
  accent('amber', 0xff8a00, 1.7),
  accent('violet', 0x6a2bff, 3.2),
  accent('lime', 0x9dff00, 1.6),
  accent('hot pink', 0xff2d59, 2.6),
];

export const HUE = { cyan: 0, magenta: 1, amber: 2, violet: 3, lime: 4, hotPink: 5 } as const;

/** Accent for a level hue index; any integer is accepted and wraps around. */
export function accentFor(hue: number): Accent {
  const count = ACCENTS.length;
  return ACCENTS[(((hue | 0) % count) + count) % count];
}

/** The road as a raised deck: its side faces, supports and the paint on edges that have no barrier. */
export const DECK = {
  /** Side face of the slab: a shade lighter than the tarmac on top, so a raised road reads as raised. */
  side: new Color(0x2b3156),
  /** Thin line along the bottom of the slab. Dim: it outlines the deck without blooming. */
  lip: ACCENTS[HUE.violet].base.clone().multiplyScalar(0.9),
  support: new Color(0x1b1f33),
  supportRing: ACCENTS[HUE.cyan].glow.clone().multiplyScalar(0.7),
  /** Open edge: amber hazard stripes, a hot red line on the brink and a red line along the side face. */
  hazardStripe: ACCENTS[HUE.amber].glow.clone().multiplyScalar(1.05),
  hazardEdge: ACCENTS[HUE.hotPink].glow.clone().multiplyScalar(0.9),
  /** Additive red light on the deck along an open edge, fading inwards. */
  hazardGlow: ACCENTS[HUE.hotPink].base.clone().multiplyScalar(0.32),
} as const;

/** Multiply factor at the core of a deck's shadow on the city floor (1 = no shadow). */
export const FLOOR_SHADOW = { nearCore: 0.3, farCore: 0.7 } as const;

/** Sparks from a drift close to a wall, by how far the multiplier has climbed. */
export const PROXIMITY_SPARK = {
  low: ACCENTS[HUE.cyan].glow,
  mid: ACCENTS[HUE.magenta].glow,
  high: ACCENTS[HUE.amber].glow.clone().multiplyScalar(1.3),
} as const;

export const GATE = {
  checkpoint: ACCENTS[HUE.amber].glow,
  goalWhite: new Color(0xffffff).multiplyScalar(1.5),
  goalGreen: new Color(0x2bff88).multiplyScalar(1.8),
} as const;

export const CAR = {
  body: new Color(0x2a3050),
  glass: new Color(0x10162a),
  tyre: new Color(0x0b0c11),
  accent: ACCENTS[HUE.cyan].glow,
  headlight: new Color(0xfff1d0).multiplyScalar(2.4),
  headlightBeam: new Color(0xfff1d0).multiplyScalar(0.2),
  /** Scaled between `tailIdle` and `tailBraking` every frame. */
  tail: new Color(0xff1a2e),
  tailIdle: 0.9,
  tailBraking: 3.4,
  underglow: ACCENTS[HUE.magenta].glow.clone().multiplyScalar(0.4),
} as const;

/** Linear RGB triples written straight into vertex buffers. */
export const SKID = {
  rear: [0.95, 0.07, 0.62],
  front: [0.22, 0.3, 0.85],
} as const;

export const SMOKE_TINT = new Color(0.62, 0.5, 0.74);
export const SPARK = new Color(0xffc266).multiplyScalar(2.6);

export const BLOOM = {
  threshold: 0.25,
  smoothing: 0.2,
  radius: 0.72,
  intensity: 1.15,
  /** Used instead of `intensity` when the reduced-flash setting is on. */
  intensityReduced: 0.7,
} as const;

/** Multiplier at which the close-to-the-wall sparks have gone all the way to amber. */
export const PROXIMITY_TINT_TOP = 7;

/**
 * Colour of the close-to-the-wall sparks for a drift multiplier: cyan at x1, magenta half way, amber from
 * PROXIMITY_TINT_TOP up. Written into `out`, which is returned.
 */
export function proximityTint(multiplier: number, out: Color): Color {
  const k = Math.min(1, Math.max(0, (multiplier - 1) / (PROXIMITY_TINT_TOP - 1)));
  if (k <= 0.5) return out.copy(PROXIMITY_SPARK.low).lerp(PROXIMITY_SPARK.mid, k * 2);
  return out.copy(PROXIMITY_SPARK.mid).lerp(PROXIMITY_SPARK.high, (k - 0.5) * 2);
}
