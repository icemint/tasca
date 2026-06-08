// The broker server — runs in the WORKER (which holds the App key). It listens on a
// unix-domain socket and answers one request per connection: {repoRef} → a repo-scoped
// {token, expiresAt}, by invoking the injected `mint`. The App key is NOT in this
// module; `mint` is the sole credential path and the server only ever serializes the
// token it returns. A unix socket (not TCP) means the boundary is enforced by
// filesystem permissions, with no network surface.

import { createServer, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { isValidRepoRef, type BrokerResponse, type RepoTokenMinter } from './contract';

export interface BrokerLogger {
  info?(message: string, ctx?: Record<string, unknown>): void;
  error?(message: string, ctx?: Record<string, unknown>): void;
}

export interface BrokerServerOptions {
  /** Unix socket path the worker listens on (shared with the runner via a volume). */
  socketPath: string;
  /** Injected scoped-token minter — the only thing here that touches credentials. */
  mint: RepoTokenMinter;
  /** Drop a connection that doesn't complete a request within this many ms. Default 5000. */
  idleTimeoutMs?: number;
  logger?: BrokerLogger;
}

export interface BrokerServerHandle {
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 4096; // a request is a tiny JSON line; cap to bound memory
const IDLE_TIMEOUT_MS = 5000; // drop a connection that doesn't complete a request promptly

/** Start the broker over a unix-domain socket. Resolves once listening. */
export async function serveBroker(options: BrokerServerOptions): Promise<BrokerServerHandle> {
  // Clear a stale socket file from a prior crash so listen() doesn't EADDRINUSE.
  await unlink(options.socketPath).catch(() => {});

  const server = createServer((sock: Socket) => {
    let buf = '';
    let settled = false;
    // EXACTLY-ONE-MINT guard: set the instant a full line is found, BEFORE dispatch,
    // so a request split across two data events can't re-invoke mint (the `settled`
    // flag only gates respond(), and it's still false while the first mint awaits —
    // so without this a partial-then-rest write would mint a second live token).
    let dispatched = false;
    sock.setEncoding('utf8');

    // Idle deadline: a legitimate request is one tiny line sent immediately. A
    // connection that connects and never completes a line is dropped, so a buggy/
    // hostile runner can't accumulate half-open sockets in the worker process. The
    // timer is unref'd so it never keeps the worker alive, and cleared once settled.
    const idle = setTimeout(() => {
      respond({ ok: false, error: 'timeout' });
      sock.destroy();
    }, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    (idle as { unref?: () => void }).unref?.();
    sock.on('close', () => clearTimeout(idle));

    const respond = (resp: BrokerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      sock.end(JSON.stringify(resp) + '\n');
    };

    sock.on('data', (chunk: string) => {
      if (dispatched) return; // one request per connection — ignore anything after
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        respond({ ok: false, error: 'request too large' });
        sock.destroy(); // forcibly close: bound memory + don't hang on a half-open conn
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for a full line
      dispatched = true;
      // .catch so an unexpected throw can't become an unhandledRejection that takes
      // down the worker process the broker runs inside.
      void handleLine(buf.slice(0, nl)).catch((err: unknown) => {
        options.logger?.error?.('broker: handler threw', { err: String(err) });
        respond({ ok: false, error: 'internal error' });
      });
    });
    // A broken connection is not our problem to log loudly; ignore transport errors.
    sock.on('error', () => {});

    const handleLine = async (line: string): Promise<void> => {
      if (settled) return;
      let repoRef: unknown;
      try {
        repoRef = (JSON.parse(line) as { repoRef?: unknown }).repoRef;
      } catch {
        return respond({ ok: false, error: 'invalid request' });
      }
      if (!isValidRepoRef(repoRef)) {
        return respond({ ok: false, error: 'invalid repoRef' });
      }
      let minted;
      try {
        minted = await options.mint(repoRef);
      } catch (err) {
        // Surface a GENERIC error to the wire — never the underlying message (which
        // could carry token/credential detail). Log the detail worker-side only.
        options.logger?.error?.('broker: mint failed', { repoRef, err: String(err) });
        return respond({ ok: false, error: 'mint failed' });
      }
      respond({ ok: true, token: minted.token, expiresAt: minted.expiresAt });
    };
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(options.socketPath, () => {
      server.removeListener('error', onError);
      options.logger?.info?.('broker: listening', { socketPath: options.socketPath });
      resolve();
    });
  });

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => {});
    },
  };
}
