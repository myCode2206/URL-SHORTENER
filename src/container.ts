import type { Config } from './config/env';
import { PostgresSequenceIdGenerator } from './infrastructure/database/idGenerator';
import { createPrismaClient, databaseCheck } from './infrastructure/database/prisma';
import { HealthService } from './modules/health/health.service';
import { createShortCodeCodec } from './modules/urls/shortCode';
import { UrlController } from './modules/urls/urls.controller';
import { UrlRepository } from './modules/urls/urls.repository';
import { UrlService } from './modules/urls/urls.service';
import type { Logger } from './utils/logger';

// The composition root: the one place that decides which concrete
// implementation each part gets. Everything else receives its dependencies, so
// tests can swap in fakes and phases can replace parts (e.g. the IdGenerator)
// without editing the code that uses them.
export function createContainer(config: Config, logger: Logger) {
  const prisma = createPrismaClient(config, logger);

  const urlService = new UrlService({
    repository: new UrlRepository(prisma),
    idGenerator: new PostgresSequenceIdGenerator(prisma),
    codec: createShortCodeCodec(config.shortCodeSecret),
    baseUrl: config.baseUrl,
  });

  return {
    prisma,
    health: new HealthService([databaseCheck(prisma)]),
    urlController: new UrlController(urlService),
  };
}

export type Container = ReturnType<typeof createContainer>;
