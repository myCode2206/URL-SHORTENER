import type { ClickEvent } from '../../../src/modules/analytics/clickEvent';
import { availabilityOf, RedirectService } from '../../../src/modules/urls/redirect.service';
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

describe('RedirectService.resolve', () => {
  function setup(found: RedirectTarget | null = target()) {
    const recorded: ClickEvent[] = [];
    const repository = { findRedirectTarget: jest.fn(() => Promise.resolve(found)) };
    const clickRecorder = { record: jest.fn((event: ClickEvent) => void recorded.push(event)) };
    const service = new RedirectService({ repository, clickRecorder, now: () => NOW });
    return { service, repository, clickRecorder, recorded };
  }

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
