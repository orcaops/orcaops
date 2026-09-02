// `review dossier` — tier 1 of the two-lane surface: the instant
// deterministic dossier plus both budgeted lane inputs, zero model
// calls.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '@orcaops/core';
import { DISCLOSURE_CODE, slugifyBranch } from '@orcaops/review-core';
import { atomicWriteFile, resolveCaptureExcludes } from '@orcaops/storage';

import { buildClaimLedger, type ClaimLedgerEntry } from './claimLedger.js';
import { loadCheckpointClaims } from './claimLedgerCli.js';
import {
  AccountCorpusCeilingError,
  buildDossier,
  DOSSIER_BUDGET_V1,
  DossierBudgetError,
  ExcludePolicyError,
  ForensicTransportCeilingError,
  invalidStubPatterns,
  ReviewDiffTruncatedError,
  ROUTINE_BUDGET_V1,
  StubPolicyError,
} from './dossier.js';
import { loadHealthyFloorSource } from './floorSource.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath } from './reviewPaths.js';
import { requireReviewStateVersion, reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';

const USAGE = `usage: review dossier --branch <b> [--profile routine|full] [--json]
Builds the tier-1 deterministic dossier: the complete
account-vs-code record, the budgeted account-lane projection, and the
capture-blind forensic lane input. Zero model calls. Writes
dossier-v1.json, dossier.md, account-projection-v1.json, and
forensic-input-v1.json under .orcaops/reviews/<branch>/.
--profile routine uses the ~8k-token-per-lane routine budgets; default full.
`;

async function rebuildLedger(
  root: string,
  branch: string,
  floor: Parameters<typeof buildClaimLedger>[0]['floor']
): Promise<ClaimLedgerEntry[]> {
  const checkpoints = await loadCheckpointClaims(root, branch, floor.scope.artifact_ids);
  return buildClaimLedger({
    floor,
    checkpoints,
    generatedAt: '1970-01-01T00:00:00.000Z',
  }).entries;
}

export type DossierProfile = 'routine' | 'full';

/** Unknown profile values fail loudly — never a silent fallback. */
export function parseDossierProfile(value: string | undefined): DossierProfile | null {
  if (value === undefined || value === 'full') return 'full';
  if (value === 'routine') return 'routine';
  return null;
}

/**
 * Build the dossier from the healthy floor and write the four lane files.
 * Shared by `review dossier` and the composite `review routine-start`.
 */
export async function buildAndWriteDossier(
  root: string,
  branch: string,
  profile: DossierProfile
): Promise<ReturnType<typeof buildDossier>> {
  const branchSlug = slugifyBranch(branch);
  const reviewDir = reviewDirPath(root, branchSlug);
  // Repo diff-stub policy (review.stub_paths). Validate at routine-start, before
  // any read/build work, so a malformed policy fails loudly with no payload
  // minted — never a silent skip.
  const config = await loadConfig(root);
  const stubPaths = config.review.stub_paths;
  const invalidStubs = invalidStubPatterns(stubPaths);
  if (invalidStubs.length > 0) throw new StubPolicyError(invalidStubs);
  // Same posture for the exclude policy: a malformed entry is a hole in a
  // security control, so fail before any payload is minted rather than
  // silently reviewing the path it was meant to withhold.
  const excludes = resolveCaptureExcludes(config.capture);
  if (excludes.invalid.length > 0) throw new ExcludePolicyError(excludes.invalid);
  const source = await loadHealthyFloorSource(root, branchSlug);
  // Refuse over a truncated floor: a truncated review diff is
  // partial coverage; the routine surface must never mint a payload over it.
  const truncated = source.floor.disclosure.find(
    (d) => d.code === DISCLOSURE_CODE.LIVE_DIFF_TRUNCATED
  );
  if (truncated !== undefined) {
    // The cap is not persisted on the floor scope; the disclosure message
    // names it. Recover the numeric ceiling from the message for the envelope.
    const capMatch = /review\.max_diff_bytes \((\d+)\)/.exec(truncated.message);
    throw new ReviewDiffTruncatedError(
      truncated.message,
      capMatch !== null ? Number.parseInt(capMatch[1]!, 10) : null
    );
  }
  const retainedDiff = await readFile(path.join(reviewDir, 'diff.patch'), 'utf8');
  const ledgerEntries = await rebuildLedger(root, branch, source.floor);
  const result = buildDossier({
    floor: source.floor,
    retainedDiff,
    ledgerEntries,
    branch,
    baseSha: source.floor.scope.base_sha,
    generatedAt: new Date().toISOString(),
    budget: profile === 'routine' ? ROUTINE_BUDGET_V1 : DOSSIER_BUDGET_V1,
    stubPaths,
    excludePaths: excludes.patterns,
  });
  const lock = reviewLock(root);
  await lock.withLock(reviewStateLockKey(branchSlug), async (lease) => {
    await requireReviewStateVersion(reviewDir);
    const currentSource = await loadHealthyFloorSource(root, branchSlug);
    if (currentSource.floorFingerprint !== source.floorFingerprint) {
      throw new Error('review floor changed while the dossier was being built; retry');
    }
    await lease.verify();
    await atomicWriteFile(
      path.join(reviewDir, 'dossier-v1.json'),
      `${JSON.stringify(result.dossier, null, 2)}\n`,
      root
    );
    await atomicWriteFile(path.join(reviewDir, 'dossier.md'), result.markdown, root);
    await atomicWriteFile(
      path.join(reviewDir, 'account-projection-v1.json'),
      `${JSON.stringify(result.accountProjection, null, 2)}\n`,
      root
    );
    await atomicWriteFile(
      path.join(reviewDir, 'forensic-input-v1.json'),
      `${JSON.stringify(result.forensicInput, null, 2)}\n`,
      root
    );
    // Coverage snapshot: the floor's persisted per-hunk attribution over
    // the SAME diff bytes the dossier read. composeStory folds it into Part
    // ownership at finalization; the run pins its sha under `input_shas`.
    await atomicWriteFile(
      path.join(reviewDir, 'coverage-v1.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          attribution_rung: source.floor.attribution.active_rung,
          items: source.floor.coverage.items,
          summary: source.floor.coverage.summary,
        },
        null,
        2
      )}\n`,
      root
    );
  });
  return result;
}

export async function runDossier(args: ReviewArgs, root: string): Promise<number> {
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.branch) {
    process.stderr.write(`review dossier: --branch is required\n${USAGE}`);
    return 2;
  }
  const profile = parseDossierProfile(args.profile);
  if (profile === null) {
    process.stderr.write(
      `review dossier: unknown --profile '${args.profile ?? ''}' — valid values: routine, full\n`
    );
    return 2;
  }
  try {
    const result = await buildAndWriteDossier(root, args.branch, profile);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          profile,
          hunks: result.dossier.code_index.length,
          ledgerEntries: result.dossier.account_core.ledger.length,
          truncationRecords: result.dossier.truncation_manifest.length,
          files: [
            'dossier-v1.json',
            'dossier.md',
            'account-projection-v1.json',
            'forensic-input-v1.json',
            'coverage-v1.json',
          ],
        })}\n`
      );
    } else {
      process.stdout.write(result.markdown);
    }
    return 0;
  } catch (error) {
    if (error instanceof StubPolicyError || error instanceof ExcludePolicyError) {
      // Malformed repo stub or exclude policy: parseable envelope, no payload minted.
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: {
              verb: 'review dossier',
              code: error.code,
              message: error.message,
              invalid_patterns: error.invalidPatterns,
            },
          })}\n`
        );
      } else {
        process.stderr.write(`review dossier: ${error.message}\n`);
      }
      return 1;
    }
    if (
      error instanceof AccountCorpusCeilingError ||
      error instanceof ForensicTransportCeilingError ||
      error instanceof ReviewDiffTruncatedError
    ) {
      // Size-degradation refusal: parseable envelope naming the
      // ceiling and the actual size; no payload was minted.
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: {
              verb: 'review dossier',
              code: error.code,
              message: error.message,
              ceiling_bytes: error.ceilingBytes,
              actual_bytes: error.actualBytes,
            },
          })}\n`
        );
      } else {
        process.stderr.write(`review dossier: ${error.message}\n`);
      }
      return 1;
    }
    if (error instanceof DossierBudgetError) {
      process.stderr.write(`review dossier: ${error.message}\n`);
      for (const item of error.inventory.slice(0, 10)) {
        process.stderr.write(`  oversize: ${item.id} (${item.section}) ~${item.size} tokens\n`);
      }
      return 1;
    }
    process.stderr.write(`review dossier: ${(error as Error).message}\n`);
    return 1;
  }
}
