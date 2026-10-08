import { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../config/env';
import type { DependencyCheck } from '../../modules/health/health.service';
import type { Logger } from '../../utils/logger';

const SLOW_QUERY_MS = 200;

// One client per process. It holds a connection pool (sized by
// `connection_limit` in DATABASE_URL) that every request shares; opening a new
// Postgres connection per request would cost a TCP and TLS handshake, plus
// authentication, every time.
export function createPrismaClient(config: Config, logger: Logger) {
  const prisma = new PrismaClient({
    datasourceUrl: config.databaseUrl,
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  const log = logger.child({ component: 'prisma' });
  // Parameter values are never logged: they can contain emails and password hashes.
  prisma.$on('query', ({ query, duration }) => {
    if (duration >= SLOW_QUERY_MS) log.warn({ durationMs: duration, query }, 'slow query');
    else log.trace({ durationMs: duration, query }, 'query');
  });
  prisma.$on('warn', ({ message }) => log.warn(message));
  prisma.$on('error', ({ message }) => log.error(message));

  return prisma;
}

export type Database = ReturnType<typeof createPrismaClient>;

export function databaseCheck(prisma: Database): DependencyCheck {
  return {
    name: 'database',
    check: async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err) {
        // The full error is already logged by the client; /ready only needs the gist.
        throw new Error(isDatabaseUnavailableError(err) ? 'unreachable' : 'query failed', {
          cause: err,
        });
      }
    },
  };
}

// Prisma error codes meaning "the database can't be reached right now", as
// opposed to "this query is wrong":
//   P1001 can't reach server   P1002 connection timed out
//   P1008 operation timed out  P1017 server closed the connection
//   P2024 timed out waiting for a free connection in the pool
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

export function isDatabaseUnavailableError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && UNAVAILABLE_CODES.has(err.code))
  );
}
