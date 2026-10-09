import type { Redis } from 'ioredis';
import type { Logger } from '../../utils/logger';
import type { RedirectTarget } from './urls.repository';

export type CacheLookup = { hit: false } | { hit: true; target: RedirectTarget | null };

export interface RedirectCacheOptions {
  ttlSeconds: number;
  negativeTtlSeconds: number;
}

// The version in the key prefix lets the cached shape change safely: bump it
// and new code ignores old entries, which simply expire.
const KEY_PREFIX = 'redirect:v1:';
// Stored for codes that don't exist ("negative caching"), so repeated requests
// for a missing code don't each reach the database.
const MISSING = '-';
const MISS: CacheLookup = { hit: false };
const FAILURE_LOG_INTERVAL_MS = 10_000;

// Short field names: this JSON is stored once per cached link.
interface Stored {
  id: string;
  url: string;
  exp: number | null;
  on: boolean;
}

// Cache-aside cache for redirect targets, keyed by short code.
//
// Every method swallows Redis errors. A broken cache must behave like an empty
// cache: callers fall back to PostgreSQL and never see an exception.
export class RedirectCache {
  private lastFailureLog = 0;
  private suppressedFailures = 0;

  constructor(
    private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>,
    private readonly options: RedirectCacheOptions,
    private readonly logger: Logger,
  ) {}

  async get(shortCode: string): Promise<CacheLookup> {
    try {
      const raw = await this.redis.get(KEY_PREFIX + shortCode);
      if (raw === null) return MISS;
      if (raw === MISSING) return { hit: true, target: null };
      return { hit: true, target: deserialize(raw) };
    } catch (err) {
      // Includes timeouts and unparseable entries: both are treated as a miss.
      this.reportFailure('get', err);
      return MISS;
    }
  }

  // Stores a found target, or remembers that the code doesn't exist.
  async set(shortCode: string, target: RedirectTarget | null): Promise<void> {
    try {
      if (target) {
        await this.redis.set(KEY_PREFIX + shortCode, serialize(target), 'EX', this.jitteredTtl());
      } else {
        await this.redis.set(
          KEY_PREFIX + shortCode,
          MISSING,
          'EX',
          this.options.negativeTtlSeconds,
        );
      }
    } catch (err) {
      this.reportFailure('set', err);
    }
  }

  // Called after a link changes (disabled, deleted, expiry edited) so the next
  // redirect reads the new state from the database. Phases 7 and 8 use it.
  async invalidate(shortCode: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + shortCode);
    } catch (err) {
      // Worse than a failed read: the old entry stays until its TTL expires.
      // The TTL is what bounds how long a link can be stale.
      this.logger.error(
        { err, shortCode },
        'cache invalidation failed; entry may be stale until TTL',
      );
    }
  }

  // ±10% randomness on the TTL. Links created in a burst (a marketing
  // campaign) would otherwise all expire in the same second and send a spike
  // of misses to the database together.
  private jitteredTtl(): number {
    const { ttlSeconds } = this.options;
    return Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
  }

  // During an outage every request fails here; one log line every 10s is
  // enough. The client itself logs when the connection goes down and comes back.
  private reportFailure(operation: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLog < FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailures++;
      return;
    }
    this.logger.warn(
      { err, operation, suppressedSinceLastLog: this.suppressedFailures },
      'cache operation failed; falling back to the database',
    );
    this.lastFailureLog = now;
    this.suppressedFailures = 0;
  }
}

function serialize(target: RedirectTarget): string {
  const stored: Stored = {
    id: target.id.toString(),
    url: target.originalUrl,
    exp: target.expiresAt?.getTime() ?? null,
    on: target.isActive,
  };
  return JSON.stringify(stored);
}

function deserialize(raw: string): RedirectTarget {
  const stored = JSON.parse(raw) as Stored;
  return {
    id: BigInt(stored.id),
    originalUrl: stored.url,
    expiresAt: stored.exp === null ? null : new Date(stored.exp),
    isActive: stored.on,
  };
}
