import { describe, expect, it } from 'vitest';

import { LineBuffer, parseClaudeStreamLine } from './stream-parser.js';

describe('parseClaudeStreamLine', () => {
  it('returns null for empty / whitespace lines', () => {
    expect(parseClaudeStreamLine('')).toBeNull();
    expect(parseClaudeStreamLine('   ')).toBeNull();
    expect(parseClaudeStreamLine('\n')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudeStreamLine('not json')).toBeNull();
    expect(parseClaudeStreamLine('{bad')).toBeNull();
  });

  it('returns null for non-result events', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' })
      )
    ).toBeNull();
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message: { content: [] } }))
    ).toBeNull();
  });

  it('parses a complete result event', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'PASS\n\nLooks good.',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 1500, output_tokens: 32 },
        is_error: false,
        modelUsage: {
          'claude-opus-5[1m]': {
            canonicalModel: 'claude-opus-5',
            provider: 'firstParty',
          },
        },
        num_turns: 1,
        session_id: 'abc-uuid',
      })
    );
    expect(event).not.toBeNull();
    expect(event?.body).toBe('PASS\n\nLooks good.');
    expect(event?.cumulativeCostUsd).toBe(0.0123);
    expect(event?.tokens).toEqual({ in: 1500, out: 32 });
    expect(event?.isError).toBe(false);
    expect(event?.model).toBe('claude-opus-5[1m]');
    expect(event?.numTurns).toBe(1);
    expect(event?.sessionId).toBe('abc-uuid');
  });

  it('omits ambiguous or malformed modelUsage instead of guessing', () => {
    const parse = (modelUsage: unknown) =>
      parseClaudeStreamLine(JSON.stringify({ type: 'result', result: 'PASS', modelUsage }));
    expect(parse({})?.model).toBeUndefined();
    expect(parse(null)?.model).toBeUndefined();
    expect(parse([])?.model).toBeUndefined();
    expect(parse({ one: {}, two: {} })?.model).toBeUndefined();
    expect(parse({ one: 'malformed' })?.model).toBeUndefined();
  });

  it('omits tokens when every count is zero', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: 'x', usage: { input_tokens: 0, output_tokens: 0 } })
    );
    expect(event?.tokens).toBeUndefined();
  });

  it('captures Anthropic prompt-cache tokens (cache_read_input_tokens, cache_creation_input_tokens)', () => {
    // The cached-prompt case: most of the structured prompt is served from
    // the prompt cache, leaving a tiny `input_tokens` delta. Without
    // capturing the cache fields we under-count cost dramatically.
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'PASS',
        usage: {
          input_tokens: 6,
          output_tokens: 7,
          cache_read_input_tokens: 1234,
          cache_creation_input_tokens: 500,
        },
      })
    );
    expect(event?.tokens).toEqual({
      in: 6,
      out: 7,
      cacheRead: 1234,
      cacheWrite: 500,
    });
  });

  it('omits cacheRead/cacheWrite keys when their counts are zero (avoids JSON noise)', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'PASS',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })
    );
    expect(event?.tokens).toEqual({ in: 100, out: 5 });
    expect((event?.tokens as Record<string, unknown>).cacheRead).toBeUndefined();
    expect((event?.tokens as Record<string, unknown>).cacheWrite).toBeUndefined();
  });

  it('captures cache fields even when fresh in/out are zero (heavy-cache evaluator pass)', () => {
    // An evaluator on its second invocation might serve 100% of the
    // prompt from cache and emit a cached PASS. Don't drop the run just
    // because in+out happen to round to zero — cacheRead alone is signal.
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'PASS',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 0,
        },
      })
    );
    expect(event?.tokens).toEqual({ in: 0, out: 0, cacheRead: 1500 });
  });

  it('marks isError=true when the CLI reports an error', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: 'budget exceeded', is_error: true })
    );
    expect(event?.isError).toBe(true);
  });
});

describe('LineBuffer', () => {
  it('returns complete lines from a single chunk', () => {
    const buf = new LineBuffer();
    expect(buf.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('holds a trailing partial line until the next chunk', () => {
    const buf = new LineBuffer();
    expect(buf.push('hello')).toEqual([]);
    expect(buf.push(' world\nnext')).toEqual(['hello world']);
    expect(buf.flush()).toBe('next');
  });

  it('handles multi-chunk JSON fragments correctly', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"type":"result","result":"PASS"')).toEqual([]);
    const lines = buf.push(',"is_error":false}\n');
    expect(lines).toHaveLength(1);
    const event = parseClaudeStreamLine(lines[0]);
    expect(event?.body).toBe('PASS');
  });
});
