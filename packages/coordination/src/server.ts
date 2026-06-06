// The thin HTTP entry (scaffold §6.3 + build step 7). node:http only — no
// Fastify/Express (decoupling constraint: no new runtime deps).
//
//   POST /webhooks/shortcut  → read RAW body → injected WebhookVerifier.verify
//                              + parse → idempotent enqueue (webhook_event) →
//                              run the orchestration off the ack.
//   GET  /healthz            → 200 'ok'.
//
// Fast-ack discipline (scaffold §4.2): verify + dedupe-record synchronously,
// then 202 immediately; the heavy orchestration runs after the response so the
// platform's webhook delivery isn't held open on a full route+execute cycle.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AdapterEvent } from '@tasca/contracts';
import type { CoordinationStore } from './store';
import type { WebhookVerifier } from './ports';
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';

export interface CoordinationServerDeps extends OrchestrationDeps {
  verifier: WebhookVerifier;
  /**
   * Schedules the post-ack orchestration. Defaults to `queueMicrotask` (fire and
   * forget); tests pass a collector to await the work deterministically.
   */
  runAsync?: (work: () => Promise<void>) => void;
}

const MAX_BODY_BYTES = 1_000_000; // reject oversized webhook bodies

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

/**
 * Build the request handler. Exposed separately from `createServer` so it can be
 * unit-tested without binding a socket.
 */
export function createRequestHandler(deps: CoordinationServerDeps) {
  const runAsync = deps.runAsync ?? ((work) => queueMicrotask(() => void work()));

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && req.url === '/webhooks/shortcut') {
      let rawBody: string;
      try {
        rawBody = await readRawBody(req);
      } catch {
        res.writeHead(413).end('payload too large');
        return;
      }

      // Verify the signature over the RAW body BEFORE parsing JSON.
      const verified = deps.verifier.verify({ rawBody, headers: headerMap(req) });
      if (!verified) {
        res.writeHead(401).end('invalid signature');
        return;
      }

      // Idempotent enqueue: a re-delivered event id is a no-op (one task).
      const { fresh } = await deps.store.recordWebhookEvent({
        platform: verified.platform,
        externalEventId: verified.externalEventId,
        payload: verified.payload,
      });
      if (!fresh) {
        res.writeHead(200).end('duplicate');
        return;
      }

      const events: AdapterEvent[] = deps.verifier.parse(verified);

      // Fast-ack: 202 now, orchestrate after the response.
      res.writeHead(202).end('accepted');
      runAsync(async () => {
        for (const event of events) {
          await orchestrateTaskAssigned(event, deps);
        }
      });
      return;
    }

    res.writeHead(404).end('not found');
  };
}

/** Create (but do not start) the node:http coordination server. */
export function createCoordinationServer(deps: CoordinationServerDeps): Server {
  const handle = createRequestHandler(deps);
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
  });
}
