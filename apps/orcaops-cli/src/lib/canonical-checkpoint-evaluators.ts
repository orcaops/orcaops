import { run } from 'effection';

import {
  type EvaluatorRunPayload,
  type GateAuditDisposition,
  type GateAuditPayload,
  isBlockingEligibleViolation,
  isBlockingEvaluatorFailure,
} from '@orcaops/evaluator-protocol';
import {
  combineEvaluatorFingerprints,
  createParamsValidator,
  discoverEvaluators,
  dispatchEvaluators,
} from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import {
  type OpenEvaluatorContext,
  type PolicyException,
  PolicyExceptionInvalidError,
  uuidv7,
} from '@orcaops/storage';

import { toGateAuditRun } from './canonical-checkpoint-shapes.js';
import { buildEvaluatorContext, type LifecycleEvaluatorContext } from './evaluator-bridge.js';
import { computePackTrustDecisions } from './evaluator-grants.js';
import { CLI_ROOT } from './evaluators-config.js';
import type { OpenRejectionEnvelope } from '../io/errors.js';
import { writeTerminalSafeStderr } from '../io/output.js';

export async function prepareCheckpointOpenEvaluators(input: {
  ctx: LifecycleEvaluatorContext;
  artifactId: string;
  declaredStepIds: string[];
  policyExceptions: PolicyException[];
  noLlm?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<OpenEvaluatorContext> {
  const { ctx, artifactId, declaredStepIds, noLlm, env } = input;
  const policy_exceptions = structuredClone(input.policyExceptions);
  const exceptionRefs = new Set(policy_exceptions.map((p) => p.evaluator));
  const { config: evalConfig, evaluators: discovered } = await discoverEvaluators(ctx.repoRoot, {
    cliRoot: CLI_ROOT,
  });
  const maxConcurrent = evalConfig?.runtime.max_concurrent ?? 4;
  const cpOpenEvaluators = discovered.filter((e) => e.enabled && e.phase === 'checkpoint-open');
  const cpOpenPackageIds = new Set(cpOpenEvaluators.map((e) => e.package_id));
  const cpOpenTrust = await computePackTrustDecisions({
    packs: (evalConfig?.packages ?? [])
      .filter((entry) => cpOpenPackageIds.has(entry.id))
      .map((entry) => ({
        packageId: entry.id,
        source: entry.source,
      })),
    repoRoot: ctx.repoRoot,
    cliRoot: CLI_ROOT,
    warn: (msg) => writeTerminalSafeStderr(`${msg}\n`),
  });
  const fingerprint = await combineEvaluatorFingerprints(cpOpenEvaluators);

  return {
    fingerprint,
    validatePolicyExceptions: () => {
      if (policy_exceptions.length === 0) return;
      for (const ex of policy_exceptions) {
        const ev = cpOpenEvaluators.find((e) => e.ref === ex.evaluator);
        if (!ev) {
          const existsElsewhere = discovered.some((e) => e.ref === ex.evaluator);
          throw new PolicyExceptionInvalidError(
            artifactId,
            existsElsewhere
              ? `policy_exceptions[] names "${ex.evaluator}", which is not a ` +
                  `\`fires_at: checkpoint-open\` evaluator. Inline policy exceptions ` +
                  `only apply to pre-append blocks; use \`orcaops block dismiss\` ` +
                  `for post-write resolution instead.`
              : `policy_exceptions[] names unknown evaluator "${ex.evaluator}".`,
            ex.evaluator
          );
        }
        if (!ev.resolution.policy_exception.enabled) {
          throw new PolicyExceptionInvalidError(
            artifactId,
            `evaluator "${ex.evaluator}" does not opt into policy exceptions ` +
              `(\`resolution.policy_exception.enabled\` is false on its spec). ` +
              `Use \`orcaops block dismiss\` after-the-fact instead, or rewrite ` +
              `the open with smaller scope.`,
            ex.evaluator
          );
        }
      }
    },
    preAppend: async (proposedOpen) => {
      if (cpOpenEvaluators.length === 0) {
        return { ok: true };
      }

      const baseContext = await buildEvaluatorContext({
        ctx,
        artifactId: artifactId,
        firesAt: 'checkpoint-open',
        checkpointN: proposedOpen.n,
        proposedOpenCheckpoint: proposedOpen,
      });
      const llm = await run(function* () {
        return yield* buildLLMClient(ctx.config.llm, {
          ...(noLlm !== undefined ? { noLlm: noLlm } : {}),
          env: env,
        });
      });
      const validator = createParamsValidator();
      const { runs } = await dispatchEvaluators({
        evaluators: cpOpenEvaluators,
        context: baseContext,
        llm,
        trust: cpOpenTrust,
        maxConcurrent,
        runIdFactory: uuidv7,
        validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
      });
      const stampedRuns: EvaluatorRunPayload[] = runs.map((r) => ({
        ...r,
        checkpoint_n: proposedOpen.n,
      }));
      const ts = new Date().toISOString();
      const dispositions: GateAuditDisposition[] = [];
      for (const r of stampedRuns) {
        if (!isBlockingEligibleViolation(r)) continue;
        if (!exceptionRefs.has(r.evaluator_ref)) continue;
        const ex = policy_exceptions.find((p) => p.evaluator === r.evaluator_ref);
        if (!ex) continue;
        dispositions.push({
          disposition_id: uuidv7(),
          run_id: r.run_id,
          evaluator_ref: r.evaluator_ref,
          disposition: 'policy-excepted',
          reason: ex.reason,
          ts,
        });
      }

      const policyExceptedRunIds = new Set(dispositions.map((d) => d.run_id));
      const unresolvedBlocks = stampedRuns.filter(
        (r) => isBlockingEvaluatorFailure(r) && !policyExceptedRunIds.has(r.run_id)
      );

      const gate_audit: GateAuditPayload = {
        runs: stampedRuns.map(toGateAuditRun),
        dispositions,
      };

      if (unresolvedBlocks.length > 0) {
        return {
          ok: false,
          envelope: {
            ok: false as const,
            status: 'blocked',
            artifact_id: artifactId,
            declared_step_ids: declaredStepIds,
            blocked_evaluator_refs: unresolvedBlocks.map((b) => b.evaluator_ref),
            evaluator_results: stampedRuns,
            gate_audit,
            blocking: true,
            message:
              `Open rejected by ${unresolvedBlocks.length} blocking evaluator outcome(s): ` +
              `${unresolvedBlocks.map((b) => b.evaluator_ref).join(', ')}. ` +
              `Fix evaluator errors and retry. Completed policy violations may instead ` +
              `be retried with smaller scope or \`policy_exceptions[]\` entries.`,
          } satisfies OpenRejectionEnvelope,
        };
      }
      return { ok: true, gate_audit };
    },
  };
}
