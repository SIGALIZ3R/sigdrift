import type { Bump } from '../types';

/**
 * Height of the ground, for everything the renderer stands on it: the car's shadow, skid marks, smoke, sparks.
 * The weekly level is flat; the endless road has bumps (see `Bump` in types.ts for the shape).
 *
 * This is the renderer's own copy of the formula, with Math.cos: it only has to agree with the simulation to well
 * under a millimetre, not bit for bit.
 */
export interface Ground {
  heightAt(x: number, z: number): number;
}

export const FLAT_GROUND: Ground = {
  heightAt: () => 0,
};

/**
 * A road edge that lies exactly on a bump's side limit must not fall off it through rounding: the road surface
 * and the wall standing on its edge would then disagree about the height there.
 */
const EDGE_TOLERANCE = 1e-3;

/** Slope of the ground at the point last passed to `bumpHeightAt`: metres of rise per metre along x and z. */
export const bumpSlope = { x: 0, z: 0 };

/** Ground height at (x, z) from the first `count` bumps of `bumps`: the highest one that covers the point. */
export function bumpHeightAt(bumps: readonly Bump[], count: number, x: number, z: number): number {
  let best = 0;
  bumpSlope.x = 0;
  bumpSlope.z = 0;
  for (let i = 0; i < count; i++) {
    const bump = bumps[i];
    const dx = x - bump.x;
    const dz = z - bump.z;
    const u = dx * bump.dirX + dz * bump.dirZ;
    if (u <= -bump.halfLength || u >= bump.halfLength) continue;
    const v = dz * bump.dirX - dx * bump.dirZ;
    if (v < -bump.halfWidth - EDGE_TOLERANCE || v > bump.halfWidth + EDGE_TOLERANCE) continue;
    const phase = (Math.PI * u) / bump.halfLength;
    const h = bump.height * 0.5 * (1 + Math.cos(phase));
    if (h <= best) continue;
    best = h;
    const slope = (-bump.height * 0.5 * Math.PI * Math.sin(phase)) / bump.halfLength;
    bumpSlope.x = slope * bump.dirX;
    bumpSlope.z = slope * bump.dirZ;
  }
  return best;
}

/** Sharpest bend of a bump's profile, 1/m: what decides how finely it has to be cut into flat pieces. */
export function bumpCurvature(bump: Bump): number {
  const k = Math.PI / Math.max(bump.halfLength, 1e-3);
  return 0.5 * Math.abs(bump.height) * k * k;
}

/** How far a straight piece may sag below (or stand above) the true curve, m. */
const MAX_SAG = 0.004;
const MIN_STEP = 0.15;
const MAX_STEP = 0.5;

/**
 * Length of the flat pieces a bump is built from, m: short enough that the faceted surface stays within a few
 * millimetres of the real one, so the car (which follows the real one) never visibly floats or sinks.
 */
export function bumpStep(bump: Bump): number {
  const curvature = bumpCurvature(bump);
  if (curvature <= 0) return MAX_STEP;
  return Math.min(MAX_STEP, Math.max(MIN_STEP, Math.sqrt((8 * MAX_SAG) / curvature)));
}

/** True when the stretch from a to b, widened by `pad` metres all round, may touch the bump. Errs towards yes. */
function nearOne(bump: Bump, ax: number, az: number, bx: number, bz: number, pad: number): boolean {
  const ua = (ax - bump.x) * bump.dirX + (az - bump.z) * bump.dirZ;
  const ub = (bx - bump.x) * bump.dirX + (bz - bump.z) * bump.dirZ;
  if (Math.min(ua, ub) - pad >= bump.halfLength || Math.max(ua, ub) + pad <= -bump.halfLength) return false;
  const va = (az - bump.z) * bump.dirX - (ax - bump.x) * bump.dirZ;
  const vb = (bz - bump.z) * bump.dirX - (bx - bump.x) * bump.dirZ;
  return Math.min(va, vb) - pad <= bump.halfWidth && Math.max(va, vb) + pad >= -bump.halfWidth;
}

/**
 * How finely the stretch from a to b has to be cut up: the shortest `bumpStep` among the bumps it may touch once
 * widened by `pad` metres all round, or 0 when it touches none. When this says 0 the ground is flat everywhere
 * within `pad` of the stretch.
 */
export function stepNear(
  bumps: readonly Bump[],
  count: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  pad: number,
): number {
  let step = 0;
  for (let i = 0; i < count; i++) {
    if (!nearOne(bumps[i], ax, az, bx, bz, pad)) continue;
    const s = bumpStep(bumps[i]);
    if (step === 0 || s < step) step = s;
  }
  return step;
}
