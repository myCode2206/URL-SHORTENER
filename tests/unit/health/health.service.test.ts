import { HealthService } from '../../../src/modules/health/health.service';

describe('HealthService.readiness', () => {
  it('is ready with no dependencies', async () => {
    await expect(new HealthService().readiness()).resolves.toEqual({
      ready: true,
      degraded: false,
      checks: {},
    });
  });

  it('reports each dependency and is not ready if any is down', async () => {
    const health = new HealthService([
      { name: 'database', check: () => Promise.resolve() },
      { name: 'cache', check: () => Promise.reject(new Error('connection refused')) },
    ]);

    const report = await health.readiness();

    expect(report.ready).toBe(false);
    expect(report.checks.database).toMatchObject({ status: 'up' });
    expect(report.checks.cache).toMatchObject({ status: 'down', error: 'connection refused' });
  });

  it('stays ready but degraded when only an optional dependency is down', async () => {
    const health = new HealthService([
      { name: 'database', check: () => Promise.resolve() },
      { name: 'cache', critical: false, check: () => Promise.reject(new Error('ECONNREFUSED')) },
    ]);

    const report = await health.readiness();

    expect(report).toMatchObject({ ready: true, degraded: true });
    expect(report.checks.cache).toMatchObject({ status: 'down', critical: false });
  });

  it('is not ready when a critical dependency is down, whatever the optional ones do', async () => {
    const health = new HealthService([
      { name: 'database', check: () => Promise.reject(new Error('down')) },
      { name: 'cache', critical: false, check: () => Promise.resolve() },
    ]);
    await expect(health.readiness()).resolves.toMatchObject({ ready: false, degraded: false });
  });

  it('times out a hanging check instead of hanging the probe', async () => {
    jest.useFakeTimers();
    const health = new HealthService([{ name: 'stuck', check: () => new Promise(() => {}) }]);

    const pending = health.readiness();
    await jest.advanceTimersByTimeAsync(2000);
    const report = await pending;

    expect(report.checks.stuck).toMatchObject({ status: 'down', error: 'check timed out' });
    jest.useRealTimers();
  });

  it('is not ready once shutdown has started', async () => {
    const health = new HealthService();
    health.markShuttingDown();
    await expect(health.readiness()).resolves.toMatchObject({ ready: false });
  });
});
