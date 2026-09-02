import type {
  EvaluatorConfig,
  EvaluatorPhase,
  EvaluatorRunPayload,
  ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import { scrubEvaluatorDiagnosticAndBound } from '@orcaops/evaluator-protocol/secrets';
import type { EvaluatorDiscoveryError } from '@orcaops/evaluator-runner';

export const LIFECYCLE_INVENTORY_EVALUATOR_REF = 'orcaops/lifecycle-evaluator-inventory';
const MAX_PERSISTED_ERROR_MESSAGE_CHARS = 4096;

interface InventoryOptions {
  artifactId: string;
  phase: EvaluatorPhase;
  checkpointN?: number;
  config: EvaluatorConfig | null;
  discovered: readonly ResolvedEvaluator[];
  eligible: readonly ResolvedEvaluator[];
  dispatchedRuns: readonly EvaluatorRunPayload[];
  discoveryErrors: readonly EvaluatorDiscoveryError[];
  runIdFactory: () => string;
  now: string;
}

interface InventoryResult {
  runs: EvaluatorRunPayload[];
  complete: boolean;
}

function refParts(ref: string): { packageId: string; evaluatorId: string } {
  const slash = ref.indexOf('/');
  return slash === -1
    ? { packageId: 'orcaops', evaluatorId: ref }
    : { packageId: ref.slice(0, slash), evaluatorId: ref.slice(slash + 1) };
}

function errorRun(input: {
  artifactId: string;
  evaluatorRef: string;
  phase: EvaluatorPhase;
  checkpointN?: number;
  severity: 'info' | 'warn' | 'block';
  code: string;
  message: string;
  runId: string;
  now: string;
}): EvaluatorRunPayload {
  const { packageId, evaluatorId } = refParts(input.evaluatorRef);
  const message = scrubEvaluatorDiagnosticAndBound(
    input.message,
    MAX_PERSISTED_ERROR_MESSAGE_CHARS
  );
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: input.runId,
    artifact_id: input.artifactId,
    evaluator_ref: input.evaluatorRef,
    package_id: packageId,
    evaluator_id: evaluatorId,
    phase: input.phase,
    severity: input.severity,
    run_status: 'error',
    verdict: null,
    body: `ERROR (${input.code})\n\n${message}`,
    error: { code: input.code, message },
    ...(input.checkpointN === undefined ? {} : { checkpoint_n: input.checkpointN }),
    ts: input.now,
  };
}

/**
 * Reconcile the configured evaluator inventory with discovery and dispatch.
 *
 * Dispatch is deliberately not trusted to define its own completeness: every
 * enabled configured ref must resolve, and every evaluator eligible for this
 * phase must produce exactly one run row. Missing refs receive typed error
 * rows, while the bridge-owned inventory evaluator records the blocking
 * pass/violation that makes absence itself visible to lifecycle gates.
 */
export function reconcileLifecycleEvaluatorInventory(input: InventoryOptions): InventoryResult {
  if (input.config === null) return { runs: [...input.dispatchedRuns], complete: true };

  const configuredEnabledRefs = Object.entries(input.config.evaluators)
    .filter(([, override]) => override.enabled)
    .map(([ref]) => ref)
    .sort();
  const discoveredRefs = new Set(input.discovered.map((evaluator) => evaluator.ref));
  const missingConfiguredRefs = configuredEnabledRefs.filter((ref) => !discoveredRefs.has(ref));

  const dispatchedByRef = new Map<string, EvaluatorRunPayload[]>();
  for (const run of input.dispatchedRuns) {
    const rows = dispatchedByRef.get(run.evaluator_ref) ?? [];
    rows.push(run);
    dispatchedByRef.set(run.evaluator_ref, rows);
  }

  const eligibleByRef = new Map(input.eligible.map((evaluator) => [evaluator.ref, evaluator]));
  const missingDispatchRefs = [...eligibleByRef]
    .filter(([ref]) => (dispatchedByRef.get(ref)?.length ?? 0) === 0)
    .map(([ref]) => ref)
    .sort();
  const duplicateDispatchRefs = [...dispatchedByRef]
    .filter(([, rows]) => rows.length > 1)
    .map(([ref]) => ref)
    .sort();
  const unexpectedDispatchRefs = [...dispatchedByRef]
    .filter(([ref]) => !eligibleByRef.has(ref))
    .map(([ref]) => ref)
    .sort();

  const problems: string[] = [];
  const blockingProblems = new Set<string>();
  const supplementalRuns: EvaluatorRunPayload[] = [];

  const addProblem = (message: string, blocking: boolean): void => {
    problems.push(message);
    if (blocking) blockingProblems.add(message);
  };

  for (const ref of missingConfiguredRefs) {
    const message =
      `enabled configured evaluator ${ref} is absent from the executing evaluator pack; ` +
      'the executable or bundled pack is stale or incompatible with .orcaops/evaluators.yaml';
    addProblem(message, true);
    supplementalRuns.push(
      errorRun({
        artifactId: input.artifactId,
        evaluatorRef: ref,
        phase: input.phase,
        checkpointN: input.checkpointN,
        severity: 'block',
        code: 'EVALUATOR_REF_UNRESOLVED',
        message,
        runId: input.runIdFactory(),
        now: input.now,
      })
    );
  }

  for (const ref of missingDispatchRefs) {
    const evaluator = eligibleByRef.get(ref)!;
    const message = `eligible evaluator ${ref} produced no persisted run outcome for ${input.phase}`;
    addProblem(message, evaluator.severity === 'block');
    supplementalRuns.push(
      errorRun({
        artifactId: input.artifactId,
        evaluatorRef: ref,
        phase: input.phase,
        checkpointN: input.checkpointN,
        severity: evaluator.severity,
        code: 'EVALUATOR_RUN_MISSING',
        message,
        runId: input.runIdFactory(),
        now: input.now,
      })
    );
  }

  for (const ref of duplicateDispatchRefs) {
    const message = `eligible evaluator ${ref} produced more than one run outcome for ${input.phase}`;
    addProblem(message, eligibleByRef.get(ref)?.severity === 'block');
  }
  for (const ref of unexpectedDispatchRefs) {
    addProblem(`unexpected evaluator ${ref} produced a run outcome for ${input.phase}`, true);
  }
  for (const [ref, evaluator] of eligibleByRef) {
    for (const run of dispatchedByRef.get(ref) ?? []) {
      if (run.run_status !== 'error') continue;
      const code = run.error?.code ?? 'UNKNOWN';
      addProblem(
        `eligible evaluator ${ref} failed with ${code} during ${input.phase}`,
        evaluator.severity === 'block'
      );
    }
  }
  for (const error of input.discoveryErrors) {
    const message = `evaluator discovery failed at ${error.source_path}: ${error.message}`;
    addProblem(message, true);
    supplementalRuns.push(
      errorRun({
        artifactId: input.artifactId,
        evaluatorRef: 'orcaops/evaluator-discovery',
        phase: input.phase,
        checkpointN: input.checkpointN,
        severity: 'block',
        code: error.code ?? 'EVALUATOR_DISCOVERY_FAILED',
        message,
        runId: input.runIdFactory(),
        now: input.now,
      })
    );
  }
  const safeProblems = problems.map((problem) =>
    scrubEvaluatorDiagnosticAndBound(problem, MAX_PERSISTED_ERROR_MESSAGE_CHARS)
  );
  const hasBlockingProblems = blockingProblems.size > 0;
  const inventoryVerdict =
    safeProblems.length === 0 ? 'pass' : hasBlockingProblems ? 'violation' : 'info';
  const inventoryBody =
    safeProblems.length === 0
      ? `PASS\n\nAll ${configuredEnabledRefs.length} enabled configured evaluator(s) resolved and all ${input.eligible.length} evaluator(s) eligible for ${input.phase} produced exactly one terminal run outcome.`
      : `${hasBlockingProblems ? 'VIOLATION' : 'INFO'}\n\nLifecycle evaluator inventory is incomplete:\n${safeProblems.map((problem) => `- ${problem}`).join('\n')}`;

  const inventoryRun: EvaluatorRunPayload = {
    schema: 'orcaops.evaluator_run/v1',
    run_id: input.runIdFactory(),
    artifact_id: input.artifactId,
    evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
    package_id: 'orcaops',
    evaluator_id: 'lifecycle-evaluator-inventory',
    phase: input.phase,
    severity: 'block',
    run_status: 'completed',
    verdict: inventoryVerdict,
    body: inventoryBody,
    raw: {
      configuredEnabledRefs,
      discoveredRefs: [...discoveredRefs].sort(),
      eligibleRefs: [...eligibleByRef.keys()].sort(),
      representedRefs: [...dispatchedByRef.keys()].sort(),
      problems: safeProblems,
    },
    ...(input.checkpointN === undefined ? {} : { checkpoint_n: input.checkpointN }),
    ts: input.now,
  };

  return {
    runs: [...input.dispatchedRuns, ...supplementalRuns, inventoryRun],
    complete: safeProblems.length === 0,
  };
}
