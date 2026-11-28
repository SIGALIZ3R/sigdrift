/**
 * Background music: three short lo-fi synth-pop loops played by a tiny sequencer on the game's AudioContext. No
 * samples or files: every note is an oscillator or a burst of the shared noise buffer, scheduled a moment ahead of
 * the audio clock. The whole band goes through one dark low-pass with a slow tape wobble and sits far under the
 * engine. Cosmetic only, so Math.random is fine here.
 */

export interface Song {
  name: string;
  bpm: number;
  /** 0..0.5: how late the off-beat sixteenths land, as a share of a sixteenth. */
  swing: number;
  /** One chord per bar, as MIDI note numbers (the pad plays them all, the arp walks them). */
  chords: readonly (readonly number[])[];
  /** Bass note per sixteenth of a bar, as an offset in semitones from the chord's root an octave down; null = rest. */
  bass: readonly (number | null)[];
  /** Arp: chord tone index per sixteenth (wrapping, +12 per lap), null = rest. */
  arp: readonly (number | null)[];
  /** Drum lanes over one bar of sixteenths: x = hit, o = soft hit, . = rest. */
  kick: string;
  snare: string;
  hat: string;
  padWave: OscillatorType;
  arpWave: OscillatorType;
  /** Low-pass on the whole band, Hz: lower = more muffled. */
  tone: number;
}

const _ = null;

export const SONGS: readonly Song[] = [
  {
    name: 'Afterglow',
    bpm: 82,
    swing: 0.16,
    // Dm9, G13, Cmaj9, Am9
    chords: [
      [50, 53, 57, 60, 64],
      [43, 53, 59, 64, 69],
      [48, 52, 55, 59, 62],
      [45, 48, 55, 59, 64],
    ],
    bass: [0, _, _, _, _, _, 0, _, 7, _, _, _, 12, _, 10, _],
    arp: [_, _, 2, _, 3, _, _, 4, _, _, 3, _, 2, _, _, _],
    kick: 'x.....x...x.....',
    snare: '....x.......x...',
    hat: 'o.x.o.x.o.x.o.xo',
    padWave: 'sawtooth',
    arpWave: 'triangle',
    tone: 1700,
  },
  {
    name: 'Night Transit',
    bpm: 96,
    swing: 0.06,
    // Am7, Fmaj7, Cadd9, G6
    chords: [
      [45, 55, 57, 60, 64],
      [41, 53, 57, 60, 64],
      [48, 55, 60, 62, 64],
      [43, 55, 59, 62, 64],
    ],
    bass: [0, _, 0, _, 12, _, 0, _, 0, _, 0, _, 12, _, 7, _],
    arp: [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 2, 3, 4, 5],
    kick: 'x...x...x...x...',
    snare: '....x.......x..o',
    hat: '..x...x...x...x.',
    padWave: 'sawtooth',
    arpWave: 'square',
    tone: 2200,
  },
  {
    name: 'Chrome Rain',
    bpm: 74,
    swing: 0.2,
    // Ebmaj7, Cm9, Abmaj7, Bb6/9
    chords: [
      [51, 55, 58, 62, 67],
      [48, 55, 58, 62, 63],
      [44, 55, 60, 63, 67],
      [46, 55, 58, 60, 65],
    ],
    bass: [0, _, _, _, _, _, _, 7, _, _, 0, _, _, _, _, _],
    arp: [_, _, _, _, 4, _, 3, _, _, _, _, _, 2, _, 1, _],
    kick: 'x.......x.x.....',
    snare: '....x.......x...',
    hat: 'x.o.x.o.x.o.x.oo',
    padWave: 'triangle',
    arpWave: 'sine',
    tone: 1400,
  },
];

/** Overall music level before the volume setting: subtle, well under the engine. */
const MUSIC_LEVEL = 0.16;
const FADE_IN = 2.5;
const FADE_OUT = 2;
/** How far ahead of the audio clock notes are scheduled, s, and how often the scheduler wakes, ms. */
const LOOKAHEAD = 0.25;
const TICK_MS = 50;

export interface MusicVoice {
  /** Fades over to `song` (an index into SONGS), or out with -1. Playing the current song again does nothing. */
  play(song: number): void;
  /** Index of the song playing (or fading in), -1 for none. */
  readonly current: number;
  dispose(): void;
}

function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

interface Player {
  song: Song;
  out: GainNode;
  step: number;
  nextTime: number;
  timer: ReturnType<typeof setInterval> | null;
}

export function createMusicVoice(ctx: BaseAudioContext, noise: AudioBuffer, destination: AudioNode): MusicVoice {
  // band -> warm low-pass -> level -> destination; a slow LFO wobbles every note's pitch like worn tape.
  const level = ctx.createGain();
  level.gain.value = MUSIC_LEVEL;
  const warm = ctx.createBiquadFilter();
  warm.type = 'lowpass';
  warm.Q.value = 0.4;
  warm.connect(level).connect(destination);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 0.35;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 9;
  wobble.connect(wobbleDepth);
  wobble.start();
  // Vinyl hiss: band-passed noise, very low.
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  hiss.playbackRate.value = 0.7;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.frequency.value = 3200;
  hissFilter.Q.value = 0.6;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hiss.connect(hissFilter).connect(hissGain).connect(level);
  hiss.start();

  let player: Player | null = null;
  let current = -1;

  function note(p: Player, freq: number, at: number, dur: number, wave: OscillatorType, peak: number, detune = 0): void {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    wobbleDepth.connect(osc.detune);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(peak, at + Math.min(0.08, dur * 0.3));
    env.gain.setTargetAtTime(0.0001, at + dur * 0.55, dur * 0.25);
    osc.connect(env).connect(p.out);
    osc.start(at);
    osc.stop(at + dur * 1.6 + 0.05);
    osc.onended = () => {
      wobbleDepth.disconnect(osc.detune);
      env.disconnect();
    };
  }

  function hit(p: Player, at: number, kind: 'kick' | 'snare' | 'hat', soft: boolean): void {
    const k = soft ? 0.55 : 1;
    if (kind === 'kick') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, at);
      osc.frequency.exponentialRampToValueAtTime(42, at + 0.14);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, at);
      env.gain.linearRampToValueAtTime(0.9 * k, at + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      osc.connect(env).connect(p.out);
      osc.start(at);
      osc.stop(at + 0.35);
      osc.onended = () => env.disconnect();
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = kind === 'hat' ? 1 : 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === 'hat' ? 'highpass' : 'bandpass';
    filter.frequency.value = kind === 'hat' ? 6500 : 1500;
    filter.Q.value = kind === 'hat' ? 0.5 : 0.8;
    const env = ctx.createGain();
    const len = kind === 'hat' ? 0.045 : 0.2;
    const peak = (kind === 'hat' ? 0.12 : 0.38) * k;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    // Random start into the noise, so no two hits are the same.
    const offset = Math.random() * Math.max(0, noise.duration - 0.5);
    src.connect(filter).connect(env).connect(p.out);
    src.start(at, offset);
    src.stop(at + len + 0.02);
    src.onended = () => env.disconnect();
  }

  function scheduleStep(p: Player, at: number): void {
    const song = p.song;
    const sixteenth = 60 / song.bpm / 4;
    const step = p.step % 16;
    const bar = Math.floor(p.step / 16);
    const chord = song.chords[bar % song.chords.length];
    const loop = Math.floor(bar / song.chords.length);
    // Every other time round the loop the arp joins; the first bar of every fourth loop drops the drums.
    const arpOn = loop % 2 === 1;
    const drumsOn = !(loop % 4 === 3 && bar % song.chords.length === 0) && loop > 0;

    if (step === 0) {
      // Pad: the whole chord, two slightly detuned voices per note, for the length of the bar.
      const barLen = sixteenth * 16;
      for (const n of chord.slice(1)) {
        note(p, midiToHz(n), at, barLen, song.padWave, 0.045, -7);
        note(p, midiToHz(n), at, barLen, song.padWave, 0.045, 7);
      }
    }
    const b = song.bass[step];
    if (b !== null && b !== undefined && loop > 0) {
      note(p, midiToHz(chord[0] - 12 + b), at, sixteenth * 3, 'triangle', 0.32);
    }
    const a = song.arp[step];
    if (arpOn && a !== null && a !== undefined) {
      const tones = chord.slice(1);
      const lap = Math.floor(a / tones.length);
      const n = tones[a % tones.length] + 12 * (lap + 1);
      note(p, midiToHz(n), at, sixteenth * 1.6, song.arpWave, 0.05);
    }
    if (drumsOn) {
      for (const lane of ['kick', 'snare', 'hat'] as const) {
        const c = song[lane][step];
        if (c === 'x' || c === 'o') hit(p, at, lane, c === 'o');
      }
    }
  }

  function pump(p: Player): void {
    if (ctx.state !== 'running') return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    // After the context was suspended the clock jumped on: skip ahead rather than play a pile-up of notes.
    if (p.nextTime < ctx.currentTime - 0.1) p.nextTime = ctx.currentTime + 0.05;
    while (p.nextTime < horizon) {
      scheduleStep(p, p.nextTime);
      const sixteenth = 60 / p.song.bpm / 4;
      const swingNext = (p.step + 1) % 2 === 1 ? p.song.swing : -p.song.swing;
      p.nextTime += sixteenth * (1 + swingNext);
      p.step++;
    }
  }

  function stopPlayer(p: Player): void {
    if (p.timer !== null) clearInterval(p.timer);
    p.timer = null;
    const now = ctx.currentTime;
    p.out.gain.cancelScheduledValues(now);
    p.out.gain.setValueAtTime(p.out.gain.value, now);
    p.out.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT);
    const out = p.out;
    setTimeout(() => out.disconnect(), (FADE_OUT + 3) * 1000);
  }

  return {
    get current() {
      return current;
    },
    play(song: number) {
      const next = song >= 0 && song < SONGS.length ? song : -1;
      if (next === current) return;
      current = next;
      if (player) stopPlayer(player);
      player = null;
      const now = ctx.currentTime;
      hissGain.gain.setTargetAtTime(next < 0 ? 0 : 0.05, now, 0.8);
      if (next < 0) return;
      const s = SONGS[next];
      warm.frequency.setTargetAtTime(s.tone, now, 0.5);
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, now);
      out.gain.linearRampToValueAtTime(1, now + FADE_IN);
      out.connect(warm);
      const p: Player = { song: s, out, step: 0, nextTime: now + 0.1, timer: null };
      p.timer = setInterval(() => pump(p), TICK_MS);
      pump(p);
      player = p;
    },
    dispose() {
      if (player?.timer) clearInterval(player.timer);
      player = null;
      wobble.stop();
      hiss.stop();
      level.disconnect();
    },
  };
}
