import jwt from 'jsonwebtoken';
import {
  AccessTokens,
  generateRefreshToken,
  hashRefreshToken,
} from '../../../src/modules/auth/tokens';

const SECRET = 'unit-test-jwt-secret-that-is-long-enough';
const ISSUER = 'https://sho.rt';
const tokens = new AccessTokens({ secret: SECRET, ttlSeconds: 900, issuer: ISSUER });
const USER = '01920000-0000-7000-8000-000000000001';

function expectRejected(token: string, code = 'INVALID_TOKEN') {
  expect(() => tokens.verify(token)).toThrow(expect.objectContaining({ statusCode: 401, code }));
}

describe('AccessTokens', () => {
  it('signs a token that verifies back to the user ID', () => {
    const { accessToken, expiresIn } = tokens.sign(USER);
    expect(expiresIn).toBe(900);
    expect(tokens.verify(accessToken)).toBe(USER);
  });

  it('carries only what it must: subject, type, issuer, audience, timestamps', () => {
    const claims = jwt.decode(tokens.sign(USER).accessToken) as jwt.JwtPayload;
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub', 'typ']);
    expect(claims.exp! - claims.iat!).toBe(900);
  });

  it('rejects an expired token with TOKEN_EXPIRED, so clients know to refresh', () => {
    const expired = jwt.sign({ typ: 'access' }, SECRET, {
      subject: USER,
      issuer: ISSUER,
      audience: 'url-shortener-api',
      expiresIn: -10,
    });
    expectRejected(expired, 'TOKEN_EXPIRED');
  });

  it('rejects a token signed with another secret', () => {
    const forged = new AccessTokens({ secret: 'x'.repeat(40), ttlSeconds: 900, issuer: ISSUER });
    expectRejected(forged.sign(USER).accessToken);
  });

  it('rejects an unsigned token (alg: none)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 900;
    const body = Buffer.from(
      JSON.stringify({ sub: USER, typ: 'access', iss: ISSUER, aud: 'url-shortener-api', exp }),
    ).toString('base64url');
    expectRejected(`${header}.${body}.`);
  });

  it('rejects a token with a tampered payload', () => {
    const [header, , signature] = tokens.sign(USER).accessToken.split('.');
    const otherUser = Buffer.from(JSON.stringify({ sub: 'someone-else', typ: 'access' })).toString(
      'base64url',
    );
    expectRejected(`${header}.${otherUser}.${signature}`);
  });

  it.each([
    ['wrong audience', { audience: 'another-api' }],
    ['wrong issuer', { issuer: 'https://evil.example' }],
  ])('rejects a correctly signed token with the %s', (_label, override) => {
    const token = jwt.sign({ typ: 'access' }, SECRET, {
      subject: USER,
      issuer: ISSUER,
      audience: 'url-shortener-api',
      expiresIn: 900,
      ...override,
    });
    expectRejected(token);
  });

  it('rejects a correctly signed token that is not an access token', () => {
    const token = jwt.sign({ typ: 'refresh' }, SECRET, {
      subject: USER,
      issuer: ISSUER,
      audience: 'url-shortener-api',
      expiresIn: 900,
    });
    expectRejected(token);
  });

  it.each(['', 'garbage', 'a.b.c'])('rejects malformed input %j', (token) => {
    expectRejected(token);
  });
});

describe('refresh tokens', () => {
  it('are 256-bit random, URL-safe strings', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateRefreshToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as a deterministic SHA-256 hex digest, so they can be looked up', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});
