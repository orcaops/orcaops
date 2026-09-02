import { spawn } from 'node:child_process';

import { buildRepoState, type RepoState, type ResumeData, writeResume } from '@orcaops/core';
import {
  REVIEW_STATE_VERSION,
  reviewFloorLockKey,
  reviewLocksDir,
  validateReviewLogFiles,
} from '@orcaops/review-engine';
import {
  ArchiveRestoreDivergenceError,
  ArchiveRestoreNotInFlightError,
  type ArtifactJson,
  ArtifactLock,
  type ArtifactRow,
  type ArtifactState,
  inspectArchivedArtifactAvailability,
  readPin,
  resolveShellKey,
  restoreArtifactFromArchive,
  restoreReviewLogsFromArchive,
  type ShellKey,
  withPinFileLock,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { deriveLabel, loadInFlightOnBranch } from '../lib/active-artifact.js';
import {
  importedArtifactsDisclosure,
  importedTrailerLine,
  resolveBranchReadScope,
} from '../lib/artifact-scope.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildContext, type CliContext } from '../lib/context.js';
import { detectInstallDrift, formatDriftNudge, type InstallDrift } from '../lib/install-drift.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { renderedNextActionsForArtifact } from '../lib/next-actions.js';
import { replacePin, resolvePinTargets, resolvePinTargetsForRead } from '../lib/pin-helpers.js';

export interface ResumeOptions {
  artifact?: string;
  branch?: string;
  copy?: boolean;
  format?: 'md' | 'json';
  json?: boolean;
  /** Picker default-acceptance: pin to default_candidate_id and resume it. */
  acceptDefault?: boolean;
  /** Skip the auto-pin write that `--accept-default` otherwise performs. */
  noPin?: boolean;
}

type ResolutionVia = 'pin' | 'single-active' | 'explicit-flag';

interface ResolvedKind {
  kind: 'resolved';
  via: ResolutionVia;
  artifactId: string;
  /** True when the picker fell back to SHA reachability. */
  lineageStale: boolean;
  lineageBranches?: string[];
  /** Whether this resolution should auto-pin (only --accept-default). */
  shouldAutoPin: boolean;
  /** The artifact was cold-started from the home-dir archive. */
  restoredFromArchive?: boolean;
  /** Result of restoring the companion review logs after a cold start. */
  reviewRestore?: ReviewRestoreOutcome;
}

type ReviewRestoreOutcome =
  | { status: 'ok'; lines_copied: number }
  | { status: 'failed'; error: string; progress: 'possibly_partial' };

interface ResolvedEmpty {
  kind: 'resolved-empty';
  branch: string;
}

interface PickerCandidate {
  id: string;
  label: string;
  task: string;
  branch: string;
  started_at: string;
  last_activity_at: string;
  state: ArtifactState;
  checkpoint_count: number;
  created_by_session_id: string | null;
  files_touched_recently: string[];
  summary_excerpt: string | null;
}

interface AmbiguousKind {
  kind: 'ambiguous';
  branch: string;
  shellKey: ShellKey;
  candidates: PickerCandidate[];
  defaultCandidateId: string;
}

type ResolveResult = ResolvedKind | ResolvedEmpty | AmbiguousKind;

/**
 * `orcaops resume` — resolve and render the current shell's in-flight
 * artifact thread.
 *
 * Resolution algorithm:
 *   1. Explicit `--artifact <id>` → via=explicit-flag (resume-once,
 *      never auto-pins).
 *   2. Pin lookup for current shell-key. If found and pinned artifact
 *      loads → via=pin.
 *   3. Strict-active filter on current branch (planned/active/blocked).
 *      a. 0 → fallback to SHA reachability (picker fallback).
 *           Same N=0/1/>1 split applies.
 *      b. 1 → via=single-active.
 *      c. >1 → ambiguous picker.
 *
 * `--accept-default` accepts the picker's default_candidate_id (most-
 * recently-active) and is the only resolution path that writes a pin
 * by default. `--no-pin` opts out of the pin-write for headless / CI.
 */
export async function resumeAction(opts: ResumeOptions = {}): Promise<void> {
  const wantJson = opts.json || opts.format === 'json';
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const resolution = await resolveResume(ctx, opts);

      if (resolution.kind === 'resolved-empty') {
        // Seeded participation (storage-class rule, decided explicitly):
        // resume targets live work, so imported artifacts are disclosed via
        // the shared trailer instead of resolved.
        const scope = await resolveBranchReadScope(
          ctx,
          { branch: resolution.branch },
          { imported: 'disclose' }
        );
        await emitResolvedEmpty(resolution, { wantJson }, scope.importedRows.length);
        return;
      }

      if (resolution.kind === 'ambiguous') {
        if (!opts.acceptDefault) {
          await emitPicker(resolution, { wantJson });
          throw new CliExit(1);
        }
        // Accept-default path: convert ambiguous → resolved with the
        // picker's default. Auto-pin per spec ("equivalent to checkout
        // + resume").
        await renderResolved(
          ctx,
          {
            kind: 'resolved',
            via: 'explicit-flag',
            artifactId: resolution.defaultCandidateId,
            lineageStale: false,
            shouldAutoPin: true,
          },
          opts,
          { wantJson }
        );
        return;
      }

      await renderResolved(ctx, resolution, opts, { wantJson });
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (err instanceof CliExit) throw err;
    if (wantJson) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

async function renderResolved(
  ctx: CliContext,
  resolved: ResolvedKind,
  opts: ResumeOptions,
  io: { wantJson: boolean }
): Promise<void> {
  if (resolved.shouldAutoPin && !opts.noPin) {
    const targets = await resolvePinTargets(ctx);
    if (targets.shellKey.kind !== 'none') {
      const row = ctx.store.store.getArtifact(resolved.artifactId);
      if (row) {
        await replacePin({
          ctx,
          artifactId: resolved.artifactId,
          branch: row.branch,
          pinnedAt: new Date().toISOString(),
          pinnedVia: 'explicit-checkout',
          targets,
        });
      }
    }
  }

  const result = await writeResume({
    store: ctx.store,
    artifactId: resolved.artifactId,
    redactSecrets: ctx.config.digest.redact_secrets,
  });
  // Imported artifacts are always summarized, so the default and pin paths
  // never resolve to one — but an explicit `resume --artifact <id>` can, and
  // imported prose never renders unlabeled.
  const originKind = ctx.store.store.getArtifact(resolved.artifactId)?.origin_kind ?? null;

  let copied = false;
  if (opts.copy) {
    copied = await copyToClipboard(result.data.agent_prompt);
  }

  // Repo-state context: non-mutating snapshot of the
  // surrounding repo (current branch / HEAD / dirty / commits since
  // artifact_head_sha / open_items addressed-since heuristic).
  const repoState = await buildRepoState({
    store: ctx.store,
    repo: ctx.repo,
    artifactId: resolved.artifactId,
  });

  // Drift nudge: stale install (skills/commands/block vs the running CLI).
  // Best-effort; null when fresh or agent=other.
  let drift: InstallDrift | null = null;
  try {
    drift = await detectInstallDrift(ctx.repoRoot, ctx.config, CLI_VERSION, ctx.gates);
  } catch {
    // best-effort: a drift-detection failure must never break resume output
  }

  if (io.wantJson) {
    // Top-level next_actions for the resumed artifact — same advisory
    // hint surface as status/capture (lazy ack-enrichment; never throws).
    const next_actions = await renderedNextActionsForArtifact(ctx, resolved.artifactId);
    // `artifact_id` and `plan_event_id` are surfaced at the top
    // level (alongside `.artifact`) so callers can pass them
    // directly into `capture checkpoint open`'s `plan_revision_id`
    // and the various `--artifact <id>` flags without diving into
    // the nested envelope. The same fields remain on `.artifact`
    // for envelope-shape consistency.
    emitOk({
      schema_version: 2,
      resolved: true,
      resolution_via: resolved.via,
      artifact_id: result.data.artifact_id,
      plan_event_id: result.data.plan_event_id,
      ...(resolved.restoredFromArchive ? { restored_from_archive: true } : {}),
      ...(resolved.reviewRestore ? { review_restore: resolved.reviewRestore } : {}),
      next_actions,
      ...(drift ? { drift } : {}),
      artifact: {
        ...resumeDataToArtifact(result.data, result.path, copied),
        origin: originKind,
        lineage_stale: resolved.lineageStale,
        lineage_branches: resolved.lineageBranches ?? null,
        repo_state: repoState,
      },
    });
    return;
  }

  if (resolved.lineageStale && resolved.lineageBranches) {
    writeTerminalSafeStdout(
      `Note: this artifact was matched by SHA reachability, not branch-name lineage. ` +
        `Recorded on: ${resolved.lineageBranches.join(', ')}. ` +
        `Run \`orcaops lineage\` to record the current branch in its lineage.\n\n`
    );
  }
  const repoStateNote = renderRepoStateNote(repoState);
  if (repoStateNote.length > 0) {
    writeTerminalSafeStdout(repoStateNote);
  }
  if (originKind === 'git-import') {
    writeTerminalSafeStdout(
      'origin: imported from git history (synthesized) — already summarized; ' +
        'resume targets live work.\n\n'
    );
  }
  writePipeFriendlyStdout(result.markdown);
  if (opts.copy) {
    const note = copied
      ? '(suggested prompt copied to clipboard)'
      : '(no clipboard available on this platform)';
    writeTerminalSafeStdout(`\n${note}\n`);
  }
  if (drift) writeTerminalSafeStderr(formatDriftNudge(drift) + '\n');
  if (resolved.reviewRestore?.status === 'failed') {
    writeTerminalSafeStderr(
      `Warning: the artifact restored successfully, but its archived review logs did not: ` +
        `${resolved.reviewRestore.error} Some earlier review logs may already have restored.\n`
    );
  }
}

function resumeDataToArtifact(
  data: ResumeData,
  cachedAt: string,
  copied: boolean
): Record<string, unknown> {
  return {
    artifact_id: data.artifact_id,
    branch: data.branch,
    task: data.task,
    started_at: data.started_at,
    is_complete: data.is_complete,
    plan_coverage_complete: data.plan_coverage_complete,
    revision_n: data.revision_n,
    plan_event_id: data.plan_event_id,
    checkpoint_count: data.checkpoint_count,
    last_checkpoint_head_sha: data.last_checkpoint_head_sha,
    steps: data.steps,
    // Prior reasoning surfaced for a resuming agent:
    // decisions are the WHY captured across closed cps; uncertainty
    // is the still-open questions. Both ride the paste-ready prompt too.
    decisions: data.decisions,
    open_uncertainty: data.open_uncertainty,
    open_items: data.open_items,
    // In-flight cps left open by the prior session and plan steps with
    // no claim from any closed cp / declaration from any open cp. The
    // skill body in `orcaops-resume.ts` promises both — they're how a
    // fresh agent decides between close / abandon / new cp on uncovered.
    open_checkpoints: data.open_checkpoints,
    uncovered_step_ids: data.uncovered_step_ids,
    historic_completions: data.historic_completions,
    agent_prompt: data.agent_prompt,
    cached_at: cachedAt,
    copied,
  };
}

async function emitResolvedEmpty(
  resolution: ResolvedEmpty,
  io: { wantJson: boolean },
  importedCount = 0
): Promise<void> {
  const payload = {
    schema_version: 2 as const,
    resolved: true as const,
    resolution_via: 'no-active-artifacts' as const,
    artifact: null,
    next_actions: [
      {
        verb: 'capture-plan' as const,
        command: 'orcaops capture plan --input -',
        effect: 'start a new task on this branch',
      },
    ],
    ...(importedCount > 0
      ? { imported_artifacts: importedArtifactsDisclosure(importedCount) }
      : {}),
  };
  if (io.wantJson) {
    emitOk(payload);
    return;
  }
  writeTerminalSafeStdout(
    `No in-flight artifacts on branch "${resolution.branch}".\n` +
      (importedCount > 0 ? `${importedTrailerLine(importedCount)}\n` : '') +
      `Run \`orcaops capture plan ...\` to start a new task.\n`
  );
}

async function emitPicker(resolution: AmbiguousKind, io: { wantJson: boolean }): Promise<void> {
  const payload = {
    schema_version: 2 as const,
    resolved: false as const,
    reason: 'multiple-active-no-pin' as const,
    shell_key: resolution.shellKey,
    candidates: resolution.candidates,
    default_candidate_id: resolution.defaultCandidateId,
    default_rationale: 'most-recently-active' as const,
    next_actions: [
      {
        verb: 'checkout' as const,
        command: 'orcaops checkout <id>',
        effect: 'pin focus to <id> in this shell (persists)',
      },
      {
        verb: 'resume-once' as const,
        command: 'orcaops resume --artifact <id>',
        effect: 'resume <id> without setting a pin',
      },
      {
        verb: 'accept-default' as const,
        command: 'orcaops resume --accept-default',
        effect: 'use default_candidate_id; equivalent to checkout + resume',
      },
    ],
  };
  if (io.wantJson) {
    emitOk(payload);
    return;
  }
  const lines: string[] = [`Multiple in-flight artifacts on "${resolution.branch}". Pick one:`, ''];
  for (const c of resolution.candidates) {
    const isDefault = c.id === resolution.defaultCandidateId ? ' [default]' : '';
    lines.push(`  ${c.id}${isDefault}  ${c.task}`);
    lines.push(`    state=${c.state}  cp=${c.checkpoint_count}  last=${c.last_activity_at}`);
  }
  lines.push('');
  lines.push('  orcaops checkout <id>            — pin focus to <id> (persists)');
  lines.push('  orcaops resume --artifact <id>  — resume <id> without setting a pin');
  lines.push('  orcaops resume --accept-default  — pin + resume the default');
  writeTerminalSafeStdout(lines.join('\n') + '\n');
}

async function resolveResume(ctx: CliContext, opts: ResumeOptions): Promise<ResolveResult> {
  // 1. Explicit --artifact takes precedence (resume-once; no auto-pin).
  if (opts.artifact) {
    let row = ctx.store.store.getArtifact(opts.artifact);
    let restoredFromArchive = false;
    let reviewRestore: ReviewRestoreOutcome | undefined;
    // Cold-start fallback — when the hot store lacks the
    // artifact and the archive is enabled, restore it (the handoff
    // mechanic: any worktree of the project can pick up archived work).
    if (!row && ctx.archive) {
      try {
        await restoreArtifactFromArchive({
          repoRoot: ctx.repoRoot,
          config: ctx.config,
          store: ctx.store,
          projectDir: ctx.archive.projectDir,
          artifactId: opts.artifact,
          archiveLock: ctx.archive,
        });
        row = ctx.store.store.getArtifact(opts.artifact);
        restoredFromArchive = row !== null;
        if (restoredFromArchive) {
          reviewRestore = await restoreCompanionReviewLogs(ctx);
        }
      } catch (err) {
        if (err instanceof ArchiveRestoreDivergenceError) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, err.message, 'artifact');
        }
        // Not in the archive either — fall through to UNKNOWN_ARTIFACT.
      }
    }
    if (!row) {
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifact with id "${opts.artifact}"` +
          (ctx.config.archive.enabled
            ? " in the hot store or this project's archive."
            : ". (The home-dir archive is disabled; if this artifact lives in another worktree's history, enable `archive.enabled` there and run `orcaops archive repair`.)")
      );
    }
    return {
      kind: 'resolved',
      via: 'explicit-flag',
      artifactId: opts.artifact,
      lineageStale: false,
      shouldAutoPin: false,
      ...(restoredFromArchive ? { restoredFromArchive: true } : {}),
      ...(reviewRestore ? { reviewRestore } : {}),
    };
  }

  const branch = opts.branch ?? (await ctx.repo.getCurrentBranch());

  // 2. Pin lookup: highest precedence below explicit-flag. Pin overrides
  // branch — the spec's "loadable" check is just "row exists", not
  // "row's lineage includes current branch".
  const pinResolution = await resolveByPin(ctx);
  if (pinResolution) {
    return {
      kind: 'resolved',
      via: 'pin',
      artifactId: pinResolution.artifactId,
      lineageStale: false,
      shouldAutoPin: false,
      ...(pinResolution.restoredFromArchive ? { restoredFromArchive: true } : {}),
      ...(pinResolution.reviewRestore ? { reviewRestore: pinResolution.reviewRestore } : {}),
    };
  }

  // 3. Branch-active filter (planned/active/blocked, not summarized).
  const inFlight = await loadInFlightOnBranch(ctx, branch);
  if (inFlight.length === 0) {
    return await resolveViaFallback(ctx, branch);
  }
  if (inFlight.length === 1) {
    return {
      kind: 'resolved',
      via: 'single-active',
      artifactId: inFlight[0].row.id,
      lineageStale: false,
      shouldAutoPin: false,
    };
  }
  // Ambiguous picker. Default = most-recently-active.
  const sorted = [...inFlight].sort((a, b) => b.row.started_at.localeCompare(a.row.started_at));
  const candidates = await Promise.all(sorted.map(async (a) => buildCandidate(ctx, a.row, a.json)));
  const defaultId = pickDefaultCandidateId(candidates);
  return {
    kind: 'ambiguous',
    branch,
    shellKey: resolveShellKey({ env: getInvocationEnv() }),
    candidates,
    defaultCandidateId: defaultId,
  };
}

async function resolveByPin(ctx: CliContext): Promise<{
  artifactId: string;
  restoredFromArchive: boolean;
  reviewRestore?: ReviewRestoreOutcome;
} | null> {
  const targets = await resolvePinTargetsForRead(ctx);
  if (targets.shellKey.kind === 'none' || targets.repoId === null) return null;
  const existing = await readPin({
    repoId: targets.repoId,
    key: targets.shellKey,
    env: getInvocationEnv(),
  });
  if (existing === null) return null;
  return withPinFileLock(
    { repoId: targets.repoId, key: targets.shellKey, env: getInvocationEnv() },
    async (pinFile) => {
      const pin = await pinFile.read();
      if (!pin) return null;
      // Keep the pin locked through archive restoration so GC cannot classify
      // and delete the association while resume is materializing its target.
      let row = ctx.store.store.getArtifact(pin.artifact_id);
      let restoredFromArchive = false;
      let reviewRestore: ReviewRestoreOutcome | undefined;
      if (!row && ctx.archive) {
        const availability = await inspectArchivedArtifactAvailability(
          ctx.archive.projectDir,
          pin.artifact_id
        );
        if (availability.kind === 'uncertain') {
          throw pinResolutionFailure(pin.artifact_id, availability.reason);
        }
        if (availability.kind === 'in_flight') {
          try {
            await restoreArtifactFromArchive({
              repoRoot: ctx.repoRoot,
              config: ctx.config,
              store: ctx.store,
              projectDir: ctx.archive.projectDir,
              artifactId: pin.artifact_id,
              requireInFlight: true,
              archiveLock: ctx.archive,
            });
            row = ctx.store.store.getArtifact(pin.artifact_id);
            restoredFromArchive = row !== null;
            if (restoredFromArchive) {
              reviewRestore = await restoreCompanionReviewLogs(ctx);
            }
          } catch (error) {
            if (error instanceof ArchiveRestoreNotInFlightError) return null;
            throw pinResolutionFailure(
              pin.artifact_id,
              error instanceof Error ? error.message : String(error)
            );
          }
          if (!row) {
            throw pinResolutionFailure(
              pin.artifact_id,
              'the archive restore completed without reconstructing the pinned artifact'
            );
          }
        }
      }
      if (!row) return null;
      const artifactJson = await ctx.store.readArtifact(pin.artifact_id);
      if (artifactJson?.state === 'summarized') return null;
      return {
        artifactId: pin.artifact_id,
        restoredFromArchive,
        ...(reviewRestore ? { reviewRestore } : {}),
      };
    }
  );
}

async function restoreCompanionReviewLogs(ctx: CliContext): Promise<ReviewRestoreOutcome> {
  if (!ctx.archive) return { status: 'ok', lines_copied: 0 };
  const lock = new ArtifactLock({
    locksDir: reviewLocksDir(ctx.repoRoot),
    containmentRoot: ctx.repoRoot,
    heartbeatIntervalMs: 30_000,
  });
  try {
    const restored = await restoreReviewLogsFromArchive({
      repoRoot: ctx.repoRoot,
      projectDir: ctx.archive.projectDir,
      reviewStateVersion: REVIEW_STATE_VERSION,
      archiveLock: ctx.archive,
      withHotReviewLocks: (slug, fn) =>
        lock.withLock(reviewFloorLockKey(slug), () => lock.withLock(slug, fn)),
      validateReviewLogs: validateReviewLogFiles,
    });
    return { status: 'ok', lines_copied: restored.lines_copied };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      progress: 'possibly_partial',
    };
  }
}

function pinResolutionFailure(artifactId: string, reason: string): OrcaopsError {
  return new OrcaopsError(
    ErrorCodes.PIN_RESOLUTION_FAILED,
    `Pinned artifact ${artifactId} could not be resolved safely from the archive: ${reason}. ` +
      'The pin was retained; run `orcaops archive repair` from the worktree that owns the ' +
      'artifact, or `orcaops archive prune --artifact <id>` if none still does, before retrying.'
  );
}

async function resolveViaFallback(ctx: CliContext, branch: string): Promise<ResolveResult> {
  const headSha = await ctx.repo.getHeadSha();
  const allLineage = ctx.store.store.db
    .prepare(`SELECT artifact_id, latest_lineage_sha FROM lineage_by_latest_sha`)
    .all() as Array<{ artifact_id: string; latest_lineage_sha: string }>;

  const reachable: Array<{
    row: ArtifactRow;
    json: ArtifactJson;
    lineageBranches: string[];
  }> = [];
  for (const r of allLineage) {
    if (!(await ctx.repo.isAncestor(r.latest_lineage_sha, headSha))) continue;
    const row = ctx.store.store.getArtifact(r.artifact_id);
    if (!row) continue;
    const json = await ctx.store.readArtifact(r.artifact_id);
    if (!json) continue;
    if (json.state === 'summarized') continue;
    const branchRows = ctx.store.store.db
      .prepare(`SELECT branch_name FROM lineage_branches WHERE artifact_id = ?`)
      .all(r.artifact_id) as Array<{ branch_name: string }>;
    reachable.push({ row, json, lineageBranches: branchRows.map((b) => b.branch_name) });
  }

  if (reachable.length === 0) return { kind: 'resolved-empty', branch };
  reachable.sort((a, b) => b.row.started_at.localeCompare(a.row.started_at));
  if (reachable.length === 1) {
    const r = reachable[0];
    return {
      kind: 'resolved',
      via: 'single-active',
      artifactId: r.row.id,
      lineageStale: true,
      lineageBranches: r.lineageBranches,
      shouldAutoPin: false,
    };
  }
  // Ambiguous via fallback. Surface the same picker shape; lineage
  // branches per candidate live inside each candidate's branch field
  // (the recorded one, not the current one).
  const candidates = await Promise.all(
    reachable.map(async (r) => buildCandidate(ctx, r.row, r.json))
  );
  return {
    kind: 'ambiguous',
    branch,
    shellKey: resolveShellKey({ env: getInvocationEnv() }),
    candidates,
    defaultCandidateId: pickDefaultCandidateId(candidates),
  };
}

async function buildCandidate(
  ctx: CliContext,
  row: ArtifactRow,
  json: ArtifactJson
): Promise<PickerCandidate> {
  const checkpoints = await ctx.store.readCheckpoints(row.id);
  const filesUnion = new Set<string>();
  for (const cp of checkpoints) {
    if (cp.status !== 'closed') continue;
    for (const f of cp.files_changed) filesUnion.add(f);
  }
  return {
    id: row.id,
    label: deriveLabel(row),
    task: row.task,
    branch: row.branch,
    started_at: row.started_at,
    last_activity_at: json.updated_at,
    state: json.state,
    checkpoint_count: json.checkpoint_count,
    created_by_session_id: json.created_by_session_id,
    files_touched_recently: [...filesUnion].slice(0, 10),
    summary_excerpt: null,
  };
}

function pickDefaultCandidateId(candidates: PickerCandidate[]): string {
  // Most-recently-active = highest last_activity_at. Tie-break on id
  // for determinism.
  const sorted = [...candidates].sort((a, b) => {
    const t = b.last_activity_at.localeCompare(a.last_activity_at);
    return t !== 0 ? t : b.id.localeCompare(a.id);
  });
  return sorted[0].id;
}

/**
 * Surface the most-actionable repo-state signals as a short human
 * note above the resume markdown. Stays silent when nothing changed
 * since the artifact's recorded head and the working tree is clean.
 */
function renderRepoStateNote(state: RepoState | null): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.working_tree_dirty) {
    lines.push('Working tree is dirty.');
  }
  if (!state.head_matches_artifact && state.artifact_head_sha) {
    const ahead = state.commits_since_artifact_head_touching_artifact_files.length;
    if (ahead > 0) {
      lines.push(
        `${ahead} commit(s) since artifact_head_sha touch this artifact's files; ` +
          `your work may already be partly done.`
      );
    } else {
      lines.push(
        `HEAD has moved since this artifact's last recorded head (no overlap with artifact files).`
      );
    }
  }
  if (state.open_items_addressed_since.length > 0) {
    lines.push(
      `${state.open_items_addressed_since.length} open item(s) may already be addressed — ` +
        `see repo_state.open_items_addressed_since.`
    );
  }
  return lines.length > 0 ? `Repo state: ${lines.join(' ')}\n\n` : '';
}

async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : process.platform === 'linux'
        ? [
            { cmd: 'xclip', args: ['-selection', 'clipboard'] },
            { cmd: 'xsel', args: ['--clipboard', '--input'] },
            { cmd: 'wl-copy', args: [] },
          ]
        : [];

  for (const c of candidates) {
    if (await trySpawnWithStdin(c.cmd, c.args, text)) return true;
  }
  return false;
}

function trySpawnWithStdin(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(text);
  });
}
