import { Redis } from 'ioredis';
import type { Config } from '../../config/env';
import type { DependencyCheck } from '../../modules/health/health.service';
import type { Logger } from '../../utils/logger';

// Redis is an accelerator, not a source of truth: every value in it can be
// rebuilt from PostgreSQL. So the client is set up to fail fast rather than
// wait. A redirect that can't reach Redis within a few milliseconds should go
// to the database, not sit in a queue until Redis comes back.
export function createRedisClient(config: Config, logger: Logger): Redis {
  const log = logger.child({ component: 'redis' });

  const redis = new Redis(config.redis.url, {
    // While disconnected, reject commands immediately. The default (queue them
    // until reconnected) would freeze every redirect for the whole outage.
    enableOfflineQueue: false,
    // Don't resend a command that was cut off by a disconnect; the caller has
    // already fallen back to the database.
    maxRetriesPerRequest: 0,
    // A command that takes longer than this counts as a failure (a cache miss).
    commandTimeout: config.redis.commandTimeoutMs,
    connectTimeout: config.redis.connectTimeoutMs,
    // On disconnect, ioredis waits this long for the socket to close before
    // destroying it. A socket that never connected has already closed, so the
    // wait always runs in full; the 2s default only delays shutdown.
    disconnectTimeout: 500,
    // Keep trying to reconnect for as long as the process runs, backing off to
    // one attempt every 2 seconds.
    retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
  });

  // Log changes of state, not every failed reconnect attempt: during an outage
  // that would be one line every 2 seconds per instance.
  let state: 'connecting' | 'up' | 'down' = 'connecting';
  redis.on('ready', () => {
    if (state !== 'up') log.info('redis connected');
    state = 'up';
  });
  redis.on('error', (err) => {
    if (state !== 'down') log.warn({ err }, 'redis unavailable; serving from the database');
    state = 'down';
  });

  return redis;
}

// Reported by /ready but not critical: if Redis is down, the app still serves
// every request from PostgreSQL. Failing readiness here would make the load
// balancer pull every instance at once and turn a cache outage into a full outage.
export function redisCheck(redis: Redis): DependencyCheck {
  return {
    name: 'cache',
    critical: false,
    check: async () => {
      await redis.ping();
    },
  };
}
