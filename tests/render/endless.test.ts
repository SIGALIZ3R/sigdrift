import { Matrix4 } from 'three';
import type { BufferGeometry, InstancedMesh, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { createFollowCamera } from '../../src/render/camera';
import { createCarVisual } from '../../src/render/carMesh';
import { createEndlessVisual } from '../../src/render/endlessMesh';
import { GeometryBuilder } from '../../src/render/geometry';
import { bumpHeightAt, bumpStep } from '../../src/render/ground';
import { SURFACE } from '../../src/render/palette';
import { DECK_DEPTH, WALL_HALF_THICK, WALL_HEIGHT, Y_ROAD, createTrackShared } from '../../src/render/roadPiece';
import type { TrackShared } from '../../src/render/roadPiece';
import { createSkidMarks } from '../../src/render/skid';
import { createSoftTexture } from '../../src/render/smoke';
import { createCarState } from '../../src/sim/car';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import { TERRAIN_Y } from '../../src/types';
import type { Bump, CarState, RenderFrame, TrackChunk } from '../../src/types';
import { CROSSING, makeBump, makeChunkRoad, makeCrossingChunks, makeStraightChunk } from '../helpers/handLevel';

const HALF_WIDTH = 6;
const CHUNK_LENGTH = 240;

/** A straight chunk along +x with some city and two pillars, from the shared helper. */
function straightChunk(index: number, startX: number, bumps: Bump[] = []): TrackChunk {
  const chunk = makeStraightChunk(index, startX, CHUNK_LENGTH, HALF_WIDTH, bumps);
  chunk.props = [
    { kind: 'pillar', x: startX + 40, z: 2, y: 0, radius: 0.8, height: 4, hue: 1 },
    { kind: 'pillar', x: startX + 200, z: -3, y: 0, radius: 0.6, height: 5, hue: 2 },
  ];
  chunk.decor = [
    { x: startX + 30, z: -30, w: 12, d: 10, h: 22, hue: 0 },
    { x: startX + 90, z: 28, w: 9, d: 14, h: 34, hue: 3 },
    { x: startX + 170, z: -26, w: 16, d: 8, h: 16, hue: 5 },
  ];
  chunk.supports = [
    { x: startX + 60, z: 0, top: -DECK_DEPTH, radius: 0.9 },
    { x: startX + 120, z: 0, top: -DECK_DEPTH, radius: 0.9 },
  ];
  return chunk;
}

function bumpAt(x: number, height = 0.6, halfLength = 3, y = 0): Bump {
  return makeBump(x, 0, 0, HALF_WIDTH + 0.5, height, halfLength * 2, y);
}

function profile(bump: Bump, x: number): number {
  const u = x - bump.x;
  return Math.abs(u) < bump.halfLength ? bump.height * 0.5 * (1 + Math.cos((Math.PI * u) / bump.halfLength)) : 0;
}

interface WorldVertex {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Every vertex of a mesh in world coordinates (chunk meshes are stored relative to their own origin). */
function worldVertices(mesh: Mesh): WorldVertex[] {
  const geometry = mesh.geometry as BufferGeometry;
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const out: WorldVertex[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push({
      x: position.getX(i) + mesh.position.x,
      y: position.getY(i) + mesh.position.y,
      z: position.getZ(i) + mesh.position.z,
      r: color.getX(i),
    });
  }
  return out;
}

/** The meshes chunks added to the group: everything after the floor and the end wall. */
function chunkMeshes(group: { children: unknown[] }): Mesh[] {
  return group.children.slice(2) as Mesh[];
}

function deckOf(group: { children: unknown[] }, shared: TrackShared, x = 0): Mesh {
  return chunkMeshes(group).find((m) => m.material === shared.deck && m.position.x === x) as Mesh;
}

function frameFor(car: CarState, height: number): RenderFrame {
  return {
    pose: { x: car.x, z: car.z, heading: car.heading },
    car,
    params: DEFAULT_CAR_PARAMS,
    run: null,
    endless: null,
    height,
    dt: 1 / 60,
  };
}

describe('geometry builder', () => {
  it('can be emptied and reused, and grows past its first capacity', () => {
    const b = new GeometryBuilder(4);
    for (let i = 0; i < 100; i++) b.line(i, 0, i + 1, 0, 0.1, 0, SURFACE.road);
    const first = b.build();
    expect(first.getAttribute('position').count).toBe(400);
    expect(first.getIndex()?.count).toBe(600);
    expect(first.getAttribute('section')).toBeUndefined();

    b.reset(1000, -500);
    b.trackSections = true;
    b.section = 42;
    b.line3(1000, 1, -500, 1002, 2, -500, 0.5, SURFACE.road);
    const second = b.build();
    const position = second.getAttribute('position');
    expect(position.count).toBe(4);
    // Stored relative to the origin given to `reset`, and with the sloped heights.
    expect(position.getX(0)).toBeCloseTo(0, 6);
    expect(position.getY(0)).toBeCloseTo(1, 6);
    expect(position.getY(1)).toBeCloseTo(2, 6);
    expect(Math.abs(position.getZ(0))).toBeCloseTo(0.5, 6);
    expect(Array.from(second.getAttribute('section').array)).toEqual([42, 42, 42, 42]);
    expect(first.getAttribute('position').count).toBe(400);
  });

  it('hands out a bounding sphere that holds every vertex', () => {
    const b = new GeometryBuilder();
    b.beam2(10, -4, 16, -4, 1, -1, 2, 3, 5, true, true, SURFACE.wall, SURFACE.wall);
    const geometry = b.build();
    const sphere = geometry.boundingSphere!;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const d = Math.hypot(position.getX(i) - sphere.center.x, position.getY(i) - sphere.center.y, position.getZ(i) - sphere.center.z);
      expect(d).toBeLessThanOrEqual(sphere.radius + 1e-4);
    }
  });
});

describe('bump height', () => {
  it('follows the formula in types.ts and lifts only the road it belongs to', () => {
    const bump = bumpAt(50, 0.8, 4);
    expect(bumpHeightAt([bump], 1, 50, 0, 0)).toBeCloseTo(0.8, 12);
    expect(bumpHeightAt([bump], 1, 52, 3, 0)).toBeCloseTo(0.8 * 0.5 * (1 + Math.cos(Math.PI / 2)), 12);
    expect(bumpHeightAt([bump], 1, 54, 0, 0)).toBe(0);
    expect(bumpHeightAt([bump], 1, 50, bump.halfWidth + 0.1, 0)).toBe(0);
    expect(bumpHeightAt([], 0, 50, 0, 0)).toBe(0);
    // A road 7 m above (a bridge) is not lifted by it, and a bump on the bridge leaves the road below alone.
    expect(bumpHeightAt([bump], 1, 50, 0, 7)).toBe(0);
    expect(bumpHeightAt([bumpAt(50, 0.8, 4, 7)], 1, 50, 0, 7)).toBeCloseTo(0.8, 12);
    expect(bumpHeightAt([bumpAt(50, 0.8, 4, 7)], 1, 50, 0, 0)).toBe(0);
  });

  it('is cut into pieces of at most half a metre', () => {
    expect(bumpStep(bumpAt(0, 0.3, 6))).toBeLessThanOrEqual(0.5);
    expect(bumpStep(bumpAt(0, 1.2, 2))).toBeGreaterThanOrEqual(0.15);
    expect(bumpStep(bumpAt(0, 1.2, 2))).toBeLessThan(bumpStep(bumpAt(0, 0.3, 6)));
  });
});

describe('endless road chunks', () => {
  it('builds a chunk in at most four draw calls, on shared materials', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.begin();
    track.addChunk(straightChunk(0, 0, [bumpAt(120)]));
    const meshes = chunkMeshes(track.group);
    expect(meshes.length).toBeLessThanOrEqual(4);
    const materials = meshes.map((m) => m.material);
    expect(materials).toContain(shared.deck);
    expect(materials).toContain(shared.deckGlow);
    expect(materials).toContain(shared.shadow);
    expect(materials).toContain(shared.decorMaterial);
    const decor = meshes.find((m) => m.material === shared.decorMaterial)!;
    expect(decor.geometry).toBe(shared.decorGeometry);
    // City blocks stand on the city floor.
    expect(decor.position.y).toBe(TERRAIN_Y);

    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    expect(track.chunkCount).toBe(2);
    expect(chunkMeshes(track.group).length).toBeLessThanOrEqual(8);
    track.dispose();
    shared.dispose();
  });

  it('raises the tarmac over a bump, at least every half metre along it', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const road = deckOf(track.group, shared);
    // Vertices exactly on the left road edge, at or above the road: the tarmac's edge column and the side face top.
    const edge = worldVertices(road)
      .filter((v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && v.y >= Y_ROAD - 1e-6 && v.y < Y_ROAD + bump.height + 1e-3)
      .sort((a, b) => a.x - b.x);
    const onBump = edge.filter((v) => Math.abs(v.x - bump.x) <= bump.halfLength);
    expect(onBump.length).toBeGreaterThan(12);
    let crest = 0;
    for (const v of onBump) {
      expect(v.y).toBeCloseTo(Y_ROAD + profile(bump, v.x), 4);
      crest = Math.max(crest, v.y);
    }
    const xs = [...new Set(onBump.map((v) => Math.round(v.x * 1e4) / 1e4))];
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThanOrEqual(0.5 + 1e-4);
    expect(crest).toBeGreaterThan(Y_ROAD + bump.height * 0.97);
    for (const v of edge.filter((e) => e.x < 100)) expect(v.y).toBeCloseTo(Y_ROAD, 6);
    expect(shared.surface.heightAt(120, 0, 0)).toBeCloseTo(0.6, 9);
    track.dispose();
    shared.dispose();
  });

  it('builds the road as a slab with walls standing on it, 0.7 m above the surface', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const all = worldVertices(deckOf(track.group, shared));
    const outerFace = all.filter(
      (v) => Math.abs(v.z + HALF_WIDTH + WALL_HALF_THICK) < 1e-4 && v.y > 0.5 && v.x > 1 && v.x < CHUNK_LENGTH - 1,
    );
    expect(outerFace.length).toBeGreaterThan(100);
    let highest = 0;
    for (const v of outerFace) {
      // Wall ends are stretched a few centimetres past their segment, hence a little slack on the bump's faces.
      if (Math.abs(v.x - bump.x) < bump.halfLength) expect(Math.abs(v.y - WALL_HEIGHT - profile(bump, v.x))).toBeLessThan(0.025);
      else expect(v.y).toBeCloseTo(WALL_HEIGHT, 5);
      highest = Math.max(highest, v.y);
    }
    expect(highest).toBeGreaterThan(WALL_HEIGHT + bump.height * 0.97);
    // The slab's side reaches down to DECK_DEPTH below the road, and the supports go down to the city floor.
    expect(all.some((v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && Math.abs(v.y + DECK_DEPTH) < 1e-5)).toBe(true);
    expect(all.some((v) => Math.abs(v.x - 60) < 1.2 && Math.abs(v.y - TERRAIN_Y) < 1e-5)).toBe(true);
    track.dispose();
    shared.dispose();
  });

  it('follows the road up a climb and over a crossing, with the bridge registered at its height', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const chunks = makeCrossingChunks();
    for (const chunk of chunks) track.addChunk(chunk);
    expect(track.chunkCount).toBe(chunks.length);
    // Over the crossing point both roads answer, each from its own level.
    expect(shared.surface.heightAt(CROSSING.crossX, 0, 0)).toBeCloseTo(0, 6);
    expect(shared.surface.heightAt(CROSSING.crossX, 0, CROSSING.height)).toBeCloseTo(CROSSING.height, 6);
    // The bridge chunk's deck stands at the bridge's height.
    const bridge = chunks.find(
      (c) => c.path[0].y > CROSSING.height - 0.1 && c.path.some((q) => q.z > 0) && c.path.some((q) => q.z < 0),
    )!;
    expect(bridge).toBeDefined();
    const deck = deckOf(track.group, shared, bridge.path[0].x);
    const tops = worldVertices(deck).filter((v) => Math.abs(v.x - CROSSING.crossX) < CROSSING.halfWidth + 0.1 && Math.abs(v.z) < 3);
    expect(tops.some((v) => Math.abs(v.y - (CROSSING.height + Y_ROAD)) < 1e-4)).toBe(true);
    track.dispose();
    shared.dispose();
  });

  it('joins chunks without a gap: the tarmac laps under the next chunk at the same height', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    const tarmac = (mesh: Mesh): WorldVertex[] =>
      worldVertices(mesh).filter((v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && Math.abs(v.y - Y_ROAD) < 1e-6);
    const end = Math.max(...tarmac(deckOf(track.group, shared, 0)).map((v) => v.x));
    const start = Math.min(...tarmac(deckOf(track.group, shared, CHUNK_LENGTH)).map((v) => v.x));
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThan(0.2);
    track.dispose();
    shared.dispose();
  });

  it('lays tarmac in the walled run-off behind the start line of chunk 0', () => {
    const chunk = straightChunk(0, 0);
    const wallBack = Math.min(...chunk.walls.map((w) => Math.min(w.ax, w.bx)));
    expect(wallBack).toBeLessThan(-5);
    const before = JSON.stringify(chunk);
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(chunk);
    const tarmac = worldVertices(deckOf(track.group, shared)).filter(
      (v) => Math.abs(v.y - Y_ROAD) < 1e-6 && Math.abs(v.r - SURFACE.road.r) < 1e-6,
    );
    expect(Math.min(...tarmac.map((v) => v.x))).toBeCloseTo(wallBack, 3);
    // The car can stand there: the surface reaches it.
    expect(shared.surface.heightAt(wallBack + 1, 0, 0)).toBeCloseTo(0, 9);
    expect(JSON.stringify(chunk)).toBe(before);
    track.dispose();
    shared.dispose();
  });

  it('frees a removed chunk, its sections and its surface, and nothing else', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    let materialsDisposed = 0;
    for (const m of [shared.solid, shared.glow, shared.deck, shared.deckGlow, shared.shadow, shared.decorMaterial]) {
      m.addEventListener('dispose', () => materialsDisposed++);
    }
    track.addChunk(straightChunk(0, 0, [bumpAt(120)]));
    track.addChunk(straightChunk(1, CHUNK_LENGTH, [bumpAt(CHUNK_LENGTH + 100)]));
    const owned = chunkMeshes(track.group).filter((m) => m.position.x === 0);
    let disposed = 0;
    for (const mesh of owned) {
      if (mesh.geometry !== shared.decorGeometry) mesh.geometry.addEventListener('dispose', () => disposed++);
      else mesh.addEventListener('dispose', () => disposed++);
    }
    expect(shared.fader.deckCount).toBe(2);
    expect(shared.surface.heightAt(120, 0, 0)).toBeGreaterThan(0.5);

    track.removeChunk(0);
    track.removeChunk(7);
    expect(disposed).toBe(owned.length);
    expect(track.chunkCount).toBe(1);
    expect(shared.fader.deckCount).toBe(1);
    expect(shared.surface.heightAt(120, 0, 0)).toBe(TERRAIN_Y);
    expect(shared.surface.heightAt(CHUNK_LENGTH + 100, 0, 0)).toBeGreaterThan(0.5);
    expect(materialsDisposed).toBe(0);

    // The road is now open behind chunk 1: the end wall closes it, at the road's height.
    const cap = track.group.children[1];
    expect(cap.visible).toBe(true);
    expect(cap.position.x).toBeCloseTo(CHUNK_LENGTH, 9);
    expect(cap.position.y).toBeCloseTo(0, 9);
    expect(cap.scale.x).toBeGreaterThan(2 * HALF_WIDTH);

    track.clear();
    expect(track.chunkCount).toBe(0);
    expect(shared.surface.roadCount).toBe(0);
    expect(shared.fader.deckCount).toBe(0);
    // Every section id is back: the whole table can be handed out again.
    expect(shared.sections.alloc(4000)).toBe(1);
    track.dispose();
    shared.dispose();
    expect(materialsDisposed).toBe(6);
  });

  it('carries the floor along in whole grid cells', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.begin();
    track.update(12_345.6, -7_890.1);
    const floor = track.group.children[0];
    expect(floor.position.x % 12).toBe(0);
    expect(floor.position.z % 12 === 0).toBe(true);
    expect(Math.abs(floor.position.x - 12_345.6)).toBeLessThanOrEqual(6);
    track.dispose();
    shared.dispose();
  });

  it('adds a chunk with climbs, open edges and bumps well inside a frame', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const shapes = [];
    for (let i = 0; i < 24; i++) {
      shapes.push(
        i % 3 === 0
          ? { length: 220, rise: 6, turn: 0.8 }
          : i % 3 === 1
            ? { length: 220, openLeft: true, openRight: true, turn: -0.6 }
            : { length: 220, rise: -6 },
      );
    }
    const chunks = makeChunkRoad(shapes, 7);
    for (const c of chunks) {
      const p = c.path[Math.floor(c.path.length / 2)];
      c.bumps.push(makeBump(p.x, p.z, 0, 7.5, 0.7, 6, p.y));
      c.decor = Array.from({ length: 30 }, (_, k) => ({ x: p.x + 40 + k * 3, z: p.z + 30, w: 8, d: 8, h: 20, hue: k }));
      c.supports = c.path.filter((_, k) => k % 6 === 0).map((q) => ({ x: q.x, z: q.z, top: q.y - DECK_DEPTH, radius: 0.9 }));
    }
    const times: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const t0 = performance.now();
      track.addChunk(chunks[i]);
      times.push(performance.now() - t0);
      if (i >= 4) track.removeChunk(i - 4);
      expect(chunkMeshes(track.group).filter((m) => m.position.x === chunks[i].path[0].x).length).toBeLessThanOrEqual(4);
    }
    const warm = times.slice(4).sort((a, b) => a - b);
    const median = warm[Math.floor(warm.length / 2)];
    const worst = warm[warm.length - 1];
    console.info(`addChunk: first ${times[0].toFixed(2)} ms, median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
    expect(median).toBeLessThan(8);
    track.dispose();
    shared.dispose();
  });
});

describe('scenery between the car and the camera', () => {
  /** Height each city block of a chunk is drawn at. */
  function blockHeights(track: { group: { children: unknown[] } }, shared: TrackShared): number[] {
    const mesh = chunkMeshes(track.group).find((m) => m.material === shared.decorMaterial) as InstancedMesh;
    const matrix = new Matrix4();
    const heights: number[] = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      heights.push(matrix.elements[5]);
    }
    return heights;
  }

  it('sinks a block that stands between the car and the camera, and raises it once it is clear', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    const built = blockHeights(track, shared);
    expect(built).toEqual([22, 34, 16]);

    // On the road nothing is in the way.
    for (let i = 0; i < 30; i++) shared.sinker.update(60, 0, 0, 1 / 60);
    expect(shared.sinker.sunkBlocks).toBe(0);

    // Behind the first block (on a lower road, or wrecked on the floor).
    for (let i = 0; i < 20; i++) shared.sinker.update(22, 0, -38, 1 / 60);
    const sunk = blockHeights(track, shared);
    expect(sunk[0]).toBeLessThan(0.1);
    expect(sunk.slice(1)).toEqual(built.slice(1));
    expect(shared.sinker.sunkBlocks).toBe(1);

    // Clear of it again: it waits a moment, then stands up exactly as built.
    shared.sinker.update(60, 0, 0, 1 / 60);
    expect(blockHeights(track, shared)[0]).toBeLessThan(0.1);
    for (let i = 0; i < 120; i++) shared.sinker.update(60, 0, 0, 1 / 60);
    expect(shared.sinker.sunkBlocks).toBe(0);
    expect(blockHeights(track, shared)).toEqual(built);

    // A removed chunk takes its blocks with it.
    for (let i = 0; i < 20; i++) shared.sinker.update(22, 0, -38, 1 / 60);
    track.removeChunk(0);
    shared.sinker.update(22, 0, -38, 1 / 60);
    expect(shared.sinker.sunkBlocks).toBe(0);
    track.dispose();
    shared.dispose();
  });
});

describe('car on the road', () => {
  function airborneCar(vy: number, y: number): CarState {
    const car = createCarState({ x: 10, z: 0, heading: 0 });
    car.vx = 30;
    car.speed = 30;
    car.forwardSpeed = 30;
    car.airborne = true;
    car.vy = vy;
    car.y = y;
    return car;
  }

  it('lifts the body and leaves a smaller, fainter shadow on the road below', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    const visual = createCarVisual(createSoftTexture());
    const grounded = createCarState({ x: 10, z: 0, heading: 0 });
    visual.update(frameFor(grounded, 0), shared.surface);
    const [body, rig] = visual.group.children;
    const shadow = rig.children[0] as Mesh;
    const shadowMaterial = shadow.material as { opacity: number };
    const groundScale = shadow.scale.x;
    const groundOpacity = shadowMaterial.opacity;
    expect(body.position.y).toBe(0);

    for (let i = 0; i < 30; i++) visual.update(frameFor(airborneCar(6, 2), 2), shared.surface);
    expect(visual.group.position.y).toBe(0);
    expect(body.position.y).toBeCloseTo(2, 6);
    expect(rig.position.y).toBeCloseTo(0, 6);
    expect(shadow.scale.x).toBeLessThan(groundScale);
    expect(shadowMaterial.opacity).toBeLessThan(groundOpacity);
    expect(body.rotation.z).toBeGreaterThan(0.02);
    expect(body.rotation.z).toBeLessThan(0.3);
    for (let i = 0; i < 60; i++) visual.update(frameFor(airborneCar(-6, 2), 2), shared.surface);
    expect(body.rotation.z).toBeLessThan(-0.02);

    // Over the edge, above nothing: the shadow lies on the city floor.
    const off = airborneCar(-8, -1);
    off.z = 30;
    for (let i = 0; i < 5; i++) visual.update(frameFor(off, -1), shared.surface);
    expect(rig.position.y).toBeCloseTo(TERRAIN_Y, 6);
    visual.dispose();
    track.dispose();
    shared.dispose();
  });

  it('pitches up a climb and with a bump, standing on the road at its height', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const chunks = makeChunkRoad([{ length: 60 }, { length: 100, rise: 10 }, { length: 60 }], 7);
    for (const c of chunks) track.addChunk(c);
    const visual = createCarVisual(createSoftTexture());
    const body = visual.group.children[0];
    const car = createCarState({ x: 110, z: 0, heading: 0 });
    const y = shared.surface.heightAt(110, 0, 5);
    expect(y).toBeGreaterThan(4);
    expect(y).toBeLessThan(6);
    car.y = y;
    for (let i = 0; i < 30; i++) visual.update(frameFor(car, y), shared.surface);
    const p = DEFAULT_CAR_PARAMS;
    const front = shared.surface.heightAt(110 + p.cgToFront, 0, y);
    const rear = shared.surface.heightAt(110 - p.cgToRear, 0, y);
    expect(body.rotation.z).toBeGreaterThan(0.1);
    expect(body.rotation.z).toBeCloseTo(Math.atan2(front - rear, p.cgToFront + p.cgToRear), 3);
    // On the axles: a hair below the centre where the climb is easing off.
    expect(body.position.y).toBeCloseTo(y, 1);
    const rig = visual.group.children[1];
    expect(rig.position.y).toBeCloseTo(y, 1);
    visual.dispose();
    track.dispose();
    shared.dispose();

    const shared2 = createTrackShared();
    const track2 = createEndlessVisual(shared2);
    track2.addChunk(straightChunk(0, 0, [bumpAt(120, 0.6, 3)]));
    const visual2 = createCarVisual(createSoftTexture());
    const body2 = visual2.group.children[0];
    const onFace = createCarState({ x: 118.5, z: 0, heading: 0 });
    for (let i = 0; i < 30; i++) visual2.update(frameFor(onFace, shared2.surface.heightAt(118.5, 0, 0)), shared2.surface);
    expect(body2.rotation.z).toBeGreaterThan(0.08);
    visual2.dispose();
    track2.dispose();
    shared2.dispose();
  });
});

describe('skid marks', () => {
  function slidingCar(x: number, y = 0): CarState {
    const car = createCarState({ x, z: 0, heading: 0 });
    car.rearSlide = 1;
    car.frontSlide = 1;
    car.y = y;
    return car;
  }

  function written(skid: ReturnType<typeof createSkidMarks>): { x: number; y: number }[] {
    const position = (skid.mesh.geometry as BufferGeometry).getAttribute('position');
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      if (x === 0 && y === 0 && position.getZ(i) === 0) continue;
      out.push({ x, y });
    }
    return out;
  }

  it('lays nothing while the car is in the air', () => {
    const skid = createSkidMarks();
    for (let i = 0; i < 20; i++) {
      const car = slidingCar(i * 0.5);
      car.airborne = true;
      skid.lay(car, DEFAULT_CAR_PARAMS);
    }
    expect(written(skid).length).toBe(0);
    skid.dispose();
  });

  it('follows the surface over a bump and up a climb', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const skid = createSkidMarks();
    for (let x = 112; x < 128; x += 0.25) skid.lay(slidingCar(x, shared.surface.heightAt(x, 0, 0)), DEFAULT_CAR_PARAMS, shared.surface);
    const marks = written(skid);
    expect(marks.length).toBeGreaterThan(40);
    for (const v of marks) expect(v.y).toBeCloseTo(0.04 + profile(bump, v.x), 2);
    expect(Math.max(...marks.map((v) => v.y))).toBeGreaterThan(0.5);
    skid.dispose();
    track.dispose();
    shared.dispose();

    const shared2 = createTrackShared();
    const track2 = createEndlessVisual(shared2);
    for (const c of makeChunkRoad([{ length: 60 }, { length: 100, rise: 10 }], 7)) track2.addChunk(c);
    const skid2 = createSkidMarks();
    for (let x = 70; x < 90; x += 0.25) skid2.lay(slidingCar(x, shared2.surface.heightAt(x, 0, 10)), DEFAULT_CAR_PARAMS, shared2.surface);
    const climb = written(skid2);
    expect(climb.length).toBeGreaterThan(40);
    for (const v of climb) expect(Math.abs(v.y - 0.04 - shared2.surface.heightAt(v.x, 0, 10))).toBeLessThan(0.03);
    expect(Math.max(...climb.map((v) => v.y))).toBeGreaterThan(2);
    skid2.dispose();
    track2.dispose();
    shared2.dispose();
  });

  it('breaks the ribbon where the height jumps, and leaves no mark over an edge', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    const skid = createSkidMarks();
    // Sliding along the road, then the same wheels report a surface far below (gone over the edge).
    for (let x = 20; x < 30; x += 0.25) skid.lay(slidingCar(x), DEFAULT_CAR_PARAMS, shared.surface);
    const before = written(skid).length;
    for (let x = 30; x < 40; x += 0.25) {
      const car = slidingCar(x, -3);
      car.z = 40;
      skid.lay(car, DEFAULT_CAR_PARAMS, shared.surface);
    }
    expect(written(skid).length).toBe(before);
    skid.dispose();
    track.dispose();
    shared.dispose();
  });
});

describe('camera', () => {
  it('stops leading the car when look-ahead is switched off', () => {
    const car = createCarState({ x: 0, z: 0, heading: 0 });
    car.vx = 30;
    car.speed = 30;
    const pose = { x: 0, z: 0, heading: 0 };
    const leading = createFollowCamera();
    const settled = createFollowCamera();
    const rest = createFollowCamera();
    rest.update(pose, createCarState(pose), 1 / 60);
    for (let i = 0; i < 600; i++) {
      leading.update(pose, car, 1 / 60);
      settled.update(pose, car, 1 / 60);
    }
    for (let i = 0; i < 600; i++) settled.update(pose, car, 1 / 60, false);
    expect(leading.camera.position.x - rest.camera.position.x).toBeGreaterThan(5);
    expect(settled.camera.position.x).toBeCloseTo(rest.camera.position.x, 3);
    expect(settled.camera.position.y).toBeCloseTo(rest.camera.position.y, 9);
  });

  it('rises and falls with the road height, smoothly, and cuts on a snap', () => {
    const car = createCarState({ x: 0, z: 0, heading: 0 });
    const pose = { x: 0, z: 0, heading: 0 };
    const follow = createFollowCamera();
    follow.update(pose, car, 1 / 60, true, 0);
    const base = follow.camera.position.y;
    follow.update(pose, car, 1 / 60, true, 10);
    expect(follow.camera.position.y - base).toBeGreaterThan(0);
    expect(follow.camera.position.y - base).toBeLessThan(2);
    for (let i = 0; i < 240; i++) follow.update(pose, car, 1 / 60, true, 10);
    expect(follow.camera.position.y - base).toBeCloseTo(10, 3);
    expect(follow.focusY).toBeCloseTo(10, 3);
    follow.snap();
    follow.update(pose, car, 1 / 60, true, 3);
    expect(follow.camera.position.y - base).toBeCloseTo(3, 9);
  });
});

describe('a car hugging an open drop-off edge', () => {
  it('counts the same 0.25 m past the edge as road as the simulation does', () => {
    const chunks = makeChunkRoad([{ length: 80, openLeft: true, openRight: true }], 7, { x: 0, z: 0, heading: 0, y: 5 });
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    for (const c of chunks) track.addChunk(c);
    expect(shared.surface.heightAt(40, 7.2, 5)).toBeCloseTo(5, 9);
    expect(shared.surface.heightAt(40, -7.2, 5)).toBeCloseTo(5, 9);
    expect(shared.surface.heightAt(40, 7.4, 5)).toBe(TERRAIN_Y);
    track.dispose();
    shared.dispose();
  });

  it('never lifts the body to its axles when the ground under its centre is the city floor', () => {
    // Inside of a bend: both axle probes land on the road at y = 5, the centre just past the edge does not.
    const ground = {
      heightAt(x: number): number {
        return Math.abs(x - 10) < 0.5 ? TERRAIN_Y : 5;
      },
    };
    const visual = createCarVisual(createSoftTexture());
    const [body, rig] = visual.group.children;
    const car = createCarState({ x: 10, z: 0, heading: 0 });
    car.y = 5;
    for (let i = 0; i < 30; i++) {
      visual.update(frameFor(car, 5), ground);
      expect(Math.abs(body.position.y - 5)).toBeLessThan(0.41);
      expect(rig.position.y).toBeGreaterThan(4);
    }
    visual.dispose();
  });

  it('rides at most 0.4 m off the ground under its centre whatever the axles say', () => {
    const ground = {
      heightAt(x: number): number {
        return Math.abs(x - 10) < 0.5 ? 5 : 5.7;
      },
    };
    const visual = createCarVisual(createSoftTexture());
    const body = visual.group.children[0];
    const car = createCarState({ x: 10, z: 0, heading: 0 });
    car.y = 5;
    for (let i = 0; i < 60; i++) visual.update(frameFor(car, 5), ground);
    expect(body.position.y - 5).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(body.position.y - 5).toBeGreaterThan(0.3);
    visual.dispose();
  });
});
