import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Shape,
} from 'three';
import type { BufferGeometry, Material, Texture } from 'three';
import type { CarParams, RenderFrame } from '../types';
import { GeometryBuilder, builderMaterial } from './geometry';
import { FLAT_GROUND } from './ground';
import type { Ground } from './ground';
import { HeadlightBeams } from './headlights';
import { CAR } from './palette';

/**
 * The player's car: an original low-poly coupe generated from code, modelled with its nose along +X and its
 * right side along +Z. The origin is the centre of mass on the ground, matching the simulated pose.
 */

export const WHEEL_COUNT = 4;

const WHEEL_RADIUS = 0.34;
const WHEEL_WIDTH = 0.26;
/** Wheel centre to the side of the body, m. */
const WHEEL_INSET = 0.12;

/** Wheel position along the nose axis, relative to the pose. Wheels 0 and 1 are the front pair. */
export function wheelOffsetX(params: CarParams, wheel: number): number {
  return wheel < 2 ? params.cgToFront : -params.cgToRear;
}

/** Wheel position towards the car's right. Even wheels are on the left, odd ones on the right. */
export function wheelOffsetZ(params: CarParams, wheel: number): number {
  const track = params.halfWidth - WHEEL_INSET;
  return (wheel & 1) === 0 ? -track : track;
}

// Side silhouettes as [x / halfLength, height in metres], running front to rear.
const BODY_TOP: readonly (readonly [number, number])[] = [
  [1, 0.5],
  [0.86, 0.6],
  [0.3, 0.74],
  [-0.72, 0.8],
  [-1, 0.76],
];
const BODY_UNDERSIDE: readonly (readonly [number, number])[] = [
  [-1, 0.3],
  [-0.94, 0.24],
  [0.92, 0.24],
  [1, 0.34],
];
const CABIN: readonly (readonly [number, number])[] = [
  [0.3, 0.72],
  [0, 1.14],
  [-0.4, 1.17],
  [-0.76, 0.78],
];
const CABIN_WIDTH = 0.8;

const ACCENT_HALF_WIDTH = 0.055;
const ACCENT_EDGE_INSET = 0.085;
const ACCENT_LIFT = 0.012;

const MAX_LATERAL_ACCEL = 12;
const ROLL_PER_ACCEL = 0.0045;
const MAX_LONG_ACCEL = 12;
const PITCH_PER_ACCEL = 0.003;
const LEAN_RATE = 10;
const BRAKE_LIGHT_RATE = 22;

// Jumps (endless mode). On the ground the whole car tilts with the slope under its axles; in the air its nose
// follows the flight path, gently.
/** How fast the body takes up the slope of the ground, 1/s: quick, the wheels are on it. */
const GROUND_PITCH_RATE = 40;
/** How fast it turns towards the flight path once in the air, 1/s. */
const FLIGHT_PITCH_RATE = 7;
/** Share of the flight path's angle the nose takes on, and the most it ever shows, rad. */
const FLIGHT_PITCH_GAIN = 0.7;
const FLIGHT_PITCH_MAX = 0.24;
/** Below this speed the flight path's angle is worked out as if the car were doing this, m/s. */
const FLIGHT_MIN_SPEED = 8;
/** An axle counts as on the car's own road while the surface under it is within this of the car's height, m. */
const AXLE_MATCH = 0.8;
/** The body never rides further than this above or below the ground under its centre (bump crests, dips), m. */
const MAX_RIDE = 0.4;

// What stays on the ground while the car is in the air: a dark blob and the underglow. Both shrink and fade as
// the car climbs, which is what makes its height readable from a camera that never moves.
const SHADOW_MARGIN = 1.5;
const SHADOW_OPACITY = 0.7;
/** Height at which the shadow and the glow have shrunk and faded as far as they go, m. */
const SHADOW_FADE_HEIGHT = 3.5;
const SHADOW_MIN_SCALE = 0.62;
const SHADOW_MIN_OPACITY = 0.5;
const UNDERGLOW_MIN_SCALE = 0.7;
const UNDERGLOW_MIN_LIGHT = 0.55;
const BEAM_MIN_LIGHT = 0.35;
const Y_SHADOW = 0.06;
const Y_UNDERGLOW = 0.07;

/** Emissive colour of the body at the peak of a crash flash: far past white in red, so it blooms. */
const CRASH_R = 1.7;
const CRASH_G = 0.1;
const CRASH_B = 0.16;

/** Extrudes a side silhouette across the car, centred on the car's long axis. */
function extrudeProfile(points: readonly (readonly [number, number])[], halfLength: number, width: number): ExtrudeGeometry {
  const shape = new Shape();
  points.forEach(([x, y], i) => {
    if (i === 0) shape.moveTo(x * halfLength, y);
    else shape.lineTo(x * halfLength, y);
  });
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.translate(0, 0, -width / 2);
  return geometry;
}

/** Headlights and the two neon lines that run along the shoulders from nose to tail. */
function glowGeometry(halfLength: number, halfWidth: number): BufferGeometry {
  const b = new GeometryBuilder();
  for (const side of [-1, 1]) {
    const z = side * (halfWidth - ACCENT_EDGE_INSET);
    for (let i = 0; i < BODY_TOP.length - 1; i++) {
      const [x0, y0] = BODY_TOP[i];
      const [x1, y1] = BODY_TOP[i + 1];
      const v0 = b.vertex(x0 * halfLength, y0 + ACCENT_LIFT, z - ACCENT_HALF_WIDTH, CAR.accent);
      const v1 = b.vertex(x1 * halfLength, y1 + ACCENT_LIFT, z - ACCENT_HALF_WIDTH, CAR.accent);
      const v2 = b.vertex(x1 * halfLength, y1 + ACCENT_LIFT, z + ACCENT_HALF_WIDTH, CAR.accent);
      const v3 = b.vertex(x0 * halfLength, y0 + ACCENT_LIFT, z + ACCENT_HALF_WIDTH, CAR.accent);
      b.quad(v0, v1, v2, v3);
    }
    b.box(halfLength - 0.04, side * halfWidth * 0.58, 1, 0, 0.07, halfWidth * 0.2, 0.4, 0.56, CAR.headlight, CAR.headlight);
  }
  return b.build();
}

/** One light bar across the tail. White vertices: the material colour sets the brightness every frame. */
function tailGeometry(halfLength: number, halfWidth: number): BufferGeometry {
  const b = new GeometryBuilder();
  const white = new Color(1, 1, 1);
  b.box(-halfLength + 0.03, 0, 1, 0, 0.07, halfWidth * 0.86, 0.62, 0.81, white, white);
  return b.build();
}

type GroundMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

function groundPlane(length: number, width: number, material: MeshBasicMaterial, order: number): GroundMesh {
  const geometry = new PlaneGeometry(length, width);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = order;
  return mesh;
}

/** Soft additive light lying on the road. */
function groundGlow(length: number, width: number, texture: Texture, color: Color): GroundMesh {
  const material = new MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  return groundPlane(length, width, material, 2);
}

/** Soft dark blob lying on the road. Drawn after the skid marks and before the lights. */
function groundShadow(length: number, width: number, texture: Texture): GroundMesh {
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity: SHADOW_OPACITY,
    depthWrite: false,
  });
  return groundPlane(length, width, material, 1.5);
}

export interface CarVisual {
  readonly group: Group;
  /**
   * Poses the car for this frame at `frame.height`. `ground` answers how high the road is (flat when left out):
   * it places the shadow and underglow on the surface under the car and tilts the car with the slope. `flash`,
   * 0..1, lights the body red for a counted crash.
   */
  update(frame: RenderFrame, ground?: Ground, flash?: number): void;
  dispose(): void;
}

class CarModel implements CarVisual {
  /** At the car's position on the ground plane, turned to its heading. Never leaves y = 0: heights are below. */
  readonly group = new Group();
  /** The car itself: raised to its height, pitched with the slope or the flight path. */
  private readonly body = new Group();
  /** Everything that leans with the bodywork; the wheels do not. */
  private readonly chassis = new Group();
  private readonly frontLeft = new Group();
  private readonly frontRight = new Group();
  /** Shadow and underglow: on the ground under the car, tilted with the ground, wherever the car is. */
  private readonly groundRig = new Group();
  private readonly tailMaterial = builderMaterial();
  private readonly owned: (BufferGeometry | Material)[] = [];
  private bodyMaterial: MeshLambertMaterial | null = null;
  private shadow: GroundMesh | null = null;
  private underglow: GroundMesh | null = null;
  private beams: HeadlightBeams | null = null;

  // The dimensions the current meshes were built for; the tuning panel can change them live.
  private halfLength = 0;
  private halfWidth = 0;
  private cgToFront = 0;
  private cgToRear = 0;

  private roll = 0;
  private pitch = 0;
  private brakeLight = 0;
  /** Pitch of the whole car from the slope it stands on, or from its flight path. Positive = nose up. */
  private bodyPitch = 0;
  /** How far the car sits above or below the ground at its centre because its axles are on higher or lower ground. */
  private ride = 0;

  constructor(private readonly softTexture: Texture) {
    this.body.add(this.chassis, this.frontLeft, this.frontRight);
    this.group.add(this.body, this.groundRig);
  }

  update(frame: RenderFrame, ground: Ground = FLAT_GROUND, flash = 0): void {
    const { pose, car, params, dt } = frame;
    if (this.isStale(params)) this.rebuild(params);

    this.group.position.set(pose.x, 0, pose.z);
    this.group.rotation.y = -pose.heading;
    this.frontLeft.rotation.y = -car.steerAngle;
    this.frontRight.rotation.y = -car.steerAngle;

    const airborne = car.airborne === true;
    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);
    const carY = frame.height || 0;
    // The surface right under the car: its own road, or whatever is below once it has gone over an edge.
    let groundY = ground.heightAt(pose.x, pose.z, carY);
    // A grounded car stands on its road: if the render's ground has none at its height right under its centre (it is
    // hugging an edge, or the render footprint disagrees with the simulation's by a hair), the car's own height is
    // the ground. Otherwise the body would be lifted to the axles from the city floor far below.
    if (!airborne && Math.abs(groundY - carY) > AXLE_MATCH) groundY = carY;
    const wheelbase = params.cgToFront + params.cgToRear;

    // On the ground the car stands on its axles; in the air its nose follows where it is going.
    let pitchTarget = 0;
    let rideTarget = 0;
    let restY = groundY;
    let groundPitch = 0;
    let rate = GROUND_PITCH_RATE;
    if (airborne) {
      const along = Math.max(FLIGHT_MIN_SPEED, Math.abs(car.forwardSpeed));
      const path = Math.atan2(car.vy || 0, along) * (car.forwardSpeed < 0 ? -1 : 1);
      pitchTarget = clamp(path * FLIGHT_PITCH_GAIN, FLIGHT_PITCH_MAX);
      rate = FLIGHT_PITCH_RATE;
    } else {
      const frontY = ground.heightAt(pose.x + cos * params.cgToFront, pose.z + sin * params.cgToFront, carY);
      const rearY = ground.heightAt(pose.x - cos * params.cgToRear, pose.z - sin * params.cgToRear, carY);
      if (wheelbase > 0 && Math.abs(frontY - carY) < AXLE_MATCH && Math.abs(rearY - carY) < AXLE_MATCH) {
        // Both axles on the road: their heights give the slope and, over a crest, how far the body dips.
        groundPitch = Math.atan2(frontY - rearY, wheelbase);
        const axleY = (frontY + rearY) / 2;
        rideTarget = clamp(axleY - groundY, MAX_RIDE);
        restY = Math.max(groundY, axleY);
      } else {
        // Half over an edge or a step: trust the simulation's slope.
        groundPitch = Math.atan(car.pitchSlope || 0);
      }
      pitchTarget = groundPitch;
    }
    const settle = 1 - Math.exp(-rate * dt);
    this.bodyPitch += (pitchTarget - this.bodyPitch) * settle;
    this.ride += (rideTarget - this.ride) * settle;
    this.body.position.y = carY + this.ride;
    this.body.rotation.z = this.bodyPitch;

    // Lean away from the turn and squat under power. Purely visual, and only with the tyres on the road.
    const lateral = airborne ? 0 : clamp(car.forwardSpeed * car.yawRate, MAX_LATERAL_ACCEL);
    const long = airborne ? 0 : clamp(car.accelLong, MAX_LONG_ACCEL);
    const k = 1 - Math.exp(-LEAN_RATE * dt);
    this.roll += (-lateral * ROLL_PER_ACCEL - this.roll) * k;
    this.pitch += (long * PITCH_PER_ACCEL - this.pitch) * k;
    this.chassis.rotation.x = this.roll;
    this.chassis.rotation.z = this.pitch;

    this.updateGroundLights(ground, pose.x, pose.z, cos, sin, restY, groundPitch, carY - groundY, carY);

    const braking = car.handbrake ? 1 : Math.min(1, Math.max(0, car.brake));
    this.brakeLight += (braking - this.brakeLight) * (1 - Math.exp(-BRAKE_LIGHT_RATE * dt));
    const glow = CAR.tailIdle + (CAR.tailBraking - CAR.tailIdle) * this.brakeLight;
    this.tailMaterial.color.copy(CAR.tail).multiplyScalar(glow);
    this.bodyMaterial?.emissive.setRGB(CRASH_R * flash, CRASH_G * flash, CRASH_B * flash);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.disposeParts();
    this.tailMaterial.dispose();
  }

  /**
   * The shadow and the lights the car throws on the road stay on the road: at `restY`, tilted with the ground,
   * shrinking and fading with the car's `altitude` above it.
   */
  private updateGroundLights(
    ground: Ground,
    x: number,
    z: number,
    cos: number,
    sin: number,
    restY: number,
    groundPitch: number,
    altitude: number,
    carY: number,
  ): void {
    const up = Math.min(1, Math.max(0, altitude / SHADOW_FADE_HEIGHT));
    this.groundRig.position.y = restY;
    this.groundRig.rotation.z = groundPitch;
    if (this.shadow) {
      const scale = 1 + (SHADOW_MIN_SCALE - 1) * up;
      this.shadow.scale.set(scale, 1, scale);
      this.shadow.material.opacity = SHADOW_OPACITY * (1 + (SHADOW_MIN_OPACITY - 1) * up);
    }
    if (this.underglow) {
      const scale = 1 + (UNDERGLOW_MIN_SCALE - 1) * up;
      this.underglow.scale.set(scale, 1, scale);
      this.underglow.material.color.copy(CAR.underglow).multiplyScalar(1 + (UNDERGLOW_MIN_LIGHT - 1) * up);
    }
    // The beams start on the road under the car (or, in the air, whatever is below) and follow it from there.
    this.beams?.update(ground, x, z, cos, sin, Math.min(restY, carY), 1 + (BEAM_MIN_LIGHT - 1) * up);
  }

  private isStale(params: CarParams): boolean {
    return (
      params.halfLength !== this.halfLength ||
      params.halfWidth !== this.halfWidth ||
      params.cgToFront !== this.cgToFront ||
      params.cgToRear !== this.cgToRear
    );
  }

  private disposeParts(): void {
    for (const item of this.owned) item.dispose();
    this.owned.length = 0;
    this.chassis.clear();
    this.frontLeft.clear();
    this.frontRight.clear();
    this.groundRig.clear();
    for (const child of [...this.body.children]) {
      if (child !== this.chassis && child !== this.frontLeft && child !== this.frontRight) this.body.remove(child);
    }
    if (this.beams) {
      this.group.remove(this.beams.mesh);
      this.beams.dispose();
    }
    this.bodyMaterial = null;
    this.shadow = null;
    this.underglow = null;
    this.beams = null;
  }

  private rebuild(params: CarParams): void {
    this.disposeParts();
    this.halfLength = params.halfLength;
    this.halfWidth = params.halfWidth;
    this.cgToFront = params.cgToFront;
    this.cgToRear = params.cgToRear;
    // The body is centred on the wheelbase, which is not centred on the centre of mass.
    this.chassis.position.x = (params.cgToFront - params.cgToRear) / 2;
    this.buildBody();
    this.buildGroundLights();
    this.buildWheels(params);
  }

  private part<G extends BufferGeometry, M extends Material>(geometry: G, material: M, shared = false): Mesh<G, M> {
    this.owned.push(geometry);
    if (!shared) this.owned.push(material);
    return new Mesh(geometry, material);
  }

  private buildBody(): void {
    const hl = this.halfLength;
    const hw = this.halfWidth;
    const profile = [...BODY_TOP, ...BODY_UNDERSIDE];
    this.bodyMaterial = new MeshLambertMaterial({ color: CAR.body });
    this.chassis.add(
      this.part(extrudeProfile(profile, hl, hw * 2), this.bodyMaterial),
      this.part(extrudeProfile(CABIN, hl, hw * 2 * CABIN_WIDTH), new MeshLambertMaterial({ color: CAR.glass })),
      this.part(glowGeometry(hl, hw), builderMaterial()),
      this.part(tailGeometry(hl, hw), this.tailMaterial, true),
    );
  }

  private buildGroundLights(): void {
    const hl = this.halfLength;
    const hw = this.halfWidth;
    const centre = this.chassis.position.x;
    this.shadow = groundShadow(hl * 2 + SHADOW_MARGIN, hw * 2 + SHADOW_MARGIN, this.softTexture);
    this.shadow.position.set(centre, Y_SHADOW, 0);
    this.underglow = groundGlow(hl * 2 + 2.2, hw * 2 + 2.2, this.softTexture, CAR.underglow);
    this.underglow.position.set(centre, Y_UNDERGLOW, 0);
    // One beam from each headlight, starting at the lamp.
    this.beams = new HeadlightBeams(centre + hl - 0.1, hw * 0.58);
    // None of these is part of the body: light and shadow on the road must not lean or jump with the car. The
    // beams are not in the rig either: they follow the road ahead themselves.
    this.groundRig.add(this.shadow, this.underglow);
    this.group.add(this.beams.mesh);
    for (const mesh of [this.shadow, this.underglow]) this.owned.push(mesh.geometry, mesh.material);
  }

  private buildWheels(params: CarParams): void {
    const geometry = new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 12);
    geometry.rotateX(Math.PI / 2);
    const material = new MeshLambertMaterial({ color: CAR.tyre });
    this.owned.push(geometry, material);
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const x = wheelOffsetX(params, w);
      const z = wheelOffsetZ(params, w);
      const wheel = new Mesh(geometry, material);
      if (w >= 2) {
        wheel.position.set(x, WHEEL_RADIUS, z);
        this.body.add(wheel);
        continue;
      }
      // Front wheels hang from a pivot so they can turn with the steering.
      const pivot = w === 0 ? this.frontLeft : this.frontRight;
      pivot.position.set(x, WHEEL_RADIUS, z);
      pivot.add(wheel);
    }
  }
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export function createCarVisual(softTexture: Texture): CarVisual {
  return new CarModel(softTexture);
}
