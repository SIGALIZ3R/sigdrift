import { Matrix4 } from 'three';
import type { BufferGeometry, InstancedMesh, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { createFollowCamera } from '../../src/render/camera';
import { createCarVisual } from '../../src/render/carMesh';
import { blockHides, createEndlessVisual } from '../../src/render/endlessMesh';
import { GeometryBuilder } from '../../src/render/geometry';
import { bumpHeightAt, bumpStep } from '../../src/render/ground';
import { buildLevelVisual } from '../../src/render/levelMesh';
import { SURFACE } from '../../src/render/palette';
import { WALL_HALF_THICK, WALL_HEIGHT, Y_ROAD, createTrackShared } from '../../src/render/roadPiece';
import { createSkidMarks } from '../../src/render/skid';
import { createSoftTexture } from '../../src/render/smoke';
import { createCarState } from '../../src/sim/car';
import { DEFAULT_CAR_PARAMS } from '../../src/sim/params';
import { createEndlessGenerator } from '../../src/gen/endless';
import { generateLevel } from '../../src/gen/trackGen';
import type { Bump, CarState, PathPoint, RenderFrame, Segment, TrackChunk, Vec2 } from '../../src/types';

const HALF_WIDTH = 6;
const SPACING = 3;
const CHUNK_LENGTH = 240;

/** A straight chunk heading +x from (startX, 0): left is -z, right is +z. Chunk 0 gets a cap behind its start. */
function straightChunk(index: number, startX: number, bumps: Bump[] = []): TrackChunk {
  const path: PathPoint[] = [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let d = 0; d <= CHUNK_LENGTH; d += SPACING) {
    path.push({ x: startX + d, z: 0, halfWidth: HALF_WIDTH, dist: startX + d });
    left.push({ x: startX + d, z: -HALF_WIDTH });
    right.push({ x: startX + d, z: HALF_WIDTH });
  }
  const walls: Segment[] = [];
  for (let i = 1; i < left.length; i++) {
    walls.push({ ax: left[i - 1].x, az: left[i - 1].z, bx: left[i].x, bz: left[i].z });
    walls.push({ ax: right[i - 1].x, az: right[i - 1].z, bx: right[i].x, bz: right[i].z });
  }
  if (index === 0) walls.push({ ax: right[0].x, az: right[0].z, bx: left[0].x, bz: left[0].z });
  return {
    index,
    path,
    left,
    right,
    walls,
    props: [
      { kind: 'pillar', x: startX + 40, z: 2, radius: 0.8, height: 4, hue: 1 },
      { kind: 'pillar', x: startX + 200, z: -3, radius: 0.6, height: 5, hue: 2 },
    ],
    decor: [
      { x: startX + 30, z: -30, w: 12, d: 10, h: 18, hue: 0 },
      { x: startX + 90, z: 28, w: 9, d: 14, h: 30, hue: 3 },
      { x: startX + 170, z: -26, w: 16, d: 8, h: 12, hue: 5 },
    ],
    bumps,
    startDist: startX,
    endDist: startX + CHUNK_LENGTH,
    intensity: 0.5,
    bounds: { minX: startX, minZ: -HALF_WIDTH, maxX: startX + CHUNK_LENGTH, maxZ: HALF_WIDTH },
  };
}

function bumpAt(x: number, height = 0.6, halfLength = 3): Bump {
  return { x, z: 0, dirX: 1, dirZ: 0, halfLength, halfWidth: HALF_WIDTH + 0.5, height };
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
      y: position.getY(i),
      z: position.getZ(i) + mesh.position.z,
      r: color.getX(i),
    });
  }
  return out;
}

/** The meshes a chunk added to the group: everything after the floor and the end wall. */
function chunkMeshes(group: { children: unknown[] }, from = 2): Mesh[] {
  return group.children.slice(from) as Mesh[];
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

    b.reset(1000, -500);
    b.line(1000, -500, 1002, -500, 0.5, 0.2, SURFACE.road);
    const second = b.build();
    const position = second.getAttribute('position');
    expect(position.count).toBe(4);
    // Stored relative to the origin given to `reset`.
    expect(position.getX(0)).toBeCloseTo(0, 6);
    expect(Math.abs(position.getZ(0))).toBeCloseTo(0.5, 6);
    expect(first.getAttribute('position').count).toBe(400);
  });

  it('hands out a bounding sphere that holds every vertex', () => {
    const b = new GeometryBuilder();
    b.box(10, -4, 1, 0, 6, 1, 0, 3, SURFACE.wall, SURFACE.wall);
    const geometry = b.build();
    const sphere = geometry.boundingSphere;
    expect(sphere).not.toBeNull();
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const d = Math.hypot(
        position.getX(i) - sphere!.center.x,
        position.getY(i) - sphere!.center.y,
        position.getZ(i) - sphere!.center.z,
      );
      expect(d).toBeLessThanOrEqual(sphere!.radius + 1e-4);
    }
  });
});

describe('bump height', () => {
  it('follows the formula in types.ts and is flat outside the bump', () => {
    const bump = bumpAt(50, 0.8, 4);
    expect(bumpHeightAt([bump], 1, 50, 0)).toBeCloseTo(0.8, 12);
    expect(bumpHeightAt([bump], 1, 52, 3)).toBeCloseTo(0.8 * 0.5 * (1 + Math.cos(Math.PI / 2)), 12);
    expect(bumpHeightAt([bump], 1, 54, 0)).toBe(0);
    expect(bumpHeightAt([bump], 1, 45.9, 0)).toBe(0);
    expect(bumpHeightAt([bump], 1, 50, HALF_WIDTH + 0.6)).toBe(0);
    expect(bumpHeightAt([], 0, 50, 0)).toBe(0);
  });

  it('is cut into pieces of at most half a metre', () => {
    expect(bumpStep(bumpAt(0, 0.3, 6))).toBeLessThanOrEqual(0.5);
    expect(bumpStep(bumpAt(0, 1.2, 2))).toBeGreaterThanOrEqual(0.15);
    expect(bumpStep(bumpAt(0, 1.2, 2))).toBeLessThan(bumpStep(bumpAt(0, 0.3, 6)));
  });
});

describe('endless road chunks', () => {
  it('builds a chunk in at most three draw calls, on shared materials', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.begin();
    track.addChunk(straightChunk(0, 0, [bumpAt(120)]));
    const meshes = chunkMeshes(track.group);
    expect(meshes.length).toBeLessThanOrEqual(3);
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    expect(meshes[0].material).toBe(shared.solid);
    expect(meshes[1].material).toBe(shared.glow);
    expect(meshes[2].material).toBe(shared.decorMaterial);
    expect(meshes[2].geometry).toBe(shared.decorGeometry);

    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    expect(track.chunkCount).toBe(2);
    expect(chunkMeshes(track.group).length).toBeLessThanOrEqual(6);
    track.dispose();
    shared.dispose();
  });

  it('raises the tarmac over a bump, at least every half metre along it', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const road = chunkMeshes(track.group)[0];
    // The tarmac's left-hand column is the only thing built exactly on the road edge.
    const edge = worldVertices(road)
      .filter((v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && v.y >= Y_ROAD - 1e-6 && v.y < Y_ROAD + bump.height + 1e-3)
      .filter((v) => Math.abs(v.r - SURFACE.road.r) < SURFACE.road.r * 2)
      .sort((a, b) => a.x - b.x);
    const onBump = edge.filter((v) => Math.abs(v.x - bump.x) <= bump.halfLength);
    expect(onBump.length).toBeGreaterThan(12);
    let crest = 0;
    for (let i = 0; i < onBump.length; i++) {
      expect(onBump[i].y).toBeCloseTo(Y_ROAD + profile(bump, onBump[i].x), 4);
      if (i > 0) expect(onBump[i].x - onBump[i - 1].x).toBeLessThanOrEqual(0.5 + 1e-4);
      crest = Math.max(crest, onBump[i].y);
    }
    expect(crest).toBeGreaterThan(Y_ROAD + bump.height * 0.97);
    // Away from the bump the road is flat and not subdivided.
    const flat = edge.filter((v) => v.x < 100);
    for (const v of flat) expect(v.y).toBeCloseTo(Y_ROAD, 6);
    expect(flat.length).toBeLessThan(100 / SPACING + 3);
    expect(track.heightAt(120, 0)).toBeCloseTo(0.6, 9);
    track.dispose();
    shared.dispose();
  });

  it('keeps wall tops 0.7 m above the ground they stand on', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const road = chunkMeshes(track.group)[0];
    const outerFace = worldVertices(road).filter(
      (v) => Math.abs(v.z + HALF_WIDTH + WALL_HALF_THICK) < 1e-4 && v.y > 0.5 && v.x > 1 && v.x < CHUNK_LENGTH - 1,
    );
    expect(outerFace.length).toBeGreaterThan(100);
    let highest = 0;
    for (const v of outerFace) {
      // Wall ends are stretched a few centimetres past their segment, hence millimetres of slack on the bump.
      if (Math.abs(v.x - bump.x) < bump.halfLength) expect(v.y).toBeCloseTo(WALL_HEIGHT + profile(bump, v.x), 2);
      else expect(v.y).toBeCloseTo(WALL_HEIGHT, 5);
      highest = Math.max(highest, v.y);
    }
    expect(highest).toBeGreaterThan(WALL_HEIGHT + bump.height * 0.97);
    track.dispose();
    shared.dispose();
  });

  it('paints a warning on the bump: crest line, stripes and chevrons before it', () => {
    const shared = createTrackShared();
    const plain = createEndlessVisual(shared);
    plain.addChunk(straightChunk(0, 0));
    const marked = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    marked.addChunk(straightChunk(0, 0, [bump]));
    const bright = (mesh: Mesh): WorldVertex[] =>
      worldVertices(mesh).filter((v) => v.r > 0.8 && Math.abs(v.z) < HALF_WIDTH - 0.75 && v.y < 1);
    const before = bright(chunkMeshes(plain.group)[0]).length;
    const paint = bright(chunkMeshes(marked.group)[0]);
    expect(before).toBe(0);
    // On the crest, and on the flat road before the bump but not after it.
    expect(paint.some((v) => Math.abs(v.x - bump.x) < 0.3 && v.y > bump.height)).toBe(true);
    expect(paint.some((v) => v.x < bump.x - bump.halfLength - 2 && v.y < 0.05)).toBe(true);
    expect(paint.some((v) => v.x > bump.x + bump.halfLength + 0.5)).toBe(false);
    plain.dispose();
    marked.dispose();
    shared.dispose();
  });

  it('joins chunks without a gap: the tarmac laps under the next chunk at the same height', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    const [first, second] = chunkMeshes(track.group).filter((m) => m.material === shared.solid);
    const tarmac = (mesh: Mesh): WorldVertex[] =>
      worldVertices(mesh).filter((v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && Math.abs(v.y - Y_ROAD) < 1e-6);
    const end = Math.max(...tarmac(first).map((v) => v.x));
    const start = Math.min(...tarmac(second).map((v) => v.x));
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThan(0.2);
    track.dispose();
    shared.dispose();
  });

  it('lays tarmac in the walled run-off behind the start line, on a hand-built and on a generated first chunk', () => {
    // Chunk 0's edges begin at the start pose, where the car sits through the countdown; its walls close the road
    // further back, and the car can reverse in there. The surface has to reach that closing wall.
    const handBuilt = straightChunk(0, 0);
    handBuilt.walls.pop();
    handBuilt.walls.push(
      { ax: -14, az: -HALF_WIDTH, bx: 0, bz: -HALF_WIDTH },
      { ax: -14, az: HALF_WIDTH, bx: 0, bz: HALF_WIDTH },
      { ax: -14, az: -HALF_WIDTH, bx: -14, bz: HALF_WIDTH },
    );
    const chunks = [handBuilt];
    for (const difficulty of ['easy', 'medium', 'hard'] as const) chunks.push(createEndlessGenerator('run-off', difficulty).next());
    for (const chunk of chunks) {
      expect(chunk.path[0].x).toBe(0);
      const wallBack = Math.min(...chunk.walls.map((w) => Math.min(w.ax, w.bx)));
      expect(wallBack).toBeLessThan(-5);
      const before = JSON.stringify(chunk);
      const shared = createTrackShared();
      const track = createEndlessVisual(shared);
      track.addChunk(chunk);
      const road = chunkMeshes(track.group).find((m) => m.material === shared.solid) as Mesh;
      const half = chunk.path[0].halfWidth;
      const tarmac = worldVertices(road).filter((v) => Math.abs(v.y - Y_ROAD) < 1e-6 && Math.abs(v.r - SURFACE.road.r) < 1e-6);
      expect(Math.min(...tarmac.map((v) => v.x))).toBeCloseTo(wallBack, 3);
      // Wall to wall at the back, too.
      const back = tarmac.filter((v) => Math.abs(v.x - wallBack) < 1e-3).map((v) => v.z);
      expect(Math.min(...back)).toBeCloseTo(-half, 3);
      expect(Math.max(...back)).toBeCloseTo(half, 3);
      // The chunk itself is left as it was.
      expect(JSON.stringify(chunk)).toBe(before);
      track.dispose();
      shared.dispose();
    }
    // A later chunk has no run-off: its surface starts on its entry line.
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    const road = chunkMeshes(track.group).find((m) => m.material === shared.solid) as Mesh;
    const tarmac = worldVertices(road).filter((v) => Math.abs(v.y - Y_ROAD) < 1e-6 && Math.abs(v.r - SURFACE.road.r) < 1e-6);
    expect(Math.min(...tarmac.map((v) => v.x))).toBeCloseTo(CHUNK_LENGTH, 3);
    track.dispose();
    shared.dispose();
  });

  it('rebuilds the chunk before when a bump sits on the join', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    const bump = bumpAt(CHUNK_LENGTH + 1, 0.5, 3);
    track.addChunk(straightChunk(1, CHUNK_LENGTH, [bump]));
    const first = chunkMeshes(track.group).find((m) => m.material === shared.solid && m.position.x === 0)!;
    const raised = worldVertices(first).filter(
      (v) => Math.abs(v.z + HALF_WIDTH) < 1e-5 && v.x > CHUNK_LENGTH - 1.5 && v.y > Y_ROAD + 0.1 && v.y < 0.6,
    );
    expect(raised.length).toBeGreaterThan(0);
    for (const v of raised) expect(v.y).toBeCloseTo(Y_ROAD + profile(bump, v.x), 4);
    track.dispose();
    shared.dispose();
  });

  it('frees a removed chunk and nothing else', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    let materialsDisposed = 0;
    for (const m of [shared.solid, shared.glow, shared.decorMaterial]) {
      m.addEventListener('dispose', () => materialsDisposed++);
    }
    let sharedGeometryDisposed = 0;
    shared.decorGeometry.addEventListener('dispose', () => sharedGeometryDisposed++);

    track.addChunk(straightChunk(0, 0, [bumpAt(120)]));
    track.addChunk(straightChunk(1, CHUNK_LENGTH, [bumpAt(CHUNK_LENGTH + 100)]));
    const owned = chunkMeshes(track.group).filter((m) => m.position.x === 0);
    let disposed = 0;
    for (const mesh of owned) {
      if (mesh.geometry !== shared.decorGeometry) mesh.geometry.addEventListener('dispose', () => disposed++);
      else mesh.addEventListener('dispose', () => disposed++);
    }
    expect(track.heightAt(120, 0)).toBeGreaterThan(0.5);

    track.removeChunk(0);
    track.removeChunk(7);
    expect(disposed).toBe(owned.length);
    expect(track.chunkCount).toBe(1);
    expect(track.heightAt(120, 0)).toBe(0);
    expect(track.heightAt(CHUNK_LENGTH + 100, 0)).toBeGreaterThan(0.5);
    expect(materialsDisposed).toBe(0);
    expect(sharedGeometryDisposed).toBe(0);

    // The road is now open behind chunk 1: the end wall closes it.
    const cap = track.group.children[1];
    expect(cap.visible).toBe(true);
    expect(cap.position.x).toBeCloseTo(CHUNK_LENGTH, 9);
    expect(cap.scale.x).toBeGreaterThan(2 * HALF_WIDTH);

    track.clear();
    expect(track.chunkCount).toBe(0);
    expect(track.group.visible).toBe(false);
    expect(materialsDisposed).toBe(0);
    track.dispose();
    shared.dispose();
    expect(materialsDisposed).toBe(3);
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
    expect(Math.abs(floor.position.z + 7_890.1)).toBeLessThanOrEqual(6);
    track.dispose();
    shared.dispose();
  });

  it('adds a chunk well inside a frame', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const chunks: TrackChunk[] = [];
    for (let i = 0; i < 24; i++) {
      const x = i * CHUNK_LENGTH;
      chunks.push(straightChunk(i, x, [bumpAt(x + 80), bumpAt(x + 180, 0.9, 2.5)]));
    }
    const times: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const t0 = performance.now();
      track.addChunk(chunks[i]);
      times.push(performance.now() - t0);
      if (i >= 4) track.removeChunk(i - 4);
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
  // The camera looks from +x, +z and above (see camera.ts): "behind" a block is on its -x, -z side.
  const block = { x: 30, z: -30, w: 12, d: 10, h: 18, hue: 0 };

  /** Height each city block of a chunk is drawn at. */
  function blockHeights(track: { group: { children: unknown[] } }, shared: { decorMaterial: unknown }): number[] {
    const mesh = chunkMeshes(track.group).find((m) => m.material === shared.decorMaterial) as InstancedMesh;
    const matrix = new Matrix4();
    const heights: number[] = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      heights.push(matrix.elements[5]);
    }
    return heights;
  }

  it('knows which blocks hide a point from the locked camera', () => {
    // On the ground just behind it, and further back where the sight line still passes under the roof.
    expect(blockHides(block, 22, 0, -38)).toBe(true);
    expect(blockHides(block, 16, 0, -44)).toBe(true);
    // Inside its footprint, and beside it within a car's length.
    expect(blockHides(block, 30, 0, -30)).toBe(true);
    expect(blockHides(block, 38, 0, -33)).toBe(true);
    // Far enough behind that the sight line clears the roof; in front of it; well to the side; above the roof.
    expect(blockHides(block, 8, 0, -52)).toBe(false);
    expect(blockHides(block, 42, 0, -18)).toBe(false);
    expect(blockHides(block, 30, 0, 0)).toBe(false);
    expect(blockHides(block, 55, 0, -45)).toBe(false);
    expect(blockHides(block, 22, 18, -38)).toBe(false);
    // Flying higher, the car shows over a block that would hide it on the ground.
    expect(blockHides(block, 16, 0, -44)).toBe(true);
    expect(blockHides(block, 16, 8, -44)).toBe(false);
  });

  it('sinks the blocks that hide a car in the air or wrecked off the road, and raises them afterwards', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    track.addChunk(straightChunk(0, 0));
    track.addChunk(straightChunk(1, CHUNK_LENGTH));
    const built = blockHeights(track, shared);
    expect(built).toEqual([18, 30, 12]);

    // On the road nothing is in the way, in the air or not; and off the road nothing sinks unless asked.
    for (let i = 0; i < 30; i++) track.seeThrough(60, i < 15 ? 3 : 0, 0, true, 1 / 60);
    for (let i = 0; i < 30; i++) track.seeThrough(22, 0, -38, false, 1 / 60);
    expect(track.sunkBlocks).toBe(0);
    expect(blockHeights(track, shared)).toEqual(built);

    // The car has flown off the road and come down behind the first block.
    track.seeThrough(22, 0, -38, true, 1 / 60);
    expect(track.sunkBlocks).toBe(1);
    const sinking = blockHeights(track, shared)[0];
    expect(sinking).toBeLessThan(18);
    expect(sinking).toBeGreaterThan(10);
    for (let i = 0; i < 20; i++) track.seeThrough(22, 0, -38, true, 1 / 60);
    const sunk = blockHeights(track, shared);
    expect(sunk[0]).toBeLessThan(0.1);
    expect(sunk[0]).toBeGreaterThan(0);
    expect(sunk.slice(1)).toEqual(built.slice(1));
    // It stays down while the car is out there, even where the block would no longer be in the way.
    for (let i = 0; i < 20; i++) track.seeThrough(60, 0, 0, true, 1 / 60);
    expect(blockHeights(track, shared)[0]).toBe(sunk[0]);
    expect(track.sunkBlocks).toBe(1);

    // Back on the road (or a new run on the same road): everything stands again, exactly as built.
    for (let i = 0; i < 60; i++) track.seeThrough(60, 0, 0, false, 1 / 60);
    expect(track.sunkBlocks).toBe(0);
    expect(blockHeights(track, shared)).toEqual(built);

    // A chunk that is removed takes its sunk blocks with it.
    for (let i = 0; i < 20; i++) track.seeThrough(22, 0, -38, true, 1 / 60);
    expect(track.sunkBlocks).toBe(1);
    track.removeChunk(0);
    expect(track.sunkBlocks).toBe(0);
    track.seeThrough(22, 0, -38, false, 1 / 60);
    track.clear();
    expect(track.sunkBlocks).toBe(0);
    track.dispose();
    shared.dispose();
  });
});

describe('weekly level on the shared builder', () => {
  it('still builds in four draw calls and leaves the shared materials alone', () => {
    const shared = createTrackShared();
    let materialsDisposed = 0;
    shared.solid.addEventListener('dispose', () => materialsDisposed++);
    const visual = buildLevelVisual(generateLevel('2026-W48'), shared);
    expect(visual.group.children.length).toBeLessThanOrEqual(4);
    expect(visual.group.children.length).toBeGreaterThanOrEqual(2);
    const road = visual.group.children.find((c) => (c as Mesh).material === shared.solid) as Mesh;
    expect(road.geometry.getAttribute('position').count).toBeGreaterThan(1000);
    visual.dispose();
    expect(materialsDisposed).toBe(0);
    shared.dispose();
  });
});

describe('car in the air', () => {
  function airborneCar(vy: number): CarState {
    const car = createCarState({ x: 10, z: 5, heading: 0 });
    car.vx = 30;
    car.speed = 30;
    car.forwardSpeed = 30;
    car.airborne = true;
    car.vy = vy;
    car.y = 2;
    return car;
  }

  it('lifts the body and leaves a smaller, fainter shadow on the ground', () => {
    const visual = createCarVisual(createSoftTexture());
    const grounded = createCarState({ x: 10, z: 5, heading: 0 });
    visual.update(frameFor(grounded, 0));
    const [body, rig] = visual.group.children;
    const shadow = rig.children[0] as Mesh;
    const shadowMaterial = shadow.material as { opacity: number };
    const groundScale = shadow.scale.x;
    const groundOpacity = shadowMaterial.opacity;
    expect(body.position.y).toBe(0);
    expect(body.rotation.z).toBeCloseTo(0, 9);

    for (let i = 0; i < 30; i++) visual.update(frameFor(airborneCar(6), 2));
    expect(visual.group.position.y).toBe(0);
    expect(body.position.y).toBeCloseTo(2, 6);
    expect(rig.position.y).toBe(0);
    expect(shadow.scale.x).toBeLessThan(groundScale);
    expect(shadowMaterial.opacity).toBeLessThan(groundOpacity);
    expect(shadowMaterial.opacity).toBeGreaterThan(0.1);
    // Nose up while climbing, nose down while falling, and gently.
    expect(body.rotation.z).toBeGreaterThan(0.02);
    expect(body.rotation.z).toBeLessThan(0.3);
    for (let i = 0; i < 60; i++) visual.update(frameFor(airborneCar(-6), 2));
    expect(body.rotation.z).toBeLessThan(-0.02);
    visual.dispose();
  });

  it('pitches with the slope while its wheels are on a bump', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const visual = createCarVisual(createSoftTexture());
    const body = visual.group.children[0];
    // Heading +x, half way up the near face.
    const car = createCarState({ x: 118.5, z: 0, heading: 0 });
    for (let i = 0; i < 30; i++) visual.update(frameFor(car, track.heightAt(car.x, car.z)), track);
    expect(body.rotation.z).toBeGreaterThan(0.08);
    expect(body.position.y).toBeGreaterThan(0.1);
    // And the other way on the far face.
    const beyond = createCarState({ x: 121.5, z: 0, heading: 0 });
    for (let i = 0; i < 30; i++) visual.update(frameFor(beyond, track.heightAt(beyond.x, beyond.z)), track);
    expect(body.rotation.z).toBeLessThan(-0.08);
    visual.dispose();
    track.dispose();
    shared.dispose();
  });
});

describe('skid marks and jumps', () => {
  function slidingCar(x: number): CarState {
    const car = createCarState({ x, z: 0, heading: 0 });
    car.rearSlide = 1;
    car.frontSlide = 1;
    return car;
  }

  it('lays nothing while the car is in the air', () => {
    const skid = createSkidMarks();
    for (let i = 0; i < 20; i++) {
      const car = slidingCar(i * 0.5);
      car.airborne = true;
      skid.lay(car, DEFAULT_CAR_PARAMS);
    }
    const position = (skid.mesh.geometry as BufferGeometry).getAttribute('position');
    expect(Array.prototype.every.call(position.array, (v: number) => v === 0)).toBe(true);
    skid.dispose();
  });

  it('follows the ground over a bump', () => {
    const shared = createTrackShared();
    const track = createEndlessVisual(shared);
    const bump = bumpAt(120, 0.6, 3);
    track.addChunk(straightChunk(0, 0, [bump]));
    const skid = createSkidMarks();
    for (let x = 112; x < 128; x += 0.25) skid.lay(slidingCar(x), DEFAULT_CAR_PARAMS, track);
    const position = (skid.mesh.geometry as BufferGeometry).getAttribute('position');
    let highest = 0;
    let written = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      if (x === 0 && y === 0) continue;
      written++;
      expect(y).toBeCloseTo(0.04 + profile(bump, x), 2);
      highest = Math.max(highest, y);
    }
    expect(written).toBeGreaterThan(40);
    expect(highest).toBeGreaterThan(0.5);
    skid.dispose();
    track.dispose();
    shared.dispose();
  });
});

describe('camera once the run is over', () => {
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
    // Height never changes: jumps do not move the camera.
    expect(settled.camera.position.y).toBeCloseTo(rest.camera.position.y, 9);
  });
});
