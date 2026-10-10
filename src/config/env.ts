import { z } from 'zod';

// Every setting the app reads comes through here. The process refuses to start
// if anything is missing or malformed, so a typo in production fails loudly at
// boot instead of surfacing as a strange bug hours later.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  APP_VERSION: z.string().min(1).default('dev'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  // Connections this process keeps open. Across all instances the total must
  // stay under the database's max_connections (see README: pooling).
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // How long a request waits to open a connection or borrow one from the pool.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Postgres cancels any statement running longer than this, so one runaway
  // query can't hold a pooled connection indefinitely.
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // redis:// locally; rediss:// (TLS) for ElastiCache with encryption in transit.
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(100),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Signs access tokens (HS256). Anyone holding it can mint a token for any
  // user, so it lives only in the secret store. Rotating it logs everyone out.
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // The public origin short links are built on, e.g. https://sho.rt
  BASE_URL: z
    .url({ protocol: /^https?$/ })
    // Zod runs refinements even after .url() fails, so guard the parse.
    .refine(
      (value) => URL.canParse(value) && new URL(value).pathname === '/',
      'must be an origin with no path',
    )
    .transform((value) => new URL(value).origin),
  // Key for scrambling database IDs into short codes. Changing it changes every
  // future code, so it must stay fixed for the life of the deployment.
  SHORT_CODE_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const vars = result.data;
  return {
    env: vars.NODE_ENV,
    isProduction: vars.NODE_ENV === 'production',
    port: vars.PORT,
    logLevel: vars.LOG_LEVEL,
    trustProxy: vars.TRUST_PROXY,
    shutdownTimeoutMs: vars.SHUTDOWN_TIMEOUT_MS,
    version: vars.APP_VERSION,
    databaseUrl: vars.DATABASE_URL,
    databasePool: {
      max: vars.DATABASE_POOL_MAX,
      connectTimeoutMs: vars.DATABASE_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: vars.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    redis: {
      url: vars.REDIS_URL,
      commandTimeoutMs: vars.REDIS_COMMAND_TIMEOUT_MS,
      connectTimeoutMs: vars.REDIS_CONNECT_TIMEOUT_MS,
    },
    cache: {
      ttlSeconds: vars.CACHE_TTL_SECONDS,
      negativeTtlSeconds: vars.CACHE_NEGATIVE_TTL_SECONDS,
    },
    auth: {
      jwtSecret: vars.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: vars.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: vars.REFRESH_TOKEN_TTL_DAYS,
      // Secure cookies are only sent over HTTPS. Production is always HTTPS
      // (TLS ends at the load balancer); local development is plain HTTP.
      secureCookies: vars.NODE_ENV === 'production',
    },
    baseUrl: vars.BASE_URL,
    shortCodeSecret: vars.SHORT_CODE_SECRET,
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
