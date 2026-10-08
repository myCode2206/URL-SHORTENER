import { Router } from 'express';
import type { UrlController } from './urls.controller';

export function urlRoutes(controller: UrlController): Router {
  const router = Router();
  router.post('/', controller.create);
  return router;
}
