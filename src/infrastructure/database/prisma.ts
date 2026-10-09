import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../config/env';
import type { DependencyCheck } from '../../modules/health/health.service';
import type { Logger } from '../../utils/logger';

const SLOW_QUERY_MS = 200;

// One client per process. Connections come from a node-postgres (pg) pool via
// Prisma's driver adapter, rather than from Prisma's built-in pool.
//
// Why: when Postgres restarts or fails over (an RDS failover, a maintenance
// restart), every pooled connection dies. Measured on this project, Prisma's
// built-in pool kept handing out dead connections for ~10 seconds, failing
// every query. pg notices the server closing an idle connection straight away
// and drops it, so the first query after the database returns succeeds.
export function createPrismaClient(config: Config, logger: Logger) {
  const log = logger.child({ component: 'prisma' });
  const { max, connectTimeoutMs, statementTimeoutMs } = config.databasePool;

  const adapter = new PrismaPg(
    {
      connectionString: config.databaseUrl,
      max,
      connectionTimeoutMillis: connectTimeoutMs,
      statement_timeout: statementTimeoutMs,
    },
    {
      // Idle connections dropped by the server (restart, failover, network).
      // pg removes them from the pool; these are informational.
      onPoolError: (err) => log.warn({ err }, 'idle database connection closed'),
      onConnectionError: (err) => log.warn({ err }, 'database connection error'),
    },
  );

  const prisma = new PrismaClient({
    adapter,
    // No 'error' listener: a failed query is either expected and handled (a
    // unique violation becomes a 409) or reaches the error handler, which logs
    // it once with the request ID. Logging it here too doubled every line.
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
    ],
  });

  // Parameter values are never logged: they can contain emails and password hashes.
  prisma.$on('query', ({ query, duration }) => {
    if (duration >= SLOW_QUERY_MS) log.warn({ durationMs: duration, query }, 'slow query');
    else log.trace({ durationMs: duration, query }, 'query');
  });
  prisma.$on('warn', ({ message }) => log.warn(message));

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

// "The database can't be reached right now", as opposed to "this query is
// wrong". The same outage surfaces in several forms, all seen in testing:
//
// - Prisma connection codes:
//     P1001 can't reach server   P1002 connection timed out
//     P1008 operation timed out  P1017 server closed the connection
//     P2024 timed out waiting for a pooled connection
// - Network errors passed through from pg, e.g. ECONNREFUSED.
// - Postgres SQLSTATEs: class 08 (connection exception); 57P01–57P03
//   (server shutting down, crashed, or not yet accepting connections).
// - Raw queries wrap any of the above in P2010, with the driver's code and
//   message in `meta`.
// - Some driver errors arrive as PrismaClientUnknownRequestError, with the
//   SQLSTATE only inside the message text (seen: 57P03 during a restart).
// - Plain Errors from pg: a pool timeout, or a connection cut mid-query.
const PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const UNAVAILABLE_SQLSTATE = /^(08...|57P0[123])$/;
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const PG_CONNECTION_MESSAGES = new Set([
  POOL_TIMEOUT_MESSAGE,
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
]);

function isUnavailableCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (PRISMA_CODES.has(code) || NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATE.test(code))
  );
}

export function isDatabaseUnavailableError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (isUnavailableCode(err.code)) return true;
    if (err.code === 'P2010') {
      const meta = (err.meta ?? {}) as { code?: string; message?: string };
      return (
        isUnavailableCode(meta.code) ||
        /^Database not reachable/.test(meta.message ?? '') ||
        PG_CONNECTION_MESSAGES.has(meta.message ?? '')
      );
    }
    return false;
  }

  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    const sqlState = /code: "([0-9A-Z]{5})"/.exec(err.message)?.[1];
    return (
      isUnavailableCode(sqlState) ||
      /the database system is (shutting down|starting up)/.test(err.message)
    );
  }

  return err instanceof Error && PG_CONNECTION_MESSAGES.has(err.message);
}
