import type { Request, Response } from 'express';
import { authenticatedUserId } from '../../middleware/authenticate';
import type { UsersService } from './users.service';

export class UsersController {
  constructor(private readonly service: UsersService) {}

  me = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.getProfile(authenticatedUserId(req));
    res.json({ success: true, data: user });
  };
}
