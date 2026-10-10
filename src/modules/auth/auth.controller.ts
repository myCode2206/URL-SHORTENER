import type { CookieOptions, Request, Response } from 'express';
import { loginBody, registerBody } from './auth.schemas';
import type { AuthService, Session } from './auth.service';

export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

// The refresh token travels only in this cookie, never in a JSON body:
// - HttpOnly: page JavaScript can't read it, so an XSS bug can't steal it.
// - Secure (production): only ever sent over HTTPS.
// - SameSite=Strict: never sent on requests started by another site (CSRF).
// - Path=/api/v1/auth: not sent with ordinary API calls or redirects, only to
//   the refresh and logout endpoints that need it.
function refreshCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: REFRESH_COOKIE_PATH };
}

export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly secureCookies: boolean,
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const session = await this.service.register(registerBody.parse(req.body));
    this.sendSession(res, 201, session);
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const session = await this.service.login(loginBody.parse(req.body));
    this.sendSession(res, 200, session);
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    try {
      this.sendSession(res, 200, await this.service.refresh(this.refreshTokenFrom(req)));
    } catch (err) {
      // The cookie is useless now; tell the browser to drop it.
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.secureCookies));
      throw err;
    }
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    await this.service.logout(this.refreshTokenFrom(req));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.secureCookies));
    res.status(204).end();
  };

  private refreshTokenFrom(req: Request): string | undefined {
    const value: unknown = req.cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private sendSession(res: Response, status: number, session: Session): void {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...refreshCookieOptions(this.secureCookies),
      expires: session.refreshTokenExpiresAt,
    });
    res.status(status).json({
      success: true,
      data: {
        user: session.user,
        accessToken: session.accessToken,
        tokenType: 'Bearer',
        expiresIn: session.expiresIn,
      },
    });
  }
}
