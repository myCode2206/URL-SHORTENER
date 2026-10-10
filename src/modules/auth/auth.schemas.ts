import { z } from 'zod';

// Emails are compared case-insensitively: "Ada@Example.com" and
// "ada@example.com" are one account. They're normalised here, before anything
// else sees them.
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// OWASP ASVS: at least 12 characters, no composition rules ("one uppercase,
// one symbol..."); length matters more, and composition rules push people toward
// predictable patterns like "Password1!". Capped at 128 so a huge password
// can't be used to burn server CPU. Not trimmed: spaces may be deliberate.
export const PASSWORD_MIN_LENGTH = 12;
const newPassword = z.string().min(PASSWORD_MIN_LENGTH).max(128);

export const registerBody = z.strictObject({
  email: email.meta({ example: 'ada@example.com' }),
  password: newPassword.meta({ example: 'correct horse battery staple' }),
});

// Login doesn't validate the email format or password rules: any wrong input
// gets the same INVALID_CREDENTIALS answer, rather than hints about what an
// account looks like.
export const loginBody = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(254).meta({ example: 'ada@example.com' }),
  password: z.string().min(1).max(128).meta({ example: 'correct horse battery staple' }),
});

export const publicUser = z.object({
  id: z.uuid(),
  email: z.email(),
  createdAt: z.iso.datetime(),
});

export const sessionResponse = z.object({
  user: publicUser,
  accessToken: z.string().meta({ description: 'JWT. Send as `Authorization: Bearer <token>`' }),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().meta({ description: 'Seconds until the access token expires' }),
});
