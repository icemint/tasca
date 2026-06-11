import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { requestStamper, type StampContext } from './request-stamp';

/** Pipe `input` through a stamper whose context is `ctx`, return the rewritten bytes. */
async function stamp(input: Buffer, ctx: StampContext | null): Promise<Buffer> {
  const t = requestStamper(() => ctx);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    t.on('data', (c: Buffer) => chunks.push(c));
    t.on('end', resolve);
    t.on('error', reject);
    Readable.from([input]).pipe(t);
  });
  return Buffer.concat(chunks);
}

const CTX: StampContext = { taskId: 'task-42', orgId: 'org-7' };

function req(method: string, body: string, extraHeaders: string[] = []): Buffer {
  const lines = [`${method} /v1/messages HTTP/1.1`, 'host: x', ...extraHeaders];
  if (body.length > 0 || method === 'POST') lines.push(`content-length: ${Buffer.byteLength(body)}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body);
}

describe('requestStamper — injects attribution into each request head', () => {
  it('adds X-Tasca-Task-Id / X-Tasca-Org-Id and preserves the body byte-for-byte', async () => {
    const body = JSON.stringify({ model: 'claude', messages: [] });
    const out = (await stamp(req('POST', body), CTX)).toString('latin1');
    expect(out).toContain('X-Tasca-Task-Id: task-42\r\n');
    expect(out).toContain('X-Tasca-Org-Id: org-7\r\n');
    expect(out.endsWith('\r\n\r\n' + body)).toBe(true); // body unchanged, framing intact
    // The original headers survive.
    expect(out).toContain('POST /v1/messages HTTP/1.1\r\n');
    expect(out).toContain('host: x\r\n');
  });

  it('STRIPS any agent-supplied X-Tasca-* and replaces it with the runner context (no spoofing)', async () => {
    const out = (
      await stamp(req('POST', '{}', ['x-tasca-task-id: FORGED-BY-AGENT', 'x-tasca-org-id: OTHER-ORG']), CTX)
    ).toString('latin1');
    expect(out).not.toContain('FORGED-BY-AGENT');
    expect(out).not.toContain('OTHER-ORG');
    expect(out).toContain('X-Tasca-Task-Id: task-42\r\n');
    expect(out).toContain('X-Tasca-Org-Id: org-7\r\n');
    // Exactly one of each (the agent's was removed, not appended-to).
    expect(out.match(/x-tasca-task-id/gi)).toHaveLength(1);
    expect(out.match(/x-tasca-org-id/gi)).toHaveLength(1);
  });

  it('with a null context, STRIPS agent-supplied attribution and adds none', async () => {
    const out = (await stamp(req('POST', '{}', ['x-tasca-task-id: FORGED']), null)).toString('latin1');
    expect(out).not.toContain('FORGED');
    expect(out).not.toMatch(/x-tasca-/i); // no attribution at all
  });

  it('handles HTTP/1.1 keep-alive — stamps EVERY request on one connection (Content-Length framing)', async () => {
    const b1 = JSON.stringify({ n: 1 });
    const b2 = JSON.stringify({ n: 2, longer: 'xxxxxx' });
    const wire = Buffer.concat([req('POST', b1), req('POST', b2)]);
    const out = (await stamp(wire, CTX)).toString('latin1');
    // Both request heads got stamped; both bodies are intact and in order.
    expect(out.match(/X-Tasca-Task-Id: task-42/g)).toHaveLength(2);
    expect(out).toContain('\r\n\r\n' + b1);
    expect(out).toContain('\r\n\r\n' + b2);
    expect(out.indexOf(b1)).toBeLessThan(out.indexOf(b2)); // order preserved
  });

  it('does not corrupt a body that itself contains a blank-line (\\r\\n\\r\\n) sequence', async () => {
    const body = 'aaa\r\n\r\nbbb'; // a CRLFCRLF inside the body must NOT be mistaken for a head boundary
    const out = (await stamp(req('POST', body), CTX)).toString('latin1');
    expect(out.endsWith('\r\n\r\n' + body)).toBe(true);
    expect(out.match(/X-Tasca-Task-Id/g)).toHaveLength(1); // one request → one stamp, body not re-parsed
  });

  it('byte-splits across chunks still frame + stamp correctly', async () => {
    const body = JSON.stringify({ model: 'claude' });
    const full = req('POST', body);
    const t = requestStamper(() => CTX);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      t.on('data', (c: Buffer) => chunks.push(c));
      t.on('end', resolve);
      t.on('error', reject);
      // One byte at a time — the head accumulator must reassemble across the boundary.
      Readable.from(Array.from(full).map((b) => Buffer.from([b]))).pipe(t);
    });
    const out = Buffer.concat(chunks).toString('latin1');
    expect(out).toContain('X-Tasca-Task-Id: task-42\r\n');
    expect(out.endsWith('\r\n\r\n' + body)).toBe(true);
  });
});

describe('requestStamper — fails SAFE on framing it will not touch (never corrupts the stream)', () => {
  it('a chunked request body → raw pass-through, original bytes unmodified, no stamp', async () => {
    const wire = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'
    );
    const out = await stamp(wire, CTX);
    expect(out.equals(wire)).toBe(true); // byte-identical — we did not touch it
  });

  it('a body method with NO content-length → raw pass-through (cannot frame the next request)', async () => {
    const wire = Buffer.from('POST /v1/messages HTTP/1.1\r\nhost: x\r\n\r\nsome-body-bytes');
    const out = await stamp(wire, CTX);
    expect(out.equals(wire)).toBe(true);
  });

  it('a GET (bodyless) with no content-length is still stamped and framed', async () => {
    const wire = Buffer.from('GET /v1/models HTTP/1.1\r\nhost: x\r\n\r\n');
    const out = (await stamp(wire, CTX)).toString('latin1');
    expect(out).toContain('X-Tasca-Task-Id: task-42\r\n');
    expect(out.endsWith('\r\n\r\n')).toBe(true);
  });

  it('an oversized head with no terminator → raw pass-through (no OOM, no corruption)', async () => {
    // 300 KB of header bytes with no blank-line delimiter trips the MAX_HEAD cap → raw.
    const wire = Buffer.concat([Buffer.from('POST /v1/x HTTP/1.1\r\nx-big: '), Buffer.alloc(300 * 1024, 0x61)]);
    const out = await stamp(wire, CTX);
    expect(out.equals(wire)).toBe(true); // flushed unchanged, no stamp, never threw
  });
});
