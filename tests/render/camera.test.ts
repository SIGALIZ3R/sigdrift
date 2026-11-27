import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFollowCamera } from '../../src/render/camera';
import { createCarState } from '../../src/sim/car';

/** Screen position (x right, y up, both -1..1) of a ground point, with the camera settled on the origin. */
function onScreen(x: number, z: number): Vector3 {
  const follow = createFollowCamera();
  follow.setAspect(16 / 9);
  follow.update({ x: 0, z: 0, heading: 0 }, createCarState({ x: 0, z: 0, heading: 0 }), 1 / 60);
  follow.camera.updateMatrixWorld();
  return new Vector3(x, 0, z).project(follow.camera);
}

describe('locked camera against the coordinate contract in types.ts', () => {
  it('keeps the car in the middle of the screen', () => {
    const centre = onScreen(0, 0);
    expect(centre.x).toBeCloseTo(0, 9);
    expect(centre.y).toBeCloseTo(0, 9);
    expect(Math.abs(centre.z)).toBeLessThan(1);
  });

  it('shows +X to the right and +Z towards the viewer', () => {
    expect(onScreen(10, 0).x).toBeGreaterThan(0);
    expect(onScreen(0, 10).y).toBeLessThan(0);
    expect(onScreen(10, 10).y).toBeLessThan(0);
  });

  it('does not mirror the world: a growing heading turns clockwise on screen', () => {
    const ahead = onScreen(10, 0);
    const right = onScreen(0, 10);
    // Screen y points up, so clockwise from `ahead` to `right` is a negative cross product.
    expect(ahead.x * right.y - ahead.y * right.x).toBeLessThan(0);
  });
});
