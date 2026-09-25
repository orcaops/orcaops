import { describe, expect, it } from 'vitest';

import { resolveNoToolCall } from '../provider-capabilities.js';
import { claudePreparedInputAdapter } from './prepared-input.js';

const SCHEMA = { type: 'object' };

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  tools: [],
  mcp_servers: [],
  ...extra,
});
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { content, ...extra },
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  is_error: false,
  result: 'an answer',
  ...extra,
});

function interpret(events: unknown[], outputSchema: Record<string, unknown> | null = null) {
  const stdout = events.map((event) => JSON.stringify(event)).join('\n');
  return claudePreparedInputAdapter.interpret(stdout, { outputSchema });
}

describe('claudePreparedInputAdapter.interpret — the structured-answer channel', () => {
  const call = assistant([{ type: 'tool_use', id: 'toolu_answer', name: 'StructuredOutput' }], {
    stop_reason: 'tool_use',
  });
  const callResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_answer' }] },
  };
  const structured = result({
    result: '',
    structured_output: { ok: true },
    stop_reason: 'tool_use',
  });

  it('is no sign of tool use when a schema was requested', () => {
    const outcome = interpret(
      [init({ tools: ['StructuredOutput'] }), call, callResult, structured],
      SCHEMA
    );
    expect(outcome.toolUse).toEqual([]);
    expect(outcome.toolsAvailable).toEqual([]);
    expect(outcome.cutOffReason).toBeNull();
    expect(outcome.structuredAnswerMissing).toBe(false);
    expect(outcome.body).toBe('{"ok":true}');
  });

  it('is an offered tool, a tool call, a tool result, and a tool stop when no schema was requested', () => {
    const outcome = interpret([
      init({ tools: ['StructuredOutput'] }),
      call,
      callResult,
      structured,
    ]);
    expect(outcome.toolsAvailable).toEqual(['tool StructuredOutput']);
    expect(outcome.toolUse).toEqual([
      'StructuredOutput',
      'a tool result returned to the model',
      'a stop to use a tool',
    ]);
  });

  it('does not excuse a result that answers some other call', () => {
    const otherResult = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_other' }] },
    };
    const outcome = interpret([init(), call, callResult, otherResult, structured], SCHEMA);
    expect(outcome.toolUse).toEqual(['a tool result returned to the model']);
  });

  it('does not excuse a stop to use a tool when the answer channel was never called', () => {
    const outcome = interpret([init(), result({ stop_reason: 'tool_use' })], SCHEMA);
    expect(outcome.toolUse).toEqual(['a stop to use a tool']);
  });

  it('is reported missing when a schema was requested and only free text came back', () => {
    const outcome = interpret([init(), result()], SCHEMA);
    expect(outcome.structuredAnswerMissing).toBe(true);
    expect(outcome.body).toBe('an answer');
  });
});

describe('claudePreparedInputAdapter.interpret — what the model was offered', () => {
  it.each([
    ['connected', true],
    ['pending', true],
    ['a-status-not-known-here', true],
    ['failed', false],
    ['disabled', false],
    ['needs-auth', false],
  ])('treats an MCP server with status %s as able to serve tools: %s', (status, servesTools) => {
    const outcome = interpret([init({ mcp_servers: [{ name: 'tracker', status }] }), result()]);
    expect(outcome.toolsAvailable).toEqual(servesTools ? [`MCP server tracker (${status})`] : []);
  });

  it('treats an MCP server that states no status as able to serve tools', () => {
    const outcome = interpret([init({ mcp_servers: [{ name: 'tracker' }] }), result()]);
    expect(outcome.toolsAvailable).toEqual(['MCP server tracker (status not stated)']);
  });

  it('says the offer was stated only when an init event listed the tools', () => {
    expect(interpret([init(), result()]).toolOfferStated).toBe(true);
    expect(interpret([result()]).toolOfferStated).toBe(false);
    expect(interpret([{ type: 'system', subtype: 'init' }, result()]).toolOfferStated).toBe(false);
  });
});

describe('claudePreparedInputAdapter.interpret — why generation stopped', () => {
  it.each([
    ['end_turn', null],
    ['stop_sequence', null],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'model_context_window_exceeded'],
    ['pause_turn', 'pause_turn'],
    ['refusal', 'refusal'],
    ['a-reason-not-known-here', 'a-reason-not-known-here'],
  ])('reads stop reason %s as cut-off reason %s', (stopReason, cutOffReason) => {
    expect(interpret([init(), result({ stop_reason: stopReason })]).cutOffReason).toBe(
      cutOffReason
    );
  });

  it('prefers the result event over the last assistant event', () => {
    const outcome = interpret([
      init(),
      assistant([], { stop_reason: 'max_tokens' }),
      result({ stop_reason: 'end_turn' }),
    ]);
    expect(outcome.cutOffReason).toBeNull();
  });

  it('does not fail an answer whose stop reason was never reported', () => {
    expect(interpret([init(), assistant([], { stop_reason: null }), result()]).cutOffReason).toBe(
      null
    );
  });
});

describe('claudePreparedInputAdapter.interpret — usage and cost', () => {
  it('reports cache activity even when no fresh tokens were counted', () => {
    const outcome = interpret([
      init(),
      result({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 800 } }),
    ]);
    expect(outcome.usage).toEqual({ in: 0, out: 0, cacheRead: 800 });
  });

  it.each([
    ['only input tokens', { input_tokens: 10 }],
    ['only output tokens', { output_tokens: 10 }],
    ['only cache tokens', { cache_read_input_tokens: 10 }],
    ['all zeros', { input_tokens: 0, output_tokens: 0 }],
  ])('reports usage with %s as unknown', (_label, usage) => {
    expect(interpret([init(), result({ usage })]).usage).toBeNull();
  });

  it('keeps the larger of each figure when several results disagree, and names no single model', () => {
    const outcome = interpret([
      init(),
      result({
        usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 40 },
        total_cost_usd: 0.01,
        modelUsage: { 'model-a': {} },
      }),
      result({
        usage: { input_tokens: 20, output_tokens: 50 },
        total_cost_usd: 0.2,
        modelUsage: { 'model-b': {} },
      }),
    ]);
    expect(outcome.resultCount).toBe(2);
    expect(outcome.usage).toEqual({ in: 100, out: 50, cacheWrite: 40 });
    expect(outcome.costUsd).toBe(0.2);
    expect(outcome.reportedModel).toBeNull();
    expect(outcome.failure).toBeNull();
  });
});

describe('claudePreparedInputAdapter.invocation', () => {
  function argsFor(request: Parameters<typeof resolveNoToolCall>[0]): string[] {
    const resolution = resolveNoToolCall(request);
    if (resolution.status !== 'available') throw new Error('expected an available provider');
    return claudePreparedInputAdapter.invocation({
      settings: resolution.settings,
      systemPrompt: null,
      outputSchema: null,
      outputSchemaFile: null,
      baseEnv: {},
    }).args;
  }

  it('passes a best-effort spend cap to the provider flag', () => {
    const args = argsFor({
      provider: 'claude',
      inherited: { provider: 'claude', model: null, maxCostUsd: 0.5 },
    });
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5000');
  });

  it('passes no spend flag when there is no cap', () => {
    expect(argsFor({ provider: 'claude' })).not.toContain('--max-budget-usd');
  });
});
