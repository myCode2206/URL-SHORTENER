import type { IdGenerator } from '../../infrastructure/database/idGenerator';
import { normalizeDestinationUrl } from './destinationUrl';
import type { ShortCodeCodec } from './shortCode';
import type { UrlRepository } from './urls.repository';

export interface ShortenedUrl {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  createdAt: Date;
}

export interface UrlServiceDependencies {
  repository: Pick<UrlRepository, 'create'>;
  idGenerator: IdGenerator;
  codec: ShortCodeCodec;
  baseUrl: string;
}

// Business rules for short URLs. Knows nothing about HTTP (no req/res) and
// nothing about SQL, so it can be unit-tested with fakes and reused from a
// worker or CLI.
export class UrlService {
  private readonly ownHostname: string;

  constructor(private readonly deps: UrlServiceDependencies) {
    this.ownHostname = new URL(deps.baseUrl).hostname;
  }

  async shorten(input: { url: string }): Promise<ShortenedUrl> {
    const originalUrl = normalizeDestinationUrl(input.url, this.ownHostname);

    // Reserve the ID first, so the code is known before the row is written.
    // That costs one extra database round trip, but the row is inserted once,
    // complete, instead of being inserted and then updated with its code.
    const id = await this.deps.idGenerator.nextId();
    const shortCode = this.deps.codec.encode(id);
    const url = await this.deps.repository.create({ id, shortCode, originalUrl });

    return {
      shortCode: url.shortCode,
      shortUrl: `${this.deps.baseUrl}/${url.shortCode}`,
      originalUrl: url.originalUrl,
      createdAt: url.createdAt,
    };
  }
}
