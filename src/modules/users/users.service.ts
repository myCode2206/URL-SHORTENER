import type { User } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { UsersRepository } from './users.repository';

// What the API may show about a user. The password hash never leaves the
// service layer: every response is built from this shape.
export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export class UsersService {
  constructor(private readonly repository: Pick<UsersRepository, 'findById'>) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.repository.findById(userId);
    // A valid token for a user that no longer exists (account deleted).
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User no longer exists');
    return toPublicUser(user);
  }
}
