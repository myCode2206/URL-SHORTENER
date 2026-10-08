import type { Url } from '@prisma/client';
import type { Database } from '../../infrastructure/database/prisma';

export interface NewUrl {
  id: bigint;
  shortCode: string;
  originalUrl: string;
}

// The only code that knows how URLs are stored. Services call these methods
// and never build queries themselves, so a storage change (a read replica, a
// cache in front, another database) is made here and nowhere else.
export class UrlRepository {
  constructor(private readonly db: Database) {}

  create(url: NewUrl): Promise<Url> {
    return this.db.url.create({ data: url });
  }
}
