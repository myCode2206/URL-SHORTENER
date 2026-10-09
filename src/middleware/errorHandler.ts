import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isDatabaseUnavailableError } from '../infrastructure/database/prisma';
import { AppError } from '../utils/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Cannot ${req.method} ${req.path}`));
};

// The only place that turns errors into HTTP responses, so every failure has the
// same shape: { success: false, error: { code, message, details?, requestId } }.
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) return next(err);

  const appError = toAppError(err);
  // pino-http logs the failed request once, including this error and its stack.
  if (appError.statusCode >= 500 && err instanceof Error) res.err = err;
  // Tells well-behaved clients the outage is temporary and when to try again.
  if (appError.statusCode === 503) res.set('Retry-After', '5');
  // Errors are never cached. CloudFront, for one, caches 4xx responses for 10s
  // by default: a 404 for a link created a moment later would stick around.
  res.set('Cache-Control', 'no-store');

  // Someone clicking a dead short link in a browser gets a readable page;
  // API clients (and anything not asking for HTML) get JSON.
  if (!req.path.startsWith('/api/') && req.accepts(['json', 'html']) === 'html') {
    res.status(appError.statusCode).type('html').send(renderErrorPage(appError, req.id));
    return;
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
      requestId: req.id,
    },
  });
};

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // A database outage is not a bug in the request, so it gets a 503 the client
  // can retry rather than a 500.
  if (isDatabaseUnavailableError(err)) {
    return new AppError(503, 'SERVICE_UNAVAILABLE', 'Service is temporarily unavailable');
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      // Unknown keys are reported on the parent object; name the keys instead.
      field: issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue.path.join('.'),
      message: issue.message,
    }));
    return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }

  // Errors raised by express.json() carry a `type` describing what went wrong.
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err.type === 'entity.parse.failed') {
      return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    return new AppError(400, 'BAD_REQUEST', 'Request body could not be read');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

function isBodyParserError(err: unknown): err is Error & { type: string } {
  return err instanceof Error && typeof (err as { type?: unknown }).type === 'string';
}

const PAGE_TITLES: Record<number, string> = {
  404: 'Link not found',
  410: 'This link is no longer available',
  503: 'Temporarily unavailable',
};

function renderErrorPage(error: AppError, requestId: unknown): string {
  const title = PAGE_TITLES[error.statusCode] ?? 'Something went wrong';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; color: #222; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } }
  small { color: #888; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(error.message)}</p>
<small>Error ${error.statusCode} · ${escapeHtml(error.code)} · request ${escapeHtml(String(requestId))}</small>
</body>
</html>`;
}

// Messages are fixed strings today, but escaping is applied anyway so that a
// future message containing user input can't become an XSS hole.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
