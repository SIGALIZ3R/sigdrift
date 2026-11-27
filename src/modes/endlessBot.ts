/**
 * The driver for endless mode: the fairness gate for generated chunks. It follows the road like the weekly bot
 * (the line and the driving are shared, in driveLine.ts), over whatever chunks are alive, and plans again each
 * time the road grows or loses its tail.
 *
 * What it adds is care over bumps. A bump throws the car into the air when the crest falls away faster than the
 * car can follow it, which depends on the car's speed and the bump's shape alone. The bot works out that speed
 * for every bump ahead and brakes to a margin below it, so its wheels never leave the ground.
 */
import { PI } from '../core/fixedMath';
import { GRAVITY } from '../sim/car';
import type { Bump, EndlessState, EndlessWorld, InputState, TrackChunk } from '../types';
import {
  LineFollower,
  addDodge,
  appendPath,
  beginPlan,
  capSpeed,
  clearLine,
  createDriveLine,
  holdSpeedEverywhere,
  layLine,
  planSpeeds,
  stationOf,
} from './driveLine';
import type { DriveLine } from './driveLine';

/** Room for about six chunks of road; the line grows if a window ever holds more. */
const LINE_CAPACITY = 1024;
/**
 * Over a crest the bot lets the ground fall away from under it with at most this share of gravity, which leaves
 * a fifth of the car's weight on its tyres. The car takes off at about 1.15 (see LAUNCH_ACCEL in sim/car.ts).
 */
const CREST_UNLOADING = 0.8;
/** The bump speed is reached this far before the ridge begins, m. */
const BUMP_LEAD = 3;

export interface EndlessBotOptions {
  /** Slow down for bumps (default true). Without it the bot takes them at whatever speed the road allows. */
  bumpCare?: boolean;
  /** Never drive faster than this, m/s (default: no limit beyond the road's own). */
  speedCap?: number;
  /**
   * Drive at this speed everywhere, m/s, slowing for neither bends nor bumps: a driver with good hands and no
   * judgement. For measuring how much a road punishes speed; overrides the other two options.
   */
  constantSpeed?: number;
}

/**
 * Fastest a car can cross a bump with its wheels pressed to the ground by at least (1 - unloading) of its weight.
 * The ridge is a raised cosine, sharpest at the crest: there the ground falls away at
 * speed² x height x (PI / halfLength)² / 2.
 */
export function bumpSpeed(bump: Bump, unloading: number = CREST_UNLOADING): number {
  if (!(bump.height > 0)) return Infinity;
  return (bump.halfLength / PI) * Math.sqrt((2 * unloading * GRAVITY) / bump.height);
}

function plan(
  line: DriveLine,
  chunks: readonly TrackChunk[],
  bumpCare: boolean,
  speedCap: number,
  constantSpeed: number,
): void {
  clearLine(line);
  // Chunks join end to start: every chunk but the first repeats its neighbour's last point.
  for (let c = 0; c < chunks.length; c++) appendPath(line, chunks[c].path, c === 0 ? 0 : 1);
  beginPlan(line);
  for (let c = 0; c < chunks.length; c++) {
    const { props, bumps } = chunks[c];
    for (let i = 0; i < props.length; i++) addDodge(line, props[i]);
    if (!bumpCare) continue;
    for (let i = 0; i < bumps.length; i++) {
      const bump = bumps[i];
      const crest = stationOf(line, bump.x, bump.z);
      capSpeed(line, crest - bump.halfLength - BUMP_LEAD, crest + bump.halfLength, bumpSpeed(bump));
    }
  }
  if (speedCap < Infinity) capSpeed(line, -Infinity, Infinity, speedCap);
  layLine(line);
  planSpeeds(line);
  if (constantSpeed > 0) holdSpeedEverywhere(line, constantSpeed);
}

/**
 * A driver for one endless run. It keeps a little memory between calls (the line over the live chunks, and where
 * on it the car was), so use one bot per car and call it once per tick. It never asks for a reset.
 */
export function createEndlessBot(
  options: EndlessBotOptions = {},
): (world: EndlessWorld, state: EndlessState) => InputState {
  const bumpCare = options.bumpCare !== false;
  const speedCap = options.speedCap ?? Infinity;
  const constantSpeed = options.constantSpeed ?? 0;
  const line = createDriveLine(LINE_CAPACITY);
  const follower = new LineFollower(line);
  const input: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  /** The live window the line was planned for. Chunk objects are never reused, so these two identify it. */
  let oldest: TrackChunk | null = null;
  let newest: TrackChunk | null = null;

  return (world: EndlessWorld, state: EndlessState): InputState => {
    input.steer = 0;
    input.throttle = 0;
    input.brake = 0;
    if (state.phase !== 'running') return input;
    const chunks = world.chunks;
    if (chunks.length === 0) return input;
    if (chunks[0] !== oldest || chunks[chunks.length - 1] !== newest) {
      oldest = chunks[0];
      newest = chunks[chunks.length - 1];
      plan(line, chunks, bumpCare, speedCap, constantSpeed);
      follower.seat(world.trackDist);
    }
    // In the air nothing the driver does reaches the road, except where the front wheels point at touchdown.
    follower.drive(world.car, world.params, input);
    return input;
  };
}
