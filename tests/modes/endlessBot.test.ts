/**
 * The endless bot, and what it proves about the generated road: that a careful driver can always get through
 * (the fairness gate), that the bumps really do throw a careless one into the air, and that the mode can be lost.
 */
import { describe, expect, it } from 'vitest';
import type { Bump, Difficulty, EndlessGenerator, EndlessMode, InputState, Pose, Prop, TrackChunk } from '../../src/types';
import { DT, GEN_VERSION, PHYSICS_VERSION, SIM_HZ } from '../../src/types';
import { hashNumbers } from '../../src/core/hash';
import {
  CHUNKS_AHEAD,
  CHUNKS_BEHIND,
  ENDLESS_COUNTDOWN_TICKS,
  createEndlessMode,
  createEndlessModeFrom,
} from '../../src/modes/endless';
import { createEndlessGenerator } from '../../src/gen/endless';
import {
  LineFollower,
  addDodge,
  appendPath,
  beginPlan,
  clearLine,
  createDriveLine,
  layLine,
  planSpeeds,
} from '../../src/modes/driveLine';
import { bumpSpeed, createEndlessBot } from '../../src/modes/endlessBot';
import type { EndlessBotOptions } from '../../src/modes/endlessBot';
import { ASSIST_STRENGTH, DEFAULT_CAR_PARAMS, cloneParams } from '../../src/sim/params';
import { quantizeInput } from '../../src/sim/replay';
import type { ChunkShape } from '../helpers/handLevel';
import { makeBump, makeChunkRoad, makeStraightChunk } from '../helpers/handLevel';

const IDLE: InputState = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
const ORIGIN: Pose = { x: 0, z: 0, heading: 0 };
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const SEEDS = ['alpha', 'bravo', 'charlie', 'delta'];
const HALF_WIDTH = 8;

/** An endless straight road along +x in 200 m chunks, with whatever `dress` puts on each chunk. */
function straightRoad(dress: (chunk: TrackChunk) => void = () => {}): () => EndlessGenerator {
  return () => {
    let index = 0;
    return {
      seed: 'hand',
      difficulty: 'medium',
      start: ORIGIN,
      next(): TrackChunk {
        const chunk = makeStraightChunk(index, index * 200, 200, HALF_WIDTH);
        dress(chunk);
        index++;
        return chunk;
      },
    };
  };
}

/** Hands out chunks built beforehand. The test must end before they run out. */
function fixedRoad(chunks: TrackChunk[]): () => EndlessGenerator {
  return () => {
    let index = 0;
    return {
      seed: 'hand',
      difficulty: 'medium',
      start: ORIGIN,
      next(): TrackChunk {
        if (index >= chunks.length) throw new Error('the hand-built road ran out');
        return chunks[index++];
      },
    };
  };
}

interface Drive {
  mode: EndlessMode;
  /** Ticks on which the car touched anything, and the hardest of those touches. */
  contacts: number;
  hardest: number;
  airTicks: number;
  /** Bumps whose crest the car has driven past. */
  bumpsCrossed: number;
  /** Slowest and fastest the car went after its first 100 m. */
  slowest: number;
  fastest: number;
  windowFaults: number;
}

/**
 * Lets a driver loose until the run has covered `metres`, has died, or `seconds` have passed. The input goes
 * through the same quantisation the game applies.
 */
function drive(
  mode: EndlessMode,
  driver: (mode: EndlessMode) => InputState,
  metres: number,
  seconds: number,
): Drive {
  const { world, state } = mode;
  const out: Drive = {
    mode,
    contacts: 0,
    hardest: 0,
    airTicks: 0,
    bumpsCrossed: 0,
    slowest: Infinity,
    fastest: 0,
    windowFaults: 0,
  };
  const crossed = new Set<Bump>();
  const limit = ENDLESS_COUNTDOWN_TICKS + seconds * SIM_HZ;
  for (let i = 0; i < limit && state.phase !== 'dead' && state.distance < metres; i++) {
    mode.step(quantizeInput(driver(mode)));
    if (state.phase !== 'running') continue;
    const car = world.car;
    const hit = world.lastCollision;
    if (hit !== null) {
      out.contacts++;
      if (hit.impact > out.hardest) out.hardest = hit.impact;
    }
    if (car.airborne) out.airTicks++;
    if (state.distance > 100) {
      if (car.speed < out.slowest) out.slowest = car.speed;
      if (car.speed > out.fastest) out.fastest = car.speed;
    }
    const chunks = world.chunks;
    const first = Math.max(0, world.chunkIndex - CHUNKS_BEHIND);
    if (chunks[0].index !== first || chunks[chunks.length - 1].index !== world.chunkIndex + CHUNKS_AHEAD) {
      out.windowFaults++;
    }
    for (const bump of chunks[world.chunkIndex - chunks[0].index].bumps) {
      if (!crossed.has(bump) && (car.x - bump.x) * bump.dirX + (car.z - bump.z) * bump.dirZ > 0) crossed.add(bump);
    }
  }
  out.bumpsCrossed = crossed.size;
  return out;
}

function botDriver(options?: EndlessBotOptions): (mode: EndlessMode) => InputState {
  const bot = createEndlessBot(options);
  return (mode) => bot(mode.world, mode.state);
}

/** The bot's line, taken with no judgement at all: the throttle is welded open and the wheel is either hard over or centred. */
function recklessDriver(): (mode: EndlessMode) => InputState {
  const bot = createEndlessBot({ bumpCare: false });
  const input: InputState = { ...IDLE };
  return (mode) => {
    const wanted = bot(mode.world, mode.state);
    input.steer = Math.abs(wanted.steer) > 0.2 ? Math.sign(wanted.steer) : 0;
    input.throttle = 1;
    return input;
  };
}

describe('endless bot', () => {
  it('keeps its hands off the controls during the countdown and once the run is dead', () => {
    const mode = createEndlessModeFrom(straightRoad());
    const bot = createEndlessBot();
    for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS; i++) {
      expect(bot(mode.world, mode.state)).toEqual(IDLE);
      mode.step(bot(mode.world, mode.state));
    }
    expect(bot(mode.world, mode.state).throttle).toBeGreaterThan(0);
    mode.state.phase = 'dead';
    expect(bot(mode.world, mode.state)).toEqual(IDLE);
  });

  it('hands back the same input object every tick, and never asks for a reset or the handbrake', () => {
    const mode = createEndlessModeFrom(straightRoad());
    const bot = createEndlessBot();
    const first = bot(mode.world, mode.state);
    for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS + 20 * SIM_HZ; i++) {
      const input = bot(mode.world, mode.state);
      expect(input).toBe(first);
      expect(input.reset).toBe(false);
      expect(input.handbrake).toBe(false);
      mode.step(input);
    }
    expect(mode.state.distance).toBeGreaterThan(300);
  });

  it('drives a straight road down the middle, across chunk after chunk, without touching anything', () => {
    const { mode, contacts, airTicks, fastest, windowFaults } = drive(
      createEndlessModeFrom(straightRoad()),
      botDriver(),
      3000,
      200,
    );
    expect(mode.state.distance).toBeGreaterThanOrEqual(3000);
    expect(mode.state.phase).toBe('running');
    expect(contacts).toBe(0);
    expect(airTicks).toBe(0);
    expect(windowFaults).toBe(0);
    expect(Math.abs(mode.world.car.z)).toBeLessThan(0.01);
    // A road this narrow is taken at about four fifths of the bot's top speed.
    expect(fastest).toBeGreaterThan(20);
  });

  it('follows a road that winds both ways and changes width', () => {
    const shapes: ChunkShape[] = [];
    for (let i = 0; i < 6; i++) {
      shapes.push({ length: 120 }, { length: 60, turn: 1.3 }, { length: 90, endHalfWidth: 12 });
      shapes.push({ length: 60, turn: -1.3, endHalfWidth: 8 }, { length: 70, turn: -0.9 }, { length: 70, turn: 0.9 });
    }
    const chunks = makeChunkRoad(shapes, HALF_WIDTH);
    const metres = chunks[chunks.length - 1 - CHUNKS_AHEAD].startDist - 10;
    const { mode, contacts, slowest, fastest } = drive(createEndlessModeFrom(fixedRoad(chunks)), botDriver(), metres, 300);
    expect(mode.state.distance).toBeGreaterThanOrEqual(metres);
    expect(metres).toBeGreaterThan(2000);
    expect(contacts).toBe(0);
    expect(mode.world.offTrack).toBe(false);
    // It slows for the bends and uses the straights.
    expect(slowest).toBeLessThan(16);
    expect(fastest).toBeGreaterThan(slowest + 5);
  });

  it.each([
    ['in the middle of the road', 0, 2],
    ['left of centre', -3, 1.5],
    ['right of centre', 3, 1.5],
    ['against the left wall', -HALF_WIDTH, 1.6],
    ['against the right wall', HALF_WIDTH, 1.6],
  ])('passes a pillar %s on its open side', (_where, z, radius) => {
    // One on every chunk after the first, so pillars keep arriving with the road.
    const pillars = (chunk: TrackChunk): void => {
      const prop: Prop = { kind: 'pillar', x: chunk.path[0].x + 100, z, y: 0, radius, height: 4, hue: 0 };
      if (chunk.index > 0) chunk.props.push(prop);
    };
    const { mode, contacts } = drive(createEndlessModeFrom(straightRoad(pillars)), botDriver(), 1500, 120);
    expect(mode.state.distance).toBeGreaterThanOrEqual(1500);
    expect(contacts).toBe(0);
    expect(mode.state.crashes).toBe(0);
  });

  it.each([
    ['low and long', 0.35, 14],
    ['the standard one', 0.5, 12],
    ['high and short', 0.8, 10],
  ])('knows how fast a bump can be taken with the wheels down: %s', (_name, height, length) => {
    const bump = makeBump(100, 0, 0, HALF_WIDTH, height, length);
    const safe = bumpSpeed(bump);
    const flightAt = (speed: number): number => {
      const mode = createEndlessModeFrom(straightRoad((chunk) => void (chunk.index === 0 && chunk.bumps.push(bump))));
      for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS; i++) mode.step(IDLE);
      mode.world.placeCar({ x: 70, z: 0, heading: 0 });
      mode.world.car.vx = speed;
      let airTicks = 0;
      for (let i = 0; i < 15 * SIM_HZ && mode.world.car.x < 130; i++) {
        // Just enough throttle to hold the speed.
        mode.step({ ...IDLE, throttle: mode.world.car.speed < speed ? 0.3 : 0 });
        if (mode.world.car.airborne) airTicks++;
      }
      expect(mode.world.car.x).toBeGreaterThanOrEqual(130);
      return airTicks;
    };
    expect(safe).toBeGreaterThan(6);
    expect(safe).toBeLessThan(20);
    expect(flightAt(safe)).toBe(0);
    // The margin is real but not wasteful: a tenth faster still holds the road, 40% faster flies. (The world's
    // suspension soaks up the first few centimetres of a crest falling away, so the car leaves the ground from about
    // 1.35 x this speed, a little later than the 1.2 x the car's own launch threshold alone would give.)
    expect(flightAt(1.1 * safe)).toBe(0);
    expect(flightAt(1.4 * safe)).toBeGreaterThan(5);
  });

  it('slows for a bump and keeps its wheels on the ground, where the same driver without the care flies', () => {
    const bumps = (chunk: TrackChunk): void => {
      if (chunk.index > 0) chunk.bumps.push(makeBump(chunk.path[0].x + 100, 0, 0, HALF_WIDTH, 0.6, 11));
    };
    const careful = drive(createEndlessModeFrom(straightRoad(bumps)), botDriver(), 1500, 200);
    const careless = drive(createEndlessModeFrom(straightRoad(bumps)), botDriver({ bumpCare: false }), 1500, 200);
    const safe = bumpSpeed(makeBump(0, 0, 0, HALF_WIDTH, 0.6, 11));

    expect(careful.bumpsCrossed).toBeGreaterThanOrEqual(6);
    expect(careful.airTicks).toBe(0);
    expect(careful.contacts).toBe(0);
    expect(careful.mode.state.lastTakeoffTick).toBe(-1);
    // Down to the bump's speed at each crest, and back up to the road's speed in between.
    expect(careful.slowest).toBeLessThan(safe + 0.6);
    expect(careful.slowest).toBeGreaterThan(safe - 1.5);
    expect(careful.fastest).toBeGreaterThan(safe + 8);

    expect(careless.bumpsCrossed).toBe(careful.bumpsCrossed);
    expect(careless.airTicks).toBeGreaterThan(careless.bumpsCrossed * 30);
    expect(careless.mode.state.lastTakeoffTick).toBeGreaterThan(0);
    expect(careless.slowest).toBeGreaterThan(safe + 5);
    // On a straight road the flight is harmless, and the careful driver pays for its care in time.
    expect(careless.mode.state.phase).toBe('running');
    expect(careless.mode.state.ticks).toBeLessThan(careful.mode.state.ticks);
  });

  it('can be capped, or told to hold one speed', () => {
    const capped = drive(createEndlessModeFrom(straightRoad()), botDriver({ speedCap: 15 }), 1000, 200);
    expect(capped.fastest).toBeGreaterThan(14);
    expect(capped.fastest).toBeLessThan(15.6);
    const steady = drive(createEndlessMode('alpha', 'easy'), botDriver({ constantSpeed: 12 }), 1000, 200);
    expect(steady.mode.state.distance).toBeGreaterThanOrEqual(1000);
    expect(steady.slowest).toBeGreaterThan(10.5);
    expect(steady.fastest).toBeLessThan(13);
  });

  it('is deterministic, and picks the road up again after a restart', () => {
    const run = (mode: EndlessMode, driver: (mode: EndlessMode) => InputState): string => {
      drive(mode, driver, 1200, 200);
      return hashNumbers([...mode.world.snapshot(), mode.state.ticks, mode.state.distance]);
    };
    const mode = createEndlessMode('bot-determinism', 'hard');
    const driver = botDriver();
    const first = run(mode, driver);
    expect(mode.state.distance).toBeGreaterThanOrEqual(1200);
    expect(run(createEndlessMode('bot-determinism', 'hard'), botDriver())).toBe(first);
    // The same bot, with its line still laid over the road it had reached, on a run that starts again.
    mode.restart();
    expect(run(mode, driver)).toBe(first);
    expect(run(createEndlessMode('bot-determinism-2', 'hard'), botDriver())).not.toBe(first);
  });
});

/**
 * The fairness gate: a road the careful bot cannot drive cleanly is a road a player should not be given. A failure
 * here means the bot, the physics or the generator changed; the difficulty and seed in the test name, and the
 * chunk index in the message, say where to look.
 */
describe('driveability of the endless road', () => {
  const GATE_METRES = 4000;
  const cases = DIFFICULTIES.flatMap((difficulty) => SEEDS.map((seed) => [difficulty, seed] as const));

  it.each(cases)('%s, seed "%s": the bot drives 4 km without a crash and without leaving the road', (difficulty, seed) => {
    const mode = createEndlessMode(seed, difficulty);
    const { world, state } = mode;
    const result = drive(mode, botDriver(), GATE_METRES, 600);
    const where = `${difficulty} "${seed}" chunk ${world.chunkIndex} at ${state.distance.toFixed(0)} m`;
    expect(state.deathCause, where).toBeNull();
    expect(world.offTrack, where).toBe(false);
    expect(state.crashes, where).toBe(0);
    expect(state.phase, where).toBe('running');
    expect(state.distance, where).toBeGreaterThanOrEqual(GATE_METRES);
    // More than the gate asks: the bot does not so much as brush a wall, and never leaves the ground.
    expect(result.contacts, where).toBe(0);
    expect(result.airTicks, where).toBe(0);
    expect(state.lastTakeoffTick, where).toBe(-1);
    expect(result.windowFaults, where).toBe(0);
    // About fifteen chunks, at a pace that is driving and not creeping.
    expect(world.chunkIndex).toBeGreaterThanOrEqual(13);
    expect(state.distance / (state.ticks * DT)).toBeGreaterThan(11);
    // It gets harder as it goes.
    expect(state.intensity).toBeGreaterThan(createEndlessMode(seed, difficulty).state.intensity + 0.3);
  });

  it('meets bumps on the way, on every difficulty', { timeout: 60_000 }, () => {
    const lines: string[] = [];
    for (const difficulty of DIFFICULTIES) {
      let bumps = 0;
      let seconds = 0;
      let slowest = Infinity;
      for (const seed of SEEDS) {
        const result = drive(createEndlessMode(seed, difficulty), botDriver(), GATE_METRES, 600);
        bumps += result.bumpsCrossed;
        seconds += result.mode.state.ticks * DT;
        slowest = Math.min(slowest, result.slowest);
      }
      expect(bumps, difficulty).toBeGreaterThan(SEEDS.length);
      lines.push(
        `  ${difficulty}: ${bumps} bumps crossed in ${SEEDS.length} x 4 km, mean ${(seconds / SEEDS.length).toFixed(1)} s ` +
          `(${((SEEDS.length * GATE_METRES) / seconds).toFixed(1)} m/s), slowest ${slowest.toFixed(1)} m/s`,
      );
    }
    console.log(`careful bot over the fairness gate\n${lines.join('\n')}`);
  });
});

/**
 * A driver who never thinks about bumps and leaves the braking as late as it will go: the bot's line and steering,
 * the throttle flat to the floor on every straight, and the brakes hard on at the last moment that would still
 * get the car down to `bendSpeed` for the bend if the brakes gave `decel` (they give that much only at speed).
 * Pedals are on or off, as on a keyboard.
 */
function lateBraker(decel: number, bendSpeed: number): (mode: EndlessMode) => InputState {
  const line = createDriveLine(1024);
  const follower = new LineFollower(line);
  const input: InputState = { ...IDLE };
  let oldest: TrackChunk | null = null;
  let newest: TrackChunk | null = null;
  return (mode) => {
    const { world, state } = mode;
    input.steer = 0;
    input.throttle = 0;
    input.brake = 0;
    if (state.phase !== 'running') return input;
    const chunks = world.chunks;
    if (chunks[0] !== oldest || chunks[chunks.length - 1] !== newest) {
      oldest = chunks[0];
      newest = chunks[chunks.length - 1];
      clearLine(line);
      for (let c = 0; c < chunks.length; c++) appendPath(line, chunks[c].path, c === 0 ? 0 : 1);
      beginPlan(line);
      for (const chunk of chunks) for (const prop of chunk.props) addDodge(line, prop);
      layLine(line);
      // For the curvature of the line. The speeds are this driver's own: flat out, and `bendSpeed` in a bend.
      planSpeeds(line);
      const last = line.count - 1;
      for (let i = 0; i <= last; i++) {
        let sharpest = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(last, i + 2); j++) sharpest = Math.max(sharpest, line.curvature[j]);
        line.speed[i] = sharpest > 0.02 ? bendSpeed : 60;
      }
      for (let i = last - 1; i >= 0; i--) {
        const entry = Math.sqrt(line.speed[i + 1] * line.speed[i + 1] + 2 * decel * (line.dist[i + 1] - line.dist[i]));
        if (entry < line.speed[i]) line.speed[i] = entry;
      }
      follower.seat(world.trackDist);
    }
    follower.drive(world.car, world.params, input);
    const target = Math.min(line.speed[follower.index], line.speed[Math.min(follower.index + 1, line.count - 1)]);
    input.throttle = world.car.speed < target ? 1 : 0;
    input.brake = world.car.speed > target + 0.5 && world.car.forwardSpeed > 2 ? 1 : 0;
    return input;
  };
}

/** The generated road for `seed`, as it is or with every bump taken off it. */
function generatedRoad(seed: string, difficulty: Difficulty, withBumps: boolean): () => EndlessGenerator {
  return () => {
    const generator = createEndlessGenerator(seed, difficulty);
    return {
      seed,
      difficulty,
      start: generator.start,
      next(): TrackChunk {
        const chunk = generator.next();
        return withBumps ? chunk : { ...chunk, bumps: [] };
      },
    };
  };
}

describe('bumps on a gentle road', () => {
  it('cost a driver who brakes late and never slows for them no more lives than the same road without bumps', { timeout: 180_000 }, () => {
    // The first 2 km of an easy run, with the steering assist the game ships. A bump too close before a bend
    // sends this driver into the bend still in the air, unbraked: with crests allowed 16 m before a bend that cost
    // it a life on about one run in eight. With 45 m of landing room it costs nothing.
    const SEEDS_HERE = 40;
    const tally = (withBumps: boolean): { crashes: number; dead: number; airSeconds: number; metres: number; top: number } => {
      const out = { crashes: 0, dead: 0, airSeconds: 0, metres: 0, top: 0 };
      for (let s = 0; s < SEEDS_HERE; s++) {
        const params = cloneParams(DEFAULT_CAR_PARAMS);
        params.steerAssist = ASSIST_STRENGTH;
        const mode = createEndlessModeFrom(generatedRoad(`ab-${s}`, 'easy', withBumps), params);
        const result = drive(mode, lateBraker(22, 16), 2000, 200);
        out.crashes += mode.state.crashes;
        if (mode.state.phase === 'dead') out.dead++;
        out.airSeconds += result.airTicks * DT;
        out.metres += mode.state.distance;
        out.top = Math.max(out.top, result.fastest);
      }
      return out;
    };
    const plain = tally(false);
    const bumpy = tally(true);
    // The driver is nearly clean on a road with no bumps, and it really is flat out. (PHYSICS_VERSION 3 / GEN_VERSION
    // 2: on the hilly road with the looser car it crashes on about one run in thirteen, and twice the wreck is left
    // nose to the wall, where this driver, who never reverses, sits for the rest of the run. The crests alone throw
    // it into the air for a few seconds over all forty runs.)
    expect(plain.crashes).toBeLessThanOrEqual(4);
    expect(plain.dead).toBe(0);
    expect(plain.airSeconds).toBeLessThan(SEEDS_HERE / 4);
    expect(plain.top).toBeGreaterThan(40);
    // The bumps are there and it flies over them...
    expect(bumpy.airSeconds).toBeGreaterThan(SEEDS_HERE);
    // ...and they cost it nothing more.
    expect(bumpy.crashes).toBeLessThanOrEqual(plain.crashes + 1);
    expect(bumpy.dead).toBe(0);
    expect(bumpy.metres).toBeGreaterThanOrEqual(plain.metres - 1);
  });
});

describe('jumps are real', () => {
  it('throws a car that arrives flat out and straight into the air, on every bump of the hard road', () => {
    let bumps = 0;
    let landedOff = 0;
    let shortest = Infinity;
    let longest = 0;
    for (const seed of SEEDS) {
      const probe = createEndlessMode(seed, 'hard');
      const found = probe.world.chunks.flatMap((chunk) => chunk.bumps);
      for (const bump of found) {
        const mode = createEndlessMode(seed, 'hard');
        for (let i = 0; i < ENDLESS_COUNTDOWN_TICKS; i++) mode.step(IDLE);
        // On the straight that leads up to the crest, at a speed the straights allow, nose along the road.
        const back = bump.halfLength + 6;
        mode.world.placeCar({
          x: bump.x - bump.dirX * back,
          z: bump.z - bump.dirZ * back,
          heading: Math.atan2(bump.dirZ, bump.dirX),
        });
        mode.world.car.vx = 25 * bump.dirX;
        mode.world.car.vz = 25 * bump.dirZ;
        let airTicks = 0;
        for (let i = 0; i < 2 * SIM_HZ && mode.state.phase === 'running'; i++) {
          mode.step({ ...IDLE, throttle: 1 });
          if (mode.world.car.airborne) airTicks++;
        }
        expect(airTicks, `${seed}: bump at ${bump.x}, ${bump.z}`).toBeGreaterThan(SIM_HZ / 4);
        expect(mode.state.lastTakeoffTick).toBeGreaterThan(0);
        bumps++;
        shortest = Math.min(shortest, airTicks * DT);
        longest = Math.max(longest, airTicks * DT);
        if (mode.state.deathCause === 'offTrack') landedOff++;
      }
    }
    expect(bumps).toBeGreaterThanOrEqual(SEEDS.length);
    console.log(
      `hard road, 25 m/s straight at each bump of the first four chunks: ${bumps} bumps, air time ` +
        `${shortest.toFixed(2)}..${longest.toFixed(2)} s, ${landedOff} flights came down outside the road`,
    );
  });

  it('gives a driver who follows the road but ignores the bumps plenty of air time on the hard road', () => {
    const result = drive(createEndlessMode('alpha', 'hard'), botDriver({ bumpCare: false }), 4000, 600);
    expect(result.bumpsCrossed).toBeGreaterThan(5);
    expect(result.airTicks).toBeGreaterThan(result.bumpsCrossed * (SIM_HZ / 10));
    expect(result.mode.state.lastLandingTick).toBeGreaterThan(result.mode.state.lastTakeoffTick - 1);
  });
});

describe('the mode can be lost', () => {
  it('kills a driver with the throttle welded open and crude steering within a few kilometres, on every difficulty', () => {
    const lines: string[] = [];
    for (const difficulty of DIFFICULTIES) {
      const distances: string[] = [];
      for (const seed of SEEDS) {
        const { mode } = drive(createEndlessMode(seed, difficulty), recklessDriver(), 20000, 600);
        const where = `${difficulty} "${seed}"`;
        expect(mode.state.phase, where).toBe('dead');
        expect(mode.state.deathCause, where).not.toBeNull();
        expect(mode.state.distance, where).toBeLessThan(3000);
        if (mode.state.deathCause === 'crashes') expect(mode.state.crashes, where).toBe(3);
        distances.push(`${mode.state.distance.toFixed(0)} m (${mode.state.deathCause})`);
      }
      lines.push(`  ${difficulty}: ${distances.join(', ')}`);
    }
    console.log(`reckless driver, distance at death\n${lines.join('\n')}`);
  });

  it('is more dangerous on medium than on easy, and on hard than on medium, for the same hands at the same speed', () => {
    // Good hands, no judgement: the bot's steering at one fixed speed, slowing for nothing. How far it gets says
    // how much the road punishes that speed.
    const speeds = [14, 16, 18, 20, 22, 24];
    const cap = 10000;
    const mean = new Map<string, number>();
    const lines: string[] = [];
    for (const speed of speeds) {
      const cells: string[] = [];
      for (const difficulty of DIFFICULTIES) {
        let total = 0;
        let deaths = 0;
        let falls = 0;
        for (const seed of SEEDS) {
          const { mode } = drive(createEndlessMode(seed, difficulty), botDriver({ constantSpeed: speed }), cap, 1200);
          total += Math.min(mode.state.distance, cap);
          if (mode.state.phase === 'dead') deaths++;
          if (mode.state.deathCause === 'offTrack') falls++;
        }
        mean.set(`${speed}/${difficulty}`, total / SEEDS.length);
        cells.push(`${difficulty} ${(total / SEEDS.length).toFixed(0)} m (${deaths}/${SEEDS.length} died, ${falls} off the road)`);
      }
      lines.push(`  ${speed} m/s: ${cells.join(', ')}`);
    }
    console.log(`mean survival distance at a constant speed, capped at ${cap} m\n${lines.join('\n')}`);
    const at = (speed: number, difficulty: Difficulty): number => mean.get(`${speed}/${difficulty}`) as number;
    // Slow enough and every road is safe; fast enough and none is.
    for (const difficulty of DIFFICULTIES) {
      expect(at(14, difficulty)).toBe(cap);
      expect(at(24, difficulty)).toBeLessThan(1500);
    }
    // In between, the difficulty decides. (GEN_VERSION 2: easy and medium are closer than they were, about 10-20%
    // apart at 20-22 m/s; hard is clearly the worst, and the only one whose open edges throw this driver off.)
    for (const speed of [20, 22, 24]) {
      expect(at(speed, 'easy'), `${speed} m/s`).toBeGreaterThan(at(speed, 'medium'));
      expect(at(speed, 'medium'), `${speed} m/s`).toBeGreaterThan(at(speed, 'hard'));
    }
    expect(at(20, 'easy')).toBeGreaterThan(1.5 * at(20, 'hard'));
    expect(at(22, 'medium')).toBeGreaterThan(1.5 * at(22, 'hard'));
    expect(at(24, 'easy')).toBeGreaterThan(1.5 * at(24, 'medium'));
  }, 120_000);
});

/**
 * One recording, pinned: the endless bot for sixty seconds of driving on the seed "endless-golden", medium. It is
 * the guard that says "endless mode changed": the generator's chunks, the streaming, bumps underfoot, the rules'
 * state and the bot itself all feed the hash.
 *
 * WHEN THE PIN MOVES
 * If the generator or the physics changed ON PURPOSE in a released game, bump GEN_VERSION or PHYSICS_VERSION in
 * src/types.ts and then update the pin. If only the bot changed, update the pin. If nothing was meant to change,
 * this is a determinism bug: find it.
 *
 * HISTORY
 * - Before release, the review fixes to endless mode moved the pin (907.26 m to 908.36 m): weight transfer under
 *   braking is limited (BRAKE_TRANSFER_LIMIT), a gentle road keeps 45 m of straight between a crest and the bend
 *   ahead (which changes medium's first chunks), and the world's snapshot gained "was above the walls".
 * - PHYSICS_VERSION 3 / GEN_VERSION 2 (2.5D roads, the drift retune, ScoreState scoring, the bot's hills and crests)
 *   moved it again; the intent is unchanged.
 * - Review fixes: open edges keep their landing zone clear (and reserve it from later road), a crest never sits
 *   where its flight would carry a car over the next bend's barrier, the progress tracker ignores heights while the
 *   car is airborne, and the score locks out after a crash. The road changed: 973.58 m to 1034.65 m.
 */
describe('golden endless run', () => {
  const PINNED_PHYSICS_VERSION = 3;
  const PINNED_GEN_VERSION = 2;
  const PINNED_HASH = 'f0c27f81f1b28fe5';
  const PINNED_DISTANCE = 1034.6478589079409;
  const GOLDEN_TICKS = 60 * SIM_HZ;

  function golden(): { hash: string; distance: number; bumps: number; mode: EndlessMode } {
    const mode = createEndlessMode('endless-golden', 'medium');
    const { world, state } = mode;
    const bot = createEndlessBot();
    const samples: number[] = [];
    const crossed = new Set<Bump>();
    while (state.ticks < GOLDEN_TICKS && state.phase !== 'dead') {
      mode.step(quantizeInput(bot(world, state)));
      for (const bump of world.chunks[world.chunkIndex - world.chunks[0].index].bumps) {
        if ((world.car.x - bump.x) * bump.dirX + (world.car.z - bump.z) * bump.dirZ > 0) crossed.add(bump);
      }
      if (state.ticks > 0 && state.ticks % SIM_HZ === 0) {
        samples.push(
          ...world.snapshot(),
          world.chunkIndex,
          world.chunks[0].index,
          world.chunks.length,
          state.ticks,
          state.distance,
          state.crashes,
          state.lastCrashTick,
          state.intensity,
          state.lastTakeoffTick,
          state.lastLandingTick,
          state.score.points,
          state.score.multiplier,
          state.score.peakMultiplier,
          state.score.drifting ? 1 : 0,
          state.score.proximity,
          state.score.combo,
          state.score.lastMultiplierLossTick,
          state.score.lastCloseTick,
        );
      }
    }
    return { hash: hashNumbers(samples), distance: state.distance, bumps: crossed.size, mode };
  }

  it('is the same run twice over', () => {
    const a = golden();
    const b = golden();
    expect(a.hash).toBe(b.hash);
    expect(a.distance).toBe(b.distance);
  });

  it('matches the pinned state hash after 60 s', () => {
    const run = golden();
    // Coverage first: the minute takes in several chunks, streaming at both ends of the window, and bumps.
    expect(run.mode.state.phase).toBe('running');
    expect(run.mode.state.ticks).toBe(GOLDEN_TICKS);
    expect(run.mode.world.chunks[0].index).toBeGreaterThan(0);
    expect(run.bumps).toBeGreaterThan(0);
    expect(PHYSICS_VERSION).toBe(PINNED_PHYSICS_VERSION);
    expect(GEN_VERSION).toBe(PINNED_GEN_VERSION);
    expect({ hash: run.hash, distance: run.distance }).toEqual({ hash: PINNED_HASH, distance: PINNED_DISTANCE });
  });
});
