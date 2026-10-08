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
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
