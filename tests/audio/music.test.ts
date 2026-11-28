import { describe, expect, it } from 'vitest';
import { SONGS } from '../../src/audio/music';

describe('background songs', () => {
  it('are three loops with one bar of sixteenths in every lane', () => {
    expect(SONGS).toHaveLength(3);
    expect(new Set(SONGS.map((s) => s.name)).size).toBe(3);
    for (const song of SONGS) {
      expect(song.bass).toHaveLength(16);
      expect(song.arp).toHaveLength(16);
      for (const lane of [song.kick, song.snare, song.hat]) expect(lane).toMatch(/^[xo.]{16}$/);
      expect(song.chords.length).toBeGreaterThan(0);
      for (const chord of song.chords) expect(chord.length).toBeGreaterThanOrEqual(3);
      expect(song.bpm).toBeGreaterThan(60);
      expect(song.bpm).toBeLessThan(110);
    }
  });
});
