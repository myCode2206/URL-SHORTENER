import { z } from 'zod';
import type { Config } from '../config/env';
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
    tags: [{ name: 'URLs' }, { name: 'Health' }],
    paths: {
      '/api/v1/urls': {
        post: {
          tags: ['URLs'],
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
            200: { description: 'All dependencies are up' },
            503: { description: 'A dependency is down or the instance is shutting down' },
          },
        },
      },
    },
    components: {
      schemas: {
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
