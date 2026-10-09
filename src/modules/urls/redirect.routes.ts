import { Router } from 'express';
import type { RedirectController } from './redirect.controller';

// Mounted last, after /api, /docs and the health routes: `/:shortCode`
// matches any single path segment, so anything registered after it would be
// shadowed.
export function redirectRoutes(controller: RedirectController): Router {
  const router = Router();
  router.get('/:shortCode', controller.redirect);
  return router;
}
