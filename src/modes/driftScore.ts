/**
 * Drift scoring, shared by the weekly run and endless mode: what counts as drifting, how a chain of drifts builds
 * points and a multiplier, when it is banked and when it is lost.
 *
 * The scorer writes the five drift fields that RunState and EndlessState have in common, in the state object it
 * was given. It keeps only two counters of its own and never allocates.
 */
import type { CarState, CollisionEvent } from '../types';
import { DT, SIM_HZ } from '../types';

const DRIFT_MIN_SPEED = 7;
const DRIFT_MIN_ANGLE = 0.2;
/**
 * Past ninety degrees the car is travelling tail first, and a slide that deep still scores up to this angle.
 * Plain reversing reads as an angle near pi, far outside it.
 */
const DRIFT_MAX_ANGLE = 1.9;
const DRIFT_POINTS_RATE = 10;
/** A chain survives this long without drifting, so that linked drifts count as one. */
const CHAIN_GRACE_TICKS = Math.round(1.2 * SIM_HZ);
const MULTIPLIER_STEP_TICKS = 2 * SIM_HZ;
const MAX_MULTIPLIER = 8;
/** A hit with more closing speed than this (m/s) throws the chain away. */
export const CHAIN_BREAK_IMPACT = 3;
const SPIN_ANGLE = 2.2;
const SPIN_MIN_SPEED = 5;

/** The part of a mode's state that drift scoring reads (`ticks`) and writes (the rest). */
export interface DriftFields {
  /** The mode's clock; a lost chain is stamped with it. */
  ticks: number;
  /** Banked drift points. */
  driftScore: number;
  /** Points in the drift chain currently in progress (not yet banked). */
  chainScore: number;
  /** Current chain multiplier, >= 1. */
  multiplier: number;
  /** True while the car counts as drifting this tick. */
  drifting: boolean;
  /** Tick on which the chain was last lost to a wall hit or spin, or -1. */
  lastChainBreakTick: number;
}

export class DriftScorer {
  private readonly state: DriftFields;
  /** Ticks spent drifting in the live chain; 0 means there is no chain. */
  private chainDriftTicks = 0;
  private chainIdleTicks = 0;

  constructor(state: DriftFields) {
    this.state = state;
  }

  /**
   * One tick of scoring, after the world has stepped. `hit` is the world's collision for that step.
   *
   * A car in the air neither scores nor runs down the chain's grace time: the chain waits for the landing.
   */
  update(car: CarState, hit: CollisionEvent | null): void {
    const state = this.state;
    const angle = Math.abs(car.driftAngle);
    if ((hit !== null && hit.impact > CHAIN_BREAK_IMPACT) || (angle > SPIN_ANGLE && car.speed > SPIN_MIN_SPEED)) {
      state.drifting = false;
      this.lose();
      return;
    }
    if (car.airborne) {
      state.drifting = false;
      return;
    }
    // No "nose first" condition: driftAngle is atan2(lateral, forward), so that would cap the angle at pi / 2 and
    // turn the deepest part of a big slide into dead time.
    const drifting = car.speed > DRIFT_MIN_SPEED && angle > DRIFT_MIN_ANGLE && angle < DRIFT_MAX_ANGLE;
    state.drifting = drifting;
    if (drifting) {
      state.chainScore += car.speed * angle * DT * DRIFT_POINTS_RATE;
      this.chainDriftTicks++;
      this.chainIdleTicks = 0;
      const steps = Math.floor(this.chainDriftTicks / MULTIPLIER_STEP_TICKS);
      state.multiplier = Math.min(MAX_MULTIPLIER, 1 + steps);
    } else if (this.chainDriftTicks > 0 && ++this.chainIdleTicks >= CHAIN_GRACE_TICKS) {
      this.bank();
    }
  }

  /** Adds the live chain, times its multiplier, to the banked score. */
  bank(): void {
    this.state.driftScore += Math.round(this.state.chainScore * this.state.multiplier);
    this.clear();
  }

  /** Throws the live chain away. With no chain there is nothing to lose and nothing to flash on the HUD. */
  lose(): void {
    if (this.chainDriftTicks > 0) this.state.lastChainBreakTick = this.state.ticks;
    this.clear();
  }

  /** Forgets the live chain without banking or marking a break. The banked score is left alone. */
  clear(): void {
    this.state.chainScore = 0;
    this.state.multiplier = 1;
    this.state.drifting = false;
    this.chainDriftTicks = 0;
    this.chainIdleTicks = 0;
  }
}
