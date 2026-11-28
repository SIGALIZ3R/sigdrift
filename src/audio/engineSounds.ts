/**
 * Each garage car's engine character: multipliers on the shared engine synth (engine.ts), plus an electric whine
 * for a car with no combustion at all. 1 everywhere is the stock car.
 */
export interface EngineSound {
  /** Pitch of the whole engine at a given rev: higher = smaller, higher-revving engine. */
  pitch: number;
  /** How hard the combustion is driven into the distortion: rasp. */
  grit: number;
  /** Brightness: scales the exhaust low-pass cut-off. */
  tone: number;
  /** The synth saw layer under the engine: body and drone. */
  saw: number;
  /** Combustion noise: crackle and breath. */
  noise: number;
  /** Combustion as a whole (0 = electric: no engine note, only the whine). */
  combustion: number;
  /** Electric motor whine, rising with road speed. */
  whine: number;
  /** Overall level. */
  level: number;
}

export const STOCK_ENGINE: Readonly<EngineSound> = Object.freeze({
  pitch: 1,
  grit: 1,
  tone: 1,
  saw: 1,
  noise: 1,
  combustion: 1,
  whine: 0,
  level: 1,
});

function engine(changes: Partial<EngineSound>): Readonly<EngineSound> {
  return Object.freeze({ ...STOCK_ENGINE, ...changes });
}

const SOUNDS: Record<string, Readonly<EngineSound>> = {
  // Balanced straight-six coupe.
  phantom: STOCK_ENGINE,
  // High-revving V10 scream: up an octave-ish, bright, clean.
  viper: engine({ pitch: 1.38, grit: 0.85, tone: 1.4, saw: 0.65, noise: 0.75 }),
  // Big V8 burble: low, thick, crackly.
  brute: engine({ pitch: 0.72, grit: 1.35, tone: 0.72, saw: 1.3, noise: 1.3, level: 1.06 }),
  // Buzzy turbo four of a rally hatch: raspy, nasal, lots of noise.
  ronin: engine({ pitch: 1.16, grit: 1.6, tone: 1.55, saw: 0.45, noise: 1.6, level: 0.95 }),
  // Electric: no combustion, a rising motor whine with a faint synth bed.
  halo: engine({ combustion: 0, saw: 0.35, whine: 1, level: 1 }),
  // Heavy armoured hauler: a slow, low diesel drone.
  kaiju: engine({ pitch: 0.56, grit: 1.2, tone: 0.58, saw: 1.6, noise: 0.95, level: 1.1 }),
};

/** The engine sound of garage car `id`; unknown ids get the stock engine. */
export function engineSoundFor(id: string): Readonly<EngineSound> {
  return SOUNDS[id] ?? STOCK_ENGINE;
}
