import { createApp } from './app';
import { loadConfig } from './config/env';
import { HealthService } from './modules/health/health.service';
import { createLogger } from './utils/logger';

const config = loadConfigOrExit();
const logger = createLogger(config);
const health = new HealthService([]);
const app = createApp({ config, logger, health });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'server listening');
});

server.on('error', (err) => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});

// Node closes idle keep-alive sockets after 5s by default. AWS load balancers
// keep them for 60s, so they can send a request down a socket Node has just
// closed, and the client sees a random 502. Node must outlive the balancer.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  health.markShuttingDown();

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  // Stop accepting connections and wait for in-flight requests to finish.
  server.close((err) => {
    if (err) logger.error({ err }, 'error while closing server');
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// After an unexpected error the process state can't be trusted. Log it and exit
// so the orchestrator starts a clean replacement.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

// The logger depends on config, so config errors go straight to stderr.
function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
