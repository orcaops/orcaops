import type { EffectiveCallSettings } from './provider-capabilities.js';
import type { JsonSchema } from './types.js';

export interface TokenUsage {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PreparedInputInvocationRequest {
  settings: EffectiveCallSettings;
  /** Null when the provider has no system prompt; the body then carries everything. */
  systemPrompt: string | null;
  outputSchema: JsonSchema | null;
  /** A schema file staged inside the runner-owned working directory. */
  outputSchemaFile: string | null;
  baseEnv: NodeJS.ProcessEnv;
}

export interface PreparedInputInvocation {
  /** Arguments after the binary. The request body is never among them. */
  args: string[];
  env: Record<string, string | undefined>;
}

export interface PreparedInputPreflight {
  invocation: PreparedInputInvocation;
  /** A diagnostic when the binary cannot safely serve this adapter version. */
  validate(stdout: string): string | null;
}

/** What a provider's output says happened. Anything it did not report is null, never zero. */
export interface ProviderOutcome {
  /** How many results the provider reported. Only exactly one can be an answer. */
  resultCount: number;
  body: string;
  reportedModel: string | null;
  usage: TokenUsage | null;
  costUsd: number | null;
  failure: { kind: 'budget_exceeded' | 'provider_error'; message: string } | null;
  /** Each sign that the model used, or tried to use, a tool. Any entry fails the call. */
  toolUse: string[];
  /** Each tool or tool server the provider said the model was offered. Any entry fails the call. */
  toolsAvailable: string[];
  /** False when the provider never stated what the model was offered, so its absence is unproven. */
  toolOfferStated: boolean;
  /** Why generation stopped, when that reason means the answer is not whole. */
  cutOffReason: string | null;
  /** A schema was requested and the provider returned no structured answer. */
  structuredAnswerMissing: boolean;
}

/** How one provider is invoked under an effective tool-access policy and how its output is read. */
export interface PreparedInputAdapter {
  /** A bounded, non-model check performed before the provider invocation. */
  preflight?(request: PreparedInputInvocationRequest): PreparedInputPreflight;
  invocation(request: PreparedInputInvocationRequest): PreparedInputInvocation;
  /**
   * The most the provider may write before the call is stopped, given the cap
   * on the answer itself. Larger than that cap only by the provider's own
   * framing of the answer.
   */
  maxStreamBytes(maxOutputBytes: number): number;
  interpret(stdout: string, request: { outputSchema: JsonSchema | null }): ProviderOutcome;
}
