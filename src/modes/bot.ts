/**
 * A deterministic driver that follows the road: the driveability gate for generated levels, and the seed of the
 * NPC racers. It grips rather than drifts, because its job is to arrive.
 *
 * Everything about the level is worked out once: a driving line (the centreline, bent around pillars towards
 * their open side) and a speed for every point of it. Per tick the driver only finds itself on that line, steers
 * at a point further along it (pure pursuit) and holds the planned speed. The line and the driving are in
 * driveLine.ts, shared with the endless bot; what is here is the weekly run's own business: the reset button.
 */
import type { InputState, Level, RunState, World } from '../types';
import { SIM_HZ } from '../types';
import { LineFollower, addDodge, appendPath, beginPlan, createDriveLine, layLine, planSpeeds } from './driveLine';
import type { DriveLine } from './driveLine';

const STUCK_TICKS = 4 * SIM_HZ;
/** Metres along the road that count as getting somewhere. */
const PROGRESS_STEP = 1;

function planLine(level: Level): DriveLine {
  const line = createDriveLine(level.path.length);
  appendPath(line, level.path);
  beginPlan(line);
  for (const prop of level.props) addDodge(line, prop);
  layLine(line);
  planSpeeds(line);
  return line;
}

/**
 * The driver for one level. It keeps a little memory between calls (where it was, when it last got somewhere), so
 * use one bot per car and call it once per tick.
 */
export function createBot(level: Level): (world: World, run: RunState) => InputState {
  const follower = new LineFollower(planLine(level));
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  let furthest = 0;
  let progressTick = 0;
  let seenResets = 0;
  let seenTicks = -1;

  /** True when the car has gone nowhere for too long. Respawns and restarts start the clock again. */
  function isStuck(run: RunState, progress: number): boolean {
    const moved = run.resets !== seenResets || run.ticks < seenTicks;
    seenResets = run.resets;
    seenTicks = run.ticks;
    if (moved || progress > furthest + PROGRESS_STEP) {
      furthest = progress;
      progressTick = run.ticks;
      return false;
    }
    if (run.ticks - progressTick < STUCK_TICKS) return false;
    progressTick = run.ticks;
    return true;
  }

  return (world: World, run: RunState): InputState => {
    input.steer = 0;
    input.throttle = 0;
    input.brake = 0;
    input.reset = false;
    if (run.phase !== 'running') return input;
    const progress = follower.drive(world.car, world.params, input);
    input.reset = isStuck(run, progress);
    return input;
  };
}
