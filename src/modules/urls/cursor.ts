import { z } from 'zod';
import { AppError } from '../../utils/errors';

export type SortField = 'createdAt' | 'clickCount';
export type SortOrder = 'asc' | 'desc';

// Where the previous page ended: the last item's sort value plus its short code,
// which breaks ties (two links created in the same millisecond, or with the
// same click count). The next page starts strictly after this position.
export interface CursorPosition {
  sort: SortField;
  order: SortOrder;
  // ISO timestamp for createdAt, decimal string for clickCount.
  value: string;
  shortCode: string;
}

const cursorSchema = z.strictObject({
  sort: z.enum(['createdAt', 'clickCount']),
  order: z.enum(['asc', 'desc']),
  value: z.string().max(40),
  shortCode: z.string().max(64),
});

// Opaque to clients: they pass back exactly what they were given. Encoding it
// means the server can change what's inside without breaking any client.
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodeCursor(cursor: string, sort: SortField, order: SortOrder): CursorPosition {
  let position: CursorPosition;
  try {
    position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw invalidCursor('Cursor is malformed');
  }
  // A cursor is a position in one particular ordering; in another it means nothing.
  if (position.sort !== sort || position.order !== order) {
    throw invalidCursor('Cursor was created for a different sort order');
  }
  const valueOk =
    sort === 'createdAt' ? !Number.isNaN(Date.parse(position.value)) : /^\d+$/.test(position.value);
  if (!valueOk) throw invalidCursor('Cursor is malformed');
  return position;
}

const invalidCursor = (message: string) => new AppError(400, 'INVALID_CURSOR', message);
