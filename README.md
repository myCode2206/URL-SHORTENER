# URL Shortener

A URL shortener built to production standards with Node.js, TypeScript, Express, PostgreSQL and Redis. It is built in phases, and each phase is tested before the next one starts. This README grows with the project; the full system-design write-up comes in the final phase.

## Progress

| Phase | Scope                              | Status  |
| ----- | ---------------------------------- | ------- |
| 1     | Project setup, TypeScript, Express | ✅ Done |
| 2     | PostgreSQL and Prisma              | ✅ Done |
| 3     | URL creation and Base62            | ⏳ Next |
| 4     | Redirects                          |         |
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
```

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
│   └── database/          # Prisma client, readiness check, outage detection
├── middleware/            # Request IDs and the central error handler
├── modules/health/        # Liveness and readiness endpoints
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
