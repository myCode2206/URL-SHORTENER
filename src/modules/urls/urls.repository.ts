import { Prisma, type Url } from '@prisma/client';
import type { Database } from '../../infrastructure/database/prisma';
import type { CursorPosition, SortField, SortOrder } from './cursor';

export interface NewUrl {
  id: bigint;
  shortCode: string;
  originalUrl: string;
  // null for links created anonymously.
  userId: string | null;
  customAlias: string | null;
  expiresAt: Date | null;
}

// A redirect is looked up by generated code or by alias, never both. Which one
// a path is follows from its shape (see redirect.service.ts).
export type RedirectLookup = { shortCode: string } | { customAlias: string };

// Everything a redirect needs, and nothing more. Phase 5 caches exactly this
// shape in Redis, so it is kept small.
export interface RedirectTarget {
  id: bigint;
  originalUrl: string;
  expiresAt: Date | null;
  isActive: boolean;
}

// A link as its owner sees it in the management API.
export interface OwnedUrl extends RedirectTarget {
  shortCode: string;
  customAlias: string | null;
  clickCount: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export type UrlStatus = 'active' | 'disabled' | 'expired';

export interface ListOptions {
  limit: number;
  sort: SortField;
  order: SortOrder;
  after?: CursorPosition;
  status?: UrlStatus;
  search?: string;
  createdFrom?: Date;
  createdTo?: Date;
  now: Date;
}

export interface UrlChanges {
  isActive?: boolean;
  expiresAt?: Date | null;
}

const OWNED_FIELDS = {
  id: true,
  shortCode: true,
  originalUrl: true,
  customAlias: true,
  isActive: true,
  expiresAt: true,
  clickCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Column names are only ever taken from these maps, never from user input,
// so they're safe to splice into SQL with Prisma.raw.
const SORT_COLUMNS: Record<SortField, string> = {
  createdAt: 'created_at',
  clickCount: 'click_count',
};

interface OwnedUrlRow {
  id: bigint;
  short_code: string;
  original_url: string;
  custom_alias: string | null;
  is_active: boolean;
  expires_at: Date | null;
  click_count: bigint;
  created_at: Date;
  updated_at: Date;
}

// The only code that knows how URLs are stored. Services call these methods
// and never build queries themselves, so a storage change (a read replica, a
// cache in front, another database) is made here and nowhere else.
export class UrlRepository {
  constructor(private readonly db: Database) {}

  create(url: NewUrl): Promise<Url> {
    return this.db.url.create({ data: url });
  }

  // Soft-deleted URLs are filtered out here, so to the redirect path they are
  // indistinguishable from codes that never existed.
  // Either way it's one unique-index lookup: short_code or custom_alias.
  findRedirectTarget(lookup: RedirectLookup): Promise<RedirectTarget | null> {
    const select = { id: true, originalUrl: true, expiresAt: true, isActive: true } as const;
    return 'shortCode' in lookup
      ? this.db.url.findUnique({ where: { shortCode: lookup.shortCode, deletedAt: null }, select })
      : this.db.url.findUnique({
          where: { customAlias: lookup.customAlias, deletedAt: null },
          select,
        });
  }

  // Ownership is part of every query below (WHERE user_id = ...), not a
  // separate check afterwards, so a bug in a caller can't leak another user's
  // link: someone else's link simply isn't found.
  findOwned(userId: string, shortCode: string): Promise<OwnedUrl | null> {
    return this.db.url.findFirst({
      where: { shortCode, userId, deletedAt: null },
      select: OWNED_FIELDS,
    });
  }

  // Returns the updated link, or null if the user doesn't own a live link with
  // this code.
  async updateOwned(
    userId: string,
    shortCode: string,
    changes: UrlChanges,
  ): Promise<OwnedUrl | null> {
    try {
      return await this.db.url.update({
        where: { shortCode, userId, deletedAt: null },
        data: changes,
        select: OWNED_FIELDS,
      });
    } catch (err) {
      // P2025: no row matched the where clause.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  }

  // Soft delete: the row (and its alias) stays reserved forever; see schema.prisma.
  // Returns the deleted link's paths (code and alias) so the caller can clear
  // both from the cache, or null if the user had no such live link.
  async softDeleteOwned(
    userId: string,
    shortCode: string,
  ): Promise<{ shortCode: string; customAlias: string | null } | null> {
    try {
      return await this.db.url.update({
        where: { shortCode, userId, deletedAt: null },
        data: { deletedAt: new Date() },
        select: { shortCode: true, customAlias: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  }

  // One page of a user's links, using keyset ("cursor") pagination.
  //
  // OFFSET pagination (LIMIT 20 OFFSET 100000) makes Postgres read and discard
  // 100,000 rows to return 20, so every page is slower than the one before.
  // Keyset pagination remembers where the last page ended and asks for rows
  // after that point:
  //
  //   WHERE (created_at, short_code) < ($lastCreatedAt, $lastShortCode)
  //   ORDER BY created_at DESC, short_code DESC LIMIT 21
  //
  // With the index (user_id, created_at DESC, short_code DESC), Postgres jumps
  // straight to that position: page 5,000 costs the same as page 1. It also
  // stays correct while links are added: OFFSET would shift and repeat or skip
  // rows.
  //
  // Fetches limit + 1 rows: the extra one only answers "is there another page?"
  async listForOwner(userId: string, options: ListOptions): Promise<OwnedUrl[]> {
    const column = Prisma.raw(SORT_COLUMNS[options.sort]);
    const direction = Prisma.raw(options.order === 'asc' ? 'ASC' : 'DESC');
    const conditions = [Prisma.sql`user_id = ${userId}::uuid`, Prisma.sql`deleted_at IS NULL`];

    if (options.after) {
      const comparison = Prisma.raw(options.order === 'asc' ? '>' : '<');
      const value =
        options.sort === 'createdAt'
          ? Prisma.sql`${new Date(options.after.value)}::timestamptz`
          : Prisma.sql`${options.after.value}::bigint`;
      conditions.push(
        Prisma.sql`(${column}, short_code) ${comparison} (${value}, ${options.after.shortCode})`,
      );
    }
    if (options.status) conditions.push(statusCondition(options.status, options.now));
    if (options.search) {
      // Wildcards in the search term are escaped, so "50%" matches a literal
      // "50%" rather than "50" followed by anything.
      const pattern = `%${escapeLike(options.search)}%`;
      conditions.push(
        Prisma.sql`(original_url ILIKE ${pattern} OR custom_alias ILIKE ${pattern} OR short_code = ${options.search})`,
      );
    }
    if (options.createdFrom) {
      conditions.push(Prisma.sql`created_at >= ${options.createdFrom}::timestamptz`);
    }
    if (options.createdTo) {
      conditions.push(Prisma.sql`created_at < ${options.createdTo}::timestamptz`);
    }

    const rows = await this.db.$queryRaw<OwnedUrlRow[]>`
      SELECT id, short_code, original_url, custom_alias, is_active, expires_at,
             click_count, created_at, updated_at
      FROM urls
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${column} ${direction}, short_code ${direction}
      LIMIT ${options.limit + 1}`;
    return rows.map(fromRow);
  }
}

function statusCondition(status: UrlStatus, now: Date): Prisma.Sql {
  switch (status) {
    case 'disabled':
      return Prisma.sql`NOT is_active`;
    case 'expired':
      return Prisma.sql`is_active AND expires_at <= ${now}::timestamptz`;
    case 'active':
      return Prisma.sql`is_active AND (expires_at IS NULL OR expires_at > ${now}::timestamptz)`;
  }
}

// LIKE treats % and _ as wildcards and \ as their escape character.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function fromRow(row: OwnedUrlRow): OwnedUrl {
  return {
    id: row.id,
    shortCode: row.short_code,
    originalUrl: row.original_url,
    customAlias: row.custom_alias,
    isActive: row.is_active,
    expiresAt: row.expires_at,
    clickCount: row.click_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
