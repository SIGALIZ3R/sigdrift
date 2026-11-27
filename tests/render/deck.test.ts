import { Color } from 'three';
import type { BufferGeometry, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { buildLevelVisual } from '../../src/render/levelMesh';
import {
  FADE_MIN_ALPHA,
  SECTION_CAPACITY,
  SectionTable,
  TO_CAMERA_X,
  TO_CAMERA_Y,
  TO_CAMERA_Z,
  blockHides,
  deckHidesCar,
  deckSectionStarts,
  describeSections,
  sectionHides,
  sectionOfPoint,
} from '../../src/render/occlusion';
import { PROXIMITY_SPARK, proximityTint } from '../../src/render/palette';
import { DECK_DEPTH, Y_ROAD, createTrackShared, hazardSpans } from '../../src/render/roadPiece';
import { PathIndex, RoadSurface } from '../../src/render/surface';
import { bumpHeightAt } from '../../src/render/ground';
import { CROSSING, OPEN_EDGE, makeBump, makeCrossingLevel, makeOpenEdgeLevel, makeRampLevel, RAMP } from '../helpers/handLevel';
import { TERRAIN_Y } from '../../src/types';
import type { PathPoint } from '../../src/types';

function straightPath(length: number, y: (x: number) => number = () => 0, halfWidth = 6, spacing = 3): PathPoint[] {
  const path: PathPoint[] = [];
  for (let x = 0; x <= length + 1e-9; x += spacing) path.push({ x, z: 0, y: y(x), halfWidth, dist: x });
  return path;
}

/** A road heading -z along x = cx at height y, from z = z0 to z = z1 (z0 > z1). */
function northPath(cx: number, z0: number, z1: number, y: number, halfWidth = 6): PathPoint[] {
  const path: PathPoint[] = [];
  for (let z = z0, d = 0; z >= z1 - 1e-9; z -= 3, d += 3) path.push({ x: cx, z, y, halfWidth, dist: d });
  return path;
}

interface V {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  section: number;
}

function vertices(mesh: Mesh): V[] {
  const geometry = mesh.geometry as BufferGeometry;
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const section = geometry.getAttribute('section');
  const out: V[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push({
      x: position.getX(i) + mesh.position.x,
      y: position.getY(i) + mesh.position.y,
      z: position.getZ(i) + mesh.position.z,
      r: color.getX(i),
      g: color.getY(i),
      b: color.getZ(i),
      section: section ? section.getX(i) : 0,
    });
  }
  return out;
}

describe('deck sections', () => {
  it('cuts a road into sections of about 24 m that cover every point once', () => {
    const path = straightPath(300);
    const starts = deckSectionStarts(path);
    expect(starts[0]).toBe(0);
    expect(starts[starts.length - 1]).toBe(path.length - 1);
    for (let k = 0; k < starts.length - 1; k++) {
      expect(starts[k + 1]).toBeGreaterThan(starts[k]);
      const length = path[starts[k + 1]].dist - path[starts[k]].dist;
      expect(length).toBeGreaterThanOrEqual(12);
      expect(length).toBeLessThanOrEqual(40);
    }
    expect(starts.length - 1).toBeGreaterThanOrEqual(10);
    expect(starts.length - 1).toBeLessThanOrEqual(13);
    // Every point maps to the section whose range holds it.
    for (let i = 0; i < path.length; i++) {
      const k = sectionOfPoint(starts, i);
      expect(starts[k]).toBeLessThanOrEqual(i);
      if (k < starts.length - 2) expect(starts[k + 1]).toBeGreaterThan(i);
    }
  });

  it('merges a short tail and copes with tiny roads', () => {
    const starts = deckSectionStarts(straightPath(30));
    expect(Array.from(starts)).toEqual([0, 10]);
    expect(Array.from(deckSectionStarts(straightPath(3)))).toEqual([0, 1]);
  });

  it('describes each section for quick rejection', () => {
    const path = straightPath(96, (x) => x * 0.1);
    const deck = describeSections(path, deckSectionStarts(path), 5);
    expect(deck.base).toBe(5);
    expect(deck.maxY[deck.maxY.length - 1]).toBeCloseTo(9.6, 4);
    for (let k = 0; k < deck.cx.length; k++) {
      for (let i = deck.starts[k]; i <= deck.starts[k + 1]; i++) {
        expect(Math.hypot(path[i].x - deck.cx[k], path[i].z - deck.cz[k])).toBeLessThanOrEqual(deck.radius[k]);
      }
    }
  });
});

describe('occlusion maths', () => {
  // A point straight up the line of sight from a car at the origin, at height h.
  function onSight(h: number): { x: number; z: number } {
    const s = (h - 0.6) / TO_CAMERA_Y;
    return { x: TO_CAMERA_X * s, z: TO_CAMERA_Z * s };
  }

  it('fades a deck well above the car that crosses its line of sight', () => {
    const p = onSight(7);
    expect(deckHidesCar(p.x, 7, p.z, 6, 0, 0, 0)).toBe(true);
    // Sideways within the road width plus margin, still in the way.
    expect(deckHidesCar(p.x + 5, 7, p.z - 5, 6, 0, 0, 0)).toBe(true);
  });

  it('leaves alone decks that are low, behind the car, off to the side or far away', () => {
    const low = onSight(1.8);
    expect(deckHidesCar(low.x, 1.8, low.z, 6, 0, 0, 0)).toBe(false);
    // The same bridge on the far side of the car from the camera.
    const p = onSight(7);
    expect(deckHidesCar(-p.x, 7, -p.z, 6, 0, 0, 0)).toBe(false);
    expect(deckHidesCar(p.x + 20, 7, p.z - 20, 6, 0, 0, 0)).toBe(false);
    const high = onSight(60);
    expect(deckHidesCar(high.x, 60, high.z, 6, 0, 0, 0)).toBe(false);
    // A car on the bridge itself is not hidden by it.
    expect(deckHidesCar(p.x, 7, p.z, 6, p.x, 7, p.z)).toBe(false);
  });

  it('finds the bridge section over the car and only that one', () => {
    const bridge = northPath(70, 110, -110, CROSSING.height);
    const deck = describeSections(bridge, deckSectionStarts(bridge), 1);
    const hiding: number[] = [];
    for (let k = 0; k < deck.cx.length; k++) if (sectionHides(deck, k, 70, 0, 0)) hiding.push(k);
    expect(hiding.length).toBeGreaterThanOrEqual(1);
    expect(hiding.length).toBeLessThanOrEqual(2);
    for (const k of hiding) {
      // The sections around z = 0 (and towards the camera, +z).
      expect(deck.cz[k]).toBeGreaterThan(-25);
      expect(deck.cz[k]).toBeLessThan(35);
    }
    // On the bridge, nothing of it hides the car.
    for (let k = 0; k < deck.cx.length; k++) expect(sectionHides(deck, k, 70, 7, 0)).toBe(false);
  });

  it('knows which city blocks hide a point, measuring blocks from the city floor', () => {
    const block = { x: 30, z: -30, w: 12, d: 10, h: 22, hue: 0 };
    // Top at TERRAIN_Y + 22 = 18.
    expect(blockHides(block, 22, 0, -38)).toBe(true);
    expect(blockHides(block, 30, 0, 0)).toBe(false);
    expect(blockHides(block, 22, 18, -38)).toBe(false);
    // Just under the roof the car is still hidden; once its eye clears the roof it is not.
    expect(blockHides(block, 22, TERRAIN_Y + 21, -38)).toBe(true);
    expect(blockHides(block, 22, TERRAIN_Y + 21.5, -38)).toBe(false);
    // A low block hides nothing standing on a road above it.
    expect(blockHides({ ...block, h: 4 }, 22, 0, -38)).toBe(false);
  });
});

describe('section table', () => {
  it('hands out ranges, eases opacity towards its target and frees ranges for reuse', () => {
    const table = new SectionTable();
    const a = table.alloc(10);
    const b = table.alloc(5);
    expect(a).toBe(1);
    expect(b).toBe(11);
    table.setTarget(a + 3, FADE_MIN_ALPHA);
    for (let i = 0; i < 60; i++) table.step(1 / 60);
    expect(table.opacity(a + 3)).toBeCloseTo(FADE_MIN_ALPHA, 2);
    expect(table.opacity(a + 2)).toBe(1);
    const data = table.texture.image.data as Uint8Array;
    expect(data[(a + 3) * 4]).toBe(Math.round(FADE_MIN_ALPHA * 255));
    expect(data[(a + 2) * 4]).toBe(255);
    table.setTarget(a + 3, 1);
    for (let i = 0; i < 120; i++) table.step(1 / 60);
    expect(table.opacity(a + 3)).toBe(1);
    table.free(a, 10);
    expect(table.alloc(4)).toBe(1);
    // Id 0 is "never fades" and a full table falls back to it.
    expect(table.alloc(SECTION_CAPACITY)).toBe(0);
    table.dispose();
  });
});

describe('hazard spans', () => {
  it('groups consecutive open segments, ignoring the unused last flag', () => {
    expect(hazardSpans([false, true, true, false, true, false], 5)).toEqual([1, 3, 4, 5]);
    expect(hazardSpans([true, true, true, true], 3)).toEqual([0, 3]);
    expect(hazardSpans([false, false, true], 2)).toEqual([]);
    expect(hazardSpans([], 0)).toEqual([]);
  });
});

describe('road surface', () => {
  it('follows the height along a ramp and is level across the road', () => {
    const index = new PathIndex(straightPath(120, (x) => (x > 30 ? Math.min(9, (x - 30) * 0.1) : 0)));
    expect(index.surfaceAt(15, 0, Infinity)).toBeCloseTo(0, 9);
    expect(index.surfaceAt(60, 0, Infinity)).toBeCloseTo(3, 6);
    expect(index.surfaceAt(60, 5.5, Infinity)).toBeCloseTo(3, 6);
    expect(index.surfaceAt(60, 7, Infinity)).toBe(-Infinity);
    expect(index.lateral).toBeCloseTo(5.5, 6);
  });

  it('picks the right deck where two roads cross, and the floor elsewhere', () => {
    const surface = new RoadSurface();
    surface.add(0, new PathIndex(straightPath(140)), []);
    surface.add(1, new PathIndex(northPath(70, 60, -60, 7)), [makeBump(70, 30, -Math.PI / 2, 6, 0.5, 6, 7)]);
    expect(surface.heightAt(70, 0, 0)).toBeCloseTo(0, 9);
    expect(surface.heightAt(70, 0, 7)).toBeCloseTo(7, 9);
    expect(surface.heightAt(70, 0)).toBeCloseTo(7, 9);
    // A bump on the bridge lifts the bridge only.
    expect(surface.heightAt(70, 30, 7)).toBeCloseTo(7.5, 6);
    expect(surface.heightAt(20, 30, 0)).toBe(TERRAIN_Y);
    expect(surface.hit).toBeNull();
    surface.remove(1);
    expect(surface.heightAt(70, 0)).toBeCloseTo(0, 9);
    expect(surface.roadCount).toBe(1);
  });

  it('answers in well under a microsecond per query on a long road', () => {
    const index = new PathIndex(straightPath(3000));
    const surface = new RoadSurface();
    surface.add(0, index, []);
    const t0 = performance.now();
    let sum = 0;
    for (let i = 0; i < 100_000; i++) sum += surface.heightAt((i * 7.3) % 3000, ((i * 1.7) % 12) - 6, 0);
    const perQuery = ((performance.now() - t0) / 100_000) * 1000;
    console.info(`surface query: ${perQuery.toFixed(3)} us`);
    expect(Number.isFinite(sum)).toBe(true);
    expect(perQuery).toBeLessThan(5);
  });
});

describe('proximity spark colour', () => {
  it('runs cyan, magenta, amber as the multiplier climbs', () => {
    const c = new Color();
    const near = (a: Color, b: Color): void => {
      expect(a.r).toBeCloseTo(b.r, 6);
      expect(a.g).toBeCloseTo(b.g, 6);
      expect(a.b).toBeCloseTo(b.b, 6);
    };
    near(proximityTint(1, c), PROXIMITY_SPARK.low);
    near(proximityTint(4, c), PROXIMITY_SPARK.mid);
    near(proximityTint(7, c), PROXIMITY_SPARK.high);
    near(proximityTint(20, c), PROXIMITY_SPARK.high);
    near(proximityTint(0, c), PROXIMITY_SPARK.low);
  });
});

describe('fixed levels as decks', () => {
  it('builds a level with a ramp in at most five draw calls, the deck following the road height', () => {
    const shared = createTrackShared();
    const level = makeRampLevel();
    const visual = buildLevelVisual(level, shared);
    expect(visual.group.children.length).toBeLessThanOrEqual(5);
    const deck = visual.group.children.find((c) => (c as Mesh).material === shared.deck) as Mesh;
    expect(deck).toBeDefined();
    // Built exactly on the road edge: the tarmac's edge column and the slab's side face.
    const tarmac = vertices(deck).filter((v) => Math.abs(v.z + RAMP.halfWidth) < 1e-4 && v.y > -0.5);
    // On top of the ramp the road edge stands at the full rise.
    const top = tarmac.filter((v) => v.x > RAMP.climbTo + 5 && v.x < RAMP.topTo - 5);
    expect(top.length).toBeGreaterThan(0);
    for (const v of top) expect(Math.abs(v.y - (RAMP.rise + Y_ROAD)) < 0.05 || v.y < RAMP.rise - 0.5).toBe(true);
    expect(top.some((v) => Math.abs(v.y - (RAMP.rise + Y_ROAD)) < 1e-3)).toBe(true);
    // The slab's side reaches DECK_DEPTH below the surface.
    const sides = vertices(deck).filter((v) => v.x > RAMP.climbTo + 5 && v.x < RAMP.topTo - 5);
    expect(sides.some((v) => Math.abs(v.y - (RAMP.rise - DECK_DEPTH)) < 1e-3)).toBe(true);
    // Every deck vertex knows its section; the floor never fades.
    const ids = new Set(vertices(deck).map((v) => v.section));
    expect(ids.has(0)).toBe(true);
    expect(ids.size).toBeGreaterThan(5);
    // The level is registered for height queries and fading, and lets go of both.
    expect(shared.surface.heightAt(160, 0)).toBeCloseTo(RAMP.rise, 6);
    expect(shared.fader.deckCount).toBe(1);
    visual.dispose();
    expect(shared.surface.heightAt(160, 0)).toBe(TERRAIN_Y);
    expect(shared.fader.deckCount).toBe(0);
    shared.dispose();
  });

  it('paints open edges with hazard stripes and leaves their neon edge strip out', () => {
    const shared = createTrackShared();
    const level = makeOpenEdgeLevel();
    const visual = buildLevelVisual(level, shared);
    const deck = visual.group.children.find((c) => (c as Mesh).material === shared.deck) as Mesh;
    const all = vertices(deck);
    const o = OPEN_EDGE;
    const amberish = (v: V): boolean => v.r > 1.2 && v.g > 0.2 && v.b < 0.2;
    const cyanish = (v: V): boolean => v.b > 1.2 && v.g > 1 && v.r < 0.3;
    const nearLeftEdge = (v: V): boolean => v.z < -o.halfWidth + 1.2 && v.z > -o.halfWidth - 0.1;
    const onTop = (v: V): boolean => Math.abs(v.y - o.height) < 0.1;
    const open = all.filter((v) => v.x > o.openFrom + 2 && v.x < o.openTo - 2 && nearLeftEdge(v) && onTop(v));
    expect(open.some(amberish)).toBe(true);
    expect(open.some(cyanish)).toBe(false);
    // A walled stretch keeps its cyan strip and has no hazard paint.
    const walled = all.filter((v) => v.x > 10 && v.x < 35 && nearLeftEdge(v) && v.y < 0.2 && v.y > -0.1);
    expect(walled.some(cyanish)).toBe(true);
    expect(walled.some(amberish)).toBe(false);
    // The open stretch has light along it in the additive mesh.
    const glow = visual.group.children.find((c) => (c as Mesh).material === shared.deckGlow) as Mesh;
    expect(glow).toBeDefined();
    expect(vertices(glow).some((v) => v.x > o.openFrom && v.x < o.openTo && v.r > 0.1)).toBe(true);
    // And its shadow lies on the city floor under the road.
    const shadow = visual.group.children.find((c) => (c as Mesh).material === shared.shadow) as Mesh;
    const shade = vertices(shadow);
    expect(shade.every((v) => Math.abs(v.y - (TERRAIN_Y + 0.03)) < 1e-4)).toBe(true);
    expect(shade.some((v) => v.r < 0.75)).toBe(true);
    visual.dispose();
    shared.dispose();
  });

  it('keeps the hazard paint and glow on top of a bump that meets the drop-off', () => {
    const shared = createTrackShared();
    const level = makeOpenEdgeLevel();
    const o = OPEN_EDGE;
    const crest = (o.openFrom + o.openTo) / 2;
    const bump = makeBump(crest, 0, 0, o.halfWidth, 0.6, 12, o.height);
    level.bumps = [bump];
    const visual = buildLevelVisual(level, shared);
    const deck = visual.group.children.find((c) => (c as Mesh).material === shared.deck) as Mesh;
    const amberish = (v: V): boolean => v.r > 1.2 && v.g > 0.2 && v.b < 0.2;
    const nearLeftEdge = (v: V): boolean => v.z < -o.halfWidth + 1.2 && v.z > -o.halfWidth - 0.1;
    const overBump = (v: V): boolean => Math.abs(v.x - crest) < 5;
    const paint = vertices(deck).filter((v) => overBump(v) && nearLeftEdge(v) && amberish(v) && v.y > o.height - 0.1);
    expect(paint.length).toBeGreaterThan(8);
    for (const v of paint) expect(v.y).toBeGreaterThanOrEqual(o.height + bumpHeightAt([bump], 1, v.x, v.z, o.height) - 0.005);
    // Right at the crest, the brink is up on the bump.
    expect(Math.max(...paint.map((v) => v.y))).toBeGreaterThan(o.height + 0.55);
    const glow = visual.group.children.find((c) => (c as Mesh).material === shared.deckGlow) as Mesh;
    const lit = vertices(glow).filter((v) => overBump(v) && nearLeftEdge(v) && v.r > 0.1 && v.y > o.height - 0.1);
    expect(lit.length).toBeGreaterThan(4);
    for (const v of lit) expect(v.y).toBeGreaterThanOrEqual(o.height + bumpHeightAt([bump], 1, v.x, v.z, o.height));
    visual.dispose();
    shared.dispose();
  });

  it('fades the bridge when the car drives under it, and brings it back afterwards', () => {
    const shared = createTrackShared();
    const level = makeCrossingLevel();
    const visual = buildLevelVisual(level, shared);
    const deck = visual.group.children.find((c) => (c as Mesh).material === shared.deck) as Mesh;
    const verts = vertices(deck);
    const bridgeIds = new Set(
      verts.filter((v) => Math.abs(v.x - CROSSING.crossX) < 4 && Math.abs(v.z) < 4 && v.y > CROSSING.height - 0.2).map((v) => v.section),
    );
    const lowIds = new Set(verts.filter((v) => Math.abs(v.z) < 4 && v.x < 30 && v.y < 0.2 && v.y > -0.2).map((v) => v.section));
    expect(bridgeIds.size).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) shared.fader.update(CROSSING.crossX, 0, 0, 1 / 60);
    for (const id of bridgeIds) if (id > 0) expect(shared.sections.opacity(id)).toBeLessThan(0.3);
    for (const id of lowIds) expect(shared.sections.opacity(id)).toBe(1);
    // On the bridge, nothing fades; driving on, the bridge comes back.
    for (let i = 0; i < 120; i++) shared.fader.update(CROSSING.crossX, CROSSING.height, -40, 1 / 60);
    for (const id of bridgeIds) expect(shared.sections.opacity(id)).toBe(1);
    visual.dispose();
    shared.dispose();
  });
});
