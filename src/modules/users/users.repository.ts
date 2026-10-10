import type { User } from '@prisma/client';
import type { Database } from '../../infrastructure/database/prisma';

export class UsersRepository {
  constructor(private readonly db: Database) {}

  // Rejects with Prisma P2002 if the email is already registered. The unique
  // index decides, so two simultaneous sign-ups can't both succeed.
  create(data: { email: string; passwordHash: string }): Promise<User> {
    return this.db.user.create({ data });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash } });
  }
}
