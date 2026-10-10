import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { Redis } from 'ioredis';
import type { Database } from '../../src/infrastructure/database/prisma';

// Uses TEST_DATABASE_URL if set (as in CI); otherwise DATABASE_URL from .env with
// "_test" appended to the database name. Refuses any database whose name doesn't
// end in "_test", because the tests delete every row between cases.
export function resolveTestDatabaseUrl(): string {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const explicit = process.env.TEST_DATABASE_URL;
  const source = explicit ?? process.env.DATABASE_URL;
  if (!source) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run integration tests');

  const url = new URL(source);
  if (!explicit && !url.pathname.endsWith('_test')) url.pathname += '_test';
  if (!url.pathname.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${url.pathname.slice(1)}": name must end in _test`,
    );
  }
  return url.toString();
}

export async function resetDatabase(prisma: Database): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE users, refresh_tokens, urls, clicks RESTART IDENTITY CASCADE',
  );
}

// IDs restart at 1 after a reset, so codes repeat across tests. Redis must be
// cleared too, or a test could read the previous test's cached entry.
export async function resetState({ prisma, redis }: { prisma: Database; redis: Redis }) {
  await Promise.all([resetDatabase(prisma), whenRedisReady(redis).then(() => redis.flushdb())]);
}

// The app's client rejects commands until it has connected (no offline queue,
// by design). In production that's a cache miss; tests need a known state.
export async function whenRedisReady(redis: Redis): Promise<void> {
  if (redis.status !== 'ready') await once(redis, 'ready');
}
