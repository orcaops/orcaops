import { captureWorktreeTreeSha } from '@orcaops/core';
import type { EvaluatorContext, ResolvedEvaluator } from '@orcaops/evaluator-protocol';
import { canonicalJson, combineEvaluatorFingerprints, sha256 } from '@orcaops/evaluator-runner';

import type { CliContext } from './context.js';

export interface PrePrReviewFingerprints {
  evaluator_set_fingerprint: string;
  review_context_fingerprint: string;
}

export function requiresRepositoryFingerprint(evaluators: readonly ResolvedEvaluator[]): boolean {
  return evaluators.some(
    (evaluator) => evaluator.engine.kind !== 'llm' || evaluator.engine.tool_policy !== undefined
  );
}

export async function computePrePrReviewFingerprints(opts: {
  ctx: Pick<CliContext, 'repo'>;
  evaluators: readonly ResolvedEvaluator[];
  context: EvaluatorContext;
}): Promise<PrePrReviewFingerprints> {
  const evaluatorSetFingerprint = await combineEvaluatorFingerprints(opts.evaluators);
  const {
    run_id: _runId,
    evaluator_ref: _evaluatorRef,
    params: _params,
    ...capturedContext
  } = opts.context;
  const input: Record<string, unknown> = {
    schema: 'orcaops.pre_pr_review_context/v1',
    evaluator_set_fingerprint: evaluatorSetFingerprint,
    captured_context: capturedContext,
    scope: 'captured-context',
  };

  if (requiresRepositoryFingerprint(opts.evaluators)) {
    const [headSha, indexTreeSha, worktree] = await Promise.all([
      opts.ctx.repo.getHeadSha(),
      opts.ctx.repo.getIndexTreeSha(),
      captureWorktreeTreeSha(opts.ctx.repo),
    ]);
    if (!worktree.ok) {
      throw new Error(
        `Cannot fingerprint the pre-PR worktree (${worktree.error_reason})` +
          (worktree.error_message ? `: ${worktree.error_message}` : '.')
      );
    }
    input.scope = 'repository';
    input.repository = {
      head_sha: headSha,
      index_tree_sha: indexTreeSha,
      worktree_tree_sha: worktree.tree_sha,
    };
  }

  return {
    evaluator_set_fingerprint: evaluatorSetFingerprint,
    review_context_fingerprint: sha256(canonicalJson(input)),
  };
}
