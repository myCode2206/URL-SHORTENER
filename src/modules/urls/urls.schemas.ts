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
