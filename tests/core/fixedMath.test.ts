import { describe, expect, it } from 'vitest';
import {
  HALF_PI,
  PI,
  TAU,
  angleDiff,
  atan,
  atan2,
  clamp,
  cos,
  hypot,
  lerp,
  lerpAngle,
  moveTowards,
  sign,
  sin,
  smoothstep,
  wrapAngle,
} from '../../src/core/fixedMath';

/** Largest |ours - reference| over a sweep. One expect per sweep keeps a million samples fast. */
function maxError(from: number, to: number, stride: number, ours: (x: number) => number, ref: (x: number) => number): number {
  let worst = 0;
  for (let x = from; x <= to; x += stride) {
    const error = Math.abs(ours(x) - ref(x));
    if (!(error <= worst)) worst = error;
  }
  return worst;
}

function inWrappedRange(a: number): boolean {
  return a > -PI && a <= PI;
}

describe('constants', () => {
  it('match Math.PI exactly', () => {
    expect(PI).toBe(Math.PI);
    expect(TAU).toBe(2 * Math.PI);
    expect(HALF_PI).toBe(Math.PI / 2);
  });
});

describe('sin / cos', () => {
  it('stay within 1e-12 of Math.sin/cos near the origin', () => {
    expect(maxError(-20, 20, 0.000137, sin, Math.sin)).toBeLessThan(1e-12);
    expect(maxError(-20, 20, 0.000137, cos, Math.cos)).toBeLessThan(1e-12);
  });

  it('stay within 1e-7 of Math.sin/cos for |x| <= 1e4', () => {
    expect(maxError(-1e4, 1e4, 0.0137, sin, Math.sin)).toBeLessThan(1e-7);
    expect(maxError(-1e4, 1e4, 0.0137, cos, Math.cos)).toBeLessThan(1e-7);
  });

  it('are accurate at the quadrant boundaries', () => {
    for (let k = -64; k <= 64; k++) {
      const x = (k * PI) / 4;
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-13);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-13);
    }
  });

  it('give exact values at zero', () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
  });

  it('are exactly odd and even', () => {
    for (let x = 0.01; x < 500; x += 0.731) {
      expect(sin(-x)).toBe(-sin(x));
      expect(cos(-x)).toBe(cos(x));
    }
  });

  it('keep sin² + cos² = 1', () => {
    for (let x = -300; x < 300; x += 0.377) {
      const s = sin(x);
      const c = cos(x);
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-14);
    }
  });

  it('return finite values in [-1, 1] for huge finite input', () => {
    for (const x of [1e6, 1e9, 1e15, 1e22, 1e100, 1e300, Number.MAX_VALUE, Number.MIN_VALUE]) {
      for (const value of [sin(x), sin(-x), cos(x), cos(-x)]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('atan', () => {
  it('stays within 1e-12 of Math.atan', () => {
    expect(maxError(-50, 50, 0.000313, atan, Math.atan)).toBeLessThan(1e-12);
    expect(maxError(-1e6, 1e6, 17.3, atan, Math.atan)).toBeLessThan(1e-12);
  });

  it('handles the special cases', () => {
    expect(atan(0)).toBe(0);
    expect(Math.abs(atan(1) - PI / 4)).toBeLessThan(1e-15);
    expect(Math.abs(atan(-1) + PI / 4)).toBeLessThan(1e-15);
    expect(Math.abs(atan(1e300) - HALF_PI)).toBeLessThan(1e-15);
    expect(Math.abs(atan(-1e300) + HALF_PI)).toBeLessThan(1e-15);
    expect(atan(1e-300)).toBe(1e-300);
  });
});

describe('atan2', () => {
  it('stays within 1e-12 of Math.atan2 all the way round, at any radius', () => {
    let worst = 0;
    for (const radius of [1e-9, 0.37, 1, 250, 1e6, 1e12]) {
      for (let angle = -PI + 1e-4; angle < PI; angle += 0.00071) {
        const y = radius * Math.sin(angle);
        const x = radius * Math.cos(angle);
        const error = Math.abs(atan2(y, x) - Math.atan2(y, x));
        if (!(error <= worst)) worst = error;
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('matches Math.atan2 on a grid that includes the axes and diagonals', () => {
    let worst = 0;
    for (let y = -6; y <= 6; y += 0.25) {
      for (let x = -6; x <= 6; x += 0.25) {
        if (x === 0 && y === 0) continue;
        const error = Math.abs(atan2(y, x) - Math.atan2(y, x));
        if (!(error <= worst)) worst = error;
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('gives the axis values', () => {
    expect(atan2(0, 0)).toBe(0);
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(1, 0)).toBe(HALF_PI);
    expect(atan2(-1, 0)).toBe(-HALF_PI);
    expect(atan2(0, -1)).toBe(PI);
  });

  it('ignores the sign of a zero', () => {
    expect(atan2(-0, -1)).toBe(PI);
    expect(atan2(-0, -0)).toBe(0);
    expect(atan2(0, -0)).toBe(0);
  });

  it('stays finite when the ratio would overflow or underflow', () => {
    expect(atan2(1e300, 1e-300)).toBe(HALF_PI);
    expect(atan2(-1e300, 1e-300)).toBe(-HALF_PI);
    expect(atan2(1e-300, 1e300)).toBe(0);
    expect(atan2(1e-300, -1e300)).toBe(PI);
    expect(Math.abs(atan2(1e300, 1e300) - PI / 4)).toBeLessThan(1e-15);
  });
});

describe('wrapAngle', () => {
  it('returns angles already in (-PI, PI] untouched', () => {
    for (const a of [0, 1, -1, 3, -3, PI, 1e-300, -1e-300]) expect(wrapAngle(a)).toBe(a);
  });

  it('maps -PI to +PI', () => {
    expect(wrapAngle(-PI)).toBe(PI);
  });

  it('wraps whole turns away', () => {
    expect(wrapAngle(TAU)).toBeCloseTo(0, 12);
    expect(wrapAngle(-TAU)).toBeCloseTo(0, 12);
    expect(wrapAngle(PI + 0.5)).toBeCloseTo(-PI + 0.5, 12);
    expect(wrapAngle(-PI - 0.5)).toBeCloseTo(PI - 0.5, 12);
    expect(wrapAngle(7 * TAU + 1.25)).toBeCloseTo(1.25, 12);
    expect(wrapAngle(-7 * TAU - 1.25)).toBeCloseTo(-1.25, 12);
  });

  it('always lands in (-PI, PI] and keeps the direction', () => {
    for (let a = -400; a <= 400; a += 0.0931) {
      const wrapped = wrapAngle(a);
      expect(inWrappedRange(wrapped)).toBe(true);
      expect(Math.abs(Math.sin(wrapped) - Math.sin(a))).toBeLessThan(1e-9);
      expect(Math.abs(Math.cos(wrapped) - Math.cos(a))).toBeLessThan(1e-9);
    }
  });

  it('stays in range next to the seam', () => {
    for (let k = -9; k <= 9; k += 2) {
      for (const nudge of [-1e-9, -1e-15, 0, 1e-15, 1e-9]) {
        expect(inWrappedRange(wrapAngle(k * PI + nudge))).toBe(true);
      }
    }
  });

  it('is finite and in range for huge angles', () => {
    for (const a of [1e15, -1e15, 1e22, 1e300, -1e300, Number.MAX_VALUE]) {
      expect(inWrappedRange(wrapAngle(a))).toBe(true);
    }
  });
});

describe('angleDiff', () => {
  it('gives the shortest signed turn', () => {
    expect(angleDiff(0, 1)).toBe(1);
    expect(angleDiff(1, 0)).toBe(-1);
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2, 12);
  });

  it('goes the short way across the seam', () => {
    expect(angleDiff(3, -3)).toBeCloseTo(TAU - 6, 12);
    expect(angleDiff(-3, 3)).toBeCloseTo(6 - TAU, 12);
    expect(angleDiff(PI - 0.1, -PI + 0.1)).toBeCloseTo(0.2, 12);
  });

  it('treats a half turn as +PI', () => {
    expect(angleDiff(0, PI)).toBe(PI);
    expect(angleDiff(0, -PI)).toBe(PI);
    expect(angleDiff(HALF_PI, -HALF_PI)).toBe(PI);
  });

  it('ignores whole turns on either side', () => {
    expect(angleDiff(5 * TAU + 0.3, -3 * TAU + 0.5)).toBeCloseTo(0.2, 10);
  });
});

describe('lerpAngle', () => {
  it('interpolates along the short arc', () => {
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 12);
    // Lands on the seam, where +PI and a hair above -PI are the same direction.
    expect(Math.abs(lerpAngle(3, -3, 0.5))).toBeCloseTo(PI, 9);
    expect(Math.abs(lerpAngle(PI - 0.2, -PI + 0.2, 0.25))).toBeCloseTo(PI - 0.1, 12);
  });

  it('returns the endpoints at t = 0 and t = 1', () => {
    expect(lerpAngle(0.4, 2.1, 0)).toBe(0.4);
    expect(lerpAngle(0.4, 2.1, 1)).toBeCloseTo(2.1, 12);
  });

  it('wraps its result', () => {
    for (let t = 0; t <= 1; t += 0.05) expect(inWrappedRange(lerpAngle(9, -14, t))).toBe(true);
  });
});

describe('scalar helpers', () => {
  it('hypot', () => {
    expect(hypot(3, 4)).toBe(5);
    expect(hypot(0, 0)).toBe(0);
    expect(hypot(-5, 12)).toBe(13);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lerp', () => {
    expect(lerp(2, 6, 0)).toBe(2);
    expect(lerp(2, 6, 1)).toBe(6);
    expect(lerp(2, 6, 0.25)).toBe(3);
    expect(lerp(4, 4, 0.3)).toBe(4);
  });

  it('sign returns -1, 0 or 1', () => {
    expect(sign(3.2)).toBe(1);
    expect(sign(-0.001)).toBe(-1);
    expect(sign(0)).toBe(0);
    expect(Object.is(sign(-0), 0)).toBe(true);
  });

  it('moveTowards never overshoots', () => {
    expect(moveTowards(0, 10, 3)).toBe(3);
    expect(moveTowards(0, -10, 3)).toBe(-3);
    expect(moveTowards(9, 10, 3)).toBe(10);
    expect(moveTowards(-9, -10, 3)).toBe(-10);
    expect(moveTowards(4, 4, 0)).toBe(4);
  });

  it('smoothstep', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(2, 6, 3)).toBe(0.15625);
  });

  it('smoothstep accepts reversed and equal edges', () => {
    expect(smoothstep(1, 0, 0.25)).toBe(0.84375);
    expect(smoothstep(2, 2, 1.9)).toBe(0);
    expect(smoothstep(2, 2, 2)).toBe(1);
  });
});
