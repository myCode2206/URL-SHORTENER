import { AppError } from '../../utils/errors';
import { SingleFlight } from '../../utils/singleFlight';
import type { ClickRecorder } from '../analytics/clickEvent';
import { isAliasFormat } from './alias';
import type { RedirectCache } from './redirectCache';
import { isShortCodeFormat } from './shortCode';
import type { RedirectLookup, RedirectTarget, UrlRepository } from './urls.repository';

export type Availability = 'available' | 'disabled' | 'expired';

// Pure function: same inputs, same answer, no I/O. Expiry is decided here and
// nowhere else, and it's trivial to unit-test at exact boundaries.
export function availabilityOf(target: RedirectTarget, now: Date): Availability {
  if (!target.isActive) return 'disabled';
  // "Expires at 12:00" means 12:00:00.000 is already expired.
  if (target.expiresAt && target.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'available';
}

export interface Visit {
  userAgent: string | null;
  referrer: string | null;
  // False for HEAD requests: link checkers and unfurlers use HEAD, and a
  // request that never loads the page shouldn't count as a click.
  countsAsClick: boolean;
}

export interface RedirectServiceDependencies {
  repository: Pick<UrlRepository, 'findRedirectTarget'>;
  cache: Pick<RedirectCache, 'get' | 'fill'>;
  clickRecorder: ClickRecorder;
  now?: () => Date;
}

const notFound = () => new AppError(404, 'URL_NOT_FOUND', 'Short URL does not exist');

// Decides from its shape alone what a path segment can be:
// - exactly 7 letters/digits: a generated code (case-sensitive: aB7xK2q ≠ AB7XK2Q)
// - otherwise, if it fits the alias rules: an alias, compared in lowercase, so
//   /My-Profile reaches my-profile
// - anything else: can't exist, so it's rejected without any lookup.
// The cache key is the canonical form; the two kinds never collide because
// aliases can never have the generated-code shape.
export function parseRedirectPath(
  segment: string,
): { cacheKey: string; lookup: RedirectLookup } | null {
  if (isShortCodeFormat(segment)) return { cacheKey: segment, lookup: { shortCode: segment } };
  const alias = segment.toLowerCase();
  if (isAliasFormat(alias)) return { cacheKey: alias, lookup: { customAlias: alias } };
  return null;
}

// The hot path: runs on every click, so it does as little as possible.
// 1. Reject paths that can't be a code or an alias, without touching Redis or
//    the database.
// 2. Redis: hit → use it (including a cached "doesn't exist").
//    Miss → one indexed PostgreSQL lookup, then store the result in Redis.
// 3. Check expired/disabled in memory. This runs on cached entries too, so an
//    entry cached before its expiry time still stops redirecting on time.
// 4. Hand the click to the recorder, which returns immediately.
export class RedirectService {
  private readonly now: () => Date;
  private readonly databaseLookups = new SingleFlight<string, RedirectTarget | null>();

  constructor(private readonly deps: RedirectServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async resolve(path: string, visit: Visit): Promise<string> {
    // /favicon.ico, /wp-login.php and random scanner paths stop here.
    const parsed = parseRedirectPath(path);
    if (!parsed) throw notFound();

    const target = await this.findTarget(parsed.cacheKey, parsed.lookup);
    if (!target) throw notFound();

    const now = this.now();
    switch (availabilityOf(target, now)) {
      case 'disabled':
        throw new AppError(410, 'URL_DISABLED', 'This short URL has been disabled by its owner');
      case 'expired':
        throw new AppError(410, 'URL_EXPIRED', 'This short URL has expired');
      case 'available':
        break;
    }

    if (visit.countsAsClick) {
      this.deps.clickRecorder.record({
        urlId: target.id,
        clickedAt: now,
        userAgent: visit.userAgent,
        referrer: visit.referrer,
      });
    }
    return target.originalUrl;
  }

  // Cache-aside: the application reads the cache, and on a miss reads the
  // database and fills the cache itself.
  private async findTarget(
    cacheKey: string,
    lookup: RedirectLookup,
  ): Promise<RedirectTarget | null> {
    const cached = await this.deps.cache.get(cacheKey);
    if (cached.hit) return cached.target;

    // If 1,000 requests miss on the same link at once, they share one query.
    return this.databaseLookups.run(cacheKey, async () => {
      const target = await this.deps.repository.findRedirectTarget(lookup);
      // Not awaited: the visitor shouldn't wait for the cache write. fill()
      // never throws, and never overwrites a value a writer stored meanwhile.
      void this.deps.cache.fill(cacheKey, target);
      return target;
    });
  }
}
