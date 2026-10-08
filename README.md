# URL Shortener

A URL shortener built to production standards with Node.js, TypeScript, Express, PostgreSQL and Redis. It is built in phases, and each phase is tested before the next one starts. This README grows with the project; the full system-design write-up comes in the final phase.

## Progress

| Phase | Scope                              | Status  |
| ----- | ---------------------------------- | ------- |
| 1     | Project setup, TypeScript, Express | ✅ Done |
| 2     | PostgreSQL and Prisma              | ✅ Done |
| 3     | URL creation and Base62            | ✅ Done |
| 4     | Redirects                          | ⏳ Next |
| 5     | Redis caching                      |         |
| 6     | Authentication                     |         |
| 7     | URL management                     |         |
| 8     | Expiration and custom aliases      |         |
| 9     | Analytics                          |         |
| 10    | Rate limiting and security         |         |
| 11    | Testing                            |         |
| 12    | Docker                             |         |
| 13    | CI/CD                              |         |
| 14    | AWS deployment                     |         |
| 15    | Load testing and optimization      |         |

## Run it locally

You need Node.js 24 or later and Docker.

```bash
npm install
cp .env.example .env     # then set POSTGRES_PASSWORD and the same password in DATABASE_URL
npm run db:up            # starts PostgreSQL and waits until it is healthy
npm run db:deploy        # applies all migrations
npm run dev              # starts with auto-reload and readable logs
```

Then check it is running:

```bash
curl localhost:3000/health   # is the process alive?
curl localhost:3000/ready    # should it receive traffic? (checks the database)

curl -X POST localhost:3000/api/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/very/long/url"}'
```

Interactive API docs (Swagger UI) are at <http://localhost:3000/docs>, and the raw OpenAPI document is at `/docs/openapi.json`.

## Scripts

| Command                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run dev`              | Runs the TypeScript source directly and restarts on every change      |
| `npm run build`            | Compiles to `dist/`                                                   |
| `npm start`                | Runs the compiled build, as production does                           |
| `npm test`                 | Runs all tests (unit and integration)                                 |
| `npm run test:unit`        | Runs unit tests only; no database needed                              |
| `npm run test:integration` | Runs integration tests against the `<db>_test` database               |
| `npm run typecheck`        | Checks types without writing any files                                |
| `npm run lint`             | Runs ESLint with type-aware rules                                     |
| `npm run format`           | Formats the code with Prettier                                        |
| `npm run db:up`            | Starts PostgreSQL in Docker                                           |
| `npm run db:migrate`       | After editing `schema.prisma`: creates a new migration and applies it |
| `npm run db:deploy`        | Applies pending migrations (what production runs)                     |
| `npm run db:studio`        | Opens Prisma Studio to browse the data                                |

## Project layout

```text
src/
├── config/env.ts          # Reads and validates every environment variable
├── infrastructure/
│   └── database/          # Prisma client, ID generator, readiness check
├── docs/openapi.ts        # OpenAPI 3.1 document, built from the Zod schemas
├── middleware/            # Request IDs and the central error handler
├── modules/
│   ├── health/            # Liveness and readiness endpoints
│   └── urls/              # routes → controller → service → repository
│       ├── shortCode.ts       # ID → scramble (Feistel) → 7-char Base62
│       └── destinationUrl.ts  # URL validation and SSRF rules
├── container.ts           # Composition root: wires concrete implementations
├── utils/                 # Logger and AppError
├── app.ts                 # Builds the Express app; doesn't start a server
└── server.ts              # Starts the server and handles graceful shutdown
prisma/
├── schema.prisma          # Data model; comments explain every index
└── migrations/            # Generated SQL, committed and applied in order
tests/
├── unit/                  # Pure logic, no database
└── integration/           # Real PostgreSQL and HTTP requests via Supertest
```

## Database schema

```text
users                      urls                                clicks
─────                      ────                                ──────
id (uuid v7)  PK  ◄──┐     id (bigint, sequence)  PK  ◄──┐     id (bigint)  PK
email         UNIQUE  └──  user_id  FK, nullable          └──  url_id       FK
password_hash              short_code    UNIQUE                clicked_at
created_at                 custom_alias  UNIQUE, nullable      ip_hash  (never the raw IP)
updated_at                 original_url                        user_agent, referrer
                           expires_at, is_active               country, device, browser, os
                           click_count, deleted_at
                           created_at, updated_at
```

| Index                                     | Query it serves                                     |
| ----------------------------------------- | --------------------------------------------------- |
| `urls(short_code)` unique                 | Redirects, the hot path: `WHERE short_code = ?`     |
| `urls(custom_alias)` unique               | Alias redirects; makes alias claims race-safe (409) |
| `urls(user_id, created_at DESC, id DESC)` | "My URLs, newest first" with cursor pagination      |
| `users(email)` unique                     | Login lookup; one account per email                 |
| `clicks(url_id, clicked_at)`              | Analytics for one URL over a time range             |

Deleting a user deletes their URLs and clicks (`ON DELETE CASCADE`). Deleting a URL through the API is a soft delete (`deleted_at`), so its alias can never be claimed by someone else.

## How short codes are generated

```text
POST /api/v1/urls
  → validate the URL (http/https only, no private IPs, no credentials)
  → id = nextval(urls_id_seq)          e.g. 6
  → permute id with a keyed Feistel network (reversible, so no collisions)
  → Base62-encode to 7 characters      e.g. "Kotrc16"
  → INSERT (id, short_code, original_url)
```

- **No collisions by construction.** The sequence never repeats a value, and both the permutation and Base62 encoding are reversible. No "generate, check, retry" loop is needed.
- **Not guessable.** Consecutive IDs give unrelated codes, so nobody can walk through every link or tell how many exist without `SHORT_CODE_SECRET`.
- **Swappable ID source.** `IdGenerator` is an interface. A Snowflake-style or block-reserving generator can replace the Postgres sequence without touching the service.
- **Capacity.** 62⁷ ≈ 3.5 trillion codes.

## Error format

Every error response has the same shape:

```json
{
  "success": false,
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Cannot GET /nope",
    "requestId": "3f0c..."
  }
}
```

The `requestId` also appears in the `X-Request-Id` response header and in every log line for that request. Quote it in a bug report and the matching logs can be found straight away.
