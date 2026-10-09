import type { Url } from '@prisma/client';
import type { Database } from '../../infrastructure/database/prisma';

export interface NewUrl {
  id: bigint;
  shortCode: string;
  originalUrl: string;
}

// Everything a redirect needs, and nothing more. Phase 5 caches exactly this
// shape in Redis, so it is kept small.
export interface RedirectTarget {
  id: bigint;
  originalUrl: string;
  expiresAt: Date | null;
  isActive: boolean;
}

// The only code that knows how URLs are stored. Services call these methods
// and never build queries themselves, so a storage change (a read replica, a
// cache in front, another database) is made here and nowhere else.
export class UrlRepository {
  constructor(private readonly db: Database) {}

  create(url: NewUrl): Promise<Url> {
    return this.db.url.create({ data: url });
  }

  // One lookup on the unique short_code index. Soft-deleted URLs are filtered
  // out here, so to the redirect path they are indistinguishable from codes
  // that never existed.
  findRedirectTarget(shortCode: string): Promise<RedirectTarget | null> {
    return this.db.url.findUnique({
      where: { shortCode, deletedAt: null },
      select: { id: true, originalUrl: true, expiresAt: true, isActive: true },
    });
  }
}
