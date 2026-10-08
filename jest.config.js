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
    // Integration tests run against real PostgreSQL. Migrations are applied once,
    // before any test file runs.
    {
      ...shared,
      displayName: 'integration',
      roots: ['<rootDir>/tests/integration'],
      globalSetup: '<rootDir>/tests/integration/global-setup.ts',
    },
  ],
};
