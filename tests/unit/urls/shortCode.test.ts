import {
  CODE_SPACE,
  createShortCodeCodec,
  fromBase62,
  isShortCodeFormat,
  SHORT_CODE_LENGTH,
  toBase62,
} from '../../../src/modules/urls/shortCode';

const codec = createShortCodeCodec('unit-test-secret-at-least-32-characters!!');

describe('Base62', () => {
  it.each([
    [0, '0000000'],
    [1, '0000001'],
    [61, '000000Z'],
    [62, '0000010'],
    [62 * 62, '0000100'],
    [CODE_SPACE - 1, 'ZZZZZZZ'],
  ])('encodes %d as %s and back', (value, code) => {
    expect(toBase62(value, SHORT_CODE_LENGTH)).toBe(code);
    expect(fromBase62(code)).toBe(value);
  });

  it('refuses numbers that need more than the requested length', () => {
    expect(() => toBase62(CODE_SPACE, SHORT_CODE_LENGTH)).toThrow(RangeError);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => fromBase62('abc-def')).toThrow(RangeError);
  });
});

describe('short-code codec', () => {
  it('always produces 7 alphanumeric characters', () => {
    for (const id of [0n, 1n, 2n, 1_000n, 10_000_000n, BigInt(CODE_SPACE - 1)]) {
      expect(codec.encode(id)).toMatch(/^[0-9a-zA-Z]{7}$/);
    }
  });

  it('is reversible: decode(encode(id)) === id', () => {
    for (const id of [0n, 1n, 2n, 61n, 62n, 123_456_789n, BigInt(CODE_SPACE - 1)]) {
      expect(codec.decode(codec.encode(id))).toBe(id);
    }
  });

  it('never gives two IDs the same code (100,000 consecutive IDs)', () => {
    const codes = new Set<string>();
    for (let id = 1n; id <= 100_000n; id++) codes.add(codec.encode(id));
    expect(codes.size).toBe(100_000);
  });

  it('hides the sequence: consecutive IDs give unrelated codes', () => {
    const codes = Array.from({ length: 1000 }, (_, i) => codec.encode(BigInt(i + 1)));
    // Sequential Base62 would put all 1,000 codes under 1 or 2 leading characters.
    expect(new Set(codes.map((code) => code[0])).size).toBeGreaterThan(50);
    expect([...codes].sort()).not.toEqual(codes);
  });

  it('is deterministic for a secret and different across secrets', () => {
    const again = createShortCodeCodec('unit-test-secret-at-least-32-characters!!');
    const other = createShortCodeCodec('a-completely-different-secret-value-123456');
    expect(again.encode(42n)).toBe(codec.encode(42n));
    expect(other.encode(42n)).not.toBe(codec.encode(42n));
  });

  it('rejects IDs outside the code space', () => {
    expect(() => codec.encode(-1n)).toThrow(RangeError);
    expect(() => codec.encode(BigInt(CODE_SPACE))).toThrow(RangeError);
  });

  it.each(['', 'abc', 'abcdefgh', 'abc-def', 'abc def', 'äbcdefg'])(
    'decodes malformed code %j to null',
    (code) => {
      expect(codec.decode(code)).toBeNull();
      expect(isShortCodeFormat(code)).toBe(false);
    },
  );
});
