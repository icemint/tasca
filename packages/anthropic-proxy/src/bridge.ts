// The keyless bridge — runs in the AGENT-RUNNER. The agent's Claude CLI is pointed at
// ANTHROPIC_BASE_URL=http://127.0.0.1:<port>; this listens there and RAW-PIPES each TCP
// connection to the worker's proxy unix socket. It carries NO credential and is not even
// HTTP-aware — just bytes. The Anthropic key is added worker-side, on the proxy's HTTPS
// leg to the API, so it never travels over this pipe or the unix socket.
//
// Per-connection isolation: each agent opens its own TCP connection → its own unix
// connection → its own upstream request at the worker. Concurrent agents never share a
// stream, so responses cannot cross-contaminate.

import { createServer, connect, type Socket } from 'node:net';

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
  close(): Promise<void>;
}

/** Start the keyless TCP↔unix bridge. Resolves once listening. */
export async function serveAnthropicBridge(options: AnthropicBridgeOptions): Promise<AnthropicBridgeHandle> {
  const host = options.listenHost ?? '127.0.0.1';

  const server = createServer((tcp: Socket) => {
    const up = connect(options.socketPath);
    // Raw byte pipe both ways — no parsing, no key, nothing to leak.
    tcp.pipe(up);
    up.pipe(tcp);
    const teardown = (): void => {
      tcp.destroy();
      up.destroy();
    };
    // A failure on either leg tears down both; a clean close on one ends the other.
    tcp.on('error', teardown);
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
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
