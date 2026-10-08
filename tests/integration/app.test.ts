import request from 'supertest';
import { createPrismaClient, databaseCheck } from '../../src/infrastructure/database/prisma';
import { createLogger } from '../../src/utils/logger';
import { buildTestApp, testConfig } from '../helpers/testApp';

describe('GET /health', () => {
  it('returns liveness information', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: 'test-version' });
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('stays healthy even when a dependency is down', async () => {
    const { app } = buildTestApp({
      checks: [{ name: 'database', check: () => Promise.reject(new Error('down')) }],
    });
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('GET /ready', () => {
  it('returns 200 when all dependencies are up', async () => {
    const { app } = buildTestApp({
      checks: [{ name: 'database', check: () => Promise.resolve() }],
    });
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database.status).toBe('up');
  });

  it('returns 503 when a dependency is down', async () => {
    const { app } = buildTestApp({
      checks: [{ name: 'database', check: () => Promise.reject(new Error('ECONNREFUSED')) }],
    });
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.database).toMatchObject({ status: 'down', error: 'ECONNREFUSED' });
  });

  it('returns 503 while shutting down', async () => {
    const { app, health } = buildTestApp();
    health.markShuttingDown();
    expect((await request(app).get('/ready')).status).toBe(503);
  });
});

describe('GET /ready with PostgreSQL', () => {
  function clientFor(databaseUrl?: string) {
    const config = testConfig(databaseUrl ? { DATABASE_URL: databaseUrl } : {});
    return createPrismaClient(config, createLogger(config));
  }

  it('is ready when the real database answers', async () => {
    const prisma = clientFor();
    const { app } = buildTestApp({ checks: [databaseCheck(prisma)] });

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.checks.database).toMatchObject({ status: 'up' });
    await prisma.$disconnect();
  });

  it('returns 503, not a crash, when the database is unreachable', async () => {
    const prisma = clientFor('postgresql://user:pass@127.0.0.1:1/down_test?connect_timeout=2');
    const { app } = buildTestApp({ checks: [databaseCheck(prisma)] });

    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.checks.database).toMatchObject({ status: 'down', error: 'unreachable' });
    await prisma.$disconnect();
  });
});

describe('request IDs', () => {
  it('generates an ID and returns it in the response header', async () => {
    const res = await request(app()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed ID from upstream', async () => {
    const res = await request(app()).get('/health').set('X-Request-Id', 'from-nginx-123');
    expect(res.headers['x-request-id']).toBe('from-nginx-123');
  });

  it.each(['has spaces <script>', 'x'.repeat(129)])(
    'replaces a malformed or oversized upstream ID',
    async (incoming) => {
      const res = await request(app()).get('/health').set('X-Request-Id', incoming);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe('error handling', () => {
  it('returns the standard error format for unknown routes', async () => {
    const res = await request(app()).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Cannot GET /does-not-exist',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app())
      .post('/anything')
      .set('Content-Type', 'application/json')
      .send('{"url": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over 10kb with 413', async () => {
    const res = await request(app())
      .post('/anything')
      .send({ data: 'x'.repeat(11 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

function app() {
  return buildTestApp().app;
}
