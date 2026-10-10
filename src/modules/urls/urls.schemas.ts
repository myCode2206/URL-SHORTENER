import { z } from 'zod';
import { MAX_URL_LENGTH } from './destinationUrl';

// Request and response shapes. The same schemas validate requests at runtime,
// give TypeScript types, and generate the OpenAPI documentation, so the docs
// can't drift from what the code actually accepts.

// strictObject rejects unknown fields, so a typo such as "ulr" returns a 400
// instead of being silently ignored.
export const createUrlBody = z.strictObject({
  url: z.string().trim().min(1).max(MAX_URL_LENGTH).meta({
    description: 'The http(s) URL to shorten',
    example: 'https://example.com/very/long/url',
  }),
});

export type CreateUrlBody = z.infer<typeof createUrlBody>;

export const shortenedUrl = z.object({
  shortCode: z.string().meta({ example: 'aB7xK2q' }),
  shortUrl: z.url().meta({ example: 'https://sho.rt/aB7xK2q' }),
  originalUrl: z.url().meta({ example: 'https://example.com/very/long/url' }),
  createdAt: z.iso.datetime(),
});

// GET /api/v1/urls query string. Strict: an unknown parameter (a typo such as
// ?sortBy=) is a 400, not silently ignored.
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const listUrlsQuery = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
    sort: z.enum(['createdAt', 'clickCount']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    status: z.enum(['active', 'disabled', 'expired']).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    createdFrom: isoDate.optional().meta({ description: 'Inclusive lower bound on createdAt' }),
    createdTo: isoDate.optional().meta({ description: 'Exclusive upper bound on createdAt' }),
  })
  .refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom < q.createdTo, {
    message: 'createdFrom must be before createdTo',
    path: ['createdFrom'],
  });

// Links are addressed by short code. Anything longer than an alias can be is
// rejected before reaching the database.
export const shortCodeParam = z.strictObject({ shortCode: z.string().min(1).max(64) });

// PATCH: only state the owner may change. The destination URL is fixed:
// letting it change after a link has been shared would allow bait-and-switch
// (share a harmless link, then point it at malware).
export const updateUrlBody = z
  .strictObject({
    isActive: z.boolean().optional(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .nullable()
      .optional()
      .meta({ description: 'New expiry (must be in the future), or null to never expire' }),
  })
  .refine((body) => body.isActive !== undefined || body.expiresAt !== undefined, {
    message: 'Provide at least one of isActive, expiresAt',
  });

export const urlView = z.object({
  shortCode: z.string(),
  shortUrl: z.url(),
  originalUrl: z.url(),
  customAlias: z.string().nullable(),
  status: z.enum(['active', 'disabled', 'expired']),
  isActive: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  clickCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const urlPage = z.object({
  items: z.array(urlView),
  pageInfo: z.object({
    nextCursor: z.string().nullable().meta({ description: 'Pass as ?cursor= for the next page' }),
    hasMore: z.boolean(),
  }),
});
