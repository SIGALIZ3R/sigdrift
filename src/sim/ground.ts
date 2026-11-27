/**
 * Ground height on tracks with bumps (endless mode). A flat track has no bumps and its ground is 0 everywhere.
 */
import type { Bump } from '../types';
import { PI, cos } from '../core/fixedMath';

/**
 * Height of one bump at (x, z), as documented on `Bump` in types.ts: a raised-cosine ridge along the road,
 * `height` at the crest and 0 from `halfLength` away, cut off sharply `halfWidth` to either side of the centre.
 */
export function bumpHeight(b: Bump, x: number, z: number): number {
  const dx = x - b.x;
  const dz = z - b.z;
  const along = dx * b.dirX + dz * b.dirZ;
  if (!(along > -b.halfLength && along < b.halfLength)) return 0;
  // right(dir) = (-dirZ, dirX)
  const across = dz * b.dirX - dx * b.dirZ;
  if (!(across >= -b.halfWidth && across <= b.halfWidth)) return 0;
  return b.height * 0.5 * (1 + cos((PI * along) / b.halfLength));
}

/**
 * Ground height at (x, z) given every bump that could be there: the highest of those that cover the point, or 0
 * where none does.
 */
export function groundHeightOf(bumps: readonly Bump[], x: number, z: number): number {
  let height = 0;
  let found = false;
  for (let i = 0; i < bumps.length; i++) {
    const h = bumpHeight(bumps[i], x, z);
    if (h !== 0 && (!found || h > height)) {
      height = h;
      found = true;
    }
  }
  return height;
}
