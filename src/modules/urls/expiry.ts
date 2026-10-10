import { AppError } from '../../utils/errors';

// About 10 years. Far enough for any real campaign; a typo like year 20270 is
// almost certainly a mistake worth catching.
const MAX_EXPIRY_MS = 3650 * 24 * 60 * 60 * 1000;

// Shared by link creation and PATCH, so both apply exactly the same rule.
export function validateExpiry(expiresAt: Date, now: Date): void {
  if (expiresAt.getTime() <= now.getTime()) {
    throw new AppError(400, 'INVALID_EXPIRY', 'expiresAt must be in the future');
  }
  if (expiresAt.getTime() - now.getTime() > MAX_EXPIRY_MS) {
    throw new AppError(400, 'INVALID_EXPIRY', 'expiresAt must be within 10 years');
  }
}
