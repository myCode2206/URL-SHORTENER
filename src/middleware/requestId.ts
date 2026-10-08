import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HEADER = 'x-request-id';
const SAFE_ID = /^[\w-]{1,128}$/;

// Reuse the ID set upstream (nginx, the load balancer) so one request can be
// traced across every hop; otherwise create one. Incoming values are checked
// because they are attacker-controlled and end up in logs.
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[HEADER];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, id);
  return id;
}
