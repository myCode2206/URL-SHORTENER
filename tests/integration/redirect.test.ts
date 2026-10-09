import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { resetState } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma, redis, redirectCache, clickRecorder } = buildTestApp();

// Edits a row behind the app's back, then invalidates its cache entry, which
// every real write path must also do (Phase 7's update endpoints).
async function updateUrl(shortCode: string, data: Prisma.UrlUpdateInput) {
  await prisma.url.update({ where: { shortCode }, data });
  await redirectCache.invalidate(shortCode);
}

// Write out clicks left over from the previous test before wiping the tables;
// otherwise they'd land on whichever new URL reuses their ID.
beforeEach(async () => {
  await clickRecorder.flush();
  await resetState({ prisma, redis });
});
afterAll(() => prisma.$disconnect());

async function createShortUrl(url = 'https://example.com/landing?utm=1'): Promise<string> {
  const res = await request(app).post('/api/v1/urls').send({ url });
  expect(res.status).toBe(201);
  return res.body.data.shortCode as string;
}

describe('GET /:shortCode', () => {
  it('redirects with 302 to the original URL and is never cached', async () => {
    const code = await createShortUrl();

    const res = await request(app).get(`/${code}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/landing?utm=1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('end to end: create → open short URL → redirected → click recorded', async () => {
    const code = await createShortUrl('https://example.com/article');

    const res = await request(app)
      .get(`/${code}`)
      .set('User-Agent', 'Mozilla/5.0 (Macintosh)')
      .set('Referer', 'https://twitter.com/');
    expect(res.headers.location).toBe('https://example.com/article');

    // Nothing has been written yet: the redirect didn't wait for analytics.
    expect(await prisma.click.count()).toBe(0);

    await clickRecorder.flush();

    const url = await prisma.url.findUniqueOrThrow({ where: { shortCode: code } });
    expect(url.clickCount).toBe(1n);
    const clicks = await prisma.click.findMany({ where: { urlId: url.id } });
    expect(clicks).toEqual([
      expect.objectContaining({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        referrer: 'https://twitter.com/',
      }),
    ]);
  });

  it('counts many clicks across several URLs in one batch', async () => {
    const [a, b] = [
      await createShortUrl('https://a.example'),
      await createShortUrl('https://b.example'),
    ];

    await Promise.all([
      ...Array.from({ length: 30 }, () => request(app).get(`/${a}`)),
      ...Array.from({ length: 12 }, () => request(app).get(`/${b}`)),
    ]);
    await clickRecorder.flush();

    const counts = await prisma.url.findMany({ select: { shortCode: true, clickCount: true } });
    expect(Object.fromEntries(counts.map((u) => [u.shortCode, u.clickCount]))).toEqual({
      [a]: 30n,
      [b]: 12n,
    });
    expect(await prisma.click.count()).toBe(42);
  });

  it('cuts over-long headers to fit their columns instead of losing the click', async () => {
    const code = await createShortUrl();
    await request(app).get(`/${code}`).set('User-Agent', 'x'.repeat(5000));
    await clickRecorder.flush();

    const click = await prisma.click.findFirstOrThrow();
    expect(click.userAgent).toHaveLength(512);
  });

  it('redirects HEAD requests without counting a click', async () => {
    const code = await createShortUrl();

    const res = await request(app).head(`/${code}`);
    await clickRecorder.flush();

    expect(res.status).toBe(302);
    expect(await prisma.click.count()).toBe(0);
  });

  describe('links that cannot be followed', () => {
    it('404 for a well-formed code that does not exist', async () => {
      const res = await request(app).get('/aB7xK2q');

      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'URL_NOT_FOUND',
        message: 'Short URL does not exist',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each(['/favicon.ico', '/robots.txt', '/abc', '/wp-login.php'])(
      '404 for %s',
      async (path) => {
        expect((await request(app).get(path)).status).toBe(404);
      },
    );

    it('410 URL_EXPIRED once the expiry time has passed', async () => {
      const code = await createShortUrl();
      await updateUrl(code, { expiresAt: new Date(Date.now() - 1000) });

      const res = await request(app).get(`/${code}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('URL_EXPIRED');
    });

    it('still redirects before the expiry time', async () => {
      const code = await createShortUrl();
      await updateUrl(code, { expiresAt: new Date(Date.now() + 60_000) });
      expect((await request(app).get(`/${code}`)).status).toBe(302);
    });

    it('410 URL_DISABLED when the owner disabled it', async () => {
      const code = await createShortUrl();
      await updateUrl(code, { isActive: false });

      const res = await request(app).get(`/${code}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('URL_DISABLED');
    });

    it('404 when soft-deleted, indistinguishable from never existing', async () => {
      const code = await createShortUrl();
      await updateUrl(code, { deletedAt: new Date() });

      const res = await request(app).get(`/${code}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('URL_NOT_FOUND');
    });

    it('records no click for expired or disabled links', async () => {
      const code = await createShortUrl();
      await updateUrl(code, { isActive: false });
      await request(app).get(`/${code}`);
      await clickRecorder.flush();
      expect(await prisma.click.count()).toBe(0);
    });
  });

  describe('browsers get an HTML error page', () => {
    it('renders HTML when the client prefers it', async () => {
      const res = await request(app)
        .get('/aB7xK2q')
        .set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<h1>Link not found</h1>');
      expect(res.text).toContain('URL_NOT_FOUND');
    });

    it('keeps JSON for API routes even when HTML is preferred', async () => {
      const res = await request(app)
        .post('/api/v1/urls')
        .set('Accept', 'text/html')
        .send({ url: 'javascript:alert(1)' });
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('routes are not shadowed by /:shortCode', () => {
    it.each(['/health', '/ready', '/docs/openapi.json'])('%s still works', async (path) => {
      expect((await request(app).get(path)).status).toBe(200);
    });
  });
});

describe('reliability', () => {
  it('survives the database killing every connection (failover/restart)', async () => {
    const code = await createShortUrl();
    // Make sure the pool holds an open, idle connection.
    await request(app).get(`/${code}`);

    // What a restart or failover does to each connection, done from a
    // separate connection so the test doesn't kill itself.
    const admin = buildTestApp().prisma;
    await admin.$executeRaw`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    await admin.$disconnect();
    // Let pg receive the server's "terminating connection" message.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await request(app).get(`/${code}`);

    expect(res.status).toBe(302);
  });

  it('returns 503, not a crash, when the database is down', async () => {
    const down = buildTestApp({
      env: { DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/down_test' },
    });

    const res = await request(down.app).get('/aB7xK2q');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    await down.prisma.$disconnect();
  });
});
