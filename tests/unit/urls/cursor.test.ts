import { decodeCursor, encodeCursor, type CursorPosition } from '../../../src/modules/urls/cursor';
import { escapeLike } from '../../../src/modules/urls/urls.repository';
import { listUrlsQuery } from '../../../src/modules/urls/urls.schemas';

const position: CursorPosition = {
  sort: 'createdAt',
  order: 'desc',
  value: '2026-06-01T12:00:00.000Z',
  shortCode: 'aB7xK2q',
};

describe('cursor', () => {
  it('round-trips a position through an opaque, URL-safe string', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, 'createdAt', 'desc')).toEqual(position);
  });

  it('round-trips a click-count position', () => {
    const clicks = { ...position, sort: 'clickCount' as const, value: '12345' };
    expect(decodeCursor(encodeCursor(clicks), 'clickCount', 'desc')).toEqual(clicks);
  });

  it.each([
    ['for another sort field', 'clickCount', 'desc'],
    ['for another direction', 'createdAt', 'asc'],
  ] as const)('rejects a cursor made %s', (_label, sort, order) => {
    expect(() => decodeCursor(encodeCursor(position), sort, order)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_CURSOR' }),
    );
  });

  it.each([
    'not-base64-json',
    Buffer.from('{"sort":"createdAt"}').toString('base64url'),
    encodeCursor({ ...position, value: 'not a date' }),
    encodeCursor({ ...position, sort: 'clickCount', value: '-1' }),
    Buffer.from(JSON.stringify({ ...position, extra: 1 })).toString('base64url'),
  ])('rejects a malformed or tampered cursor %#', (cursor) => {
    const sort = cursor.includes('clickCount') ? 'clickCount' : 'createdAt';
    expect(() => decodeCursor(cursor, sort, 'desc')).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
});

describe('listUrlsQuery', () => {
  it('applies defaults: newest first, 20 per page', () => {
    expect(listUrlsQuery.parse({})).toEqual({ limit: 20, sort: 'createdAt', order: 'desc' });
  });

  it('coerces query-string values', () => {
    const q = listUrlsQuery.parse({ limit: '50', createdFrom: '2026-01-01T00:00:00Z' });
    expect(q.limit).toBe(50);
    expect(q.createdFrom).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it.each([
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ sort: 'originalUrl' }],
    [{ status: 'deleted' }],
    [{ sortBy: 'createdAt' }], // unknown parameter (typo)
    [{ createdFrom: 'yesterday' }],
    [{ createdFrom: '2026-02-01T00:00:00Z', createdTo: '2026-01-01T00:00:00Z' }],
  ])('rejects %j', (query) => {
    expect(listUrlsQuery.safeParse(query).success).toBe(false);
  });
});

describe('escapeLike', () => {
  it.each([
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['plain text', 'plain text'],
  ])('%j → %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});
