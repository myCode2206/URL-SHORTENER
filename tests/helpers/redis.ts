// Uses TEST_REDIS_URL if set (as in CI); otherwise REDIS_URL from .env pointed
// at logical database 15. The tests flush their database between cases, so
// database 0, where development data lives, is refused outright.
export const TEST_REDIS_DB = '15';

export function resolveTestRedisUrl(): string {
  const explicit = process.env.TEST_REDIS_URL;
  const source = explicit ?? process.env.REDIS_URL;
  if (!source) throw new Error('Set TEST_REDIS_URL or REDIS_URL to run integration tests');

  const url = new URL(source);
  if (!explicit) url.pathname = `/${TEST_REDIS_DB}`;
  if (url.pathname === '/' || url.pathname === '/0') {
    throw new Error('Refusing to run tests against Redis database 0');
  }
  return url.toString();
}
