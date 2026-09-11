// `review dossier` — tier 1 of the two-lane surface: the instant
// deterministic dossier plus both budgeted lane inputs, zero model
// calls.
//
// The dossier is derived on read from the retained floor publication and never
// bound to a run: `prepareDatabaseReviewRunInputs` binds a run's dossier,
// projection, forensic input, coverage and diff to that run, so a dossier built
// before any run exists has no canonical home. Like the claim ledger, it
// restates what the selected floor already covers and mints nothing.

import { loadConfig } from '@orcaops/core';
import { DISCLOSURE_CODE } from '@orcaops/review-core';
import { resolveCaptureExcludes } from '@orcaops/storage';

import { buildClaimLedger, type ClaimLedgerEntry } from './claimLedger.js';
import { checkpointClaims } from './claimLedgerCli.js';
import { readCanonicalReviewSource } from './database/review-source.js';
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
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import type { ReviewArgs } from './run.js';

const USAGE = `usage: review dossier --branch <b> [--profile routine|full] [--json]
Derives the tier-1 deterministic dossier from the selected floor: the complete
account-vs-code record, the budgeted account-lane projection, and the
capture-blind forensic lane input. Zero model calls, and nothing is written —
the run's pinned inputs are minted by \`review start\` / \`routine-start\`.
--profile routine uses the ~8k-token-per-lane routine budgets; default full.
`;

function rebuildLedger(
  artifacts: Parameters<typeof checkpointClaims>[0],
  branch: string,
  floor: Parameters<typeof buildClaimLedger>[0]['floor']
): ClaimLedgerEntry[] {
  const checkpoints = checkpointClaims(artifacts, floor.scope.artifact_ids);
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
 * Derive the dossier from the selected floor. Shared by `review dossier` and
 * any caller that needs the same deterministic projection without a run.
 */
export async function buildBranchDossier(
  root: string,
  branch: string,
  profile: DossierProfile
): Promise<ReturnType<typeof buildDossier>> {
  // Repo diff-stub policy (review.stub_paths). Validate before any read/build
  // work, so a malformed policy fails loudly with no payload derived — never a
  // silent skip.
  const config = await loadConfig(root);
  const stubPaths = config.review.stub_paths;
  const invalidStubs = invalidStubPatterns(stubPaths);
  if (invalidStubs.length > 0) throw new StubPolicyError(invalidStubs);
  // Same posture for the exclude policy: a malformed entry is a hole in a
  // security control, so fail before any payload is derived rather than
  // silently reviewing the path it was meant to withhold.
  const excludes = resolveCaptureExcludes(config.capture);
  if (excludes.invalid.length > 0) throw new ExcludePolicyError(excludes.invalid);
  const source = await readCanonicalReviewSource(branch, { cwd: root });
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
  return buildDossier({
    floor: source.floor,
    retainedDiff: source.diffText,
    ledgerEntries: rebuildLedger(source.artifacts, branch, source.floor),
    branch,
    baseSha: source.floor.scope.base_sha,
    generatedAt: new Date().toISOString(),
    budget: profile === 'routine' ? ROUTINE_BUDGET_V1 : DOSSIER_BUDGET_V1,
    stubPaths,
    excludePaths: excludes.patterns,
  });
}

export async function runDossier(args: ReviewArgs, root: string): Promise<number> {
  if (args.help === true) {
    writeReviewOutput(USAGE);
    return 0;
  }
  if (!args.branch) {
    writeReviewError(`review dossier: --branch is required\n${USAGE}`);
    return 2;
  }
  const profile = parseDossierProfile(args.profile);
  if (profile === null) {
    writeReviewError(
      `review dossier: unknown --profile '${args.profile ?? ''}' — valid values: routine, full\n`
    );
    return 2;
  }
  try {
    const result = await buildBranchDossier(root, args.branch, profile);

    if (args.json) {
      writeReviewOutput(
        `${JSON.stringify({
          ok: true,
          profile,
          hunks: result.dossier.code_index.length,
          ledgerEntries: result.dossier.account_core.ledger.length,
          truncationRecords: result.dossier.truncation_manifest.length,
          floor_input_hash: result.dossier.floor_input_hash,
        })}\n`
      );
    } else {
      writeReviewOutput(result.markdown);
    }
    return 0;
  } catch (error) {
    if (error instanceof StubPolicyError || error instanceof ExcludePolicyError) {
      // Malformed repo stub or exclude policy: parseable envelope, no payload minted.
      if (args.json) {
        writeReviewOutput(
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
        writeReviewError(`review dossier: ${error.message}\n`);
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
        writeReviewOutput(
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
        writeReviewError(`review dossier: ${error.message}\n`);
      }
      return 1;
    }
    if (error instanceof DossierBudgetError) {
      writeReviewError(`review dossier: ${error.message}\n`);
      for (const item of error.inventory.slice(0, 10)) {
        writeReviewError(`  oversize: ${item.id} (${item.section}) ~${item.size} tokens\n`);
      }
      return 1;
    }
    writeReviewError(`review dossier: ${(error as Error).message}\n`);
    return 1;
  }
}
