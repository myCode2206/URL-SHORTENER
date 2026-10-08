import { loadConfig } from '../../../src/config/env';

const required = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
  BASE_URL: 'https://sho.rt',
  SHORT_CODE_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
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
  ])('fails fast with a message naming the bad variable: %j', (env, name) => {
    expect(() => loadConfig({ ...required, ...env })).toThrow(
      new RegExp(`Invalid environment configuration[\\s\\S]*${name}`),
    );
  });
});
