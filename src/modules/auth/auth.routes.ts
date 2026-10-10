import cookieParser from 'cookie-parser';
import { Router } from 'express';
import type { AuthController } from './auth.controller';

export function authRoutes(controller: AuthController): Router {
  const router = Router();

  // Responses carry tokens: no browser, proxy or CDN may keep a copy.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Only the auth routes read cookies; nothing else in the API uses them.
  router.use(cookieParser());

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  return router;
}
