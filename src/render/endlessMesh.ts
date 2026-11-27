import { Color, Group, Matrix4, Mesh } from 'three';
import type { BoxGeometry, BufferGeometry, InstancedMesh, MeshBasicMaterial } from 'three';
import type { Bump, DecorBlock, TrackChunk, Vec2 } from '../types';
import { CAMERA_PITCH, CAMERA_YAW } from './camera';
import { GeometryBuilder } from './geometry';
import { bumpHeightAt, stepNear } from './ground';
import type { Ground } from './ground';
import { GRID_CELL, GRID_HALF_WIDTH, Y_GRID, Y_GROUND } from './levelMesh';
import { ACCENTS, HUE, SURFACE } from './palette';
import {
  WALL_HALF_THICK,
  WALL_HEIGHT,
  WALL_OVERLAP,
  addRoadPiece,
  addRoadPieceGlow,
  buildDecorMesh,
  closedEndCorner,
} from './roadPiece';
import type { RoadPiece, TrackShared } from './roadPiece';

/**
 * The endless road: one small set of meshes per chunk, added ahead of the car and removed behind it, on a floor
 * that follows the car so it never runs out.
 *
 * Draw calls: at most three per chunk (everything opaque, the light pools round its pillars, its city blocks),
 * plus one for the floor and one for the wall across the open end behind the car. Materials are shared with the
 * weekly level; a chunk owns only its geometry.
 */

/**
 * Each chunk's tarmac runs this far past its last point, under the start of the next. Two chunks never share
 * vertices (each mesh has its own origin), so without the lap a hairline of ground could show through the join.
 * Both layers are the same colour at the same height, so the lap itself cannot be seen.
 */
const SEAM_OVERLAP = 0.05;
/** A bump within this distance of a chunk's entry line counts as reaching the chunk before it, m. */
const ENTRY_PAD = 0.3;

/** The floor reaches this far from the car in x and z: well beyond anything the locked camera can show. */
const FLOOR_GRID_CELLS = 22;
const FLOOR_HALF = 900;
/**
 * The weekly level fades its grid out with distance from the road. A grid that moves with the car cannot do that
 * without the fade visibly sliding, so it is one even tone, about what the level shows a short way off the road.
 */
const FLOOR_GRID_STRENGTH = 0.7;

/**
 * City blocks are opaque and stand right beside the road, and the camera never moves round them. A car that
 * leaves the road in the air can fly behind one, or come down inside one, and the player would see it vanish and
 * then a game-over screen. So while the car is in the air, or lies wrecked off the road, every block that stands
 * between it and the camera sinks into the ground; its neon outline (part of the chunk's own mesh) stays hanging,
 * so it still reads as a building. The blocks rise again once the car is back on the road.
 */
/** Unit direction from any point of the scene towards the locked camera. */
const TO_CAMERA_X = Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW);
const TO_CAMERA_Y = Math.sin(CAMERA_PITCH);
const TO_CAMERA_Z = Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW);
/** The sight line is taken from this far above the wheels, and a block counts if it comes this close to the line, m. */
const SIGHT_HEIGHT = 0.6;
const SIGHT_CLEARANCE = 2.8;
/** What is left of a sunk block: a slab on the ground, m. */
const SUNK_HEIGHT = 0.04;
/** Share of its height a block sinks, and rises again, per second. */
const SINK_RATE = 9;
const RISE_RATE = 2.5;
/** Blocks of one chunk are numbered below this in the keys of the sunk set. */
const BLOCK_KEY_SPAN = 4096;

/** Whether a block hides the point (x, y, z), or anything within SIGHT_CLEARANCE of it sideways, from the camera. */
export function blockHides(block: DecorBlock, x: number, y: number, z: number): boolean {
  const py = y + SIGHT_HEIGHT;
  if (py >= block.h) return false;
  // Ray from the point towards the camera against the block grown sideways by the clearance (slab test). All
  // three components of the direction are positive, so the ray leaves through the +x, top or +z face.
  const nearX = (block.x - block.w / 2 - SIGHT_CLEARANCE - x) / TO_CAMERA_X;
  const farX = (block.x + block.w / 2 + SIGHT_CLEARANCE - x) / TO_CAMERA_X;
  const nearZ = (block.z - block.d / 2 - SIGHT_CLEARANCE - z) / TO_CAMERA_Z;
  const farZ = (block.z + block.d / 2 + SIGHT_CLEARANCE - z) / TO_CAMERA_Z;
  const farY = (block.h - py) / TO_CAMERA_Y;
  const enter = Math.max(nearX, nearZ, 0);
  const leave = Math.min(farX, farZ, farY);
  return leave > enter;
}

interface SunkBlock {
  visual: ChunkVisual;
  block: number;
  key: number;
  /** 1 = standing at full height, 0 = sunk. */
  level: number;
}

const blockMatrix = new Matrix4();

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

/** A wall one metre long, centred on the origin along +X: scaled and turned to close the road's open end. */
function buildCapGeometry(): BufferGeometry {
  const b = new GeometryBuilder(64);
  b.box(0, 0, 1, 0, 0.5, WALL_HALF_THICK, 0, WALL_HEIGHT, SURFACE.wall, ACCENTS[HUE.violet].glow);
  return b.build();
}

class ChunkVisual {
  readonly bumps: readonly Bump[];
  /** The chunk's entry line, left edge to right edge. */
  readonly entryAX: number;
  readonly entryAZ: number;
  readonly entryBX: number;
  readonly entryBZ: number;
  readonly hasEntry: boolean;

  constructor(
    readonly chunk: TrackChunk,
    private readonly road: Mesh<BufferGeometry, MeshBasicMaterial>,
    private readonly glow: Mesh<BufferGeometry, MeshBasicMaterial> | null,
    private readonly decor: InstancedMesh<BoxGeometry, MeshBasicMaterial> | null,
  ) {
    this.bumps = chunk.bumps;
    this.hasEntry = chunk.left.length > 0 && chunk.right.length > 0;
    this.entryAX = this.hasEntry ? chunk.left[0].x : 0;
    this.entryAZ = this.hasEntry ? chunk.left[0].z : 0;
    this.entryBX = this.hasEntry ? chunk.right[0].x : 0;
    this.entryBZ = this.hasEntry ? chunk.right[0].z : 0;
  }

  get blockCount(): number {
    return this.decor ? this.chunk.decor.length : 0;
  }

  /** Draws city block `i` at `level` of its height (1 = as built). */
  setBlockLevel(i: number, level: number): void {
    const mesh = this.decor;
    if (!mesh) return;
    const block = this.chunk.decor[i];
    const height = Math.max(block.h * level, SUNK_HEIGHT);
    blockMatrix.makeScale(block.w, height, block.d).setPosition(block.x - mesh.position.x, 0, block.z - mesh.position.z);
    mesh.setMatrixAt(i, blockMatrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  addTo(group: Group): void {
    group.add(this.road);
    if (this.glow) group.add(this.glow);
    if (this.decor) group.add(this.decor);
  }

  /** Frees what the chunk owns: its geometry and instance buffers. Materials and the block geometry are shared. */
  dispose(): void {
    this.road.removeFromParent();
    this.road.geometry.dispose();
    if (this.glow) {
      this.glow.removeFromParent();
      this.glow.geometry.dispose();
    }
    if (this.decor) {
      this.decor.removeFromParent();
      this.decor.dispose();
    }
  }
}

export interface EndlessVisual extends Ground {
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
  /**
   * Keeps the car in sight. Call once per frame with the car's position (y = height of its wheels): while
   * `active`, every city block standing between that point and the camera sinks into the ground and stays down;
   * once it is no longer active they rise again. Pass `active` while the car is in the air or wrecked off the road.
   */
  seeThrough(x: number, y: number, z: number, active: boolean, dt: number): void;
  /** Number of city blocks currently sunk or on their way down or up. */
  readonly sunkBlocks: number;
  dispose(): void;
}

class EndlessTrack implements EndlessVisual {
  readonly group = new Group();
  private readonly chunks = new Map<number, ChunkVisual>();
  /** Every bump of every chunk on show: what `heightAt` answers from. */
  private readonly liveBumps: Bump[] = [];
  private readonly floor: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly cap: Mesh<BufferGeometry, MeshBasicMaterial>;
  // Working buffers, kept between chunks so building one leaves nothing behind but its finished geometry.
  private readonly builder = new GeometryBuilder(16384);
  private readonly glowBuilder = new GeometryBuilder(1024);
  private readonly groundBumps: Bump[] = [];
  /** City blocks that are not at full height: see `seeThrough`. */
  private readonly sunk: SunkBlock[] = [];
  private readonly sunkKeys = new Set<number>();
  /** The first chunk's tarmac outline, with the walled run-off behind the start line added: see `build`. */
  private readonly startLeft: Vec2[] = [];
  private readonly startRight: Vec2[] = [];
  private readonly piece: RoadPiece = {
    path: [],
    left: [],
    right: [],
    walls: [],
    props: [],
    decor: [],
    bumps: [],
    ground: this.groundBumps,
    groundCount: 0,
    overlap: SEAM_OVERLAP,
    variation: 0,
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
      this.forgetSunk(before);
      before.dispose();
      this.chunks.set(chunk.index - 1, this.build(before.chunk));
    }
    this.refresh();
  }

  /** Builds the chunk's meshes and puts them in the scene. */
  private build(chunk: TrackChunk): ChunkVisual {
    const originX = chunk.path.length > 0 ? chunk.path[0].x : 0;
    const originZ = chunk.path.length > 0 ? chunk.path[0].z : 0;

    // A bump close to a join shapes the ground of both chunks: take the neighbours' bumps into account too.
    const ground = this.groundBumps;
    ground.length = 0;
    for (let i = 0; i < chunk.bumps.length; i++) ground.push(chunk.bumps[i]);
    this.addNeighbourBumps(chunk.index - 1);
    this.addNeighbourBumps(chunk.index + 1);

    const piece = this.piece;
    piece.path = chunk.path;
    piece.left = chunk.left;
    piece.right = chunk.right;
    // Chunk 0's edges begin at the start line, but its walls run on to a closing wall behind it and the car can
    // drive (and sits half) in that stretch. Its tarmac starts at the closing wall, as the weekly level's does.
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
      }
    }
    piece.walls = chunk.walls;
    piece.props = chunk.props;
    piece.decor = chunk.decor;
    piece.bumps = chunk.bumps;
    piece.groundCount = ground.length;
    piece.variation = Math.imul(chunk.index + 1, 7919);

    const builder = this.builder.reset(originX, originZ);
    addRoadPiece(builder, piece);
    const road = new Mesh(builder.build(), this.shared.solid);
    placeStatic(road, originX, originZ);

    let glow: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
    if (chunk.props.length > 0) {
      const glowBuilder = this.glowBuilder.reset(originX, originZ);
      addRoadPieceGlow(glowBuilder, piece);
      glow = new Mesh(glowBuilder.build(), this.shared.glow);
      placeStatic(glow, originX, originZ);
    }

    const decor = buildDecorMesh(chunk.decor, this.shared, originX, originZ);
    if (decor) {
      decor.matrixAutoUpdate = false;
      decor.updateMatrix();
    }

    // Do not keep the chunk's arrays alive through the reused piece.
    piece.path = piece.left = piece.right = EMPTY;
    piece.walls = piece.props = piece.decor = piece.bumps = EMPTY;
    ground.length = 0;
    this.startLeft.length = 0;
    this.startRight.length = 0;

    const visual = new ChunkVisual(chunk, road, glow, decor);
    visual.addTo(this.group);
    return visual;
  }

  removeChunk(index: number): void {
    if (this.removeOne(index)) this.refresh();
  }

  clear(): void {
    for (const visual of this.chunks.values()) visual.dispose();
    this.chunks.clear();
    this.sunk.length = 0;
    this.sunkKeys.clear();
    this.refresh();
    this.group.visible = false;
  }

  update(x: number, z: number): void {
    // Whole cells only: the grid then looks nailed to the world while it is really being carried along.
    this.floor.position.set(Math.round(x / GRID_CELL) * GRID_CELL, 0, Math.round(z / GRID_CELL) * GRID_CELL);
  }

  get sunkBlocks(): number {
    return this.sunk.length;
  }

  seeThrough(x: number, y: number, z: number, active: boolean, dt: number): void {
    const sunk = this.sunk;
    if (active) {
      for (const [index, visual] of this.chunks) {
        const decor = visual.chunk.decor;
        const count = visual.blockCount;
        for (let i = 0; i < count; i++) {
          if (!blockHides(decor[i], x, y, z)) continue;
          const key = index * BLOCK_KEY_SPAN + i;
          if (this.sunkKeys.has(key)) continue;
          this.sunkKeys.add(key);
          sunk.push({ visual, block: i, key, level: 1 });
        }
      }
    }
    if (sunk.length === 0) return;
    const step = Math.max(0, dt) * (active ? -SINK_RATE : RISE_RATE);
    let kept = 0;
    for (let i = 0; i < sunk.length; i++) {
      const entry = sunk[i];
      const level = Math.min(1, Math.max(0, entry.level + step));
      if (level !== entry.level) {
        entry.level = level;
        entry.visual.setBlockLevel(entry.block, level);
      }
      if (level >= 1) this.sunkKeys.delete(entry.key);
      else sunk[kept++] = entry;
    }
    sunk.length = kept;
  }

  /** Forgets the sunk blocks of a chunk whose meshes are being thrown away. */
  private forgetSunk(visual: ChunkVisual): void {
    const sunk = this.sunk;
    let kept = 0;
    for (let i = 0; i < sunk.length; i++) {
      if (sunk[i].visual === visual) this.sunkKeys.delete(sunk[i].key);
      else sunk[kept++] = sunk[i];
    }
    sunk.length = kept;
  }

  heightAt(x: number, z: number): number {
    const bumps = this.liveBumps;
    return bumps.length === 0 ? 0 : bumpHeightAt(bumps, bumps.length, x, z);
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
    this.forgetSunk(visual);
    visual.dispose();
    this.chunks.delete(index);
    return true;
  }

  /** Brings the bump list and the end wall up to date with the chunks now on show. */
  private refresh(): void {
    const bumps = this.liveBumps;
    bumps.length = 0;
    let oldest = Infinity;
    for (const [index, visual] of this.chunks) {
      if (index < oldest) oldest = index;
      for (let i = 0; i < visual.bumps.length; i++) bumps.push(visual.bumps[i]);
    }
    this.placeCap(oldest);
  }

  /**
   * The simulation closes the road behind the car at the entry of its oldest chunk; this is that wall. Chunk 0
   * brings its own, built from its wall list like any other.
   */
  private placeCap(oldest: number): void {
    const visual = oldest > 0 ? this.chunks.get(oldest) : undefined;
    const cap = this.cap;
    if (!visual || !visual.hasEntry) {
      cap.visible = false;
      return;
    }
    const dx = visual.entryBX - visual.entryAX;
    const dz = visual.entryBZ - visual.entryAZ;
    cap.position.set((visual.entryAX + visual.entryBX) / 2, 0, (visual.entryAZ + visual.entryBZ) / 2);
    cap.rotation.y = -Math.atan2(dz, dx);
    cap.scale.x = Math.sqrt(dx * dx + dz * dz) + 2 * WALL_OVERLAP;
    cap.visible = true;
  }
}

const EMPTY: never[] = [];

/** True when one of the chunk's own bumps reaches its entry line, and so the end of the chunk before it. */
function touchesEntry(chunk: TrackChunk): boolean {
  if (chunk.bumps.length === 0 || chunk.left.length === 0 || chunk.right.length === 0) return false;
  const l = chunk.left[0];
  const r = chunk.right[0];
  return stepNear(chunk.bumps, chunk.bumps.length, l.x, l.z, r.x, r.z, ENTRY_PAD) > 0;
}

/** A chunk never moves once placed: its matrix is worked out here, once, instead of on every frame. */
function placeStatic(mesh: Mesh, x: number, z: number): void {
  mesh.position.set(x, 0, z);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

export function createEndlessVisual(shared: TrackShared): EndlessVisual {
  return new EndlessTrack(shared);
}
