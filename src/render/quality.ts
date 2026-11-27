/**
 * How many pixels the renderer draws. Pure arithmetic, no three.js: the renderer asks, this answers.
 *
 * Two limits sit on top of the device pixel ratio:
 * - a pixel budget, so a 4K or ultrawide window does not make the drawing buffer several times larger than the
 *   GPU cost the look was tuned for;
 * - a frame-time watchdog, which trades resolution for frame rate on a GPU that still cannot keep up.
 */

/** About 2560 x 1440. Past this the picture gains little and every full-screen pass keeps getting dearer. */
export const MAX_PIXELS = 2560 * 1440;

/** Drawing-buffer pixels per CSS pixel: `wanted`, unless the window is so large that the budget says less. */
export function budgetPixelRatio(width: number, height: number, wanted: number, maxPixels = MAX_PIXELS): number {
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.min(wanted, Math.sqrt(maxPixels / area));
}

/** Frames per measurement. Long enough to ride out a hitch, short enough to react within a couple of seconds. */
const WINDOW_FRAMES = 90;
/** Frames ignored after any change of resolution: reallocating buffers makes the next few frames slow. */
const SETTLE_FRAMES = 20;
/** A frame this long is a stall (tab switch, shader compile), not a measure of the GPU. */
const STALL_SECONDS = 0.09;
/** Average frame time that counts as too slow: under about 50 frames a second. */
const SLOW_SECONDS = 1 / 50;
/** Each step keeps this share of the resolution, and so about two thirds of the pixels. */
const STEP = 0.8;
/** Three steps end at about half resolution in each direction, a quarter of the pixels. */
const MAX_STEPS = 3;
/** A step down has to buy at least this much frame time, or resolution was never the problem. */
const WORTHWHILE = 0.92;

/**
 * Lowers a resolution scale (1 down to about 0.5) while frames stay slow.
 *
 * It never raises the scale again, so it cannot oscillate. And it checks its own work: if a step down did not
 * make frames noticeably faster, the slowness is not about pixels (a 30 Hz display, a throttled tab, a busy CPU),
 * so the step is undone and the watchdog stops for good.
 */
export class ResolutionWatchdog {
  /** Multiply the pixel ratio by this. */
  scale = 1;
  private steps = 0;
  private frames = 0;
  private seconds = 0;
  private settle = SETTLE_FRAMES;
  private stopped = false;
  /** Scale and average frame time before the step that is being judged, or null when none is. */
  private trial: { steps: number; seconds: number } | null = null;

  /** Back to full resolution, e.g. after the quality setting or the window size changed. */
  reset(): void {
    this.setSteps(0);
    this.stopped = false;
    this.trial = null;
    this.restartWindow();
  }

  /**
   * Feed it the real time of every rendered frame (0 while paused). Returns true when `scale` has just changed
   * and the drawing buffer needs resizing.
   */
  frame(dt: number): boolean {
    if (this.stopped || !(dt > 0) || dt >= STALL_SECONDS) return false;
    if (this.settle > 0) {
      this.settle--;
      return false;
    }
    this.frames++;
    this.seconds += dt;
    if (this.frames < WINDOW_FRAMES) return false;
    const average = this.seconds / this.frames;
    this.restartWindow();

    const trial = this.trial;
    this.trial = null;
    if (trial !== null && average > trial.seconds * WORTHWHILE) {
      this.setSteps(trial.steps);
      this.stopped = true;
      return true;
    }
    if (average <= SLOW_SECONDS || this.steps >= MAX_STEPS) return false;
    this.trial = { steps: this.steps, seconds: average };
    this.setSteps(this.steps + 1);
    return true;
  }

  private setSteps(steps: number): void {
    this.steps = steps;
    this.scale = Math.pow(STEP, steps);
  }

  private restartWindow(): void {
    this.frames = 0;
    this.seconds = 0;
    this.settle = SETTLE_FRAMES;
  }
}
