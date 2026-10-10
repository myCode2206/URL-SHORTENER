import { AppError } from '../../utils/errors';
import { isShortCodeFormat, SHORT_CODE_LENGTH } from './shortCode';

// Rules for custom aliases (https://sho.rt/my-profile).
//
// Generated codes and aliases share one URL space, so they must never
// overlap: a path of exactly 7 letters/digits is always a generated code, and
// everything else is an alias. An alias may therefore never have that shape.

export const ALIAS_MIN_LENGTH = 4;
export const ALIAS_MAX_LENGTH = 32;

// Lowercase ASCII letters and digits in words joined by single hyphens: no
// leading, trailing or doubled hyphens. ASCII only is also a security rule:
// with Unicode, "pаypal" (Cyrillic а) looks identical to "paypal" (a homoglyph
// attack); with ASCII there are no look-alikes.
const ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Paths the service uses or may use, plus generic words that make a short link
// look like part of the site itself (sho.rt/login, sho.rt/admin).
// prettier-ignore
const RESERVED = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'analytics', 'api', 'app', 'assets',
  'auth', 'billing', 'blog', 'contact', 'dashboard', 'docs', 'download', 'downloads', 'faq',
  'health', 'help', 'home', 'index', 'legal', 'login', 'logout', 'metrics', 'null', 'official',
  'oauth', 'pricing', 'privacy', 'ready', 'register', 'robots', 'root', 'security', 'settings',
  'signin', 'signout', 'signup', 'sitemap', 'static', 'status', 'support', 'system', 'terms',
  'undefined', 'user', 'users', 'webhook', 'webhooks', 'well-known', 'www',
]);

// A short link carries this service's reputation. These catch the most common
// abuse: links that look like they belong to a well-known brand, or that bait
// people into entering credentials (sho.rt/paypal-verify-account). Matching is
// per hyphen-separated word ("apple-id" is blocked, "pineapple" is not). It's a
// first line of defence, not a complete one: real abuse prevention also
// checks the destination's reputation (Phase 10) and has a way to report links.
// prettier-ignore
const IMPERSONATED_BRANDS = [
  'amazon', 'apple', 'binance', 'coinbase', 'facebook', 'gmail', 'google', 'icloud', 'instagram',
  'linkedin', 'metamask', 'microsoft', 'netflix', 'outlook', 'paypal', 'whatsapp',
];
// prettier-ignore
const CREDENTIAL_BAIT = [
  'login', 'logon', 'signin', 'password', 'passwd', 'verify', 'verification', 'wallet',
  'seedphrase', 'recovery', 'unlock', '2fa', 'otp',
];

// Returns the canonical (lowercase) alias, or throws a 400 explaining why the
// alias can't be used.
export function normalizeAlias(input: string): string {
  // Case-insensitive: "My-Profile" and "my-profile" are the same alias, so two
  // people can't hold look-alike links.
  const alias = input.trim().toLowerCase();

  if (alias.length < ALIAS_MIN_LENGTH || alias.length > ALIAS_MAX_LENGTH) {
    throw invalid(`Alias must be ${ALIAS_MIN_LENGTH}–${ALIAS_MAX_LENGTH} characters`);
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw invalid(
      'Alias may contain only letters, digits and single hyphens, and must start and end with a letter or digit',
    );
  }
  if (isShortCodeFormat(alias)) {
    throw invalid(
      `Alias can't be exactly ${SHORT_CODE_LENGTH} letters and digits; that format is reserved for generated links. Add a hyphen or change the length.`,
    );
  }
  if (RESERVED.has(alias)) throw notAllowed('This alias is reserved');

  const words = alias.split('-');
  const startsAny = (terms: string[]) => words.some((w) => terms.some((t) => w.startsWith(t)));
  if (startsAny(IMPERSONATED_BRANDS)) {
    throw notAllowed('Aliases that use well-known brand names are not allowed');
  }
  if (startsAny(CREDENTIAL_BAIT)) {
    throw notAllowed('Aliases that look like sign-in or verification pages are not allowed');
  }
  return alias;
}

// A path segment that could be an alias, checked before any lookup so that
// impossible values never reach Redis or the database.
export function isAliasFormat(value: string): boolean {
  return (
    value.length >= ALIAS_MIN_LENGTH &&
    value.length <= ALIAS_MAX_LENGTH &&
    ALIAS_PATTERN.test(value) &&
    !isShortCodeFormat(value)
  );
}

const invalid = (message: string) => new AppError(400, 'INVALID_ALIAS', message);
const notAllowed = (message: string) => new AppError(400, 'ALIAS_NOT_ALLOWED', message);
