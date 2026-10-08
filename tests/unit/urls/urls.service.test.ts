import type { Url } from '@prisma/client';
import { createShortCodeCodec } from '../../../src/modules/urls/shortCode';
import type { NewUrl } from '../../../src/modules/urls/urls.repository';
import { UrlService } from '../../../src/modules/urls/urls.service';
import { AppError } from '../../../src/utils/errors';

// The service is tested with fakes: no database, no HTTP. That isolates the
// business rules and makes these tests fast and deterministic.
function setup() {
  const created: NewUrl[] = [];
  let nextId = 100n;
  const idGenerator = { nextId: jest.fn(() => Promise.resolve(nextId++)) };
  const repository = {
    create: jest.fn((url: NewUrl) => {
      created.push(url);
      return Promise.resolve({ ...url, createdAt: new Date('2026-01-01T00:00:00Z') } as Url);
    }),
  };
  const codec = createShortCodeCodec('service-test-secret-at-least-32-chars!!');
  const service = new UrlService({ repository, idGenerator, codec, baseUrl: 'https://sho.rt' });
  return { service, idGenerator, repository, codec, created };
}

describe('UrlService.shorten', () => {
  it('reserves an ID, encodes it, and stores the normalised URL', async () => {
    const { service, codec, created } = setup();

    const result = await service.shorten({ url: 'HTTPS://Example.com/a' });

    expect(created).toEqual([
      { id: 100n, shortCode: codec.encode(100n), originalUrl: 'https://example.com/a' },
    ]);
    expect(result).toEqual({
      shortCode: codec.encode(100n),
      shortUrl: `https://sho.rt/${codec.encode(100n)}`,
      originalUrl: 'https://example.com/a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('gives each call a new ID and code, even for the same URL', async () => {
    const { service } = setup();
    const first = await service.shorten({ url: 'https://example.com' });
    const second = await service.shorten({ url: 'https://example.com' });
    expect(first.shortCode).not.toBe(second.shortCode);
  });

  it('rejects a bad URL before reserving an ID or writing anything', async () => {
    const { service, idGenerator, repository } = setup();

    await expect(service.shorten({ url: 'http://169.254.169.254/' })).rejects.toBeInstanceOf(
      AppError,
    );
    expect(idGenerator.nextId).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects links back to its own domain', async () => {
    const { service } = setup();
    await expect(service.shorten({ url: 'https://sho.rt/abc1234' })).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });
});
