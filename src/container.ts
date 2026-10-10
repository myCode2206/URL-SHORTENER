import type { Config } from './config/env';
import { PostgresSequenceIdGenerator } from './infrastructure/database/idGenerator';
import { createPrismaClient, databaseCheck } from './infrastructure/database/prisma';
import { createRedisClient, redisCheck } from './infrastructure/redis/redis';
import { authenticate } from './middleware/authenticate';
import { BufferedClickRecorder } from './modules/analytics/bufferedClickRecorder';
import { ClicksRepository } from './modules/analytics/clicks.repository';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { RefreshTokensRepository } from './modules/auth/refreshTokens.repository';
import { AccessTokens } from './modules/auth/tokens';
import { HealthService } from './modules/health/health.service';
import { RedirectCache } from './modules/urls/redirectCache';
import { RedirectController } from './modules/urls/redirect.controller';
import { RedirectService } from './modules/urls/redirect.service';
import { UrlManagementService } from './modules/urls/urlManagement.service';
import { createShortCodeCodec } from './modules/urls/shortCode';
import { UrlController } from './modules/urls/urls.controller';
import { UrlRepository } from './modules/urls/urls.repository';
import { UrlService } from './modules/urls/urls.service';
import { UsersController } from './modules/users/users.controller';
import { UsersRepository } from './modules/users/users.repository';
import { UsersService } from './modules/users/users.service';
import type { Logger } from './utils/logger';

// The composition root: the one place that decides which concrete
// implementation each part gets. Everything else receives its dependencies, so
// tests can swap in fakes and phases can replace parts (e.g. the IdGenerator or
// the ClickRecorder) without editing the code that uses them.
export function createContainer(config: Config, logger: Logger) {
  const prisma = createPrismaClient(config, logger);
  const redis = createRedisClient(config, logger);
  const urlRepository = new UrlRepository(prisma);
  const redirectCache = new RedirectCache(
    redis,
    config.cache,
    logger.child({ component: 'redirect-cache' }),
  );

  const urlService = new UrlService({
    repository: urlRepository,
    cache: redirectCache,
    idGenerator: new PostgresSequenceIdGenerator(prisma),
    codec: createShortCodeCodec(config.shortCodeSecret),
    baseUrl: config.baseUrl,
  });

  const clickRecorder = new BufferedClickRecorder(
    new ClicksRepository(prisma),
    logger.child({ component: 'clicks' }),
  );
  const redirectService = new RedirectService({
    repository: urlRepository,
    cache: redirectCache,
    clickRecorder,
  });

  const usersRepository = new UsersRepository(prisma);
  const accessTokens = new AccessTokens({
    secret: config.auth.jwtSecret,
    ttlSeconds: config.auth.accessTokenTtlSeconds,
    issuer: config.baseUrl,
  });
  const authService = new AuthService({
    users: usersRepository,
    refreshTokens: new RefreshTokensRepository(prisma),
    accessTokens,
    refreshTokenTtlDays: config.auth.refreshTokenTtlDays,
    logger: logger.child({ component: 'auth' }),
  });

  return {
    prisma,
    redis,
    redirectCache,
    clickRecorder,
    health: new HealthService([databaseCheck(prisma), redisCheck(redis)]),
    urlController: new UrlController(
      urlService,
      new UrlManagementService({
        repository: urlRepository,
        cache: redirectCache,
        baseUrl: config.baseUrl,
      }),
    ),
    redirectController: new RedirectController(redirectService),
    authController: new AuthController(authService, config.auth.secureCookies),
    usersController: new UsersController(new UsersService(usersRepository)),
    requireAuth: authenticate(accessTokens, { required: true }),
    optionalAuth: authenticate(accessTokens, { required: false }),
  };
}

export type Container = ReturnType<typeof createContainer>;
