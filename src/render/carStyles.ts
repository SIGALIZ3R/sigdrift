import { Color } from 'three';
import { ACCENTS, CAR, HUE } from './palette';

/**
 * How each garage car looks. Side silhouettes are [x / halfLength, height in metres], running front to rear; the
 * body is extruded across the car's full width and the cabin across `cabinWidth` of it.
 */
export interface CarStyle {
  bodyTop: readonly (readonly [number, number])[];
  bodyUnderside: readonly (readonly [number, number])[];
  cabin: readonly (readonly [number, number])[];
  cabinWidth: number;
  body: Color;
  glass: Color;
  /** The neon lines along the shoulders. */
  accent: Color;
  /** The light under the car. */
  underglow: Color;
  /** A rear wing: [x / halfLength of its leading edge, height] or null for none. */
  wing: readonly [number, number] | null;
  /** Neon stripes along the bonnet's centreline. */
  bonnetStripes: boolean;
  /** A row of lamps along the front of the roof (rally and off-road lights). */
  roofLights: boolean;
  /** One headlight bar across the whole nose, and one across the tail, in place of two lamps. */
  lightBar: boolean;
}

/** The stock coupe (Phantom): cyan shoulders, magenta underglow. */
const PHANTOM: CarStyle = {
  bodyTop: [
    [1, 0.5],
    [0.86, 0.6],
    [0.3, 0.74],
    [-0.72, 0.8],
    [-1, 0.76],
  ],
  bodyUnderside: [
    [-1, 0.3],
    [-0.94, 0.24],
    [0.92, 0.24],
    [1, 0.34],
  ],
  cabin: [
    [0.3, 0.72],
    [0, 1.14],
    [-0.4, 1.17],
    [-0.76, 0.78],
  ],
  cabinWidth: 0.8,
  body: CAR.body,
  glass: CAR.glass,
  accent: CAR.accent,
  underglow: CAR.underglow,
  wing: null,
  bonnetStripes: false,
  roofLights: false,
  lightBar: false,
};

/** A low wedge (Viper): pale body, magenta lines, a long raked canopy and a rear wing. */
const VIPER: CarStyle = {
  bodyTop: [
    [1, 0.36],
    [0.7, 0.5],
    [0.1, 0.66],
    [-0.8, 0.72],
    [-1, 0.7],
  ],
  bodyUnderside: [
    [-1, 0.28],
    [-0.95, 0.2],
    [0.9, 0.2],
    [1, 0.28],
  ],
  cabin: [
    [0.25, 0.64],
    [-0.1, 0.98],
    [-0.42, 1.0],
    [-0.7, 0.71],
  ],
  cabinWidth: 0.72,
  body: new Color(0x8a90b8),
  glass: new Color(0x120a24),
  accent: ACCENTS[HUE.magenta].glow,
  underglow: ACCENTS[HUE.cyan].glow.clone().multiplyScalar(0.35),
  wing: [-0.82, 1.0],
  bonnetStripes: false,
  roofLights: false,
  lightBar: false,
};

/** A long-bonnet muscle car (Brute): dark body, amber lines, twin bonnet stripes, a tall square cabin set back. */
const BRUTE: CarStyle = {
  bodyTop: [
    [1, 0.62],
    [0.92, 0.7],
    [0.1, 0.76],
    [-0.85, 0.82],
    [-1, 0.8],
  ],
  bodyUnderside: [
    [-1, 0.32],
    [-0.96, 0.26],
    [0.94, 0.26],
    [1, 0.36],
  ],
  cabin: [
    [0.05, 0.74],
    [-0.15, 1.22],
    [-0.6, 1.24],
    [-0.8, 0.8],
  ],
  cabinWidth: 0.86,
  body: new Color(0x1c1420),
  glass: new Color(0x0a0c16),
  accent: ACCENTS[HUE.amber].glow,
  underglow: ACCENTS[HUE.amber].base.clone().multiplyScalar(0.4),
  wing: null,
  bonnetStripes: true,
  roofLights: false,
  lightBar: false,
};

/** A short boxy rally hatch (Ronin): olive body, lime lines, a tall cabin running to the tail, roof lamps. */
const RONIN: CarStyle = {
  bodyTop: [
    [1, 0.6],
    [0.82, 0.7],
    [0.4, 0.78],
    [-0.6, 0.8],
    [-1, 0.78],
  ],
  bodyUnderside: [
    [-1, 0.34],
    [-0.94, 0.28],
    [0.92, 0.28],
    [1, 0.38],
  ],
  cabin: [
    [0.42, 0.76],
    [0.12, 1.26],
    [-0.88, 1.24],
    [-0.98, 0.78],
  ],
  cabinWidth: 0.84,
  body: new Color(0x2e3a1c),
  glass: new Color(0x0b120a),
  accent: ACCENTS[HUE.lime].glow,
  underglow: ACCENTS[HUE.lime].base.clone().multiplyScalar(0.32),
  wing: [-0.98, 1.3],
  bonnetStripes: false,
  roofLights: true,
  lightBar: false,
};

/** A smooth electric teardrop (Halo): pearl body, white light lines, cyan underglow, a long bubble canopy, light bars nose and tail. */
const HALO: CarStyle = {
  bodyTop: [
    [1, 0.42],
    [0.75, 0.56],
    [0.2, 0.68],
    [-0.65, 0.72],
    [-1, 0.6],
  ],
  bodyUnderside: [
    [-1, 0.26],
    [-0.95, 0.2],
    [0.92, 0.2],
    [1, 0.3],
  ],
  cabin: [
    [0.5, 0.6],
    [0.05, 1.02],
    [-0.5, 1.02],
    [-0.92, 0.64],
  ],
  cabinWidth: 0.78,
  body: new Color(0xc8cce0),
  glass: new Color(0x061826),
  // Cool white light lines: the only car without a coloured neon.
  accent: new Color(0xe8f4ff).multiplyScalar(1.9),
  underglow: ACCENTS[HUE.cyan].base.clone().multiplyScalar(0.45),
  wing: null,
  bonnetStripes: false,
  roofLights: false,
  lightBar: true,
};

/** An armoured hauler (Kaiju): gunmetal body, violet lines, a raised cab up front and a cargo bed behind. */
const KAIJU: CarStyle = {
  bodyTop: [
    [1, 0.78],
    [0.9, 0.86],
    [0.45, 0.9],
    [-0.4, 0.92],
    [-1, 0.92],
  ],
  bodyUnderside: [
    [-1, 0.38],
    [-0.96, 0.3],
    [0.94, 0.3],
    [1, 0.42],
  ],
  cabin: [
    [0.5, 0.88],
    [0.3, 1.42],
    [-0.25, 1.42],
    [-0.3, 0.9],
  ],
  cabinWidth: 0.9,
  body: new Color(0x2a2838),
  glass: new Color(0x0c0a18),
  accent: ACCENTS[HUE.violet].glow,
  underglow: ACCENTS[HUE.violet].base.clone().multiplyScalar(0.5),
  wing: null,
  bonnetStripes: true,
  roofLights: true,
  lightBar: false,
};

const STYLES: Record<string, CarStyle> = { phantom: PHANTOM, viper: VIPER, brute: BRUTE, ronin: RONIN, halo: HALO, kaiju: KAIJU };

/** The look for a garage car id; unknown ids get the stock coupe. */
export function carStyle(id: string): CarStyle {
  return STYLES[id] ?? PHANTOM;
}
