// `review ledger` — build and persist the claim ledger.
// Deterministic, model-free, and independent of any composed narrative: it
// needs only a healthy floor plus the branch's checkpoint claims from the
// artifact store. Writes .orcaops/reviews/<slug>/ledger-v1.json.

import path from 'node:path';

import { loadConfig } from '@orcaops/core';
import { slugifyBranch } from '@orcaops/review-core';
import { ArtifactStore, atomicWriteFile } from '@orcaops/storage';

import { buildClaimLedger, type CheckpointClaims, type ClaimLedger } from './claimLedger.js';
import { loadHealthyFloorSource } from './floorSource.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath } from './reviewPaths.js';
import { requireReviewStateVersion, reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';
import { requireCompleteArtifactStore } from './storePreparation.js';

const USAGE = `usage: review ledger --branch <b> [--json]
Builds the deterministic claim ledger (account-vs-reality confrontation) from
the healthy floor + captured checkpoint claims. No model calls. Writes
.orcaops/reviews/<branch-slug>/ledger-v1.json.
`;

export async function loadCheckpointClaims(
  root: string,
  branch: string,
  scopeArtifactIds: readonly string[]
): Promise<CheckpointClaims[]> {
  const config = await loadConfig(root);
  const store = new ArtifactStore({ repoRoot: root, config });
  const claims: CheckpointClaims[] = [];
  const inScope = new Set(scopeArtifactIds);
  try {
    await requireCompleteArtifactStore(store, 'claim ledger');
    const rows = store.store
      .listArtifactsByLineageBranch({ branch })
      .filter((row) => inScope.has(row.id));
    for (const row of rows) {
      // FAIL CLOSED: the ledger is a durable deliverable — treating an
      // unreadable artifact as zero claims would convert acknowledged
      // work into "unclaimed" in ledger-v1.json. Refuse before writing.
      let checkpoints;
      try {
        checkpoints = await store.readCheckpointsRecovered(row.id);
      } catch (err) {
        throw new Error(
          `claim ledger cannot read artifact ${row.id} — ` +
            `${err instanceof Error ? err.message : String(err)} ` +
            `A ledger written without it would misstate claims; ` +
            `run \`orcaops doctor\` to see the corruption.`,
          { cause: err }
        );
      }
      for (const checkpoint of checkpoints) {
        claims.push({
          artifact: row.id,
          cp: checkpoint.n,
          status: checkpoint.status,
          completedStepIds:
            checkpoint.status === 'closed' ? [...checkpoint.completed_step_ids] : [],
          filesChanged: checkpoint.status === 'closed' ? [...checkpoint.files_changed] : [],
          verificationCommands:
            checkpoint.status === 'closed'
              ? (checkpoint.verification ?? []).map((entry) => entry.command)
              : [],
        });
      }
    }
  } finally {
    store.close();
  }
  return claims;
}

export async function runClaimLedger(args: ReviewArgs, root: string): Promise<number> {
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.branch) {
    process.stderr.write(`review ledger: --branch is required\n${USAGE}`);
    return 2;
  }
  try {
    const branchSlug = slugifyBranch(args.branch);
    const source = await loadHealthyFloorSource(root, branchSlug);
    const checkpoints = await loadCheckpointClaims(
      root,
      args.branch,
      source.floor.scope.artifact_ids
    );
    const ledger: ClaimLedger = buildClaimLedger({
      floor: source.floor,
      checkpoints,
      generatedAt: new Date().toISOString(),
    });
    const ledgerPath = path.join(reviewDirPath(root, branchSlug), 'ledger-v1.json');
    const lock = reviewLock(root);
    await lock.withLock(reviewStateLockKey(branchSlug), async (lease) => {
      await requireReviewStateVersion(path.dirname(ledgerPath));
      const currentSource = await loadHealthyFloorSource(root, branchSlug);
      if (currentSource.floorFingerprint !== source.floorFingerprint) {
        throw new Error('review floor changed while the claim ledger was being built; retry');
      }
      await lease.verify();
      await atomicWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, root);
    });
    if (args.json) {
      const byKind: Record<string, number> = {};
      for (const entry of ledger.entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          schema_version: ledger.schema_version,
          branch: ledger.branch,
          floor_input_hash: ledger.floor_input_hash,
          entries: ledger.entries.length,
          byKind,
          path: ledgerPath,
        })}\n`
      );
    } else {
      process.stdout.write(
        `claim ledger: ${String(ledger.entries.length)} entr${ledger.entries.length === 1 ? 'y' : 'ies'} → ${ledgerPath}\n`
      );
      for (const entry of ledger.entries) {
        process.stdout.write(`- [${entry.kind}] ${entry.message}\n`);
      }
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    } else {
      process.stderr.write(`review ledger: ${message}\n`);
    }
    return 1;
  }
}
