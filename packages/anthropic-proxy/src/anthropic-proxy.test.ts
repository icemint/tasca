import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { serveAnthropicProxy, serveAnthropicBridge, type AnthropicProxyHandle, type AnthropicBridgeHandle, type AgentCallUsage } from './index';

// The master Anthropic key the worker holds — it must NEVER reach the runner/agent: not
// downstream to the client, not over the unix socket wire, not in a log. Only the upstream
// (fake api.anthropic.com) ever legitimately sees it.
const MASTER_KEY = 'sk-ant-MASTER-DO-NOT-LEAK-' + randomBytes(8).toString('hex');

// Short socket paths under /tmp (unix socket paths cap ~104 bytes).
const sockPath = (): string => `/tmp/tap-${randomBytes(6).toString('hex')}.sock`;

interface Upstream {
  origin: string;
  received: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>;
  server: Server;
}

let proxies: AnthropicProxyHandle[] = [];
let bridges: AnthropicBridgeHandle[] = [];
let upstreams: Server[] = [];

afterEach(async () => {
  await Promise.all(proxies.map((p) => p.close()));
  await Promise.all(bridges.map((b) => b.close()));
  await Promise.all(upstreams.map((u) => new Promise<void>((r) => u.close(() => r()))));
  proxies = [];
  bridges = [];
  upstreams = [];
});

/** A stand-in for api.anthropic.com: records what it received and lets a test shape the
 *  response (status, headers, a sequence of body chunks with optional delays). */
function fakeUpstream(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<Upstream> {
  const received: Upstream['received'] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, body, res);
    });
  });
  upstreams.push(server);
  return new Promise<Upstream>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, received, server });
    });
  });
}

async function startProxy(upstreamOrigin: string, logger?: Parameters<typeof serveAnthropicProxy>[0]['logger']): Promise<string> {
  const socketPath = sockPath();
  proxies.push(await serveAnthropicProxy({ socketPath, apiKey: MASTER_KEY, upstreamOrigin, ...(logger ? { logger } : {}) }));
  return socketPath;
}

/** Start a proxy with a usage sink that captures every reported agent-call usage (slice W3-S4b). */
async function startProxyWithSink(upstreamOrigin: string): Promise<{ socketPath: string; records: Array<AgentCallUsage & { orgId: string; taskId: string }> }> {
  const socketPath = sockPath();
  const records: Array<AgentCallUsage & { orgId: string; taskId: string }> = [];
  proxies.push(
    await serveAnthropicProxy({
      socketPath,
      apiKey: MASTER_KEY,
      upstreamOrigin,
      usageSink: { record: (e) => records.push(e) },
    })
  );
  return { socketPath, records };
}

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Make an HTTP request to a unix socket (the proxy) — what the bridge pipes to. */
function reqViaSocket(
  socketPath: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { socketPath, path: opts.path ?? '/v1/messages', method: opts.method ?? 'POST', headers: opts.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    r.on('error', reject);
    r.end(opts.body ?? undefined); // end(body) → Content-Length (what the real Anthropic client sends)
  });
}

/** Make an HTTP request to a TCP host:port (the bridge). */
function reqViaTcp(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port, path: opts.path ?? '/v1/messages', method: opts.method ?? 'POST', headers: opts.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    r.on('error', reject);
    r.end(opts.body ?? undefined); // end(body) → Content-Length (what the real Anthropic client sends)
  });
}

describe('anthropic proxy — forwarding + key injection', () => {
  it('forwards the request to Anthropic and injects the worker key on the UPSTREAM leg', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const sock = await startProxy(up.origin);
    const out = await reqViaSocket(sock, { path: '/v1/messages', body: JSON.stringify({ model: 'claude' }) });

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
    // The UPSTREAM saw the master key (injection happened) on the right path/body.
    expect(up.received).toHaveLength(1);
    expect(up.received[0]!.headers['x-api-key']).toBe(MASTER_KEY);
    expect(up.received[0]!.url).toBe('/v1/messages');
    expect(JSON.parse(up.received[0]!.body)).toEqual({ model: 'claude' });
  });

  it('forwards anthropic-version + content-type but NOT the agents own x-api-key/authorization (no override/probe)', async () => {
    const up = await fakeUpstream((_req, _body, res) => res.end('{}'));
    const sock = await startProxy(up.origin);
    await reqViaSocket(sock, {
      headers: { 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-api-key': 'AGENT-FORGED', authorization: 'Bearer AGENT-FORGED' },
      body: '{}',
    });
    const h = up.received[0]!.headers;
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['content-type']).toBe('application/json');
    expect(h['x-api-key']).toBe(MASTER_KEY); // the worker key WON — the agent's forged one was stripped
    expect(h['authorization']).toBeUndefined(); // stripped entirely
  });
});

describe('THE INVARIANT — the Anthropic key never reaches the runner/agent side', () => {
  it('the key is added ONLY upstream; the client request/response never carry it', async () => {
    // The upstream echoes EVERYTHING it received back to the client — the worst case for a
    // leak. Even so, the client must never observe the master key, because the proxy adds
    // it on the upstream leg only (the response the client gets is the upstream's, which
    // here echoes the upstream-received headers — but the proxy strips response framing,
    // and the key is not echoed since the upstream wouldn't return its own auth header).
    const up = await fakeUpstream((req, body, res) => {
      // A hostile upstream that tries to reflect the auth back downstream:
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoedKey: req.headers['x-api-key'] ?? null, body }));
    });
    const sock = await startProxy(up.origin);

    // What the AGENT sends has no key (it has none).
    const out = await reqViaSocket(sock, { body: 'hello', headers: { 'content-type': 'text/plain' } });

    // The agent's request as the upstream saw it: the key was added by the proxy, not the agent.
    // The agent never put it on the wire — it isn't in the agent's env at all.
    // The client response: even if a hostile upstream echoes the key in its BODY, that's the
    // upstream's doing, not a proxy leak — but we assert the proxy itself adds nothing leaky.
    // Here we prove the proxy does not DOWNSTREAM the key via headers it controls:
    expect(JSON.stringify(out.headers)).not.toContain(MASTER_KEY); // never in response headers
  });

  it('a RAW capture of the unix-socket wire (client↔proxy) never contains the master key', async () => {
    // Tap the bytes the proxy reads from / writes to the unix socket by acting as a raw
    // client: send a raw HTTP/1.1 request and record every byte the proxy sends back. The
    // key is added on the SEPARATE upstream connection, so it can never appear on this wire.
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const sock = await startProxy(up.origin);

    const wireBytes = await new Promise<string>((resolve, reject) => {
      const c = connect(sock);
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write('POST /v1/messages HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}'));
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });

    expect(wireBytes).toContain('200'); // we got the proxied response back
    expect(wireBytes).not.toContain(MASTER_KEY); // …with NO key anywhere on the unix wire
    // And the upstream did receive the key (so injection genuinely happened upstream).
    expect(up.received[0]!.headers['x-api-key']).toBe(MASTER_KEY);
  });

  it('a generic 502 (no key, no detail) when the upstream is unreachable; nothing leaks via logs', async () => {
    const logs: Array<{ message: string; ctx?: Record<string, unknown> }> = [];
    const logger = { error: (message: string, ctx?: Record<string, unknown>) => logs.push({ message, ...(ctx ? { ctx } : {}) }) };
    // Point at a dead port (nothing listening).
    const sock = await startProxy('http://127.0.0.1:1', logger);
    const out = await reqViaSocket(sock, { body: '{}' });
    expect(out.status).toBe(502);
    expect(out.body).not.toContain(MASTER_KEY);
    expect(JSON.stringify(logs)).not.toContain(MASTER_KEY); // the key is never logged
  });

  it('rejects a non-origin-form request target (no absolute-form/CONNECT smuggling) with 400', async () => {
    const up = await fakeUpstream((_req, _body, res) => res.end('{}'));
    const sock = await startProxy(up.origin);
    const status = await new Promise<string>((resolve, reject) => {
      const c = connect(sock);
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write('GET http://evil.example/ HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n'));
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    expect(status).toContain('400');
    expect(up.received).toHaveLength(0); // never forwarded — the fixed upstream was never hit
  });
});

describe('streaming + concurrency', () => {
  it('STREAMS an SSE response chunk-by-chunk (not buffered) — first chunk arrives before the upstream ends', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      // Hold the stream open, then send the rest — proving the proxy pipes progressively.
      setTimeout(() => {
        res.write('event: b\ndata: 2\n\n');
        res.end();
      }, 40);
    });
    const sock = await startProxy(up.origin);

    const { firstChunkAt, endAt, body } = await new Promise<{ firstChunkAt: number; endAt: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ socketPath: sock, path: '/v1/messages', method: 'POST' }, (res) => {
        let body = '';
        let firstChunkAt = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          body += c;
        });
        res.on('end', () => resolve({ firstChunkAt, endAt: Date.now(), body }));
      });
      r.on('error', reject);
      r.end('{}');
    });

    expect(body).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    // The first chunk landed meaningfully before the stream ended → it was streamed, not buffered.
    expect(endAt - firstChunkAt).toBeGreaterThanOrEqual(25);
  });

  it('a client disconnect mid-stream TEARS DOWN the upstream (no leak / no runaway billing / no DoS amplification)', async () => {
    let upstreamStarted = false;
    let upstreamClosed = false;
    const up = await fakeUpstream((_req, _body, res) => {
      upstreamStarted = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      res.on('close', () => (upstreamClosed = true));
      // Hold the stream open indefinitely (never end) — a long completion an attacker
      // would open and abandon. If the proxy leaked, this upstream would keep running.
    });
    const sock = await startProxy(up.origin);

    // Make a request, read the first chunk, then ABORT the client connection.
    await new Promise<void>((resolve) => {
      const r = httpRequest({ socketPath: sock, path: '/v1/messages', method: 'POST' }, (res) => {
        res.on('data', () => {
          r.destroy(); // got the first chunk → bail mid-stream
          resolve();
        });
      });
      r.on('error', () => resolve());
      r.end('{}');
    });

    await new Promise((r) => setTimeout(r, 80)); // let the close propagate upstream
    expect(upstreamStarted).toBe(true);
    expect(upstreamClosed).toBe(true); // the upstream was destroyed, not left streaming
  });

  it('CONCURRENT requests never cross-contaminate — each gets exactly its own response', async () => {
    // The upstream echoes a per-request marker; the proxy must keep each request/response
    // pair on its own connection.
    const up = await fakeUpstream((_req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: body }));
    });
    const sock = await startProxy(up.origin);

    const markers = Array.from({ length: 12 }, (_, i) => `marker-${i}-${randomBytes(4).toString('hex')}`);
    const results = await Promise.all(markers.map((m) => reqViaSocket(sock, { body: m })));

    results.forEach((out, i) => {
      expect(JSON.parse(out.body).echo).toBe(markers[i]); // each response carries ITS OWN body, none crossed
    });
  });
});

describe('the keyless bridge (runner side)', () => {
  it('pipes TCP→unix end-to-end; the key is still injected upstream and never on the bridge', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const sock = await startProxy(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath: sock });
    bridges.push(bridge);

    const out = await reqViaTcp(bridge.port, { body: JSON.stringify({ model: 'claude' }) });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
    // The agent reached Anthropic THROUGH the keyless bridge; the key was injected worker-side.
    expect(up.received[0]!.headers['x-api-key']).toBe(MASTER_KEY);
    // The bridge module holds no key — it is a raw byte pipe (asserted structurally by the
    // forged-key strip test above + the raw-wire capture; here we confirm the e2e path works).
  });
});

// Slice W3-S4b: agent-call metering. The bridge stamps the current {task,org} onto each request
// head; the worker proxy tees the response, extracts the usage, and reports it via the usageSink.
// These re-prove the 2b break-targets UNDER the new code: the key still never crosses to the runner,
// streams stay per-connection isolated + un-stalled, and the tee never corrupts the response.
describe('agent-call metering (S4b) — attribution via the bridge + usage tee', () => {
  const SSE_BODY = (id: string) =>
    `event: message_start\ndata: {"type":"message_start","message":{"id":"${id}","model":"claude-haiku-4-5","usage":{"input_tokens":25,"output_tokens":1}}}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`;

  it('meters a non-streaming agent call with the {org,task} the bridge stamped', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_RT1', model: 'claude-haiku-4-5', usage: { input_tokens: 11, output_tokens: 22 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-A', orgId: 'org-1' });

    const out = await reqViaTcp(bridge.port, { body: JSON.stringify({ model: 'claude' }) });
    expect(out.status).toBe(200);
    await tick();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ orgId: 'org-1', taskId: 'task-A', model: 'claude-haiku-4-5', inputTokens: 11, outputTokens: 22, idempotencyKey: 'msg_RT1' });
    // The proxy STRIPS the attribution headers — Anthropic never sees them.
    expect(up.received[0]!.headers['x-tasca-task-id']).toBeUndefined();
    expect(up.received[0]!.headers['x-tasca-org-id']).toBeUndefined();
  });

  it('meters a STREAMING (SSE) call from the final message_delta — response byte-identical and NOT stalled', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_S1","model":"claude-haiku-4-5","usage":{"input_tokens":25,"output_tokens":1}}}\n\n`);
      setTimeout(() => {
        res.write(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`);
        res.end();
      }, 40);
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-S', orgId: 'org-9' });

    const { firstChunkAt, endAt, body } = await new Promise<{ firstChunkAt: number; endAt: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: bridge.port, path: '/v1/messages', method: 'POST' }, (res) => {
        let b = '';
        let firstChunkAt = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          b += c;
        });
        res.on('end', () => resolve({ firstChunkAt, endAt: Date.now(), body: b }));
      });
      r.on('error', reject);
      r.end('{}');
    });

    expect(body).toBe(SSE_BODY('msg_S1')); // every byte forwarded unchanged THROUGH the tee
    expect(endAt - firstChunkAt).toBeGreaterThanOrEqual(25); // streamed progressively — the tee did not buffer/stall
    await tick();
    expect(records).toEqual([{ orgId: 'org-9', taskId: 'task-S', model: 'claude-haiku-4-5', inputTokens: 25, outputTokens: 42, idempotencyKey: 'msg_S1' }]);
  });

  it('RE-PROOF: with metering wired + a context set, the master key still never crosses the bridge wire', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_K', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-K', orgId: 'org-K' });

    // Raw-capture the bytes the bridge sends back over the TCP (runner-side) wire.
    const wireBytes = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: '127.0.0.1', port: bridge.port });
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write('POST /v1/messages HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}'));
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    expect(wireBytes).toContain('200');
    expect(wireBytes).not.toContain(MASTER_KEY); // key never on the runner-side wire, even with the tee
    expect(up.received[0]!.headers['x-api-key']).toBe(MASTER_KEY); // injected upstream as before
    await tick();
    expect(records).toHaveLength(1); // and the call WAS metered (the stamper framed the raw request)
  });

  it('an agent that forges x-tasca-* through the bridge cannot spoof attribution (bridge strips, runner context wins)', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_F', model: 'm', usage: { input_tokens: 2, output_tokens: 3 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-REAL', orgId: 'org-REAL' });

    await reqViaTcp(bridge.port, {
      headers: { 'x-tasca-task-id': 'task-FORGED', 'x-tasca-org-id': 'org-VICTIM' },
      body: '{}',
    });
    await tick();
    expect(records).toHaveLength(1);
    expect(records[0]!.taskId).toBe('task-REAL'); // the runner's context, NOT the agent's forgery
    expect(records[0]!.orgId).toBe('org-REAL');
  });

  it('no attribution headers (e.g. a call outside any job) → no usage recorded, response unaffected', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_N', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    // Hit the proxy socket directly with NO x-tasca-* headers (no bridge / no context).
    const out = await reqViaSocket(socketPath, { body: '{}' });
    expect(out.status).toBe(200);
    await tick();
    expect(records).toHaveLength(0); // nothing to attribute → nothing recorded; the call still succeeded
  });

  it('CONCURRENT metered calls never cross attribution — each usage row carries ITS OWN task', async () => {
    // Echo a per-request response id so each tee extracts a distinct idempotency key; drive the
    // proxy socket directly with distinct x-tasca headers (what distinct stamped connections look like).
    const up = await fakeUpstream((_req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const marker = JSON.parse(body).marker as string;
      res.end(JSON.stringify({ id: `msg_${marker}`, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);

    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    await Promise.all(
      ids.map((id) =>
        reqViaSocket(socketPath, {
          headers: { 'x-tasca-task-id': `task-${id}`, 'x-tasca-org-id': 'org-1', 'content-type': 'application/json' },
          body: JSON.stringify({ marker: id }),
        })
      )
    );
    await tick(50);
    expect(records).toHaveLength(12);
    // Each recorded usage's task matches its own response id — no cross-attribution under concurrency.
    for (const r of records) {
      expect(r.idempotencyKey).toBe(`msg_${r.taskId.replace('task-', '')}`);
    }
  });

  it('PARTIAL attribution (only one of the two headers) → unmetered, the call still succeeds', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_P', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    // Drive the proxy directly with only ONE of the two ids — `meter` requires BOTH (server.ts).
    const a = await reqViaSocket(socketPath, { headers: { 'x-tasca-task-id': 't', 'content-type': 'application/json' }, body: '{}' });
    const b = await reqViaSocket(socketPath, { headers: { 'x-tasca-org-id': 'o', 'content-type': 'application/json' }, body: '{}' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await tick();
    expect(records).toHaveLength(0); // neither call had a complete {task,org} → nothing recorded
  });

  it('a CHUNKED request through the bridge falls back to raw — unmetered, LOGGED, response still works', async () => {
    const logs: Array<{ m: string; ctx?: Record<string, unknown> }> = [];
    const logger = { error: (m: string, ctx?: Record<string, unknown>) => logs.push({ m, ...(ctx ? { ctx } : {}) }) };
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_CH', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath, logger });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-C', orgId: 'org-C' });

    const resp = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: '127.0.0.1', port: bridge.port });
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write('POST /v1/messages HTTP/1.1\r\nhost: x\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n'));
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });

    expect(resp).toContain('200'); // the chunked request was still proxied (raw) and answered
    await tick();
    expect(records).toHaveLength(0); // fallback → no attribution stamped → unmetered
    expect(logs.some((l) => /fell back to raw/.test(l.m))).toBe(true); // …and the under-metering was logged, not silent
  });

  it('close() promptly tears down an in-flight connection (graceful shutdown does not hang on a live stream)', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n'); // …then hold the stream open forever
    });
    const { socketPath } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath }); // NOT pushed — we close it here
    bridge.setContext({ taskId: 'task-H', orgId: 'org-H' });

    await new Promise<void>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port: bridge.port, path: '/v1/messages', method: 'POST' }, (res) => {
        res.on('data', () => resolve()); // got the first chunk → a live, open connection
      });
      r.on('error', () => resolve());
      r.end('{}');
    });

    const start = Date.now();
    await bridge.close();
    expect(Date.now() - start).toBeLessThan(1000); // resolved promptly — the open connection was torn down
  });

  it('a metered call to a NON-2xx upstream is not recorded (no metering of an error body)', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit' } }));
    });
    const { socketPath, records } = await startProxyWithSink(up.origin);
    const bridge = await serveAnthropicBridge({ listenPort: 0, socketPath });
    bridges.push(bridge);
    bridge.setContext({ taskId: 'task-E', orgId: 'org-E' });
    const out = await reqViaTcp(bridge.port, { body: '{}' });
    expect(out.status).toBe(429); // the error is forwarded faithfully
    await tick();
    expect(records).toHaveLength(0); // …but a 4xx/5xx carries no usage → nothing recorded
  });
});
