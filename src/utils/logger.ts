import { pino, type Logger } from 'pino';
import type { Config } from '../config/env';

export type { Logger };

// JSON logs in production (one object per line, ready for CloudWatch or Loki);
// human-readable output in development.
export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'url-shortener', env: config.env, version: config.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Credentials must never reach log storage.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.refreshToken',
      ],
      censor: '[REDACTED]',
    },
    ...(config.env === 'development' && {
      transport: { target: 'pino-pretty', options: { singleLine: true } },
    }),
  });
}
