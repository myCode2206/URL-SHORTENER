import request from 'supertest';
import { resetState } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma, redis, redirectCache } = buildTestApp();

beforeEach(() => resetState({ prisma, redis }));

let userCounter = 0;
async function signUp(): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: `user${++userCounter}@example.com`, password: 'correct horse battery staple' });
  return { token: res.body.data.accessToken, userId: res.body.data.user.id };
}

async function createLink(token: string, url = 'https://example.com/'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/urls')
    .set('Authorization', `Bearer ${token}`)
    .send({ url });
  return res.body.data.shortCode as string;
}

const authed = (token: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  patch: (path: string, body: object) =>
    request(app).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${token}`),
});

// The short codes on one page of a list response, in order.
function codesOf(res: request.Response): string[] {
  return (res.body.data.items as { shortCode: string }[]).map((item) => item.shortCode);
}

// Follows nextCursor until the end and returns every short code seen, in order.
async function readAllPages(token: string, query: string): Promise<string[]> {
  const codes: string[] = [];
  let cursor: string | null = null;
  do {
    const path = `/api/v1/urls?${query}${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await authed(token).get(path);
    expect(res.status).toBe(200);
    codes.push(...codesOf(res));
    cursor = res.body.data.pageInfo.nextCursor;
  } while (cursor);
  return codes;
}

describe('GET /api/v1/urls (list)', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/urls')).status).toBe(401);
  });

  it('lists only your own links, newest first, with their details', async () => {
    const me = await signUp();
    const other = await signUp();
    const first = await createLink(me.token, 'https://example.com/first');
    const second = await createLink(me.token, 'https://example.com/second');
    await createLink(other.token);
    await request(app).post('/api/v1/urls').send({ url: 'https://anonymous.example' });

    const res = await authed(me.token).get('/api/v1/urls');

    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual([second, first]);
    expect(res.body.data.items[0]).toEqual({
      shortCode: second,
      shortUrl: `http://short.test/${second}`,
      originalUrl: 'https://example.com/second',
      customAlias: null,
      status: 'active',
      isActive: true,
      expiresAt: null,
      clickCount: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(res.body.data.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  it('pages through every link exactly once, even when many share a timestamp', async () => {
    const me = await signUp();
    // 45 links, 15 created in the very same millisecond: only the short_code
    // tie-breaker keeps their order, and therefore the pages, well defined.
    await prisma.$executeRaw`
      INSERT INTO urls (short_code, original_url, user_id, created_at, updated_at)
      SELECT 'code' || lpad(n::text, 3, '0'), 'https://example.com/' || n, ${me.userId}::uuid,
             CASE WHEN n <= 15 THEN timestamptz '2026-01-01 00:00:00' ELSE now() - n * interval '1 minute' END,
             now()
      FROM generate_series(1, 45) AS n`;

    const codes = await readAllPages(me.token, 'limit=7');

    expect(codes).toHaveLength(45);
    expect(new Set(codes).size).toBe(45);
  });

  it('keeps pages stable when new links are created between page requests', async () => {
    const me = await signUp();
    for (let i = 0; i < 5; i++) await createLink(me.token, `https://example.com/${i}`);
    const page1 = await authed(me.token).get('/api/v1/urls?limit=2');
    const seen = codesOf(page1);

    await createLink(me.token, 'https://example.com/new'); // would shift OFFSET-based pages

    const page2 = await authed(me.token).get(
      `/api/v1/urls?limit=2&cursor=${page1.body.data.pageInfo.nextCursor}`,
    );
    const next = codesOf(page2);
    expect(next.some((code: string) => seen.includes(code))).toBe(false);
  });

  it('sorts by click count in either direction', async () => {
    const me = await signUp();
    const codes = [
      await createLink(me.token),
      await createLink(me.token),
      await createLink(me.token),
    ];
    for (const [i, code] of codes.entries()) {
      await prisma.url.update({ where: { shortCode: code }, data: { clickCount: [5, 50, 20][i] } });
    }

    const desc = await readAllPages(me.token, 'sort=clickCount&order=desc&limit=1');
    const asc = await readAllPages(me.token, 'sort=clickCount&order=asc&limit=1');

    expect(desc).toEqual([codes[1], codes[2], codes[0]]);
    expect(asc).toEqual([codes[0], codes[2], codes[1]]);
  });

  it('filters by status', async () => {
    const me = await signUp();
    const active = await createLink(me.token);
    const disabled = await createLink(me.token);
    const expired = await createLink(me.token);
    await prisma.url.update({ where: { shortCode: disabled }, data: { isActive: false } });
    await prisma.url.update({
      where: { shortCode: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    for (const [status, code] of [
      ['active', active],
      ['disabled', disabled],
      ['expired', expired],
    ]) {
      const res = await authed(me.token).get(`/api/v1/urls?status=${status}`);
      expect(codesOf(res)).toEqual([code]);
      expect(res.body.data.items[0].status).toBe(status);
    }
  });

  it('searches destinations case-insensitively, treating % and _ literally', async () => {
    const me = await signUp();
    const sale = await createLink(me.token, 'https://shop.example/Summer-Sale?off=50%25');
    await createLink(me.token, 'https://shop.example/winter');
    await createLink(me.token, 'https://shop.example/a_b');
    await createLink(me.token, 'https://shop.example/axb');

    const bySale = await authed(me.token).get('/api/v1/urls?search=summer-sale');
    const byPercent = await authed(me.token).get(
      `/api/v1/urls?search=${encodeURIComponent('50%')}`,
    );
    const byUnderscore = await authed(me.token).get('/api/v1/urls?search=a_b');
    const byCode = await authed(me.token).get(`/api/v1/urls?search=${sale}`);

    expect(codesOf(bySale)).toEqual([sale]);
    expect(byPercent.body.data.items).toHaveLength(1);
    // Unescaped, "a_b" would also match "axb".
    expect(byUnderscore.body.data.items).toHaveLength(1);
    expect(codesOf(byCode)).toEqual([sale]);
  });

  it('filters by creation date range (from inclusive, to exclusive)', async () => {
    const me = await signUp();
    const codes = [
      await createLink(me.token),
      await createLink(me.token),
      await createLink(me.token),
    ];
    const dates = ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'];
    for (const [i, code] of codes.entries()) {
      await prisma.url.update({
        where: { shortCode: code },
        data: { createdAt: new Date(dates[i]!) },
      });
    }

    const res = await authed(me.token).get(
      '/api/v1/urls?createdFrom=2026-02-01T00:00:00Z&createdTo=2026-03-01T00:00:00Z',
    );

    expect(codesOf(res)).toEqual([codes[1]]);
  });

  it.each([
    ['limit=500', 'VALIDATION_ERROR'],
    ['sortBy=createdAt', 'VALIDATION_ERROR'],
    ['cursor=garbage', 'INVALID_CURSOR'],
  ])('rejects ?%s with 400', async (query, code) => {
    const me = await signUp();
    const res = await authed(me.token).get(`/api/v1/urls?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('rejects a cursor reused with a different sort', async () => {
    const me = await signUp();
    for (let i = 0; i < 3; i++) await createLink(me.token);
    const first = await authed(me.token).get('/api/v1/urls?limit=1');

    const res = await authed(me.token).get(
      `/api/v1/urls?limit=1&sort=clickCount&cursor=${first.body.data.pageInfo.nextCursor}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /api/v1/urls/:shortCode', () => {
  it('returns your link', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    const res = await authed(me.token).get(`/api/v1/urls/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.data.shortCode).toBe(code);
  });

  it('answers 404, not 403, for someone else’s link and for an anonymous one', async () => {
    const me = await signUp();
    const other = await signUp();
    const theirs = await createLink(other.token);
    const anon = (await request(app).post('/api/v1/urls').send({ url: 'https://a.example' })).body
      .data.shortCode;

    for (const code of [theirs, anon, 'zzzzzzz']) {
      const res = await authed(me.token).get(`/api/v1/urls/${code}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('URL_NOT_FOUND');
    }
  });
});

describe('PATCH /api/v1/urls/:shortCode', () => {
  it('disabling stops redirects immediately, even though the link is cached', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    expect((await request(app).get(`/${code}`)).status).toBe(302); // now cached

    const res = await authed(me.token).patch(`/api/v1/urls/${code}`, { isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isActive: false, status: 'disabled' });
    const redirect = await request(app).get(`/${code}`);
    expect(redirect.status).toBe(410);
    expect(redirect.body.error.code).toBe('URL_DISABLED');
  });

  it('re-enabling makes it redirect again', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    await authed(me.token).patch(`/api/v1/urls/${code}`, { isActive: false });

    await authed(me.token).patch(`/api/v1/urls/${code}`, { isActive: true });

    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('sets and clears an expiry', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    const future = new Date(Date.now() + 3_600_000).toISOString();

    const set = await authed(me.token).patch(`/api/v1/urls/${code}`, { expiresAt: future });
    expect(set.body.data.expiresAt).toBe(future);
    expect((await request(app).get(`/${code}`)).status).toBe(302);

    const cleared = await authed(me.token).patch(`/api/v1/urls/${code}`, { expiresAt: null });
    expect(cleared.body.data.expiresAt).toBeNull();
  });

  it.each([
    [{ expiresAt: '2020-01-01T00:00:00Z' }, 'INVALID_EXPIRY'],
    [{}, 'VALIDATION_ERROR'],
    [{ originalUrl: 'https://evil.example' }, 'VALIDATION_ERROR'],
    [{ isActive: 'no' }, 'VALIDATION_ERROR'],
  ])('rejects %j with 400', async (body, code) => {
    const me = await signUp();
    const link = await createLink(me.token);
    const res = await authed(me.token).patch(`/api/v1/urls/${link}`, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('cannot change someone else’s link', async () => {
    const me = await signUp();
    const other = await signUp();
    const theirs = await createLink(other.token);

    const res = await authed(me.token).patch(`/api/v1/urls/${theirs}`, { isActive: false });

    expect(res.status).toBe(404);
    expect((await request(app).get(`/${theirs}`)).status).toBe(302);
  });
});

describe('DELETE /api/v1/urls/:shortCode', () => {
  it('soft-deletes: 204, redirects 404 at once, gone from list and detail', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    await request(app).get(`/${code}`); // cached

    const res = await authed(me.token).delete(`/api/v1/urls/${code}`);

    expect(res.status).toBe(204);
    expect((await request(app).get(`/${code}`)).status).toBe(404);
    expect((await authed(me.token).get(`/api/v1/urls/${code}`)).status).toBe(404);
    expect((await authed(me.token).get('/api/v1/urls')).body.data.items).toHaveLength(0);
    // The row is kept, so its code can never be issued to anyone else.
    expect(await prisma.url.count({ where: { shortCode: code } })).toBe(1);
  });

  it('a second delete is a 404', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    await authed(me.token).delete(`/api/v1/urls/${code}`);
    expect((await authed(me.token).delete(`/api/v1/urls/${code}`)).status).toBe(404);
  });

  it('cannot delete someone else’s link', async () => {
    const me = await signUp();
    const other = await signUp();
    const theirs = await createLink(other.token);

    expect((await authed(me.token).delete(`/api/v1/urls/${theirs}`)).status).toBe(404);
    expect((await request(app).get(`/${theirs}`)).status).toBe(302);
  });
});

describe('cache consistency', () => {
  it('a slow redirect cannot re-cache the old state after a disable', async () => {
    const me = await signUp();
    const code = await createLink(me.token);
    const before = await prisma.url.findUniqueOrThrow({ where: { shortCode: code } });
    await redis.del(`redirect:v1:${code}`); // the slow reader just missed...

    await authed(me.token).patch(`/api/v1/urls/${code}`, { isActive: false });
    // ...and now tries to cache the row it read before the update.
    await redirectCache.fill(code, before);

    expect((await request(app).get(`/${code}`)).status).toBe(410);
  });
});
