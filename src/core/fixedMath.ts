/**
 * Deterministic maths for the simulation and the generator.
 *
 * Built only from + - * / Math.floor Math.abs Math.sqrt, which IEEE-754 defines exactly, so every result is
 * bit-identical on every JS engine. Math.sin/cos/atan2 are implementation-defined and must not be used in the sim.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

const TWO_OVER_PI = 0.6366197723675814;
// PI/2 split in two so that k * PIO2_HI is exact for |k| < 2^20 (the high part has only 33 significant bits).
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;

// Minimax coefficients for sin and cos on [-PI/4, PI/4] (error below 1e-16).
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function sinPoly(r: number, z: number): number {
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function cosPoly(z: number): number {
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** sin(x + quarterTurns * PI/2) for x >= 0. */
function sinShifted(x: number, quarterTurns: number): number {
  const k = Math.floor(x * TWO_OVER_PI + 0.5);
  let r = x - k * PIO2_HI - k * PIO2_LO;
  // Beyond ~1e15 a double no longer resolves the angle and r is meaningless: keep it bounded so the result is finite.
  if (r > 1) r = 1;
  else if (r < -1) r = -1;
  const n = k + quarterTurns;
  const quadrant = n - 4 * Math.floor(n / 4);
  const z = r * r;
  if (quadrant === 0) return sinPoly(r, z);
  if (quadrant === 1) return cosPoly(z);
  if (quadrant === 2) return -sinPoly(r, z);
  return -cosPoly(z);
}

/** Exactly odd: sin(-x) === -sin(x). */
export function sin(x: number): number {
  return x < 0 ? -sinShifted(-x, 0) : sinShifted(x, 0);
}

/** Exactly even: cos(-x) === cos(x). */
export function cos(x: number): number {
  return sinShifted(Math.abs(x), 1);
}

const TAN_PI_12 = 0.2679491924311227;
const SQRT3 = 1.7320508075688772;
const PI_6 = 0.5235987755982988;
const A1 = -1 / 3;
const A2 = 1 / 5;
const A3 = -1 / 7;
const A4 = 1 / 9;
const A5 = -1 / 11;
const A6 = 1 / 13;
const A7 = -1 / 15;
const A8 = 1 / 17;
const A9 = -1 / 19;
const A10 = 1 / 21;
const A11 = -1 / 23;
const A12 = 1 / 25;

/** Taylor series; the first dropped term is below 2e-17 for |t| <= tan(PI/12). */
function atanSeries(t: number): number {
  const z = t * t;
  const tail = A7 + z * (A8 + z * (A9 + z * (A10 + z * (A11 + z * A12))));
  return t * (1 + z * (A1 + z * (A2 + z * (A3 + z * (A4 + z * (A5 + z * (A6 + z * tail)))))));
}

/** atan(t) for 0 <= t <= 1. Shifts the upper part of the range down by PI/6 so the series converges fast. */
function atanUnit(t: number): number {
  if (t > TAN_PI_12) return PI_6 + atanSeries((SQRT3 * t - 1) / (SQRT3 + t));
  return atanSeries(t);
}

export function atan(x: number): number {
  const ax = Math.abs(x);
  const a = ax <= 1 ? atanUnit(ax) : HALF_PI - atanUnit(1 / ax);
  return x < 0 ? -a : a;
}

/**
 * Same quadrants as Math.atan2, but the sign of a zero is ignored: atan2(0, 0) is 0 and atan2(±0, negative) is +PI.
 * Dividing the smaller magnitude by the larger keeps the ratio from overflowing.
 */
export function atan2(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  let a = ax >= ay ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Wraps into (-PI, PI]. Angles already in range are returned untouched. */
export function wrapAngle(a: number): number {
  if (a > -PI && a <= PI) return a;
  let r = a + TAU * Math.floor((PI - a) / TAU);
  if (r > PI) r -= TAU;
  else if (r <= -PI) r += TAU;
  // Still out of range only when |a| is so large that a double cannot resolve one turn.
  return r > -PI && r <= PI ? r : 0;
}

/** Shortest signed turn from `from` to `to`, in (-PI, PI]. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Interpolates along the shorter arc. The result is wrapped into (-PI, PI]. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDiff(a, b) * t);
}

/** Steps `current` towards `target` by at most `maxDelta`, never overshooting. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return delta > 0 ? current + maxDelta : current - maxDelta;
}

/** Hermite step from 0 at edge0 to 1 at edge1 (the edges may be in either order). Equal edges give a hard step. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
