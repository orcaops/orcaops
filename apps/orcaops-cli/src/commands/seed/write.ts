import {
  buildDiffFingerprintManifest,
  EMPTY_TREE_SHA,
  type Repo,
  SNAPSHOT_REF_PREFIX,
} from '@orcaops/core';
import {
  type ArtifactStore,
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  type CheckpointSnapshotBoundary,
  type Config,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
  redactSecretsInObject,
} from '@orcaops/storage';

import type { SeedClusterSynthesis } from './synthesize.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';

export interface SeedWriteContext {
  repo: Repo;
  store: ArtifactStore;
  config: Config;
}

export interface SeedWriteResult {
  artifactId: string;
  outcome: 'created' | 'resumed' | 'complete';
  checkpoints: number;
}

export interface PreparedSeedCheckpoint {
  openBoundary: CheckpointSnapshotBoundary;
  closeBoundary: CheckpointSnapshotBoundary;
  fingerprintSummary: DiffFingerprintSummary;
  fingerprintManifest: DiffFingerprintManifest | null;
}

function checkpointKey(artifactId: string, n: number): string {
  return `${artifactId}:${n}`;
}

function skippedCheckpoint(): PreparedSeedCheckpoint {
  return {
    openBoundary: buildDefaultSkippedSnapshotBoundary(),
    closeBoundary: buildDefaultSkippedSnapshotBoundary(),
    fingerprintSummary: buildDefaultSkippedFingerprintSummary(),
    fingerprintManifest: null,
  };
}

function snapshotRef(artifactId: string, n: number, phase: 'open' | 'close'): string {
  return `${SNAPSHOT_REF_PREFIX}/${artifactId}/${n}/${phase}`;
}

export async function prepareSeedSnapshots(
  repo: Repo,
  syntheses: readonly SeedClusterSynthesis[],
  opts: { fingerprints: boolean; maxDiffBytes: number }
): Promise<ReadonlyMap<string, PreparedSeedCheckpoint>> {
  const prepared = new Map<string, PreparedSeedCheckpoint>();
  const pinnable = syntheses.flatMap((synthesis) =>
    synthesis.checkpoints
      .filter((checkpoint) => checkpoint.group.parentSha !== EMPTY_TREE_SHA)
      .map((checkpoint) => ({ synthesis, checkpoint }))
  );
  for (const synthesis of syntheses) {
    for (const checkpoint of synthesis.checkpoints) {
      prepared.set(checkpointKey(synthesis.artifactId, checkpoint.n), skippedCheckpoint());
    }
  }
  if (!opts.fingerprints || pinnable.length === 0) return prepared;

  try {
    await repo.updateRefsBatch(
      pinnable.flatMap(({ synthesis, checkpoint }) => [
        {
          ref: snapshotRef(synthesis.artifactId, checkpoint.n, 'open'),
          sha: checkpoint.group.parentSha,
        },
        {
          ref: snapshotRef(synthesis.artifactId, checkpoint.n, 'close'),
          sha: checkpoint.group.headSha,
        },
      ])
    );
  } catch {
    return prepared;
  }

  let trees: Map<string, string>;
  let diffs: Awaited<ReturnType<Repo['diffCommitPairs']>>;
  try {
    trees = await repo.resolveTreesBatch(
      pinnable.flatMap(({ checkpoint }) => [checkpoint.group.parentSha, checkpoint.group.headSha])
    );
    diffs = await repo.diffCommitPairs(
      pinnable.map(({ checkpoint }) => ({
        parentSha: checkpoint.group.parentSha,
        headSha: checkpoint.group.headSha,
      })),
      opts.maxDiffBytes
    );
  } catch {
    return prepared;
  }

  for (const { synthesis, checkpoint } of pinnable) {
    const openTreeSha = trees.get(checkpoint.group.parentSha);
    const closeTreeSha = trees.get(checkpoint.group.headSha);
    const diff = diffs.get(checkpoint.group.headSha);
    if (!openTreeSha || !closeTreeSha || !diff) continue;
    try {
      const built = await buildDiffFingerprintManifest({
        artifactId: synthesis.artifactId,
        checkpointN: checkpoint.n,
        openTreeSha,
        closeTreeSha,
        diffBytes: diff.diff,
        truncated: diff.truncated,
        maxDiffBytes: opts.maxDiffBytes,
      });
      prepared.set(checkpointKey(synthesis.artifactId, checkpoint.n), {
        openBoundary: {
          snapshot_ref: snapshotRef(synthesis.artifactId, checkpoint.n, 'open'),
          tree_sha: openTreeSha,
          snapshot_commit_sha: checkpoint.group.parentSha,
          snapshot_error_reason: null,
        },
        closeBoundary: {
          snapshot_ref: snapshotRef(synthesis.artifactId, checkpoint.n, 'close'),
          tree_sha: closeTreeSha,
          snapshot_commit_sha: checkpoint.group.headSha,
          snapshot_error_reason: null,
        },
        fingerprintSummary: built.summary,
        fingerprintManifest: built.manifest,
      });
    } catch {
      prepared.set(checkpointKey(synthesis.artifactId, checkpoint.n), skippedCheckpoint());
    }
  }
  return prepared;
}

export async function writeSeedCluster(
  ctx: SeedWriteContext,
  synthesis: SeedClusterSynthesis,
  opts: { prepared: ReadonlyMap<string, PreparedSeedCheckpoint> }
): Promise<SeedWriteResult> {
  return ctx.store.withArtifactEventBatch(synthesis.artifactId, () =>
    writeSeedClusterBatched(ctx, redactSeedNarrative(synthesis), opts)
  );
}

/**
 * Redact secret-shaped runs out of synthesized narrative before it is written.
 *
 * Seed is the one write path that scrubs rather than refuses, and the split is
 * not arbitrary: refusal exists so an author can reword. Here the text is
 * machine-synthesized from commits that already exist, so there is nothing to
 * reword — refusing would block the whole backfill on input nobody can fix.
 * The same reasoning already governs evaluator output, which the runner scrubs
 * at write for exactly this reason.
 *
 * Safe against replay because seed's idempotency keys derive from git identity
 * (`seedKey(opts, 'plan')`, `checkpoint:<group>:open`), never from content, so
 * a re-run re-derives the same commits, redacts them identically, and dedups.
 * Scrubbing content that keyed its own idempotency would turn every re-seed
 * into a conflict.
 */
function redactSeedNarrative(synthesis: SeedClusterSynthesis): SeedClusterSynthesis {
  return {
    ...synthesis,
    plan: redactSecretsInObject(synthesis.plan),
    checkpoints: synthesis.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      summary: redactSecretsInObject(checkpoint.summary),
    })),
    summary: redactSecretsInObject(synthesis.summary),
  };
}

async function writeSeedClusterBatched(
  ctx: SeedWriteContext,
  synthesis: SeedClusterSynthesis,
  opts: { prepared: ReadonlyMap<string, PreparedSeedCheckpoint> }
): Promise<SeedWriteResult> {
  const existingRow = ctx.store.store.getArtifact(synthesis.artifactId);
  const existingSummary = ctx.store.store.getSummary(synthesis.artifactId);
  if (existingSummary) {
    return {
      artifactId: synthesis.artifactId,
      outcome: 'complete',
      checkpoints: ctx.store.store.getClosedCheckpoints(synthesis.artifactId).length,
    };
  }
  const existingArtifact = existingRow ? await ctx.store.readArtifact(synthesis.artifactId) : null;
  if (
    existingArtifact?.origin?.kind !== undefined &&
    existingArtifact.origin.kind !== 'git-import'
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Deterministic seed artifact id ${synthesis.artifactId} belongs to a live capture.`
    );
  }

  // An abandoned checkpoint releases its step and records no close, so that
  // position is un-imported — but replaying its deterministic open key lands
  // back on the abandoned checkpoint, which can never be closed, and the
  // cluster fails forever. Salt each position's keys with how many attempts
  // at it were abandoned: a retried position mints a fresh checkpoint while
  // an untouched one still replays byte-identically.
  const abandonedAttempts = new Map<string, number>();
  for (const checkpoint of existingRow
    ? await ctx.store.readCheckpoints(synthesis.artifactId)
    : []) {
    if (checkpoint.status !== 'abandoned') continue;
    for (const stepId of checkpoint.declared_step_ids) {
      abandonedAttempts.set(stepId, (abandonedAttempts.get(stepId) ?? 0) + 1);
    }
  }

  let planEventId: string;
  let resumed = existingRow !== null;
  const existingPlan = existingRow ? await ctx.store.readPlan(synthesis.artifactId) : null;
  if (existingPlan) {
    planEventId = existingPlan.source_event_id;
  } else {
    const written = await ctx.store.writePlan(synthesis.plan, {
      idempotencyKey: synthesis.idempotencyKeys.plan,
    });
    planEventId = written.event_id;
    resumed = false;
  }

  for (const checkpoint of synthesis.checkpoints) {
    const prepared =
      opts.prepared.get(checkpointKey(synthesis.artifactId, checkpoint.n)) ?? skippedCheckpoint();
    const attempts = abandonedAttempts.get(checkpoint.stepId) ?? 0;
    const retry = attempts > 0 ? `#retry${attempts}` : '';
    const opened = await ctx.store.writeCheckpointOpened(
      {
        artifact_id: synthesis.artifactId,
        declared_step_ids: [checkpoint.stepId],
        policy_exceptions: [],
        plan_revision_id: planEventId,
      },
      {
        headSha: checkpoint.group.parentSha,
        openedAt: checkpoint.timestamp,
        idempotencyKey: `${checkpoint.idempotencyKeys.open}${retry}`,
        invokedByAgent: 'other',
        snapshotCallbacks: {
          captureOpenSnapshot: async () => ({ boundary: prepared.openBoundary }),
        },
      }
    );
    if (opened.outcome === 'conflict' || opened.outcome === 'blocked') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Unable to replay imported checkpoint ${checkpoint.n} open.` +
          ' The durable event log is intact; only the derived cache can be wrong here. Run `orcaops rebuild` to re-derive it from the event logs, then re-run `orcaops seed --yes`. If it persists, run `orcaops doctor`. Do not delete the artifact directory, the project archive, or the seed journal — the cache outlives all three.'
      );
    }

    const closed = await ctx.store.writeCheckpointClosed(
      {
        artifact_id: synthesis.artifactId,
        n: opened.checkpoint.n,
        summary: checkpoint.summary,
        files_changed: checkpoint.group.files,
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: [checkpoint.stepId],
        head_sha: checkpoint.group.headSha,
      },
      {
        closedAt: checkpoint.timestamp,
        idempotencyKey: `${checkpoint.idempotencyKeys.close}${retry}`,
        invokedByAgent: 'other',
        skipWallClockOverlapScan: true,
        snapshotCallbacks: {
          captureCloseFingerprint: async () => ({
            boundary: prepared.closeBoundary,
            summary: prepared.fingerprintSummary,
            manifest: prepared.fingerprintManifest,
          }),
        },
      }
    );
    if (closed.outcome === 'conflict') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Unable to replay imported checkpoint ${checkpoint.n} close.` +
          ' The durable event log is intact; only the derived cache can be wrong here. Run `orcaops rebuild` to re-derive it from the event logs, then re-run `orcaops seed --yes`. If it persists, run `orcaops doctor`. Do not delete the artifact directory, the project archive, or the seed journal — the cache outlives all three.'
      );
    }
  }

  const summarized = await ctx.store.writeSummary(synthesis.summary, {
    idempotencyKey: synthesis.idempotencyKeys.summary,
  });
  if (summarized.outcome === 'conflict') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Unable to replay imported artifact ${synthesis.artifactId} summary.` +
        ' The durable event log is intact; only the derived cache can be wrong here. Run `orcaops rebuild` to re-derive it from the event logs, then re-run `orcaops seed --yes`. If it persists, run `orcaops doctor`. Do not delete the artifact directory, the project archive, or the seed journal — the cache outlives all three.'
    );
  }
  return {
    artifactId: synthesis.artifactId,
    outcome: resumed ? 'resumed' : 'created',
    checkpoints: synthesis.checkpoints.length,
  };
}
