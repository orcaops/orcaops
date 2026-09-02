import { access, readFile } from 'node:fs/promises';

import {
  artifactPathsFor,
  type ArtifactStore,
  blockingEvaluatorFailureKind,
} from '@orcaops/storage';

import { computeCoverage } from './coverage.js';
import type { BlockPhase, LifecycleSnapshot, UnresolvedBlock } from './next-actions.js';
import { buildDigestUsage, usageFingerprint } from '../digest/builder.js';

/** Minimal repo capability the snapshot needs (structural — CliContext.repo satisfies it). */
export interface HeadShaSource {
  getHeadSha(): Promise<string>;
}

/** Structural view of storage's EvaluatorRunRow — the fields the block filter reads. */
interface EvaluatorRunLike {
  evaluator_ref: string;
  run_id: string;
  phase: string;
  severity: string;
  run_status: string;
  verdict: string | null;
  disposition: string | null;
  checkpoint_n?: number | null;
}

export interface DeriveLifecycleSnapshotOptions {
  /** Pre-fetched HEAD sha — `status` fetches once and reuses across artifacts. */
  currentHeadSha?: string;
  /**
   * ref → whether the evaluator opts into `acknowledge` resolution. Supplied
   * by the caller after evaluator discovery; absent ⇒ `acknowledge_enabled`
   * defaults to false (dismiss-only). See `appendNextActions` for the lazy
   * enrichment that fills this only when blocks exist.
   */
  acknowledgeByRef?: (ref: string) => boolean;
}

/**
 * Derive the currently-open lifecycle blockers from evaluator-run rows,
 * mirroring storage's ordered supersession (`computeOpenBlocksByRef` in
 * rebuilders.ts): for each `evaluator_ref`, only the latest decisive
 * block-severity run decides state. A later pass/info run clears the block,
 * a newer violation or error supersedes the older one, and a disposition on
 * the latest violation (reflected in its materialized `disposition` column)
 * clears it. Errors can only be cleared by a later successful run.
 *
 * `listEvaluatorRuns` returns rows in ascending (source_event_index,
 * local_kind_rank, local_index) order, so the last decisive block run seen
 * per ref is the current one. Filtering raw rows on `disposition ===
 * 'unresolved'` independently would resurface a stale
 * violation that a later passing `run-evaluators` already cleared — keeping
 * status/resume stuck on ack/dismiss after the artifact is no longer blocked.
 *
 * `checkpoint-open` rows are excluded — open-phase blocks are pre-append soft
 * rejections with no persisted run to ack/dismiss (defensive; they don't
 * reach this projection).
 */
export function computeUnresolvedBlocks(
  runRows: readonly EvaluatorRunLike[],
  acknowledgeByRef?: (ref: string) => boolean
): UnresolvedBlock[] {
  // Last decisive block-severity run wins per ref (rows are ascending).
  // Errors set a non-dispositionable blocker; completed pass/info clears;
  // skipped runs leave the current state unchanged.
  const latestByRef = new Map<string, EvaluatorRunLike>();
  for (const r of runRows) {
    if (r.severity === 'block' && (r.run_status === 'completed' || r.run_status === 'error')) {
      latestByRef.set(r.evaluator_ref, r);
    }
  }

  const blocks: UnresolvedBlock[] = [];
  for (const r of latestByRef.values()) {
    if (r.phase === 'checkpoint-open') continue;
    const kind = blockingEvaluatorFailureKind(r);
    if (kind === 'error' || (kind === 'violation' && r.disposition === 'unresolved')) {
      blocks.push({
        kind,
        evaluator_ref: r.evaluator_ref,
        run_id: r.run_id,
        phase: r.phase as BlockPhase,
        ...(r.checkpoint_n == null ? {} : { checkpoint_n: r.checkpoint_n }),
        acknowledge_enabled:
          kind === 'violation' && acknowledgeByRef ? acknowledgeByRef(r.evaluator_ref) : false,
      });
    }
  }
  return blocks;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Digest presence + the source_event_id it was built from. "present" keys
 * on `digest.md` existence; the id comes from the `digest.meta.json`
 * sidecar (null when absent/corrupt → treated as stale, re-suggesting a
 * regenerate). No mtimes.
 */
async function readDigestState(
  store: ArtifactStore,
  artifactId: string
): Promise<{ present: boolean; source_event_id: string | null; usage_fingerprint: string | null }> {
  const paths = artifactPathsFor(store.repoRoot, store.config, artifactId);
  if (!(await fileExists(paths.digestMd)))
    return { present: false, source_event_id: null, usage_fingerprint: null };
  try {
    const parsed = JSON.parse(await readFile(paths.digestMeta, 'utf8')) as {
      source_event_id?: unknown;
      usage_fingerprint?: unknown;
    };
    return {
      present: true,
      source_event_id: typeof parsed.source_event_id === 'string' ? parsed.source_event_id : null,
      usage_fingerprint:
        typeof parsed.usage_fingerprint === 'string' ? parsed.usage_fingerprint : null,
    };
  } catch {
    return { present: true, source_event_id: null, usage_fingerprint: null };
  }
}

/**
 * Derive the lifecycle snapshot `nextActions` reasons over. Reuses the
 * store's projection reads (readArtifact/readPlan/readCheckpoints) +
 * listEvaluatorRuns + the shared computeCoverage. Returns null when the
 * artifact has no projection (no plan_captured event).
 */
export async function deriveLifecycleSnapshot(
  store: ArtifactStore,
  repo: HeadShaSource,
  artifactId: string,
  opts: DeriveLifecycleSnapshotOptions = {}
): Promise<LifecycleSnapshot | null> {
  const artifact = await store.readArtifact(artifactId);
  if (!artifact) return null;

  const plan = await store.readPlan(artifactId);
  const checkpoints = await store.readCheckpoints(artifactId);

  const closed = checkpoints.filter(
    (c): c is typeof c & { status: 'closed' } => c.status === 'closed'
  );
  const opens = checkpoints.filter((c): c is typeof c & { status: 'open' } => c.status === 'open');
  const planStepIds = plan ? plan.plan_steps.map((s) => s.step_id) : [];

  const { uncovered_step_ids, plan_coverage_complete } = computeCoverage({
    planStepIds,
    closedCheckpoints: closed,
    openCheckpoints: opens,
  });

  const current_head_sha = opts.currentHeadSha ?? (await repo.getHeadSha());
  const digest = await readDigestState(store, artifactId);
  // Live usage fingerprint — compared to the cached one (isDigestCurrent) so a
  // usage-only change marks the cached digest stale. The digest reads usage live.
  const live_usage_fingerprint = usageFingerprint(buildDigestUsage(store.store, artifactId));

  return {
    artifact_id: artifactId,
    state: artifact.state,
    current_head_sha,
    artifact_source_event_id: artifact.source_event_id ?? null,
    pre_pr_checked_head_sha: artifact.pre_pr_checked_head_sha ?? null,
    pre_pr_checked_source_event_id: artifact.pre_pr_checked_source_event_id ?? null,
    digest_present: digest.present,
    digest_source_event_id: digest.source_event_id,
    digest_usage_fingerprint: digest.usage_fingerprint,
    live_usage_fingerprint,
    open_checkpoints: opens.map((cp) => ({
      n: cp.n,
      declared_step_ids: [...cp.declared_step_ids],
    })),
    uncovered_step_ids,
    // Empty plan ⇒ not "complete" (computeCoverage returns true for empty).
    plan_coverage_complete: planStepIds.length > 0 && plan_coverage_complete,
    unresolved_blocks: computeUnresolvedBlocks(
      store.store.listEvaluatorRuns(artifactId),
      opts.acknowledgeByRef
    ),
    // First-cp signal for the open-hint wording: no checkpoint of any status
    // (open/closed/abandoned) exists yet ⇒ the next open is the first.
    no_checkpoints_yet: checkpoints.length === 0,
  };
}
