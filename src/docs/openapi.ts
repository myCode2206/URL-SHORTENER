import { z } from 'zod';
import type { Config } from '../config/env';
import { loginBody, publicUser, registerBody, sessionResponse } from '../modules/auth/auth.schemas';
import { createUrlBody, shortenedUrl } from '../modules/urls/urls.schemas';

type JsonSchema = Record<string, unknown>;

// Zod 4 emits JSON Schema 2020-12, which is exactly what OpenAPI 3.1 uses, so
// no extra library is needed to document the schemas.
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const result: JsonSchema = { ...z.toJSONSchema(schema, { io }) };
  delete result.$schema;
  delete result.id;
  return result;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function errorResponse(description: string, code: string, message: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: ref('ErrorResponse'),
        example: { success: false, error: { code, message, requestId: '3f0c8a1e-...' } },
      },
    },
  };
}

const serviceUnavailable = errorResponse(
  'A required dependency (e.g. the database) is unavailable. Retry after the Retry-After delay.',
  'SERVICE_UNAVAILABLE',
  'Service is temporarily unavailable',
);

const envelope = (schemaName: string) => ({
  type: 'object',
  properties: { success: { const: true }, data: ref(schemaName) },
  required: ['success', 'data'],
});

const jsonContent = (schema: object) => ({ 'application/json': { schema } });

const unauthorized = errorResponse(
  'Missing, malformed or expired access token (AUTH_REQUIRED, INVALID_TOKEN, TOKEN_EXPIRED)',
  'TOKEN_EXPIRED',
  'Access token has expired; refresh it',
);

const refreshCookieHeader = {
  'Set-Cookie': {
    description:
      'refresh_token: HttpOnly; SameSite=Strict; Path=/api/v1/auth; Secure in production. Never readable by JavaScript.',
    schema: { type: 'string' },
  },
};

const sessionOk = (status: string) => ({
  description: `${status}. The access token is in the body; the refresh token is set as a cookie.`,
  headers: refreshCookieHeader,
  content: jsonContent(envelope('Session')),
});

export function buildOpenApiDocument(config: Config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'URL Shortener API',
      version: config.version,
      description:
        'Shortens URLs into collision-free 7-character codes. All errors share the `ErrorResponse` shape.',
    },
    servers: [{ url: config.baseUrl }],
    tags: [
      { name: 'Auth' },
      { name: 'Users' },
      { name: 'URLs' },
      { name: 'Redirect' },
      { name: 'Health' },
    ],
    paths: {
      '/api/v1/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Create an account and start a session',
          description:
            'Password: 12–128 characters, no composition rules. Stored as an Argon2id hash.',
          requestBody: { required: true, content: jsonContent(ref('RegisterRequest')) },
          responses: {
            201: sessionOk('Account created'),
            400: errorResponse(
              'Invalid email or password too short',
              'VALIDATION_ERROR',
              'Request validation failed',
            ),
            409: errorResponse(
              'Email already registered',
              'EMAIL_TAKEN',
              'An account with this email already exists',
            ),
            503: serviceUnavailable,
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Log in and start a session',
          requestBody: { required: true, content: jsonContent(ref('LoginRequest')) },
          responses: {
            200: sessionOk('Logged in'),
            401: errorResponse(
              'Wrong email or password. Deliberately the same answer for both.',
              'INVALID_CREDENTIALS',
              'Email or password is incorrect',
            ),
            503: serviceUnavailable,
          },
        },
      },
      '/api/v1/auth/refresh': {
        post: {
          tags: ['Auth'],
          summary: 'Get a new access token using the refresh-token cookie',
          description:
            'Rotates the refresh token: the cookie sent is revoked and a new one is set. Sending an already-used refresh token revokes the whole session (theft detection).',
          parameters: [
            { name: 'refresh_token', in: 'cookie', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: sessionOk('Session refreshed'),
            401: errorResponse(
              'Missing, unknown, expired or reused refresh token',
              'INVALID_REFRESH_TOKEN',
              'Session is invalid or has expired; log in again',
            ),
            503: serviceUnavailable,
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'End the session',
          description:
            'Revokes the refresh token (and its whole session) and clears the cookie. Always 204.',
          parameters: [
            { name: 'refresh_token', in: 'cookie', required: false, schema: { type: 'string' } },
          ],
          responses: { 204: { description: 'Logged out' }, 503: serviceUnavailable },
        },
      },
      '/api/v1/users/me': {
        get: {
          tags: ['Users'],
          summary: 'The signed-in user',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Current user', content: jsonContent(envelope('PublicUser')) },
            401: unauthorized,
            503: serviceUnavailable,
          },
        },
      },
      '/api/v1/urls': {
        post: {
          tags: ['URLs'],
          // Either anonymous or signed in; signed-in users own the link.
          security: [{}, { bearerAuth: [] }],
          summary: 'Shorten a URL',
          description:
            'Only public http(s) URLs are accepted: no localhost, private or link-local IPs, embedded credentials, or links to this service.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CreateUrlRequest') } },
          },
          responses: {
            201: {
              description: 'Short URL created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { const: true }, data: ref('ShortenedUrl') },
                    required: ['success', 'data'],
                  },
                },
              },
            },
            401: unauthorized,
            400: errorResponse(
              'Malformed JSON, schema violation (VALIDATION_ERROR) or a URL that is not allowed (INVALID_URL)',
              'INVALID_URL',
              'URLs pointing to private or internal networks are not allowed',
            ),
            413: errorResponse(
              'Body larger than 10kb',
              'PAYLOAD_TOO_LARGE',
              'Request body is too large',
            ),
            503: serviceUnavailable,
          },
        },
      },
      '/{shortCode}': {
        get: {
          tags: ['Redirect'],
          summary: 'Follow a short link',
          description:
            'Redirects to the original URL with 302 and `Cache-Control: no-store`, so every click reaches the server and is counted. Clicks are recorded asynchronously and never delay the redirect. HEAD requests redirect without counting a click. Browsers (Accept: text/html) get an HTML error page instead of JSON.',
          parameters: [
            {
              name: 'shortCode',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^[0-9a-zA-Z]{7}$' },
              example: 'aB7xK2q',
            },
          ],
          responses: {
            302: {
              description: 'Redirect to the original URL (in the Location header)',
              headers: { Location: { schema: { type: 'string', format: 'uri' } } },
            },
            404: errorResponse('No such short URL', 'URL_NOT_FOUND', 'Short URL does not exist'),
            410: errorResponse(
              'The short URL expired (URL_EXPIRED) or was disabled by its owner (URL_DISABLED)',
              'URL_EXPIRED',
              'This short URL has expired',
            ),
            503: serviceUnavailable,
          },
        },
      },
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Liveness: is the process running?',
          responses: { 200: { description: 'The process is up' } },
        },
      },
      '/ready': {
        get: {
          tags: ['Health'],
          summary: 'Readiness: can this instance serve traffic?',
          responses: {
            200: {
              description:
                'Critical dependencies (PostgreSQL) are up. `degraded: true` means an optional one (Redis) is down: still serving, from the database.',
            },
            503: {
              description: 'A critical dependency is down or the instance is shutting down',
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token from register, login or refresh. Expires after 15 minutes.',
        },
      },
      schemas: {
        RegisterRequest: jsonSchema(registerBody, 'input'),
        LoginRequest: jsonSchema(loginBody, 'input'),
        PublicUser: jsonSchema(publicUser, 'output'),
        Session: jsonSchema(sessionResponse, 'output'),
        CreateUrlRequest: jsonSchema(createUrlBody, 'input'),
        ShortenedUrl: jsonSchema(shortenedUrl, 'output'),
        ErrorResponse: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', description: 'Stable, machine-readable error code' },
                message: { type: 'string', description: 'Human-readable explanation' },
                details: { description: 'Field-level problems, for VALIDATION_ERROR' },
                requestId: { type: 'string', description: 'Quote this when reporting a problem' },
              },
            },
          },
        },
      },
    },
  };
}
