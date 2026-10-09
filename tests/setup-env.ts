import { resolveTestDatabaseUrl } from './helpers/database';
import { resolveTestRedisUrl } from './helpers/redis';

// Set before .env is loaded; values that are already set are not overwritten.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.BASE_URL = 'http://short.test';
process.env.SHORT_CODE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

// Unit tests don't need a database or Redis, so they still run (e.g. in CI)
// without either. resolveTestDatabaseUrl also loads .env.
try {
  process.env.DATABASE_URL = resolveTestDatabaseUrl();
} catch {
  delete process.env.DATABASE_URL;
}
try {
  process.env.REDIS_URL = resolveTestRedisUrl();
} catch {
  delete process.env.REDIS_URL;
}
