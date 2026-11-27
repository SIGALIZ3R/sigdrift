/**
 * The rules of endless mode, on roads built by hand: countdown, distance, crashes, leaving the road, the window of
 * live chunks, restart and death. The generated road and the bot are in endlessBot.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type {
  CollisionEvent,
  Difficulty,
  EndlessGenerator,
  EndlessMode,
  InputState,
  Pose,
  TrackChunk,
} from '../../src/types';
import { DT, SIM_HZ } from '../../src/types';
import { hashNumbers } from '../../src/core/hash';
import { MULTIPLIER_RATE, POINTS_RATE, RECOVER_TICKS, createScoreState } from '../../src/modes/driftScore';
import {
  CHUNKS_AHEAD,
  CHUNKS_BEHIND,
  CRASH_AFTERMATH_TICKS,
  CRASH_COOLDOWN_TICKS,
  CRASH_IMPACT,
  CRASH_REARM_DISTANCE,
  CRASH_REARM_SPEED,
  ENDLESS_COUNTDOWN_TICKS,
  ENDLESS_MAX_CRASHES,
  createEndlessMode,
  createEndlessModeFrom,
} from '../../src/modes/endless';
import { DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { makeBump, makeStraightChunk } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const FLOORED: InputState = { ...IDLE, throttle: 1 };
const ORIGIN: Pose = { x: 0, z: 0, heading: 0 };
const CHUNK_LENGTH = 100;
const HALF_WIDTH = 8;
const RADIUS = DEFAULT_CAR_PARAMS.collisionRadius;
/** Where the one bump of the bumpy road sits, on chunk 0. */
const BUMP_X = 60;

interface HandRoad {
  make: () => EndlessGenerator;
  /** Chunks handed out by the generator in use (it is replaced on restart). */
  served: () => number;
}

/**
 * An endless straight road along +x in 100 m chunks, 8 m to either wall. Chunk n reports an intensity of n / 100 so
 * that tests can tell which chunk the mode is reading.
 */
function handRoad(options: { bump?: boolean; start?: Pose; difficulty?: Difficulty } = {}): HandRoad {
  let served = 0;
  const make = (): EndlessGenerator => {
    let index = 0;
    served = 0;
    return {
      seed: 'hand',
      difficulty: options.difficulty ?? 'medium',
      start: options.start ?? ORIGIN,
      next(): TrackChunk {
        const bumps = options.bump && index === 0 ? [makeBump(BUMP_X, 0, 0, HALF_WIDTH)] : [];
        const chunk = makeStraightChunk(index, index * CHUNK_LENGTH, CHUNK_LENGTH, HALF_WIDTH, bumps);
        chunk.intensity = index / 100;
        index++;
        served++;
        return chunk;
      },
    };
  };
  return { make, served: () => served };
}

function steps(mode: EndlessMode, count: number, input: InputState = IDLE): void {
  for (let i = 0; i < count; i++) mode.step(input);
}

/** A mode on the hand-built road, past its countdown. */
function started(options: Parameters<typeof handRoad>[0] = {}): EndlessMode {
  const mode = createEndlessModeFrom(handRoad(options).make);
  steps(mode, ENDLESS_COUNTDOWN_TICKS);
  expect(mode.state.phase).toBe('running');
  return mode;
}

/** Puts the car somewhere already moving, as a crash test needs it. */
function shove(mode: EndlessMode, x: number, z: number, heading: number, vx: number, vz: number): void {
  mode.world.placeCar({ x, z, heading });
  mode.world.car.vx = vx;
  mode.world.car.vz = vz;
}

/** Sends the car off from a pose already moving at `speed` along its nose. */
function launch(mode: EndlessMode, x: number, z: number, heading: number, speed: number): void {
  shove(mode, x, z, heading, speed * Math.cos(heading), speed * Math.sin(heading));
}

/** Throws the car sideways at the right-hand wall and steps until it has hit it. Returns the hardest impact. */
function hitWall(mode: EndlessMode, sideSpeed: number, forwardSpeed = 0): number {
  shove(mode, mode.world.car.x + 5, HALF_WIDTH - RADIUS - 0.3, 0, forwardSpeed, sideSpeed);
  let hardest = 0;
  for (let i = 0; i < SIM_HZ / 4 && mode.state.phase === 'running'; i++) {
    mode.step(IDLE);
    const hit = mode.world.lastCollision;
    if (hit !== null && hit.impact > hardest) hardest = hit.impact;
  }
  return hardest;
}

/** Everything a tick can change: the world's dynamic state and the rules' state. */
function fullState(mode: EndlessMode): number[] {
  const s = mode.state;
  return [
    ...mode.world.snapshot(),
    mode.world.chunkIndex,
    mode.world.chunks.length,
    mode.world.chunks[0].index,
    ['countdown', 'running', 'dead'].indexOf(s.phase),
    s.countdownTicks,
    s.ticks,
    s.distance,
    s.crashes,
    s.lastCrashTick,
    s.deathCause === null ? 0 : s.deathCause === 'offTrack' ? 1 : 2,
    s.intensity,
    s.lastTakeoffTick,
    s.lastLandingTick,
    s.score.points,
    s.score.multiplier,
    s.score.peakMultiplier,
    s.score.drifting ? 1 : 0,
    s.score.proximity,
    s.score.combo,
    s.score.lastMultiplierLossTick,
    s.score.lastCloseTick,
  ];
}

/**
 * Takes the physics out: from now on a world step only counts the tick and reports `script.hit`, and the test
 * writes the car fields the rules read. That pins the rules to exact numbers, which real driving never gives.
 */
function stubPhysics(mode: EndlessMode): { hit: CollisionEvent | null } {
  const script: { hit: CollisionEvent | null } = { hit: null };
  const world = mode.world;
  world.step = (): void => {
    world.tick++;
    world.lastCollision = script.hit;
  };
  return script;
}

function hit(impact: number): CollisionEvent {
  return { x: 0, z: 0, nx: 0, nz: -1, impact };
}

function slide(mode: EndlessMode, speed: number, angle: number): void {
  const car = mode.world.car;
  car.speed = speed;
  car.forwardSpeed = speed * Math.cos(angle);
  car.driftAngle = angle;
}

describe('the rules in numbers', () => {
  it('are three crashes, 4 m/s to count as one, a second between two, three chunks ahead and two behind', () => {
    expect(ENDLESS_MAX_CRASHES).toBe(3);
    expect(CRASH_IMPACT).toBe(4);
    expect(CRASH_COOLDOWN_TICKS).toBe(SIM_HZ);
    // The same accident for up to five seconds, while the car is under 12 m/s and within 20 m of where it crashed.
    expect(CRASH_AFTERMATH_TICKS).toBe(5 * SIM_HZ);
    expect(CRASH_REARM_SPEED).toBe(12);
    expect(CRASH_REARM_DISTANCE).toBe(20);
    expect(CHUNKS_AHEAD).toBe(3);
    expect(CHUNKS_BEHIND).toBe(2);
    expect(ENDLESS_COUNTDOWN_TICKS).toBe(3 * SIM_HZ);
  });
});

describe('start of an endless run', () => {
  it('begins in the countdown with a clean slate and the first four chunks laid', () => {
    const road = handRoad({ difficulty: 'hard' });
    const mode = createEndlessModeFrom(road.make);
    expect(mode.state).toEqual({
      phase: 'countdown',
      countdownTicks: 3 * SIM_HZ,
      ticks: 0,
      difficulty: 'hard',
      distance: 0,
      crashes: 0,
      maxCrashes: 3,
      lastCrashTick: -1,
      deathCause: null,
      intensity: 0,
      lastTakeoffTick: -1,
      lastLandingTick: -1,
      score: createScoreState(),
    });
    expect(mode.world.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(road.served()).toBe(1 + CHUNKS_AHEAD);
    expect(mode.world.tick).toBe(0);
    expect(mode.world.chunkIndex).toBe(0);
    expect(mode.world.car).toMatchObject({ x: 0, z: 0, heading: 0, speed: 0, airborne: false });
  });

  it('takes the difficulty and the car from createEndlessMode, and builds the same road for the same seed', () => {
    const params = cloneParams(DEFAULT_CAR_PARAMS);
    const a = createEndlessMode('same-seed', 'easy', params);
    const b = createEndlessMode('same-seed', 'easy');
    const other = createEndlessMode('other-seed', 'easy');
    expect(a.state.difficulty).toBe('easy');
    expect(a.world.params).toBe(params);
    expect(b.world.params).not.toBe(params);
    expect(a.world.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(a.world.chunks.map((c) => c.endDist)).toEqual(b.world.chunks.map((c) => c.endDist));
    expect(a.world.chunks[3].path).toEqual(b.world.chunks[3].path);
    expect(other.world.chunks[3].path).not.toEqual(a.world.chunks[3].path);
    expect(a.state.intensity).toBe(a.world.chunks[0].intensity);
    expect(createEndlessMode('same-seed', 'hard').state.intensity).toBeGreaterThan(a.state.intensity);
  });

  it('holds the car on the start line for three seconds, whatever the driver does', () => {
    const mode = createEndlessModeFrom(handRoad().make);
    const thrash: InputState = { steer: 1, throttle: 1, brake: 0, handbrake: true, reset: true };
    for (let i = 1; i < ENDLESS_COUNTDOWN_TICKS; i++) {
      mode.step(thrash);
      expect(mode.state.phase).toBe('countdown');
      expect(mode.state.countdownTicks).toBe(ENDLESS_COUNTDOWN_TICKS - i);
    }
    expect(mode.world.tick).toBe(0);
    expect(mode.world.car).toMatchObject({ x: 0, z: 0, heading: 0, speed: 0, steerAngle: 0 });
    expect(mode.state.ticks).toBe(0);
    expect(mode.state.distance).toBe(0);
  });

  it('turns into the run when the countdown reaches zero, and the clock starts on the next tick', () => {
    const mode = createEndlessModeFrom(handRoad().make);
    steps(mode, ENDLESS_COUNTDOWN_TICKS, FLOORED);
    expect(mode.state.phase).toBe('running');
    expect(mode.state.countdownTicks).toBe(0);
    expect(mode.state.ticks).toBe(0);
    expect(mode.world.tick).toBe(0);
    mode.step(FLOORED);
    expect(mode.state.ticks).toBe(1);
    expect(mode.world.tick).toBe(1);
    expect(mode.world.car.speed).toBeGreaterThan(0);
  });
});

describe('distance', () => {
  it('is how far along the road the car has got', () => {
    const mode = started();
    let previous = 0;
    for (let i = 0; i < 6 * SIM_HZ; i++) {
      mode.step(FLOORED);
      expect(mode.state.distance).toBeGreaterThanOrEqual(previous);
      previous = mode.state.distance;
    }
    // The hand-built road runs along +x and counts its distance in x.
    expect(mode.state.distance).toBeGreaterThan(100);
    expect(mode.state.distance).toBeCloseTo(mode.world.car.x, 6);
    expect(mode.state.distance).toBe(mode.world.trackDist);
  });

  it('is counted from the start line, wherever on the road that is', () => {
    const mode = started({ start: { x: 30, z: 2, heading: 0 } });
    expect(mode.world.trackDist).toBeCloseTo(30, 9);
    expect(mode.state.distance).toBe(0);
    steps(mode, 3 * SIM_HZ, FLOORED);
    expect(mode.state.distance).toBeGreaterThan(20);
    expect(mode.state.distance).toBeCloseTo(mode.world.car.x - 30, 6);
  });

  it('keeps the furthest point reached when the car backs up', () => {
    const mode = started();
    steps(mode, 3 * SIM_HZ, FLOORED);
    steps(mode, 3 * SIM_HZ, { ...IDLE, brake: 1 });
    const furthest = mode.state.distance;
    expect(furthest).toBeGreaterThan(20);
    // The brake pedal has selected reverse by now.
    steps(mode, 3 * SIM_HZ, { ...IDLE, brake: 1 });
    expect(mode.world.car.forwardSpeed).toBeLessThan(-2);
    expect(mode.world.trackDist).toBeLessThan(furthest - 5);
    expect(mode.state.distance).toBe(furthest);
  });

  it('is never negative: backing off the start line into the run-off scores nothing', () => {
    const mode = started({ start: { x: 30, z: 0, heading: 0 } });
    for (let i = 0; i < 4 * SIM_HZ; i++) {
      mode.step({ ...IDLE, brake: 1 });
      expect(mode.state.distance).toBe(0);
    }
    expect(mode.world.car.x).toBeLessThan(20);
    expect(mode.world.trackDist).toBeLessThan(20);
    expect(mode.state.phase).toBe('running');
  });

  it('ignores the reset button: there is no checkpoint to go back to', () => {
    const mode = started();
    const twin = started();
    for (let i = 0; i < 2 * SIM_HZ; i++) {
      mode.step({ ...FLOORED, reset: i % 7 === 0 });
      twin.step(FLOORED);
    }
    expect(fullState(mode)).toEqual(fullState(twin));
    expect(mode.world.car.x).toBeGreaterThan(10);
  });
});

describe('crashes', () => {
  it('counts a hard hit on a wall, once', () => {
    const mode = started();
    const hardest = hitWall(mode, 8);
    expect(hardest).toBeGreaterThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.lastCrashTick).toBeGreaterThan(0);
    expect(mode.state.lastCrashTick).toBeLessThanOrEqual(mode.state.ticks);
    expect(mode.state.phase).toBe('running');
    expect(mode.state.deathCause).toBeNull();
    // The wreck bouncing off and settling is still the same accident.
    steps(mode, 3 * SIM_HZ);
    expect(mode.state.crashes).toBe(1);
  });

  it('lets the car scrape along a wall without losing a life', () => {
    const mode = started();
    shove(mode, 20, HALF_WIDTH - RADIUS - 0.3, 0.1, 25, 2.5);
    let contacts = 0;
    let hardest = 0;
    for (let i = 0; i < 2 * SIM_HZ; i++) {
      // Leaning on the wall all the way, steering into it.
      mode.step({ ...IDLE, throttle: 0.5, steer: 0.3 });
      const scrape = mode.world.lastCollision;
      if (scrape !== null) {
        contacts++;
        hardest = Math.max(hardest, scrape.impact);
      }
    }
    expect(contacts).toBeGreaterThan(10);
    expect(hardest).toBeGreaterThan(0.5);
    expect(hardest).toBeLessThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(0);
    expect(mode.state.lastCrashTick).toBe(-1);
    expect(mode.state.phase).toBe('running');
    expect(mode.state.distance).toBeGreaterThan(30);
  });

  it('draws the line at exactly 4 m/s of closing speed', () => {
    const mode = started();
    const script = stubPhysics(mode);
    script.hit = hit(CRASH_IMPACT - 0.001);
    steps(mode, 5);
    expect(mode.state.crashes).toBe(0);
    script.hit = hit(CRASH_IMPACT);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.lastCrashTick).toBe(6);
  });

  it('counts no second crash within a second of the last counted one, and counts a car at speed again after that', () => {
    const mode = started();
    const script = stubPhysics(mode);
    // A car that keeps its speed through the crash: a glancing blow, and it is still travelling.
    mode.world.car.speed = 30;
    steps(mode, 10);
    script.hit = hit(9);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.lastCrashTick).toBe(11);
    // Hit after hit, every tick: nothing more for one second.
    steps(mode, CRASH_COOLDOWN_TICKS - 1);
    expect(mode.state.ticks).toBe(11 + CRASH_COOLDOWN_TICKS - 1);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.lastCrashTick).toBe(11);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(2);
    expect(mode.state.lastCrashTick).toBe(11 + CRASH_COOLDOWN_TICKS);
    // The second starts again from the crash that counted, not from the hits in between.
    script.hit = null;
    steps(mode, CRASH_COOLDOWN_TICKS - 1);
    script.hit = hit(9);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(3);
  });

  it('keeps hits by a slow car near where it crashed as part of the same accident, for up to five seconds', () => {
    const mode = started();
    const script = stubPhysics(mode);
    const world = mode.world as { trackDist: number } & EndlessMode['world'];
    const car = world.car;
    car.speed = 30;
    world.trackDist = 100;
    script.hit = hit(9);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(1);
    // The wreck is all but stopped. Past the first second, hard knocks at under 12 m/s still cost nothing...
    car.speed = CRASH_REARM_SPEED - 0.01;
    world.trackDist = 100 + CRASH_REARM_DISTANCE - 0.01;
    steps(mode, CRASH_AFTERMATH_TICKS - 2);
    expect(mode.state.ticks).toBe(CRASH_AFTERMATH_TICKS - 1);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.lastCrashTick).toBe(1);
    // ...whichever way along the road it has drifted...
    world.trackDist = 100 - CRASH_REARM_DISTANCE + 0.01;
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(1);
    // ...until five seconds after the crash, when the accident is over whatever the car is doing.
    mode.step(IDLE);
    expect(mode.state.ticks).toBe(1 + CRASH_AFTERMATH_TICKS);
    expect(mode.state.crashes).toBe(2);
    expect(mode.state.lastCrashTick).toBe(1 + CRASH_AFTERMATH_TICKS);
  });

  it('counts a slow hit again once the car has left the scene, and any hit by a car that has got going again', () => {
    for (const reason of ['speed', 'forwards', 'backwards'] as const) {
      const mode = started();
      const script = stubPhysics(mode);
      const world = mode.world as { trackDist: number } & EndlessMode['world'];
      const car = world.car;
      car.speed = 30;
      world.trackDist = 100;
      script.hit = hit(9);
      mode.step(IDLE);
      car.speed = 3;
      steps(mode, CRASH_COOLDOWN_TICKS + 10);
      expect(mode.state.crashes).toBe(1);
      if (reason === 'speed') car.speed = CRASH_REARM_SPEED;
      else world.trackDist = 100 + (reason === 'forwards' ? CRASH_REARM_DISTANCE : -CRASH_REARM_DISTANCE);
      mode.step(IDLE);
      expect(mode.state.crashes, reason).toBe(2);
      expect(mode.state.lastCrashTick, reason).toBe(mode.state.ticks);
    }
  });

  it('charges one life for driving head-on into a pillar and keeping the accelerator down', () => {
    // The car bounces back about 3 m and the throttle drives it into the same pillar again, a second and a half
    // later at 7 m/s. That used to be a second crash.
    for (const pillarX of [130, 160, 190]) {
      const mode = createEndlessModeFrom(() => {
        const generator = handRoad().make();
        return {
          ...generator,
          next(): TrackChunk {
            const chunk = generator.next();
            if (chunk.index === 1) chunk.props.push({ kind: 'pillar', x: pillarX, z: 0, y: 0, radius: 1.5, height: 5, hue: 0 });
            return chunk;
          },
        };
      });
      let hardHits = 0;
      let wasHit = false;
      for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS + 14 * SIM_HZ; i++) {
        mode.step(FLOORED);
        const hard = mode.world.lastCollision !== null && mode.world.lastCollision.impact >= CRASH_IMPACT;
        if (hard && !wasHit && mode.state.phase === 'running') hardHits++;
        wasHit = hard;
      }
      // It really did come back for more, and it is still nose to the pillar.
      expect(hardHits, `pillar at ${pillarX}`).toBeGreaterThanOrEqual(2);
      expect(mode.world.car.x).toBeLessThan(pillarX);
      expect(mode.state.crashes, `pillar at ${pillarX}`).toBe(1);
      expect(mode.state.phase).toBe('running');
    }
  });

  it.each([25, 32, 40])('charges one life for a head-on hit on a wall at %d m/s, with the accelerator kept down or let go', (speed) => {
    for (const input of [FLOORED, IDLE]) {
      const mode = started();
      launch(mode, 50, 0, Math.PI / 2, speed);
      let hardHits = 0;
      for (let i = 0; i < 8 * SIM_HZ; i++) {
        mode.step(input);
        if (mode.world.lastCollision !== null && mode.world.lastCollision.impact >= CRASH_IMPACT) hardHits++;
      }
      expect(mode.state.crashes).toBe(1);
      // With the pedal down it came back at the wall hard enough to have counted; let go, it rolled back
      // across the road into the other wall (from 32 m/s up).
      if (input === FLOORED || speed >= 32) expect(hardHits).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not charge a second life for driving off into the wall the wreck is facing', () => {
    const mode = started();
    expect(hitWall(mode, 8, 15)).toBeGreaterThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(1);
    const crashedAt = mode.world.trackDist;
    for (let i = 0; i < 2 * SIM_HZ; i++) mode.step({ ...IDLE, brake: mode.world.car.forwardSpeed > 1 ? 1 : 0 });
    expect(mode.world.car.speed).toBe(0);
    expect(Math.abs(mode.world.trackDist - crashedAt)).toBeLessThan(CRASH_REARM_DISTANCE);
    // At rest, nose 1.5 m from the wall, and the driver picks the accelerator instead of reverse.
    const x = mode.world.car.x;
    mode.world.placeCar({ x, z: HALF_WIDTH - RADIUS - (DEFAULT_CAR_PARAMS.halfLength - RADIUS) - 1.5, heading: Math.PI / 2 });
    let hardest = 0;
    for (let i = 0; i < SIM_HZ; i++) {
      mode.step(FLOORED);
      if (mode.world.lastCollision !== null) hardest = Math.max(hardest, mode.world.lastCollision.impact);
    }
    expect(hardest).toBeGreaterThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(1);
  });

  it('charges a second life for a second accident: the car got going again and hit something else', () => {
    const mode = started();
    expect(hitWall(mode, 8, 15)).toBeGreaterThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(1);
    steps(mode, CRASH_COOLDOWN_TICKS);
    expect(hitWall(mode, 8, 15)).toBeGreaterThan(CRASH_IMPACT);
    expect(mode.state.crashes).toBe(2);
  });

  it('ends the run on the third crash, with the cause "crashes"', () => {
    const mode = started();
    for (let crash = 1; crash <= ENDLESS_MAX_CRASHES; crash++) {
      expect(mode.state.phase).toBe('running');
      // Each time the car is travelling again when it is thrown at the wall: three accidents, not one.
      expect(hitWall(mode, 8, 15)).toBeGreaterThan(CRASH_IMPACT);
      expect(mode.state.crashes).toBe(crash);
      if (crash < ENDLESS_MAX_CRASHES) steps(mode, CRASH_COOLDOWN_TICKS);
    }
    expect(mode.state.phase).toBe('dead');
    expect(mode.state.deathCause).toBe('crashes');
    expect(mode.state.crashes).toBe(mode.state.maxCrashes);
    expect(mode.state.lastCrashTick).toBe(mode.state.ticks);
  });

  it('is what happens to a driver who floors it and saws at the wheel', () => {
    const mode = started();
    for (let i = 0; i < 60 * SIM_HZ && mode.state.phase === 'running'; i++) {
      // Full lock one way, then the other, every half second. (Sawing once a second, the loose car swings its nose
      // into the wall and sits there with its wheels spinning.)
      mode.step({ ...FLOORED, steer: Math.floor((2 * i) / SIM_HZ) % 2 === 0 ? 1 : -1 });
    }
    expect(mode.state.phase).toBe('dead');
    expect(mode.state.deathCause).toBe('crashes');
    expect(mode.state.crashes).toBe(3);
    expect(mode.state.ticks).toBeLessThan(20 * SIM_HZ);
  });
});

describe('leaving the road', () => {
  it('ends the run the moment a jump taken diagonally comes down beyond the wall', () => {
    const mode = started({ bump: true });
    launch(mode, 40, -6, 0.45, 38);
    let flew = 0;
    for (let i = 0; i < 3 * SIM_HZ && mode.state.phase === 'running'; i++) {
      mode.step(FLOORED);
      if (mode.world.car.airborne) {
        flew++;
        expect(mode.state.phase).toBe('running');
      }
    }
    expect(flew).toBeGreaterThan(60);
    expect(mode.state.phase).toBe('dead');
    expect(mode.state.deathCause).toBe('offTrack');
    expect(mode.world.offTrack).toBe(true);
    expect(mode.world.car.airborne).toBe(false);
    expect(Math.abs(mode.world.car.z)).toBeGreaterThan(HALF_WIDTH + RADIUS);
    expect(mode.state.crashes).toBe(0);
    expect(mode.state.lastTakeoffTick).toBeGreaterThan(0);
    // Dead on the tick it landed.
    expect(mode.state.lastLandingTick).toBe(mode.state.ticks);
    expect(mode.state.lastLandingTick - mode.state.lastTakeoffTick).toBe(flew);
  });

  it('lets the car slide to a stop on the city floor where it came down, on its own brakes', () => {
    const mode = started({ bump: true });
    launch(mode, 40, -6, 0.45, 38);
    for (let i = 0; i < 3 * SIM_HZ && mode.state.phase === 'running'; i++) mode.step(IDLE);
    expect(mode.state.deathCause).toBe('offTrack');
    const frozen = { ...mode.state, score: { ...mode.state.score } };
    const { x, z, y } = mode.world.car;
    for (let i = 0; i < 4 * SIM_HZ; i++) {
      mode.step({ ...FLOORED, steer: 1 });
      expect(mode.world.car.throttle).toBe(0);
    }
    expect(mode.state).toEqual(frozen);
    expect(mode.world.car.speed).toBe(0);
    expect(mode.world.car.y).toBe(y);
    expect(Math.hypot(mode.world.car.x - x, mode.world.car.z - z)).toBeGreaterThan(1);
    expect(mode.world.offTrack).toBe(true);
  });

  it('does not end the run when a straight jump comes down on the road', () => {
    const mode = started({ bump: true });
    launch(mode, 30, 0, 0, 36);
    let flew = 0;
    for (let i = 0; i < 3 * SIM_HZ; i++) {
      mode.step(IDLE);
      if (mode.world.car.airborne) flew++;
    }
    expect(flew).toBeGreaterThan(80);
    expect(mode.state.phase).toBe('running');
    expect(mode.state.deathCause).toBeNull();
    expect(mode.state.crashes).toBe(0);
    expect(mode.world.offTrack).toBe(false);
    expect(mode.state.lastTakeoffTick).toBeGreaterThan(0);
    expect(mode.state.lastLandingTick).toBe(mode.state.lastTakeoffTick + flew);
    expect(mode.state.distance).toBeGreaterThan(BUMP_X + 20);
  });

  it('reports no take-off and no landing for a car that crosses the bump slowly', () => {
    const mode = started({ bump: true });
    launch(mode, 30, 0, 0, 10);
    for (let i = 0; i < 6 * SIM_HZ; i++) mode.step({ ...IDLE, throttle: 0.1 });
    expect(mode.world.car.x).toBeGreaterThan(BUMP_X + 10);
    expect(mode.state.lastTakeoffTick).toBe(-1);
    expect(mode.state.lastLandingTick).toBe(-1);
  });
});

describe('the window of live chunks', () => {
  it('always holds the two chunks behind the car, its own and three ahead, and the road never runs out', () => {
    const road = handRoad();
    const mode = createEndlessModeFrom(road.make);
    const { world, state } = mode;
    steps(mode, ENDLESS_COUNTDOWN_TICKS);
    let seenChunk = 0;
    for (let i = 0; i < 90 * SIM_HZ && state.distance < 2500; i++) {
      mode.step(FLOORED);
      const at = world.chunkIndex;
      expect(at).toBe(Math.floor(world.car.x / CHUNK_LENGTH));
      const first = Math.max(0, at - CHUNKS_BEHIND);
      if (world.chunks[0].index !== first || world.chunks.length !== at + CHUNKS_AHEAD - first + 1 || at !== seenChunk) {
        // Spelled out only when something moved, to keep the loop cheap.
        expect(world.chunks.map((c) => c.index)).toEqual(
          Array.from({ length: at + CHUNKS_AHEAD - first + 1 }, (_, n) => first + n),
        );
        seenChunk = at;
      }
      // Generated exactly as far as needed: never behind, never further ahead.
      expect(road.served()).toBe(at + CHUNKS_AHEAD + 1);
      expect(world.chunks[world.chunks.length - 1].endDist - world.trackDist).toBeGreaterThan(CHUNKS_AHEAD * CHUNK_LENGTH);
      expect(state.intensity).toBe(at / 100);
      expect(world.offTrack).toBe(false);
      expect(world.lastCollision).toBeNull();
    }
    expect(state.distance).toBeGreaterThanOrEqual(2500);
    expect(seenChunk).toBe(25);
    expect(world.chunks).toHaveLength(1 + CHUNKS_BEHIND + CHUNKS_AHEAD);
    expect(state.phase).toBe('running');
  });

  it('shuts the road behind the window: a car that backs up meets a wall, not the void', () => {
    const mode = started();
    launch(mode, 20, 0, 0, 40);
    steps(mode, 12 * SIM_HZ, FLOORED);
    const oldest = mode.world.chunks[0];
    expect(oldest.index).toBeGreaterThan(0);
    const reached = mode.state.distance;
    // Thrown backwards down the road, hard.
    shove(mode, mode.world.car.x, 0, 0, -40, 0);
    let stopped = false;
    for (let i = 0; i < 20 * SIM_HZ && mode.state.phase === 'running'; i++) {
      mode.step(IDLE);
      if (mode.world.lastCollision !== null) stopped = true;
      expect(mode.world.car.x).toBeGreaterThan(oldest.path[0].x);
      expect(mode.world.offTrack).toBe(false);
    }
    expect(stopped).toBe(true);
    expect(mode.state.distance).toBe(reached);
  });
});

describe('drift scoring on the endless road', () => {
  /** Points of the first tick of a 20 m/s, 0.5 rad slide in the open (multiplier 1 + one tick of climb). */
  const FIRST_TICK = 20 * 0.5 * POINTS_RATE * DT * (1 + MULTIPLIER_RATE * DT);

  it('follows the shared rules (driftScore.ts), with the world wall distance for the proximity', () => {
    const mode = started();
    // In the middle of the road, well clear of the walls.
    mode.world.placeCar({ x: 50, z: 0, heading: 0 });
    expect(mode.world.wallDistance).toBeGreaterThan(4);
    stubPhysics(mode);
    slide(mode, 20, 0.5);
    mode.step(IDLE);
    expect(mode.state.score.drifting).toBe(true);
    expect(mode.state.score.points).toBeCloseTo(FIRST_TICK, 12);
    steps(mode, 4 * SIM_HZ - 1);
    expect(mode.state.score.multiplier).toBeCloseTo(1 + 4 * MULTIPLIER_RATE, 9);
    expect(mode.state.score.proximity).toBe(0);
    // Brushing a wall.
    (mode.world as { wallDistance: number }).wallDistance = 0.2;
    mode.step(IDLE);
    expect(mode.state.score.proximity).toBe(1);
  });

  it('scores nothing in the air, and the multiplier waits for the landing', () => {
    const mode = started();
    stubPhysics(mode);
    slide(mode, 20, 0.5);
    steps(mode, 50);
    const { points, multiplier } = mode.state.score;
    mode.world.car.airborne = true;
    steps(mode, 3 * SIM_HZ);
    expect(mode.state.score.drifting).toBe(false);
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.multiplier).toBe(multiplier);
    expect(mode.state.lastTakeoffTick).toBe(51);
    mode.world.car.airborne = false;
    steps(mode, 50);
    expect(mode.state.lastLandingTick).toBe(51 + 3 * SIM_HZ);
    expect(mode.state.score.drifting).toBe(true);
    expect(mode.state.score.points).toBeGreaterThan(points);
  });

  it('loses the multiplier, not the points, on a crash and on a spin', () => {
    const mode = started();
    const script = stubPhysics(mode);
    slide(mode, 20, 0.5);
    steps(mode, 2 * SIM_HZ);
    const points = mode.state.score.points;
    script.hit = hit(CRASH_IMPACT);
    mode.step(IDLE);
    expect(mode.state.crashes).toBe(1);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.combo).toBe(0);
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.lastMultiplierLossTick).toBe(2 * SIM_HZ + 1);

    script.hit = null;
    // The wreck still sliding at an angle scores nothing until the car has straightened up after the lockout.
    steps(mode, 50);
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.multiplier).toBe(1);
    slide(mode, 20, 0);
    steps(mode, RECOVER_TICKS);
    slide(mode, 20, 0.5);
    steps(mode, 50);
    expect(mode.state.score.multiplier).toBeGreaterThan(1);
    slide(mode, 20, 2.4);
    mode.step(IDLE);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.lastMultiplierLossTick).toBe(2 * SIM_HZ + 102 + RECOVER_TICKS);
    expect(mode.state.score.points).toBeGreaterThan(points);
    expect(mode.state.crashes).toBe(1);
  });

  it('keeps every point when the run ends', () => {
    const mode = started();
    const script = stubPhysics(mode);
    // Going fast enough for each hit to be an accident of its own.
    slide(mode, 20, 0);
    for (let crash = 0; crash < 2; crash++) {
      script.hit = hit(6);
      mode.step(IDLE);
      script.hit = null;
      steps(mode, CRASH_COOLDOWN_TICKS);
    }
    slide(mode, 20, 0.5);
    steps(mode, 60);
    const points = mode.state.score.points;
    expect(points).toBeGreaterThan(0);
    script.hit = hit(6);
    mode.step(IDLE);
    expect(mode.state.phase).toBe('dead');
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.score.multiplier).toBe(1);
    expect(mode.state.score.drifting).toBe(false);
    steps(mode, SIM_HZ);
    expect(mode.state.score.points).toBe(points);
  });
});

describe('a dead run', () => {
  function crashOut(): EndlessMode {
    const mode = started();
    launch(mode, 20, 0, 0, 30);
    steps(mode, SIM_HZ, FLOORED);
    for (let crash = 0; crash < ENDLESS_MAX_CRASHES; crash++) {
      const car = mode.world.car;
      // Carrying its speed down the road, and thrown at the wall.
      shove(mode, car.x, HALF_WIDTH - RADIUS - 0.3, 0, 30, 8);
      for (let i = 0; i < CRASH_COOLDOWN_TICKS && mode.state.phase === 'running'; i++) mode.step(FLOORED);
    }
    expect(mode.state.phase).toBe('dead');
    return mode;
  }

  it('is frozen: time, distance, crashes and score stay as they were, whatever the driver does', () => {
    const mode = crashOut();
    const { ticks, distance, crashes, lastCrashTick, intensity } = mode.state;
    const points = mode.state.score.points;
    expect(mode.world.car.speed).toBeGreaterThan(15);
    const frozen = { ...mode.state };
    for (let i = 0; i < 8 * SIM_HZ; i++) {
      mode.step({ steer: i % 50 < 25 ? 1 : -1, throttle: 1, brake: 0, handbrake: false, reset: true });
      expect(mode.state).toEqual(frozen);
    }
    expect(mode.state).toMatchObject({ ticks, distance, crashes, lastCrashTick, intensity });
    expect(mode.state.score.points).toBe(points);
    expect(mode.state.deathCause).toBe('crashes');
  });

  it('lets the wreck slide to a stop on its own brakes, without stretching the distance', () => {
    const mode = crashOut();
    const diedAt = mode.world.car.x;
    const worldTick = mode.world.tick;
    let braked = 0;
    for (let i = 0; i < 8 * SIM_HZ; i++) {
      mode.step(FLOORED);
      expect(mode.world.car.throttle).toBe(0);
      if (mode.world.car.brake > 0 || mode.world.car.handbrake) braked++;
    }
    expect(braked).toBe(8 * SIM_HZ);
    expect(mode.world.tick).toBe(worldTick + 8 * SIM_HZ);
    expect(mode.world.car.speed).toBe(0);
    expect(mode.world.car.x).toBeGreaterThan(diedAt + 5);
    expect(mode.state.distance).toBeLessThan(mode.world.trackDist);
    expect(mode.world.car.reversing).toBe(false);
  });

  it('streams no more road', () => {
    const road = handRoad();
    const mode = createEndlessModeFrom(road.make);
    steps(mode, ENDLESS_COUNTDOWN_TICKS);
    const script = stubPhysics(mode);
    script.hit = hit(9);
    mode.world.car.speed = 30;
    for (let i = 0; i < 2 * CRASH_COOLDOWN_TICKS + 1; i++) mode.step(IDLE);
    expect(mode.state.phase).toBe('dead');
    const served = road.served();
    steps(mode, 5 * SIM_HZ);
    expect(road.served()).toBe(served);
    expect(mode.world.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('restart', () => {
  /** Forty seconds of scripted hooliganism on the bumpy hand-built road, sampled every quarter second. */
  function trace(mode: EndlessMode): string[] {
    const hashes: string[] = [];
    const input: InputState = { ...IDLE };
    for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS + 40 * SIM_HZ; i++) {
      const beat = Math.floor(i / (SIM_HZ / 2));
      input.throttle = beat % 5 === 4 ? 0 : 1;
      input.brake = beat % 5 === 4 ? 1 : 0;
      input.steer = beat % 11 === 7 ? 0.5 : beat % 13 === 5 ? -0.5 : -0.25 * mode.world.car.z - 2 * mode.world.car.heading;
      input.handbrake = beat % 17 === 9;
      mode.step(input);
      if (i % (SIM_HZ / 4) === 0) hashes.push(hashNumbers(fullState(mode)));
    }
    return hashes;
  }

  it('goes back to the start line with a fresh countdown, a fresh state and the first four chunks', () => {
    const road = handRoad({ bump: true });
    const mode = createEndlessModeFrom(road.make);
    const fresh = { ...mode.state };
    const freshWorld = fullState(mode);
    steps(mode, ENDLESS_COUNTDOWN_TICKS + 15 * SIM_HZ, FLOORED);
    expect(mode.state.distance).toBeGreaterThan(400);
    expect(mode.state.lastLandingTick).toBeGreaterThan(0);
    expect(mode.world.chunks[0].index).toBeGreaterThan(0);
    mode.restart();
    expect(mode.state).toEqual(fresh);
    expect(fullState(mode)).toEqual(freshWorld);
    expect(mode.world.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(road.served()).toBe(1 + CHUNKS_AHEAD);
    expect(mode.world.car).toMatchObject({ x: 0, z: 0, heading: 0, speed: 0, airborne: false, y: 0 });
    expect(mode.world.offTrack).toBe(false);
    expect(mode.world.lastCollision).toBeNull();
  });

  it('plays out exactly like the first run: identical state hashes all the way', () => {
    const mode = createEndlessModeFrom(handRoad({ bump: true }).make);
    const first = trace(mode);
    // The script is rough enough to mean something: it jumps, slides, crashes three times and rolls to a stop.
    expect(mode.state.lastTakeoffTick).toBeGreaterThan(0);
    expect(mode.state.score.points).toBeGreaterThan(0);
    expect(mode.state.deathCause).toBe('crashes');
    expect(mode.world.car.speed).toBe(0);
    mode.restart();
    const second = trace(mode);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(first.length / 2);
    expect(trace(createEndlessModeFrom(handRoad({ bump: true }).make))).toEqual(first);
  });

  it('works from a dead run, after either kind of death', () => {
    const mode = createEndlessModeFrom(handRoad({ bump: true }).make);
    const first = trace(mode);

    mode.restart();
    steps(mode, ENDLESS_COUNTDOWN_TICKS);
    launch(mode, 40, -6, 0.45, 38);
    for (let i = 0; i < 3 * SIM_HZ && mode.state.phase === 'running'; i++) mode.step(IDLE);
    expect(mode.state.deathCause).toBe('offTrack');
    mode.restart();
    expect(mode.state.phase).toBe('countdown');
    expect(mode.state.deathCause).toBeNull();
    expect(trace(mode)).toEqual(first);

    mode.restart();
    steps(mode, ENDLESS_COUNTDOWN_TICKS);
    for (let crash = 0; crash < ENDLESS_MAX_CRASHES; crash++) {
      hitWall(mode, 8, 15);
      steps(mode, CRASH_COOLDOWN_TICKS);
    }
    expect(mode.state.deathCause).toBe('crashes');
    mode.restart();
    expect(mode.state.crashes).toBe(0);
    expect(trace(mode)).toEqual(first);
  });

  it('rebuilds the generated road from its seed', () => {
    const mode = createEndlessMode('restart-seed', 'medium');
    const before = mode.world.chunks.map((c) => c.path);
    steps(mode, ENDLESS_COUNTDOWN_TICKS + 5 * SIM_HZ, { ...IDLE, throttle: 0.4 });
    expect(mode.state.distance).toBeGreaterThan(10);
    mode.restart();
    expect(mode.world.chunks.map((c) => c.path)).toEqual(before);
    expect(mode.world.chunks.map((c) => c.path)).not.toBe(before);
    expect(mode.state.distance).toBe(0);
    expect(mode.world.tick).toBe(0);
  });
});
