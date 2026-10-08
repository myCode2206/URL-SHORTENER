import { createHmac } from 'node:crypto';

// Turns a unique database ID into a short code, and back.
//
//   database id 1, 2, 3 ...
//        │  1. permute: scramble the ID with a secret key (bijective)
//        ▼
//   2_946_023_911_342, 871_337_205_119, ...
//        │  2. Base62-encode to a fixed 7 characters
//        ▼
//   "Ze3kq9B", "fM0xT2a", ...
//
// Step 2 alone would already be collision-free, because different numbers
// always have different Base62 strings. But codes would be sequential ("0000001",
// "0000002"), so anyone could walk through every link ever created and see how
// many exist. Step 1 fixes that: it maps each ID to a unique number in the same
// range, so every code is still unique and the order looks random without the key.

export const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const SHORT_CODE_LENGTH = 7;
// 62^7 ≈ 3.5 trillion codes, about 350,000 times the 10M-URL target.
export const CODE_SPACE = 62 ** SHORT_CODE_LENGTH;

const SHORT_CODE_PATTERN = new RegExp(`^[0-9a-zA-Z]{${SHORT_CODE_LENGTH}}$`);

export function toBase62(value: number, length: number): string {
  let remaining = value;
  let out = '';
  for (let i = 0; i < length; i++) {
    out = BASE62_ALPHABET.charAt(remaining % 62) + out;
    remaining = Math.floor(remaining / 62);
  }
  if (remaining > 0) throw new RangeError(`${value} does not fit in ${length} Base62 characters`);
  return out;
}

export function fromBase62(code: string): number {
  let value = 0;
  for (const char of code) {
    const digit = BASE62_ALPHABET.indexOf(char);
    if (digit < 0) throw new RangeError(`invalid Base62 character "${char}"`);
    value = value * 62 + digit;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The permutation is a Feistel network, the structure inside block ciphers such
// as DES. It is reversible whatever the round function is, which is what makes
// it collision-free: two different IDs can never produce the same output.
//
// It works on 42-bit numbers (2^42 ≈ 4.4T, just above 62^7 ≈ 3.5T), split into
// two 21-bit halves. Each round mixes one half into the other using an HMAC of
// the secret. If the result lands outside [0, 62^7), it's permuted again
// ("cycle walking") until it fits; on average that takes 1.25 tries.
//
// A simpler scramble, (a × id + b) mod 62^7, can be broken from two consecutive
// codes: their difference reveals `a`. A keyed Feistel network can't be undone
// without the secret.
// ---------------------------------------------------------------------------
const HALF_BITS = 21;
const HALF_SIZE = 2 ** HALF_BITS;
const HALF_MASK = HALF_SIZE - 1;
const ROUNDS = 4;

function roundFunction(key: string, round: number, half: number): number {
  const digest = createHmac('sha256', key).update(`${round}:${half}`).digest();
  return digest.readUIntBE(0, 3) & HALF_MASK;
}

function feistelForward(key: string, value: number): number {
  let left = Math.floor(value / HALF_SIZE);
  let right = value % HALF_SIZE;
  for (let round = 0; round < ROUNDS; round++) {
    [left, right] = [right, left ^ roundFunction(key, round, right)];
  }
  return left * HALF_SIZE + right;
}

function feistelBackward(key: string, value: number): number {
  let left = Math.floor(value / HALF_SIZE);
  let right = value % HALF_SIZE;
  for (let round = ROUNDS - 1; round >= 0; round--) {
    [left, right] = [right ^ roundFunction(key, round, left), left];
  }
  return left * HALF_SIZE + right;
}

export interface ShortCodeCodec {
  encode(id: bigint): string;
  decode(code: string): bigint | null;
}

export function createShortCodeCodec(secret: string): ShortCodeCodec {
  return {
    encode(id) {
      if (id < 0n || id >= BigInt(CODE_SPACE)) {
        throw new RangeError(`id ${id} is outside the short-code space`);
      }
      let permuted = feistelForward(secret, Number(id));
      while (permuted >= CODE_SPACE) permuted = feistelForward(secret, permuted);
      return toBase62(permuted, SHORT_CODE_LENGTH);
    },

    // The inverse of encode. Redirects look codes up in the database directly;
    // this exists to prove the mapping is reversible and for debugging.
    decode(code) {
      if (!isShortCodeFormat(code)) return null;
      let value = feistelBackward(secret, fromBase62(code));
      while (value >= CODE_SPACE) value = feistelBackward(secret, value);
      return BigInt(value);
    },
  };
}

export function isShortCodeFormat(code: string): boolean {
  return SHORT_CODE_PATTERN.test(code);
}
