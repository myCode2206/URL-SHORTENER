import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { HealthService, type DependencyCheck } from '../../src/modules/health/health.service';
import { createLogger } from '../../src/utils/logger';

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({ ...process.env, APP_VERSION: 'test-version', ...overrides });
}

// Every container built in a test file, so the shared teardown can close their
// database and Redis connections (tests/integration/teardown.ts).
const containers: Container[] = [];

// The real app wired to the test database and test Redis.
// - checks: replace the readiness checks (default: none, so /ready tests are explicit)
// - realHealth: keep the container's real database and Redis checks instead
export function buildTestApp({
  checks = [],
  env = {},
  realHealth = false,
}: { checks?: DependencyCheck[]; env?: NodeJS.ProcessEnv; realHealth?: boolean } = {}) {
  const config = testConfig(env);
  const logger = createLogger(config);
  const container = createContainer(config, logger);
  containers.push(container);
  const health = realHealth ? container.health : new HealthService(checks);
  const app = createApp({ config, logger, ...container, health });
  return { app, ...container, health };
}

export async function closeTestApps(): Promise<void> {
  await Promise.all(
    containers.splice(0).map(async ({ clickRecorder, prisma, redis }) => {
      await clickRecorder.stop();
      await prisma.$disconnect();
      redis.disconnect();
    }),
  );
}
