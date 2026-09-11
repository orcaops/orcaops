import { buildClaimLedger, type CheckpointClaims, type ClaimLedger } from './claimLedger.js';
import { readCanonicalReviewSource } from './database/review-source.js';
import { type ReviewArtifact } from './model.js';
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import type { ReviewArgs } from './run.js';

const USAGE = `usage: review ledger --branch <b> [--json]
Builds the deterministic claim ledger (account-vs-reality confrontation) from
the healthy floor + captured checkpoint claims. No model calls. Prints the ledger
to standard output without changing retained review state.
`;

/**
 * The branch's checkpoint claims, read from the review's retained artifacts.
 *
 * The claims are a durable deliverable, so this reads the same artifacts the
 * floor was derived from rather than a second source that could disagree with
 * it about what the review covers.
 */
export function checkpointClaims(
  artifacts: readonly ReviewArtifact[],
  scopeArtifactIds: readonly string[]
): CheckpointClaims[] {
  const inScope = new Set(scopeArtifactIds);
  const claims: CheckpointClaims[] = [];
  for (const artifact of artifacts) {
    if (!inScope.has(artifact.id)) continue;
    for (const checkpoint of artifact.checkpoints) {
      claims.push({
        artifact: artifact.id,
        cp: checkpoint.n,
        status: checkpoint.status,
        completedStepIds: checkpoint.status === 'closed' ? [...checkpoint.completedStepIds] : [],
        filesChanged: checkpoint.status === 'closed' ? [...checkpoint.filesChanged] : [],
        verificationCommands:
          checkpoint.status === 'closed'
            ? checkpoint.verification.map((entry) => entry.command)
            : [],
      });
    }
  }
  return claims;
}

export async function runClaimLedger(args: ReviewArgs, root: string): Promise<number> {
  if (args.help === true) {
    writeReviewOutput(USAGE);
    return 0;
  }
  if (!args.branch) {
    writeReviewError(`review ledger: --branch is required\n${USAGE}`);
    return 2;
  }
  try {
    const source = await readCanonicalReviewSource(args.branch, { cwd: root });
    const floor = source.floor;
    const checkpoints = checkpointClaims(source.artifacts, floor.scope.artifact_ids);
    const ledger: ClaimLedger = buildClaimLedger({
      floor,
      checkpoints,
      generatedAt: new Date().toISOString(),
    });
    if (args.json) {
      const byKind: Record<string, number> = {};
      for (const entry of ledger.entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      writeReviewOutput(
        `${JSON.stringify({
          ok: true,
          schema_version: ledger.schema_version,
          branch: ledger.branch,
          floor_input_hash: ledger.floor_input_hash,
          entries: ledger.entries.length,
          byKind,
        })}\n`
      );
    } else {
      writeReviewOutput(
        `claim ledger: ${String(ledger.entries.length)} entr${ledger.entries.length === 1 ? 'y' : 'ies'}\n`
      );
      for (const entry of ledger.entries) {
        writeReviewOutput(`- [${entry.kind}] ${entry.message}\n`);
      }
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    if (args.json) {
      writeReviewOutput(`${JSON.stringify({ ok: false, message })}\n`);
    } else {
      writeReviewError(`review ledger: ${message}\n`);
    }
    return 1;
  }
}
