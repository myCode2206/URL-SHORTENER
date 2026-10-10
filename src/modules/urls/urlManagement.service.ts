import { AppError } from '../../utils/errors';
import { decodeCursor, encodeCursor, type SortField, type SortOrder } from './cursor';
import { validateExpiry } from './expiry';
import { availabilityOf } from './redirect.service';
import type { RedirectCache } from './redirectCache';
import type { OwnedUrl, UrlChanges, UrlRepository, UrlStatus } from './urls.repository';

// A link as the API shows it to its owner. No internal ID: links are
// identified by their short code everywhere in the API.
export interface UrlView {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  status: UrlStatus;
  isActive: boolean;
  expiresAt: Date | null;
  clickCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListQuery {
  limit: number;
  cursor?: string;
  sort: SortField;
  order: SortOrder;
  status?: UrlStatus;
  search?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface UrlPage {
  items: UrlView[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface UrlManagementDependencies {
  repository: Pick<UrlRepository, 'listForOwner' | 'findOwned' | 'updateOwned' | 'softDeleteOwned'>;
  cache: Pick<RedirectCache, 'set'>;
  baseUrl: string;
  now?: () => Date;
}

// Someone else's link and a link that doesn't exist get the same 404. A 403
// would confirm that the code exists, which lets anyone probe for other
// people's links.
const notFound = () => new AppError(404, 'URL_NOT_FOUND', 'Short URL does not exist');

export class UrlManagementService {
  private readonly now: () => Date;

  constructor(private readonly deps: UrlManagementDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(userId: string, query: ListQuery): Promise<UrlPage> {
    const after = query.cursor ? decodeCursor(query.cursor, query.sort, query.order) : undefined;
    const now = this.now();
    const rows = await this.deps.repository.listForOwner(userId, { ...query, after, now });

    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            sort: query.sort,
            order: query.order,
            value:
              query.sort === 'createdAt'
                ? last.createdAt.toISOString()
                : last.clickCount.toString(),
            shortCode: last.shortCode,
          })
        : null;

    return { items: page.map((url) => this.view(url, now)), pageInfo: { nextCursor, hasMore } };
  }

  async get(userId: string, shortCode: string): Promise<UrlView> {
    const url = await this.deps.repository.findOwned(userId, shortCode);
    if (!url) throw notFound();
    return this.view(url, this.now());
  }

  async update(userId: string, shortCode: string, changes: UrlChanges): Promise<UrlView> {
    const now = this.now();
    if (changes.expiresAt) validateExpiry(changes.expiresAt, now);

    const url = await this.deps.repository.updateOwned(userId, shortCode, changes);
    if (!url) throw notFound();

    // Overwrite the cached entries with the new state, so disabling a link
    // stops redirects at once instead of when the cache entry expires.
    await this.cacheEverywhere(url, url);
    return this.view(url, now);
  }

  async remove(userId: string, shortCode: string): Promise<void> {
    const deleted = await this.deps.repository.softDeleteOwned(userId, shortCode);
    if (!deleted) throw notFound();
    // Cache "doesn't exist", so redirects return 404 immediately.
    await this.cacheEverywhere(deleted, null);
  }

  // A link is reachable by its code and, if it has one, its alias. Both cache
  // entries must change together, or disabling an aliased link would leave the
  // alias redirecting from cache.
  private async cacheEverywhere(
    paths: { shortCode: string; customAlias: string | null },
    state: OwnedUrl | null,
  ): Promise<void> {
    const keys = [paths.shortCode, paths.customAlias].filter((k): k is string => k !== null);
    await Promise.all(keys.map((key) => this.deps.cache.set(key, state)));
  }

  private view(url: OwnedUrl, now: Date): UrlView {
    const availability = availabilityOf(url, now);
    return {
      shortCode: url.shortCode,
      shortUrl: `${this.deps.baseUrl}/${url.customAlias ?? url.shortCode}`,
      originalUrl: url.originalUrl,
      customAlias: url.customAlias,
      status: availability === 'available' ? 'active' : availability,
      isActive: url.isActive,
      expiresAt: url.expiresAt,
      clickCount: Number(url.clickCount),
      createdAt: url.createdAt,
      updatedAt: url.updatedAt,
    };
  }
}
