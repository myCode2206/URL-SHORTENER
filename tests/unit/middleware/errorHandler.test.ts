import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { toAppError } from '../../../src/middleware/errorHandler';
import { AppError } from '../../../src/utils/errors';

const clientVersion = 'test';

describe('toAppError', () => {
  it('passes AppErrors through unchanged', () => {
    const err = new AppError(409, 'ALIAS_TAKEN', 'Alias already in use');
    expect(toAppError(err)).toBe(err);
  });

  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])(
    'maps database connectivity error %s to 503',
    (code) => {
      const err = new Prisma.PrismaClientKnownRequestError('db down', { code, clientVersion });
      expect(toAppError(err)).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    },
  );

  it('maps a failed initial connection to 503', () => {
    const err = new Prisma.PrismaClientInitializationError("Can't reach database", clientVersion);
    expect(toAppError(err)).toMatchObject({ statusCode: 503 });
  });

  it('treats other database errors as internal errors without leaking details', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on email', {
      code: 'P2002',
      clientVersion,
    });
    const mapped = toAppError(err);
    expect(mapped).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    expect(mapped.message).not.toContain('email');
  });

  it('turns Zod errors into 400 with field-level details', () => {
    const result = z.object({ url: z.url() }).safeParse({ url: 'nope' });
    expect(toAppError(result.error)).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: [{ field: 'url', message: expect.any(String) }],
    });
  });

  it('hides unexpected errors behind a generic 500', () => {
    const mapped = toAppError(new Error('ECONNRESET at /srv/app/secret.ts:42'));
    expect(mapped).toMatchObject({ statusCode: 500, message: 'An unexpected error occurred' });
  });
});
