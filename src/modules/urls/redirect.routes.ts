import { Router } from 'express';
import type { RedirectController } from './redirect.controller';

// Mounted last, after /api, /docs and the health routes: `/:code` matches any
// single path segment (a generated code or an alias), so anything registered
// after it would be shadowed.
export function redirectRoutes(controller: RedirectController): Router {
  const router = Router();
  router.get('/:code', controller.redirect);
  return router;
}
