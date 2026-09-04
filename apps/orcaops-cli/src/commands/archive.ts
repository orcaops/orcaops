import { access, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { Repo, resolveConfigSource, scrubError } from '@orcaops/core';
import {
  archiveArtifactPaths,
  archiveProjectDir,
  type ArchiveRepairIssue,
  archiveRoot,
  artifactPathsFor,
  type ArtifactSourceInspection,
  assertResolvedWithin,
  computeMirrorLag,
  dropProjectIndex,
  indexRoot,
  inspectArtifactSources,
  isUuidV7,
  type MirrorLagReport,
  probeHotState,
  readEventLog,
  replaceHotArtifactFromArchive,
  replayMissingEvents,
  usageBlockedMissing,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { displayConfigPath, openEffectiveConfig, writeConfigDocument } from '../lib/config-file.js';
import { buildContext, type CliContext } from '../lib/context.js';
import { getInvocationEnv } from '../lib/invocation-context.js';
import { ensureProjectId, ProjectIdentityError, readProjectId } from '../lib/project-identity.js';
import { withRepositoryInstallLock } from '../lib/repository-install-lock.js';

/**
 * `orcaops archive status|repair`. Status is pure read;
 * repair appends a true missing tail through the normal mirror transform and
 * canonically rebuilds prefix/interior gaps while retaining the prior copy.
 * It also doubles as the first-enable backfill. `archive prune` is the ONLY
 * deletion path for archived history.
 */

export interface ArchiveStatusOptions {
  json?: boolean;
}

interface ArchiveSurvey {
  ctx: CliContext;
  projectId: string;
  dataRoot: string;
  projectDir: string;
  report: MirrorLagReport;
  permsOk: boolean | null;
}

async function surveyArchive(ctx: CliContext): Promise<ArchiveSurvey> {
  let projectId: string | null;
  try {
    projectId = await readProjectId(ctx.repo);
  } catch (error) {
    if (error instanceof ProjectIdentityError) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message);
    }
    throw error;
  }
  if (!projectId) {
    // buildContext mints on every archive-enabled invocation, so a missing
    // id here means archive wiring failed fail-open moments ago.
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'No project identity resolved — archive wiring failed for this invocation (see stderr).'
    );
  }
  const dataRoot = archiveRoot(getInvocationEnv());
  const projectDir = archiveProjectDir(dataRoot, projectId);
  const report = await computeMirrorLag({
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    projectDir,
  });
  return {
    ctx,
    projectId,
    dataRoot,
    projectDir,
    report,
    permsOk: await checkPerms([dataRoot, projectDir]),
  };
}

/** True when no surveyed dir is group/other-accessible; null on win32 / no dirs yet. */
async function checkPerms(dirs: string[]): Promise<boolean | null> {
  if (process.platform === 'win32') return null;
  let sawAny = false;
  for (const dir of dirs) {
    let mode: number;
    try {
      mode = (await stat(dir)).mode;
    } catch {
      continue; // not created yet — nothing to grade
    }
    sawAny = true;
    if ((mode & 0o077) !== 0) return false;
  }
  return sawAny ? true : null;
}

async function effectiveConfigDisplayPath(ctx: CliContext): Promise<string> {
  return displayConfigPath(await resolveConfigSource(ctx.repoRoot), ctx.repoRoot);
}

async function requireEnabled(ctx: CliContext): Promise<void> {
  if (!ctx.config.archive.enabled) {
    const configPath = await effectiveConfigDisplayPath(ctx);
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Archive is disabled (\`archive.enabled: false\` in ${configPath}). ` +
        'Enable it, then re-run.'
    );
  }
}

export async function archiveStatusAction(opts: ArchiveStatusOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      if (!ctx.config.archive.enabled) {
        const configPath = await effectiveConfigDisplayPath(ctx);
        const payload = {
          enabled: false,
          note: `Archive is disabled; nothing is being mirrored. Set \`archive.enabled: true\` in ${configPath} to opt in.`,
        };
        if (opts.json) {
          emitOk(payload);
        } else {
          writeTerminalSafeStdout(`orcaops archive — disabled\n${payload.note}\n`);
        }
        return;
      }
      const s = await surveyArchive(ctx);
      const lagging = s.report.artifacts.filter((a) => a.repair_mode !== 'complete');
      const rebuilding = s.report.artifacts_requiring_rebuild;
      const corrupt = s.report.artifacts.reduce((n, a) => n + a.archive_corrupt_lines, 0);
      const needsRepair =
        s.report.repairable_missing > 0 || s.report.artifacts_requiring_rebuild > 0;
      const usageBlocked = usageBlockedMissing(s.report);
      const hint = archiveStatusHint(s.report);
      const artifacts = await Promise.all(
        s.report.artifacts.map(async (artifact) => {
          if (artifact.repair_mode !== 'blocked') return artifact;
          const sourceState = await inspectArtifactSources({
            repoRoot: ctx.repoRoot,
            config: ctx.config,
            projectDir: s.projectDir,
            artifactId: artifact.artifact_id,
          });
          return {
            ...artifact,
            source_state: sourceState,
            resolution_commands: archiveResolutionCommands(artifact.artifact_id, sourceState),
          };
        })
      );
      if (opts.json) {
        emitOk({
          enabled: true,
          project_id: s.projectId,
          data_root: s.dataRoot,
          project_dir: s.projectDir,
          redact_secrets: ctx.config.archive.redact_secrets,
          artifacts,
          usage: s.report.usage,
          total_missing: s.report.total_missing,
          repairable_missing: s.report.repairable_missing,
          blocked_missing: s.report.blocked_missing,
          usage_blocked_missing: s.report.usage_blocked_missing,
          blocked_artifacts: s.report.blocked_artifacts,
          artifacts_requiring_rebuild: rebuilding,
          archive_corrupt_lines: corrupt,
          perms_ok: s.permsOk,
          ...(hint === null ? {} : { hint }),
        });
        return;
      }
      const lines: string[] = [];
      lines.push(`orcaops archive — project ${s.projectId}`);
      lines.push(`  data root:   ${s.dataRoot}`);
      lines.push(`  artifacts:   ${s.report.artifacts.length} hot, ${lagging.length} lagging`);
      lines.push(
        `  usage:       ${s.report.usage.hot_events} hot events, ` +
          `${s.report.usage.missing_event_ids.length} missing`
      );
      if (usageBlocked > 0) {
        lines.push(
          `  quarantine:  ${usageBlocked} invalid usage event(s) retained in the hot source; ` +
            'they remain without archive-readable content and do not block archive activation'
        );
      }
      lines.push(`  missing:     ${s.report.total_missing} event(s) total`);
      lines.push(`  repairable:  ${s.report.repairable_missing} missing event(s)`);
      lines.push(
        `  blocked:     ${s.report.blocked_artifacts} artifact(s), ` +
          `${s.report.blocked_missing} missing event(s)`
      );
      lines.push(`  rebuilds:    ${rebuilding} artifact(s)`);
      for (const artifact of artifacts) {
        if (artifact.repair_mode !== 'blocked') continue;
        const resolutionCommands =
          'resolution_commands' in artifact ? artifact.resolution_commands : [];
        lines.push(
          `    ${artifact.artifact_id}: ${artifact.block_reason ?? 'blocked'} — ` +
            `${artifact.block_message ?? 'automatic repair is unavailable'}`
        );
        for (const command of resolutionCommands) {
          lines.push(`      ${command}`);
        }
        if (resolutionCommands.length === 0) {
          lines.push('      no automated resolution: neither source strictly reconstructs');
        }
      }
      if (corrupt > 0)
        lines.push(
          `  corrupt:     ${corrupt} archive line(s) — surfaced; prior copies retained on rebuild`
        );
      if (s.permsOk === false) lines.push(`  perms:       LOOSE — run chmod 700 on the dirs above`);
      if (needsRepair) {
        lines.push('');
        lines.push('Run `orcaops archive repair` to backfill and rebuild non-tail gaps.');
      }
      if (s.report.blocked_artifacts > 0) {
        lines.push('');
        lines.push(
          'Automatic repair is blocked. Run `orcaops archive status --json` to inspect ' +
            'each artifact before choosing an explicit archive source.'
        );
      }
      lines.push('');
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

export interface BackfillArtifactIssue extends ArchiveRepairIssue {
  resolution_commands: string[];
}

export interface BackfillResult {
  projectId: string;
  missingBefore: number;
  replayedEvents: number;
  remainingMissing: number;
  blockedMissing: number;
  quarantinedUsageEvents: number;
  blockedArtifacts: number;
  complete: boolean;
  artifactIssues: BackfillArtifactIssue[];
  rebuiltArtifacts: Array<{ artifact_id: string; backup_path: string }>;
  remainingRebuilds: number;
  corruptLines: number;
}

/**
 * Shared enable/repair backfill: survey the archive and
 * repair every missing hot-store event into it. The
 * first-enable backfill and `archive repair` are the SAME operation —
 * extraction keeps them from drifting.
 */
async function runArchiveBackfill(ctx: CliContext): Promise<BackfillResult> {
  if (!ctx.archive) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Archive wiring failed for this invocation (see stderr); cannot backfill.'
    );
  }
  const s = await surveyArchive(ctx);
  const result = await replayMissingEvents({
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    projectDir: s.projectDir,
    mirror: ctx.archive,
  });
  const artifactIssues = await Promise.all(
    result.artifact_issues.map(async (issue) => {
      const sourceState = await inspectArtifactSources({
        repoRoot: ctx.repoRoot,
        config: ctx.config,
        projectDir: s.projectDir,
        artifactId: issue.artifact_id,
      });
      return {
        ...issue,
        resolution_commands: archiveResolutionCommands(issue.artifact_id, sourceState),
      };
    })
  );
  return {
    projectId: s.projectId,
    missingBefore: s.report.total_missing,
    replayedEvents: result.replayed_events,
    remainingMissing: result.remaining_missing,
    blockedMissing: result.blocked_missing,
    quarantinedUsageEvents: result.usage_blocked_missing,
    blockedArtifacts: result.blocked_artifacts,
    complete: result.complete,
    artifactIssues,
    rebuiltArtifacts: result.rebuilt_artifacts,
    remainingRebuilds: result.remaining_rebuilds,
    corruptLines: s.report.artifacts.reduce((n, a) => n + a.archive_corrupt_lines, 0),
  };
}

export interface ArchiveToggleOptions {
  json?: boolean;
}

export interface ArchiveActivationResult {
  alreadyEnabled: boolean;
  backfill: BackfillResult;
}

/**
 * Enable the raw config flag, rebuild the context with archive wiring, and
 * backfill. The flag is intentionally not rolled back if backfill is blocked
 * or fails: init/config mutations have already landed and future captures
 * should mirror while the operator resolves old history.
 */
async function activateArchiveAndBackfill(repoRoot?: string): Promise<ArchiveActivationResult> {
  let alreadyEnabled = false;
  let archiveFlagApplied = false;
  try {
    // Flipping the flag needs the config and the root, not a store: a
    // read-only context serves an untouched worktree from memory.
    const ctx = await buildContext({ root: repoRoot, mintArchiveIdentity: false });
    let resolvedRoot: string;
    let hotEmpty: boolean;
    try {
      alreadyEnabled = ctx.config.archive.enabled === true;
      await patchArchiveEnabled(ctx.repoRoot, true);
      archiveFlagApplied = true;
      resolvedRoot = ctx.repoRoot;
      hotEmpty = probeHotState(ctx.repoRoot, ctx.config).empty;
    } finally {
      ctx.store.close();
    }

    // Nothing captured here yet means nothing to replay. Mint the identity
    // (the archive keys on it) but open no store: the initializing worktree
    // follows the same lazy path as every sibling, creating its data
    // directories on the first write that has something to store.
    if (hotEmpty) {
      const { projectId } = await ensureProjectId(new Repo(resolvedRoot));
      return {
        alreadyEnabled,
        backfill: {
          projectId,
          missingBefore: 0,
          replayedEvents: 0,
          remainingMissing: 0,
          blockedMissing: 0,
          quarantinedUsageEvents: 0,
          blockedArtifacts: 0,
          complete: true,
          artifactIssues: [],
          rebuiltArtifacts: [],
          remainingRebuilds: 0,
          corruptLines: 0,
        },
      };
    }

    {
      const enabledCtx = await buildContext({ root: repoRoot });
      try {
        return { alreadyEnabled, backfill: await runArchiveBackfill(enabledCtx) };
      } finally {
        enabledCtx.store.close();
      }
    }
  } catch (error) {
    if (!archiveFlagApplied && error instanceof OrcaopsError) throw error;
    const timing = archiveFlagApplied ? ' after archive.enabled was applied' : '';
    throw new OrcaopsError(
      ErrorCodes.INTERNAL,
      `Archive activation failed${timing}: ${scrubError(errorMessage(error))}`
    );
  }
}

/**
 * Strict explicit activation: artifact content conflicts exit non-zero until
 * resolved. Invalid usage records are quarantined and reported, but do not
 * make safe automatic backfill permanently impossible.
 */
export async function enableArchiveAndBackfill(
  repoRoot?: string
): Promise<ArchiveActivationResult> {
  const activation = await activateArchiveAndBackfill(repoRoot);
  if (!activation.backfill.complete) {
    throw new OrcaopsError(
      ErrorCodes.ARCHIVE_INCOMPLETE,
      archiveIncompleteMessage(activation.backfill)
    );
  }
  return activation;
}

/**
 * Tolerant init activation: applied init work remains successful and the
 * incomplete backfill is returned for the init result + warnings.
 */
export async function enableArchiveAndBackfillForInit(
  repoRoot?: string
): Promise<ArchiveActivationResult> {
  return activateArchiveAndBackfill(repoRoot);
}

/**
 * `orcaops archive enable`: flip `archive.enabled` via a raw
 * config.json edit (mutate ONLY that key — never serialize the resolved
 * Config), then run the first-enable backfill through the same
 * `replayMissingEvents` machinery `archive repair` uses. Idempotent:
 * re-enabling reports `already_enabled`; true tails append, while non-tail
 * gaps are rebuilt with a retained backup.
 */
export async function archiveEnableAction(opts: ArchiveToggleOptions = {}): Promise<void> {
  try {
    const { alreadyEnabled, backfill } = await enableArchiveAndBackfill();
    if (opts.json) {
      emitOk({
        enabled: true,
        already_enabled: alreadyEnabled,
        project_id: backfill.projectId,
        missing_before: backfill.missingBefore,
        replayed_events: backfill.replayedEvents,
        remaining_missing: backfill.remainingMissing,
        blocked_missing: backfill.blockedMissing,
        usage_blocked_missing: backfill.quarantinedUsageEvents,
        blocked_artifacts: backfill.blockedArtifacts,
        complete: backfill.complete,
        artifact_issues: backfill.artifactIssues,
        rebuilt_artifacts: backfill.rebuiltArtifacts,
        remaining_rebuilds: backfill.remainingRebuilds,
        archive_corrupt_lines: backfill.corruptLines,
      });
      return;
    }
    const lines: string[] = [];
    lines.push(
      alreadyEnabled
        ? 'Archive already enabled — backfill re-checked.'
        : 'Archive enabled — captured history now mirrors to the home-dir archive.'
    );
    lines.push(`  project:  ${backfill.projectId}`);
    lines.push(
      `  backfill: ${backfill.replayedEvents} event(s) replayed, ${backfill.remainingMissing} remaining`
    );
    lines.push(
      `  blocked:  ${backfill.blockedArtifacts} artifact(s), ` +
        `${backfill.blockedMissing} missing event(s)`
    );
    if (backfill.quarantinedUsageEvents > 0) {
      lines.push(
        `  quarantine: ${backfill.quarantinedUsageEvents} invalid usage event(s) remain in ` +
          'the hot ledger without archive-readable content and do not block archive activation'
      );
    }
    lines.push(
      `  rebuild:  ${backfill.rebuiltArtifacts.length} artifact(s), ` +
        `${backfill.remainingRebuilds} remaining`
    );
    lines.push('');
    writeTerminalSafeStdout(lines.join('\n'));
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * `orcaops archive disable`: flip the flag off via the same
 * raw edit. Deliberately leaves ALL archived data in place — `archive
 * prune` stays the only deletion path.
 */
export async function archiveDisableAction(opts: ArchiveToggleOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      const alreadyDisabled = ctx.config.archive.enabled !== true;
      await patchArchiveEnabled(ctx.repoRoot, false);
      if (opts.json) {
        emitOk({
          enabled: false,
          already_disabled: alreadyDisabled,
          note: 'Archived data is retained; `orcaops archive prune` is the only deletion path.',
        });
        return;
      }
      writeTerminalSafeStdout(
        'Archive disabled — mirroring stops; existing archived data is retained ' +
          '(`orcaops archive prune` is the only deletion path).\n'
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/** Raw config.json edit: mutate ONLY archive.enabled, atomic write. */
async function patchArchiveEnabled(repoRoot: string, enabled: boolean): Promise<void> {
  const commonDir = await new Repo(repoRoot).getCommonDirAbsolute();
  await withRepositoryInstallLock(commonDir, async (installLease) => {
    const document = await openEffectiveConfig(repoRoot);
    const archive = (document.raw.archive ?? {}) as Record<string, unknown>;
    document.raw.archive = { ...archive, enabled };
    await installLease.verify();
    await writeConfigDocument(document);
  });
}

export interface ArchiveRepairOptions {
  json?: boolean;
}

export async function archiveRepairAction(opts: ArchiveRepairOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      await requireEnabled(ctx);
      const backfill = await runArchiveBackfill(ctx);
      if (opts.json) {
        emitOk({
          project_id: backfill.projectId,
          missing_before: backfill.missingBefore,
          replayed_events: backfill.replayedEvents,
          remaining_missing: backfill.remainingMissing,
          blocked_missing: backfill.blockedMissing,
          usage_blocked_missing: backfill.quarantinedUsageEvents,
          blocked_artifacts: backfill.blockedArtifacts,
          complete: backfill.complete,
          artifact_issues: backfill.artifactIssues,
          rebuilt_artifacts: backfill.rebuiltArtifacts,
          remaining_rebuilds: backfill.remainingRebuilds,
          archive_corrupt_lines: backfill.corruptLines,
        });
        return;
      }
      const lines: string[] = [];
      lines.push(`orcaops archive repair — project ${backfill.projectId}`);
      lines.push(`  missing before: ${backfill.missingBefore}`);
      lines.push(`  replayed:       ${backfill.replayedEvents}`);
      lines.push(`  remaining:      ${backfill.remainingMissing}`);
      lines.push(`  complete:       ${backfill.complete ? 'yes' : 'no'}`);
      lines.push(
        `  blocked:        ${backfill.blockedArtifacts} artifact(s), ` +
          `${backfill.blockedMissing} missing event(s)`
      );
      if (backfill.quarantinedUsageEvents > 0) {
        lines.push(
          `  quarantine:     ${backfill.quarantinedUsageEvents} invalid usage event(s) remain ` +
            'in the hot ledger without archive-readable content and do not block archive activation'
        );
      }
      lines.push(`  rebuilt:        ${backfill.rebuiltArtifacts.length}`);
      lines.push(`  rebuilds left:  ${backfill.remainingRebuilds}`);
      for (const rebuilt of backfill.rebuiltArtifacts) {
        lines.push(`    ${rebuilt.artifact_id} (backup: ${rebuilt.backup_path})`);
      }
      for (const issue of backfill.artifactIssues) {
        lines.push(`    ${issue.artifact_id}: ${issue.kind} — ${issue.message}`);
      }
      if (backfill.corruptLines > 0) {
        lines.push(
          `  corrupt:        ${backfill.corruptLines} archive line(s) surfaced ` +
            '(prior copies retained on rebuild)'
        );
      }
      lines.push('');
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

export type ArchiveResolveSource = 'archive' | 'hot';

export interface ArchiveResolveOptions {
  artifact: string;
  source: ArchiveResolveSource;
  apply?: boolean;
  json?: boolean;
}

export async function archiveResolveAction(opts: ArchiveResolveOptions): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      await requireEnabled(ctx);
      const survey = await surveyArchive(ctx);
      const sourceState = await inspectArtifactSources({
        repoRoot: ctx.repoRoot,
        config: ctx.config,
        projectDir: survey.projectDir,
        artifactId: opts.artifact,
      });
      const selected = sourceState[opts.source];
      if (!selected.valid) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Cannot resolve artifact ${opts.artifact} from ${opts.source}: ` +
            `${selected.error ?? 'the selected source is invalid'}. Nothing was changed.`
        );
      }

      const baseResult = {
        artifact_id: opts.artifact,
        source: opts.source,
        applied: opts.apply === true,
        source_state: sourceState,
        resolution_commands: archiveResolutionCommands(opts.artifact, sourceState),
      };
      if (opts.apply !== true) {
        if (opts.json) {
          emitOk({
            ...baseResult,
            applied: false,
            backup_path: null,
            note: 'Dry run only; pass --apply to replace the non-selected copy.',
          });
          return;
        }
        writeTerminalSafeStdout(formatArchiveResolveDryRun(baseResult));
        return;
      }

      if (opts.source === 'archive') {
        const result = await replaceHotArtifactFromArchive({
          repoRoot: ctx.repoRoot,
          config: ctx.config,
          store: ctx.store,
          projectDir: survey.projectDir,
          artifactId: opts.artifact,
          expectedHotEventIds: sourceState.hot.event_ids,
          expectedHotCorruptLines: sourceState.hot.corrupt_lines,
          expectedArchiveEventIds: sourceState.archive.event_ids,
        });
        const payload = { ...baseResult, ...result };
        if (opts.json) {
          emitOk(payload);
          return;
        }
        writeTerminalSafeStdout(formatArchiveResolveApplied(payload));
        return;
      }

      if (!ctx.archive) {
        throw new OrcaopsError(
          ErrorCodes.INTERNAL,
          'Archive wiring is unavailable; the hot source was not applied.'
        );
      }
      const archiveMirror = ctx.archive;
      const hotPaths = artifactPathsFor(ctx.repoRoot, ctx.config, opts.artifact);
      const archivePaths = archiveArtifactPaths(survey.projectDir, opts.artifact);
      const applied = await ctx.store.withArtifactLock(opts.artifact, async () => {
        const hot = await readEventLog({
          eventLogPath: hotPaths.eventsNdjson,
          sidecarsDir: hotPaths.sidecarsDir,
          containmentRoot: ctx.repoRoot,
        });
        const archived = await readEventLog({
          eventLogPath: archivePaths.eventsNdjson,
          sidecarsDir: archivePaths.sidecarsDir,
        });
        if (
          hot.corrupt.length !== sourceState.hot.corrupt_lines ||
          archived.corrupt.length !== sourceState.archive.corrupt_lines ||
          !sameStrings(
            hot.events.map((event) => event.event_id),
            sourceState.hot.event_ids
          ) ||
          !sameStrings(
            archived.events.map((event) => event.event_id),
            sourceState.archive.event_ids
          )
        ) {
          throw new OrcaopsError(
            ErrorCodes.INVALID_INPUT,
            `Artifact ${opts.artifact} changed after the dry-run state was observed; ` +
              'nothing was replaced. Re-run `orcaops archive resolve`.'
          );
        }
        const result = await archiveMirror.rebuildArtifactFromHot(
          opts.artifact,
          hot.events,
          hotPaths.sidecarsDir,
          ctx.repoRoot,
          archived.events.map((event) => event.event_id),
          archived.corrupt.length
        );
        return {
          events_installed: hot.events.length,
          backup_path: result.backupPath,
          indexed: true,
        };
      });
      const payload = { ...baseResult, ...applied };
      if (opts.json) {
        emitOk(payload);
        return;
      }
      writeTerminalSafeStdout(formatArchiveResolveApplied(payload));
    } finally {
      ctx.store.close();
    }
  } catch (error) {
    const normalized =
      error instanceof OrcaopsError ||
      !(error instanceof Error) ||
      !('code' in error) ||
      typeof (error as { code?: unknown }).code !== 'string' ||
      !(error as { code: string }).code.startsWith('ARCHIVE_RESTORE_')
        ? error
        : new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message);
    if (opts.json) emitError(normalized);
    writeErrorLine(normalized);
    throw new CliExit(1);
  }
}

function archiveStatusHint(report: MirrorLagReport): string | null {
  const parts: string[] = [];
  if (report.repairable_missing > 0 || report.artifacts_requiring_rebuild > 0) {
    parts.push('Run `orcaops archive repair` to backfill and rebuild safe non-tail gaps.');
  }
  if (report.blocked_artifacts > 0) {
    parts.push(
      'Automatic repair is blocked for at least one artifact; inspect `artifacts[]` and ' +
        'choose an explicit source with `orcaops archive resolve`.'
    );
  }
  const usageBlocked = usageBlockedMissing(report);
  if (usageBlocked > 0) {
    parts.push(
      `${usageBlocked} invalid usage event(s) remain quarantined in the hot ledger ` +
        'without archive-readable content and do not block archive activation.'
    );
  }
  return parts.length === 0 ? null : parts.join(' ');
}

export function archiveResolutionCommands(
  artifactId: string,
  sources: ArtifactSourceInspection
): string[] {
  const commands: string[] = [];
  if (sources.archive.valid) {
    commands.push(`orcaops archive resolve --artifact ${artifactId} --source archive --apply`);
  }
  if (sources.hot.valid) {
    commands.push(`orcaops archive resolve --artifact ${artifactId} --source hot --apply`);
  }
  return commands;
}

function formatArchiveResolveDryRun(result: {
  artifact_id: string;
  source: ArchiveResolveSource;
  source_state: ArtifactSourceInspection;
}): string {
  const selected = result.source_state[result.source];
  return (
    `orcaops archive resolve — DRY RUN\n` +
    `  artifact: ${result.artifact_id}\n` +
    `  source:   ${result.source} (${selected.event_ids.length} event(s), valid)\n` +
    `  action:   replace ${result.source === 'archive' ? 'hot' : 'archive'} and retain its backup\n` +
    `\nPass --apply to perform this replacement.\n`
  );
}

function formatArchiveResolveApplied(result: {
  artifact_id: string;
  source: ArchiveResolveSource;
  events_installed: number;
  backup_path: string;
}): string {
  return (
    `orcaops archive resolve — applied\n` +
    `  artifact:  ${result.artifact_id}\n` +
    `  source:    ${result.source}\n` +
    `  installed: ${result.events_installed} event(s)\n` +
    `  backup:    ${result.backup_path}\n`
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function archiveIncompleteMessage(backfill: BackfillResult): string {
  const quarantine =
    backfill.quarantinedUsageEvents === 0
      ? ''
      : ` ${backfill.quarantinedUsageEvents} invalid usage event(s) remain quarantined and ` +
        'do not block activation.';
  return (
    `Archive is enabled, but activation is incomplete: ` +
    `${backfill.remainingMissing} repairable event(s) remain, ` +
    `${backfill.remainingRebuilds} artifact(s) still require rebuild, and ` +
    `${backfill.blockedArtifacts} artifact(s) are content-blocked.` +
    quarantine +
    ' ' +
    'Run `orcaops archive status --json`; use `orcaops archive repair` for repairable ' +
    'lag and `orcaops archive resolve` for blocked conflicts.'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ARCHIVE_PRUNE_WARNING =
  'WARNING: archive prune permanently deletes captured history from the home-dir archive. ' +
  'This is the ONLY deletion path — orcaops never deletes archive data without it.';

export interface ArchivePruneOptions {
  /** Delete one project's entire archive dir. */
  project?: string;
  /** Delete one artifact's archive dir (searched across projects). */
  artifact?: string;
  /** Actually delete. Default is dry-run. */
  apply?: boolean;
  json?: boolean;
}

/**
 * `orcaops archive prune --project <id> | --artifact <id> [--apply]` —
 * the ONLY archive deletion path (keep-forever otherwise). Clones the
 * `snapshots prune` UX: exactly-one-of selector, dry-run default, the
 * warning on EVERY output. Runs from anywhere (no repo context needed —
 * the archive is global state). A path-containment assertion guards
 * every removal, and the pruned project's disposable index is dropped.
 */
export async function archivePruneAction(opts: ArchivePruneOptions = {}): Promise<void> {
  try {
    const selected = [
      ...(opts.project !== undefined ? (['project'] as const) : []),
      ...(opts.artifact !== undefined ? (['artifact'] as const) : []),
    ];
    if (selected.length !== 1) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Exactly one of --project <id> | --artifact <id> is required.',
        selected.length === 0 ? undefined : 'selector'
      );
    }
    const mode = selected[0];
    const env = getInvocationEnv();
    const dataRoot = path.resolve(archiveRoot(env));

    // Selectors are UUIDv7 by product contract (both ids are uuidv7-minted);
    // validating the SHAPE first means a traversal like `--artifact
    // ../../<victim>` is rejected before any path is built, and containment
    // below is per-target — a project strictly beneath <root>/projects/, an
    // artifact strictly beneath ITS project's artifacts/ — not merely
    // beneath the archive root (which a cross-project traversal satisfies).
    const assertSelectorId = (value: string, flag: string): string => {
      if (!isUuidV7(value)) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `${flag} must be a canonical UUIDv7 id; got ${JSON.stringify(value)}.`,
          mode
        );
      }
      return value;
    };
    const assertContainedIn = (target: string, root: string): string => {
      try {
        return assertResolvedWithin(target, root, mode);
      } catch (err) {
        throw new OrcaopsError(ErrorCodes.INVALID_INPUT, (err as Error).message, mode);
      }
    };

    interface Candidate {
      /** dataRoot-relative path — what --apply would delete. */
      path: string;
      project_id: string;
      artifacts: number;
    }
    const candidates: Candidate[] = [];
    const affectedProjects = new Set<string>();

    const projectsRoot = path.join(dataRoot, 'projects');
    if (mode === 'project') {
      const projectId = assertSelectorId(opts.project as string, '--project');
      const dir = assertContainedIn(archiveProjectDir(dataRoot, projectId), projectsRoot);
      if (await exists(dir)) {
        candidates.push({
          path: path.relative(dataRoot, dir),
          project_id: projectId,
          artifacts: await countDirEntries(path.join(dir, 'artifacts')),
        });
        affectedProjects.add(projectId);
      }
    } else {
      const artifactId = assertSelectorId(opts.artifact as string, '--artifact');
      for (const projectId of await listProjectDirs(dataRoot)) {
        const projectDir = archiveProjectDir(dataRoot, projectId);
        const dir = assertContainedIn(
          path.join(projectDir, 'artifacts', artifactId),
          path.join(projectDir, 'artifacts')
        );
        if (await exists(dir)) {
          candidates.push({
            path: path.relative(dataRoot, dir),
            project_id: projectId,
            artifacts: 1,
          });
          affectedProjects.add(projectId);
        }
      }
    }

    let deleted = 0;
    if (opts.apply === true && candidates.length > 0) {
      for (const c of candidates) {
        // Re-check at the deletion boundary: the target must still resolve
        // strictly beneath projects/ (symlink swaps between scan and rm are
        // caught here).
        await rm(assertContainedIn(path.join(dataRoot, c.path), projectsRoot), {
          recursive: true,
          force: true,
        });
        deleted += 1;
      }
      // The index is disposable by contract: drop it wholesale; the next
      // --all-projects query re-ingests what remains.
      for (const projectId of affectedProjects) {
        await dropProjectIndex(indexRoot(env), projectId);
      }
    }

    const applied = opts.apply === true;
    if (opts.json) {
      emitOk({ applied, mode, warning: ARCHIVE_PRUNE_WARNING, candidates, deleted });
      return;
    }
    const lines: string[] = [];
    lines.push(
      applied
        ? `orcaops archive prune — applied (mode=${mode})`
        : `orcaops archive prune — dry-run (mode=${mode}, pass --apply to delete)`
    );
    lines.push(ARCHIVE_PRUNE_WARNING);
    if (candidates.length === 0) {
      lines.push('Nothing to prune for that selector.');
    } else {
      for (const c of candidates) {
        lines.push(`  ${c.path} (${c.artifacts} artifact(s))`);
      }
      lines.push(
        applied
          ? `Deleted ${deleted} target(s).`
          : `${candidates.length} target(s) would be deleted.`
      );
    }
    lines.push('');
    writeTerminalSafeStdout(lines.join('\n'));
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function countDirEntries(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).length;
  } catch {
    return 0;
  }
}

async function listProjectDirs(dataRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(dataRoot, 'projects'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
