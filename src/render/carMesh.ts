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
import { GeometryBuilder, builderMaterial } from './levelMesh';
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

function groundGlow(length: number, width: number, texture: Texture, color: Color): Mesh {
  const geometry = new PlaneGeometry(length, width);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 2;
  return mesh;
}

export interface CarVisual {
  readonly group: Group;
  update(frame: RenderFrame): void;
  dispose(): void;
}

class CarModel implements CarVisual {
  readonly group = new Group();
  /** Everything that leans with the body; the wheels stay flat on the road. */
  private readonly chassis = new Group();
  private readonly frontLeft = new Group();
  private readonly frontRight = new Group();
  private readonly tailMaterial = builderMaterial();
  private readonly owned: (BufferGeometry | Material)[] = [];

  // The dimensions the current meshes were built for; the tuning panel can change them live.
  private halfLength = 0;
  private halfWidth = 0;
  private cgToFront = 0;
  private cgToRear = 0;

  private roll = 0;
  private pitch = 0;
  private brakeLight = 0;

  constructor(private readonly softTexture: Texture) {
    this.group.add(this.chassis, this.frontLeft, this.frontRight);
  }

  update(frame: RenderFrame): void {
    const { pose, car, params, dt } = frame;
    if (this.isStale(params)) this.rebuild(params);

    this.group.position.set(pose.x, 0, pose.z);
    this.group.rotation.y = -pose.heading;
    this.frontLeft.rotation.y = -car.steerAngle;
    this.frontRight.rotation.y = -car.steerAngle;

    // Lean away from the turn and squat under power. Purely visual.
    const lateral = clamp(car.forwardSpeed * car.yawRate, MAX_LATERAL_ACCEL);
    const long = clamp(car.accelLong, MAX_LONG_ACCEL);
    const k = 1 - Math.exp(-LEAN_RATE * dt);
    this.roll += (-lateral * ROLL_PER_ACCEL - this.roll) * k;
    this.pitch += (long * PITCH_PER_ACCEL - this.pitch) * k;
    this.chassis.rotation.x = this.roll;
    this.chassis.rotation.z = this.pitch;

    const braking = car.handbrake ? 1 : Math.min(1, Math.max(0, car.brake));
    this.brakeLight += (braking - this.brakeLight) * (1 - Math.exp(-BRAKE_LIGHT_RATE * dt));
    const glow = CAR.tailIdle + (CAR.tailBraking - CAR.tailIdle) * this.brakeLight;
    this.tailMaterial.color.copy(CAR.tail).multiplyScalar(glow);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.disposeParts();
    this.tailMaterial.dispose();
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
    for (const child of [...this.group.children]) {
      if (child !== this.chassis && child !== this.frontLeft && child !== this.frontRight) this.group.remove(child);
    }
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
    this.chassis.add(
      this.part(extrudeProfile(profile, hl, hw * 2), new MeshLambertMaterial({ color: CAR.body })),
      this.part(extrudeProfile(CABIN, hl, hw * 2 * CABIN_WIDTH), new MeshLambertMaterial({ color: CAR.glass })),
      this.part(glowGeometry(hl, hw), builderMaterial()),
      this.part(tailGeometry(hl, hw), this.tailMaterial, true),
    );
  }

  private buildGroundLights(): void {
    const hl = this.halfLength;
    const hw = this.halfWidth;
    const centre = this.chassis.position.x;
    const underglow = groundGlow(hl * 2 + 2.2, hw * 2 + 2.2, this.softTexture, CAR.underglow);
    underglow.position.set(centre, 0.07, 0);
    const beam = groundGlow(11, 6.5, this.softTexture, CAR.headlightBeam);
    beam.position.set(centre + hl + 4.6, 0.075, 0);
    // Parented to the root, not the chassis: light on the road must not tilt with the body.
    for (const mesh of [underglow, beam]) {
      this.owned.push(mesh.geometry, mesh.material as Material);
      this.group.add(mesh);
    }
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
        this.group.add(wheel);
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
