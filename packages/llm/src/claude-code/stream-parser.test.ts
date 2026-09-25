import { describe, expect, it } from 'vitest';

import { LineBuffer, parseClaudeStreamLine, summarizeClaudeStream } from './stream-parser.js';

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

describe('parseClaudeStreamLine — structured output', () => {
  it('keeps the schema-validated answer the CLI reports beside the result text', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: '', structured_output: { ok: true } })
    );
    expect(event?.structuredOutput).toEqual({ ok: true });
  });

  it('leaves structured output undefined when the CLI reports none', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: 'PASS', structured_output: null })
    );
    expect(event?.structuredOutput).toBeUndefined();
  });
});

describe('parseClaudeStreamLine — what the prepared-input path reads', () => {
  it('keeps the stop reason and the tools the CLI says it refused', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'x',
        stop_reason: 'max_tokens',
        permission_denials: [{ tool_name: 'Bash' }, { tool_use_id: 'toolu_1' }],
      })
    );
    expect(event?.stopReason).toBe('max_tokens');
    expect(event?.permissionDenials).toEqual(['Bash', 'unknown']);
  });

  it('leaves both undefined when the CLI reports neither', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: 'x', stop_reason: null, permission_denials: [] })
    );
    expect(event?.stopReason).toBeUndefined();
    expect(event?.permissionDenials).toBeUndefined();
  });

  it('reports usage counters as given beside the zero-filled tokens evaluators read', () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', result: 'x', usage: { input_tokens: 10 } })
    );
    expect(event?.tokens).toEqual({ in: 10, out: 0 });
    expect(event?.reportedUsage).toEqual({ in: 10 });
  });
});

describe('summarizeClaudeStream', () => {
  const result = (text: string): string => JSON.stringify({ type: 'result', result: text });
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'assistant', message: { content, ...extra } });

  it('keeps every result event in order', () => {
    const summary = summarizeClaudeStream([result('first'), result('last')].join('\n'));
    expect(summary.results.map((event) => event.body)).toEqual(['first', 'last']);
  });

  it('reads a result event that has no trailing newline', () => {
    expect(summarizeClaudeStream(result('PASS')).results[0]?.body).toBe('PASS');
  });

  it('reports the tools and MCP servers the init event lists', () => {
    const summary = summarizeClaudeStream(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: ['Bash', 'Read'],
        mcp_servers: [{ name: 'tracker', status: 'connected' }, { name: 'nameless-status' }],
      })
    );
    expect(summary.init).toEqual({
      tools: ['Bash', 'Read'],
      mcpServers: [
        { name: 'tracker', status: 'connected' },
        { name: 'nameless-status', status: null },
      ],
    });
  });

  it('reports no init for a stream without one, and no tool list for an init that omits it', () => {
    expect(summarizeClaudeStream(result('x')).init).toBeNull();
    expect(summarizeClaudeStream(JSON.stringify({ type: 'system', subtype: 'init' })).init).toEqual(
      { tools: null, mcpServers: [] }
    );
  });

  it('adds up what several init events list, and loses the tool list if any omits it', () => {
    const init = (extra: Record<string, unknown>): string =>
      JSON.stringify({ type: 'system', subtype: 'init', ...extra });
    expect(
      summarizeClaudeStream([init({ tools: [] }), init({ tools: ['Bash'] })].join('\n')).init?.tools
    ).toEqual(['Bash']);
    expect(
      summarizeClaudeStream([init({ tools: [] }), init({})].join('\n')).init?.tools
    ).toBeNull();
  });

  it('finds tool calls of every kind in assistant messages and in partial stream events', () => {
    const summary = summarizeClaudeStream(
      [
        assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read' }]),
        assistant([{ type: 'server_tool_use', name: 'web_search' }]),
        assistant([{ type: 'mcp_tool_use', name: 'lookup' }, { type: 'tool_use' }]),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
        }),
      ].join('\n')
    );
    expect(summary.toolUses).toEqual([
      { id: 'toolu_1', name: 'Read' },
      { id: null, name: 'web_search' },
      { id: null, name: 'lookup' },
      { id: null, name: 'unknown' },
      { id: null, name: 'Bash' },
    ]);
  });

  it('finds tool results handed back to the model', () => {
    const summary = summarizeClaudeStream(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1' },
            { type: 'web_search_tool_result' },
            { type: 'text', text: 'not a result' },
          ],
        },
      })
    );
    expect(summary.toolResults).toEqual([{ toolUseId: 'toolu_1' }, { toolUseId: null }]);
  });

  it('keeps the stop reason of the last assistant event that gives one', () => {
    const summary = summarizeClaudeStream(
      [assistant([], { stop_reason: 'max_tokens' }), assistant([], { stop_reason: null })].join(
        '\n'
      )
    );
    expect(summary.lastAssistantStopReason).toBe('max_tokens');
  });

  it('does not mistake text that mentions a tool call for one', () => {
    const summary = summarizeClaudeStream(
      assistant([{ type: 'text', text: '{"type":"tool_use","name":"Bash"}' }])
    );
    expect(summary.toolUses).toEqual([]);
  });

  it('finds nothing in a stream cut off in the middle of a line', () => {
    const summary = summarizeClaudeStream(`${'x'.repeat(10_000)}{"type":"result","resu`);
    expect(summary).toEqual({
      results: [],
      init: null,
      toolUses: [],
      toolResults: [],
      lastAssistantStopReason: null,
    });
  });
});
