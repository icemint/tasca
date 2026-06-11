import { describe, it, expect } from 'vitest';
import {
  AnthropicChat,
  AnthropicClassifier,
  AnthropicDecomposer,
  extractJson,
  type FetchLike,
} from './index';

/** A fake transport returning a fixed Anthropic Messages response (a text block). */
function okWith(text: string): { calls: Array<{ url: string; headers: Record<string, string>; body: string }>; fetch: FetchLike } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, async text() { return JSON.stringify({ content: [{ type: 'text', text }] }); } };
  };
  return { calls, fetch };
}

const features = { wordCount: 50, hasReasoningVerb: true, scopeHint: 'multi-file' as const, labelTier: null };

describe('AnthropicChat', () => {
  it('POSTs the Messages API with auth headers + model, returns the text block', async () => {
    const t = okWith('hello');
    const chat = new AnthropicChat({ apiKey: 'sk-test', model: 'claude-haiku-4-5-20251001', fetch: t.fetch });
    const out = await chat.complete({ system: 'sys', prompt: 'hi', maxTokens: 32 });
    expect(out).toBe('hello');
    expect(t.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(t.calls[0]!.headers['x-api-key']).toBe('sk-test');
    expect(t.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(t.calls[0]!.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe('sys');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('throws on a non-200 status', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, async text() { return 'overloaded'; } });
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch });
    await expect(chat.complete({ prompt: 'x', maxTokens: 8 })).rejects.toThrow('anthropic 503');
  });

  it('throws on a body with no text content', async () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ content: [] }); } });
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch });
    await expect(chat.complete({ prompt: 'x', maxTokens: 8 })).rejects.toThrow('no text content');
  });

  it('times out (rejects) when the transport hangs', async () => {
    const fetch: FetchLike = () => new Promise(() => {}); // never resolves
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch, timeoutMs: 10 });
    await expect(chat.complete({ prompt: 'x', maxTokens: 8 })).rejects.toBeTruthy();
  });
});

describe('extractJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('extracts JSON wrapped in prose + ```json fences', () => {
    expect(extractJson('Here:\n```json\n{"tier":"hard"}\n```\nthanks')).toEqual({ tier: 'hard' });
  });
  it('throws when there is no JSON object', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('AnthropicClassifier — surfaces failures as throws (the consumer falls back)', () => {
  it('returns {tier, confidence} from a good response', async () => {
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch: okWith('{"tier":"hard","confidence":0.82}').fetch });
    const out = await new AnthropicClassifier(chat).classify({ title: 't', body: 'b', features });
    expect(out).toEqual({ tier: 'hard', confidence: 0.82 });
  });

  it('THROWS on a transport error (→ estimateTier degrades to the heuristic)', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 500, async text() { return 'err'; } });
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch });
    await expect(new AnthropicClassifier(chat).classify({ title: 't', body: 'b', features })).rejects.toBeTruthy();
  });

  it('THROWS on a non-JSON model response', async () => {
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch: okWith('I cannot classify this').fetch });
    await expect(new AnthropicClassifier(chat).classify({ title: 't', body: 'b', features })).rejects.toBeTruthy();
  });
});

describe('AnthropicDecomposer — surfaces failures as throws (the proposer returns null)', () => {
  it('returns the split from a good response', async () => {
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch: okWith('{"children":[{"title":"a","body":""}],"why":"ok"}').fetch });
    const out = await new AnthropicDecomposer(chat).decompose({ title: 't', body: 'b' });
    expect(out!.children).toHaveLength(1);
  });

  it('THROWS on a transport error', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 500, async text() { return 'err'; } });
    const chat = new AnthropicChat({ apiKey: 'k', model: 'm', fetch });
    await expect(new AnthropicDecomposer(chat).decompose({ title: 't', body: 'b' })).rejects.toBeTruthy();
  });
});
