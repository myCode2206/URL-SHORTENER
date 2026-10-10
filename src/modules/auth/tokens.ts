import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError } from '../../utils/errors';

// Two kinds of token, with opposite trade-offs:
//
// Access token: a signed JWT, valid for 15 minutes, sent with every API call.
//   The server checks the signature and expiry with no database lookup, which
//   is why it scales. The cost: it can't be revoked. A stolen one works until
//   it expires, so it is kept short-lived.
//
// Refresh token: a random string, valid for 30 days, used for one thing only:
//   getting a new access token. Every use is checked against the database, so
//   it can be revoked at any moment (logout, theft detected). It lives in an
//   HttpOnly cookie that page JavaScript can't read.

const AUDIENCE = 'url-shortener-api';

export interface AccessTokenOptions {
  secret: string;
  ttlSeconds: number;
  issuer: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresIn: number;
}

export class AccessTokens {
  constructor(private readonly options: AccessTokenOptions) {}

  sign(userId: string): IssuedAccessToken {
    const { secret, ttlSeconds, issuer } = this.options;
    const accessToken = jwt.sign({ typ: 'access' }, secret, {
      algorithm: 'HS256',
      subject: userId,
      expiresIn: ttlSeconds,
      issuer,
      audience: AUDIENCE,
    });
    return { accessToken, expiresIn: ttlSeconds };
  }

  // Returns the user ID, or throws a 401.
  verify(token: string): string {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.options.secret, {
        // Pinned. Accepting whatever algorithm the token's header names allows
        // `alg: none` (no signature at all) and algorithm-confusion forgeries.
        algorithms: ['HS256'],
        issuer: this.options.issuer,
        audience: AUDIENCE,
      });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired; refresh it');
      }
      throw invalidToken();
    }
    // A correctly signed token of another kind (if one is ever added) must
    // not work as an access token.
    if (typeof payload === 'string' || payload.typ !== 'access' || !payload.sub) {
      throw invalidToken();
    }
    return payload.sub;
  }
}

const invalidToken = () => new AppError(401, 'INVALID_TOKEN', 'Access token is invalid');

// 32 random bytes = 256 bits: unguessable, so no brute-force protection is
// needed, and a fast hash is enough to store it. (Argon2 is for passwords,
// which people choose and which are therefore guessable.)
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

// SHA-256, unsalted, on purpose: refresh is a lookup by hash, so the hash must
// be deterministic. Salting adds nothing against brute force for 256-bit
// random input.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
