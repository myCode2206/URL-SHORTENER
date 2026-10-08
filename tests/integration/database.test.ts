import { Prisma } from '@prisma/client';
import {
  createPrismaClient,
  databaseCheck,
  isDatabaseUnavailableError,
  type Database,
} from '../../src/infrastructure/database/prisma';
import { createLogger } from '../../src/utils/logger';
import { resetDatabase } from '../helpers/database';
import { testConfig } from '../helpers/testApp';

const config = testConfig();
let prisma: Database;

beforeAll(() => {
  prisma = createPrismaClient(config, createLogger(config));
});
beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());

function createUser(email = 'ada@example.com') {
  return prisma.user.create({ data: { email, passwordHash: 'argon2-hash-placeholder' } });
}

function createUrl(data: Partial<Prisma.UrlUncheckedCreateInput> = {}) {
  return prisma.url.create({
    data: {
      shortCode: `c${Math.random().toString(36).slice(2, 9)}`,
      originalUrl: 'https://example.com',
      ...data,
    },
  });
}

async function expectPrismaError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('schema defaults', () => {
  it('gives users a time-ordered UUIDv7 id and timestamps', async () => {
    const user = await createUser();
    // The 13th hex digit of a UUID is its version.
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('assigns increasing database-generated ids to URLs', async () => {
    const first = await createUrl();
    const second = await createUrl();
    expect(first.id).toBe(1n);
    expect(second.id).toBe(2n);
    expect(first).toMatchObject({
      isActive: true,
      clickCount: 0n,
      customAlias: null,
      deletedAt: null,
    });
  });
});

describe('unique constraints', () => {
  it('rejects a duplicate email', async () => {
    await createUser('dup@example.com');
    await expectPrismaError(createUser('dup@example.com'), 'P2002');
  });

  it('rejects a duplicate short code', async () => {
    await createUrl({ shortCode: 'aB7xK2' });
    await expectPrismaError(createUrl({ shortCode: 'aB7xK2' }), 'P2002');
  });

  it('rejects a duplicate custom alias but allows many URLs without one', async () => {
    await createUrl({ customAlias: 'my-profile' });
    await expectPrismaError(createUrl({ customAlias: 'my-profile' }), 'P2002');

    await createUrl();
    await createUrl();
    expect(await prisma.url.count({ where: { customAlias: null } })).toBe(2);
  });

  it('settles a race for the same alias at the database: exactly one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createUrl({ customAlias: 'contested' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('foreign keys', () => {
  it('rejects a URL owned by a user that does not exist', async () => {
    await expectPrismaError(createUrl({ userId: '01920000-0000-7000-8000-000000000000' }), 'P2003');
  });

  it('rejects a click for a URL that does not exist', async () => {
    await expectPrismaError(prisma.click.create({ data: { urlId: 999n } }), 'P2003');
  });

  it('cascades: deleting a user removes their URLs and those URLs’ clicks', async () => {
    const user = await createUser();
    const url = await createUrl({ userId: user.id });
    await prisma.click.createMany({ data: [{ urlId: url.id }, { urlId: url.id }] });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.url.count()).toBe(0);
    expect(await prisma.click.count()).toBe(0);
  });

  it('keeps anonymous URLs (no owner)', async () => {
    const url = await createUrl({ userId: null });
    expect(url.userId).toBeNull();
  });
});

describe('indexes', () => {
  it('has an index behind every hot query', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`;
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));

    expect(defs.urls_short_code_key).toContain('UNIQUE INDEX');
    expect(defs.urls_custom_alias_key).toContain('UNIQUE INDEX');
    expect(defs.users_email_key).toContain('UNIQUE INDEX');
    expect(defs.urls_user_id_created_at_id_idx).toContain('(user_id, created_at DESC, id DESC)');
    expect(defs.clicks_url_id_clicked_at_idx).toContain('(url_id, clicked_at)');
  });

  it('uses the short_code index for redirect lookups', async () => {
    await prisma.$executeRaw`
      INSERT INTO urls (short_code, original_url, updated_at)
      SELECT 'code' || n, 'https://example.com/' || n, now() FROM generate_series(1, 20000) AS n`;
    await prisma.$executeRawUnsafe('ANALYZE urls');

    const plan = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`
      EXPLAIN SELECT original_url FROM urls WHERE short_code = 'code12345'`;
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('urls_short_code_key');
  });
});

describe('readiness check', () => {
  it('reports up against the real database', async () => {
    await expect(databaseCheck(prisma).check()).resolves.toBeUndefined();
  });

  it('fails and is recognised as an outage when the database is unreachable', async () => {
    const unreachable = createPrismaClient(
      testConfig({
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/nothing_test?connect_timeout=2',
      }),
      createLogger(config),
    );
    await expect(databaseCheck(unreachable).check()).rejects.toThrow('unreachable');

    const rawError = await unreachable.$queryRaw`SELECT 1`.then(
      () => null,
      (err: unknown) => err,
    );
    expect(isDatabaseUnavailableError(rawError)).toBe(true);
    await unreachable.$disconnect();
  });
});
