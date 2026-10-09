import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { HealthService, type DependencyCheck } from '../../src/modules/health/health.service';
import { createLogger } from '../../src/utils/logger';

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({ ...process.env, APP_VERSION: 'test-version', ...overrides });
}

// The real app wired to the test database. Health checks default to none, so
// tests that don't touch the database don't need one; pass `checks` to test /ready.
export function buildTestApp({
  checks = [],
  env = {},
}: { checks?: DependencyCheck[]; env?: NodeJS.ProcessEnv } = {}) {
  const config = testConfig(env);
  const logger = createLogger(config);
  const container = createContainer(config, logger);
  const health = new HealthService(checks);
  const app = createApp({ config, logger, ...container, health });
  return { app, health, prisma: container.prisma, clickRecorder: container.clickRecorder };
}
