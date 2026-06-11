// The keyless bridge — runs in the AGENT-RUNNER. The agent's Claude CLI is pointed at
// ANTHROPIC_BASE_URL=http://127.0.0.1:<port>; this listens there and pipes each TCP
// connection to the worker's proxy unix socket. It carries NO credential — the Anthropic
// key is added worker-side, on the proxy's HTTPS leg to the API, so it never travels over
// this pipe or the unix socket.
//
// It is minimally HTTP-aware on the REQUEST direction only (slice W3-S4b): it stamps the
// current task/org attribution headers into each outgoing request head (see request-stamp.ts)
// so the worker can meter agent token spend per task/org. The RESPONSE direction stays a raw
// byte pipe. Still keyless. Fail-safe: any framing it can't parse degrades that connection to
// a raw pass-through — it never corrupts or stalls the stream.
//
// Per-connection isolation: each agent opens its own TCP connection → its own unix connection
// → its own upstream request at the worker. Concurrent agents never share a stream, so
// responses cannot cross-contaminate; each connection's stamper is independent.

import { createServer, connect, type Socket } from 'node:net';
import { requestStamper, type StampContext } from './request-stamp';

export interface AnthropicBridgeLogger {
  error?(message: string, ctx?: Record<string, unknown>): void;
}

export interface AnthropicBridgeOptions {
  /** Loopback host to listen on. Default '127.0.0.1' (never expose beyond the runner). */
  listenHost?: string;
  /** TCP port for the agent's ANTHROPIC_BASE_URL. 0 → an ephemeral port (read `.port`). */
  listenPort: number;
  /** The worker proxy's unix socket path (shared via a volume). */
  socketPath: string;
  logger?: AnthropicBridgeLogger;
}

export interface AnthropicBridgeHandle {
  /** The bound port (useful when listenPort was 0). */
  port: number;
  /** Set (or clear) the attribution stamped onto subsequent request heads. The runner calls this
   *  before each job; the runner is sequential so one context is live at a time. null → no stamping. */
  setContext(ctx: StampContext | null): void;
  close(): Promise<void>;
}

/** Start the keyless TCP↔unix bridge. Resolves once listening. */
export async function serveAnthropicBridge(options: AnthropicBridgeOptions): Promise<AnthropicBridgeHandle> {
  const host = options.listenHost ?? '127.0.0.1';
  // Shared, settable attribution — read by each connection's stamper at the start of every request.
  // The runner is sequential, so exactly one context is live at a time (no cross-job interleaving).
  let context: StampContext | null = null;
  // Live connections, so close() can tear down in-flight agent connections promptly instead of
  // letting server.close() hang on a long SSE stream at SIGTERM (graceful-shutdown hygiene).
  const teardowns = new Set<() => void>();

  const server = createServer((tcp: Socket) => {
    const up = connect(options.socketPath);
    // REQUEST direction: stamp attribution into each request head (keyless; fail-safe to raw). A
    // fallback to raw means this connection's calls go UNMETERED — logged so that is never silent.
    const stamper = requestStamper(
      () => context,
      (reason) =>
        options.logger?.error?.('anthropic-bridge: request stamping fell back to raw; calls on this connection are unmetered', { reason })
    );
    tcp.pipe(stamper).pipe(up);
    // RESPONSE direction: raw byte pipe — untouched, no parsing, no key.
    up.pipe(tcp);
    const teardown = (): void => {
      teardowns.delete(teardown);
      tcp.destroy();
      up.destroy();
      stamper.destroy();
    };
    teardowns.add(teardown);
    // A failure on any leg tears down both; a clean close on one ends the other.
    tcp.on('error', teardown);
    stamper.on('error', teardown);
    up.on('error', (err) => {
      options.logger?.error?.('anthropic-bridge: upstream socket error', { err: String(err) });
      teardown();
    });
    tcp.on('close', () => up.destroy());
    up.on('close', () => tcp.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(options.listenPort, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.listenPort;

  return {
    port,
    setContext(ctx: StampContext | null): void {
      context = ctx;
    },
    async close(): Promise<void> {
      for (const t of [...teardowns]) t(); // destroy in-flight connections so close() does not hang on a live stream
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
