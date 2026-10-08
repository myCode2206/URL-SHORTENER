import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { resolveRequestId } from './middleware/requestId';
import type { HealthService } from './modules/health/health.service';
import { healthRoutes } from './modules/health/health.routes';
import type { Logger } from './utils/logger';

export interface AppDependencies {
  config: Config;
  logger: Logger;
  health: HealthService;
}

// Builds the Express app without starting a server. Tests use this to run
// requests in memory with fake dependencies; server.ts adds the real ones.
export function createApp({ config, logger, health }: AppDependencies): Express {
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
