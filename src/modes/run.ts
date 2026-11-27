/**
 * Mode 1: drive from the start pad to the goal through every checkpoint, against the clock.
 *
 * The mode owns the rules (countdown, gates, resets, drift scoring) and tells the world when to step. It never
 * touches car physics.
 */
import { cos, sin } from '../core/fixedMath';
import type { Gate, InputState, Pose, RunMode, RunState, World } from '../types';
import { DT, SIM_HZ } from '../types';

export const COUNTDOWN_TICKS = 3 * SIM_HZ;

const DRIFT_MIN_SPEED = 7;
const DRIFT_MIN_ANGLE = 0.2;
const DRIFT_MAX_ANGLE = 1.9;
const DRIFT_POINTS_RATE = 10;
/** A chain survives this long without drifting, so that linked drifts count as one. */
const CHAIN_GRACE_TICKS = Math.round(1.2 * SIM_HZ);
const MULTIPLIER_STEP_TICKS = 2 * SIM_HZ;
const MAX_MULTIPLIER = 8;
const CRASH_IMPACT = 3;
const SPIN_ANGLE = 2.2;
const SPIN_MIN_SPEED = 5;
/** Below this the roll-out swaps the brake for the handbrake, because a held brake turns into reverse. */
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
  /** Ticks spent drifting in the live chain; 0 means there is no chain. */
  private chainDriftTicks = 0;
  private chainIdleTicks = 0;

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
    state.driftScore = 0;
    state.lastCheckpointTick = -1;
    state.lastChainBreakTick = -1;
    this.resetHeld = false;
    this.clearChain();
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
    this.scoreDrift();
    if (crossesForwards(this.gates[state.nextCheckpoint], fromX, fromZ, car.x, car.z)) this.passGate();
  }

  /** After the finish the car brakes itself to a stop, whatever the player does. */
  private rollOut(): void {
    const braking = this.world.car.forwardSpeed > ROLL_OUT_BRAKE_SPEED;
    this.rollOutInput.brake = braking ? 1 : 0;
    this.rollOutInput.handbrake = !braking;
    this.world.step(this.rollOutInput);
  }

  private respawn(): void {
    this.world.placeCar(this.state.respawn);
    this.state.resets++;
    this.loseChain();
  }

  private passGate(): void {
    const { world, state } = this;
    if (state.nextCheckpoint === state.checkpointCount) {
      state.phase = 'finished';
      state.drifting = false;
      this.bankChain();
      return;
    }
    copyPose(world.level.checkpoints[state.nextCheckpoint].respawn, state.respawn);
    state.nextCheckpoint++;
    state.splits.push(state.ticks);
    state.lastCheckpointTick = state.ticks;
  }

  private scoreDrift(): void {
    const { world, state } = this;
    const car = world.car;
    const angle = Math.abs(car.driftAngle);
    const hit = world.lastCollision;
    if ((hit !== null && hit.impact > CRASH_IMPACT) || (angle > SPIN_ANGLE && car.speed > SPIN_MIN_SPEED)) {
      state.drifting = false;
      this.loseChain();
      return;
    }
    const drifting =
      car.forwardSpeed > 0 && car.speed > DRIFT_MIN_SPEED && angle > DRIFT_MIN_ANGLE && angle < DRIFT_MAX_ANGLE;
    state.drifting = drifting;
    if (drifting) {
      state.chainScore += car.speed * angle * DT * DRIFT_POINTS_RATE;
      this.chainDriftTicks++;
      this.chainIdleTicks = 0;
      const steps = Math.floor(this.chainDriftTicks / MULTIPLIER_STEP_TICKS);
      state.multiplier = Math.min(MAX_MULTIPLIER, 1 + steps);
    } else if (this.chainDriftTicks > 0 && ++this.chainIdleTicks >= CHAIN_GRACE_TICKS) {
      this.bankChain();
    }
  }

  private bankChain(): void {
    this.state.driftScore += Math.round(this.state.chainScore * this.state.multiplier);
    this.clearChain();
  }

  /** Throws the live chain away. With no chain there is nothing to lose and nothing to flash on the HUD. */
  private loseChain(): void {
    if (this.chainDriftTicks > 0) this.state.lastChainBreakTick = this.state.ticks;
    this.clearChain();
  }

  private clearChain(): void {
    this.state.chainScore = 0;
    this.state.multiplier = 1;
    this.state.drifting = false;
    this.chainDriftTicks = 0;
    this.chainIdleTicks = 0;
  }
}

export function createRunMode(world: World): RunMode {
  return new Run(world);
}
