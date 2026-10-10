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

  // Two ways to write, and the difference matters:
  //
  // fill: used by the read path after a cache miss. Writes only if the key is
  //   absent (SET NX), so it can never overwrite a newer value.
  // set:  used by write paths (create, update, delete). Always overwrites.
  //
  // Together they close the classic cache-aside race, where a slow reader
  // caches the old row just after a writer has updated it:
  //
  //   reader: miss → reads OLD row ────────────────────┐
  //   writer:          updates row → set(NEW)          │
  //   reader:                              fill(OLD) ← NX: key exists, ignored
  //
  // With "delete on write" instead, the reader's late write would succeed and
  // a disabled link could keep redirecting for the rest of the TTL.
  async fill(shortCode: string, target: RedirectTarget | null): Promise<void> {
    await this.write('fill', shortCode, target, true);
  }

  async set(shortCode: string, target: RedirectTarget | null): Promise<void> {
    await this.write('set', shortCode, target, false);
  }

  // Removes an entry outright; the next redirect reads PostgreSQL.
  async invalidate(shortCode: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + shortCode);
    } catch (err) {
      // The old entry stays until its TTL expires; the TTL bounds how stale it gets.
      this.logger.error(
        { err, shortCode },
        'cache invalidation failed; entry may be stale until TTL',
      );
    }
  }

  // A found target, or a marker that the code doesn't exist (negative caching).
  private async write(
    operation: 'fill' | 'set',
    shortCode: string,
    target: RedirectTarget | null,
    onlyIfAbsent: boolean,
  ): Promise<void> {
    const value = target ? serialize(target) : MISSING;
    const ttl = target ? this.jitteredTtl() : this.options.negativeTtlSeconds;
    try {
      if (onlyIfAbsent) await this.redis.set(KEY_PREFIX + shortCode, value, 'EX', ttl, 'NX');
      else await this.redis.set(KEY_PREFIX + shortCode, value, 'EX', ttl);
    } catch (err) {
      if (operation === 'set') {
        // A failed overwrite can leave the previous state cached (for example
        // a link that was just disabled) until its TTL expires.
        this.logger.error({ err, shortCode }, 'cache update failed; entry may be stale until TTL');
      } else {
        this.reportFailure(operation, err);
      }
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
