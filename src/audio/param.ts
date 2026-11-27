/**
 * Glides an AudioParam towards a target with setTargetAtTime, which is click-free from any starting value.
 * Remembers the last target so that a parameter that is not changing costs no automation events.
 */
export interface Glide {
  /** Head for `value`, covering about 63 % of the remaining distance every `timeConstant` seconds. */
  to(value: number, now: number, timeConstant: number): void;
}

export function createGlide(param: AudioParam): Glide {
  let last = Number.NaN;
  return {
    to(value, now, timeConstant) {
      if (!Number.isFinite(value)) return;
      const delta = value - last;
      // NaN on the first call, so that one always goes through.
      if (Math.abs(delta) <= 1e-3 * Math.abs(value) + 1e-6) return;
      last = value;
      param.setTargetAtTime(value, now, timeConstant);
    },
  };
}
