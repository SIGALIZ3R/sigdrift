import type { CarParams, CarState, CollisionEvent, InputState, Level, Pose, World } from '../types';
import { DT } from '../types';
import { createCarState, resetCarState, stepCar } from './car';
import type { Collider } from './collision';
import { buildCollider, resolveCollisions } from './collision';
import { DEFAULT_CAR_PARAMS, cloneParams } from './params';

class SimWorld implements World {
  readonly level: Level;
  params: CarParams;
  readonly car: CarState;
  tick = 0;
  /** Owned by the collider and overwritten on the next step: copy it to keep it. */
  lastCollision: CollisionEvent | null = null;
  private readonly collider: Collider;

  constructor(level: Level, params: CarParams) {
    this.level = level;
    this.params = params;
    this.car = createCarState(level.start);
    this.collider = buildCollider(level);
  }

  step(input: InputState): void {
    stepCar(this.car, this.params, input, DT);
    this.lastCollision = resolveCollisions(this.car, this.params, this.collider);
    this.tick++;
  }

  placeCar(pose: Pose): void {
    resetCarState(this.car, pose);
    this.lastCollision = null;
  }

  /**
   * The tick plus everything the next step reads. The other derived fields follow from these; `rearSlide` is here
   * because the steering assist and the wheelspin feed on last tick's value, and `reversing` because the gear is a
   * latch. The height state comes last: on a fixed level it is always 0, 0 and not airborne.
   */
  snapshot(): number[] {
    const { x, z, heading, vx, vz, yawRate, steerAngle, accelLong, rearSlide, reversing, y, vy, airborne } = this.car;
    return [
      this.tick,
      x,
      z,
      heading,
      vx,
      vz,
      yawRate,
      steerAngle,
      accelLong,
      rearSlide,
      reversing ? 1 : 0,
      y,
      vy,
      airborne ? 1 : 0,
    ];
  }
}

/**
 * The car starts at `level.start`, at rest. `params` is used as given (not copied) so a tuning panel can keep
 * editing the object it passed in; without it the world gets its own copy of the defaults.
 */
export function createWorld(level: Level, params: CarParams = cloneParams(DEFAULT_CAR_PARAMS)): World {
  return new SimWorld(level, params);
}
