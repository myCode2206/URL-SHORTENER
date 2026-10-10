import { isAliasFormat, normalizeAlias } from '../../../src/modules/urls/alias';
import { validateExpiry } from '../../../src/modules/urls/expiry';

function rejection(alias: string): { code: string; message: string } {
  try {
    normalizeAlias(alias);
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error(`expected "${alias}" to be rejected`);
}

describe('normalizeAlias', () => {
  it.each([
    ['my-profile', 'my-profile'],
    ['My-Profile', 'my-profile'], // case-insensitive
    ['  launch-2026  ', 'launch-2026'],
    ['abcd', 'abcd'], // minimum length
    ['a'.repeat(32), 'a'.repeat(32)], // maximum length
    ['my-page', 'my-page'], // 7 characters, but the hyphen makes it unlike a code
    ['abcdefgh', 'abcdefgh'], // 8 letters: longer than a code
    ['pineapple-cake', 'pineapple-cake'], // contains "apple", but not as a word
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeAlias(input)).toBe(expected);
  });

  it.each([
    ['abc', /4–32 characters/],
    ['a'.repeat(33), /4–32 characters/],
    ['my_profile', /letters, digits and single hyphens/],
    ['my profile', /letters, digits and single hyphens/],
    ['-profile', /letters, digits and single hyphens/],
    ['profile-', /letters, digits and single hyphens/],
    ['my--profile', /letters, digits and single hyphens/],
    ['café-menu', /letters, digits and single hyphens/],
    ['pаypal-help', /letters, digits and single hyphens/], // Cyrillic "а": a homoglyph
    ['my.profile', /letters, digits and single hyphens/],
    ['../admin', /letters, digits and single hyphens/],
  ])('rejects %j as INVALID_ALIAS', (alias, message) => {
    expect(rejection(alias)).toMatchObject({
      code: 'INVALID_ALIAS',
      message: expect.stringMatching(message),
    });
  });

  it.each(['abcdefg', 'launch1', '2026abc', 'ABCDEFG'])(
    'rejects %j: exactly 7 letters/digits is the generated-code shape',
    (alias) => {
      expect(rejection(alias)).toMatchObject({
        code: 'INVALID_ALIAS',
        message: expect.stringContaining('reserved for generated links'),
      });
    },
  );

  it.each(['docs', 'admin', 'health', 'ready', 'login', 'Settings', 'well-known', 'dashboard'])(
    'rejects the reserved word %j',
    (alias) => {
      expect(rejection(alias)).toMatchObject({
        code: 'ALIAS_NOT_ALLOWED',
        message: 'This alias is reserved',
      });
    },
  );

  // Some route names never reach the reserved list: the earlier shape rules
  // already rule them out.
  it.each([
    ['api', '4–32 characters'],
    ['metrics', 'reserved for generated links'],
  ])('%j is blocked by an earlier rule (%s)', (alias, message) => {
    expect(rejection(alias)).toMatchObject({
      code: 'INVALID_ALIAS',
      message: expect.stringContaining(message),
    });
  });

  it.each(['paypal-help', 'apple-id', 'my-google-docs', 'applesupport', 'netflix-tv'])(
    'rejects brand impersonation %j',
    (alias) => {
      expect(rejection(alias)).toMatchObject({
        code: 'ALIAS_NOT_ALLOWED',
        message: expect.stringContaining('brand'),
      });
    },
  );

  it.each(['account-login', 'verify-now', 'reset-password', 'my-wallet', 'signin-here'])(
    'rejects credential bait %j',
    (alias) => {
      expect(rejection(alias)).toMatchObject({
        code: 'ALIAS_NOT_ALLOWED',
        message: expect.stringContaining('sign-in'),
      });
    },
  );
});

describe('isAliasFormat (redirect-path check)', () => {
  it.each(['my-profile', 'abcdefgh', 'my-page'])('%s could be an alias', (value) => {
    expect(isAliasFormat(value)).toBe(true);
  });

  it.each(['abc', 'abcdefg', 'My-Profile', 'my_profile', 'favicon.ico'])(
    '%s cannot (uppercase is lowercased by the caller first)',
    (value) => {
      expect(isAliasFormat(value)).toBe(false);
    },
  );
});

describe('validateExpiry', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  it.each([1, 60_000, 365 * 24 * 3600 * 1000])('accepts %d ms from now', (ms) => {
    expect(() => validateExpiry(at(ms), now)).not.toThrow();
  });

  it.each([
    [0, 'in the future'],
    [-1, 'in the future'],
    [11 * 365 * 24 * 3600 * 1000, 'within 10 years'],
  ])('rejects %d ms from now', (ms, message) => {
    expect(() => validateExpiry(at(ms), now)).toThrow(
      expect.objectContaining({
        code: 'INVALID_EXPIRY',
        message: expect.stringContaining(message),
      }),
    );
  });
});
