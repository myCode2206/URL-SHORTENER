-- Hand-written: Prisma's schema language can't express CHECK constraints.
--
-- The application already validates aliases (src/modules/urls/alias.ts). This
-- is defence in depth: whatever writes to the table (a future code path, a
-- script, a manual fix in psql), a malformed alias can't be stored. Only the
-- shape is checked here; the reserved-word and brand rules are policy, which
-- changes more often than a migration should.
--
--   lowercase letters/digits in words joined by single hyphens, 4-32 chars,
--   and never exactly 7 letters/digits (that shape belongs to generated codes)
ALTER TABLE "urls" ADD CONSTRAINT "urls_custom_alias_format" CHECK (
  "custom_alias" IS NULL OR (
    "custom_alias" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND char_length("custom_alias") BETWEEN 4 AND 32
    AND "custom_alias" !~ '^[a-z0-9]{7}$'
  )
);
