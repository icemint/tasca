// The Anthropic credential proxy — runs in the WORKER (which holds the Anthropic API
// key). It listens on a unix-domain socket and forwards each HTTP request to the real
// Anthropic API over HTTPS, INJECTING the master key worker-side. The agent (runner side)
// reaches it through a keyless TCP↔unix bridge and never sees the key.
//
// THE INVARIANT (mirrors @tasca/broker): the master key is captured in this closure,
// inside the worker. It is added to the UPSTREAM request only — on the worker→Anthropic
// TLS leg — so it never travels over the unix socket the runner/agent can reach, never
// goes downstream to the client, and is never logged. A prompt-injected agent that finds
// and connects to the socket directly gets keyless PROXIED access (the worst case), not
// the key.
//
// Pure-streaming (no body buffering): the request body is piped up and the response body
// piped down, so a streaming (SSE) response works and a huge prompt can't OOM the worker.
// Each connection is independent (separate req/res + a fresh upstream request), so
// concurrent agents never cross-contaminate streams.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { unlink, chmod } from 'node:fs/promises';
import { usageTee, type AgentCallUsage } from './usage-tee';

/** Where the proxy REPORTS an agent call's usage (slice W3-S4b). The worker supplies an impl that
 *  writes usage_event{org_id, task_id, source:'agent', ...}. A plain callback — the proxy keeps zero
 *  @tasca deps (a leaf). Fire-and-forget: metering must never break or delay the agent's stream. */
export interface AgentUsageSink {
  record(e: AgentCallUsage & { orgId: string; taskId: string }): void;
}

export interface AnthropicProxyLogger {
  info?(message: string, ctx?: Record<string, unknown>): void;
  error?(message: string, ctx?: Record<string, unknown>): void;
}

export interface AnthropicProxyOptions {
  /** Unix socket path the worker listens on (shared with the runner via a volume). */
  socketPath: string;
  /** The master Anthropic API key — captured in this closure, never sent downstream. */
  apiKey: string;
  /** Upstream origin to forward to. Default 'https://api.anthropic.com'. (http:// is
   *  accepted for tests/local upstreams.) The host is FIXED — the agent cannot redirect
   *  the proxy to an arbitrary destination. */
  upstreamOrigin?: string;
  /** chmod the socket after binding (0o660 in deploy: worker binds, group-shared runner
   *  connects, no world). Omitted → Node umask default (owner-only). */
  socketMode?: number;
  /** Per-request upstream timeout. Default 600000ms (long, for streaming completions). */
  requestTimeoutMs?: number;
  /** Usage sink (slice W3-S4b). When present AND the request carries the X-Tasca-Task-Id/Org-Id headers
   *  (stamped by the runner's bridge), the proxy tees the response to extract usage and reports it here.
   *  Absent → no agent metering (the response still streams normally). */
  usageSink?: AgentUsageSink;
  logger?: AnthropicProxyLogger;
}

export interface AnthropicProxyHandle {
  close(): Promise<void>;
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 600_000;

/** A Node header value is `string | string[] | undefined`; collapse to the first string (or undefined). */
function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// The agent must NOT control auth or framing — auth is supplied worker-side, framing is
// recomputed by the upstream client. `x-api-key`/`authorization` are stripped so the
// agent can neither override nor probe the injected credential.
const STRIP_REQUEST_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'host',
  'connection',
  'proxy-authorization',
  'proxy-connection',
  'content-length',
  'transfer-encoding',
  // Tasca-internal attribution headers (slice W3-S4b): read worker-side for metering, then STRIPPED —
  // never forwarded to Anthropic (an internal task/org id is not Anthropic's business).
  'x-tasca-task-id',
  'x-tasca-org-id',
]);

// Hop-by-hop response headers not forwarded to the client.
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Start the Anthropic proxy over a unix-domain socket. Resolves once listening. */
export async function serveAnthropicProxy(options: AnthropicProxyOptions): Promise<AnthropicProxyHandle> {
  const upstream = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM);
  const apiKey = options.apiKey; // closure capture — the ONLY place the key lives here
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestUpstream = upstream.protocol === 'http:' ? httpRequest : httpsRequest;

  // Clear a stale socket from a prior crash so listen() doesn't EADDRINUSE.
  await unlink(options.socketPath).catch(() => {});

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only origin-form paths ("/v1/messages") — reject absolute-form / CONNECT-style
    // targets so the agent can't smuggle a different destination past the fixed host.
    if (!req.url || !req.url.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'bad request target' } }));
      return;
    }

    // Read the attribution headers (slice W3-S4b) BEFORE the strip loop removes them. Both must be
    // present (and a sink wired) to meter this call; otherwise the response just streams normally.
    const taskId = firstHeader(req.headers['x-tasca-task-id']);
    const orgId = firstHeader(req.headers['x-tasca-org-id']);
    const meter = options.usageSink && taskId && orgId ? { sink: options.usageSink, taskId, orgId } : null;

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    headers['host'] = upstream.host;
    headers['x-api-key'] = apiKey; // ← the injection, worker-side, on the upstream leg only

    const upstreamOpts: RequestOptions = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: req.url,
      headers,
      timeout: timeoutMs,
    };

    let upstreamRes: import('node:http').IncomingMessage | undefined;

    const upReq = requestUpstream(upstreamOpts, (upRes) => {
      upstreamRes = upRes;
      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        outHeaders[name] = value;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      // STREAM the response — SSE-safe, no buffering. When metering this call (a runner request with
      // the attribution headers + a sink), interpose a passthrough tee that forwards every byte
      // UNCHANGED and extracts the usage on the side; report it best-effort. A 2xx only (don't meter
      // an error body). The tee can never corrupt/stall the stream (it pushes each chunk as-is).
      const status = upRes.statusCode ?? 502;
      if (meter && status >= 200 && status < 300) {
        const tee = usageTee(firstHeader(upRes.headers['content-type']), (u) => {
          try {
            meter.sink.record({ ...u, orgId: meter.orgId, taskId: meter.taskId });
          } catch (err) {
            options.logger?.error?.('anthropic-proxy: usage sink threw', { err: String(err) });
          }
        });
        tee.on('error', () => res.destroy());
        upRes.pipe(tee).pipe(res);
      } else {
        upRes.pipe(res);
      }
      upRes.on('error', () => res.destroy());
    });

    upReq.on('error', (err) => {
      // GENERIC error downstream — never the key or the underlying detail. Log worker-side.
      options.logger?.error?.('anthropic-proxy: upstream request failed', { err: String(err) });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'upstream request failed' } }));
      } else {
        res.destroy();
      }
    });
    upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')));

    // Client went away (disconnect/abort) BEFORE the response finished → tear down the
    // upstream so it stops streaming (and billing) into a dead socket and the key-bearing
    // upstream TLS connection is released. Mirrors bridge.ts's bidirectional teardown; a
    // normal completion (writableFinished) is skipped. A prompt-injected agent that opens
    // and abandons many streams therefore can't leak/exhaust the worker's upstream sockets.
    res.on('close', () => {
      if (res.writableFinished) return;
      upstreamRes?.destroy();
      upReq.destroy();
    });

    req.pipe(upReq); // STREAM the request body up — no buffering (bounds memory)
    req.on('error', () => upReq.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(options.socketPath, () => {
      server.removeListener('error', onError);
      options.logger?.info?.('anthropic-proxy: listening', { socketPath: options.socketPath });
      resolve();
    });
  });

  if (options.socketMode !== undefined) {
    await chmod(options.socketPath, options.socketMode);
  }

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => {});
    },
  };
}
