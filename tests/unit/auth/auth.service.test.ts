import { randomUUID } from 'node:crypto';
import { Prisma, type RefreshToken, type User } from '@prisma/client';
import argon2 from 'argon2';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { hashPassword, TIMING_EQUALIZER_HASH } from '../../../src/modules/auth/password';
import type { NewRefreshToken } from '../../../src/modules/auth/refreshTokens.repository';
import { hashRefreshToken } from '../../../src/modules/auth/tokens';
import { createLogger } from '../../../src/utils/logger';
import { testLoggerConfig } from '../../helpers/silentLogger';

// In-memory stand-ins for the two repositories, with the same semantics the
// real ones get from PostgreSQL (unique email, atomic rotate).
function setup() {
  let now = new Date('2026-06-01T12:00:00Z');
  const users = new Map<string, User>();
  const tokens = new Map<string, RefreshToken>();

  const usersRepo = {
    create: jest.fn(async ({ email, passwordHash }: { email: string; passwordHash: string }) => {
      if ([...users.values()].some((u) => u.email === email)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const user = { id: randomUUID(), email, passwordHash, createdAt: now, updatedAt: now };
      users.set(user.id, user);
      return user;
    }),
    findByEmail: jest.fn(
      async (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
    ),
    findById: jest.fn(async (id: string) => users.get(id) ?? null),
    updatePasswordHash: jest.fn(async (id: string, passwordHash: string) => {
      users.set(id, { ...users.get(id)!, passwordHash });
    }),
  };

  const insert = (t: NewRefreshToken) => {
    const row = { ...t, id: randomUUID(), revokedAt: null, createdAt: now };
    tokens.set(row.tokenHash, row);
  };
  const refreshRepo = {
    create: jest.fn(async (t: NewRefreshToken) => insert(t)),
    findByHash: jest.fn(async (hash: string) => tokens.get(hash) ?? null),
    rotate: jest.fn(async (id: string, next: NewRefreshToken) => {
      const current = [...tokens.values()].find((t) => t.id === id);
      if (!current || current.revokedAt) return false;
      current.revokedAt = now;
      insert(next);
      return true;
    }),
    revokeFamily: jest.fn(async (familyId: string) => {
      let count = 0;
      for (const t of tokens.values()) {
        if (t.familyId === familyId && !t.revokedAt) {
          t.revokedAt = now;
          count++;
        }
      }
      return count;
    }),
  };

  const logger = createLogger(testLoggerConfig);
  const warn = jest.spyOn(logger, 'warn');
  const service = new AuthService({
    users: usersRepo,
    refreshTokens: refreshRepo,
    accessTokens: {
      sign: (userId: string) => ({ accessToken: `access-for-${userId}`, expiresIn: 900 }),
    },
    refreshTokenTtlDays: 30,
    logger,
    now: () => now,
  });

  const activeTokens = () => [...tokens.values()].filter((t) => !t.revokedAt);
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { service, users, tokens, usersRepo, refreshRepo, activeTokens, advance, warn };
}

const credentials = { email: 'ada@example.com', password: 'correct horse battery staple' };

describe('register', () => {
  it('stores a hash, never the password, and starts a session', async () => {
    const { service, users } = setup();

    const session = await service.register(credentials);

    const stored = [...users.values()][0]!;
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(credentials.password);
    expect(session.user).toEqual({
      id: stored.id,
      email: 'ada@example.com',
      createdAt: stored.createdAt,
    });
    expect(session.user).not.toHaveProperty('passwordHash');
    expect(session.accessToken).toBe(`access-for-${stored.id}`);
  });

  it('stores only the hash of the refresh token, valid for 30 days', async () => {
    const { service, tokens } = setup();
    const session = await service.register(credentials);

    const row = tokens.get(hashRefreshToken(session.refreshToken))!;
    expect(row).toBeDefined();
    expect([...tokens.keys()]).not.toContain(session.refreshToken);
    expect(session.refreshTokenExpiresAt).toEqual(new Date('2026-07-01T12:00:00Z'));
  });

  it('rejects a second account for the same email with 409', async () => {
    const { service } = setup();
    await service.register(credentials);
    await expect(service.register(credentials)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMAIL_TAKEN',
    });
  });
});

describe('login', () => {
  it('starts a new, independent session with the right password', async () => {
    const { service, activeTokens } = setup();
    const first = await service.register(credentials);

    const second = await service.login(credentials);

    expect(second.user.id).toBe(first.user.id);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(new Set(activeTokens().map((t) => t.familyId)).size).toBe(2);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { service } = setup();
    await service.register(credentials);

    const wrongPassword = service.login({ ...credentials, password: 'wrong password here' });
    const unknownEmail = service.login({ ...credentials, email: 'nobody@example.com' });

    const expected = {
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect',
    };
    await expect(wrongPassword).rejects.toMatchObject(expected);
    await expect(unknownEmail).rejects.toMatchObject(expected);
  });

  it('upgrades a hash made with older, weaker parameters', async () => {
    const { service, users, usersRepo } = setup();
    const { user } = await service.register(credentials);
    users.get(user.id)!.passwordHash = await argon2.hash(credentials.password, {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 1,
    });

    await service.login(credentials);

    expect(usersRepo.updatePasswordHash).toHaveBeenCalledTimes(1);
    expect(users.get(user.id)!.passwordHash).toMatch(/m=19456,p=1,t=2/);
  });

  it('does not rehash a current hash', async () => {
    const { service, usersRepo } = setup();
    await service.register(credentials);
    await service.login(credentials);
    expect(usersRepo.updatePasswordHash).not.toHaveBeenCalled();
  });
});

describe('refresh (rotation)', () => {
  it('swaps the refresh token for a new one in the same session', async () => {
    const { service, tokens, activeTokens } = setup();
    const { refreshToken } = await service.register(credentials);

    const next = await service.refresh(refreshToken);

    expect(next.refreshToken).not.toBe(refreshToken);
    expect(tokens.get(hashRefreshToken(refreshToken))!.revokedAt).not.toBeNull();
    expect(activeTokens()).toHaveLength(1);
    expect(activeTokens()[0]!.familyId).toBe(tokens.get(hashRefreshToken(refreshToken))!.familyId);
  });

  it('detects reuse of an old token and ends the session for everyone', async () => {
    const { service, activeTokens, warn } = setup();
    const stolen = (await service.register(credentials)).refreshToken;
    const legit = (await service.refresh(stolen)).refreshToken; // the owner refreshes

    // The attacker replays the stolen (already used) token.
    await expect(service.refresh(stolen)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });

    // The whole session is gone: even the owner's current token stops working.
    expect(activeTokens()).toHaveLength(0);
    await expect(service.refresh(legit)).rejects.toMatchObject({ statusCode: 401 });
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('reuse detected'));
  });

  it('raises one theft alert, not one per stale token presented afterwards', async () => {
    const { service, warn } = setup();
    const stolen = (await service.register(credentials)).refreshToken;
    const ownersNext = (await service.refresh(stolen)).refreshToken;

    await service.refresh(stolen).catch(() => {}); // reuse: session revoked, alert
    await service.refresh(ownersNext).catch(() => {}); // owner's now-dead token: no alert
    await service.refresh(stolen).catch(() => {}); // replayed again: no alert

    const alerts = warn.mock.calls.filter(([, msg]) => String(msg).includes('reuse detected'));
    expect(alerts).toHaveLength(1);
  });

  it('does not alert on a token from a session that was logged out', async () => {
    const { service, warn } = setup();
    const token = (await service.register(credentials)).refreshToken;
    await service.logout(token);

    await expect(service.refresh(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the user’s other sessions alone when one is revoked', async () => {
    const { service, activeTokens } = setup();
    const laptop = (await service.register(credentials)).refreshToken;
    const phone = (await service.login(credentials)).refreshToken;
    await service.refresh(laptop);
    await service.refresh(laptop).catch(() => {}); // reuse: laptop session revoked

    expect(activeTokens()).toHaveLength(1);
    await expect(service.refresh(phone)).resolves.toBeDefined();
  });

  it('rejects an expired refresh token', async () => {
    const { service, advance } = setup();
    const { refreshToken } = await service.register(credentials);
    advance(30 * 24 * 60 * 60 * 1000);
    await expect(service.refresh(refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });

  it.each([undefined, '', 'never-issued'])(
    'rejects a missing or unknown token %j',
    async (token) => {
      const { service } = setup();
      await expect(service.refresh(token)).rejects.toMatchObject({ statusCode: 401 });
    },
  );

  it('treats losing a race for the same token as reuse', async () => {
    const { service, refreshRepo, activeTokens } = setup();
    const { refreshToken } = await service.register(credentials);
    refreshRepo.rotate.mockResolvedValueOnce(false); // another request rotated it first

    await expect(service.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
    expect(activeTokens()).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes the whole session', async () => {
    const { service, activeTokens } = setup();
    const first = (await service.register(credentials)).refreshToken;
    const current = (await service.refresh(first)).refreshToken;

    await service.logout(current);

    expect(activeTokens()).toHaveLength(0);
  });

  it.each([undefined, 'unknown-token'])('succeeds quietly for %j (idempotent)', async (token) => {
    const { service } = setup();
    await expect(service.logout(token)).resolves.toBeUndefined();
  });
});

it('the hash used for the timing equaliser is a real Argon2id hash', async () => {
  expect(await TIMING_EQUALIZER_HASH).toMatch(/^\$argon2id\$/);
  expect(await hashPassword('x')).not.toBe(await TIMING_EQUALIZER_HASH);
});
