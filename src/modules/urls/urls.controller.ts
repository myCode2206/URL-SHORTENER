import type { Request, Response } from 'express';
import { authenticatedUserId } from '../../middleware/authenticate';
import type { UrlManagementService } from './urlManagement.service';
import { createUrlBody, listUrlsQuery, shortCodeParam, updateUrlBody } from './urls.schemas';
import type { UrlService } from './urls.service';

// Translates between HTTP and the services: parse and validate the request, call
// a service, choose the status code. No business rules live here.
export class UrlController {
  constructor(
    private readonly service: UrlService,
    private readonly management: UrlManagementService,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    // A ZodError thrown here becomes a 400 VALIDATION_ERROR in the error handler.
    const body = createUrlBody.parse(req.body);
    const url = await this.service.shorten(body, req.auth?.userId ?? null);
    res.status(201).json({ success: true, data: url });
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.management.list(
      authenticatedUserId(req),
      listUrlsQuery.parse(req.query),
    );
    res.json({ success: true, data: page });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = shortCodeParam.parse(req.params);
    res.json({
      success: true,
      data: await this.management.get(authenticatedUserId(req), shortCode),
    });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = shortCodeParam.parse(req.params);
    const changes = updateUrlBody.parse(req.body);
    const url = await this.management.update(authenticatedUserId(req), shortCode, changes);
    res.json({ success: true, data: url });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = shortCodeParam.parse(req.params);
    await this.management.remove(authenticatedUserId(req), shortCode);
    res.status(204).end();
  };
}
