import { loadConfig } from '../../../src/config/env';

const required = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
  BASE_URL: 'https://sho.rt',
  SHORT_CODE_SECRET: 'x'.repeat(32),
  REDIS_URL: 'redis://:pass@localhost:6379/0',
  JWT_ACCESS_SECRET: 'j'.repeat(32),
};

describe('loadConfig', () => {
  it('uses Secure cookies only in production', () => {
    expect(loadConfig(required).auth.secureCookies).toBe(false);
    expect(loadConfig({ ...required, NODE_ENV: 'production' }).auth.secureCookies).toBe(true);
  });

  it('accepts rediss:// for TLS connections (ElastiCache in transit encryption)', () => {
    const config = loadConfig({ ...required, REDIS_URL: 'rediss://cache.aws:6379' });
    expect(config.redis.url).toBe('rediss://cache.aws:6379');
  });

  it('normalises BASE_URL to a bare origin', () => {
    expect(loadConfig({ ...required, BASE_URL: 'https://SHO.RT/' }).baseUrl).toBe('https://sho.rt');
  });

  it('applies defaults when optional variables are absent', () => {
    const config = loadConfig(required);
    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      port: 3000,
      logLevel: 'info',
      trustProxy: 0,
      shutdownTimeoutMs: 10_000,
      version: 'dev',
      databaseUrl: required.DATABASE_URL,
      baseUrl: 'https://sho.rt',
      redis: { url: required.REDIS_URL, commandTimeoutMs: 100, connectTimeoutMs: 2000 },
      cache: { ttlSeconds: 3600, negativeTtlSeconds: 60 },
      auth: {
        jwtSecret: required.JWT_ACCESS_SECRET,
        accessTokenTtlSeconds: 900,
        refreshTokenTtlDays: 30,
        secureCookies: false,
      },
    });
  });

  it('coerces numeric strings from the environment', () => {
    const config = loadConfig({
      ...required,
      PORT: '8080',
      TRUST_PROXY: '1',
      NODE_ENV: 'production',
    });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(1);
    expect(config.isProduction).toBe(true);
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    [{ TRUST_PROXY: '-1' }, 'TRUST_PROXY'],
    [{ DATABASE_URL: undefined }, 'DATABASE_URL'],
    [{ DATABASE_URL: 'mysql://localhost/app' }, 'DATABASE_URL'],
    [{ BASE_URL: 'sho.rt' }, 'BASE_URL'],
    [{ BASE_URL: 'ftp://sho.rt' }, 'BASE_URL'],
    [{ BASE_URL: 'https://sho.rt/links' }, 'BASE_URL'],
    [{ SHORT_CODE_SECRET: 'too-short' }, 'SHORT_CODE_SECRET'],
    [{ REDIS_URL: undefined }, 'REDIS_URL'],
    [{ JWT_ACCESS_SECRET: 'short' }, 'JWT_ACCESS_SECRET'],
    [{ ACCESS_TOKEN_TTL_SECONDS: '86400' }, 'ACCESS_TOKEN_TTL_SECONDS'],
    [{ REDIS_URL: 'http://localhost:6379' }, 'REDIS_URL'],
    [{ CACHE_TTL_SECONDS: '0' }, 'CACHE_TTL_SECONDS'],
  ])('fails fast with a message naming the bad variable: %j', (env, name) => {
    expect(() => loadConfig({ ...required, ...env })).toThrow(
      new RegExp(`Invalid environment configuration[\\s\\S]*${name}`),
    );
  });
});
