/** The garage cars' looks (carStyles.ts) and the car mesh switching between them (carMesh.ts). */
import { describe, expect, it } from 'vitest';
import { Mesh, MeshLambertMaterial, Texture } from 'three';
import type { Object3D } from 'three';
import { createCarVisual } from '../../src/render/carMesh';
import { carStyle } from '../../src/render/carStyles';
import { CARS } from '../../src/sim/cars';
import { createCarState } from '../../src/sim/car';
import { cloneParams } from '../../src/sim/params';
import type { CarParams, RenderFrame } from '../../src/types';

function frame(params: CarParams): RenderFrame {
  return {
    pose: { x: 0, z: 0, heading: 0 },
    car: createCarState({ x: 0, z: 0, heading: 0 }),
    params,
    run: null,
    endless: null,
    height: 0,
    dt: 1 / 60,
  };
}

/** Colours of every Lambert (lit) material on the car: the body and the glass. */
function litColours(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((node) => {
    if (node instanceof Mesh && node.material instanceof MeshLambertMaterial) out.push(node.material.color.getHexString());
  });
  return out;
}

describe('car styles', () => {
  it('has a distinct look for every garage car', () => {
    const bodies = CARS.map((car) => carStyle(car.id).body.getHexString());
    expect(new Set(bodies).size).toBe(CARS.length);
    const accents = CARS.map((car) => carStyle(car.id).accent.getHexString());
    expect(new Set(accents).size).toBe(CARS.length);
  });

  it('falls back to the stock coupe for an unknown id', () => {
    expect(carStyle('tank')).toBe(carStyle('phantom'));
  });

  it.each(CARS.map((car) => car.id))('%s has silhouettes that run front to rear and close up', (id) => {
    const style = carStyle(id);
    expect(style.bodyTop[0][0]).toBe(1);
    expect(style.bodyTop.at(-1)?.[0]).toBe(-1);
    for (let i = 1; i < style.bodyTop.length; i++) expect(style.bodyTop[i][0]).toBeLessThan(style.bodyTop[i - 1][0]);
    expect(style.bodyUnderside[0][0]).toBe(-1);
    expect(style.bodyUnderside.at(-1)?.[0]).toBe(1);
    // The roof is above the body and the body above the underside everywhere.
    const roof = Math.max(...style.cabin.map(([, y]) => y));
    expect(roof).toBeGreaterThan(Math.max(...style.bodyTop.map(([, y]) => y)));
    for (const [, y] of style.bodyTop) expect(y).toBeGreaterThan(Math.max(...style.bodyUnderside.map(([, u]) => u)));
    expect(style.cabinWidth).toBeGreaterThan(0.5);
    expect(style.cabinWidth).toBeLessThan(1);
  });
});

describe('car mesh', () => {
  it('rebuilds with the new look on the next update after setStyle', () => {
    const visual = createCarVisual(new Texture());
    const phantom = cloneParams(CARS[0].params);
    visual.update(frame(phantom));
    const before = litColours(visual.group);
    expect(before).toContain(carStyle('phantom').body.getHexString());

    visual.setStyle('brute');
    // Nothing changes until the next frame.
    expect(litColours(visual.group)).toEqual(before);
    visual.update(frame(cloneParams(CARS[2].params)));
    expect(litColours(visual.group)).toContain(carStyle('brute').body.getHexString());
    expect(litColours(visual.group)).not.toContain(carStyle('phantom').body.getHexString());
    visual.dispose();
  });

  it('does not rebuild when the same look is set again', () => {
    const visual = createCarVisual(new Texture());
    const params = cloneParams(CARS[1].params);
    visual.setStyle('viper');
    visual.update(frame(params));
    let body: Object3D | null = null;
    visual.group.traverse((node) => {
      if (!body && node instanceof Mesh && node.material instanceof MeshLambertMaterial) body = node;
    });
    visual.setStyle('viper');
    visual.update(frame(params));
    let after: Object3D | null = null;
    visual.group.traverse((node) => {
      if (!after && node instanceof Mesh && node.material instanceof MeshLambertMaterial) after = node;
    });
    expect(after).toBe(body);
    visual.dispose();
  });

  it('draws the extras: the Viper wing and the Brute bonnet stripes add glow geometry', () => {
    const glowVertices = (id: string, index: number): number => {
      const visual = createCarVisual(new Texture());
      visual.setStyle(id);
      visual.update(frame(cloneParams(CARS[index].params)));
      let count = 0;
      visual.group.traverse((node) => {
        if (node instanceof Mesh && !(node.material instanceof MeshLambertMaterial) && node.geometry.getAttribute('color')) {
          count += node.geometry.getAttribute('position').count;
        }
      });
      visual.dispose();
      return count;
    };
    const phantom = glowVertices('phantom', 0);
    expect(glowVertices('viper', 1)).toBeGreaterThan(phantom);
    expect(glowVertices('brute', 2)).toBeGreaterThan(phantom);
  });
});
