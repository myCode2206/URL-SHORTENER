import { RedirectCache } from '../../../src/modules/urls/redirectCache';
import type { RedirectTarget } from '../../../src/modules/urls/urls.repository';
import { createLogger } from '../../../src/utils/logger';
import { testLoggerConfig } from '../../helpers/silentLogger';

const logger = createLogger(testLoggerConfig);
const OPTIONS = { ttlSeconds: 3600, negativeTtlSeconds: 60 };

// A Map standing in for Redis, recording what was written and with which TTL.
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string, _ex: 'EX', seconds: number) => {
      store.set(key, value);
      ttls.set(key, seconds);
      return Promise.resolve('OK' as const);
    }),
    del: jest.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
  };
}

function brokenRedis() {
  const fail = () => Promise.reject(new Error('Connection is closed.'));
  return { get: jest.fn(fail), set: jest.fn(fail), del: jest.fn(fail) };
}

const target: RedirectTarget = {
  id: 9_007_199_254_740_993n, // larger than Number.MAX_SAFE_INTEGER: must survive as a bigint
  originalUrl: 'https://example.com/a?b=1',
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  isActive: true,
};

describe('RedirectCache', () => {
  it('round-trips a target exactly, including bigint ids and dates', async () => {
    const cache = new RedirectCache(fakeRedis() as never, OPTIONS, logger);

    await cache.set('aB7xK2q', target);

    await expect(cache.get('aB7xK2q')).resolves.toEqual({ hit: true, target });
  });

  it('round-trips a target with no expiry', async () => {
    const cache = new RedirectCache(fakeRedis() as never, OPTIONS, logger);
    await cache.set('aB7xK2q', { ...target, expiresAt: null });
    await expect(cache.get('aB7xK2q')).resolves.toMatchObject({ target: { expiresAt: null } });
  });

  it('reports a miss for unknown codes', async () => {
    const cache = new RedirectCache(fakeRedis() as never, OPTIONS, logger);
    await expect(cache.get('nothing')).resolves.toEqual({ hit: false });
  });

  it('caches "does not exist" as a hit with no target, using the short TTL', async () => {
    const redis = fakeRedis();
    const cache = new RedirectCache(redis as never, OPTIONS, logger);

    await cache.set('aB7xK2q', null);

    await expect(cache.get('aB7xK2q')).resolves.toEqual({ hit: true, target: null });
    expect(redis.ttls.get('redirect:v1:aB7xK2q')).toBe(60);
  });

  it('spreads positive TTLs ±10% so entries created together expire apart', async () => {
    const redis = fakeRedis();
    const cache = new RedirectCache(redis as never, OPTIONS, logger);

    for (let i = 0; i < 200; i++) await cache.set(`code${i}`, target);

    const ttls = [...redis.ttls.values()];
    expect(Math.min(...ttls)).toBeGreaterThanOrEqual(3240);
    expect(Math.max(...ttls)).toBeLessThanOrEqual(3960);
    expect(new Set(ttls).size).toBeGreaterThan(50);
  });

  it('uses a versioned key so the stored format can change safely', async () => {
    const redis = fakeRedis();
    await new RedirectCache(redis as never, OPTIONS, logger).set('aB7xK2q', target);
    expect([...redis.store.keys()]).toEqual(['redirect:v1:aB7xK2q']);
  });

  it('removes an entry on invalidate', async () => {
    const cache = new RedirectCache(fakeRedis() as never, OPTIONS, logger);
    await cache.set('aB7xK2q', target);
    await cache.invalidate('aB7xK2q');
    await expect(cache.get('aB7xK2q')).resolves.toEqual({ hit: false });
  });

  it('treats an unreadable entry as a miss', async () => {
    const redis = fakeRedis();
    redis.store.set('redirect:v1:aB7xK2q', '{not json');
    const cache = new RedirectCache(redis as never, OPTIONS, logger);
    await expect(cache.get('aB7xK2q')).resolves.toEqual({ hit: false });
  });

  describe('when Redis fails', () => {
    const cache = new RedirectCache(brokenRedis(), OPTIONS, logger);

    it('get reports a miss instead of throwing', async () => {
      await expect(cache.get('aB7xK2q')).resolves.toEqual({ hit: false });
    });

    it('set and invalidate resolve instead of throwing', async () => {
      await expect(cache.set('aB7xK2q', target)).resolves.toBeUndefined();
      await expect(cache.invalidate('aB7xK2q')).resolves.toBeUndefined();
    });
  });
});
