import type { Config } from '../../src/config/env';

// Just enough config to build a silent logger in unit tests, without
// requiring database settings.
export const testLoggerConfig = {
  env: 'test',
  logLevel: 'silent',
  version: 'test',
} as Config;
