import { execFileSync } from 'node:child_process';
import { resolveTestDatabaseUrl } from '../helpers/database';

// Brings the test database to the latest schema with the same command production
// deployments use, so migrations themselves are tested on every run.
export default function globalSetup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'pipe',
  });
}
