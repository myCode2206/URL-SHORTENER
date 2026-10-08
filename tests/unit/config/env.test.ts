import { loadConfig } from '../../../src/config/env';

describe('loadConfig', () => {
  it('applies defaults when variables are absent', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      port: 3000,
      logLevel: 'info',
      trustProxy: 0,
      shutdownTimeoutMs: 10_000,
      version: 'dev',
    });
  });

  it('coerces numeric strings from the environment', () => {
    const config = loadConfig({ PORT: '8080', TRUST_PROXY: '1', NODE_ENV: 'production' });
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
  ])('fails fast with a message naming the bad variable: %j', (env, name) => {
    expect(() => loadConfig(env)).toThrow(
      new RegExp(`Invalid environment configuration[\\s\\S]*${name}`),
    );
  });
});
