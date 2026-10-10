import argon2 from 'argon2';
import { hashPassword, needsRehash, verifyPassword } from '../../../src/modules/auth/password';

describe('password hashing', () => {
  it('produces an Argon2id hash with the configured parameters, never the password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('salts every hash: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!'),
      hashPassword('same password!'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('treats a malformed stored hash as a mismatch, not a crash', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('flags hashes made with weaker, older parameters for re-hashing', async () => {
    const old = await argon2.hash('pw', { type: argon2.argon2id, memoryCost: 4096, timeCost: 1 });
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash(await hashPassword('pw'))).toBe(false);
  });
});
