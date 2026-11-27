/**
 * Fixed-timestep loop: the simulation advances in whole steps of `dt`, rendering interpolates with `alpha`.
 */

/** Turns variable frame times into a whole number of fixed steps. Pure: no DOM, no clock. */
export class Accumulator {
  private readonly dt: number;
  private readonly maxFrameSeconds: number;
  private pending = 0;

  constructor(dt: number, maxFrameSeconds = 0.1) {
    if (!(dt > 0) || !(dt < Infinity)) throw new RangeError('Accumulator: dt must be a positive finite number');
    this.dt = dt;
    this.maxFrameSeconds = maxFrameSeconds;
  }

  /**
   * Adds one frame's worth of time and returns how many steps to run now.
   * Long frames are clamped to maxFrameSeconds, so a slow machine sees the game slow down instead of
   * falling ever further behind.
   */
  advance(frameSeconds: number): number {
    this.pending += this.clampFrame(frameSeconds);
    let steps = Math.floor(this.pending / this.dt);
    this.pending -= steps * this.dt;
    // The division and the subtraction round separately; keep the leftover inside [0, dt).
    if (this.pending < 0) {
      this.pending = 0;
    } else if (this.pending >= this.dt) {
      this.pending -= this.dt;
      steps += 1;
    }
    return steps;
  }

  /** Leftover time as a fraction of a step, 0 (inclusive) to 1 (exclusive). */
  get alpha(): number {
    return this.pending / this.dt;
  }

  reset(): void {
    this.pending = 0;
  }

  private clampFrame(frameSeconds: number): number {
    if (!(frameSeconds > 0)) return 0;
    return frameSeconds > this.maxFrameSeconds ? this.maxFrameSeconds : frameSeconds;
  }
}

export interface FixedLoopOptions {
  /** Advance the simulation by exactly `dt`. */
  step: () => void;
  /** Draw a frame. `alpha` is how far (0..1) the frame sits past the latest step; `frameSeconds` is real elapsed time. */
  render: (alpha: number, frameSeconds: number) => void;
  dt: number;
}

export interface FixedLoop {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createFixedLoop(opts: FixedLoopOptions): FixedLoop {
  const accumulator = new Accumulator(opts.dt);
  let running = false;
  let frameRequest = 0;
  let lastTime = 0;

  const restartClock = (): void => {
    accumulator.reset();
    lastTime = performance.now();
  };

  const onFrame = (now: number): void => {
    // Requested before stepping so that stop() or a stop/start pair called from a callback sees the live handle.
    frameRequest = requestAnimationFrame(onFrame);
    // A frame timestamp can predate the performance.now() taken in restartClock.
    const frameSeconds = now > lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    const steps = accumulator.advance(frameSeconds);
    for (let i = 0; i < steps && running; i++) opts.step();
    if (running) opts.render(accumulator.alpha, frameSeconds);
  };

  // A hidden tab gets no frames; without this the time spent away would be simulated on return.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') restartClock();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      restartClock();
      document.addEventListener('visibilitychange', onVisibilityChange);
      frameRequest = requestAnimationFrame(onFrame);
    },
    stop(): void {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frameRequest);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    get running(): boolean {
      return running;
    },
  };
}
