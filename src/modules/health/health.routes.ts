import { Router } from 'express';
import type { HealthService } from './health.service';

// GET /health: liveness. "Is the process alive?" Never checks dependencies; if it
// did, a brief database blip would make the orchestrator restart healthy
// containers, which only makes an outage worse.
//
// GET /ready: readiness. "Should this instance get traffic right now?" Fails
// when a required dependency is down or the process is shutting down.
export function healthRoutes(health: HealthService, version: string): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version,
      uptimeSeconds: health.uptimeSeconds(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (_req, res) => {
    const report = await health.readiness();
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? 'ready' : 'not_ready',
      checks: report.checks,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
