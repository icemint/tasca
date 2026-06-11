// Request-head stamper (slice W3-S4b). The keyless bridge becomes minimally HTTP-aware on the
// REQUEST direction ONLY: it injects Tasca attribution headers (X-Tasca-Task-Id / X-Tasca-Org-Id)
// into each outgoing HTTP/1.1 request head so the worker proxy can meter the agent's token spend
// per task/org. It carries NO credential (unchanged) and never parses the response direction.
//
// Integrity: any agent-supplied X-Tasca-* header is STRIPPED and replaced with the runner's claimed
// context — so on the normal path (agent → bridge → proxy) the agent cannot spoof attribution. (An
// agent that bypasses the bridge and connects to the proxy socket directly can misattribute its OWN
// spend; that is the documented limit — no worse than the keyless-proxied-access worst case of 2b,
// and bounded to the single-tenant-trusted bar until the W4 sandbox lands.)
//
// Framing: handles HTTP/1.1 keep-alive via Content-Length. Any unparseable framing (a chunked request
// body, a missing length on a body method, an oversized head) FAILS SAFE — the connection switches to
// a raw byte pass-through of the ORIGINAL bytes, losing attribution for that connection but NEVER
// corrupting or stalling the request stream.

import { Transform } from 'node:stream';

const CRLFCRLF = Buffer.from('\r\n\r\n');
const MAX_HEAD = 256 * 1024; // cap head accumulation; an agent can't OOM us with an endless header
const STAMP_TASK = 'X-Tasca-Task-Id';
const STAMP_ORG = 'X-Tasca-Org-Id';
// Methods that carry no body — a missing Content-Length on these is normal (frame as empty body).
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

export interface StampContext {
  taskId: string;
  orgId: string;
}

/** Parse the request-head region (request-line + header lines, no trailing CRLF), strip any incoming
 *  X-Tasca-* headers, inject the runner's context (when set), and report the body length. Returns null
 *  on any framing we won't touch — the caller then falls back to a raw pass-through. */
function frameAndStamp(headRegion: Buffer, ctx: StampContext | null): { head: Buffer; contentLength: number } | null {
  const lines = headRegion.toString('latin1').split('\r\n'); // headers are ASCII; latin1 is byte-faithful
  const method = (lines[0]?.split(' ')[0] ?? '').toUpperCase();

  let contentLength: number | null = null;
  let chunked = false;
  const kept: string[] = [lines[0] ?? ''];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const lower = name.trim().toLowerCase();
    if (lower === 'x-tasca-task-id' || lower === 'x-tasca-org-id') continue; // STRIP agent-supplied attribution
    if (lower === 'content-length') {
      const n = Number.parseInt(line.slice(colon + 1).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return null; // malformed length → fail safe
      contentLength = n;
    } else if (lower === 'transfer-encoding' && line.slice(colon + 1).toLowerCase().includes('chunked')) {
      chunked = true;
    }
    kept.push(line);
  }

  if (chunked) return null; // we don't frame chunked request bodies — fail safe to raw
  let bodyLen: number;
  if (contentLength !== null) bodyLen = contentLength;
  else if (BODYLESS.has(method)) bodyLen = 0;
  else return null; // a body method with no length → can't frame the next request safely → raw

  if (ctx) {
    kept.push(`${STAMP_TASK}: ${ctx.taskId}`);
    kept.push(`${STAMP_ORG}: ${ctx.orgId}`);
  }
  return { head: Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'latin1'), contentLength: bodyLen };
}

/** Build the request-direction stamper Transform. `getContext` is read at the START of each request
 *  (so a sequential runner can flip context between jobs); returns null → strip-only, no attribution.
 *  `onFallback` fires once if a connection degrades to raw pass-through (chunked body, missing length,
 *  oversized head) — so the resulting under-metering is observable, never silent. */
export function requestStamper(getContext: () => StampContext | null, onFallback?: (reason: string) => void): Transform {
  let state: 'head' | 'body' | 'raw' = 'head';
  let head: Buffer = Buffer.alloc(0);
  let bodyRemaining = 0;
  const fallback = (self: Transform, reason: string): void => {
    self.push(head); // flush whatever we buffered, UNMODIFIED
    head = Buffer.alloc(0);
    state = 'raw';
    onFallback?.(reason);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      while (buf.length > 0) {
        if (state === 'raw') {
          this.push(buf);
          break;
        }
        if (state === 'body') {
          if (bodyRemaining <= 0) {
            state = 'head';
            head = Buffer.alloc(0);
            continue;
          }
          const n = Math.min(bodyRemaining, buf.length);
          this.push(buf.subarray(0, n));
          bodyRemaining -= n;
          buf = buf.subarray(n);
          if (bodyRemaining === 0) {
            state = 'head';
            head = Buffer.alloc(0);
          }
          continue;
        }
        // state === 'head' — accumulate until the blank-line delimiter, then frame + stamp.
        head = head.length === 0 ? buf : Buffer.concat([head, buf]);
        buf = Buffer.alloc(0);
        const idx = head.indexOf(CRLFCRLF);
        if (idx === -1) {
          if (head.length > MAX_HEAD) fallback(this, 'oversized-head'); // give up parsing — pass raw
          break; // need more bytes (or now raw)
        }
        const framed = frameAndStamp(head.subarray(0, idx), getContext());
        if (!framed) {
          fallback(this, 'unframable-request (chunked body or missing content-length)');
          break;
        }
        const afterHead = head.subarray(idx + 4);
        this.push(framed.head);
        bodyRemaining = framed.contentLength;
        state = 'body';
        head = Buffer.alloc(0);
        buf = afterHead; // continue the loop with the remainder as body / next request
      }
      cb();
    },
  });
}
