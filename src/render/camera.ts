import { OrthographicCamera, Vector3 } from 'three';
import type { CarState, Pose } from '../types';

/** Turn of the camera around the vertical axis, radians. Fixed for the whole game. */
export const CAMERA_YAW = Math.PI / 4;
/** Elevation of the camera above the horizon, radians. Fixed for the whole game. */
export const CAMERA_PITCH = (52 * Math.PI) / 180;
/** Height of the visible slice of world at standstill, metres (measured in the view plane). */
export const VIEW_HEIGHT_M = 62;

const DISTANCE = 260;
const NEAR = 1;
const FAR = 700;

const LOOK_AHEAD_S = 0.32;
const LOOK_AHEAD_MAX = 10;
const LOOK_RATE = 2.2;
const FOLLOW_RATE = 9;
/** A jump this large in one frame is a teleport (restart, new level): cut instead of gliding. */
const SNAP_DISTANCE = 40;

const WIDEN_MAX = 0.15;
const WIDEN_SPEED_REF = 48;
const WIDEN_RATE = 1.4;

const SHAKE_MAX = 0.7;
const SHAKE_DECAY = 9;

function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export interface FollowCamera {
  readonly camera: OrthographicCamera;
  /** World-space screen axes. They never change, so billboards can be built from them once. */
  readonly right: Vector3;
  readonly up: Vector3;
  setAspect(aspect: number): void;
  update(pose: Pose, car: CarState, dt: number): void;
  /** Adds screen shake; `amount` is in metres of view-plane travel. */
  addShake(amount: number): void;
  /** Makes the next update cut straight to the car. */
  snap(): void;
}

class LockedCamera implements FollowCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);
  readonly right = new Vector3();
  readonly up = new Vector3();

  private readonly offset = new Vector3(
    Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW),
    Math.sin(CAMERA_PITCH),
    Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW),
  ).multiplyScalar(DISTANCE);

  private aspect = 1;
  private widen = 0;
  private appliedWiden = -1;
  private focusX = 0;
  private focusZ = 0;
  private lookX = 0;
  private lookZ = 0;
  private shake = 0;
  private shakeTime = 0;
  private snapNext = true;

  constructor() {
    this.camera.position.copy(this.offset);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.applyProjection();
  }

  setAspect(aspect: number): void {
    this.aspect = aspect > 0 ? aspect : 1;
    this.applyProjection();
  }

  addShake(amount: number): void {
    this.shake = Math.min(SHAKE_MAX, this.shake + amount);
  }

  snap(): void {
    this.snapNext = true;
  }

  update(pose: Pose, car: CarState, dt: number): void {
    this.follow(pose, car, dt);
    this.updateWiden(car.speed, dt);

    this.shakeTime += dt;
    this.shake *= Math.exp(-SHAKE_DECAY * dt);
    const sx = this.shake * Math.sin(this.shakeTime * 61);
    const sy = this.shake * Math.cos(this.shakeTime * 47);
    this.camera.position.set(
      this.focusX + this.offset.x + this.right.x * sx + this.up.x * sy,
      this.offset.y + this.right.y * sx + this.up.y * sy,
      this.focusZ + this.offset.z + this.right.z * sx + this.up.z * sy,
    );
  }

  /** Moves the focus point towards the car plus a smoothed, speed-based look-ahead. */
  private follow(pose: Pose, car: CarState, dt: number): void {
    let aheadX = car.vx * LOOK_AHEAD_S;
    let aheadZ = car.vz * LOOK_AHEAD_S;
    const ahead = Math.sqrt(aheadX * aheadX + aheadZ * aheadZ);
    if (ahead > LOOK_AHEAD_MAX) {
      aheadX *= LOOK_AHEAD_MAX / ahead;
      aheadZ *= LOOK_AHEAD_MAX / ahead;
    }

    const dx = pose.x + this.lookX - this.focusX;
    const dz = pose.z + this.lookZ - this.focusZ;
    if (this.snapNext || dx * dx + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.snapNext = false;
      this.lookX = aheadX;
      this.lookZ = aheadZ;
      this.focusX = pose.x + aheadX;
      this.focusZ = pose.z + aheadZ;
      return;
    }

    const lookK = damp(LOOK_RATE, dt);
    this.lookX += (aheadX - this.lookX) * lookK;
    this.lookZ += (aheadZ - this.lookZ) * lookK;
    const followK = damp(FOLLOW_RATE, dt);
    this.focusX += (pose.x + this.lookX - this.focusX) * followK;
    this.focusZ += (pose.z + this.lookZ - this.focusZ) * followK;
  }

  private updateWiden(speed: number, dt: number): void {
    const target = WIDEN_MAX * Math.min(1, Math.max(0, speed / WIDEN_SPEED_REF));
    this.widen += (target - this.widen) * damp(WIDEN_RATE, dt);
    if (Math.abs(this.widen - this.appliedWiden) > 1e-4) this.applyProjection();
  }

  private applyProjection(): void {
    this.appliedWiden = this.widen;
    // Portrait windows keep the full width in view instead of cropping the sides.
    const fit = this.aspect < 1 ? 1 / this.aspect : 1;
    const halfHeight = (VIEW_HEIGHT_M * (1 + this.widen) * fit) / 2;
    const camera = this.camera;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.right = halfHeight * this.aspect;
    camera.left = -halfHeight * this.aspect;
    camera.updateProjectionMatrix();
  }
}

export function createFollowCamera(): FollowCamera {
  return new LockedCamera();
}
