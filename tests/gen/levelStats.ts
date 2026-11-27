/** Character statistics of a generated level, shared by the generator tests. Not a test file itself. */
import { findCrossings } from '../../src/gen/validate';
import type { Level } from '../../src/types';

export interface LevelStats {
  length: number;
  crossings: number;
  /** Highest road surface, m. */
  maxHeight: number;
  /** Total climbing along the route, m. */
  climb: number;
  /** Share of the centreline at y >= 3. */
  raisedShare: number;
  /** Open edge length (both sides) over raised edge length (both sides). */
  openShare: number;
  /** Open edge length (both sides), m. */
  openLength: number;
  bumpsPerKm: number;
  pillarsPerKm: number;
  supports: number;
  /** Total turning, degrees. */
  turning: number;
  /** Narrowest half width, m. */
  narrowest: number;
  /** Mean half width over the path points, m. */
  meanHalfWidth: number;
  /** Path points in a plaza (half width >= 15 m). */
  plazaPoints: number;
}

export function levelStats(level: Level): LevelStats {
  const p = level.path;
  let open = 0;
  let raisedEdge = 0;
  let raised = 0;
  let climb = 0;
  let turning = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const run = p[i + 1].dist - p[i].dist;
    open += ((level.leftOpen[i] ? 1 : 0) + (level.rightOpen[i] ? 1 : 0)) * run;
    if (p[i].y >= 3 && p[i + 1].y >= 3) {
      raisedEdge += 2 * run;
      raised += run;
    }
    climb += Math.max(0, p[i + 1].y - p[i].y);
  }
  for (let i = 1; i + 1 < p.length; i++) {
    const ax = p[i].x - p[i - 1].x;
    const az = p[i].z - p[i - 1].z;
    const bx = p[i + 1].x - p[i].x;
    const bz = p[i + 1].z - p[i].z;
    turning += Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
  }
  const km = level.length / 1000;
  return {
    length: level.length,
    crossings: findCrossings(level).count,
    maxHeight: Math.max(...p.map((q) => q.y)),
    climb,
    raisedShare: raised / level.length,
    openShare: raisedEdge > 0 ? open / raisedEdge : 0,
    openLength: open,
    bumpsPerKm: level.bumps.length / km,
    pillarsPerKm: level.props.length / km,
    supports: level.supports.length,
    turning: (turning * 180) / Math.PI,
    narrowest: Math.min(...p.map((q) => q.halfWidth)),
    meanHalfWidth: p.reduce((sum, q) => sum + q.halfWidth, 0) / p.length,
    plazaPoints: p.filter((q) => q.halfWidth >= 15).length,
  };
}
