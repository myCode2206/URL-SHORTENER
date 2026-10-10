import type { RefreshToken } from '@prisma/client';
import type { Database } from '../../infrastructure/database/prisma';

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export class RefreshTokensRepository {
  constructor(private readonly db: Database) {}

  async create(token: NewRefreshToken): Promise<void> {
    await this.db.refreshToken.create({ data: token });
  }

  findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.db.refreshToken.findUnique({ where: { tokenHash } });
  }

  // Revokes the presented token and stores its replacement, atomically.
  //
  // "Revoke only if not already revoked" is a single UPDATE, so if the same
  // token arrives twice at the same moment (two tabs, or an attacker racing
  // the victim), exactly one wins. The loser gets false and is treated as a
  // reuse. If the insert fails, the revoke is rolled back, so a failed refresh
  // never leaves the user with no valid token.
  rotate(currentId: string, next: NewRefreshToken): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: currentId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) return false;
      await tx.refreshToken.create({ data: next });
      return true;
    });
  }

  // Returns how many still-active tokens were revoked. 0 means the session was
  // already over (logged out, or revoked earlier).
  async revokeFamily(familyId: string): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
