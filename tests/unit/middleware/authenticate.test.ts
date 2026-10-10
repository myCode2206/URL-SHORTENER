import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../../src/middleware/authenticate';
import { AccessTokens } from '../../../src/modules/auth/tokens';

const tokens = new AccessTokens({
  secret: 'middleware-test-secret-that-is-long-enough',
  ttlSeconds: 900,
  issuer: 'https://sho.rt',
});
const USER = '01920000-0000-7000-8000-000000000001';

function run(required: boolean, authorization?: string) {
  const req = { get: (name: string) => (name === 'authorization' ? authorization : undefined) };
  const headers: Record<string, string> = {};
  const res = { set: (name: string, value: string) => (headers[name] = value) };
  const next = jest.fn() as jest.MockedFunction<NextFunction>;
  authenticate(tokens, { required })(req as Request, res as unknown as Response, next);
  return { req: req as Request, next, headers, error: next.mock.calls[0]?.[0] as unknown };
}

describe('authenticate middleware', () => {
  it('sets req.auth from a valid bearer token', () => {
    const { req, error } = run(true, `Bearer ${tokens.sign(USER).accessToken}`);
    expect(error).toBeUndefined();
    expect(req.auth).toEqual({ userId: USER });
  });

  it('required: rejects a request without a token, with WWW-Authenticate', () => {
    const { error, headers } = run(true);
    expect(error).toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
    expect(headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('optional: lets an anonymous request through', () => {
    const { req, error } = run(false);
    expect(error).toBeUndefined();
    expect(req.auth).toBeUndefined();
  });

  it('optional: still rejects a bad token rather than treating it as anonymous', () => {
    const { error, headers } = run(false, 'Bearer not.a.jwt');
    expect(error).toMatchObject({ statusCode: 401, code: 'INVALID_TOKEN' });
    expect(headers['WWW-Authenticate']).toContain('invalid_token');
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer a b', 'token-without-scheme'])(
    'rejects a malformed Authorization header %j',
    (header) => {
      expect(run(true, header).error).toMatchObject({ statusCode: 401, code: 'INVALID_TOKEN' });
    },
  );
});
