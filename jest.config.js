const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  clearMocks: true,
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    // Unit tests need no running infrastructure.
    { ...shared, displayName: 'unit', roots: ['<rootDir>/tests/unit'] },
    // Integration tests run against real PostgreSQL and Redis. Migrations are
    // applied once, before any test file runs. The files share one test
    // database and wipe it between tests, so they must run one at a time
    // (npm run test:integration passes --runInBand): in parallel they delete
    // each other's rows and deadlock on TRUNCATE.
    {
      ...shared,
      displayName: 'integration',
      roots: ['<rootDir>/tests/integration'],
      globalSetup: '<rootDir>/tests/integration/global-setup.ts',
      setupFilesAfterEnv: ['<rootDir>/tests/integration/teardown.ts'],
    },
  ],
};
