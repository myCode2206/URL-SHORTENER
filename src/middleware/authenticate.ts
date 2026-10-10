import type { Request, RequestHandler } from 'express';
import type { AccessTokens } from '../modules/auth/tokens';
import { AppError } from '../utils/errors';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

// Checks the `Authorization: Bearer <token>` header and records the user on
// `req.auth`. No database lookup: the signature proves the token is ours, and
// the expiry limits how long it works.
//
// required: false is for routes that also work anonymously (creating a short
// URL). A token there is still checked: a broken or expired token gets a 401
// rather than being silently treated as anonymous, which would create links
// the user then can't find in their account.
export function authenticate(
  tokens: Pick<AccessTokens, 'verify'>,
  { required }: { required: boolean },
): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization');
    if (!header) {
      if (!required) return next();
      return next(unauthorized(res, 'AUTH_REQUIRED', 'Authentication required'));
    }

    const token = BEARER.exec(header)?.[1];
    if (!token) {
      return next(
        unauthorized(res, 'INVALID_TOKEN', 'Authorization header must be "Bearer <token>"'),
      );
    }

    try {
      req.auth = { userId: tokens.verify(token) };
      next();
    } catch (err) {
      // RFC 6750: a 401 for a bad bearer token says why in WWW-Authenticate.
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      next(err);
    }
  };
}

function unauthorized(res: Parameters<RequestHandler>[1], code: string, message: string) {
  res.set('WWW-Authenticate', 'Bearer');
  return new AppError(401, code, message);
}

// For handlers mounted behind authenticate({ required: true }).
export function authenticatedUserId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
  return req.auth.userId;
}
