/**
 * The weekly run's generator settings and the five fixed levels. Each level is a fixed seed plus its own options,
 * so it is the same for every player and only changes when GEN_VERSION does.
 */

import type { Level, LevelDef, TrackOptions } from '../types';
import { GEN_VERSION } from '../types';
import { generateTrack } from './trackGen';

/** This week's generated run: some hills, about one overpass, a little open edge. */
export const WEEKLY_OPTIONS: TrackOptions = {
  cells: [16, 24],
  halfWidth: [9, 11],
  elevation: 0.45,
  crossings: 1,
  openEdges: 0.12,
  bumpsPerKm: 1.5,
  twist: 0.5,
  plazas: 0.5,
  pillarsPerKm: 2.5,
};

/** Each level's tag was picked from a few hundred candidates for the clearest character at this GEN_VERSION. */
function levelSeed(id: string, tag: string): string {
  return `sigdrift|gen-v${GEN_VERSION}|level|${id}|${tag}`;
}

export const LEVELS: readonly LevelDef[] = [
  {
    id: 'L1',
    name: 'Glowline Boulevard',
    blurb: 'Wide, flowing and nearly flat. Learn to hold a slide under the signs.',
    difficulty: 1,
    seed: levelSeed('L1', 'glowline-96'),
    options: {
      cells: [16, 18],
      halfWidth: [10, 11.5],
      elevation: 0.08,
      crossings: 0,
      openEdges: 0,
      bumpsPerKm: 0,
      twist: 0.3,
      plazas: 0.4,
      pillarsPerKm: 1,
    },
  },
  {
    id: 'L2',
    name: 'Ciphers Alley',
    blurb: 'Hairpins, S-bends and open plazas packed with pillars. Pure technique.',
    difficulty: 2,
    seed: levelSeed('L2', 'ciphers-42'),
    options: {
      cells: [18, 22],
      halfWidth: [8.6, 10],
      elevation: 0.22,
      crossings: 0,
      openEdges: 0.04,
      bumpsPerKm: 0.8,
      twist: 0.95,
      plazas: 1,
      pillarsPerKm: 4.5,
    },
  },
  {
    id: 'L3',
    name: 'Vertigo Ramps',
    blurb: 'Climb the arcology, then drop off the crest. Big hills, one overpass.',
    difficulty: 3,
    seed: levelSeed('L3', 'vertigo-89'),
    options: {
      cells: [18, 22],
      halfWidth: [9, 10.5],
      elevation: 1,
      crossings: 1,
      openEdges: 0.18,
      bumpsPerKm: 1.5,
      twist: 0.45,
      plazas: 0.3,
      pillarsPerKm: 2,
    },
  },
  {
    id: 'L4',
    name: 'Knotwork Interchange',
    blurb: 'A tangle of flyovers: pass over and under your own line again and again.',
    difficulty: 4,
    seed: levelSeed('L4', 'knotwork-171'),
    options: {
      cells: [24, 27],
      halfWidth: [8.8, 10],
      elevation: 0.8,
      crossings: 3,
      openEdges: 0.22,
      bumpsPerKm: 1.5,
      twist: 0.6,
      plazas: 0.3,
      pillarsPerKm: 2.5,
    },
  },
  {
    id: 'L5',
    name: 'Skyway Zero',
    blurb: 'Long raised runs with open drops, bumps and no second chances. Stay on the deck.',
    difficulty: 5,
    seed: levelSeed('L5', 'skyway-122'),
    options: {
      cells: [22, 26],
      halfWidth: [7.8, 9],
      elevation: 0.95,
      crossings: 1,
      openEdges: 0.55,
      bumpsPerKm: 4,
      twist: 0.35,
      plazas: 0.15,
      pillarsPerKm: 3,
    },
  },
];

export function getLevelDef(id: string): LevelDef | null {
  return LEVELS.find((def) => def.id === id) ?? null;
}

/** The level for a definition (validated; deterministic for the def's seed and options). */
export function generateLevelFor(def: LevelDef): Level {
  return generateTrack(def.seed, def.id, def.options);
}
