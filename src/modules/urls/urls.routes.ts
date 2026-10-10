import { Router, type RequestHandler } from 'express';
import type { UrlController } from './urls.controller';

// optionalAuth: anyone may shorten a URL; a signed-in user becomes its owner.
export function urlRoutes(controller: UrlController, optionalAuth: RequestHandler): Router {
  const router = Router();
  router.post('/', optionalAuth, controller.create);
  return router;
}
