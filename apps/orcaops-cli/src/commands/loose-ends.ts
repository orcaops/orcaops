import { computeCoverage } from '@orcaops/core';
import type { ArtifactOriginKind, Summary } from '@orcaops/storage';
import { loadArtifactThreadFromArchive } from '@orcaops/storage';

import { assertWindowOrdered, parseLimit, parseSince, parseUntil } from './list.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import {
  selectProjectArtifacts,
  unavailableArtifactIdsWithoutSelectedProjection,
} from '../lib/artifact-projections.js';
import {
  type ArtifactScopeFlags,
  importedArtifactsDisclosure,
  importedTag,
  importedTrailerLine,
  resolveArtifactScope,
} from '../lib/artifact-scope.js';
import { buildContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { formatProjectScopeWarnings, openAllProjects } from '../lib/project-scope.js';

/**
 * `orcaops loose-ends` — everything an artifact still owes, per artifact:
 * summary `open_items`, `deferred_decisions` (JSON-projection read), raw
 * `uncertainty` entries from closed checkpoints (with provenance — no
 * resolution/dedup in v1), plan steps covered by no checkpoint
 * (`computeCoverage`), still-open checkpoints (with age), and a
 * `no_summary` flag. An artifact is included only if it has ≥1 finding.
 *
 * Window semantics (pinned, the OPPOSITE of `decisions`): window flags
 * select ARTIFACTS only — findings are always the artifact's CURRENT loose
 * ends. A month-old open item is still a loose end today, so record-level
 * time filtering would defeat the command; finding timestamps are carried
 * for display, never for filtering. Combining window flags with
 * `--artifact` (exact-scope) is rejected: the flags would do nothing, and
 * rejection beats silent-ignore.
 */

export interface LooseEndsInput {
  planSteps: ReadonlyArray<{ step_id: string; label: string; text: string }>;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    completed_step_ids: readonly string[];
    uncertainty: readonly string[];
  }>;
  openCheckpoints: ReadonlyArray<{
    n: number;
    opened_at: string;
    declared_step_ids: readonly string[];
  }>;
  summary: {
    open_items: readonly string[];
    deferred_decisions: readonly string[];
    ts: string;
  } | null;
  /**
   * True when the summary exists but could not be read (recovery
   * refusal) — distinct from `summary: null` (never captured). The
   * open items and deferred decisions are UNKNOWN, not empty.
   */
  summaryUnreadable?: boolean;
  /** True when the artifact log itself refused recovery. */
  artifactUnreadable?: boolean;
  /** ISO now, for open-checkpoint age computation. */
  now: string;
}

export interface ArtifactLooseEnds {
  open_items: Array<{ text: string; ts: string }>;
  deferred_decisions: Array<{ text: string; ts: string }>;
  uncertainty: Array<{ checkpoint_n: number; closed_at: string; entries: string[] }>;
  uncovered_steps: Array<{ step_id: string; label: string; text: string }>;
  open_checkpoints: Array<{ n: number; opened_at: string; age_seconds: number }>;
  no_summary: boolean;
  /** The summary exists but is unreadable — findings from it are unknown. */
  summary_unreadable: boolean;
  finding_count: number;
}

/** Assemble one artifact's current loose ends. Pure — unit-tested directly. */
export function collectLooseEnds(input: LooseEndsInput): ArtifactLooseEnds {
  const summaryTs = input.summary?.ts ?? '';
  const open_items = (input.summary?.open_items ?? []).map((text) => ({ text, ts: summaryTs }));
  const deferred_decisions = (input.summary?.deferred_decisions ?? []).map((text) => ({
    text,
    ts: summaryTs,
  }));

  const uncertainty = input.closedCheckpoints
    .filter((cp) => cp.uncertainty.length > 0)
    .map((cp) => ({
      checkpoint_n: cp.n,
      closed_at: cp.closed_at,
      entries: [...cp.uncertainty],
    }));

  const coverage = computeCoverage({
    planStepIds: input.planSteps.map((s) => s.step_id),
    closedCheckpoints: input.closedCheckpoints,
    openCheckpoints: input.openCheckpoints,
  });
  const stepById = new Map(input.planSteps.map((s) => [s.step_id, s]));
  const uncovered_steps = coverage.uncovered_step_ids.map((id) => {
    const s = stepById.get(id);
    return { step_id: id, label: s?.label ?? '(unknown)', text: s?.text ?? '(unknown)' };
  });

  const nowMs = Date.parse(input.now);
  const open_checkpoints = input.openCheckpoints.map((cp) => ({
    n: cp.n,
    opened_at: cp.opened_at,
    age_seconds: Math.max(0, Math.floor((nowMs - Date.parse(cp.opened_at)) / 1000)),
  }));

  const summary_unreadable = input.summaryUnreadable === true;
  // An unreadable summary is NOT "no summary": the artifact was closed
  // out, and its recorded open items are unknown rather than empty.
  const no_summary = input.summary === null && !summary_unreadable;
  const finding_count =
    open_items.length +
    deferred_decisions.length +
    uncertainty.reduce((acc, u) => acc + u.entries.length, 0) +
    uncovered_steps.length +
    open_checkpoints.length +
    // A plan with no summary is itself a loose end — "captured then
    // forgotten" must stay visible even with zero other findings.
    (no_summary ? 1 : 0) +
    // An unreadable summary is a finding too: the recorded loose ends
    // exist but cannot be served.
    (summary_unreadable ? 1 : 0) +
    // Log refusal is independently material even when every derivable
    // loose-end bucket happens to be empty.
    (input.artifactUnreadable === true ? 1 : 0);

  return {
    open_items,
    deferred_decisions,
    uncertainty,
    uncovered_steps,
    open_checkpoints,
    no_summary,
    summary_unreadable,
    finding_count,
  };
}

export interface LooseEndsOptions extends ArtifactScopeFlags {
  /**
   * Cross-project mode: fan out over every archived project. The current
   * project's hot and retained archive projections are deduplicated
   * freshest-first, with ties using hot. Summary content for index-served
   * projects is rebuilt from archive events. Implies all branches; rejects
   * `--branch` and `--artifact`. Window semantics unchanged (artifact selection only).
   */
  allProjects?: boolean;
  json?: boolean;
}

interface ArtifactLooseEndsView extends ArtifactLooseEnds {
  artifact_id: string;
  label: string;
  task: string;
  branch: string;
  /** `git-import` marks synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  /**
   * The artifact's event log is unreadable (the summary probe refused):
   * every OTHER finding on this row is index-derived and unverifiable
   * against the log — treat the row as unknown, not as fact.
   */
  unreadable?: true;
  /** Present only in --all-projects mode. */
  project_id?: string;
  project?: string;
}

/** Cross-project loose ends: same collector, archive-thread summary loader. */
async function runLooseEndsAllProjects(opts: LooseEndsOptions): Promise<void> {
  const since = parseSince(opts.since, 'since');
  const until = parseUntil(opts.until, 'until');
  const activeSince = parseSince(opts.activeSince, 'active-since');
  const activeUntil = parseUntil(opts.activeUntil, 'active-until');
  assertWindowOrdered(since, until, 'since', 'until');
  assertWindowOrdered(activeSince, activeUntil, 'active-since', 'active-until');
  const window = { since, until, activeSince, activeUntil };

  const scope = await openAllProjects();
  try {
    const now = new Date().toISOString();
    const artifacts: ArtifactLooseEndsView[] = [];
    const unavailable = new Set<string>();
    for (const p of scope.projects) {
      const selected = await selectProjectArtifacts(p);
      for (const id of unavailableArtifactIdsWithoutSelectedProjection(p.issues, selected)) {
        unavailable.add(id);
      }
      const hotEligible = new Set(
        (p.hotStore ? p.store.listArtifacts(window) : []).map((row) => row.id)
      );
      const archiveStore = p.hotStore ? p.archiveStore : p.store;
      const archiveEligible = new Set(
        (archiveStore?.listArtifacts(window) ?? []).map((row) => row.id)
      );
      for (const artifact of selected) {
        if (
          artifact.source === 'hot'
            ? !hotEligible.has(artifact.row.id)
            : !archiveEligible.has(artifact.row.id)
        ) {
          continue;
        }
        const row = artifact.row;
        const latest = artifact.store.getLatestPlanRevision(row.id);
        const closed = artifact.store.getClosedCheckpoints(row.id);
        const open = artifact.store.getOpenCheckpoints(row.id);
        // Row-level health probe FIRST: artifact.json's source is the
        // artifact's last event, so it witnesses any clean truncation a
        // summary-less artifact would otherwise hide (readSummary
        // legitimately returns null there).
        let rowUnreadable = false;
        let summaryUnreadable = false;
        let summary: Summary | null = null;
        if (artifact.source === 'hot') {
          const rowRead =
            artifact.hotReadError === undefined
              ? await readForEnumeration(row.id, 'loose-ends', () =>
                  p.hotStore!.readArtifact(row.id)
                )
              : await readForEnumeration(row.id, 'loose-ends', () =>
                  Promise.reject(artifact.hotReadError)
                );
          rowUnreadable = rowRead.kind === 'unreadable';
          // The summary probe stays independent: an intact log with no
          // summary is different from an unreadable summary projection.
          const summaryRead = await readForEnumeration(row.id, 'loose-ends', () =>
            p.hotStore!.readSummary(row.id)
          );
          summaryUnreadable = summaryRead.kind === 'unreadable';
          summary = summaryRead.kind === 'readable' ? summaryRead.value : null;
        } else {
          const threadRead = await readForEnumeration(row.id, 'loose-ends', () =>
            loadArtifactThreadFromArchive(p.projectDir, row.id)
          );
          const thread = threadRead.kind === 'readable' ? threadRead.value : null;
          if ((thread?.lossyLines ?? 0) > 0) {
            process.stderr.write(
              `warning: artifact ${row.id} is unreadable in loose-ends — the archive ` +
                `copy has ${thread!.lossyLines} corrupt event-log line(s)\n`
            );
          }
          rowUnreadable = threadRead.kind === 'unreadable' || (thread?.lossyLines ?? 0) > 0;
          summaryUnreadable = rowUnreadable;
          summary = rowUnreadable ? null : (thread?.summary ?? null);
        }
        const artifactUnreadable =
          rowUnreadable || (summaryUnreadable && artifact.source === 'archive');
        const le = collectLooseEnds({
          planSteps: (latest?.steps ?? []).map((s) => ({
            step_id: s.step_id,
            label: s.label,
            text: s.text,
          })),
          closedCheckpoints: closed,
          openCheckpoints: open,
          summary:
            summary === null
              ? null
              : {
                  open_items: summary.open_items,
                  deferred_decisions: summary.deferred_decisions,
                  ts: summary.ts,
                },
          now,
          summaryUnreadable,
          artifactUnreadable: rowUnreadable,
        });
        if (le.finding_count === 0) continue;
        artifacts.push({
          artifact_id: row.id,
          label: row.label ?? 'unlabelled',
          task: row.task,
          branch: row.branch,
          origin: row.origin_kind ?? null,
          project_id: p.projectId,
          project: p.displayName,
          ...(artifactUnreadable ? { unreadable: true as const } : {}),
          ...le,
        });
      }
    }
    if (opts.json) {
      emitOk({
        all_projects: true,
        projects: scope.projects.length,
        artifacts,
        degraded_artifacts: [...unavailable].sort(),
        window_semantics: 'selects-artifacts-only',
        ...(scope.issues.length > 0 ? { warnings: scope.issues } : {}),
      });
      return;
    }
    writeTerminalSafeStdout(formatHuman(artifacts) + formatProjectScopeWarnings(scope.issues));
  } finally {
    scope.close();
  }
}

export async function looseEndsAction(opts: LooseEndsOptions = {}): Promise<void> {
  try {
    parseLimit(opts.limit);
    if (opts.allProjects) {
      if (opts.branch !== undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--all-projects implies all branches; drop --branch.',
          'branch'
        );
      }
      if ((opts.artifact ?? []).length > 0) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--artifact exact-scope is single-project; drop --all-projects.',
          'artifact'
        );
      }
      await runLooseEndsAllProjects(opts);
      return;
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      // Seeded participation (storage-class rule, decided explicitly):
      // loose ends are obligations of live work — synthesized history owes
      // nothing, and hundreds of imported artifacts' enrichment uncertainty
      // would drown the live signal. Imported rows stay reachable via
      // --all-branches / --branch / --artifact and render with [imported];
      // their presence is disclosed via the shared imported trailer.
      const scope = await resolveArtifactScope(ctx, opts, { imported: 'disclose' });
      if (scope.exactScope && scope.windowFlagsPresent) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          'window flags have no effect in exact-scope mode (--artifact); loose ends are ' +
            'current state, so records are never time-filtered. Drop the window flags.',
          'artifact'
        );
      }

      const now = new Date().toISOString();
      const artifacts: ArtifactLooseEndsView[] = [];
      for (const row of scope.rows) {
        const latest = ctx.store.store.getLatestPlanRevision(row.id);
        const closed = ctx.store.store.getClosedCheckpoints(row.id);
        const open = ctx.store.store.getOpenCheckpoints(row.id);
        // Row-level probe first (see the all-projects arm for why).
        const rowRead = await readForEnumeration(row.id, 'loose-ends', () =>
          ctx.store.readArtifact(row.id)
        );
        const rowUnreadable = rowRead.kind === 'unreadable';
        // Independent summary probe — see the all-projects arm.
        const summaryRead = await readForEnumeration(row.id, 'loose-ends', () =>
          ctx.store.readSummary(row.id)
        );
        const summaryUnreadable = summaryRead.kind === 'unreadable';
        const summary = summaryRead.kind === 'readable' ? summaryRead.value : null;
        const le = collectLooseEnds({
          planSteps: (latest?.steps ?? []).map((s) => ({
            step_id: s.step_id,
            label: s.label,
            text: s.text,
          })),
          closedCheckpoints: closed,
          openCheckpoints: open,
          summary:
            summary === null
              ? null
              : {
                  open_items: summary.open_items,
                  deferred_decisions: summary.deferred_decisions,
                  ts: summary.ts,
                },
          now,
          summaryUnreadable,
          artifactUnreadable: rowUnreadable,
        });
        if (le.finding_count === 0) continue;
        artifacts.push({
          artifact_id: row.id,
          label: row.label ?? 'unlabelled',
          task: row.task,
          branch: row.branch,
          origin: row.origin_kind ?? null,
          ...(rowUnreadable ? { unreadable: true as const } : {}),
          ...le,
        });
      }

      // Empty-state pointer parity with `decisions`: imported artifacts owe
      // no loose ends, so a wide scope (--all-branches) reaches them yet
      // reports nothing — the empty view must still disclose the imported
      // corpus exists, not just the rows the default scope withheld.
      const importedPointer =
        artifacts.length === 0 ? scope.importedInStore : scope.importedWithheld;
      if (opts.json) {
        emitOk({
          artifacts,
          window_semantics: 'selects-artifacts-only',
          ...(importedPointer > 0
            ? { imported_artifacts: importedArtifactsDisclosure(importedPointer) }
            : {}),
        });
        return;
      }
      writeTerminalSafeStdout(formatHuman(artifacts, importedPointer));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatHuman(artifacts: ArtifactLooseEndsView[], importedWithheld = 0): string {
  if (artifacts.length === 0) {
    return importedWithheld > 0
      ? `No loose ends in scope.\n${importedTrailerLine(importedWithheld)}\n`
      : 'No loose ends in scope.\n';
  }
  const lines: string[] = [];
  for (const a of artifacts) {
    const imported = a.origin === 'git-import';
    lines.push(
      `${a.artifact_id}  ${importedTag(a.origin)}${a.label} (${a.branch}) — ${a.finding_count} finding(s)`
    );
    if (imported) {
      lines.push('  origin: imported from git history (synthesized)');
    }
    for (const oi of a.open_items) lines.push(`  open item: ${oi.text}`);
    for (const dd of a.deferred_decisions) lines.push(`  deferred decision: ${dd.text}`);
    for (const u of a.uncertainty) {
      for (const e of u.entries) lines.push(`  uncertainty (cp #${u.checkpoint_n}): ${e}`);
    }
    for (const s of a.uncovered_steps) lines.push(`  uncovered step: ${s.label}`);
    for (const cp of a.open_checkpoints) {
      lines.push(`  open checkpoint #${cp.n} (opened ${cp.opened_at}, ${cp.age_seconds}s ago)`);
    }
    if (a.no_summary) lines.push('  no summary captured');
    if (a.summary_unreadable)
      lines.push('  summary unreadable — open items unknown (run `orcaops doctor`)');
    if (a.unreadable === true)
      lines.push('  artifact log unreadable — the findings above are index-derived, unverified');
    lines.push('');
  }
  if (importedWithheld > 0) lines.push(importedTrailerLine(importedWithheld), '');
  return lines.join('\n');
}
