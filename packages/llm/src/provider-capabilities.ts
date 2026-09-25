import { LLM_TOOL_PREFERENCE, type LlmProvider } from './detect.js';
import type { Effort } from './types.js';

/**
 * What the orcaops adapter for a provider can ENFORCE or OBSERVE on a call —
 * never what the underlying CLI merely accepts. A flag the CLI takes but the
 * adapter cannot turn into a guarantee is declared `false`.
 */
export interface ProviderCapabilities {
  /** Every tool is disabled by adapter flags, independent of the prompt. */
  readonly enforcesNoToolExecution: boolean;
  readonly spendCap: SpendCapBehavior;
  readonly enforcesOutputTokenCap: boolean;
  readonly reportsUsage: boolean;
  readonly reportsCost: boolean;
  readonly supportsEffort: boolean;
  readonly supportsSystemPrompt: boolean;
  /** A JSON schema is forwarded to the provider. Callers still validate the answer. */
  readonly supportsStructuredOutput: boolean;
  readonly readsInputFromStdin: boolean;
}

/**
 * What a per-call dollar limit does on a provider. `hard_ceiling`: no call can
 * cost more. `stops_after_exceeded`: the provider stops only once the amount
 * has been spent, so a single response can exceed it. `none`: no limit at all.
 */
export type SpendCapBehavior = 'hard_ceiling' | 'stops_after_exceeded' | 'none';

/** `codex_restricted` is defense in depth and is not an all-tools-disabled guarantee. */
export type ToolAccess = 'none' | 'codex_restricted';

export const PROVIDER_CAPABILITIES: Readonly<Record<LlmProvider, ProviderCapabilities>> = {
  claude: Object.freeze({
    enforcesNoToolExecution: true,
    spendCap: 'stops_after_exceeded',
    enforcesOutputTokenCap: false,
    reportsUsage: true,
    reportsCost: true,
    supportsEffort: true,
    supportsSystemPrompt: true,
    supportsStructuredOutput: true,
    readsInputFromStdin: true,
  }),
  codex: Object.freeze({
    enforcesNoToolExecution: false,
    spendCap: 'none',
    enforcesOutputTokenCap: false,
    reportsUsage: true,
    reportsCost: false,
    supportsEffort: true,
    supportsSystemPrompt: false,
    supportsStructuredOutput: true,
    readsInputFromStdin: true,
  }),
};

const NO_TOOL_EXECUTION_GAP: Readonly<Record<LlmProvider, string | null>> = {
  claude: null,
  codex: 'Codex does not expose a supported control that removes every built-in and hosted tool',
};

/** The evaluator configuration (`llm.*`) a no-tool workload may inherit from. */
export interface InheritedLlmSettings {
  /** The provider `llm.tool` resolves to: the one `model` was configured for. */
  provider: LlmProvider | null;
  model: string | null;
  effort?: Effort;
  maxCostUsd?: number;
}

export interface NoToolCallRequest {
  /** The provider selected for the workload. It is never substituted. */
  provider: LlmProvider;
  /** Defaults to the strict no-tool policy. The restricted policy must be explicit. */
  toolAccess?: ToolAccess;
  /** A model chosen for this workload; used exactly as given. */
  explicitModel?: string | null;
  explicitEffort?: Effort;
  /** A hard per-call spend cap the workload asked for. */
  explicitMaxCostUsd?: number;
  /** A hard generation limit the workload asked for. */
  maxOutputTokens?: number;
  inherited?: InheritedLlmSettings;
}

export type EffectiveModel =
  | { selection: 'explicit' | 'inherited'; id: string }
  | {
      selection: 'provider_default';
      id: null;
      /** A configured model left behind because it belongs to another provider. */
      inheritedModelNotCarried: string | null;
    };

export type EffectiveEffort =
  | { selection: 'explicit' | 'inherited'; value: Effort }
  | { selection: 'provider_default'; value: null; inheritedEffortDropped: Effort | null };

export type EffectiveSpendCap =
  | { kind: 'enforced'; usd: number; selection: 'explicit' | 'inherited' }
  /** Passed to a provider that stops only after the amount is spent: a call can cost more. */
  | { kind: 'best_effort'; usd: number; selection: 'inherited' }
  | { kind: 'none'; inheritedCapDropped: number | null };

export type EffectiveOutputTokenCap = { kind: 'enforced'; tokens: number } | { kind: 'none' };

export interface EffectiveCallSettings {
  provider: LlmProvider;
  toolAccess: ToolAccess;
  model: EffectiveModel;
  effort: EffectiveEffort;
  spendCap: EffectiveSpendCap;
  outputTokenCap: EffectiveOutputTokenCap;
  capabilities: ProviderCapabilities;
}

export type RefusedCapability =
  | 'provider'
  | 'tool_access'
  | 'no_tool_execution'
  | 'spend_cap'
  | 'output_token_cap'
  | 'effort'
  | 'model';

export interface CapabilityRefusal {
  capability: RefusedCapability;
  message: string;
}

export type NoToolCallResolution =
  | { status: 'available'; provider: LlmProvider; settings: EffectiveCallSettings }
  | { status: 'unavailable'; provider: LlmProvider; refusals: CapabilityRefusal[] };

const SPEND_CAP_DECIMALS = 4;
const SPEND_CAP_UNITS_PER_USD = 10 ** SPEND_CAP_DECIMALS;

/**
 * Decide whether `request.provider` can serve the requested tool-access policy
 * and with which settings. A cap the provider cannot enforce refuses instead
 * of being dropped, and no other provider is ever considered.
 */
export function resolveNoToolCall(request: NoToolCallRequest): NoToolCallResolution {
  if (!isSupportedProvider(request.provider)) {
    return {
      status: 'unavailable',
      provider: request.provider,
      refusals: [
        {
          capability: 'provider',
          message:
            `${JSON.stringify(request.provider)} is not a supported provider. ` +
            `Select one of: ${LLM_TOOL_PREFERENCE.join(', ')}.`,
        },
      ],
    };
  }
  return resolveNoToolCallWithCapabilities(request, PROVIDER_CAPABILITIES[request.provider]);
}

/** Guards callers that take the provider from configuration or another untyped source. */
export function isSupportedProvider(provider: unknown): provider is LlmProvider {
  return typeof provider === 'string' && Object.hasOwn(PROVIDER_CAPABILITIES, provider);
}

/**
 * The resolution rules over a given capability set. Tests use it to reach
 * combinations no shipped provider has; it is kept out of the package exports
 * so production code cannot vouch for a provider with invented capabilities.
 */
export function resolveNoToolCallWithCapabilities(
  request: NoToolCallRequest,
  capabilities: ProviderCapabilities
): NoToolCallResolution {
  const { provider } = request;
  const refusals: CapabilityRefusal[] = [];
  const toolAccess = request.toolAccess ?? 'none';

  if (!isToolAccess(toolAccess)) {
    refusals.push({
      capability: 'tool_access',
      message:
        `${JSON.stringify(toolAccess)} is not a supported tool-access policy. ` +
        'Select one of: none, codex_restricted.',
    });
  } else if (toolAccess === 'codex_restricted' && provider !== 'codex') {
    refusals.push({
      capability: 'tool_access',
      message: 'The codex_restricted tool-access policy is available only with the codex provider.',
    });
  } else if (toolAccess === 'none' && !capabilities.enforcesNoToolExecution) {
    const gap = NO_TOOL_EXECUTION_GAP[provider];
    refusals.push({
      capability: 'no_tool_execution',
      message:
        `${provider} cannot run with every tool disabled${gap !== null ? `: ${gap}` : ''}. ` +
        remedy(null, (provided) => provided.enforcesNoToolExecution, 'enforces no-tool execution'),
    });
  }

  const model = resolveModel(request, refusals);
  const effort = resolveEffort(request, capabilities, refusals);
  const spendCap = resolveSpendCap(request, capabilities, refusals);
  const outputTokenCap = resolveOutputTokenCap(request, capabilities, refusals);

  if (refusals.length > 0) return { status: 'unavailable', provider, refusals };
  return {
    status: 'available',
    provider,
    settings: {
      provider,
      toolAccess,
      model,
      effort,
      spendCap,
      outputTokenCap,
      capabilities,
    },
  };
}

export function isToolAccess(value: unknown): value is ToolAccess {
  return value === 'none' || value === 'codex_restricted';
}

function resolveModel(request: NoToolCallRequest, refusals: CapabilityRefusal[]): EffectiveModel {
  const explicit = request.explicitModel;
  if (explicit !== undefined && explicit !== null) {
    if (explicit.trim().length === 0) {
      refusals.push({
        capability: 'model',
        message: `The model selected for ${request.provider} is empty. Name a model or remove the setting to use the provider default.`,
      });
    }
    return { selection: 'explicit', id: explicit };
  }
  const inherited = request.inherited;
  if (inherited?.model) {
    if (inherited.provider === request.provider) {
      return { selection: 'inherited', id: inherited.model };
    }
    return { selection: 'provider_default', id: null, inheritedModelNotCarried: inherited.model };
  }
  return { selection: 'provider_default', id: null, inheritedModelNotCarried: null };
}

function resolveEffort(
  request: NoToolCallRequest,
  capabilities: ProviderCapabilities,
  refusals: CapabilityRefusal[]
): EffectiveEffort {
  if (request.explicitEffort !== undefined) {
    if (!capabilities.supportsEffort) {
      refusals.push({
        capability: 'effort',
        message:
          `${request.provider} has no effort setting, so the requested effort ` +
          `"${request.explicitEffort}" cannot be applied. ` +
          remedy(
            'Remove the effort setting',
            (provided) => provided.supportsEffort,
            'supports effort'
          ),
      });
    }
    return { selection: 'explicit', value: request.explicitEffort };
  }
  const inherited = request.inherited?.effort;
  if (inherited !== undefined && capabilities.supportsEffort) {
    return { selection: 'inherited', value: inherited };
  }
  return { selection: 'provider_default', value: null, inheritedEffortDropped: inherited ?? null };
}

function resolveSpendCap(
  request: NoToolCallRequest,
  capabilities: ProviderCapabilities,
  refusals: CapabilityRefusal[]
): EffectiveSpendCap {
  const explicit = request.explicitMaxCostUsd;
  const inherited = request.inherited?.maxCostUsd;
  const requested = explicit ?? inherited;
  if (requested === undefined) return { kind: 'none', inheritedCapDropped: null };

  const refuse = (message: string): EffectiveSpendCap => {
    refusals.push({ capability: 'spend_cap', message });
    return { kind: 'none', inheritedCapDropped: null };
  };
  const holdsCeiling = (provided: ProviderCapabilities): boolean =>
    provided.spendCap === 'hard_ceiling';

  if (explicit !== undefined && capabilities.spendCap !== 'hard_ceiling') {
    const shortfall =
      capabilities.spendCap === 'stops_after_exceeded'
        ? `${request.provider} stops a call only after the amount is exceeded, so a single ` +
          `response can exceed the requested cap of ${describeUsd(explicit)}`
        : `${request.provider} cannot limit what a call spends, so the requested cap of ` +
          `${describeUsd(explicit)} would not be a guarantee`;
    return refuse(
      `${shortfall}. ` +
        remedy('Remove the cap', holdsCeiling, 'holds a hard per-call spend ceiling')
    );
  }
  if (capabilities.spendCap === 'none') return { kind: 'none', inheritedCapDropped: requested };

  const usd = passableSpendCapUsd(requested);
  if (usd === null) {
    return refuse(
      `A per-call spend cap of ${String(requested)} cannot be passed to ${request.provider}: ` +
        `it must be a dollar amount of at least $${formatUsd(1 / SPEND_CAP_UNITS_PER_USD)}.`
    );
  }
  if (capabilities.spendCap === 'hard_ceiling') {
    return { kind: 'enforced', usd, selection: explicit !== undefined ? 'explicit' : 'inherited' };
  }
  return { kind: 'best_effort', usd, selection: 'inherited' };
}

/**
 * The cap as the provider will actually receive it. The Claude argument
 * builder rounds to four decimals, and rounding to nearest could RAISE the
 * cap, so the value is floored to that precision first.
 */
function passableSpendCapUsd(requested: number): number | null {
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const units = Math.floor(requested * SPEND_CAP_UNITS_PER_USD + 1e-6);
  return units >= 1 ? units / SPEND_CAP_UNITS_PER_USD : null;
}

function resolveOutputTokenCap(
  request: NoToolCallRequest,
  capabilities: ProviderCapabilities,
  refusals: CapabilityRefusal[]
): EffectiveOutputTokenCap {
  const requested = request.maxOutputTokens;
  if (requested === undefined) return { kind: 'none' };
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    refusals.push({
      capability: 'output_token_cap',
      message: `An output token cap of ${String(requested)} cannot be enforced: it must be a positive whole number of tokens.`,
    });
    return { kind: 'none' };
  }
  if (!capabilities.enforcesOutputTokenCap) {
    refusals.push({
      capability: 'output_token_cap',
      message:
        `${request.provider} cannot enforce an output token cap, so the requested limit of ` +
        `${requested} tokens would not be a guarantee. ` +
        remedy(
          'Remove the limit',
          (provided) => provided.enforcesOutputTokenCap,
          'enforces an output token cap'
        ),
    });
    return { kind: 'none' };
  }
  return { kind: 'enforced', tokens: requested };
}

function remedy(
  removal: string | null,
  provides: (capabilities: ProviderCapabilities) => boolean,
  description: string
): string {
  const providers = LLM_TOOL_PREFERENCE.filter((name) => provides(PROVIDER_CAPABILITIES[name]));
  if (providers.length === 0) {
    return removal === null
      ? `No supported provider ${description}.`
      : `${removal}; no supported provider ${description}.`;
  }
  const selection = `elect a provider that ${description} (${providers.join(', ')}).`;
  return removal === null ? `S${selection}` : `${removal}, or s${selection}`;
}

function describeUsd(usd: number): string {
  return Number.isFinite(usd) ? `$${formatUsd(usd)}` : String(usd);
}

function formatUsd(usd: number): string {
  return usd.toFixed(SPEND_CAP_DECIMALS);
}
