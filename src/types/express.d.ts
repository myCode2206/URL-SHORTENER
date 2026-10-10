// Adds the authenticated user to Express's Request type, set by the
// authenticate middleware.
declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
    }
  }
}

export {};
