import { existsSync } from 'node:fs';
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
  await prisma.$executeRawUnsafe('TRUNCATE users, urls, clicks RESTART IDENTITY CASCADE');
}
