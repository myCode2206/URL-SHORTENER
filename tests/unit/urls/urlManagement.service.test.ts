import { decodeCursor } from '../../../src/modules/urls/cursor';
import { UrlManagementService } from '../../../src/modules/urls/urlManagement.service';
import type { OwnedUrl, UrlChanges } from '../../../src/modules/urls/urls.repository';

const NOW = new Date('2026-06-01T12:00:00Z');
const USER = 'user-1';

function owned(overrides: Partial<OwnedUrl> = {}): OwnedUrl {
  return {
    id: 1n,
    shortCode: 'aB7xK2q',
    originalUrl: 'https://example.com/',
    customAlias: null,
    isActive: true,
    expiresAt: null,
    clickCount: 3n,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function setup(rows: OwnedUrl[] = []) {
  const repository = {
    listForOwner: jest.fn(async () => rows),
    findOwned: jest.fn(async (userId: string, code: string) =>
      userId === USER ? (rows.find((r) => r.shortCode === code) ?? null) : null,
    ),
    updateOwned: jest.fn(async (userId: string, code: string, changes: UrlChanges) => {
      const row = userId === USER ? rows.find((r) => r.shortCode === code) : undefined;
      return row ? { ...row, ...changes } : null;
    }),
    softDeleteOwned: jest.fn(
      async (userId: string, code: string) =>
        userId === USER && rows.some((r) => r.shortCode === code),
    ),
  };
  const cache = { set: jest.fn(async () => {}) };
  const service = new UrlManagementService({
    repository,
    cache,
    baseUrl: 'https://sho.rt',
    now: () => NOW,
  });
  return { service, repository, cache };
}

const query = { limit: 2, sort: 'createdAt' as const, order: 'desc' as const };

describe('list', () => {
  it('returns a page and a cursor pointing after its last item when there is more', async () => {
    const rows = [owned({ shortCode: 'a' }), owned({ shortCode: 'b' }), owned({ shortCode: 'c' })];
    const { service, repository } = setup(rows);

    const page = await service.list(USER, query);

    expect(repository.listForOwner).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ limit: 2 }),
    );
    expect(page.items.map((i) => i.shortCode)).toEqual(['a', 'b']);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeCursor(page.pageInfo.nextCursor!, 'createdAt', 'desc')).toMatchObject({
      shortCode: 'b',
      value: '2026-05-01T00:00:00.000Z',
    });
  });

  it('returns no cursor on the last page', async () => {
    const { service } = setup([owned({ shortCode: 'a' })]);
    await expect(service.list(USER, query)).resolves.toMatchObject({
      pageInfo: { hasMore: false, nextCursor: null },
    });
  });

  it('passes a decoded cursor position to the repository', async () => {
    const rows = [owned({ shortCode: 'a' }), owned({ shortCode: 'b' }), owned({ shortCode: 'c' })];
    const { service, repository } = setup(rows);
    const { pageInfo } = await service.list(USER, query);

    await service.list(USER, { ...query, cursor: pageInfo.nextCursor! });

    expect(repository.listForOwner).toHaveBeenLastCalledWith(
      USER,
      expect.objectContaining({ after: expect.objectContaining({ shortCode: 'b' }) }),
    );
  });

  it.each([
    [{}, 'active'],
    [{ isActive: false }, 'disabled'],
    [{ expiresAt: new Date('2026-05-31T00:00:00Z') }, 'expired'],
    [{ expiresAt: new Date('2026-07-01T00:00:00Z') }, 'active'],
  ])('reports status for %j as %s', async (overrides, status) => {
    const { service } = setup([owned(overrides)]);
    const { items } = await service.list(USER, { ...query, limit: 20 });
    expect(items[0]?.status).toBe(status);
  });

  it('shows the alias in shortUrl when the link has one, and never the internal id', async () => {
    const { service } = setup([owned({ customAlias: 'my-profile' })]);
    const [item] = (await service.list(USER, { ...query, limit: 20 })).items;
    expect(item?.shortUrl).toBe('https://sho.rt/my-profile');
    expect(item).not.toHaveProperty('id');
    expect(item?.clickCount).toBe(3);
  });
});

describe('get / update / remove: ownership', () => {
  it.each(['get', 'update', 'remove'] as const)(
    '%s answers 404 for another user’s link, exactly as for a missing one',
    async (method) => {
      const { service } = setup([owned()]);
      const call = (userId: string, code: string) =>
        method === 'get'
          ? service.get(userId, code)
          : method === 'update'
            ? service.update(userId, code, { isActive: false })
            : service.remove(userId, code);

      const notMine = call('someone-else', 'aB7xK2q');
      const missing = call(USER, 'zzzzzzz');

      const expected = { statusCode: 404, code: 'URL_NOT_FOUND' };
      await expect(notMine).rejects.toMatchObject(expected);
      await expect(missing).rejects.toMatchObject(expected);
    },
  );
});

describe('update', () => {
  it('writes the new state to the cache so redirects change immediately', async () => {
    const { service, cache } = setup([owned()]);

    const view = await service.update(USER, 'aB7xK2q', { isActive: false });

    expect(view.status).toBe('disabled');
    expect(cache.set).toHaveBeenCalledWith('aB7xK2q', expect.objectContaining({ isActive: false }));
  });

  it('rejects an expiry in the past without touching the database', async () => {
    const { service, repository } = setup([owned()]);

    await expect(
      service.update(USER, 'aB7xK2q', { expiresAt: new Date('2026-05-31T00:00:00Z') }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_EXPIRY' });
    expect(repository.updateOwned).not.toHaveBeenCalled();
  });

  it('accepts null to remove the expiry', async () => {
    const { service } = setup([owned({ expiresAt: new Date('2026-07-01T00:00:00Z') })]);
    await expect(service.update(USER, 'aB7xK2q', { expiresAt: null })).resolves.toMatchObject({
      expiresAt: null,
    });
  });
});

describe('remove', () => {
  it('caches "does not exist" so redirects 404 immediately', async () => {
    const { service, cache } = setup([owned()]);
    await service.remove(USER, 'aB7xK2q');
    expect(cache.set).toHaveBeenCalledWith('aB7xK2q', null);
  });
});
