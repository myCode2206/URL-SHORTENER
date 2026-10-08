import { resolveTestDatabaseUrl } from './helpers/database';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Unit tests don't need a database, so they still run (e.g. in CI) without one.
try {
  process.env.DATABASE_URL = resolveTestDatabaseUrl();
} catch {
  delete process.env.DATABASE_URL;
}
