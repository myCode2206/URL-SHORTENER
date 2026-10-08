# URL Shortener

A URL shortener built to production standards with Node.js, TypeScript, Express, PostgreSQL and Redis. It is built in phases, and each phase is tested before the next one starts. This README grows with the project; the full system-design write-up comes in the final phase.

## Progress

| Phase | Scope                              | Status  |
| ----- | ---------------------------------- | ------- |
| 1     | Project setup, TypeScript, Express | ✅ Done |
| 2     | PostgreSQL and Prisma              | ⏳ Next |
| 3     | URL creation and Base62            |         |
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

You need Node.js 24 or later.

```bash
npm install
cp .env.example .env
npm run dev          # starts with auto-reload and readable logs
```

Then check it is running:

```bash
curl localhost:3000/health   # is the process alive?
curl localhost:3000/ready    # should it receive traffic?
```

## Scripts

| Command             | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`       | Runs the TypeScript source directly and restarts on every change              |
| `npm run build`     | Compiles to `dist/`                                                           |
| `npm start`         | Runs the compiled build, as production does                                   |
| `npm test`          | Runs all tests (`test:unit` and `test:integration` run each group separately) |
| `npm run typecheck` | Checks types without writing any files                                        |
| `npm run lint`      | Runs ESLint with type-aware rules                                             |
| `npm run format`    | Formats the code with Prettier                                                |

## Project layout

```text
src/
├── config/env.ts          # Reads and validates every environment variable
├── middleware/            # Request IDs and the central error handler
├── modules/health/        # Liveness and readiness endpoints
├── utils/                 # Logger and AppError
├── app.ts                 # Builds the Express app; doesn't start a server
└── server.ts              # Starts the server and handles graceful shutdown
tests/
├── unit/                  # Pure logic, no HTTP
└── integration/           # HTTP requests sent to the app with Supertest
```

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
