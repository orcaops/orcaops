import {
  buildDiffFingerprintManifest,
  EMPTY_TREE_SHA,
  type Repo,
  SNAPSHOT_REF_PREFIX,
} from '@orcaops/core';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  type CheckpointSnapshotBoundary,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
  redactSecretsInObject,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';

import type { SeedClusterSynthesis } from './synthesize.js';

export interface PreparedSeedCheckpoint {
  openBoundary: CheckpointSnapshotBoundary;
  closeBoundary: CheckpointSnapshotBoundary;
  fingerprintSummary: DiffFingerprintSummary;
  fingerprintManifest: DiffFingerprintManifest | null;
  publications: readonly SeedSnapshotPublication[];
}

export interface SeedSnapshotPublication {
  publicationId: string;
  fullRef: string;
  objectOid: string;
  treeOid: string;
  objectFormat: 'sha1' | 'sha256';
  checkpointNumber: number;
  checkpointPhase: 'open' | 'close';
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
    publications: [],
  };
}

function snapshotPublication(
  synthesis: SeedClusterSynthesis,
  checkpoint: SeedClusterSynthesis['checkpoints'][number],
  phase: 'open' | 'close',
  objectOid: string,
  treeOid: string
): SeedSnapshotPublication {
  const publicationId = artifactOperationId(
    synthesis.artifactId,
    checkpoint.idempotencyKeys[phase],
    'seed_snapshot'
  );
  return {
    publicationId,
    fullRef: `${SNAPSHOT_REF_PREFIX}/${synthesis.artifactId}/${checkpoint.n}/${phase}-${publicationId}`,
    objectOid,
    treeOid,
    objectFormat: objectOid.length === 64 ? 'sha256' : 'sha1',
    checkpointNumber: checkpoint.n,
    checkpointPhase: phase,
  };
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

  return readSeedSnapshots(repo, pinnable, prepared, opts);
}

async function readSeedSnapshots(
  repo: Repo,
  pinnable: {
    synthesis: SeedClusterSynthesis;
    checkpoint: SeedClusterSynthesis['checkpoints'][number];
  }[],
  prepared: Map<string, PreparedSeedCheckpoint>,
  opts: { maxDiffBytes: number }
): Promise<ReadonlyMap<string, PreparedSeedCheckpoint>> {
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
      const openPublication = snapshotPublication(
        synthesis,
        checkpoint,
        'open',
        checkpoint.group.parentSha,
        openTreeSha
      );
      const closePublication = snapshotPublication(
        synthesis,
        checkpoint,
        'close',
        checkpoint.group.headSha,
        closeTreeSha
      );
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
          snapshot_ref: openPublication.fullRef,
          tree_sha: openTreeSha,
          snapshot_commit_sha: checkpoint.group.parentSha,
          snapshot_error_reason: null,
        },
        closeBoundary: {
          snapshot_ref: closePublication.fullRef,
          tree_sha: closeTreeSha,
          snapshot_commit_sha: checkpoint.group.headSha,
          snapshot_error_reason: null,
        },
        fingerprintSummary: built.summary,
        fingerprintManifest: built.manifest,
        publications: [openPublication, closePublication],
      });
    } catch {
      prepared.set(checkpointKey(synthesis.artifactId, checkpoint.n), skippedCheckpoint());
    }
  }
  return prepared;
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
export function redactSeedNarrative(synthesis: SeedClusterSynthesis): SeedClusterSynthesis {
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
