import { randomUUID } from 'node:crypto';

import type {
  PreparedInputAdapter,
  ProviderOutcome,
  TokenUsage,
} from '../prepared-input-adapter.js';
import { buildClaudeArgs, buildClaudeEnv } from './args.js';
import {
  type ClaudeResultEvent,
  type ClaudeStreamSummary,
  eventToEvaluateError,
  summarizeClaudeStream,
} from './stream-parser.js';

export const CLAUDE_PREPARED_INPUT_ENTRYPOINT = 'orcaops-prepared-input';

// With `--json-schema` the CLI has the model hand over its answer by calling
// this synthetic tool. It touches nothing, so it is the one tool call that does
// not break the no-tool guarantee — and only when a schema was requested.
const STRUCTURED_ANSWER_TOOL = 'StructuredOutput';

// stream-json repeats the answer — in the assistant event, in the result
// event, and once more as structured output — and JSON string escaping can
// double each copy. The envelope allowance covers the init and bookkeeping
// events that surround them.
const ANSWER_COPIES_IN_STREAM = 3;
const JSON_ESCAPE_GROWTH = 2;
const STREAM_ENVELOPE_ALLOWANCE_BYTES = 256 * 1024;

// Anything else, a status this adapter does not know included, may serve tools.
const MCP_STATUSES_WITHOUT_TOOLS = new Set(['failed', 'disabled', 'needs-auth']);

// `tool_use` is listed because it is judged as a sign of tool use, or as the
// structured-answer exemption, and never as a cut-off.
const WHOLE_ANSWER_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use']);

export const claudePreparedInputAdapter: PreparedInputAdapter = {
  invocation({ settings, systemPrompt, outputSchema, baseEnv }) {
    return {
      args: buildClaudeArgs({
        toolPolicy: { mode: 'none' },
        withholdAllTools: true,
        sessionId: randomUUID(),
        model: settings.model.id,
        ...(settings.effort.value !== null ? { effort: settings.effort.value } : {}),
        ...(settings.spendCap.kind !== 'none' ? { maxBudgetUsd: settings.spendCap.usd } : {}),
        ...(systemPrompt !== null ? { systemPrompt } : {}),
        outputSchema,
      }),
      env: buildClaudeEnv({ baseEnv, entrypoint: CLAUDE_PREPARED_INPUT_ENTRYPOINT }),
    };
  },

  maxStreamBytes(maxOutputBytes) {
    return (
      maxOutputBytes * ANSWER_COPIES_IN_STREAM * JSON_ESCAPE_GROWTH +
      STREAM_ENVELOPE_ALLOWANCE_BYTES
    );
  },

  interpret(stdout, { outputSchema }): ProviderOutcome {
    const summary = summarizeClaudeStream(stdout);
    const schemaRequested = outputSchema !== null;
    const isAnswerChannel = (name: string): boolean =>
      schemaRequested && name === STRUCTURED_ANSWER_TOOL;
    const { results } = summary;
    const result = results.length === 1 ? results[0] : undefined;
    const error = result !== undefined ? eventToEvaluateError(result) : undefined;
    const structured = schemaRequested ? result?.structuredOutput : undefined;
    const stopReason = result?.stopReason ?? summary.lastAssistantStopReason;
    const models = new Set(results.flatMap((event) => (event.model ? [event.model] : [])));

    return {
      resultCount: results.length,
      body: structured !== undefined ? JSON.stringify(structured) : (result?.body ?? ''),
      reportedModel: models.size === 1 ? [...models][0] : null,
      usage: results.map(usageOf).reduce(largerUsage, null),
      costUsd: results.map(costOf).reduce(largerCost, null),
      failure:
        error === undefined
          ? null
          : {
              kind: error.code === 'BUDGET' ? 'budget_exceeded' : 'provider_error',
              message: error.message,
            },
      toolUse: toolUseSigns(summary, stopReason, isAnswerChannel),
      toolsAvailable: [
        ...(summary.init?.tools ?? [])
          .filter((name) => !isAnswerChannel(name))
          .map((name) => `tool ${name}`),
        ...(summary.init?.mcpServers ?? [])
          .filter((server) => !MCP_STATUSES_WITHOUT_TOOLS.has(server.status ?? ''))
          .map((server) => `MCP server ${server.name} (${server.status ?? 'status not stated'})`),
      ],
      toolOfferStated: summary.init !== null && summary.init.tools !== null,
      cutOffReason:
        stopReason === null || stopReason === undefined || WHOLE_ANSWER_STOP_REASONS.has(stopReason)
          ? null
          : stopReason,
      structuredAnswerMissing: schemaRequested && structured === undefined,
    };
  },
};

function toolUseSigns(
  summary: ClaudeStreamSummary,
  stopReason: string | null | undefined,
  isAnswerChannel: (name: string) => boolean
): string[] {
  const answerChannelCalls = new Set(
    summary.toolUses.flatMap((use) => (isAnswerChannel(use.name) && use.id ? [use.id] : []))
  );
  const calledAnswerChannel = summary.toolUses.some((use) => isAnswerChannel(use.name));
  const signs = [
    ...summary.toolUses.filter((use) => !isAnswerChannel(use.name)).map((use) => use.name),
    ...summary.toolResults
      .filter((toolResult) => !answerChannelCalls.has(toolResult.toolUseId ?? ''))
      .map(() => 'a tool result returned to the model'),
    ...summary.results
      .flatMap((event) => event.permissionDenials ?? [])
      .map((name) => `${name} (refused by the provider)`),
    ...(stopReason === 'tool_use' && !calledAnswerChannel ? ['a stop to use a tool'] : []),
  ];
  return [...new Set(signs)];
}

/** Reported only when both sides of the exchange were counted; a half-report is unknown. */
function usageOf(event: ClaudeResultEvent): TokenUsage | null {
  const reported = event.reportedUsage;
  if (reported?.in === undefined || reported.out === undefined) return null;
  const counters = [reported.in, reported.out, reported.cacheRead ?? 0, reported.cacheWrite ?? 0];
  if (counters.every((counter) => counter === 0)) return null;
  return {
    in: reported.in,
    out: reported.out,
    ...(reported.cacheRead ? { cacheRead: reported.cacheRead } : {}),
    ...(reported.cacheWrite ? { cacheWrite: reported.cacheWrite } : {}),
  };
}

// A zero cost is indistinguishable from an unreported one, and counting an
// unknown spend as nothing is the unsafe direction.
function costOf(event: ClaudeResultEvent): number | null {
  const cost = event.cumulativeCostUsd;
  return cost !== undefined && cost > 0 ? cost : null;
}

// Results that disagree keep the larger figure: under-reporting spend is the unsafe direction.
function largerCost(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return a ?? b;
  return Math.max(a, b);
}

function largerUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null || b === null) return a ?? b;
  const cacheRead = Math.max(a.cacheRead ?? 0, b.cacheRead ?? 0);
  const cacheWrite = Math.max(a.cacheWrite ?? 0, b.cacheWrite ?? 0);
  return {
    in: Math.max(a.in, b.in),
    out: Math.max(a.out, b.out),
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}
