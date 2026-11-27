/**
 * Mode 1: drive from the start pad to the goal through every checkpoint, against the clock.
 *
 * The mode owns the rules (countdown, gates, resets) and tells the world when to step. Drift scoring is in
 * driftScore.ts, shared with endless mode. It never touches car physics.
 */
import { cos, sin } from '../core/fixedMath';
import type { Gate, InputState, Pose, RunMode, RunState, World } from '../types';
import { SIM_HZ } from '../types';
import { DriftScorer } from './driftScore';

export const COUNTDOWN_TICKS = 3 * SIM_HZ;

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
    invLengthSq: lengthSq > 0 ? 1 / lengthSq : 0,
  };
}

/**
 * True when the move from (x0, z0) to (x1, z1) passes through the gate from behind. Ending exactly on the line
 * counts and starting on it does not, so one pass can never count twice.
 */
function crossesForwards(line: GateLine, x0: number, z0: number, x1: number, z1: number): boolean {
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
}

function freshState(world: World): RunState {
  return {
    phase: 'countdown',
    countdownTicks: COUNTDOWN_TICKS,
    ticks: 0,
    nextCheckpoint: 0,
    checkpointCount: world.level.checkpoints.length,
    splits: [],
    respawn: { ...world.level.start },
    resets: 0,
    driftScore: 0,
    chainScore: 0,
    multiplier: 1,
    drifting: false,
    lastCheckpointTick: -1,
    lastChainBreakTick: -1,
  };
}

class Run implements RunMode {
  readonly world: World;
  readonly state: RunState;
  /** Every checkpoint in order, then the goal. */
  private readonly gates: GateLine[];
  private readonly rollOutInput: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  private resetHeld = false;
  private readonly drift: DriftScorer;

  constructor(world: World) {
    this.world = world;
    this.state = freshState(world);
    this.drift = new DriftScorer(this.state);
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
    state.driftScore = 0;
    state.lastCheckpointTick = -1;
    state.lastChainBreakTick = -1;
    this.resetHeld = false;
    this.drift.clear();
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
    if (resetPressed) this.respawn();
    // Read after a respawn, so the jump back to the checkpoint is never mistaken for driving through a gate.
    const fromX = car.x;
    const fromZ = car.z;
    world.step(input);
    this.drift.update(car, world.lastCollision);
    if (crossesForwards(this.gates[state.nextCheckpoint], fromX, fromZ, car.x, car.z)) this.passGate();
  }

  /** After the finish the car brakes itself to a stop, whatever the player does. */
  private rollOut(): void {
    // The brake works in either direction of travel, so a car that crossed the line backwards is stopped too.
    // In reverse gear the pedal is the accelerator, so a car that backed over the line gets the handbrake alone.
    const car = this.world.car;
    const braking = !car.reversing && Math.abs(car.forwardSpeed) > ROLL_OUT_BRAKE_SPEED;
    this.rollOutInput.brake = braking ? 1 : 0;
    this.rollOutInput.handbrake = !braking;
    this.world.step(this.rollOutInput);
  }

  private respawn(): void {
    this.world.placeCar(this.state.respawn);
    this.state.resets++;
    this.drift.lose();
  }

  private passGate(): void {
    const { world, state } = this;
    if (state.nextCheckpoint === state.checkpointCount) {
      state.phase = 'finished';
      state.drifting = false;
      this.drift.bank();
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
