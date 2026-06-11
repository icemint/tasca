// SSE-aware usage tee (slice W3-S4b). The proxy streams the Anthropic response downstream UNCHANGED;
// this extracts the per-call usage (token counts + the response id) from a COPY of the stream so
// per-task/per-org agent spend can be metered — WITHOUT buffering the whole body or stalling the
// downstream. The tee is a passthrough Transform: every byte is forwarded as-is, in real time; the
// parser runs on the side and can NEVER corrupt or block the stream (a parse failure → no usage, the
// agent's stream is unaffected). Bounded memory: SSE is parsed event-by-event (only a partial event
// is buffered); a non-streaming JSON body is accumulated under a hard cap.

import { Transform } from 'node:stream';

export interface AgentCallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The Anthropic response id — the metering idempotency key. */
  idempotencyKey: string;
}

interface AnthropicEvent {
  type?: string;
  id?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
}

/** Extracts usage from a streamed (SSE) or plain-JSON Anthropic response. Feed chunks; `result()`
 *  returns the usage or null. Never throws on malformed input. */
export class UsageExtractor {
  private static readonly MAX_JSON = 1 << 20; // 1 MB cap on the non-streaming accumulation path
  private readonly sse: boolean;
  private buf = '';
  private id: string | null = null;
  private model: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(contentType: string | undefined) {
    this.sse = (contentType ?? '').toLowerCase().includes('text/event-stream');
  }

  feed(chunk: Buffer): void {
    if (this.sse) {
      this.buf += chunk.toString('utf8');
      // Process each COMPLETE event (\n\n-delimited); keep only the trailing partial — bounded memory.
      let idx: number;
      while ((idx = this.buf.indexOf('\n\n')) !== -1) {
        const event = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          const m = /^data:\s?(.*)$/.exec(line);
          if (m) this.tryAbsorb(m[1]!);
        }
      }
    } else if (this.buf.length < UsageExtractor.MAX_JSON) {
      this.buf += chunk.toString('utf8'); // non-streaming: accumulate the JSON body (capped)
    }
  }

  private tryAbsorb(json: string): void {
    let obj: AnthropicEvent;
    try {
      obj = JSON.parse(json) as AnthropicEvent;
    } catch {
      return;
    }
    if (obj.type === 'message_start' && obj.message) {
      // The opening event carries the id, model, and input_tokens (output_tokens starts at ~1).
      if (obj.message.id) this.id = obj.message.id;
      if (obj.message.model) this.model = obj.message.model;
      if (typeof obj.message.usage?.input_tokens === 'number') this.inputTokens = obj.message.usage.input_tokens;
      if (typeof obj.message.usage?.output_tokens === 'number') this.outputTokens = obj.message.usage.output_tokens;
    } else if (obj.type === 'message_delta' && typeof obj.usage?.output_tokens === 'number') {
      this.outputTokens = obj.usage.output_tokens; // the final delta carries the TOTAL output_tokens (last wins)
    } else if (obj.id && obj.usage) {
      // A non-streaming message body: id + usage in one object.
      this.id = obj.id;
      if (obj.model) this.model = obj.model;
      if (typeof obj.usage.input_tokens === 'number') this.inputTokens = obj.usage.input_tokens;
      if (typeof obj.usage.output_tokens === 'number') this.outputTokens = obj.usage.output_tokens;
    }
  }

  result(): AgentCallUsage | null {
    if (!this.sse && this.buf) this.tryAbsorb(this.buf); // parse the accumulated non-streaming body
    if (this.id && this.model) {
      return { model: this.model, inputTokens: this.inputTokens, outputTokens: this.outputTokens, idempotencyKey: this.id };
    }
    return null;
  }
}

/**
 * A passthrough Transform: forwards every byte UNCHANGED (so the downstream SSE stream is byte-identical
 * and real-time, backpressure handled by the stream), while a side parser extracts the usage. `onUsage`
 * fires at most once, on flush, with the extracted usage (or never, if none/parse-failed). A parse error
 * NEVER breaks the forward.
 */
export function usageTee(contentType: string | undefined, onUsage: (u: AgentCallUsage) => void): Transform {
  const ex = new UsageExtractor(contentType);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        ex.feed(chunk);
      } catch {
        /* the tee must NEVER break the stream on a parse error */
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      try {
        const u = ex.result();
        if (u) onUsage(u);
      } catch {
        /* best-effort metering */
      }
      cb();
    },
  });
}
