// Something the app depends on. `check` should reject when it is unusable.
//
// critical (default true): the app can't serve traffic without it (PostgreSQL),
// so readiness fails while it's down.
// critical: false: the app works without it, just slower (Redis). It is reported
// as down and marks the instance "degraded", but readiness still passes.
export interface DependencyCheck {
  name: string;
  critical?: boolean;
  check: () => Promise<void>;
}

export interface CheckResult {
  status: 'up' | 'down';
  critical: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  // True when an optional dependency is down: serving traffic, but not at full speed.
  degraded: boolean;
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
      this.checks.map(
        async ({ name, check, critical = true }) =>
          [name, { ...(await runCheck(check)), critical }] as const,
      ),
    );
    const results = entries.map(([, result]) => result);
    const criticalUp = results.every((r) => !r.critical || r.status === 'up');
    return {
      ready: criticalUp && !this.shuttingDown,
      degraded: results.some((r) => !r.critical && r.status === 'down'),
      checks: Object.fromEntries(entries),
    };
  }
}

async function runCheck(check: () => Promise<void>): Promise<Omit<CheckResult, 'critical'>> {
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
