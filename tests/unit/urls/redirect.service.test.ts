import type { ClickEvent } from '../../../src/modules/analytics/clickEvent';
import { availabilityOf, RedirectService } from '../../../src/modules/urls/redirect.service';
import type { CacheLookup } from '../../../src/modules/urls/redirectCache';
import type { RedirectTarget } from '../../../src/modules/urls/urls.repository';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function target(overrides: Partial<RedirectTarget> = {}): RedirectTarget {
  return {
    id: 7n,
    originalUrl: 'https://example.com/',
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

describe('availabilityOf (expiration logic)', () => {
  it.each([
    ['no expiry', null, 'available'],
    ['expires in 1ms', at(1), 'available'],
    ['expires exactly now', at(0), 'expired'],
    ['expired 1ms ago', at(-1), 'expired'],
    ['expired a year ago', at(-365 * 24 * 3600 * 1000), 'expired'],
  ] as const)('%s → %s', (_label, expiresAt, expected) => {
    expect(availabilityOf(target({ expiresAt }), NOW)).toBe(expected);
  });

  it('reports disabled before expired', () => {
    expect(availabilityOf(target({ isActive: false, expiresAt: at(-1) }), NOW)).toBe('disabled');
  });
});

// By default the cache always misses, so these tests exercise the database path.
function setup(found: RedirectTarget | null = target(), cached: CacheLookup = { hit: false }) {
  const recorded: ClickEvent[] = [];
  const repository = { findRedirectTarget: jest.fn(() => Promise.resolve(found)) };
  const cache = {
    get: jest.fn((_code: string) => Promise.resolve(cached)),
    fill: jest.fn((_code: string, _target: RedirectTarget | null) => Promise.resolve()),
  };
  const clickRecorder = { record: jest.fn((event: ClickEvent) => void recorded.push(event)) };
  const service = new RedirectService({ repository, cache, clickRecorder, now: () => NOW });
  return { service, repository, cache, clickRecorder, recorded };
}

describe('RedirectService.resolve', () => {
  const visit = {
    userAgent: 'Mozilla/5.0',
    referrer: 'https://news.ycombinator.com/',
    countsAsClick: true,
  };

  it('returns the destination and records the click', async () => {
    const { service, recorded } = setup();

    await expect(service.resolve('aB7xK2q', visit)).resolves.toBe('https://example.com/');
    expect(recorded).toEqual([
      {
        urlId: 7n,
        clickedAt: NOW,
        userAgent: 'Mozilla/5.0',
        referrer: 'https://news.ycombinator.com/',
      },
    ]);
  });

  it('does not count HEAD requests as clicks', async () => {
    const { service, clickRecorder } = setup();
    await service.resolve('aB7xK2q', { ...visit, countsAsClick: false });
    expect(clickRecorder.record).not.toHaveBeenCalled();
  });

  it.each(['', 'abc', 'favicon.ico', 'wp-login.php', 'aB7xK2q8', 'aB7-K2q'])(
    'rejects malformed code %j with 404 without querying the database',
    async (code) => {
      const { service, repository } = setup();
      await expect(service.resolve(code, visit)).rejects.toMatchObject({
        statusCode: 404,
        code: 'URL_NOT_FOUND',
      });
      expect(repository.findRedirectTarget).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for a well-formed code that does not exist', async () => {
    const { service } = setup(null);
    await expect(service.resolve('aB7xK2q', visit)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    [{ expiresAt: at(-1) }, 'URL_EXPIRED'],
    [{ isActive: false }, 'URL_DISABLED'],
  ])('returns 410 for %j without recording a click', async (overrides, code) => {
    const { service, clickRecorder } = setup(target(overrides));

    await expect(service.resolve('aB7xK2q', visit)).rejects.toMatchObject({
      statusCode: 410,
      code,
    });
    expect(clickRecorder.record).not.toHaveBeenCalled();
  });
});

describe('RedirectService caching (cache-aside)', () => {
  const visit = { userAgent: null, referrer: null, countsAsClick: true };

  it('serves a cache hit without touching the database', async () => {
    const { service, repository } = setup(null, { hit: true, target: target() });

    await expect(service.resolve('aB7xK2q', visit)).resolves.toBe('https://example.com/');
    expect(repository.findRedirectTarget).not.toHaveBeenCalled();
  });

  it('still records the click for a cache hit', async () => {
    const { service, recorded } = setup(null, { hit: true, target: target({ id: 42n }) });
    await service.resolve('aB7xK2q', visit);
    expect(recorded[0]?.urlId).toBe(42n);
  });

  it('serves a cached "does not exist" as 404 without touching the database', async () => {
    const { service, repository } = setup(target(), { hit: true, target: null });

    await expect(service.resolve('aB7xK2q', visit)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.findRedirectTarget).not.toHaveBeenCalled();
  });

  it('checks expiry on cached entries too', async () => {
    const { service } = setup(null, { hit: true, target: target({ expiresAt: at(-1) }) });
    await expect(service.resolve('aB7xK2q', visit)).rejects.toMatchObject({ statusCode: 410 });
  });

  it('on a miss, reads the database and caches what it found', async () => {
    const { service, repository, cache } = setup(target());

    await service.resolve('aB7xK2q', visit);

    expect(repository.findRedirectTarget).toHaveBeenCalledWith('aB7xK2q');
    expect(cache.fill).toHaveBeenCalledWith('aB7xK2q', target());
  });

  it('on a miss for a missing code, caches the absence', async () => {
    const { service, cache } = setup(null);
    await expect(service.resolve('aB7xK2q', visit)).rejects.toMatchObject({ statusCode: 404 });
    expect(cache.fill).toHaveBeenCalledWith('aB7xK2q', null);
  });

  it('collapses concurrent misses for one code into a single database query', async () => {
    const { service, repository } = setup(target());

    const results = await Promise.all(
      Array.from({ length: 100 }, () => service.resolve('aB7xK2q', visit)),
    );

    expect(results).toHaveLength(100);
    expect(repository.findRedirectTarget).toHaveBeenCalledTimes(1);
  });

  it('does not collapse misses for different codes', async () => {
    const { service, repository } = setup(target());
    await Promise.all([service.resolve('aB7xK2q', visit), service.resolve('zZ9yY8x', visit)]);
    expect(repository.findRedirectTarget).toHaveBeenCalledTimes(2);
  });

  it('never makes the visitor wait for the cache write', async () => {
    const { service, cache } = setup(target());
    cache.fill.mockReturnValue(new Promise(() => {})); // a write that never finishes
    await expect(service.resolve('aB7xK2q', visit)).resolves.toBe('https://example.com/');
  });
});
