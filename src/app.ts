import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Config } from './config/env';
import { buildOpenApiDocument } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { resolveRequestId } from './middleware/requestId';
import type { HealthService } from './modules/health/health.service';
import { healthRoutes } from './modules/health/health.routes';
import type { RedirectController } from './modules/urls/redirect.controller';
import { redirectRoutes } from './modules/urls/redirect.routes';
import type { UrlController } from './modules/urls/urls.controller';
import { urlRoutes } from './modules/urls/urls.routes';
import type { Logger } from './utils/logger';

export interface AppDependencies {
  config: Config;
  logger: Logger;
  health: HealthService;
  urlController: UrlController;
  redirectController: RedirectController;
}

// Builds the Express app without starting a server. Tests use this to run
// requests in memory with fake dependencies; server.ts adds the real ones.
export function createApp({
  config,
  logger,
  health,
  urlController,
  redirectController,
}: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind nginx or a load balancer, the client IP is in X-Forwarded-For. Trust
  // exactly as many proxies as exist; trusting more lets clients forge their IP.
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: resolveRequestId,
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Probes hit these every few seconds; logging them would drown real traffic.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes(health, config.version));

  const openApiDocument = buildOpenApiDocument(config);
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use('/api/v1/urls', urlRoutes(urlController));
  // Must stay last: /:shortCode matches any single path segment.
  app.use(redirectRoutes(redirectController));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
