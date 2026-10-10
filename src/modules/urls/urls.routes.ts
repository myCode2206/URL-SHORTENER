import { Router, type RequestHandler } from 'express';
import type { UrlController } from './urls.controller';

export function urlRoutes(
  controller: UrlController,
  { requireAuth, optionalAuth }: { requireAuth: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router();
  // Anyone may shorten a URL; a signed-in user becomes its owner.
  router.post('/', optionalAuth, controller.create);
  // Managing links requires an account: you can only see and change your own.
  router.get('/', requireAuth, controller.list);
  router.get('/:shortCode', requireAuth, controller.get);
  router.patch('/:shortCode', requireAuth, controller.update);
  router.delete('/:shortCode', requireAuth, controller.remove);
  return router;
}
