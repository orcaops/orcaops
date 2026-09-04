import { createHash } from 'node:crypto';

import { type DetailedCommit, type SeedCluster } from '@orcaops/core';
import {
  computeMemberShasHash,
  type GitImportEnrichmentPayload,
  type Plan,
  type Summary,
} from '@orcaops/storage';

import {
  importedArtifactEnrichmentDir,
  readSeedEnrichmentManifest,
  resolveSeedEnrichment,
  writeSeedEnrichmentBundles,
} from './enrichment.js';
import { withSeedRunLock } from './journal.js';
import type { SeedCheckpointSynthesis, SeedClusterSynthesis } from './synthesize.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext, type CliContext } from '../../lib/context.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface SeedEnrichOptions {
  artifact: string;
  dryRun?: boolean;
  yes?: boolean;
  enrichmentDir?: string;
  preserveDecisions?: boolean;
  prContext?: boolean;
  json?: boolean;
}

interface SeedEnrichResult {
  mode: 'dry-run' | 'apply';
  artifact_id: string;
  bundle_directory: string;
  bundle_file: string;
  decision_mode: 'preserve' | 'replace';
  confirmation_required: boolean;
  ready: boolean;
  totals: { amended: number; unchanged: number; invalid: number; failed: number };
  invalid: Array<{ file: string; reason: string }>;
  warnings: Array<{ file: string; warning: string }>;
  failures: string[];
}

function enrichmentOptionsHash(plan: Plan): string {
  const origin = plan.origin!;
  return createHash('sha256')
    .update(
      JSON.stringify([
        'orcaops-seed-enrich:v1',
        plan.artifact_id,
        origin.cluster_key,
        origin.member_shas_hash,
      ])
    )
    .digest('hex');
}

async function loadMemberCommits(
  ctx: CliContext,
  shas: readonly string[]
): Promise<DetailedCommit[]> {
  const commits = new Array<DetailedCommit>(shas.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, shas.length) }, async () => {
    while (nextIndex < shas.length) {
      const index = nextIndex++;
      const sha = shas[index]!;
      let commit: DetailedCommit | undefined;
      try {
        commit = (await ctx.repo.logDetailed(sha, { maxCount: 1 }))[0];
      } catch {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Cannot read imported member commit ${sha}; restore the Git object and retry.`,
          'artifact'
        );
      }
      if (!commit || commit.sha !== sha) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Cannot read imported member commit ${sha}; restore the Git object and retry.`,
          'artifact'
        );
      }
      commits[index] = commit;
    }
  });
  await Promise.all(workers);
  return commits.sort(
    (left, right) =>
      Date.parse(left.committerDateIso) - Date.parse(right.committerDateIso) ||
      left.sha.localeCompare(right.sha)
  );
}

async function existingImportSynthesis(
  ctx: CliContext,
  artifactId: string
): Promise<{ synthesis: SeedClusterSynthesis; plan: Plan; summary: Summary }> {
  const plan = await ctx.store.readPlan(artifactId);
  if (!plan) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No artifact found for ${JSON.stringify(artifactId)}.`,
      'artifact'
    );
  }
  const origin = plan.origin;
  if (origin?.kind !== 'git-import') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(artifactId)} is not imported Git history.`,
      'artifact'
    );
  }
  if (!origin.cluster_key || !origin.member_shas || !origin.member_shas_hash) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(artifactId)} predates exact seed membership. ` +
        'Re-seed it with a current Orcaops build before enriching it.',
      'artifact'
    );
  }
  if (computeMemberShasHash(origin.member_shas) !== origin.member_shas_hash) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(artifactId)} has inconsistent imported member provenance.`,
      'artifact'
    );
  }
  const checkpoints = await ctx.store.readCheckpoints(artifactId);
  const summary = await ctx.store.readSummary(artifactId);
  if (
    !summary ||
    checkpoints.length !== plan.plan_steps.length ||
    checkpoints.some((checkpoint) => checkpoint.status !== 'closed')
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(artifactId)} is not a complete imported thread.`,
      'artifact'
    );
  }
  const closed = checkpoints
    .filter((checkpoint) => checkpoint.status === 'closed')
    .sort((left, right) => left.n - right.n);
  const commits = await loadMemberCommits(ctx, origin.member_shas);
  const headCommit = commits.find((commit) => commit.sha === summary.head_sha);
  if (!headCommit) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(artifactId)} has inconsistent imported member provenance: ` +
        `summary head ${summary.head_sha} is not an imported member.`,
      'artifact'
    );
  }
  const checkpointSyntheses: SeedCheckpointSynthesis[] = closed.map((checkpoint, index) => {
    const representative =
      commits.find((commit) => commit.sha === checkpoint.head_sha) ??
      commits[index] ??
      commits.at(-1)!;
    return {
      n: checkpoint.n,
      stepId: plan.plan_steps[index]!.step_id,
      timestamp: checkpoint.closed_at,
      group: {
        key: `checkpoint:${checkpoint.n}`,
        commits: [representative],
        parentSha: checkpoint.open_head_sha ?? plan.base_sha,
        headSha: checkpoint.head_sha,
        files: checkpoint.files_changed,
        committerDateIso: checkpoint.closed_at,
      },
      summary: checkpoint.summary,
      idempotencyKeys: { open: 'unused', close: 'unused' },
    };
  });
  const cluster: SeedCluster = {
    key: origin.cluster_key,
    kind: headCommit && headCommit.parentShas.length > 1 ? 'merge' : 'run',
    label: plan.label,
    baseSha: plan.base_sha,
    headSha: summary.head_sha,
    commits,
    checkpoints: checkpointSyntheses.map((checkpoint) => checkpoint.group),
    authors: origin.authors,
    files: [...new Set(closed.flatMap((checkpoint) => checkpoint.files_changed))].sort(),
    firstParentPosition: 0,
    displayDateIso: summary.ts,
    latestCommitDateIso: summary.ts,
    conventionalType: null,
    conventionalScope: null,
    warnings: [],
  };
  return {
    plan,
    summary,
    synthesis: {
      artifactId,
      cluster,
      plan,
      checkpoints: checkpointSyntheses,
      summary,
      idempotencyKeys: { plan: 'unused', summary: 'unused' },
    },
  };
}

function authoredContentMatches(
  current: { synthesis: SeedClusterSynthesis; plan: Plan; summary: Summary },
  proposed: SeedClusterSynthesis,
  preserveDecisions: boolean
): boolean {
  return (
    current.plan.label === proposed.plan.label &&
    current.plan.task === proposed.plan.task &&
    JSON.stringify(
      current.plan.plan_steps.map((step) => ({ label: step.label, text: step.text }))
    ) ===
      JSON.stringify(
        proposed.plan.plan_steps.map((step) => ({ label: step.label, text: step.text }))
      ) &&
    JSON.stringify(current.synthesis.checkpoints.map((checkpoint) => checkpoint.summary)) ===
      JSON.stringify(proposed.checkpoints.map((checkpoint) => checkpoint.summary)) &&
    current.summary.outcome === proposed.summary.outcome &&
    (preserveDecisions ||
      JSON.stringify(current.plan.decisions) === JSON.stringify(proposed.plan.decisions))
  );
}

function amendmentPayload(
  current: { plan: Plan },
  proposed: SeedClusterSynthesis,
  priorEnrichmentEventId: string | null,
  preserveDecisions: boolean
): GitImportEnrichmentPayload {
  const origin = current.plan.origin!;
  return {
    provenance_version: 1,
    artifact_id: current.plan.artifact_id,
    cluster_key: origin.cluster_key!,
    member_shas_hash: origin.member_shas_hash!,
    enriched_at: proposed.plan.origin!.enriched_at!,
    prior_enrichment_event_id: priorEnrichmentEventId,
    label: proposed.plan.label,
    task: proposed.plan.task,
    steps: proposed.plan.plan_steps.map((step) => ({ label: step.label, text: step.text })),
    checkpoint_summaries: proposed.checkpoints.map((checkpoint) => ({
      n: checkpoint.n,
      summary: checkpoint.summary,
    })),
    outcome: proposed.summary.outcome,
    decisions: preserveDecisions
      ? { mode: 'preserve' }
      : {
          mode: 'replace',
          decisions: proposed.plan.decisions.map((decision) => ({
            ...decision,
            revision_n: 0 as const,
            evidence: decision.evidence!,
          })),
        },
  };
}

export async function runSeedEnrich(
  ctx: CliContext,
  opts: SeedEnrichOptions
): Promise<SeedEnrichResult> {
  if (opts.dryRun && opts.yes) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--dry-run and --yes cannot be used together.',
      'dryRun'
    );
  }
  const current = await existingImportSynthesis(ctx, opts.artifact);
  if (
    opts.preserveDecisions !== true &&
    current.plan.decisions.some((decision) => !decision.evidence)
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Artifact ${JSON.stringify(opts.artifact)} has decisions without structured Git evidence. ` +
        'Use --preserve-decisions for a prose-only amendment.',
      'preserveDecisions'
    );
  }
  const decisionMode = opts.preserveDecisions ? ('preserve' as const) : ('replace' as const);
  const optionsHash = enrichmentOptionsHash(current.plan);
  const directory =
    opts.enrichmentDir ?? importedArtifactEnrichmentDir(ctx.repo.cwd, ctx.config, opts.artifact);
  const priorEnrichmentEventId = await ctx.store.readLatestGitImportEnrichmentEventId(
    opts.artifact
  );
  const mode: SeedEnrichResult['mode'] = opts.yes ? 'apply' : 'dry-run';

  let manifest = await readSeedEnrichmentManifest(ctx.repo.cwd, ctx.config, directory);
  if (mode === 'dry-run') {
    await writeSeedEnrichmentBundles(ctx.repo.cwd, ctx.config, [current.synthesis], {
      optionsHash,
      prContextConsented: opts.prContext === true,
      directory,
      amendment: {
        artifact_id: opts.artifact,
        prior_enrichment_event_id: priorEnrichmentEventId,
        member_shas_hash: current.plan.origin!.member_shas_hash!,
        decision_mode: decisionMode,
        pr_context_consented: opts.prContext === true,
      },
    });
    manifest = await readSeedEnrichmentManifest(ctx.repo.cwd, ctx.config, directory);
  }
  if (
    !manifest ||
    manifest.options_hash !== optionsHash ||
    manifest.amendment?.artifact_id !== opts.artifact ||
    manifest.amendment.member_shas_hash !== current.plan.origin!.member_shas_hash ||
    manifest.amendment.decision_mode !== decisionMode ||
    manifest.amendment.pr_context_consented !== (opts.prContext === true)
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No current enrichment preview exists for ${JSON.stringify(opts.artifact)}. ` +
        'Run `orcaops seed enrich --artifact <id> --dry-run` first.',
      'artifact'
    );
  }
  if (manifest.amendment.prior_enrichment_event_id !== priorEnrichmentEventId) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `The enrichment preview for ${JSON.stringify(opts.artifact)} is stale. ` +
        'Run `orcaops seed enrich --artifact <id> --dry-run` again before applying it.',
      'artifact'
    );
  }

  const resolved = await resolveSeedEnrichment(ctx.repo.cwd, ctx.config, [current.synthesis], {
    enrichmentDir: directory,
    optionsHash,
    prContextConsented: opts.prContext === true,
    usePersisted: false,
    persistAccepted: false,
  });
  const bundleFile = manifest.bundles[0]?.filename ?? '';
  const base = {
    mode,
    artifact_id: opts.artifact,
    bundle_directory: directory,
    bundle_file: bundleFile,
    decision_mode: decisionMode,
    invalid: resolved.report.invalid.map((entry) => ({ file: entry.file, reason: entry.reason })),
    warnings: resolved.report.warnings.map((entry) => ({
      file: entry.file,
      warning: entry.warning,
    })),
  };
  if (resolved.report.applied !== 1) {
    const missingUsableEnrichment = mode === 'apply' && resolved.report.invalid.length === 0;
    return {
      ...base,
      confirmation_required: false,
      ready: false,
      totals: {
        amended: 0,
        unchanged: 0,
        invalid: resolved.report.invalid.length,
        failed: missingUsableEnrichment ? 1 : 0,
      },
      failures: missingUsableEnrichment
        ? [
            `No usable authored enrichment JSON matched artifact ` +
              `${JSON.stringify(opts.artifact)} in ${directory}. ` +
              'Create or correct it from the generated bundle, then rerun the preview before applying.',
          ]
        : [],
    };
  }

  const proposed = resolved.syntheses[0]!;
  if (authoredContentMatches(current, proposed, opts.preserveDecisions === true)) {
    return {
      ...base,
      confirmation_required: false,
      ready: true,
      totals: { amended: 0, unchanged: 1, invalid: 0, failed: 0 },
      failures: [],
    };
  }
  if (mode === 'dry-run') {
    return {
      ...base,
      confirmation_required: true,
      ready: true,
      totals: { amended: 0, unchanged: 0, invalid: 0, failed: 0 },
      failures: [],
    };
  }

  const payload = amendmentPayload(
    current,
    proposed,
    manifest.amendment.prior_enrichment_event_id,
    opts.preserveDecisions === true
  );
  const { enriched_at: _enrichedAt, ...idempotentContent } = payload;
  const idempotencyKey = createHash('sha256')
    .update(JSON.stringify(idempotentContent))
    .digest('hex');
  try {
    const written = await ctx.store.writeGitImportEnrichment(payload, { idempotencyKey });
    return {
      ...base,
      confirmation_required: false,
      ready: true,
      totals: {
        amended: written.outcome === 'created' ? 1 : 0,
        unchanged: written.outcome === 'replay' ? 1 : 0,
        invalid: 0,
        failed: written.outcome === 'conflict' ? 1 : 0,
      },
      failures:
        written.outcome === 'conflict'
          ? [`Idempotency conflict with event ${written.priorEventId ?? 'unknown'}.`]
          : [],
    };
  } catch (error) {
    return {
      ...base,
      confirmation_required: false,
      ready: true,
      totals: { amended: 0, unchanged: 0, invalid: 0, failed: 1 },
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function renderSeedEnrichResult(result: SeedEnrichResult): string {
  const lines = [
    `Seed enrichment ${result.mode === 'dry-run' ? 'preview' : 'apply'} — ${result.artifact_id}`,
    `Bundle: ${result.bundle_directory}/${result.bundle_file}`,
    `Decision mode: ${result.decision_mode}`,
    `Amended ${result.totals.amended}; unchanged ${result.totals.unchanged}; ` +
      `invalid ${result.totals.invalid}; failed ${result.totals.failed}.`,
  ];
  for (const invalid of result.invalid) lines.push(`invalid ${invalid.file}: ${invalid.reason}`);
  for (const warning of result.warnings) lines.push(`warning ${warning.file}: ${warning.warning}`);
  for (const failure of result.failures) lines.push(`failed: ${failure}`);
  if (!result.ready) {
    lines.push('Author the enrichment JSON beside the generated bundle, then rerun the preview.');
  } else if (result.confirmation_required) {
    lines.push('Review the preview, then rerun with `--yes` to append the amendment event.');
  }
  return `${lines.join('\n')}\n`;
}

export async function seedEnrichAction(opts: SeedEnrichOptions): Promise<void> {
  let failed = false;
  try {
    const ctx = await buildContext();
    try {
      const result = await withSeedRunLock(ctx.repo, getInvocationEnv(), () =>
        runSeedEnrich(ctx, opts)
      );
      if (opts.json) emitOk(result);
      else writeTerminalSafeStdout(renderSeedEnrichResult(result));
      failed = result.totals.invalid > 0 || result.totals.failed > 0;
    } finally {
      ctx.store.close();
    }
  } catch (error) {
    if (opts.json) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  }
  if (failed) throw new CliExit(1);
}
