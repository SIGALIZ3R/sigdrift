/**
 * Lateral tyre curve. Pure functions of slip angle, shared by both axles.
 *
 * With x = |slip| * stiffness / grip the curve is:
 *   x <= 2: grip * x * (1 - x / 4)                 slope `stiffness` at zero, flat-topped peak of `grip` at x = 2
 *   x >  2: falls along a bell from `grip` towards `grip * slideGrip`
 * Both pieces have zero slope at the peak, so the force never jumps as a tyre lets go.
 */

/** Normalised slip at which the curve peaks. */
export const PEAK_SLIP_RATIO = 2;

/** How far past the peak (in normalised slip) the grip has fallen halfway to its sliding value. */
const FALLOFF_WIDTH = 2;

/** Slip angle (rad) at which a tyre with this stiffness and grip is at its peak. */
export function peakSlipAngle(stiffness: number, grip: number): number {
  return stiffness > 0 ? (PEAK_SLIP_RATIO * grip) / stiffness : 0;
}

/**
 * Lateral force as a multiple of axle load, with the sign of `slip` (the force itself opposes the slip).
 * Exactly odd in `slip`.
 */
export function lateralForceCoefficient(slip: number, stiffness: number, grip: number, slideGrip: number): number {
  if (!(grip > 0) || !(stiffness > 0)) return 0;
  const ratio = (Math.abs(slip) * stiffness) / grip;
  let shape: number;
  if (ratio <= PEAK_SLIP_RATIO) {
    shape = ratio * (1 - ratio / (2 * PEAK_SLIP_RATIO));
  } else {
    const past = (ratio - PEAK_SLIP_RATIO) / FALLOFF_WIDTH;
    shape = slideGrip + (1 - slideGrip) / (1 + past * past);
  }
  return slip < 0 ? -grip * shape : grip * shape;
}
