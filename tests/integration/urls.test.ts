import request from 'supertest';
import { createShortCodeCodec } from '../../src/modules/urls/shortCode';
import { resetDatabase } from '../helpers/database';
import { buildTestApp } from '../helpers/testApp';

const { app, prisma } = buildTestApp();
const codec = createShortCodeCodec(process.env.SHORT_CODE_SECRET!);

beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());

const shorten = (body: unknown) =>
  request(app)
    .post('/api/v1/urls')
    .send(body as object);

describe('POST /api/v1/urls', () => {
  it('creates a short URL and returns 201', async () => {
    const res = await shorten({ url: 'https://Example.com/very/long/url?ref=1' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      data: {
        shortCode: expect.stringMatching(/^[0-9a-zA-Z]{7}$/),
        shortUrl: `http://short.test/${res.body.data.shortCode}`,
        originalUrl: 'https://example.com/very/long/url?ref=1',
        createdAt: expect.any(String),
      },
    });
  });

  it('stores the row with the code derived from its database ID', async () => {
    const res = await shorten({ url: 'https://example.com' });
    const { shortCode } = res.body.data;

    const row = await prisma.url.findUniqueOrThrow({ where: { shortCode } });
    expect(row.id).toBe(1n);
    expect(codec.decode(shortCode)).toBe(row.id);
    expect(row).toMatchObject({
      originalUrl: 'https://example.com/',
      userId: null,
      isActive: true,
    });
  });

  it('gives every request a unique code, even under concurrency', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => shorten({ url: `https://example.com/${i % 5}` })),
    );

    expect(responses.every((res) => res.status === 201)).toBe(true);
    const codes = new Set(responses.map((res) => res.body.data.shortCode as string));
    expect(codes.size).toBe(50);
    expect(await prisma.url.count()).toBe(50);
  });

  it('trims surrounding whitespace from the URL', async () => {
    const res = await shorten({ url: '  https://example.com/x  ' });
    expect(res.body.data.originalUrl).toBe('https://example.com/x');
  });

  describe('rejects invalid input with 400', () => {
    it.each([
      [{}, 'url'],
      [{ url: '' }, 'url'],
      [{ url: 42 }, 'url'],
      [{ url: 'https://example.com', ulr: 'typo' }, 'ulr'],
    ])('schema violation %j → VALIDATION_ERROR', async (body, field) => {
      const res = await shorten(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe(field);
    });

    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'javascript:alert(1)',
      'http://localhost:3000',
      'http://short.test/abc1234',
    ])('disallowed URL %s → INVALID_URL', async (url) => {
      const res = await shorten({ url });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_URL', message: expect.any(String) });
    });

    it('a request without a JSON body', async () => {
      const res = await request(app).post('/api/v1/urls').type('text').send('https://example.com');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('writes nothing to the database', async () => {
      await shorten({ url: 'http://10.0.0.1' });
      expect(await prisma.url.count()).toBe(0);
    });
  });

  it('returns 503 with Retry-After when the database is down', async () => {
    const down = buildTestApp({
      env: { DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/down_test?connect_timeout=2' },
    });

    const res = await request(down.app).post('/api/v1/urls').send({ url: 'https://example.com' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    await down.prisma.$disconnect();
  });
});

describe('API documentation', () => {
  it('serves an OpenAPI 3.1 document generated from the Zod schemas', async () => {
    const res = await request(app).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/api/v1/urls'].post.responses).toHaveProperty('201');
    expect(res.body.components.schemas.CreateUrlRequest).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', maxLength: 2048 } },
    });
  });

  it('serves Swagger UI', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
