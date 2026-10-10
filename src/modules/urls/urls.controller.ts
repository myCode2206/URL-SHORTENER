import type { Request, Response } from 'express';
import { createUrlBody } from './urls.schemas';
import type { UrlService } from './urls.service';

// Translates between HTTP and the service: parse and validate the request, call
// the service, choose the status code. No business rules live here.
export class UrlController {
  constructor(private readonly service: UrlService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    // A ZodError thrown here becomes a 400 VALIDATION_ERROR in the error handler.
    const body = createUrlBody.parse(req.body);
    const url = await this.service.shorten(body, req.auth?.userId ?? null);
    res.status(201).json({ success: true, data: url });
  };
}
