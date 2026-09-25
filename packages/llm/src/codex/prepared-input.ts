import type {
  PreparedInputAdapter,
  PreparedInputInvocation,
  ProviderOutcome,
  TokenUsage,
} from '../prepared-input-adapter.js';

const MINIMUM_VERSION = [0, 154, 0] as const;
const STREAM_ENVELOPE_ALLOWANCE_BYTES = 2 * 1024 * 1024;
const JSON_ESCAPE_GROWTH = 2;

// Built-in provider entries ignore retry overrides. A named provider keeps the
// saved-login route while making request and stream retry counts effective.
const RESTRICTED_CONFIG = [
  'approval_policy="never"',
  'agents.enabled=false',
  'allow_login_shell=false',
  'apps._default.enabled=false',
  'default_permissions="orcaops_restricted"',
  'features.apps=false',
  'features.browser_use=false',
  'features.code_mode=false',
  'features.computer_use=false',
  'features.goals=false',
  'features.hooks=false',
  'features.image_generation=false',
  'features.in_app_browser=false',
  'features.in_app_local_automation=false',
  'features.memories=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.shell_snapshot=false',
  'features.shell_tool=false',
  'features.skill_mcp_dependency_install=false',
  'features.skill_search=false',
  'features.sleep_tool=false',
  'features.tool_suggest=false',
  'features.unified_exec=false',
  'features.unbounded_connection_retries=false',
  'features.view_image=false',
  'mcp_servers={}',
  'model_provider="orcaops_openai"',
  'model_providers.orcaops_openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0}',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_environment_context=false',
  'permissions.orcaops_restricted={filesystem={":root"="deny",":minimal"="read"},network={enabled=false}}',
  'project_doc_max_bytes=0',
  'shell_environment_policy.inherit="none"',
  'skills.include_instructions=false',
  'suppress_unstable_features_warning=true',
  'tools.experimental_request_user_input.enabled=false',
  'tools.update_plan.enabled=false',
  'web_search="disabled"',
] as const;

const PASSIVE_ITEM_TYPES = new Set(['agent_message', 'error', 'reasoning', 'plan', 'todo_list']);
const EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

// Codex 0.154.0 may omit a denied nested functions.exec attempt from JSONL.
// Permission denial is the boundary; stream rejection is an additional signal.
export const codexRestrictedPreparedInputAdapter: PreparedInputAdapter = {
  preflight({ baseEnv }) {
    return {
      invocation: { args: ['--version'], env: buildCodexPreparedInputEnv(baseEnv) },
      validate(stdout) {
        const version = stdout.trim();
        const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(version);
        const parts = match?.slice(1).map(Number);
        const supported =
          parts !== undefined &&
          parts.every(Number.isSafeInteger) &&
          isAtLeastMinimumVersion(parts);
        return supported
          ? null
          : `Restricted Codex calls require codex-cli 0.154.0 or newer; found ${JSON.stringify(version || 'no version output')}.`;
      },
    };
  },

  invocation({ settings, outputSchemaFile, baseEnv }) {
    return {
      args: buildCodexPreparedInputArgs({
        model: settings.model.id,
        effort: settings.effort.value,
        outputSchemaFile,
      }),
      env: buildCodexPreparedInputEnv(baseEnv),
    };
  },

  maxStreamBytes(maxOutputBytes) {
    return maxOutputBytes * JSON_ESCAPE_GROWTH + STREAM_ENVELOPE_ALLOWANCE_BYTES;
  },

  interpret(stdout, { outputSchema }) {
    return interpretCodexJsonStream(stdout, outputSchema !== null);
  },
};

function isAtLeastMinimumVersion(version: number[]): boolean {
  for (const [index, part] of version.entries()) {
    if (part !== MINIMUM_VERSION[index]) return part > MINIMUM_VERSION[index];
  }
  return true;
}

export function buildCodexPreparedInputArgs(params: {
  model: string | null;
  effort: string | null;
  outputSchemaFile: string | null;
}): string[] {
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--color',
    'never',
  ];

  for (const config of RESTRICTED_CONFIG) args.push('-c', config);
  if (params.model !== null) args.push('--model', params.model);
  if (params.effort !== null)
    args.push('-c', `model_reasoning_effort=${tomlString(params.effort)}`);
  if (params.outputSchemaFile !== null) args.push('--output-schema', params.outputSchemaFile);
  args.push('-');
  return args;
}

function buildCodexPreparedInputEnv(baseEnv: NodeJS.ProcessEnv): PreparedInputInvocation['env'] {
  return {
    ...baseEnv,
    CI: 'true',
    TERM: 'dumb',
    ORCAOPS_HOOK_SUPPRESS: '1',
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function interpretCodexJsonStream(
  stdout: string,
  schemaRequested: boolean
): ProviderOutcome {
  const events: Record<string, unknown>[] = [];
  const protocolFailures: string[] = [];
  for (const [index, line] of stdout.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError('event is not an object');
      events.push(parsed);
    } catch (err) {
      protocolFailures.push(`Codex emitted invalid JSON on line ${index + 1}: ${errorText(err)}`);
      break;
    }
  }

  let state: 'initial' | 'thread' | 'turn' | 'terminal' = 'initial';
  for (const [index, event] of events.entries()) {
    const line = index + 1;
    if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
      protocolFailures.push(
        `Codex emitted an unsupported event type on line ${line}: ${JSON.stringify(event.type)}.`
      );
      continue;
    }
    if (state === 'terminal') {
      protocolFailures.push(`Codex emitted ${event.type} after the terminal turn event.`);
      continue;
    }
    if (event.type === 'thread.started') {
      if (state !== 'initial' || typeof event.thread_id !== 'string') {
        protocolFailures.push('Codex emitted an invalid or out-of-order thread.started event.');
      } else {
        state = 'thread';
      }
      continue;
    }
    if (event.type === 'turn.started') {
      if (state !== 'thread') {
        protocolFailures.push('Codex emitted an out-of-order turn.started event.');
      } else {
        state = 'turn';
      }
      continue;
    }
    if (isItemEvent(event)) {
      if (state !== 'turn') protocolFailures.push(`Codex emitted ${event.type} outside a turn.`);
      if (!isRecord(event.item) || typeof event.item.type !== 'string') {
        protocolFailures.push(`Codex emitted a malformed ${event.type} event.`);
      }
      continue;
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      if (state !== 'turn') {
        protocolFailures.push(`Codex emitted an out-of-order ${event.type} event.`);
      }
      if (event.type === 'turn.completed' && !hasUsageShape(event)) {
        protocolFailures.push('Codex emitted turn.completed without complete token usage.');
      }
      state = 'terminal';
    }
  }

  const completedTurns = events.filter((event) => event.type === 'turn.completed');
  const failedTurns = events.filter((event) => event.type === 'turn.failed');
  const agentMessages = events.flatMap((event) => {
    if (event.type !== 'item.completed' || !isRecord(event.item)) return [];
    return event.item.type === 'agent_message' && typeof event.item.text === 'string'
      ? [event.item.text]
      : [];
  });
  const toolUse = new Set<string>();
  const itemFailures: string[] = [];
  for (const event of events) {
    if (!isItemEvent(event) || !isRecord(event.item) || typeof event.item.type !== 'string') {
      continue;
    }
    if (!PASSIVE_ITEM_TYPES.has(event.item.type)) toolUse.add(event.item.type);
    if (event.item.type === 'error') itemFailures.push(itemErrorMessage(event.item));
  }

  const failures = [...protocolFailures, ...events.flatMap(failureMessage), ...itemFailures];
  const usage = completedTurns.map(usageOf).reduce(largerUsage, null);

  return {
    resultCount: completedTurns.length + failedTurns.length,
    body: agentMessages.at(-1) ?? '',
    reportedModel: null,
    usage,
    costUsd: null,
    failure:
      failures.length === 0 ? null : { kind: 'provider_error', message: failures.join('; ') },
    toolUse: [...toolUse],
    toolsAvailable: [],
    toolOfferStated: false,
    cutOffReason: null,
    structuredAnswerMissing:
      schemaRequested &&
      (agentMessages.length === 0 || !isJsonValue(agentMessages[agentMessages.length - 1]!)),
  };
}

function hasUsageShape(event: Record<string, unknown>): boolean {
  if (!isRecord(event.usage)) return false;
  return (
    nonnegativeInteger(event.usage.input_tokens) !== null &&
    nonnegativeInteger(event.usage.output_tokens) !== null &&
    (event.usage.cached_input_tokens === undefined ||
      nonnegativeInteger(event.usage.cached_input_tokens) !== null) &&
    (event.usage.cache_write_input_tokens === undefined ||
      nonnegativeInteger(event.usage.cache_write_input_tokens) !== null)
  );
}

function isItemEvent(event: Record<string, unknown>): boolean {
  return (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  );
}

function failureMessage(event: Record<string, unknown>): string[] {
  if (event.type !== 'turn.failed' && event.type !== 'error') return [];
  if (typeof event.message === 'string') return [event.message];
  if (isRecord(event.error) && typeof event.error.message === 'string') {
    return [event.error.message];
  }
  return [`Codex reported ${String(event.type)}.`];
}

function itemErrorMessage(item: Record<string, unknown>): string {
  if (typeof item.message === 'string') return item.message;
  if (typeof item.text === 'string') return item.text;
  return 'Codex reported an error item.';
}

function isJsonValue(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function usageOf(event: Record<string, unknown>): TokenUsage | null {
  if (!isRecord(event.usage)) return null;
  const input = nonnegativeInteger(event.usage.input_tokens);
  const output = nonnegativeInteger(event.usage.output_tokens);
  if (input === null || output === null) return null;
  const cacheRead = Math.min(nonnegativeInteger(event.usage.cached_input_tokens) ?? 0, input);
  const cacheWrite = nonnegativeInteger(event.usage.cache_write_input_tokens) ?? 0;
  if (input === 0 && output === 0 && cacheWrite === 0) return null;
  return {
    in: input - cacheRead,
    out: output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
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

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
