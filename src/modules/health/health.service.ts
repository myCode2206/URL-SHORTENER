// A dependency the app cannot serve traffic without (PostgreSQL from Phase 2,
// Redis from Phase 5). `check` should reject when the dependency is unusable.
export interface DependencyCheck {
  name: string;
  check: () => Promise<void>;
}

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, CheckResult>;
}

const CHECK_TIMEOUT_MS = 2000;

export class HealthService {
  private shuttingDown = false;
  private readonly startedAt = Date.now();

  constructor(private readonly checks: DependencyCheck[] = []) {}

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  // Once shutdown begins, readiness fails so the load balancer stops sending new
  // requests while the in-flight ones finish.
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.checks.map(async ({ name, check }) => [name, await runCheck(check)] as const),
    );
    const checks = Object.fromEntries(entries);
    const allUp = entries.every(([, result]) => result.status === 'up');
    return { ready: allUp && !this.shuttingDown, checks };
  }
}

async function runCheck(check: () => Promise<void>): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  // A hung dependency must not hang the readiness probe itself.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return { status: 'up', latencyMs: elapsed(started) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: 'down', latencyMs: elapsed(started), error };
  } finally {
    clearTimeout(timer);
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
