import { Router, type RequestHandler } from 'express';
import type { UsersController } from './users.controller';

export function usersRoutes(controller: UsersController, requireAuth: RequestHandler): Router {
  const router = Router();
  router.get('/me', requireAuth, controller.me);
  return router;
}
