/**
 * Drift scoring, shared by every mode (see ScoreState in types.ts).
 *
 * - The car is DRIFTING while it is on the ground, faster than DRIFT_MIN_SPEED, not in reverse gear, and travelling
 *   between DRIFT_MIN_ANGLE and DRIFT_MAX_ANGLE off its nose. (Past ninety degrees the car is travelling tail first,
 *   and a slide that deep still scores; plain reversing reads as an angle near pi, far outside it.)
 * - PROXIMITY: 0 beyond PROXIMITY_FAR metres from a wall or pillar, rising smoothly to 1 at PROXIMITY_NEAR or closer.
 *   It only counts while drifting.
 * - POINTS flow every drifting tick, straight into `points`:
 *     speed x |drift angle| x POINTS_RATE x (1 + PROXIMITY_POINTS_BONUS x proximity) x multiplier   per second.
 *   Points are NEVER taken away.
 * - The MULTIPLIER climbs while drifting by MULTIPLIER_RATE per second plus up to MULTIPLIER_PROXIMITY_RATE per
 *   second more, scaled by proximity (a drift on the wall climbs seven times faster than one in the open), up to
 *   MAX_MULTIPLIER. When the drifting stops it holds for MULTIPLIER_HOLD_TICKS, so linked drifts keep it, then decays
 *   by MULTIPLIER_DECAY per second down to 1. In the air it neither scores nor runs down: a jump between two drifts
 *   links them.
 * - A real impact (LOSS_IMPACT or harder), a spin (SPIN_ANGLE at SPIN_MIN_SPEED), a fall or a manual reset drop the
 *   multiplier to 1 and the combo to 0. Light scrapes do not: riding the wall is the point. Grinding along a wall
 *   while not drifting earns nothing.
 * - After a crash, a fall or a reset, scoring is LOCKED OUT for at least RECOVER_TICKS, and until the car has gone
 *   RECOVER_CLEAN_TICKS in a row without counting as drifting: a wreck bouncing or sliding along the wall it just hit
 *   earns no points and rebuilds no multiplier. (A spin only costs the multiplier: the car is still being driven.)
 *
 * Nothing here allocates per tick. The few counters ScoreState has no field for live on the object made by
 * createScoreState, out of sight of the shared type.
 */
import type { CarState, ScoreState } from '../types';
import { DT, SIM_HZ } from '../types';

export const DRIFT_MIN_SPEED = 8;
export const DRIFT_MIN_ANGLE = 0.25;
export const DRIFT_MAX_ANGLE = 1.9;
/** Proximity is 0 at and beyond this distance from a solid, m. */
export const PROXIMITY_FAR = 4;
/** Proximity is 1 at and inside this distance, m. */
export const PROXIMITY_NEAR = 0.4;
/** Points per second per (m/s x rad) of drift, before the proximity bonus and the multiplier. */
export const POINTS_RATE = 12;
/** At proximity 1 a drift scores 1 + this times as much. */
export const PROXIMITY_POINTS_BONUS = 2.5;
/** Multiplier gained per second of drifting, anywhere. */
export const MULTIPLIER_RATE = 0.25;
/** Extra multiplier gained per second of drifting at proximity 1 (in proportion below it). */
export const MULTIPLIER_PROXIMITY_RATE = 1.5;
export const MAX_MULTIPLIER = 10;
/** How long the multiplier holds still after a drift ends. */
export const MULTIPLIER_HOLD_TICKS = Math.round(1.5 * SIM_HZ);
/** Multiplier lost per second once the hold is over. */
export const MULTIPLIER_DECAY = 0.5;
/** A hit with this much closing speed (m/s) or more costs the multiplier. Lighter scrapes are free. */
export const LOSS_IMPACT = 4;
/** Further off the nose than this (rad), faster than SPIN_MIN_SPEED, is a spin, which costs the multiplier. */
export const SPIN_ANGLE = 2.3;
export const SPIN_MIN_SPEED = 5;
/** Proximity at which a drift counts as a close-to-the-wall moment (lastCloseTick). */
export const CLOSE_PROXIMITY = 0.5;

/** Least time scoring stays locked out after a crash, a fall or a reset. */
export const RECOVER_TICKS = Math.round(0.75 * SIM_HZ);
/** The lockout ends only after the car has gone this long in a row without counting as drifting. */
export const RECOVER_CLEAN_TICKS = Math.round(0.25 * SIM_HZ);

/** Flags for one tick of scoring. */
export interface ScoreFlags {
  /** A real impact this tick (collision closing speed >= LOSS_IMPACT). */
  crashed: boolean;
  /** The car fell off, was reset, or the mode otherwise threw the drift away this tick. */
  lost: boolean;
}

/** The counters behind the shared fields. */
interface ScoreCounters extends ScoreState {
  /** Ticks on the ground since the car last drifted (0 while drifting). */
  idleTicks: number;
  /** Ticks of post-crash lockout left (see RECOVER_TICKS); 0 when scoring normally. */
  lockoutTicks: number;
}

export function createScoreState(): ScoreState {
  const state: ScoreCounters = {
    points: 0,
    multiplier: 1,
    peakMultiplier: 1,
    drifting: false,
    proximity: 0,
    combo: 0,
    lastMultiplierLossTick: -1,
    lastCloseTick: -1,
    idleTicks: 0,
    lockoutTicks: 0,
  };
  return state;
}

/** Back to a fresh run's score, in place. */
export function resetScore(s: ScoreState): void {
  s.points = 0;
  s.multiplier = 1;
  s.peakMultiplier = 1;
  s.drifting = false;
  s.proximity = 0;
  s.combo = 0;
  s.lastMultiplierLossTick = -1;
  s.lastCloseTick = -1;
  (s as ScoreCounters).idleTicks = 0;
  (s as ScoreCounters).lockoutTicks = 0;
}

/** Whether scoring is locked out after a crash, a fall or a reset (see RECOVER_TICKS). */
export function isRecovering(s: ScoreState): boolean {
  return ((s as ScoreCounters).lockoutTicks ?? 0) > 0;
}

/** 0 at PROXIMITY_FAR metres or more, 1 at PROXIMITY_NEAR or less, smooth in between. */
export function proximityAt(wallDistance: number): number {
  if (!(wallDistance < PROXIMITY_FAR)) return 0;
  if (wallDistance <= PROXIMITY_NEAR) return 1;
  const t = (PROXIMITY_FAR - wallDistance) / (PROXIMITY_FAR - PROXIMITY_NEAR);
  return t * t * (3 - 2 * t);
}

/** Whether the car counts as drifting (see the header). */
export function isDrifting(car: CarState): boolean {
  if (car.airborne || car.reversing || !(car.speed > DRIFT_MIN_SPEED)) return false;
  const angle = Math.abs(car.driftAngle);
  return angle > DRIFT_MIN_ANGLE && angle < DRIFT_MAX_ANGLE;
}

/** Whether the car is spinning out (see SPIN_ANGLE). */
export function isSpinning(car: CarState): boolean {
  return !car.reversing && car.speed > SPIN_MIN_SPEED && Math.abs(car.driftAngle) > SPIN_ANGLE;
}

/**
 * Drops the multiplier to 1 and the combo to 0. `lastMultiplierLossTick` is stamped only when there was something
 * to lose, so the HUD does not flash "lost" for a car that had no multiplier. With `lockout` (a crash, a fall, a
 * reset) scoring also stays locked out while the car recovers (see RECOVER_TICKS).
 */
export function loseMultiplier(s: ScoreState, tick: number, lockout = true): void {
  if (lockout) (s as ScoreCounters).lockoutTicks = RECOVER_TICKS;
  if (s.multiplier > 1 || s.combo > 0) s.lastMultiplierLossTick = tick;
  s.multiplier = 1;
  s.combo = 0;
  s.drifting = false;
  s.proximity = 0;
  (s as ScoreCounters).idleTicks = MULTIPLIER_HOLD_TICKS;
}

/**
 * One tick of scoring, after the world has stepped. `wallDistance` is the world's SimBase.wallDistance, `tick` the
 * mode's clock (stamped on the events).
 */
export function stepScore(
  s: ScoreState,
  car: CarState,
  wallDistance: number,
  tick: number,
  flags: { crashed: boolean; lost: boolean },
): void {
  const counters = s as ScoreCounters;
  if (flags.crashed || flags.lost) {
    loseMultiplier(s, tick, true);
    return;
  }
  if (isSpinning(car)) {
    loseMultiplier(s, tick, false);
    return;
  }
  const lockout = counters.lockoutTicks ?? 0;
  if (lockout > 0) {
    // Still recovering from the hit: a slide now is the wreck, not a drift.
    s.drifting = false;
    s.proximity = 0;
    counters.lockoutTicks = car.airborne || isDrifting(car) ? Math.max(lockout - 1, RECOVER_CLEAN_TICKS) : lockout - 1;
    return;
  }
  if (car.airborne) {
    s.drifting = false;
    s.proximity = 0;
    return;
  }
  if (!isDrifting(car)) {
    s.drifting = false;
    s.proximity = 0;
    const idle = (counters.idleTicks ?? 0) + 1;
    counters.idleTicks = idle;
    if (idle > MULTIPLIER_HOLD_TICKS && s.multiplier > 1) {
      s.multiplier -= MULTIPLIER_DECAY * DT;
      if (s.multiplier <= 1) {
        // The chain has run out: the next drift starts a new combo.
        s.multiplier = 1;
        s.combo = 0;
      }
    }
    return;
  }

  const proximity = proximityAt(wallDistance);
  if (proximity >= CLOSE_PROXIMITY && !(s.proximity >= CLOSE_PROXIMITY)) s.lastCloseTick = tick;
  s.drifting = true;
  s.proximity = proximity;
  counters.idleTicks = 0;

  let multiplier = s.multiplier + (MULTIPLIER_RATE + MULTIPLIER_PROXIMITY_RATE * proximity) * DT;
  if (multiplier > MAX_MULTIPLIER) multiplier = MAX_MULTIPLIER;
  s.multiplier = multiplier;
  if (multiplier > s.peakMultiplier) s.peakMultiplier = multiplier;

  const gained =
    car.speed * Math.abs(car.driftAngle) * POINTS_RATE * (1 + PROXIMITY_POINTS_BONUS * proximity) * multiplier * DT;
  s.points += gained;
  s.combo += gained;
}
