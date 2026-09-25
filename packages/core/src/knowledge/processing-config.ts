import { createHash } from 'node:crypto';

import type {
  CapabilityRefusal,
  EffectiveEffort,
  EffectiveModel,
  EffectiveOutputTokenCap,
  EffectiveSpendCap,
  LlmProvider,
  MeasuredPreparedInputRequest,
  NoToolCallRequest,
  NoToolCallResolution,
  PreparedInputRequestParts,
  ProviderCapabilities,
  ProviderProbeSnapshot,
  SpendCapBehavior,
  ToolAccess,
} from '@orcaops/llm';
import { canonicalJson, type Config } from '@orcaops/storage';

import { smallestProcessableInputBytes } from './interpretation/request.js';
import type { ConfigSourceKind } from '../config/source.js';

/**
 * The parts of the llm package this validation consults. They are passed in,
 * and imported above as types only: core is bundled into surfaces that must
 * not load the provider adapters.
 */
export interface LlmCapabilitySurface {
  capabilities: Readonly<Record<LlmProvider, ProviderCapabilities>>;
  selectDefaultProvider(
    tool: Config['llm']['tool'],
    availability: ProviderProbeSnapshot
  ): LlmProvider | null;
  resolveNoToolCall(request: NoToolCallRequest): NoToolCallResolution;
  /** How the input cap is judged: what a request of the smallest source would actually send. */
  measurePreparedInputRequest(parts: PreparedInputRequestParts): MeasuredPreparedInputRequest;
}

export interface ProcessingConfigSource {
  kind: ConfigSourceKind;
  path: string;
}

export interface KnowledgeProcessingInput {
  config: Config;
  /** The file that governs the job's originating worktree, as the config loader resolved it. */
  source: ProcessingConfigSource;
  providerAvailability: ProviderProbeSnapshot;
  llm: LlmCapabilitySurface;
}

export type ProcessingPauseCode =
  | 'disabled'
  | 'llm_tool_none'
  | 'provider_unavailable'
  | 'provider_unverified'
  | 'provider_unsupported'
  | 'tool_access_unsupported'
  | 'no_tool_execution_unenforced'
  | 'model_invalid'
  | 'effort_unsupported'
  | 'per_call_cap_unenforceable'
  | 'output_token_cap_unenforceable'
  | 'daily_budget_unenforceable'
  | 'daily_budget_below_per_call_cap'
  | 'input_cap_below_floor';

export interface ProcessingPauseReason {
  code: ProcessingPauseCode;
  /** The configuration key to change, when one key is responsible. */
  setting: string | null;
  message: string;
}

export type ProcessingNoticeCode =
  | 'inherited_model_not_carried'
  | 'inherited_effort_dropped'
  | 'inherited_per_call_cap_dropped'
  | 'per_call_cap_best_effort'
  | 'no_per_call_cap'
  | 'no_daily_budget';

export interface ProcessingNotice {
  code: ProcessingNoticeCode;
  message: string;
}

export type PerCallSpendLimit = 'none' | { usd: number; holds: 'ceiling' | 'best_effort' };

/**
 * Keyed by setting name, and the same shape the consent decision compares
 * against what a person was shown, so it is handed over unchanged.
 */
export interface EffectiveProcessingLimits {
  max_cost_usd_per_call: PerCallSpendLimit;
  max_cost_usd_per_day: number | 'none';
  max_calls_per_hour: number;
  max_input_bytes: number;
  max_output_bytes: number;
}

export interface EffectiveProcessingConfiguration {
  source: ProcessingConfigSource;
  provider: { id: LlmProvider; selection: 'explicit' | 'inherited' };
  toolAccess: ToolAccess;
  model: EffectiveModel;
  effort: EffectiveEffort;
  limits: EffectiveProcessingLimits;
  outputTokenCap: EffectiveOutputTokenCap;
  /**
   * The request these settings were resolved from. The llm call resolves it
   * again, and an inherited best-effort amount cannot be restated as an
   * explicit one, so the worker passes this on instead of rebuilding it.
   */
  callRequest: NoToolCallRequest;
  timeoutMs: number;
  maxAttempts: number;
  idleExitMs: number;
  notices: ProcessingNotice[];
  /**
   * SHA-256 over the effective values a call runs under. Where a value came
   * from (inherited or explicit, which file) is left out, so moving a setting
   * without changing it keeps the identity. Carries no credentials.
   */
  configurationIdentity: string;
}

export type KnowledgeProcessingResolution =
  | { status: 'ready'; configuration: EffectiveProcessingConfiguration }
  | {
      status: 'paused';
      source: ProcessingConfigSource;
      /** Null when no provider could be selected at all. */
      provider: LlmProvider | null;
      reasons: ProcessingPauseReason[];
    };

const SECTION = 'knowledge_processing';

const PAUSE_CODE_BY_REFUSED_CAPABILITY: Readonly<
  Record<CapabilityRefusal['capability'], ProcessingPauseCode>
> = {
  provider: 'provider_unsupported',
  tool_access: 'tool_access_unsupported',
  no_tool_execution: 'no_tool_execution_unenforced',
  model: 'model_invalid',
  effort: 'effort_unsupported',
  spend_cap: 'per_call_cap_unenforceable',
  output_token_cap: 'output_token_cap_unenforceable',
};

/**
 * Resolve the settings background knowledge processing would run under, or
 * why it is paused. Judges only combinations that base configuration
 * validation already accepted as well-formed, and returns every refusal as a
 * value: an unsupported combination pauses this workload and must never fail a
 * capture, so nothing on the capture path may depend on this succeeding.
 */
export function resolveKnowledgeProcessing(
  input: KnowledgeProcessingInput
): KnowledgeProcessingResolution {
  const { config, source, providerAvailability, llm } = input;
  const processing = config.knowledge_processing;
  const availabilityOf = (name: string): string | undefined =>
    Object.hasOwn(providerAvailability, name)
      ? providerAvailability[name as LlmProvider]
      : undefined;
  const paused = (
    provider: LlmProvider | null,
    reasons: ProcessingPauseReason[]
  ): KnowledgeProcessingResolution => ({ status: 'paused', source, provider, reasons });

  if (!processing.enabled) {
    return paused(null, [
      {
        code: 'disabled',
        setting: `${SECTION}.enabled`,
        message:
          source.kind === 'none'
            ? 'Knowledge processing is off: no orcaops configuration file exists, and it is off by default.'
            : `Knowledge processing is off: ${SECTION}.enabled is false in ${source.path}.`,
      },
    ]);
  }
  if (config.llm.tool === 'none') {
    return paused(null, [
      {
        code: 'llm_tool_none',
        setting: 'llm.tool',
        message:
          `llm.tool is "none" in ${source.path}, which turns off every model call, so knowledge ` +
          'processing cannot run with these settings.',
      },
    ]);
  }

  const llmToolProvider = llm.selectDefaultProvider(config.llm.tool, providerAvailability);
  const providerIsExplicit = processing.provider !== 'inherit';
  const provider = processing.provider === 'inherit' ? llmToolProvider : processing.provider;
  if (provider === null) {
    const candidates = Object.keys(llm.capabilities);
    const unconfirmed = candidates.filter((name) => availabilityOf(name) !== 'absent');
    return paused(null, [
      unconfirmed.length === 0
        ? {
            code: 'provider_unavailable',
            setting: 'llm.tool',
            message:
              `No model provider was found on this machine (looked for ` +
              `${candidates.join(', ')}). Install a native CLI or official npm package. ` +
              'Launcher scripts are excluded; ORCAOPS_CLAUDE_PATH and ORCAOPS_CODEX_PATH can select the underlying entrypoint.',
          }
        : {
            code: 'provider_unverified',
            setting: 'llm.tool',
            message:
              `Which model provider is installed could not be verified: no completed check for ` +
              `${unconfirmed.join(', ')}. No call is sent until one can be confirmed.`,
          },
    ]);
  }
  const providerSetting = providerIsExplicit ? `${SECTION}.provider` : 'llm.tool';

  const reasons: ProcessingPauseReason[] = [];
  const availability = availabilityOf(provider);
  if (availability === 'absent') {
    reasons.push({
      code: 'provider_unavailable',
      setting: providerSetting,
      message:
        `${provider} (${providerSetting}) was not found on this machine. No other provider is ` +
        `used in its place. Prepared-input processing excludes launcher scripts; set ` +
        `${provider === 'claude' ? 'ORCAOPS_CLAUDE_PATH' : 'ORCAOPS_CODEX_PATH'} to a native CLI or official npm entrypoint.`,
    });
  } else if (availability !== 'present') {
    reasons.push({
      code: 'provider_unverified',
      setting: providerSetting,
      message:
        `Whether ${provider} (${providerSetting}) is installed could not be confirmed: its ` +
        'version check did not finish. No call is sent until it can be confirmed.',
    });
  }

  const perCallSetting = processing.max_cost_usd_per_call;
  const explicitPerCallUsd = typeof perCallSetting === 'number' ? perCallSetting : undefined;
  const callRequest: NoToolCallRequest = {
    provider,
    toolAccess: processing.tool_access,
    explicitModel:
      processing.model === 'inherit' || processing.model === 'provider_default'
        ? null
        : processing.model,
    explicitEffort: processing.effort === 'inherit' ? undefined : processing.effort,
    explicitMaxCostUsd: explicitPerCallUsd,
    maxOutputTokens: processing.max_output_tokens,
    inherited: {
      // `llm.model` was configured for the provider `llm.tool` resolves to, and
      // is carried to that provider only.
      provider: llmToolProvider,
      model: processing.model === 'provider_default' ? null : config.llm.model,
      effort: config.llm.effort,
      maxCostUsd: perCallSetting === 'inherit' ? config.llm.default_max_cost_usd : undefined,
    },
  };
  const resolution = llm.resolveNoToolCall(callRequest);

  const settingByRefusedCapability: Record<CapabilityRefusal['capability'], string> = {
    provider: providerSetting,
    tool_access: `${SECTION}.tool_access`,
    no_tool_execution: `${SECTION}.tool_access`,
    model: `${SECTION}.model`,
    effort: `${SECTION}.effort`,
    spend_cap:
      explicitPerCallUsd === undefined
        ? 'llm.default_max_cost_usd'
        : `${SECTION}.max_cost_usd_per_call`,
    output_token_cap: `${SECTION}.max_output_tokens`,
  };
  if (resolution.status === 'unavailable') {
    for (const refusal of resolution.refusals) {
      const setting = settingByRefusedCapability[refusal.capability];
      reasons.push({
        code: PAUSE_CODE_BY_REFUSED_CAPABILITY[refusal.capability],
        setting,
        message: `${setting}: ${refusal.message}`,
      });
    }
  }

  // A surface may be handed a provider its capability table does not declare.
  // That pauses; it must not reach a lookup that would throw.
  const capabilities = Object.hasOwn(llm.capabilities, provider)
    ? llm.capabilities[provider]
    : null;
  if (capabilities === null) {
    if (!reasons.some((reason) => reason.code === 'provider_unsupported')) {
      reasons.push({
        code: 'provider_unsupported',
        setting: providerSetting,
        message:
          `${providerSetting}: ${provider} is not a provider whose capabilities are declared ` +
          `(${Object.keys(llm.capabilities).join(', ')}), so nothing it would enforce is known.`,
      });
    }
    return paused(provider, reasons);
  }

  const floor = smallestProcessableInputBytes({
    provider,
    measure: { measurePreparedInputRequest: llm.measurePreparedInputRequest },
  });
  if (processing.max_input_bytes < floor) {
    const setting = `${SECTION}.max_input_bytes`;
    reasons.push({
      code: 'input_cap_below_floor',
      setting,
      message:
        `${setting}: ${processing.max_input_bytes} bytes is below the ${floor} the smallest ` +
        `source needs. The instructions and the answer schema are sent before any of the source ` +
        `is, and a quarter of the cap is always reserved for related knowledge, so under ` +
        `${floor} every capture is a size-limit condition whatever its length. Raise ` +
        `${setting} to ${floor} or more.`,
    });
  }

  const spend = decideSpendLimits({
    provider,
    spendCapBehavior: capabilities.spendCap,
    perCall: resolution.status === 'available' ? resolution.settings.spendCap : null,
    requestedPerDayUsd: processing.max_cost_usd_per_day,
  });
  reasons.push(...spend.reasons);

  if (resolution.status === 'unavailable' || reasons.length > 0) return paused(provider, reasons);

  const { toolAccess, model, effort, outputTokenCap } = resolution.settings;
  const limits: EffectiveProcessingLimits = {
    max_cost_usd_per_call: spend.perCall,
    max_cost_usd_per_day: spend.perDay,
    max_calls_per_hour: processing.max_calls_per_hour,
    max_input_bytes: processing.max_input_bytes,
    max_output_bytes: processing.max_output_bytes,
  };
  const settings = {
    provider,
    tool_access: toolAccess,
    model: model.id,
    effort: effort.value,
    limits,
    output_token_cap: outputTokenCap.kind === 'enforced' ? outputTokenCap.tokens : 'none',
    timeout_ms: processing.timeout_ms,
    max_attempts: processing.max_attempts,
    idle_exit_ms: processing.idle_exit_ms,
  };
  return {
    status: 'ready',
    configuration: {
      source,
      provider: { id: provider, selection: providerIsExplicit ? 'explicit' : 'inherited' },
      toolAccess,
      model,
      effort,
      limits,
      outputTokenCap,
      callRequest,
      timeoutMs: processing.timeout_ms,
      maxAttempts: processing.max_attempts,
      idleExitMs: processing.idle_exit_ms,
      notices: [
        ...inheritanceNotices(provider, model, effort),
        ...spendNotices(provider, resolution.settings.spendCap, limits),
      ],
      configurationIdentity: configurationIdentity(settings),
    },
  };
}

/**
 * The one place that decides which dollar limits this workload may promise.
 *
 * A provider that stops a call only after the amount is exceeded holds no
 * ceiling: an amount passed to it is labelled best effort, and nothing can be
 * reserved against a daily budget, so a daily budget pauses the workload.
 * Reserving a best-effort amount instead would let a day overrun its budget by
 * one response per call while still being shown as a budget. The refusal of an
 * explicit per-call amount is the llm package's own; `perCall` is null when it
 * refused the call.
 */
function decideSpendLimits(input: {
  provider: LlmProvider;
  spendCapBehavior: SpendCapBehavior;
  perCall: EffectiveSpendCap | null;
  requestedPerDayUsd: number | undefined;
}): { perCall: PerCallSpendLimit; perDay: number | 'none'; reasons: ProcessingPauseReason[] } {
  const { provider, spendCapBehavior, perCall, requestedPerDayUsd } = input;
  const perCallLimit: PerCallSpendLimit =
    perCall === null || perCall.kind === 'none'
      ? 'none'
      : { usd: perCall.usd, holds: perCall.kind === 'enforced' ? 'ceiling' : 'best_effort' };
  if (requestedPerDayUsd === undefined) {
    return { perCall: perCallLimit, perDay: 'none', reasons: [] };
  }

  const setting = `${SECTION}.max_cost_usd_per_day`;
  const reasons: ProcessingPauseReason[] = [];
  if (spendCapBehavior !== 'hard_ceiling') {
    const shortfall =
      spendCapBehavior === 'stops_after_exceeded'
        ? `${provider} stops a call only after its amount is exceeded`
        : `${provider} cannot limit what a call spends`;
    reasons.push({
      code: 'daily_budget_unenforceable',
      setting,
      message:
        `${setting}: a daily budget of $${requestedPerDayUsd} is enforced by reserving each ` +
        `call's hard ceiling against it before the call is sent, and ${shortfall}, so there is ` +
        'nothing to reserve and the budget would not be a guarantee. Remove the daily budget; ' +
        `${SECTION}.max_calls_per_hour limits calls, not dollars.`,
    });
  } else if (perCall !== null && perCall.kind !== 'enforced') {
    reasons.push({
      code: 'daily_budget_unenforceable',
      setting,
      message:
        `${setting}: a daily budget of $${requestedPerDayUsd} is enforced by reserving each ` +
        `call's hard ceiling against it, and no per-call ceiling is set. Set ` +
        `${SECTION}.max_cost_usd_per_call to an amount, or remove the daily budget.`,
    });
  } else if (perCall !== null && perCall.usd > requestedPerDayUsd) {
    reasons.push({
      code: 'daily_budget_below_per_call_cap',
      setting,
      message:
        `${setting}: the daily budget of $${requestedPerDayUsd} is below the per-call ceiling of ` +
        `$${perCall.usd}, so no call's reservation could ever fit. Raise the daily budget or ` +
        'lower the per-call ceiling.',
    });
  }
  return { perCall: perCallLimit, perDay: requestedPerDayUsd, reasons };
}

function inheritanceNotices(
  provider: LlmProvider,
  model: EffectiveModel,
  effort: EffectiveEffort
): ProcessingNotice[] {
  const notices: ProcessingNotice[] = [];
  if (model.selection === 'provider_default' && model.inheritedModelNotCarried !== null) {
    notices.push({
      code: 'inherited_model_not_carried',
      message:
        `llm.model "${model.inheritedModelNotCarried}" was configured for another provider and ` +
        `is not passed to ${provider}, which uses its own default model.`,
    });
  }
  if (effort.selection === 'provider_default' && effort.inheritedEffortDropped !== null) {
    notices.push({
      code: 'inherited_effort_dropped',
      message:
        `llm.effort "${effort.inheritedEffortDropped}" is not applied: ${provider} has no ` +
        'effort setting.',
    });
  }
  return notices;
}

function spendNotices(
  provider: LlmProvider,
  spendCap: EffectiveSpendCap,
  limits: EffectiveProcessingLimits
): ProcessingNotice[] {
  const notices: ProcessingNotice[] = [];
  const perCall = limits.max_cost_usd_per_call;
  if (perCall === 'none') {
    if (spendCap.kind === 'none' && spendCap.inheritedCapDropped !== null) {
      notices.push({
        code: 'inherited_per_call_cap_dropped',
        message:
          `llm.default_max_cost_usd ($${spendCap.inheritedCapDropped}) is not applied: ` +
          `${provider} cannot limit what a call spends.`,
      });
    }
    notices.push({ code: 'no_per_call_cap', message: 'No per-call dollar cap applies.' });
  } else if (perCall.holds === 'best_effort') {
    notices.push({
      code: 'per_call_cap_best_effort',
      message:
        `The per-call amount of $${perCall.usd} is best effort, not a cap: ${provider} stops a ` +
        'call only after the amount is exceeded, so one response can cost more.',
    });
  }
  if (limits.max_cost_usd_per_day === 'none') {
    notices.push({
      code: 'no_daily_budget',
      message: `No daily dollar budget applies. ${SECTION}.max_calls_per_hour limits calls, not dollars.`,
    });
  }
  return notices;
}

/** One wording for every surface that must tell a provider default from a model orcaops selects. */
export function describeProcessingModel(model: EffectiveModel): string {
  if (model.selection === 'explicit') return `${model.id} (selected by ${SECTION}.model)`;
  if (model.selection === 'inherited') return `${model.id} (selected by llm.model)`;
  return "the provider's default model (orcaops selects none)";
}

function configurationIdentity(settings: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, settings }))
    .digest('hex');
}
