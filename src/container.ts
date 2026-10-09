import type { Config } from './config/env';
import { PostgresSequenceIdGenerator } from './infrastructure/database/idGenerator';
import { createPrismaClient, databaseCheck } from './infrastructure/database/prisma';
import { BufferedClickRecorder } from './modules/analytics/bufferedClickRecorder';
import { ClicksRepository } from './modules/analytics/clicks.repository';
import { HealthService } from './modules/health/health.service';
import { RedirectController } from './modules/urls/redirect.controller';
import { RedirectService } from './modules/urls/redirect.service';
import { createShortCodeCodec } from './modules/urls/shortCode';
import { UrlController } from './modules/urls/urls.controller';
import { UrlRepository } from './modules/urls/urls.repository';
import { UrlService } from './modules/urls/urls.service';
import type { Logger } from './utils/logger';

// The composition root: the one place that decides which concrete
// implementation each part gets. Everything else receives its dependencies, so
// tests can swap in fakes and phases can replace parts (e.g. the IdGenerator or
// the ClickRecorder) without editing the code that uses them.
export function createContainer(config: Config, logger: Logger) {
  const prisma = createPrismaClient(config, logger);
  const urlRepository = new UrlRepository(prisma);

  const urlService = new UrlService({
    repository: urlRepository,
    idGenerator: new PostgresSequenceIdGenerator(prisma),
    codec: createShortCodeCodec(config.shortCodeSecret),
    baseUrl: config.baseUrl,
  });

  const clickRecorder = new BufferedClickRecorder(
    new ClicksRepository(prisma),
    logger.child({ component: 'clicks' }),
  );
  const redirectService = new RedirectService({ repository: urlRepository, clickRecorder });

  return {
    prisma,
    clickRecorder,
    health: new HealthService([databaseCheck(prisma)]),
    urlController: new UrlController(urlService),
    redirectController: new RedirectController(redirectService),
  };
}

export type Container = ReturnType<typeof createContainer>;
