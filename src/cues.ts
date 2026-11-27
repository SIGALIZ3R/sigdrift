/**
 * Sound cues that come from watching the simulation rather than from a mode's own events: the scoring blips
 * (close call, multiplier up, combo lost), going over an edge and coming back down from a jump. Shared by every
 * session. Call `before` just ahead of a mode step and `after` right behind it; comparing the two within one step
 * keeps a restart (which puts every "last tick" field back to -1) from ever sounding like an event.
 */
import type { BlipKind } from './audio/mixer';
import { SIM_HZ, TERRAIN_Y } from './types';
import type { ScoreState, SimBase } from './types';

/** Anything with a `blip`: the game's audio, or a recorder in tests. */
export interface CueSink {
  blip(kind: BlipKind): void;
}

/** A car in the air at least this long gets a landing thud. Shorter hops (kerbs, small bumps) stay silent. */
const LAND_MIN_AIR_TICKS = Math.round(0.3 * SIM_HZ);
/** A mode-reported fall this soon after the cue already played (the car was seen going over) is not cued again. */
const FALL_CUE_WINDOW_TICKS = 3 * SIM_HZ;
/** Within this of the city floor counts as "on the floor". */
const FLOOR_SLACK = 0.5;

export class DriveCues {
  private readonly sink: CueSink;
  /** Counts `after` calls: the cues' own clock, independent of the mode's and the world's tick counters. */
  private clock = 0;
  private closeTick = -1;
  private lossTick = -1;
  private multiplier = 1;
  private airTicks = 0;
  private overVoid = false;
  private fallCuedAt = -Infinity;

  constructor(sink: CueSink) {
    this.sink = sink;
  }

  /** Forget the airborne state (on restart and on a respawn). */
  reset(): void {
    this.airTicks = 0;
    this.overVoid = false;
    this.fallCuedAt = -Infinity;
  }

  before(score: ScoreState): void {
    this.closeTick = score.lastCloseTick;
    this.lossTick = score.lastMultiplierLossTick;
    this.multiplier = score.multiplier;
  }

  /** `stepped` is whether the world advanced during this mode step (it does not in the countdown, for instance). */
  after(world: SimBase, score: ScoreState, stepped: boolean): void {
    this.clock++;
    const sink = this.sink;
    if (score.lastCloseTick !== this.closeTick && score.lastCloseTick >= 0) sink.blip('close');
    // The scorer stamps a loss only when there was a multiplier or combo to lose.
    if (score.lastMultiplierLossTick !== this.lossTick && score.lastMultiplierLossTick >= 0) {
      sink.blip('comboLost');
    } else if (Math.floor(score.multiplier) > Math.floor(this.multiplier)) {
      sink.blip('multiplier');
    }
    if (stepped) this.watchHeight(world);
  }

  /** The mode says the car fell off (run: lastFallTick; endless: an offTrack death). Cued unless it already was. */
  modeFall(): void {
    if (this.clock - this.fallCuedAt <= FALL_CUE_WINDOW_TICKS) return;
    this.fallCuedAt = this.clock;
    this.sink.blip('fall');
  }

  private watchHeight(world: SimBase): void {
    const car = world.car;
    if (car.airborne) {
      this.airTicks++;
      // Nothing but the city floor under an airborne car: it has gone over an edge (or a barrier).
      if (!this.overVoid && world.groundHeight(car.x, car.z, car.y) <= TERRAIN_Y + FLOOR_SLACK) {
        this.overVoid = true;
        this.fallCuedAt = this.clock;
        this.sink.blip('fall');
      }
      return;
    }
    const wasInAir = this.airTicks;
    this.airTicks = 0;
    const onFloor = car.y <= TERRAIN_Y + FLOOR_SLACK;
    // The fall cue carries its own thud for the floor.
    if (wasInAir >= LAND_MIN_AIR_TICKS && !onFloor && !this.overVoid) this.sink.blip('land');
    if (!onFloor) this.overVoid = false;
  }
}
