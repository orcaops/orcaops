import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CopilotUsageSource, extractOtelUsageRecords } from './otel-parser.js';

let tmp: string;
let seq = 0;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-llm-copilot-'));
  seq = 0;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const SID = 'conv-0000-1111';
const T0 = Date.parse('2026-07-01T10:00:00.000Z');
const MTIME = Date.parse('2026-07-01T12:00:00.000Z');

/** `[seconds, nanos]` for a ms epoch. */
function hr(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

function chatSpan(o: {
  session?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  traceId?: string;
  spanId?: string;
  responseId?: string;
  endMs?: number;
  legacyNames?: boolean;
  omitSessionAttr?: boolean;
}): string {
  const n = seq++;
  const attrs: Record<string, unknown> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': o.model ?? 'claude-sonnet-4.6',
    'gen_ai.response.model': o.model ?? 'claude-sonnet-4.6',
    ...(o.omitSessionAttr === true ? {} : { 'gen_ai.conversation.id': o.session ?? SID }),
    ...(o.responseId !== undefined ? { 'gen_ai.response.id': o.responseId } : {}),
  };
  if (o.legacyNames === true) {
    attrs['gen_ai.usage.input_tokens'] = o.input ?? 0;
    attrs['gen_ai.usage.output_tokens'] = o.output ?? 0;
    if (o.cacheRead !== undefined) attrs['gen_ai.usage.cache_read_input_tokens'] = o.cacheRead;
    if (o.cacheWrite !== undefined)
      attrs['gen_ai.usage.cache_creation_input_tokens'] = o.cacheWrite;
    if (o.reasoning !== undefined) attrs['gen_ai.usage.reasoning_output_tokens'] = o.reasoning;
  } else {
    attrs['gen_ai.usage.input_tokens'] = o.input ?? 0;
    attrs['gen_ai.usage.output_tokens'] = o.output ?? 0;
    if (o.cacheRead !== undefined) attrs['gen_ai.usage.cache_read.input_tokens'] = o.cacheRead;
    if (o.cacheWrite !== undefined) attrs['gen_ai.usage.cache_write.input_tokens'] = o.cacheWrite;
    if (o.reasoning !== undefined) attrs['gen_ai.usage.reasoning.output_tokens'] = o.reasoning;
  }
  return (
    JSON.stringify({
      type: 'span',
      traceId: o.traceId ?? `trace-${n}`,
      spanId: o.spanId ?? `span-${n}`,
      name: `chat ${o.model ?? 'claude-sonnet-4.6'}`,
      endTime: hr(o.endMs ?? T0 + n * 60_000),
      attributes: attrs,
    }) + '\n'
  );
}

function inferenceLog(o: {
  session?: string;
  model?: string;
  input?: number;
  output?: number;
  traceId?: string;
  spanId?: string;
  responseId?: string;
  hrMs?: number;
  omitSessionAttr?: boolean;
}): string {
  const n = seq++;
  return (
    JSON.stringify({
      traceId: o.traceId ?? `trace-${n}`,
      spanId: o.spanId ?? `logspan-${n}`,
      hrTime: hr(o.hrMs ?? T0 + n * 60_000),
      _body: `GenAI inference: ${o.model ?? 'gpt-5.4'}`,
      attributes: {
        'event.name': 'gen_ai.client.inference.operation.details',
        'gen_ai.request.model': o.model ?? 'gpt-5.4',
        ...(o.omitSessionAttr === true ? {} : { 'gen_ai.conversation.id': o.session ?? SID }),
        ...(o.responseId !== undefined ? { 'gen_ai.response.id': o.responseId } : {}),
        'gen_ai.usage.input_tokens': o.input ?? 0,
        'gen_ai.usage.output_tokens': o.output ?? 0,
      },
    }) + '\n'
  );
}

function agentTurnLog(o: {
  session?: string;
  input?: number;
  output?: number;
  traceId?: string;
  turn?: string;
  responseId?: string;
}): string {
  const n = seq++;
  return (
    JSON.stringify({
      ...(o.traceId !== undefined ? { traceId: o.traceId } : {}),
      hrTime: hr(T0 + n * 60_000),
      _body: 'copilot_chat.agent.turn',
      attributes: {
        'event.name': 'copilot_chat.agent.turn',
        ...(o.turn !== undefined ? { 'turn.index': o.turn } : {}),
        'copilot_chat.session_id': o.session ?? SID,
        ...(o.responseId !== undefined ? { 'gen_ai.response.id': o.responseId } : {}),
        'gen_ai.usage.input_tokens': o.input ?? 0,
        'gen_ai.usage.output_tokens': o.output ?? 0,
      },
    }) + '\n'
  );
}

const metricLine =
  JSON.stringify({
    type: 'metric',
    name: 'gen_ai.client.token.usage',
    dataPoints: [{ value: 12345 }],
  }) + '\n';

async function writeOtel(name: string, content: string, home = tmp): Promise<string> {
  const dir = path.join(home, '.copilot', 'otel');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

function source(env: Record<string, string | undefined> = {}): CopilotUsageSource {
  return new CopilotUsageSource({ HOME: tmp, ...env });
}

describe('extractOtelUsageRecords', () => {
  it('parses a chat span, subtracting cache-inclusive input and carrying reasoning', () => {
    const recs = extractOtelUsageRecords(
      chatSpan({ input: 19452, output: 281, cacheRead: 123, cacheWrite: 25, reasoning: 128 }),
      MTIME
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].usage).toEqual({
      input_tokens: 19329, // 19452 − 123 (input is cache-inclusive)
      output_tokens: 281,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 123,
      dimensions: { reasoning_output_tokens: 128 },
    });
    expect(recs[0].model).toBe('claude-sonnet-4.6');
    expect(recs[0].sessionId).toBe(SID);
  });

  it('accepts the legacy underscore usage-attribute names (< v1.0.56)', () => {
    const recs = extractOtelUsageRecords(
      chatSpan({
        input: 100,
        output: 10,
        cacheRead: 40,
        cacheWrite: 5,
        reasoning: 3,
        legacyNames: true,
      }),
      MTIME
    );
    expect(recs[0].usage).toEqual({
      input_tokens: 60,
      output_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 40,
      dimensions: { reasoning_output_tokens: 3 },
    });
  });

  it('clamps cache_read to input', () => {
    const recs = extractOtelUsageRecords(chatSpan({ input: 50, output: 1, cacheRead: 80 }), MTIME);
    expect(recs[0].usage.input_tokens).toBe(0);
    expect(recs[0].usage.cache_read_input_tokens).toBe(50);
  });

  it('uses an inference log when no chat span covers the response', () => {
    const recs = extractOtelUsageRecords(inferenceLog({ input: 70, output: 7 }), MTIME);
    expect(recs).toHaveLength(1);
    expect(recs[0].model).toBe('gpt-5.4');
    expect(recs[0].usage.input_tokens).toBe(70);
  });

  it('suppresses lower-precedence shapes sharing a traceId or response id', () => {
    const content =
      chatSpan({
        input: 100,
        output: 10,
        traceId: 'trace-dupe',
        spanId: 'chat-1',
        responseId: 'resp-dupe',
      }) +
      inferenceLog({ input: 100, output: 10, traceId: 'trace-dupe', responseId: 'resp-dupe' }) +
      // Same response exported on a DIFFERENT trace — suppressed via response id.
      agentTurnLog({ input: 100, output: 10, traceId: 'trace-other', responseId: 'resp-dupe' });
    const recs = extractOtelUsageRecords(content, MTIME);
    expect(recs).toHaveLength(1);
    expect(recs[0].dedupKey).toBe('trace-dupe:chat-1');
  });

  it('keeps an agent-turn log with its own trace and response', () => {
    const content =
      chatSpan({ input: 100, output: 10, traceId: 'trace-a', responseId: 'resp-a' }) +
      agentTurnLog({ input: 40, output: 4, traceId: 'trace-b', turn: '2', responseId: 'resp-b' });
    const recs = extractOtelUsageRecords(content, MTIME);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.dedupKey)).toContain('agent-turn:trace-b:2');
  });

  it('inherits session id and model from a sibling record in the same trace', () => {
    // The usage-carrying span lacks a session attr; a sibling log in the same
    // trace carries it.
    const sibling =
      JSON.stringify({
        traceId: 'trace-ctx',
        hrTime: hr(T0),
        attributes: { 'gen_ai.conversation.id': SID, 'gen_ai.response.model': 'gpt-5.4' },
      }) + '\n';
    const content =
      sibling +
      chatSpan({
        input: 10,
        output: 1,
        traceId: 'trace-ctx',
        omitSessionAttr: true,
        model: undefined,
      });
    // Strip the span's own model attrs so it must inherit from the trace ctx.
    const lines = content.trimEnd().split('\n');
    const span = JSON.parse(lines[1]) as {
      attributes: Record<string, unknown>;
      name: string;
    };
    delete span.attributes['gen_ai.request.model'];
    delete span.attributes['gen_ai.response.model'];
    span.name = 'chat';
    const recs = extractOtelUsageRecords(`${lines[0]}\n${JSON.stringify(span)}\n`, MTIME);
    expect(recs).toHaveLength(1);
    expect(recs[0].sessionId).toBe(SID);
    expect(recs[0].model).toBe('gpt-5.4');
  });

  it('falls back to the traceId as the session id when no session attr exists anywhere', () => {
    const recs = extractOtelUsageRecords(
      chatSpan({ input: 10, output: 1, traceId: 'trace-lonely', omitSessionAttr: true }),
      MTIME
    );
    expect(recs[0].sessionId).toBe('trace-lonely');
  });

  it('ignores metric lines, attribute-less lines, and zero-usage records', () => {
    const content =
      metricLine +
      'garbage\n' +
      chatSpan({ input: 0, output: 0 }) +
      chatSpan({ input: 5, output: 1 });
    const recs = extractOtelUsageRecords(content, MTIME);
    expect(recs).toHaveLength(1);
    expect(recs[0].usage.input_tokens).toBe(5);
  });

  it('reads every timestamp encoding and falls back to the file mtime', () => {
    const scalarMs =
      JSON.stringify({
        traceId: 't-ms',
        spanId: 's-ms',
        timestamp: T0 + 1000,
        _body: 'GenAI inference: gpt-5.4',
        attributes: {
          'event.name': 'gen_ai.client.inference.operation.details',
          'gen_ai.conversation.id': SID,
          'gen_ai.usage.input_tokens': 1,
        },
      }) + '\n';
    const unixNano =
      JSON.stringify({
        traceId: 't-ns',
        spanId: 's-ns',
        timeUnixNano: (T0 + 2000) * 1e6,
        _body: 'GenAI inference: gpt-5.4',
        attributes: {
          'event.name': 'gen_ai.client.inference.operation.details',
          'gen_ai.conversation.id': SID,
          'gen_ai.usage.input_tokens': 2,
        },
      }) + '\n';
    const noTime =
      JSON.stringify({
        traceId: 't-none',
        spanId: 's-none',
        _body: 'GenAI inference: gpt-5.4',
        attributes: {
          'event.name': 'gen_ai.client.inference.operation.details',
          'gen_ai.conversation.id': SID,
          'gen_ai.usage.input_tokens': 4,
        },
      }) + '\n';
    const endTime = chatSpan({ input: 8, output: 0, endMs: T0 + 3000 });
    const recs = extractOtelUsageRecords(scalarMs + unixNano + noTime + endTime, MTIME);
    const byInput = new Map(recs.map((r) => [r.usage.input_tokens, r.tsMs]));
    expect(byInput.get(1)).toBe(T0 + 1000);
    expect(byInput.get(2)).toBe(T0 + 2000);
    expect(byInput.get(4)).toBe(MTIME); // fallback
    expect(byInput.get(8)).toBe(T0 + 3000);
  });
});

describe('CopilotUsageSource.readUsage', () => {
  it('sums a session across shapes and files, filtered by session id', async () => {
    await writeOtel(
      'a.jsonl',
      chatSpan({ input: 100, output: 10, cacheRead: 20 }) +
        chatSpan({ session: 'conv-other', input: 999, output: 99 })
    );
    await writeOtel('b.jsonl', inferenceLog({ input: 40, output: 4, model: 'gpt-5.4' }));
    const snap = await source().readUsage(SID);
    expect(snap).not.toBeNull();
    expect(snap!.recordCount).toBe(2);
    expect(snap!.total).toEqual({
      input_tokens: 120, // (100 − 20) + 40
      output_tokens: 14,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
    });
    expect(snap!.modelBreakdown.map((m) => m.model)).toEqual(['claude-sonnet-4.6', 'gpt-5.4']);
  });

  it('dedups the same span appearing in two files (traceId:spanId key)', async () => {
    const span = chatSpan({ input: 50, output: 5, traceId: 'trace-x', spanId: 'span-x' });
    await writeOtel('a.jsonl', span);
    await writeOtel('b.jsonl', span);
    const snap = await source().readUsage(SID);
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(50);
  });

  it('honors the until cutoff and reports asOf accordingly', async () => {
    await writeOtel(
      'a.jsonl',
      chatSpan({ input: 10, output: 1, endMs: T0 }) +
        chatSpan({ input: 99, output: 9, endMs: T0 + 60 * 60_000 })
    );
    const until = new Date(T0 + 30 * 60_000).toISOString();
    const snap = await source().readUsage(SID, { until });
    expect(snap!.recordCount).toBe(1);
    expect(snap!.total.input_tokens).toBe(10);
    expect(snap!.asOf).toBe(until);
    expect(await source().readUsage(SID, { until: '2020-01-01T00:00:00.000Z' })).toBeNull();
  });

  it('merges the COPILOT_OTEL_FILE_EXPORTER_PATH file, deduped against the dir', async () => {
    const inDir = await writeOtel('a.jsonl', chatSpan({ input: 10, output: 1 }));
    const outside = path.join(tmp, 'elsewhere.jsonl');
    await writeFile(outside, chatSpan({ input: 7, output: 2 }), 'utf8');

    const both = source({ COPILOT_OTEL_FILE_EXPORTER_PATH: outside });
    expect((await both.readUsage(SID))!.total.input_tokens).toBe(17);

    // Pointing the exporter path INTO the dir must not double-count.
    const dup = source({ COPILOT_OTEL_FILE_EXPORTER_PATH: inDir });
    expect((await dup.readUsage(SID))!.total.input_tokens).toBe(10);
  });

  it('returns null with no export dir, an unknown session, or a blank sid', async () => {
    expect(await source().readUsage(SID)).toBeNull(); // no dir at all
    await writeOtel('a.jsonl', chatSpan({ input: 10, output: 1 }));
    expect(await source().readUsage('conv-unknown')).toBeNull();
    expect(await source().readUsage('')).toBeNull();
    expect(await source().readUsage('   ')).toBeNull();
  });
});

describe('CopilotUsageSource.resolveActiveSessionId', () => {
  it('reads COPILOT_AGENT_SESSION_ID, trimmed; null when unset or blank', () => {
    expect(
      new CopilotUsageSource({ COPILOT_AGENT_SESSION_ID: `  ${SID}  ` }).resolveActiveSessionId()
    ).toBe(SID);
    expect(new CopilotUsageSource({}).resolveActiveSessionId()).toBeNull();
    expect(
      new CopilotUsageSource({ COPILOT_AGENT_SESSION_ID: '   ' }).resolveActiveSessionId()
    ).toBeNull();
  });

  it('has no filesystem discovery (env is the only channel)', () => {
    expect('discoverActiveSessionId' in new CopilotUsageSource({})).toBe(false);
  });
});
