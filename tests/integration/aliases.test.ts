import request from 'supertest';
import { resetState } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma, redis } = buildTestApp();
beforeEach(() => resetState({ prisma, redis }));

let n = 0;
async function signUp(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: `alias${++n}@example.com`, password: 'correct horse battery staple' });
  return res.body.data.accessToken as string;
}

const create = (body: object, token?: string) => {
  const req = request(app).post('/api/v1/urls');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
};

describe('custom aliases', () => {
  it('creates a link at the alias and redirects there', async () => {
    const token = await signUp();

    const res = await create(
      { url: 'https://example.com/profile', customAlias: 'my-profile' },
      token,
    );

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      shortUrl: 'http://short.test/my-profile',
      customAlias: 'my-profile',
      shortCode: expect.stringMatching(/^[0-9a-zA-Z]{7}$/),
    });
    const redirect = await request(app).get('/my-profile');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/profile');
  });

  it('is case-insensitive: stored lowercase, reachable in any case', async () => {
    const token = await signUp();
    await create({ url: 'https://example.com', customAlias: 'Launch-Day' }, token);

    for (const path of ['/launch-day', '/LAUNCH-DAY', '/Launch-Day']) {
      expect((await request(app).get(path)).status).toBe(302);
    }
  });

  it('keeps the generated code working too', async () => {
    const token = await signUp();
    const res = await create({ url: 'https://example.com/x', customAlias: 'my-profile' }, token);
    expect((await request(app).get(`/${res.body.data.shortCode}`)).status).toBe(302);
  });

  it('returns 409 when the alias is taken, by anyone, in any case', async () => {
    const alice = await signUp();
    const bob = await signUp();
    await create({ url: 'https://example.com/a', customAlias: 'my-profile' }, alice);

    const res = await create({ url: 'https://example.com/b', customAlias: 'MY-PROFILE' }, bob);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'ALIAS_TAKEN',
      message: 'This alias is already taken',
    });
    expect((await request(app).get('/my-profile')).headers.location).toBe('https://example.com/a');
  });

  it('lets exactly one of several simultaneous claims win', async () => {
    const tokens = await Promise.all([signUp(), signUp(), signUp(), signUp()]);

    const results = await Promise.all(
      tokens.map((t, i) =>
        create({ url: `https://example.com/${i}`, customAlias: 'contested' }, t),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('keeps a deleted link’s alias reserved, so it cannot be hijacked', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const { body } = await create(
      { url: 'https://alice.example', customAlias: 'alice-blog' },
      alice,
    );
    await request(app)
      .delete(`/api/v1/urls/${body.data.shortCode}`)
      .set('Authorization', `Bearer ${alice}`);

    const res = await create({ url: 'https://evil.example', customAlias: 'alice-blog' }, bob);

    expect(res.status).toBe(409);
    expect((await request(app).get('/alice-blog')).status).toBe(404);
  });

  it('requires a signed-in user', async () => {
    const res = await create({ url: 'https://example.com', customAlias: 'my-profile' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(await prisma.url.count()).toBe(0);
  });

  it.each([
    ['ab', 'INVALID_ALIAS'],
    ['my_profile', 'INVALID_ALIAS'],
    ['abcdefg', 'INVALID_ALIAS'], // the generated-code shape
    ['docs', 'ALIAS_NOT_ALLOWED'],
    ['health', 'ALIAS_NOT_ALLOWED'],
    ['paypal-support', 'ALIAS_NOT_ALLOWED'],
    ['verify-account', 'ALIAS_NOT_ALLOWED'],
  ])('rejects %j with 400 %s', async (customAlias, code) => {
    const token = await signUp();
    const res = await create({ url: 'https://example.com', customAlias }, token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await prisma.url.count()).toBe(0);
  });

  it('serves a just-claimed alias even if a miss for it was cached a moment ago', async () => {
    const token = await signUp();
    expect((await request(app).get('/new-campaign')).status).toBe(404); // caches "doesn't exist"

    await create({ url: 'https://example.com/campaign', customAlias: 'new-campaign' }, token);

    expect((await request(app).get('/new-campaign')).status).toBe(302);
  });

  it('disabling an aliased link stops both the alias and the code at once', async () => {
    const token = await signUp();
    const { body } = await create({ url: 'https://example.com', customAlias: 'my-profile' }, token);
    const code = body.data.shortCode as string;
    await request(app).get('/my-profile'); // both paths are cached now
    await request(app).get(`/${code}`);

    await request(app)
      .patch(`/api/v1/urls/${code}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect((await request(app).get('/my-profile')).status).toBe(410);
    expect((await request(app).get(`/${code}`)).status).toBe(410);
  });

  it('is shown in the owner’s list and searchable', async () => {
    const token = await signUp();
    await create({ url: 'https://example.com', customAlias: 'summer-sale' }, token);

    const res = await request(app)
      .get('/api/v1/urls?search=summer')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        customAlias: 'summer-sale',
        shortUrl: 'http://short.test/summer-sale',
      }),
    ]);
  });

  it('is rejected by the database itself if the application rules are bypassed', async () => {
    await expect(prisma.$executeRaw`
      INSERT INTO urls (short_code, original_url, custom_alias, updated_at)
      VALUES ('direct1', 'https://example.com', 'Bad--Alias', now())`).rejects.toThrow(
      /urls_custom_alias_format/,
    );
  });
});

describe('expiration at creation', () => {
  it('redirects until the expiry time, then answers 410 Gone', async () => {
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const res = await create({ url: 'https://example.com/flash', expiresAt });
    expect(res.status).toBe(201);
    expect(res.body.data.expiresAt).toBe(expiresAt);
    const code = res.body.data.shortCode as string;

    expect((await request(app).get(`/${code}`)).status).toBe(302);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Still cached (the cache entry lives far longer), but expiry is checked on
    // every request, so it stops at exactly the right moment.
    expect(await redis.exists(`redirect:v1:${code}`)).toBe(1);
    const after = await request(app).get(`/${code}`);
    expect(after.status).toBe(410);
    expect(after.body.error.code).toBe('URL_EXPIRED');
  });

  it('is available to anonymous users', async () => {
    const res = await create({
      url: 'https://example.com',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ['2020-01-01T00:00:00Z', 'INVALID_EXPIRY'],
    ['2099-01-01T00:00:00Z', 'INVALID_EXPIRY'],
    ['tomorrow', 'VALIDATION_ERROR'],
    ['2027-01-01', 'VALIDATION_ERROR'],
  ])('rejects expiresAt %j', async (expiresAt, code) => {
    const res = await create({ url: 'https://example.com', expiresAt });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('PATCH applies the same expiry rules as creation', async () => {
    const token = await signUp();
    const { body } = await create({ url: 'https://example.com' }, token);

    const res = await request(app)
      .patch(`/api/v1/urls/${body.data.shortCode}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: '2099-01-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('expiresAt must be within 10 years');
  });

  it('works together with an alias', async () => {
    const token = await signUp();
    const res = await create(
      {
        url: 'https://example.com/event',
        customAlias: 'event-2026',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      token,
    );

    expect(res.status).toBe(201);
    expect((await request(app).get('/event-2026')).status).toBe(302);
  });
});
