import { type Operation, run } from 'effection';

import { createClaudeCodeClient } from './claude-code/index.js';
import { createCodexCliClient } from './codex/index.js';
import {
  type LlmProvider,
  probeProviderAvailability,
  type ProviderProbeSnapshot,
  selectDefaultProvider,
} from './detect.js';
import { deterministicClient } from './deterministic.js';
import type { EvaluateOptions, EvaluateResult, LLMClient } from './types.js';

/**
 * The subset of `Config['llm']` that buildLLMClient needs. We keep this
 * structurally compatible with @orcaops/core's Config so callers can pass
 * `config.llm` directly.
 */
export interface LLMClientConfig {
  tool: 'auto' | 'claude' | 'codex' | 'none';
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  default_max_cost_usd: number;
}

export interface BuildLLMClientOptions {
  noLlm?: boolean;
  /** Test injection — bypass detection and use this client. */
  override?: LLMClient;
  /**
   * Env override for `ORCAOPS_CLAUDE_PATH` / `ORCAOPS_CODEX_PATH`
   * lookups inside the built client. Defaults to `process.env`. Set by
   * the in-process test harness so concurrent parallel agents observe
   * distinct env for binary-path resolution without mutating globals.
   */
  env?: NodeJS.ProcessEnv;
}

type RunnableProviderAvailability = Readonly<Record<LlmProvider, boolean>>;

/**
 * Build an LLMClient for the given config. Resolves `tool: 'auto'` via
 * runtime detection; falls back to deterministic when no tool is found.
 *
 * Returns an Effection Operation so detection (which spawns `--version`
 * subprocesses) participates in the surrounding scope.
 */
export function buildLLMClient(
  config: LLMClientConfig,
  opts: BuildLLMClientOptions = {}
): Operation<LLMClient> {
  return resolveLLMClient(config, opts);
}

// 'auto' resolves to the first available CLI tool. If none are present,
// fall back to 'none' — a missing CLI is not a runtime failure; it just
// means LLM evaluators are recorded as skipped until the user installs one.
function* resolveToolChoice(
  config: Pick<LLMClientConfig, 'tool'>,
  env?: NodeJS.ProcessEnv
): Operation<'claude' | 'codex' | 'none'> {
  if (config.tool === 'auto') {
    const snapshot = yield* probeProviderAvailability({ env });
    return selectDefaultProvider('auto', snapshot) ?? 'none';
  }
  return config.tool;
}

/**
 * The value `LLMClient.defaultProvider` would carry for this config,
 * without constructing a client. Grant-time capability classification
 * (eval trust / add-pack / update-pack / doctor) must classify with the
 * same effective provider the dispatch gate will see, and those callers
 * are plain async CLI paths with no client in hand.
 */
export async function resolveDefaultProvider(
  config: Pick<LLMClientConfig, 'tool'>,
  env?: NodeJS.ProcessEnv
): Promise<'claude' | 'codex' | null> {
  const tool = await run(() => resolveToolChoice(config, env));
  return tool === 'none' ? null : tool;
}

function* resolveLLMClient(
  config: LLMClientConfig,
  opts: BuildLLMClientOptions
): Operation<LLMClient> {
  if (opts.override) return opts.override;
  if (opts.noLlm || config.tool === 'none') return deterministicClient;

  const snapshot = yield* probeProviderAvailability({ env: opts.env });
  const tool = selectDefaultProvider(config.tool, snapshot);
  if (tool === null) return deterministicClient;
  const availability = runnableAvailability(snapshot);

  // Per-evaluator provider routing. The default client matches
  // the resolved tool; the alt client is built lazily on first call so
  // the cost is only paid when a repo actually mixes providers.
  const defaultClient = buildClientForTool(tool, config, opts.env);
  return makeRoutingClient({
    defaultTool: tool,
    defaultClient,
    availability,
    buildAlt: (alt) => buildClientForTool(alt, config, opts.env),
  });
}

function runnableAvailability(snapshot: ProviderProbeSnapshot): RunnableProviderAvailability {
  return {
    claude: snapshot.claude !== 'absent',
    codex: snapshot.codex !== 'absent',
  };
}

/**
 * Wrap a default `LLMClient` so per-evaluate calls can override the
 * provider via `EvaluateOptions.provider`. Calls without an override
 * (or whose override matches the default) hit the existing client
 * unchanged. Override mismatches lazily build a sibling client and
 * cache it for subsequent calls.
 *
 * Exported for testing; production code reaches it via `buildLLMClient`.
 */
export interface MakeRoutingClientOptions {
  defaultTool: 'claude' | 'codex';
  defaultClient: LLMClient;
  /** Lazily build a client for an alt provider. Mock-friendly. */
  buildAlt: (tool: 'claude' | 'codex') => LLMClient;
  availability?: Readonly<Record<'claude' | 'codex', boolean>>;
}

export function makeRoutingClient(opts: MakeRoutingClientOptions): LLMClient {
  const altCache = new Map<'claude' | 'codex', LLMClient>();
  altCache.set(opts.defaultTool, opts.defaultClient);

  function pick(provider?: 'claude' | 'codex'): LLMClient {
    const tool = provider ?? opts.defaultTool;
    if (tool === opts.defaultTool) return opts.defaultClient;
    const cached = altCache.get(tool);
    if (cached) return cached;
    const fresh = opts.buildAlt(tool);
    altCache.set(tool, fresh);
    return fresh;
  }

  return {
    isDeterministic: false,
    defaultProvider: opts.defaultTool,
    isProviderAvailable(provider): boolean {
      return opts.availability?.[provider] ?? true;
    },
    evaluate(evalOpts: EvaluateOptions): Operation<EvaluateResult> {
      const provider = evalOpts.provider ?? opts.defaultTool;
      if (opts.availability?.[provider] === false) {
        return (function* (): Operation<EvaluateResult> {
          yield* [];
          return {
            body: `ERROR\n\n${provider} is not installed`,
            model: null,
            durationMs: 0,
            sessionId: `unavailable-${provider}`,
            error: { code: 'TOOL_NOT_FOUND', message: `${provider} is not installed` },
          };
        })();
      }
      return pick(evalOpts.provider).evaluate(evalOpts);
    },
  };
}

function buildClientForTool(
  tool: 'claude' | 'codex',
  config: LLMClientConfig,
  env?: NodeJS.ProcessEnv
): LLMClient {
  if (tool === 'claude') {
    return createClaudeCodeClient({
      defaultModel: config.model,
      defaultEffort: config.effort,
      defaultMaxBudgetUsd: config.default_max_cost_usd,
      env,
    });
  }
  return createCodexCliClient({
    defaultModel: config.model,
    env,
  });
}
