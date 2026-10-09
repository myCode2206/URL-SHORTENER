import request from 'supertest';
import { resetState, whenRedisReady } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma, redis, redirectCache, clickRecorder } = buildTestApp();
const key = (code: string) => `redirect:v1:${code}`;

beforeEach(async () => {
  await clickRecorder.flush();
  await resetState({ prisma, redis });
});

async function createShortUrl(url = 'https://example.com/cached'): Promise<string> {
  const res = await request(app).post('/api/v1/urls').send({ url });
  expect(res.status).toBe(201);
  return res.body.data.shortCode as string;
}

// Remove the row without the app knowing. If a redirect still works after
// this, it must have been served from Redis.
async function deleteRowBehindTheCache(code: string) {
  await prisma.url.delete({ where: { shortCode: code } });
}

describe('Redis redirect cache', () => {
  it('writes new links through to the cache with a jittered TTL near 1 hour', async () => {
    const code = await createShortUrl();

    const ttl = await redis.ttl(key(code));

    expect(await redis.exists(key(code))).toBe(1);
    expect(ttl).toBeGreaterThanOrEqual(3240);
    expect(ttl).toBeLessThanOrEqual(3960);
  });

  it('serves redirects from Redis without querying PostgreSQL', async () => {
    const code = await createShortUrl();
    await deleteRowBehindTheCache(code);

    const res = await request(app).get(`/${code}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/cached');
  });

  it('on a miss, reads PostgreSQL and fills the cache', async () => {
    const code = await createShortUrl();
    await redis.del(key(code));

    expect((await request(app).get(`/${code}`)).status).toBe(302);
    // The cache write isn't awaited by the request; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await redis.exists(key(code))).toBe(1);
  });

  it('caches a missing code for 60s, so repeat requests skip the database', async () => {
    const res = await request(app).get('/aB7xK2q');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(res.status).toBe(404);
    expect(await redis.get(key('aB7xK2q'))).toBe('-');
    expect(await redis.ttl(key('aB7xK2q'))).toBeLessThanOrEqual(60);
  });

  it('invalidation makes the next redirect see the database again', async () => {
    const code = await createShortUrl();
    await deleteRowBehindTheCache(code);
    expect((await request(app).get(`/${code}`)).status).toBe(302); // stale, from cache

    await redirectCache.invalidate(code);

    expect((await request(app).get(`/${code}`)).status).toBe(404);
  });

  it('still enforces expiry on an entry cached before the link expired', async () => {
    const code = await createShortUrl();
    const row = await prisma.url.findUniqueOrThrow({ where: { shortCode: code } });
    await redirectCache.set(code, {
      id: row.id,
      originalUrl: row.originalUrl,
      expiresAt: new Date(Date.now() - 1),
      isActive: true,
    });

    const res = await request(app).get(`/${code}`);

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('URL_EXPIRED');
  });

  it('still counts clicks that are served from the cache', async () => {
    const code = await createShortUrl();

    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);
    await clickRecorder.flush();

    const row = await prisma.url.findUniqueOrThrow({ where: { shortCode: code } });
    expect(row.clickCount).toBe(2n);
  });
});

describe('when Redis is unavailable', () => {
  // Nothing listens on port 1: every Redis command fails immediately.
  const down = buildTestApp({
    env: { REDIS_URL: 'redis://localhost:1/15' },
    realHealth: true,
  });

  beforeEach(() => resetState({ prisma, redis }));

  it('still creates and redirects, falling back to PostgreSQL', async () => {
    const created = await request(down.app)
      .post('/api/v1/urls')
      .send({ url: 'https://example.com/no-cache' });
    expect(created.status).toBe(201);

    const res = await request(down.app).get(`/${created.body.data.shortCode}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/no-cache');
  });

  it('answers quickly instead of waiting for Redis', async () => {
    const created = await request(down.app)
      .post('/api/v1/urls')
      .send({ url: 'https://example.com' });
    const started = performance.now();
    await request(down.app).get(`/${created.body.data.shortCode}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('stays ready (traffic keeps flowing) but reports degraded', async () => {
    const res = await request(down.app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      degraded: true,
      checks: {
        database: { status: 'up', critical: true },
        cache: { status: 'down', critical: false },
      },
    });
  });
});

describe('readiness with everything up', () => {
  it('reports both dependencies up and not degraded', async () => {
    const healthy = buildTestApp({ realHealth: true });
    // A brand-new client reports the cache as down until it has connected.
    await whenRedisReady(healthy.redis);

    const res = await request(healthy.app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      degraded: false,
      checks: { database: { status: 'up' }, cache: { status: 'up' } },
    });
  });
});
