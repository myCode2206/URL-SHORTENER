import { z } from 'zod';
import type { Config } from '../config/env';
import { loginBody, publicUser, registerBody, sessionResponse } from '../modules/auth/auth.schemas';
import {
  createUrlBody,
  listUrlsQuery,
  shortenedUrl,
  updateUrlBody,
  urlPage,
  urlView,
} from '../modules/urls/urls.schemas';

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

// Turns a Zod object schema for a query string into OpenAPI parameters, so the
// documented parameters are exactly the ones the endpoint validates.
function queryParameters(schema: z.ZodType) {
  const { properties = {}, required = [] } = jsonSchema(schema, 'input') as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: property,
    ...(typeof property.description === 'string' && { description: property.description }),
  }));
}

const shortCodePath = {
  name: 'shortCode',
  in: 'path',
  required: true,
  description: 'The link’s short code (its identifier throughout the API)',
  schema: { type: 'string', maxLength: 64 },
};

export function buildOpenApiDocument(config: Config) {
  const notOwned = errorResponse(
    'No such link, or it belongs to someone else (deliberately indistinguishable)',
    'URL_NOT_FOUND',
    'Short URL does not exist',
  );

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
        get: {
          tags: ['URLs'],
          summary: 'List your links (cursor pagination)',
          description:
            'Pass `pageInfo.nextCursor` back as `cursor` for the next page; keep the other parameters the same. No total count: counting every matching row would cost as much as reading them.',
          security: [{ bearerAuth: [] }],
          parameters: queryParameters(listUrlsQuery),
          responses: {
            200: { description: 'One page of links', content: jsonContent(envelope('UrlPage')) },
            400: errorResponse(
              'Invalid parameter or cursor',
              'INVALID_CURSOR',
              'Cursor was created for a different sort order',
            ),
            401: unauthorized,
          },
        },
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
      '/api/v1/urls/{shortCode}': {
        parameters: [shortCodePath],
        get: {
          tags: ['URLs'],
          summary: 'One of your links',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'The link', content: jsonContent(envelope('UrlView')) },
            401: unauthorized,
            404: notOwned,
          },
        },
        patch: {
          tags: ['URLs'],
          summary: 'Enable/disable a link or change its expiry',
          description:
            'Takes effect for redirects immediately (the cache entry is overwritten). The destination URL cannot be changed: that would allow bait-and-switch after a link is shared.',
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: jsonContent(ref('UpdateUrlRequest')) },
          responses: {
            200: { description: 'Updated link', content: jsonContent(envelope('UrlView')) },
            400: errorResponse(
              'Invalid body, or expiresAt in the past',
              'INVALID_EXPIRY',
              'expiresAt must be in the future',
            ),
            401: unauthorized,
            404: notOwned,
          },
        },
        delete: {
          tags: ['URLs'],
          summary: 'Delete a link',
          description:
            'Soft delete: redirects return 404 immediately, and the code is never reissued, so a shared link can never start pointing somewhere new.',
          security: [{ bearerAuth: [] }],
          responses: { 204: { description: 'Deleted' }, 401: unauthorized, 404: notOwned },
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
        UrlView: jsonSchema(urlView, 'output'),
        UrlPage: {
          ...jsonSchema(urlPage, 'output'),
          properties: {
            items: { type: 'array', items: ref('UrlView') },
            pageInfo: (jsonSchema(urlPage, 'output').properties as Record<string, unknown>)
              .pageInfo,
          },
        },
        UpdateUrlRequest: jsonSchema(updateUrlBody, 'input'),
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
