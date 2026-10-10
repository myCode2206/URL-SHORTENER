import { Prisma, type Url } from '@prisma/client';
import type { IdGenerator } from '../../infrastructure/database/idGenerator';
import { AppError } from '../../utils/errors';
import { normalizeAlias } from './alias';
import { normalizeDestinationUrl } from './destinationUrl';
import { validateExpiry } from './expiry';
import type { RedirectCache } from './redirectCache';
import type { ShortCodeCodec } from './shortCode';
import type { UrlRepository } from './urls.repository';

export interface ShortenInput {
  url: string;
  customAlias?: string;
  expiresAt?: Date;
}

export interface ShortenedUrl {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface UrlServiceDependencies {
  repository: Pick<UrlRepository, 'create'>;
  cache: Pick<RedirectCache, 'set'>;
  idGenerator: IdGenerator;
  codec: ShortCodeCodec;
  baseUrl: string;
  now?: () => Date;
}

// Business rules for short URLs. Knows nothing about HTTP (no req/res) and
// nothing about SQL, so it can be unit-tested with fakes and reused from a
// worker or CLI.
export class UrlService {
  private readonly ownHostname: string;
  private readonly now: () => Date;

  constructor(private readonly deps: UrlServiceDependencies) {
    this.ownHostname = new URL(deps.baseUrl).hostname;
    this.now = deps.now ?? (() => new Date());
  }

  // userId is null for anonymous requests; signed-in users own their links.
  async shorten(input: ShortenInput, userId: string | null): Promise<ShortenedUrl> {
    // Every rule is checked before an ID is reserved or anything is written.
    const originalUrl = normalizeDestinationUrl(input.url, this.ownHostname);
    const customAlias =
      input.customAlias === undefined ? null : this.aliasFor(input.customAlias, userId);
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt) validateExpiry(expiresAt, this.now());

    // Reserve the ID first, so the code is known before the row is written.
    // That costs one extra database round trip, but the row is inserted once,
    // complete, instead of being inserted and then updated with its code.
    const id = await this.deps.idGenerator.nextId();
    const shortCode = this.deps.codec.encode(id);
    const url = await this.insert({ id, shortCode, originalUrl, userId, customAlias, expiresAt });

    // Write-through for every path that reaches the link (the code and, if
    // set, the alias). New links are usually clicked right after being shared,
    // and this also replaces any cached "doesn't exist" for that path; someone
    // may have tried /my-profile before it was claimed.
    const target = {
      id: url.id,
      originalUrl: url.originalUrl,
      expiresAt: url.expiresAt,
      isActive: url.isActive,
    };
    await Promise.all(
      [url.shortCode, url.customAlias]
        .filter((key): key is string => key !== null)
        .map((key) => this.deps.cache.set(key, target)),
    );

    return {
      shortCode: url.shortCode,
      shortUrl: `${this.deps.baseUrl}/${url.customAlias ?? url.shortCode}`,
      originalUrl: url.originalUrl,
      customAlias: url.customAlias,
      expiresAt: url.expiresAt,
      createdAt: url.createdAt,
    };
  }

  // Aliases are a signed-in feature: an anonymous one could never be managed,
  // edited or deleted, and would squat a name forever.
  private aliasFor(input: string, userId: string | null): string {
    if (!userId) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to choose a custom alias');
    }
    return normalizeAlias(input);
  }

  private async insert(url: Parameters<UrlRepository['create']>[0]): Promise<Url> {
    try {
      return await this.deps.repository.create(url);
    } catch (err) {
      // The unique index decides who gets an alias: no "check, then insert"
      // gap where two people can both see it as free. Soft-deleted links keep
      // their alias, so a deleted alias is still taken; otherwise someone else
      // could claim it and take over every place the old link was shared.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        (err.meta?.target as string[] | undefined)?.includes('custom_alias')
      ) {
        throw new AppError(409, 'ALIAS_TAKEN', 'This alias is already taken');
      }
      throw err;
    }
  }
}
