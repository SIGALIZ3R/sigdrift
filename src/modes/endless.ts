/**
 * Mode 2: an endless road. Drive as far as you can.
 *
 * The road arrives in chunks from a generator and this mode keeps a window of them alive around the car. Three
 * hard hits end the run, and so does leaving the road: falling off an open edge or flying over a barrier ends it as
 * soon as the car comes to rest on the city floor (the world keeps the car falling until then, so the player sees
 * the drop). There are no checkpoints and no reset. Drift points are scored as in every mode (driftScore.ts); the
 * distance is the other record. Like the weekly run, the mode owns the rules and never touches car physics.
 */
import { createEndlessGenerator } from '../gen/endless';
import { createEndlessWorld } from '../sim/endlessWorld';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../sim/params';
import type {
  CarParams,
  DeathCause,
  Difficulty,
  EndlessGenerator,
  EndlessMode,
  EndlessState,
  EndlessWorld,
  InputState,
} from '../types';
import { SIM_HZ } from '../types';
import { createScoreState, loseMultiplier, resetScore, stepScore } from './driftScore';

export const ENDLESS_COUNTDOWN_TICKS = 3 * SIM_HZ;
export const ENDLESS_MAX_CRASHES = 3;
/** Closing speed against a wall or pillar (m/s) from which a hit counts as a crash. Anything lighter is a scrape. */
export const CRASH_IMPACT = 4;
/**
 * One accident is one crash, however it bounces. After a counted crash further hits are free for
 * CRASH_COOLDOWN_TICKS, and after that for as long as they are still the same accident: until
 * CRASH_AFTERMATH_TICKS have passed, a hit by a car that was going slower than CRASH_REARM_SPEED when it struck,
 * less than CRASH_REARM_DISTANCE along the road from where it crashed. That is the wreck coming back off the wall
 * into the pillar it has just hit with the accelerator still down, rolling back into the opposite wall, or being
 * driven off the wall it is facing in the wrong gear. A car that has got going again, or has left the scene, can
 * crash again.
 */
export const CRASH_COOLDOWN_TICKS = SIM_HZ;
export const CRASH_AFTERMATH_TICKS = 5 * SIM_HZ;
/** Faster than anything a wreck does on the rebound (a fifth of top speed) or in the few metres it bounced back. */
export const CRASH_REARM_SPEED = 12;
export const CRASH_REARM_DISTANCE = 20;
/** Chunks kept generated beyond the one the car is on, and kept alive behind it. */
export const CHUNKS_AHEAD = 3;
export const CHUNKS_BEHIND = 2;

/** Below this the wreck's roll-out swaps the brake for the handbrake: a held brake selects reverse at a standstill. */
const ROLL_OUT_BRAKE_SPEED = 1;

function freshState(difficulty: Difficulty): EndlessState {
  return {
    phase: 'countdown',
    countdownTicks: ENDLESS_COUNTDOWN_TICKS,
    ticks: 0,
    difficulty,
    distance: 0,
    crashes: 0,
    maxCrashes: ENDLESS_MAX_CRASHES,
    lastCrashTick: -1,
    deathCause: null,
    intensity: 0,
    lastTakeoffTick: -1,
    lastLandingTick: -1,
    score: createScoreState(),
  };
}

class Endless implements EndlessMode {
  readonly world: EndlessWorld;
  readonly state: EndlessState;
  private readonly makeGenerator: () => EndlessGenerator;
  private generator: EndlessGenerator;
  private readonly flags = { crashed: false, lost: false };
  private readonly rollOutInput: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  /** Index of the newest chunk handed to the world. */
  private newestChunk = -1;
  /** `world.trackDist` on the start line: distance is counted from there. */
  private startDist = 0;
  private wasAirborne = false;
  /** `world.trackDist` where the last counted crash happened. */
  private crashDist = 0;

  constructor(makeGenerator: () => EndlessGenerator, params: CarParams) {
    this.makeGenerator = makeGenerator;
    this.generator = makeGenerator();
    this.world = createEndlessWorld(this.generator.start, params);
    this.state = freshState(this.generator.difficulty);
    this.layFirstRoad();
  }

  step(input: InputState): void {
    const phase = this.state.phase;
    if (phase === 'countdown') this.stepCountdown();
    else if (phase === 'running') this.stepRunning(input);
    else this.rollOut();
  }

  restart(): void {
    const { world, state } = this;
    this.generator = this.makeGenerator();
    world.dropChunksBefore(Infinity);
    world.tick = 0;
    state.phase = 'countdown';
    state.countdownTicks = ENDLESS_COUNTDOWN_TICKS;
    state.ticks = 0;
    state.difficulty = this.generator.difficulty;
    state.distance = 0;
    state.crashes = 0;
    state.lastCrashTick = -1;
    state.deathCause = null;
    state.lastTakeoffTick = -1;
    state.lastLandingTick = -1;
    resetScore(state.score);
    this.layFirstRoad();
  }

  /** Puts the car on the start line of a fresh generator's road, with the first chunks under and ahead of it. */
  private layFirstRoad(): void {
    const world = this.world;
    this.newestChunk = -1;
    for (let i = 0; i <= CHUNKS_AHEAD; i++) this.addNextChunk();
    // Placed once the road is there, so that the world finds the car on it and measures the start line.
    world.placeCar(this.generator.start);
    this.startDist = world.trackDist;
    this.wasAirborne = false;
    this.crashDist = 0;
    this.state.intensity = this.liveIntensity();
  }

  private addNextChunk(): void {
    const chunk = this.generator.next();
    this.world.addChunk(chunk);
    this.newestChunk = chunk.index;
  }

  private liveIntensity(): number {
    const chunks = this.world.chunks;
    if (chunks.length === 0) return 0;
    const at = this.world.chunkIndex - chunks[0].index;
    return chunks[at < 0 ? 0 : at >= chunks.length ? chunks.length - 1 : at].intensity;
  }

  private stepCountdown(): void {
    const state = this.state;
    if (--state.countdownTicks > 0) return;
    state.countdownTicks = 0;
    state.phase = 'running';
  }

  private stepRunning(input: InputState): void {
    const { world, state } = this;
    const car = world.car;
    state.ticks++;
    // How fast the car was going before anything it hits this tick slowed it.
    const approachSpeed = car.speed;
    // `input.reset` means nothing here: there is no checkpoint to go back to, and the world does not read it.
    world.step(input);

    if (car.airborne !== this.wasAirborne) {
      if (car.airborne) state.lastTakeoffTick = state.ticks;
      else state.lastLandingTick = state.ticks;
      this.wasAirborne = car.airborne;
    }
    if (world.offTrack) {
      this.die('offTrack');
      return;
    }

    const hit = world.lastCollision;
    const hard = hit !== null && hit.impact >= CRASH_IMPACT;
    this.flags.crashed = hard;
    this.flags.lost = false;
    stepScore(state.score, car, world.wallDistance, state.ticks, this.flags);
    if (hard && this.isNewAccident(approachSpeed)) {
      state.crashes++;
      state.lastCrashTick = state.ticks;
      this.crashDist = world.trackDist;
      if (state.crashes >= ENDLESS_MAX_CRASHES) {
        this.die('crashes');
        return;
      }
    }

    // The progress tracker can slide along the road while the car is in the air, so distance only counts once the
    // car is back on its wheels: a jump that ends in a fall never pads the record.
    const travelled = world.trackDist - this.startDist;
    if (!car.airborne && !world.offTrack && travelled > state.distance) state.distance = travelled;
    this.streamChunks();
    state.intensity = this.liveIntensity();
  }

  /** Whether a hard hit now is a crash of its own, or still part of the last one: see CRASH_COOLDOWN_TICKS. */
  private isNewAccident(approachSpeed: number): boolean {
    const state = this.state;
    if (state.lastCrashTick < 0) return true;
    const since = state.ticks - state.lastCrashTick;
    if (since < CRASH_COOLDOWN_TICKS) return false;
    if (since >= CRASH_AFTERMATH_TICKS) return true;
    const moved = Math.abs(this.world.trackDist - this.crashDist);
    return approachSpeed >= CRASH_REARM_SPEED || moved >= CRASH_REARM_DISTANCE;
  }

  /** Keeps road generated ahead of the car and lets go of the road far behind it. */
  private streamChunks(): void {
    const world = this.world;
    const wanted = world.chunkIndex + CHUNKS_AHEAD;
    while (this.newestChunk < wanted) this.addNextChunk();
    world.dropChunksBefore(world.chunkIndex - CHUNKS_BEHIND);
  }

  /** The run is over. The points scored are kept; the multiplier goes. */
  private die(cause: DeathCause): void {
    const state = this.state;
    state.phase = 'dead';
    state.deathCause = cause;
    loseMultiplier(state.score, state.ticks);
  }

  /**
   * After the run ends the wreck brakes itself to a stop, whatever the player does: on the road after the last
   * crash, or on the city floor where it came down.
   */
  private rollOut(): void {
    const world = this.world;
    const car = world.car;
    const braking = !car.reversing && Math.abs(car.forwardSpeed) > ROLL_OUT_BRAKE_SPEED;
    this.rollOutInput.brake = braking ? 1 : 0;
    this.rollOutInput.handbrake = !braking;
    world.step(this.rollOutInput);
  }
}

/**
 * Endless mode on the road that `seed` and `difficulty` generate. `params` is used as given (not copied), so a
 * tuning panel can keep editing it; without it the mode gets its own copy of the defaults.
 */
export function createEndlessMode(
  seed: string,
  difficulty: Difficulty,
  params: CarParams = cloneParams(DEFAULT_CAR_PARAMS),
): EndlessMode {
  return new Endless(() => createEndlessGenerator(seed, difficulty), params);
}

/**
 * Endless mode on any supply of chunks. `makeGenerator` is called once now and once per restart, and must hand
 * back a generator that starts again from chunk 0 each time. For tests and hand-built roads.
 */
export function createEndlessModeFrom(
  makeGenerator: () => EndlessGenerator,
  params: CarParams = cloneParams(DEFAULT_CAR_PARAMS),
): EndlessMode {
  return new Endless(makeGenerator, params);
}
