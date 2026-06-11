import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { UsageExtractor, usageTee, type AgentCallUsage } from './usage-tee';

// A realistic Anthropic streaming (SSE) response: message_start carries id/model/input_tokens;
// the final message_delta carries the TOTAL output_tokens.
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_01ABC","model":"claude-haiku-4-5","usage":{"input_tokens":25,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const NON_STREAMING = JSON.stringify({
  id: 'msg_02XYZ',
  model: 'claude-haiku-4-5',
  type: 'message',
  usage: { input_tokens: 7, output_tokens: 13 },
});

describe('UsageExtractor — parses usage from a streamed or plain-JSON response', () => {
  it('extracts id, model, input + final output tokens from an SSE stream', () => {
    const ex = new UsageExtractor('text/event-stream');
    ex.feed(Buffer.from(SSE));
    expect(ex.result()).toEqual<AgentCallUsage>({
      model: 'claude-haiku-4-5',
      inputTokens: 25,
      outputTokens: 42, // the message_delta total, not the message_start seed of 1
      idempotencyKey: 'msg_01ABC',
    });
  });

  it('parses an SSE stream fed in arbitrary chunk boundaries (mid-event splits)', () => {
    const ex = new UsageExtractor('text/event-stream');
    const bytes = Buffer.from(SSE);
    // Feed one byte at a time — the partial-event buffering must still reassemble each event.
    for (let i = 0; i < bytes.length; i++) ex.feed(bytes.subarray(i, i + 1));
    expect(ex.result()).toEqual<AgentCallUsage>({
      model: 'claude-haiku-4-5',
      inputTokens: 25,
      outputTokens: 42,
      idempotencyKey: 'msg_01ABC',
    });
  });

  it('extracts usage from a non-streaming JSON body', () => {
    const ex = new UsageExtractor('application/json');
    ex.feed(Buffer.from(NON_STREAMING));
    expect(ex.result()).toEqual<AgentCallUsage>({
      model: 'claude-haiku-4-5',
      inputTokens: 7,
      outputTokens: 13,
      idempotencyKey: 'msg_02XYZ',
    });
  });

  it('returns null (never throws) on garbage, empty, or a body with no usage', () => {
    expect(new UsageExtractor('application/json').result()).toBeNull(); // empty
    const g = new UsageExtractor('text/event-stream');
    g.feed(Buffer.from('event: x\ndata: not-json\n\ndata: {"partial":true}\n\n'));
    expect(g.result()).toBeNull();
    const j = new UsageExtractor('application/json');
    j.feed(Buffer.from('{this is not json'));
    expect(j.result()).toBeNull();
  });

  it('caps the non-streaming accumulation (a huge body cannot OOM the extractor)', () => {
    const ex = new UsageExtractor('application/json');
    // Feed > 1 MB before the real (parseable) body — the cap stops accumulation, so no usage.
    ex.feed(Buffer.alloc(2 << 20, 0x20)); // 2 MB of spaces
    ex.feed(Buffer.from(NON_STREAMING));
    expect(ex.result()).toBeNull(); // accumulation was capped; the trailing JSON never landed
  });
});

describe('usageTee — forwards every byte unchanged while extracting usage on the side', () => {
  async function runTee(input: Buffer, contentType: string): Promise<{ out: Buffer; usage: AgentCallUsage[] }> {
    const usage: AgentCallUsage[] = [];
    const tee = usageTee(contentType, (u) => usage.push(u));
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tee.on('data', (c: Buffer) => chunks.push(c));
      tee.on('end', resolve);
      tee.on('error', reject);
      Readable.from([input]).pipe(tee);
    });
    return { out: Buffer.concat(chunks), usage };
  }

  it('the forwarded bytes are byte-identical to the input (SSE)', async () => {
    const input = Buffer.from(SSE);
    const { out, usage } = await runTee(input, 'text/event-stream');
    expect(out.equals(input)).toBe(true); // not one byte changed — the agent sees the exact stream
    expect(usage).toHaveLength(1);
    expect(usage[0]).toEqual<AgentCallUsage>({ model: 'claude-haiku-4-5', inputTokens: 25, outputTokens: 42, idempotencyKey: 'msg_01ABC' });
  });

  it('onUsage fires exactly once, on flush', async () => {
    const { usage } = await runTee(Buffer.from(SSE), 'text/event-stream');
    expect(usage).toHaveLength(1);
  });

  it('a parse failure never breaks the forward — bytes still pass through, no usage', async () => {
    const garbage = Buffer.from('event: x\ndata: {broken\n\nrandom bytes \x00\x01\x02');
    const { out, usage } = await runTee(garbage, 'text/event-stream');
    expect(out.equals(garbage)).toBe(true); // the stream is intact despite unparseable content
    expect(usage).toHaveLength(0); // …and no (bogus) usage was reported
  });

  it('forwards a multi-chunk stream identically (order + content preserved)', async () => {
    const usage: AgentCallUsage[] = [];
    const tee = usageTee('text/event-stream', (u) => usage.push(u));
    const parts = ['event: message_start\n', 'data: {"type":"message_start","message":{"id":"msg_X","model":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n', 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'];
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tee.on('data', (c: Buffer) => chunks.push(c));
      tee.on('end', resolve);
      tee.on('error', reject);
      Readable.from(parts.map((p) => Buffer.from(p))).pipe(tee);
    });
    expect(Buffer.concat(chunks).toString()).toBe(parts.join(''));
    expect(usage[0]).toEqual<AgentCallUsage>({ model: 'm', inputTokens: 3, outputTokens: 9, idempotencyKey: 'msg_X' });
  });
});
