import { Color, Group, Mesh } from 'three';
import type { BoxGeometry, BufferGeometry, InstancedMesh, MeshBasicMaterial } from 'three';
import type { Bump, TrackChunk, Vec2 } from '../types';
import { GeometryBuilder } from './geometry';
import { stepNear } from './ground';
import { GRID_CELL, GRID_HALF_WIDTH, Y_GRID, Y_GROUND } from './levelMesh';
import { blockSet } from './occlusion';
import type { BlockSet, DeckSections } from './occlusion';
import { ACCENTS, HUE, SURFACE } from './palette';
import {
  DECK_DEPTH,
  WALL_HALF_THICK,
  WALL_HEIGHT,
  WALL_OVERLAP,
  addRoadPiece,
  addRoadPieceGlow,
  addRoadShadow,
  allocateSections,
  buildDecorMesh,
  closedEndCorner,
} from './roadPiece';
import type { RoadPiece, TrackShared } from './roadPiece';
import { PathIndex } from './surface';

export { blockHides } from './occlusion';

/**
 * The endless road: one small set of meshes per chunk, added ahead of the car and removed behind it, over a city
 * floor that follows the car so it never runs out.
 *
 * Draw calls: at most four per chunk (the deck with everything opaque on it, the light on it, its shadow on the
 * floor, its city blocks), plus one for the floor and one for the wall across the open end behind the car.
 * Materials are shared with the fixed levels; a chunk owns only its geometry and its section ids.
 */

/**
 * Each chunk's tarmac runs this far past its last point, under the start of the next. Two chunks never share
 * vertices (each mesh has its own origin), so without the lap a hairline of floor could show through the join.
 * Both layers are the same colour at the same height, so the lap itself cannot be seen.
 */
const SEAM_OVERLAP = 0.05;
/** A bump within this distance of a chunk's entry line counts as reaching the chunk before it, m. */
const ENTRY_PAD = 0.3;
/** The surface index lets a chunk's road reach this far past either end, so the joins never drop out, m. */
const JOIN_REACH = 0.5;

/** The floor reaches this far from the car in x and z: well beyond anything the locked camera can show. */
const FLOOR_GRID_CELLS = 22;
const FLOOR_HALF = 900;
/**
 * The fixed levels fade their grid out with distance from the road. A grid that moves with the car cannot do that
 * without the fade visibly sliding, so it is one even tone, about what a level shows a short way off the road.
 */
const FLOOR_GRID_STRENGTH = 0.7;

function buildFloorGeometry(): BufferGeometry {
  const b = new GeometryBuilder(512);
  const g = SURFACE.ground;
  const v0 = b.vertex(-FLOOR_HALF, Y_GROUND, -FLOOR_HALF, g);
  const v1 = b.vertex(FLOOR_HALF, Y_GROUND, -FLOOR_HALF, g);
  const v2 = b.vertex(FLOOR_HALF, Y_GROUND, FLOOR_HALF, g);
  const v3 = b.vertex(-FLOOR_HALF, Y_GROUND, FLOOR_HALF, g);
  b.quad(v0, v1, v2, v3);
  const line = new Color().copy(SURFACE.ground).lerp(SURFACE.grid, FLOOR_GRID_STRENGTH);
  const reach = FLOOR_GRID_CELLS * GRID_CELL;
  for (let i = -FLOOR_GRID_CELLS; i <= FLOOR_GRID_CELLS; i++) {
    const at = i * GRID_CELL;
    b.line(-reach, at, reach, at, GRID_HALF_WIDTH, Y_GRID, line);
    b.line(at, -reach, at, reach, GRID_HALF_WIDTH, Y_GRID, line);
  }
  return b.build();
}

/** A wall one metre long, centred on the origin along +X, standing on y = 0: placed across the road's open end. */
function buildCapGeometry(): BufferGeometry {
  const b = new GeometryBuilder(64);
  b.box(0, 0, 1, 0, 0.5, WALL_HALF_THICK, -DECK_DEPTH, WALL_HEIGHT, SURFACE.wall, ACCENTS[HUE.violet].glow);
  return b.build();
}

class ChunkVisual {
  readonly bumps: readonly Bump[];
  /** The chunk's entry line, left edge to right edge, and the road height there. */
  readonly entryAX: number;
  readonly entryAZ: number;
  readonly entryBX: number;
  readonly entryBZ: number;
  readonly entryY: number;
  readonly hasEntry: boolean;
  private readonly blocks: BlockSet | null;

  constructor(
    readonly chunk: TrackChunk,
    private readonly shared: TrackShared,
    readonly index: PathIndex,
    readonly sections: DeckSections,
    readonly meshes: readonly Mesh[],
    private readonly decor: InstancedMesh<BoxGeometry, MeshBasicMaterial> | null,
  ) {
    this.bumps = chunk.bumps;
    this.hasEntry = chunk.left.length > 0 && chunk.right.length > 0;
    this.entryAX = this.hasEntry ? chunk.left[0].x : 0;
    this.entryAZ = this.hasEntry ? chunk.left[0].z : 0;
    this.entryBX = this.hasEntry ? chunk.right[0].x : 0;
    this.entryBZ = this.hasEntry ? chunk.right[0].z : 0;
    this.entryY = chunk.path.length > 0 ? chunk.path[0].y : 0;
    this.blocks = decor ? blockSet(chunk.decor, decor) : null;
  }

  /** Puts the meshes in the scene and tells the shared registries about the chunk. */
  show(group: Group): void {
    for (const mesh of this.meshes) group.add(mesh);
    if (this.decor) group.add(this.decor);
    if (this.blocks) this.shared.sinker.add(this.blocks);
    this.shared.fader.add(this.sections);
    this.shared.surface.add(this.chunk.index, this.index, this.chunk.bumps);
  }

  /** Frees what the chunk owns: its geometry, instance buffers and section ids. Materials are shared. */
  dispose(): void {
    const shared = this.shared;
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    if (this.decor) {
      this.decor.removeFromParent();
      this.decor.dispose();
    }
    if (this.blocks) shared.sinker.remove(this.blocks);
    shared.fader.remove(this.sections);
    shared.sections.free(this.sections.base, this.sections.starts.length - 1);
    shared.surface.remove(this.chunk.index);
  }
}

export interface EndlessVisual {
  readonly group: Group;
  /** Number of chunks on show. */
  readonly chunkCount: number;
  /** Shows the floor, ready for chunks. */
  begin(): void;
  addChunk(chunk: TrackChunk): void;
  /** Unknown indices are ignored. */
  removeChunk(index: number): void;
  /** Removes every chunk and hides the floor. */
  clear(): void;
  /** Keeps the floor under the car. Call once per frame with the car's position. */
  update(x: number, z: number): void;
  dispose(): void;
}

class EndlessTrack implements EndlessVisual {
  readonly group = new Group();
  private readonly chunks = new Map<number, ChunkVisual>();
  private readonly floor: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly cap: Mesh<BufferGeometry, MeshBasicMaterial>;
  // Working buffers, kept between chunks so building one leaves nothing behind but its finished geometry.
  private readonly builder = new GeometryBuilder(16384);
  private readonly glowBuilder = new GeometryBuilder(1024);
  private readonly shadowBuilder = new GeometryBuilder(1024);
  private readonly groundBumps: Bump[] = [];
  /** The first chunk's tarmac outline, with the walled run-off behind the start line added: see `build`. */
  private readonly startLeft: Vec2[] = [];
  private readonly startRight: Vec2[] = [];
  private readonly heights: number[] = [];
  private readonly piece: RoadPiece = {
    path: [],
    left: [],
    right: [],
    heights: this.heights,
    lead: 0,
    leftOpen: [],
    rightOpen: [],
    walls: [],
    props: [],
    supports: [],
    decor: [],
    bumps: [],
    ground: this.groundBumps,
    groundCount: 0,
    overlap: SEAM_OVERLAP,
    variation: 0,
    sectionBase: 0,
    sectionStarts: new Int32Array(0),
  };

  constructor(private readonly shared: TrackShared) {
    this.floor = new Mesh(buildFloorGeometry(), shared.solid);
    this.floor.frustumCulled = false;
    this.cap = new Mesh(buildCapGeometry(), shared.solid);
    this.cap.visible = false;
    this.group.add(this.floor, this.cap);
    this.group.visible = false;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  begin(): void {
    this.group.visible = true;
  }

  addChunk(chunk: TrackChunk): void {
    this.removeOne(chunk.index);
    this.chunks.set(chunk.index, this.build(chunk));
    // A bump right at the start of this chunk also lifts the end of the one before, which was built without
    // knowing about it. Rare (generators keep bumps clear of the joins), but then that chunk is built again.
    const before = this.chunks.get(chunk.index - 1);
    if (before && touchesEntry(chunk)) {
      before.dispose();
      this.chunks.set(chunk.index - 1, this.build(before.chunk));
    }
    this.placeCap();
  }

  /** Builds the chunk's meshes and puts them in the scene. */
  private build(chunk: TrackChunk): ChunkVisual {
    const originX = chunk.path.length > 0 ? chunk.path[0].x : 0;
    const originZ = chunk.path.length > 0 ? chunk.path[0].z : 0;

    // A bump close to a join shapes the surface of both chunks: take the neighbours' bumps into account too.
    const ground = this.groundBumps;
    ground.length = 0;
    for (let i = 0; i < chunk.bumps.length; i++) ground.push(chunk.bumps[i]);
    this.addNeighbourBumps(chunk.index - 1);
    this.addNeighbourBumps(chunk.index + 1);

    const piece = this.piece;
    const heights = this.heights;
    heights.length = 0;
    for (let i = 0; i < chunk.path.length; i++) heights.push(chunk.path[i].y);
    piece.path = chunk.path;
    piece.left = chunk.left;
    piece.right = chunk.right;
    piece.lead = 0;
    let runOff = JOIN_REACH;
    // Chunk 0's edges begin at the start line, but its walls run on to a closing wall behind it and the car can
    // drive (and sits half) in that stretch. Its tarmac starts at the closing wall, as a fixed level's does.
    if (chunk.index === 0 && chunk.left.length > 1 && chunk.right.length > 1) {
      const l = closedEndCorner(chunk.walls, chunk.left[0], chunk.left[1]);
      const r = closedEndCorner(chunk.walls, chunk.right[0], chunk.right[1]);
      if (l && r) {
        const { startLeft, startRight } = this;
        startLeft.push(l);
        startRight.push(r);
        for (let i = 0; i < chunk.left.length; i++) startLeft.push(chunk.left[i]);
        for (let i = 0; i < chunk.right.length; i++) startRight.push(chunk.right[i]);
        piece.left = startLeft;
        piece.right = startRight;
        heights.unshift(chunk.path[0].y);
        piece.lead = 1;
        const p = chunk.path[0];
        runOff = Math.hypot((l.x + r.x) / 2 - p.x, (l.z + r.z) / 2 - p.z);
      }
    }
    piece.leftOpen = chunk.leftOpen;
    piece.rightOpen = chunk.rightOpen;
    piece.walls = chunk.walls;
    piece.props = chunk.props;
    piece.supports = chunk.supports;
    piece.decor = chunk.decor;
    piece.bumps = chunk.bumps;
    piece.groundCount = ground.length;
    piece.variation = Math.imul(chunk.index + 1, 7919);
    const sections = allocateSections(chunk.path, this.shared.sections);
    piece.sectionBase = sections.base;
    piece.sectionStarts = sections.starts;

    const meshes: Mesh[] = [];
    const builder = this.builder.reset(originX, originZ);
    builder.trackSections = true;
    addRoadPiece(builder, piece);
    meshes.push(placeStatic(new Mesh(builder.build(), this.shared.deck), originX, originZ, 0));

    const glowBuilder = this.glowBuilder.reset(originX, originZ);
    glowBuilder.trackSections = true;
    addRoadPieceGlow(glowBuilder, piece);
    if (glowBuilder.vertexCount > 0) {
      meshes.push(placeStatic(new Mesh(glowBuilder.build(), this.shared.deckGlow), originX, originZ, 1));
    }

    const shadowBuilder = this.shadowBuilder.reset(originX, originZ);
    addRoadShadow(shadowBuilder, piece);
    if (shadowBuilder.vertexCount > 0) {
      meshes.push(placeStatic(new Mesh(shadowBuilder.build(), this.shared.shadow), originX, originZ, -1));
    }

    const decor = buildDecorMesh(chunk.decor, this.shared, originX, originZ);
    if (decor) {
      decor.matrixAutoUpdate = false;
      decor.updateMatrix();
    }

    // Do not keep the chunk's arrays alive through the reused piece.
    piece.path = piece.left = piece.right = EMPTY;
    piece.leftOpen = piece.rightOpen = EMPTY;
    piece.walls = piece.props = piece.supports = piece.decor = piece.bumps = EMPTY;
    piece.sectionStarts = NO_SECTIONS;
    ground.length = 0;
    heights.length = 0;
    this.startLeft.length = 0;
    this.startRight.length = 0;

    const index = new PathIndex(chunk.path, runOff, JOIN_REACH);
    const visual = new ChunkVisual(chunk, this.shared, index, sections, meshes, decor);
    visual.show(this.group);
    return visual;
  }

  removeChunk(index: number): void {
    if (this.removeOne(index)) this.placeCap();
  }

  clear(): void {
    for (const visual of this.chunks.values()) visual.dispose();
    this.chunks.clear();
    this.placeCap();
    this.group.visible = false;
  }

  update(x: number, z: number): void {
    // Whole cells only: the grid then looks nailed to the world while it is really being carried along.
    this.floor.position.set(Math.round(x / GRID_CELL) * GRID_CELL, 0, Math.round(z / GRID_CELL) * GRID_CELL);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.floor.geometry.dispose();
    this.cap.geometry.dispose();
  }

  private addNeighbourBumps(index: number): void {
    const neighbour = this.chunks.get(index);
    if (!neighbour) return;
    for (let i = 0; i < neighbour.bumps.length; i++) this.groundBumps.push(neighbour.bumps[i]);
  }

  private removeOne(index: number): boolean {
    const visual = this.chunks.get(index);
    if (!visual) return false;
    visual.dispose();
    this.chunks.delete(index);
    return true;
  }

  /**
   * The simulation closes the road behind the car at the entry of its oldest chunk; this is that wall. Chunk 0
   * brings its own, built from its wall list like any other.
   */
  private placeCap(): void {
    let oldest = Infinity;
    for (const index of this.chunks.keys()) if (index < oldest) oldest = index;
    const visual = oldest > 0 && oldest !== Infinity ? this.chunks.get(oldest) : undefined;
    const cap = this.cap;
    if (!visual || !visual.hasEntry) {
      cap.visible = false;
      return;
    }
    const dx = visual.entryBX - visual.entryAX;
    const dz = visual.entryBZ - visual.entryAZ;
    cap.position.set((visual.entryAX + visual.entryBX) / 2, visual.entryY, (visual.entryAZ + visual.entryBZ) / 2);
    cap.rotation.y = -Math.atan2(dz, dx);
    cap.scale.x = Math.sqrt(dx * dx + dz * dz) + 2 * WALL_OVERLAP;
    cap.visible = true;
  }
}

const EMPTY: never[] = [];
const NO_SECTIONS = new Int32Array(0);

/** True when one of the chunk's own bumps reaches its entry line, and so the end of the chunk before it. */
function touchesEntry(chunk: TrackChunk): boolean {
  if (chunk.bumps.length === 0 || chunk.left.length === 0 || chunk.right.length === 0) return false;
  const l = chunk.left[0];
  const r = chunk.right[0];
  const y = chunk.path.length > 0 ? chunk.path[0].y : 0;
  return stepNear(chunk.bumps, chunk.bumps.length, l.x, l.z, r.x, r.z, ENTRY_PAD, y, y) > 0;
}

/** A chunk never moves once placed: its matrix is worked out here, once, instead of on every frame. */
function placeStatic(mesh: Mesh, x: number, z: number, renderOrder: number): Mesh {
  mesh.position.set(x, 0, z);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.renderOrder = renderOrder;
  return mesh;
}

export function createEndlessVisual(shared: TrackShared): EndlessVisual {
  return new EndlessTrack(shared);
}
