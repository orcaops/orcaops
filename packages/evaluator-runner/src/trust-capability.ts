/**
 * The single capability-classification policy, in its own module so every
 * consumer shares it without an import cycle: dispatch (which refuses),
 * pack validation (which decides what to warn about, prompt for, grant, and
 * put in the installation manifest), and doctor (which reports). Parallel
 * copies of this rule previously let dispatch gate a class validation never
 * emitted — making consent ungrantable.
 */

/**
 * Capability classes the consent gate protects. These are exactly the
 * pack-validation security warning codes: a grant records which classes the
 * user accepted, and an evaluator requiring a class its pack's decision does
 * not carry is refused.
 */
export type TrustCapability =
  | 'command_evaluators_present'
  | 'llm_evaluators_present'
  | 'file_reading_llm_evaluator_present';

export function isTrustCapability(value: string): value is TrustCapability {
  return (
    value === 'command_evaluators_present' ||
    value === 'llm_evaluators_present' ||
    value === 'file_reading_llm_evaluator_present'
  );
}

/**
 * The engine shape the classifier needs. Deliberately structural, not
 * `ResolvedEvaluator`: `validatePack` classifies raw SPECS (pre-resolve) and
 * must reach the identical verdict.
 */
export interface ClassifiableEngine {
  kind: 'command' | 'llm';
  provider?: 'claude' | 'codex' | undefined;
  tool_policy?: { mode: 'none' | 'command-filtered' } | undefined;
  selection_sources?: { provider?: 'user-override' | 'pack-spec' | 'global' } | undefined;
}

export const PROVIDER_CAPABILITY_FLOORS: Readonly<
  Record<'claude' | 'codex', readonly TrustCapability[]>
> = {
  claude: [],
  codex: ['file_reading_llm_evaluator_present'],
};

/**
 * The complete capability set an evaluator's engine requires.
 *
 * `defaultLlmProvider` is the tool an evaluator reaches when it declares no
 * `provider` (from `LLMClient.defaultProvider`). It matters because codex
 * exposes file-reading tools: an evaluator declaring NEITHER a provider nor a
 * tool_policy still reads the worktree whenever the resolved
 * default is codex, and repository config (`llm.tool`) selects that default —
 * so the gate must follow the effective provider, not just the declared one.
 */
export function requiredTrustCapabilities(
  engine: ClassifiableEngine,
  defaultLlmProvider?: 'claude' | 'codex' | null
): readonly TrustCapability[] {
  if (engine.kind === 'command') return ['command_evaluators_present'];
  if (engine.kind === 'llm') {
    const required = new Set<TrustCapability>(['llm_evaluators_present']);
    const effectiveProvider = engine.provider ?? defaultLlmProvider ?? null;
    const providerFloor =
      effectiveProvider === null ? [] : PROVIDER_CAPABILITY_FLOORS[effectiveProvider];
    for (const capability of providerFloor) {
      required.add(capability);
    }
    if (engine.tool_policy?.mode === 'command-filtered') {
      required.add('file_reading_llm_evaluator_present');
    }
    return [...required];
  }
  return [];
}

export function requiredTrustCapabilitiesForEngines(
  engines: readonly ClassifiableEngine[],
  defaultLlmProvider?: 'claude' | 'codex' | null
): readonly TrustCapability[] {
  const capabilities = new Set<TrustCapability>();
  for (const engine of engines) {
    for (const capability of requiredTrustCapabilities(engine, defaultLlmProvider)) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}

/**
 * Per-package trust decision, computed by the CALLER (the CLI verifies
 * user-local grants / the installation manifest — see
 * docs/evaluator-consent.md). The runner never reads grant files itself.
 */
export type PackTrustDecision =
  | { verdict: 'trusted'; capabilities: readonly TrustCapability[] }
  | { verdict: 'refused'; reason: string };

export type ConsentGateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * The COMPLETE consent gate for one evaluator: capability classification
 * plus decision-coverage check. Dispatch enforces it; doctor reports from
 * it. Anything less than the full check at a reporting surface disagrees
 * with enforcement — a verdict-only read passes a capability-short grant
 * that dispatch refuses.
 */
export function evaluateConsentGate(
  engine: ClassifiableEngine,
  packageId: string,
  decision: PackTrustDecision | undefined,
  defaultLlmProvider?: 'claude' | 'codex' | null
): ConsentGateResult {
  const required = requiredTrustCapabilities(engine, defaultLlmProvider);
  if (required.length === 0) return { allowed: true };
  if (decision === undefined || decision.verdict === 'refused') {
    return {
      allowed: false,
      reason:
        decision?.verdict === 'refused'
          ? decision.reason
          : `Pack "${packageId}" has no trust decision; run \`orcaops eval trust ${packageId}\` to inspect and grant.`,
    };
  }
  const missing = required.filter((capability) => !decision.capabilities.includes(capability));
  if (missing.length > 0) {
    if (engine.selection_sources?.provider === 'user-override') {
      return {
        allowed: false,
        reason:
          `Your .orcaops/evaluators.yaml provider override makes pack "${packageId}" require ` +
          `${missing.map((capability) => `"${capability}"`).join(', ')}; repository config ` +
          `cannot authorize that capability. Run \`orcaops eval trust ${packageId}\` to ` +
          `inspect and grant it in your user-local trust store.`,
      };
    }
    return {
      allowed: false,
      reason:
        `Pack "${packageId}" is granted without the ${missing
          .map((capability) => `"${capability}"`)
          .join(', ')} capability${missing.length === 1 ? '' : ' classes'} ` +
        `this evaluator requires; run \`orcaops eval trust ${packageId}\` to re-inspect and re-grant.`,
    };
  }
  return { allowed: true };
}
