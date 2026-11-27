/**
 * The weekly run and the five fixed levels: drive from the start pad to the goal through every checkpoint, against
 * the clock.
 *
 * The mode owns the rules (countdown, gates, resets, falls) and tells the world when to step. Drift scoring is in
 * driftScore.ts, shared with endless mode. It never touches car physics.
 *
 * Roads cross over and under each other, so a gate only counts for a car near its height (GATE_HEIGHT_REACH).
 *
 * FALLS: once the world reports the car resting on the city floor (offTrack), the fall is counted, the multiplier
 * is lost and the car is left where it lies for FALL_RESPAWN_TICKS (the world keeps stepping, so the player sees
 * it), then put back at the last checkpoint. The clock keeps running throughout. Pressing reset while it waits puts
 * it back at once (that is not counted as a reset).
 */
import { cos, sin } from '../core/fixedMath';
import type { Gate, InputState, Pose, RunMode, RunState, World } from '../types';
import { SIM_HZ } from '../types';
import { LOSS_IMPACT, createScoreState, loseMultiplier, resetScore, stepScore } from './driftScore';

export const COUNTDOWN_TICKS = 3 * SIM_HZ;
/** How long a fallen car is left on the floor before it is put back at the last checkpoint. */
export const FALL_RESPAWN_TICKS = Math.round(0.9 * SIM_HZ);
/** A car crosses a gate only when its wheels are within this of the gate's road height, m. */
export const GATE_HEIGHT_REACH = 3;

/** Below this the roll-out swaps the brake for the handbrake, because a held brake selects reverse at a standstill. */
const ROLL_OUT_BRAKE_SPEED = 1;

/** A gate as a line with a normal that points the way the road travels. */
interface GateLine {
  ax: number;
  az: number;
  gx: number;
  gz: number;
  nx: number;
  nz: number;
  y: number;
  invLengthSq: number;
}

function gateLine(gate: Gate): GateLine {
  const gx = gate.bx - gate.ax;
  const gz = gate.bz - gate.az;
  const lengthSq = gx * gx + gz * gz;
  const along = gz * cos(gate.respawn.heading) - gx * sin(gate.respawn.heading);
  const flip = along < 0 ? -1 : 1;
  return {
    ax: gate.ax,
    az: gate.az,
    gx,
    gz,
    nx: flip * gz,
    nz: -flip * gx,
    y: gate.y ?? gate.respawn.y ?? 0,
    invLengthSq: lengthSq > 0 ? 1 / lengthSq : 0,
  };
}

/**
 * True when the move from (x0, z0) to (x1, z1) passes through the gate from behind, with the wheels near the gate's
 * height at the end of the move. Ending exactly on the line counts and starting on it does not, so one pass can
 * never count twice.
 */
function crossesForwards(line: GateLine, x0: number, z0: number, x1: number, z1: number, y1: number): boolean {
  if (!(Math.abs(y1 - line.y) <= GATE_HEIGHT_REACH)) return false;
  const before = (x0 - line.ax) * line.nx + (z0 - line.az) * line.nz;
  const after = (x1 - line.ax) * line.nx + (z1 - line.az) * line.nz;
  if (!(before < 0 && after >= 0)) return false;
  const t = before / (before - after);
  const hitX = x0 + (x1 - x0) * t - line.ax;
  const hitZ = z0 + (z1 - z0) * t - line.az;
  const share = (hitX * line.gx + hitZ * line.gz) * line.invLengthSq;
  return share >= 0 && share <= 1;
}

function copyPose(from: Pose, to: Pose): void {
  to.x = from.x;
  to.z = from.z;
  to.heading = from.heading;
  to.y = from.y ?? 0;
}

function freshState(world: World): RunState {
  const start = world.level.start;
  return {
    phase: 'countdown',
    countdownTicks: COUNTDOWN_TICKS,
    ticks: 0,
    nextCheckpoint: 0,
    checkpointCount: world.level.checkpoints.length,
    splits: [],
    respawn: { x: start.x, z: start.z, heading: start.heading, y: start.y ?? 0 },
    resets: 0,
    falls: 0,
    lastFallTick: -1,
    respawnInTicks: 0,
    score: createScoreState(),
    lastCheckpointTick: -1,
  };
}

class Run implements RunMode {
  readonly world: World;
  readonly state: RunState;
  /** Every checkpoint in order, then the goal. */
  private readonly gates: GateLine[];
  private readonly rollOutInput: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  private readonly flags = { crashed: false, lost: false };
  private resetHeld = false;

  constructor(world: World) {
    this.world = world;
    this.state = freshState(world);
    this.gates = [...world.level.checkpoints, world.level.goal].map(gateLine);
    this.restart();
  }

  step(input: InputState): void {
    const resetPressed = input.reset && !this.resetHeld;
    this.resetHeld = input.reset;
    const phase = this.state.phase;
    if (phase === 'countdown') this.stepCountdown();
    else if (phase === 'running') this.stepRunning(input, resetPressed);
    else this.rollOut();
  }

  restart(): void {
    const { world, state } = this;
    world.placeCar(world.level.start);
    world.tick = 0;
    state.phase = 'countdown';
    state.countdownTicks = COUNTDOWN_TICKS;
    state.ticks = 0;
    state.nextCheckpoint = 0;
    state.splits.length = 0;
    copyPose(world.level.start, state.respawn);
    state.resets = 0;
    state.falls = 0;
    state.lastFallTick = -1;
    state.respawnInTicks = 0;
    state.lastCheckpointTick = -1;
    resetScore(state.score);
    this.resetHeld = false;
  }

  private stepCountdown(): void {
    const state = this.state;
    if (--state.countdownTicks > 0) return;
    state.countdownTicks = 0;
    state.phase = 'running';
  }

  private stepRunning(input: InputState, resetPressed: boolean): void {
    const { world, state } = this;
    const car = world.car;
    state.ticks++;

    if (state.respawnInTicks > 0) {
      // The car lies where it fell while the player watches; the clock runs on.
      if (resetPressed || --state.respawnInTicks === 0) {
        state.respawnInTicks = 0;
        world.placeCar(state.respawn);
      } else {
        this.stepNeutral();
      }
      return;
    }

    if (resetPressed) this.reset();
    // Read after a respawn, so the jump back to the checkpoint is never mistaken for driving through a gate.
    const fromX = car.x;
    const fromZ = car.z;
    world.step(input);

    if (world.offTrack) {
      this.fall();
      return;
    }

    const hit = world.lastCollision;
    this.flags.crashed = hit !== null && hit.impact >= LOSS_IMPACT;
    this.flags.lost = false;
    stepScore(state.score, car, world.wallDistance, state.ticks, this.flags);
    if (crossesForwards(this.gates[state.nextCheckpoint], fromX, fromZ, car.x, car.z, car.y)) this.passGate();
  }

  /** After the finish the car brakes itself to a stop, whatever the player does. */
  private rollOut(): void {
    this.stepNeutral();
  }

  /** One step of the car braking itself to a stop. */
  private stepNeutral(): void {
    // The brake works in either direction of travel, so a car that crossed the line backwards is stopped too.
    // In reverse gear the pedal is the accelerator, so a car that backed over the line gets the handbrake alone.
    const car = this.world.car;
    const braking = !car.reversing && Math.abs(car.forwardSpeed) > ROLL_OUT_BRAKE_SPEED;
    this.rollOutInput.brake = braking ? 1 : 0;
    this.rollOutInput.handbrake = !braking;
    this.world.step(this.rollOutInput);
  }

  private reset(): void {
    const state = this.state;
    this.world.placeCar(state.respawn);
    state.resets++;
    loseMultiplier(state.score, state.ticks);
  }

  private fall(): void {
    const state = this.state;
    state.falls++;
    state.lastFallTick = state.ticks;
    state.respawnInTicks = FALL_RESPAWN_TICKS;
    loseMultiplier(state.score, state.ticks);
  }

  private passGate(): void {
    const { world, state } = this;
    if (state.nextCheckpoint === state.checkpointCount) {
      state.phase = 'finished';
      state.score.drifting = false;
      state.score.proximity = 0;
      return;
    }
    copyPose(world.level.checkpoints[state.nextCheckpoint].respawn, state.respawn);
    state.nextCheckpoint++;
    state.splits.push(state.ticks);
    state.lastCheckpointTick = state.ticks;
  }
}

export function createRunMode(world: World): RunMode {
  return new Run(world);
}
