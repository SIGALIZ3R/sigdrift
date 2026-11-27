/**
 * Hashes for replay tests and seeds. Not cryptographic.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
// The second mix uses unrelated constants so that it fails independently of the first.
const ALT_OFFSET = 0x9747b28c;
const ALT_PRIME = 0x5bd1e995;

const floatView = new Float64Array(1);
const wordView = new Uint32Array(floatView.buffer);
// Typed-array views use the platform byte order; read the two halves in a fixed order regardless.
const LOW_WORD = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0 : 1;
const HIGH_WORD = 1 - LOW_WORD;

/** FNV-1a over the four bytes of a 32-bit word, lowest byte first. */
function mixWord(hash: number, word: number, prime: number): number {
  hash = Math.imul(hash ^ (word & 0xff), prime);
  hash = Math.imul(hash ^ ((word >>> 8) & 0xff), prime);
  hash = Math.imul(hash ^ ((word >>> 16) & 0xff), prime);
  return Math.imul(hash ^ (word >>> 24), prime);
}

/** Bijective finaliser: spreads the last bytes' influence over all 32 bits. */
function avalanche(hash: number): number {
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/**
 * 16 hex chars over the exact float64 bits of every value: -0 and 0 differ, and so does any 1-ulp change.
 */
export function hashNumbers(values: readonly number[]): string {
  let h1 = FNV_OFFSET;
  let h2 = ALT_OFFSET;
  for (let i = 0; i < values.length; i++) {
    floatView[0] = values[i];
    const low = wordView[LOW_WORD];
    const high = wordView[HIGH_WORD];
    h1 = mixWord(mixWord(h1, low, FNV_PRIME), high, FNV_PRIME);
    h2 = mixWord(mixWord(h2, high, ALT_PRIME), low, ALT_PRIME);
  }
  return hex8(avalanche(h1)) + hex8(avalanche(h2 ^ values.length));
}

/** 8 hex chars over the string's UTF-16 code units. */
export function hashString(s: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME);
  }
  return hex8(avalanche(hash));
}
