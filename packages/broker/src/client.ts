// The broker client — runs in the AGENT-RUNNER. It has ONLY the socket path; no App
// key, no GitHubAppClient, no installation id. It connects, asks for a repo-scoped
// token, and gets back {token, expiresAt} or an error. That is the runner's entire
// credential surface.

import { connect, type Socket } from 'node:net';
import type { BrokerResponse, CredentialBroker, RepoToken } from './contract';

export interface BrokerClientOptions {
  socketPath: string;
  /** How long to wait for the broker to answer before giving up. Default 10s. */
  timeoutMs?: number;
}

/** A broker client over the unix socket. */
export function brokerClient(options: BrokerClientOptions): CredentialBroker {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    mintRepoToken(repoRef: string): Promise<RepoToken> {
      return new Promise<RepoToken>((resolve, reject) => {
        const sock: Socket = connect(options.socketPath);
        let buf = '';
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('broker: timed out'))), timeoutMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify({ repoRef }) + '\n'));
        sock.on('data', (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf('\n');
          if (nl === -1) return;
          let resp: BrokerResponse;
          try {
            resp = JSON.parse(buf.slice(0, nl)) as BrokerResponse;
          } catch {
            return finish(() => reject(new Error('broker: malformed response')));
          }
          if (resp.ok && typeof resp.token === 'string' && typeof resp.expiresAt === 'number') {
            const token = resp.token;
            const expiresAt = resp.expiresAt;
            return finish(() => resolve({ token, expiresAt }));
          }
          const error = !resp.ok && typeof resp.error === 'string' ? resp.error : 'broker error';
          finish(() => reject(new Error(error)));
        });
        sock.on('error', (err: Error) => finish(() => reject(err)));
      });
    },
  };
}
