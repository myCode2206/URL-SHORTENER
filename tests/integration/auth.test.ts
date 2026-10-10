import jwt from 'jsonwebtoken';
import request from 'supertest';
import { resetState } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma, redis } = buildTestApp();
beforeEach(() => resetState({ prisma, redis }));

const credentials = { email: 'ada@example.com', password: 'correct horse battery staple' };

const register = (body: object = credentials) =>
  request(app).post('/api/v1/auth/register').send(body);
const login = (body: object = credentials) => request(app).post('/api/v1/auth/login').send(body);

// Every Set-Cookie header on a response (none, one or several).
function setCookies(res: request.Response): string[] {
  return ([] as string[]).concat(res.headers['set-cookie'] ?? []);
}

// The value of the refresh_token cookie from a response, or undefined.
function refreshCookie(res: request.Response): string | undefined {
  const cookie = setCookies(res).find((c) => c.startsWith('refresh_token='));
  return cookie?.split(';')[0]?.slice('refresh_token='.length) || undefined;
}

const refresh = (token: string) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', `refresh_token=${token}`);
const me = (accessToken: string) =>
  request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);

describe('POST /api/v1/auth/register', () => {
  it('creates the account and returns an access token plus a refresh cookie', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      user: { id: expect.any(String), email: 'ada@example.com', createdAt: expect.any(String) },
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    expect(res.body.data).not.toHaveProperty('refreshToken');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets the refresh cookie HttpOnly, SameSite=Strict and scoped to /api/v1/auth', async () => {
    const res = await register();
    const cookie = setCookies(res)[0]!;

    expect(cookie).toMatch(/^refresh_token=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toMatch(/Expires=/);
  });

  it('stores an Argon2id hash in the database, never the password or the raw refresh token', async () => {
    const res = await register();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const stored = await prisma.refreshToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(refreshCookie(res));
  });

  it('normalises the email: case and surrounding spaces do not create a second account', async () => {
    await register();
    const res = await register({ ...credentials, email: '  ADA@Example.COM ' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('lets exactly one of several simultaneous sign-ups for one email succeed', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register()));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });

  it.each([
    [{ email: 'not-an-email', password: credentials.password }, 'email'],
    [{ email: credentials.email, password: 'too short' }, 'password'],
    [{ email: credentials.email, password: 'x'.repeat(129) }, 'password'],
    [{ email: credentials.email }, 'password'],
  ])('rejects invalid input %j', async (body, field) => {
    const res = await register(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe(field);
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(() => register());

  it('logs in with the right password', async () => {
    const res = await login({ ...credentials, email: 'ADA@example.com' });

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toBeDefined();
    expect((await me(res.body.data.accessToken)).body.data.email).toBe('ada@example.com');
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const wrongPassword = await login({ ...credentials, password: 'not the right password' });
    const unknownEmail = await login({ ...credentials, email: 'nobody@example.com' });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
      });
      expect(refreshCookie(res)).toBeUndefined();
    }
  });

  it('takes about as long for an unknown email as for a wrong password', async () => {
    const time = async (body: object) => {
      const started = performance.now();
      await login(body);
      return performance.now() - started;
    };
    const median = async (body: object) => {
      const samples = [];
      for (let i = 0; i < 5; i++) samples.push(await time(body));
      return samples.sort((a, b) => a - b)[2]!;
    };

    const wrongPassword = await median({ ...credentials, password: 'not the right password' });
    const unknownEmail = await median({ ...credentials, email: 'nobody@example.com' });

    // Without the equaliser, an unknown email returns in ~1ms instead of ~15ms.
    expect(unknownEmail).toBeGreaterThan(wrongPassword * 0.5);
  });
});

describe('access tokens', () => {
  it('opens protected routes', async () => {
    const { body } = await register();
    const res = await me(body.data.accessToken);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(body.data.user);
  });

  it('rejects requests without a token with 401 and WWW-Authenticate', async () => {
    const res = await request(app).get('/api/v1/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const { body } = await register();
    const claims = jwt.decode(body.data.accessToken) as jwt.JwtPayload;
    const expired = jwt.sign(
      { typ: 'access', exp: Math.floor(Date.now() / 1000) - 1 },
      process.env.JWT_ACCESS_SECRET!,
      { subject: claims.sub, issuer: claims.iss, audience: 'url-shortener-api' },
    );

    const res = await me(expired);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 404 when the token is valid but the account was deleted', async () => {
    const { body } = await register();
    await prisma.user.delete({ where: { id: body.data.user.id } });

    expect((await me(body.data.accessToken)).status).toBe(404);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates: returns a new access token and replaces the refresh cookie', async () => {
    const first = refreshCookie(await register())!;

    const res = await refresh(first);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const second = refreshCookie(res);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await me(res.body.data.accessToken)).status).toBe(200);
  });

  it('detects a stolen token being reused and revokes the whole session', async () => {
    const stolen = refreshCookie(await register())!;
    const ownersNext = refreshCookie(await refresh(stolen))!; // the owner refreshes

    const attacker = await refresh(stolen); // attacker replays the old token

    expect(attacker.status).toBe(401);
    expect(attacker.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    // The owner's current token is now dead too; they must log in again.
    expect((await refresh(ownersNext)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('lets exactly one of two simultaneous uses of the same token win', async () => {
    const token = refreshCookie(await register())!;

    const results = await Promise.all([refresh(token), refresh(token)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects a request without a cookie, and clears any cookie on failure', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');

    expect(res.status).toBe(401);
    expect(setCookies(res)[0]).toMatch(/^refresh_token=;.*Expires=Thu, 01 Jan 1970/);
  });

  it('rejects an expired refresh token', async () => {
    const token = refreshCookie(await register())!;
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await refresh(token)).status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session, clears the cookie and returns 204', async () => {
    const token = refreshCookie(await register())!;

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `refresh_token=${token}`);

    expect(res.status).toBe(204);
    expect(setCookies(res)[0]).toMatch(/^refresh_token=;/);
    expect((await refresh(token)).status).toBe(401);
  });

  it('succeeds without a cookie (idempotent)', async () => {
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
  });

  it('ends only that session: other devices stay signed in', async () => {
    const laptop = refreshCookie(await register())!;
    const phone = refreshCookie(await login())!;

    await request(app).post('/api/v1/auth/logout').set('Cookie', `refresh_token=${laptop}`);

    expect((await refresh(phone)).status).toBe(200);
  });
});

describe('URL ownership', () => {
  it('records the signed-in user as the owner of a new short URL', async () => {
    const { body } = await register();

    const res = await request(app)
      .post('/api/v1/urls')
      .set('Authorization', `Bearer ${body.data.accessToken}`)
      .send({ url: 'https://example.com/mine' });

    expect(res.status).toBe(201);
    const url = await prisma.url.findUniqueOrThrow({
      where: { shortCode: res.body.data.shortCode },
    });
    expect(url.userId).toBe(body.data.user.id);
  });

  it('still allows anonymous shortening, with no owner', async () => {
    const res = await request(app).post('/api/v1/urls').send({ url: 'https://example.com/anon' });

    expect(res.status).toBe(201);
    const url = await prisma.url.findUniqueOrThrow({
      where: { shortCode: res.body.data.shortCode },
    });
    expect(url.userId).toBeNull();
  });

  it('rejects a bad token instead of silently creating an anonymous link', async () => {
    const res = await request(app)
      .post('/api/v1/urls')
      .set('Authorization', 'Bearer not.a.token')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(401);
    expect(await prisma.url.count()).toBe(0);
  });
});
