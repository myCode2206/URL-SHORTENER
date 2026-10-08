import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { HealthService, type DependencyCheck } from '../../src/modules/health/health.service';
import { createLogger } from '../../src/utils/logger';

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({ ...process.env, APP_VERSION: 'test-version', ...overrides });
}

export function buildTestApp({ checks = [] }: { checks?: DependencyCheck[] } = {}) {
  const config = testConfig();
  const health = new HealthService(checks);
  const app = createApp({ config, logger: createLogger(config), health });
  return { app, health };
}
