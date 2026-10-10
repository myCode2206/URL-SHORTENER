import type { Request, Response } from 'express';
import type { RedirectService } from './redirect.service';

export class RedirectController {
  constructor(private readonly service: RedirectService) {}

  redirect = async (req: Request<{ code: string }>, res: Response): Promise<void> => {
    const destination = await this.service.resolve(req.params.code, {
      userAgent: req.get('user-agent') ?? null,
      referrer: req.get('referer') ?? null,
      countsAsClick: req.method === 'GET',
    });

    // 302, not 301. Browsers cache a 301 permanently: the next click goes
    // straight to the destination without asking us, so we'd never count it,
    // and expiring or disabling the link would have no effect for anyone
    // who had already clicked it. no-store says the same to every cache.
    res.set('Cache-Control', 'no-store');
    res.redirect(302, destination);
  };
}
