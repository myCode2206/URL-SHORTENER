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

  // Every form below was observed while restarting Postgres under live traffic.
  it.each([
    ['network error passed through from pg', 'ECONNREFUSED'],
    ['server shutting down (SQLSTATE)', '57P01'],
    ['server not accepting connections yet (SQLSTATE)', '57P03'],
    ['connection exception class 08 (SQLSTATE)', '08006'],
  ])('maps %s to 503', (_label, code) => {
    const err = new Prisma.PrismaClientKnownRequestError('db down', { code, clientVersion });
    expect(toAppError(err)).toMatchObject({ statusCode: 503 });
  });

  it('maps a raw query wrapped as P2010 "Database not reachable" to 503', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion,
      meta: { code: 'N/A', message: 'Database not reachable: 127.0.0.1:5432' },
    });
    expect(toAppError(err)).toMatchObject({ statusCode: 503 });
  });

  it('maps an unknown request error carrying an outage SQLSTATE to 503', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError { kind: QueryError(PostgresError { code: "57P03", message: "the database system is shutting down" }) }',
      { clientVersion },
    );
    expect(toAppError(err)).toMatchObject({ statusCode: 503 });
  });

  it.each(['Connection terminated unexpectedly', 'timeout exceeded when trying to connect'])(
    'maps the plain pg error "%s" to 503',
    (message) => {
      expect(toAppError(new Error(message))).toMatchObject({ statusCode: 503 });
    },
  );

  it('does not treat a query error such as a syntax error as an outage', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "42601", message: "syntax error" }',
      { clientVersion },
    );
    expect(toAppError(err)).toMatchObject({ statusCode: 500 });
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
