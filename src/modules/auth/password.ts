import argon2 from 'argon2';

// Argon2id, the winner of the Password Hashing Competition and OWASP's first
// recommendation. Each guess deliberately costs memory as well as CPU: with a
// stolen database, an attacker's GPU can try billions of SHA-256 guesses per
// second, but only a handful of Argon2id guesses, because every one needs its
// own 19 MiB.
//
// Parameters are OWASP's recommended minimum (19 MiB, 2 passes, 1 lane):
// ~15ms on a laptop, a few times that on a small cloud CPU. More memory per
// hash would be stronger, but every concurrent login holds that memory: 16
// simultaneous logins at 64 MiB would need 1 GiB, enough to crash a small
// container. Hashing runs on libuv's thread pool, so it never blocks the event
// loop. The parameters are stored inside each hash, so they can be raised later
// (see needsRehash).
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash is "doesn't match", not a server error.
    return false;
  }
}

// True when a hash was made with older, weaker parameters. Login re-hashes it
// with the current ones, the only moment the plain password is available.
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

// Verified against when the email doesn't exist, so "no such user" takes as
// long as "wrong password". Otherwise response times reveal which emails have
// accounts. The password behind this hash is irrelevant; nobody's account uses it.
export const TIMING_EQUALIZER_HASH = hashPassword('timing-equalizer-not-a-real-password');
