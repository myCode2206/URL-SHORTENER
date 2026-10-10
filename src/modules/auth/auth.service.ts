import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { Logger } from '../../utils/logger';
import type { UsersRepository } from '../users/users.repository';
import { toPublicUser, type PublicUser } from '../users/users.service';
import { hashPassword, needsRehash, TIMING_EQUALIZER_HASH, verifyPassword } from './password';
import type { RefreshTokensRepository } from './refreshTokens.repository';
import { generateRefreshToken, hashRefreshToken, type AccessTokens } from './tokens';

export interface Credentials {
  email: string;
  password: string;
}

// What a successful register, login or refresh produces. The controller puts
// the refresh token in a cookie and everything else in the JSON body.
export interface Session {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthServiceDependencies {
  users: Pick<UsersRepository, 'create' | 'findByEmail' | 'findById' | 'updatePasswordHash'>;
  refreshTokens: Pick<RefreshTokensRepository, 'create' | 'findByHash' | 'rotate' | 'revokeFamily'>;
  accessTokens: Pick<AccessTokens, 'sign'>;
  refreshTokenTtlDays: number;
  logger: Logger;
  now?: () => Date;
}

// One message for "no such email" and "wrong password", so the login form
// can't be used to discover who has an account.
const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
const invalidRefreshToken = () =>
  new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session is invalid or has expired; log in again');

export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async register({ email, password }: Credentials): Promise<Session> {
    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = await this.deps.users.create({ email, passwordHash });
    } catch (err) {
      // Relying on the unique index, not "check, then insert", means two
      // sign-ups racing for one email can't both succeed.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
    return this.startSession(user, randomUUID());
  }

  async login({ email, password }: Credentials): Promise<Session> {
    const user = await this.deps.users.findByEmail(email);
    if (!user) {
      // Spend the same time as a real check, so timing doesn't reveal that
      // the email isn't registered.
      await verifyPassword(await TIMING_EQUALIZER_HASH, password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();

    if (needsRehash(user.passwordHash)) {
      await this.deps.users.updatePasswordHash(user.id, await hashPassword(password));
    }
    return this.startSession(user, randomUUID());
  }

  // Exchanges a refresh token for a new access token and a new refresh token.
  async refresh(refreshToken: string | undefined): Promise<Session> {
    if (!refreshToken) throw invalidRefreshToken();
    const stored = await this.deps.refreshTokens.findByHash(hashRefreshToken(refreshToken));
    if (!stored) throw invalidRefreshToken();

    // Already used. Refresh tokens are single-use, so seeing one again means
    // a copy exists: someone stole it, or replayed it. We can't tell the thief
    // from the owner, so end the whole session for both.
    if (stored.revokedAt) {
      await this.revokeForReuse(stored.familyId, stored.userId);
      throw invalidRefreshToken();
    }
    if (stored.expiresAt.getTime() <= this.now().getTime()) throw invalidRefreshToken();

    const user = await this.deps.users.findById(stored.userId);
    if (!user) throw invalidRefreshToken();

    const next = this.newRefreshToken(user.id, stored.familyId);
    // Lost a race with another use of the same token: treat it as reuse too.
    if (!(await this.deps.refreshTokens.rotate(stored.id, next.record))) {
      await this.revokeForReuse(stored.familyId, stored.userId);
      throw invalidRefreshToken();
    }
    return this.session(user, next.token, next.record.expiresAt);
  }

  // Ends the session the token belongs to. Idempotent: logging out twice, or
  // with an unknown or expired token, still succeeds.
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const stored = await this.deps.refreshTokens.findByHash(hashRefreshToken(refreshToken));
    if (stored) await this.deps.refreshTokens.revokeFamily(stored.familyId);
  }

  private async startSession(user: User, familyId: string): Promise<Session> {
    const { token, record } = this.newRefreshToken(user.id, familyId);
    await this.deps.refreshTokens.create(record);
    return this.session(user, token, record.expiresAt);
  }

  private newRefreshToken(userId: string, familyId: string) {
    const token = generateRefreshToken();
    const ttlMs = this.deps.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
    const record = {
      userId,
      familyId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(this.now().getTime() + ttlMs),
    };
    return { token, record };
  }

  private session(user: User, refreshToken: string, refreshTokenExpiresAt: Date): Session {
    return {
      user: toPublicUser(user),
      ...this.deps.accessTokens.sign(user.id),
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private async revokeForReuse(familyId: string, userId: string): Promise<void> {
    const revoked = await this.deps.refreshTokens.revokeFamily(familyId);
    // A security event worth alerting on: possible token theft. Only when this
    // call actually ended a live session; replaying a token from a session that
    // is already over (logged out, or revoked earlier) is just a stale cookie,
    // and alerting on it would train people to ignore the alert.
    if (revoked > 0) {
      this.deps.logger.warn({ userId, familyId }, 'refresh token reuse detected; session revoked');
    }
  }
}
