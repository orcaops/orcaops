import type { ArtifactOriginKind } from '@orcaops/storage';
import { loadArtifactThreadFromArchive } from '@orcaops/storage';

import { assertWindowOrdered, parseLimit, parseSince, parseUntil } from './list.js';
import { splitEvidenceCitation } from './seed/enrichment.js';
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
 * `orcaops decisions` — every recorded decision across the scoped artifact
 * set, merged from the three capture surfaces:
 *
 *   - `plan` — the latest plan revision's CUMULATIVE decisions (each entry
 *     is stamped with the `revision_n` that added it; its `ts` is that
 *     revision's `captured_at`);
 *   - `checkpoint` — closed checkpoints' `decisions[]` (`ts` = `closed_at`);
 *   - `summary_deferred` — the summary's `deferred_decisions` strings
 *     (`ts` = the summary `ts`). JSON-projection read; deliberately no
 *     SQLite migration.
 *
 * Window semantics (the opposite of `loose-ends`): window flags select
 * artifacts AND filter decision RECORDS to the window — each record carries
 * `ts`, so "--active-since yesterday" cannot surface years-old plan
 * decisions from a merely recently-active artifact. With `--artifact`
 * (exact-scope) the flags stop selecting artifacts but still filter records
 * ("decisions made yesterday on these artifacts"). An artifact is listed
 * only if ≥1 record survives.
 */

export interface DecisionRecord {
  source: 'plan' | 'checkpoint' | 'summary_deferred';
  /** Best-known timestamp; null only when a plan revision row is missing. */
  ts: string | null;
  decision: string;
  reason: string | null;
  alternatives_considered?: Array<{ option: string; rejected_because: string }>;
  /** Plan records: the revision that added the decision. */
  revision_n?: number;
  /** Checkpoint records: the closing checkpoint's n. */
  checkpoint_n?: number;
}

export interface CollectDecisionsInput {
  /** Latest plan revision's cumulative decisions (each stamped revision_n). */
  planDecisions: ReadonlyArray<{
    decision: string;
    reason?: string | null;
    alternatives_considered?: ReadonlyArray<{ option: string; rejected_because: string }>;
    revision_n: number;
  }>;
  /** revision_n → captured_at (from listPlanRevisions). */
  revisionCapturedAt: ReadonlyMap<number, string>;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    decisions: readonly unknown[];
  }>;
  /** Summary deferred_decisions (plain strings per the Summary schema). */
  deferredDecisions: readonly string[];
  summaryTs: string | null;
}

export interface RecordWindow {
  lower?: string;
  upper?: string;
}

/**
 * Intersect the two flag pairs into one record window: lower = the latest
 * provided lower bound, upper = the earliest provided upper bound. No flags
 * ⇒ empty window ⇒ all records.
 */
export function recordWindowFromFlags(w: {
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
}): RecordWindow {
  const lowers = [w.since, w.activeSince].filter((x): x is string => x !== undefined);
  const uppers = [w.until, w.activeUntil].filter((x): x is string => x !== undefined);
  return {
    ...(lowers.length > 0 ? { lower: lowers.reduce((a, b) => (a > b ? a : b)) } : {}),
    ...(uppers.length > 0 ? { upper: uppers.reduce((a, b) => (a < b ? a : b)) } : {}),
  };
}

/**
 * Merge one artifact's decision records from the three sources and filter
 * them to the record window. Pure — unit-tested directly.
 */
export function collectArtifactDecisions(
  input: CollectDecisionsInput,
  window: RecordWindow = {}
): DecisionRecord[] {
  const records: DecisionRecord[] = [];

  for (const d of input.planDecisions) {
    records.push({
      source: 'plan',
      ts: input.revisionCapturedAt.get(d.revision_n) ?? null,
      decision: d.decision,
      reason: d.reason ?? null,
      ...(d.alternatives_considered && d.alternatives_considered.length > 0
        ? { alternatives_considered: [...d.alternatives_considered] }
        : {}),
      revision_n: d.revision_n,
    });
  }

  for (const cp of input.closedCheckpoints) {
    for (const raw of cp.decisions) {
      if (raw === null || typeof raw !== 'object') continue;
      const d = raw as {
        decision?: unknown;
        reason?: unknown;
        alternatives_considered?: unknown;
      };
      if (typeof d.decision !== 'string' || d.decision.length === 0) continue;
      const alts = Array.isArray(d.alternatives_considered)
        ? (d.alternatives_considered as Array<{ option: string; rejected_because: string }>)
        : [];
      records.push({
        source: 'checkpoint',
        ts: cp.closed_at,
        decision: d.decision,
        reason: typeof d.reason === 'string' ? d.reason : null,
        ...(alts.length > 0 ? { alternatives_considered: alts } : {}),
        checkpoint_n: cp.n,
      });
    }
  }

  for (const text of input.deferredDecisions) {
    records.push({
      source: 'summary_deferred',
      ts: input.summaryTs,
      decision: text,
      reason: null,
    });
  }

  if (window.lower === undefined && window.upper === undefined) return records;
  // A record whose ts is unknown cannot be shown to lie inside the window —
  // drop it rather than guess.
  return records.filter(
    (r) =>
      r.ts !== null &&
      (window.lower === undefined || r.ts >= window.lower) &&
      (window.upper === undefined || r.ts <= window.upper)
  );
}

export interface DecisionsOptions extends ArtifactScopeFlags {
  /**
   * Cross-project mode: fan out over every archived project. The current
   * project's hot and retained archive projections are deduplicated
   * freshest-first, with ties using hot. Thread content for index-served
   * projects is rebuilt from ARCHIVE EVENTS via the
   * rebuilders — `deferred_decisions` is deliberately not materialized
   * in the index. Implies all branches; rejects
   * `--branch` and `--artifact` (exact-scope stays single-project).
   */
  allProjects?: boolean;
  json?: boolean;
}

interface ArtifactDecisions {
  artifact_id: string;
  label: string;
  task: string;
  branch: string;
  /** `git-import` marks synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  records: DecisionRecord[];
  /** Present only in --all-projects mode. */
  project_id?: string;
  project?: string;
}

/** Cross-project decisions: same collector, archive-thread content loader. */
async function runDecisionsAllProjects(opts: DecisionsOptions): Promise<void> {
  const since = parseSince(opts.since, 'since');
  const until = parseUntil(opts.until, 'until');
  const activeSince = parseSince(opts.activeSince, 'active-since');
  const activeUntil = parseUntil(opts.activeUntil, 'active-until');
  assertWindowOrdered(since, until, 'since', 'until');
  assertWindowOrdered(activeSince, activeUntil, 'active-since', 'active-until');
  const window = { since, until, activeSince, activeUntil };
  const recordWindow = recordWindowFromFlags(window);

  const scope = await openAllProjects();
  try {
    const artifacts: ArtifactDecisions[] = [];
    const degraded = new Set<string>();
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
        const revisionCapturedAt = new Map(
          artifact.store
            .listPlanRevisions(row.id)
            .map((r) => [r.plan.revision_n, r.plan.captured_at])
        );
        let planDecisions: CollectDecisionsInput['planDecisions'];
        let closed: CollectDecisionsInput['closedCheckpoints'];
        let deferredDecisions: CollectDecisionsInput['deferredDecisions'];
        let summaryTs: string | null;
        if (artifact.source === 'hot') {
          if (artifact.hotReadError !== undefined) {
            await readForEnumeration(row.id, 'decisions', () =>
              Promise.reject(artifact.hotReadError)
            );
            degraded.add(row.id);
            continue;
          }
          const planRead = await readForEnumeration(row.id, 'decisions', () =>
            p.hotStore!.readPlan(row.id)
          );
          const summaryRead =
            planRead.kind === 'unreadable'
              ? planRead
              : await readForEnumeration(row.id, 'decisions', () =>
                  p.hotStore!.readSummary(row.id)
                );
          if (planRead.kind === 'unreadable' || summaryRead.kind === 'unreadable') {
            // Its decisions are unknown, not absent — disclose, skip.
            degraded.add(row.id);
            continue;
          }
          const plan = planRead.value;
          const summary = summaryRead.value;
          planDecisions = (plan?.decisions ?? []) as CollectDecisionsInput['planDecisions'];
          closed = artifact.store.getClosedCheckpoints(row.id).map((cp) => ({
            n: cp.n,
            closed_at: cp.closed_at,
            decisions: cp.decisions,
          }));
          deferredDecisions = summary?.deferred_decisions ?? [];
          summaryTs = summary?.ts ?? null;
        } else {
          const threadRead = await readForEnumeration(row.id, 'decisions', () =>
            loadArtifactThreadFromArchive(p.projectDir, row.id)
          );
          if (threadRead.kind === 'unreadable') {
            degraded.add(row.id);
            continue;
          }
          const thread = threadRead.value;
          if (thread.lossyLines > 0) {
            // Rebuilt from survivors only — its decisions are unknown,
            // not absent; disclose and skip.
            process.stderr.write(
              `warning: artifact ${row.id} is unreadable in decisions — the archive copy ` +
                `has ${thread.lossyLines} corrupt event-log line(s)\n`
            );
            degraded.add(row.id);
            continue;
          }
          planDecisions = (thread.plan?.decisions ?? []) as CollectDecisionsInput['planDecisions'];
          closed = thread.checkpoints
            .filter((cp) => cp.status === 'closed')
            .map((cp) => ({ n: cp.n, closed_at: cp.closed_at, decisions: cp.decisions }));
          deferredDecisions = thread.summary?.deferred_decisions ?? [];
          summaryTs = thread.summary?.ts ?? null;
        }
        const records = collectArtifactDecisions(
          {
            planDecisions,
            revisionCapturedAt,
            closedCheckpoints: closed,
            deferredDecisions,
            summaryTs,
          },
          recordWindow
        );
        if (records.length === 0) continue;
        artifacts.push({
          artifact_id: row.id,
          label: row.label ?? 'unlabelled',
          task: row.task,
          branch: row.branch,
          origin: row.origin_kind ?? null,
          records,
          project_id: p.projectId,
          project: p.displayName,
        });
      }
    }
    if (opts.json) {
      const degradedAll = [...new Set([...degraded, ...unavailable])].sort();
      emitOk({
        all_projects: true,
        projects: scope.projects.length,
        artifacts,
        degraded_artifacts: degradedAll,
        record_window:
          recordWindow.lower === undefined && recordWindow.upper === undefined
            ? null
            : recordWindow,
        ...(scope.issues.length > 0 ? { warnings: scope.issues } : {}),
      });
      return;
    }
    writeTerminalSafeStdout(formatHuman(artifacts) + formatProjectScopeWarnings(scope.issues));
  } finally {
    scope.close();
  }
}

export async function decisionsAction(opts: DecisionsOptions = {}): Promise<void> {
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
      await runDecisionsAllProjects(opts);
      return;
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      // Seeded participation (storage-class rule, decided explicitly):
      // decisions is an "In" surface — a day-one user's first decisions
      // query must reach the imported corpus even though seeded artifacts
      // record the remote-tracking branch name.
      const scope = await resolveArtifactScope(ctx, opts, { imported: 'include' });
      const recordWindow = recordWindowFromFlags(scope.window);

      const artifacts: ArtifactDecisions[] = [];
      const degraded: string[] = [];
      for (const row of scope.rows) {
        const planRead = await readForEnumeration(row.id, 'decisions', () =>
          ctx.store.readPlan(row.id)
        );
        if (planRead.kind === 'unreadable') {
          degraded.push(row.id);
          continue;
        }
        const plan = planRead.value;
        const revisionCapturedAt = new Map(
          ctx.store.store
            .listPlanRevisions(row.id)
            .map((r) => [r.plan.revision_n, r.plan.captured_at])
        );
        const closed = ctx.store.store.getClosedCheckpoints(row.id).map((cp) => ({
          n: cp.n,
          closed_at: cp.closed_at,
          decisions: cp.decisions,
        }));
        const summaryRead = await readForEnumeration(row.id, 'decisions', () =>
          ctx.store.readSummary(row.id)
        );
        if (summaryRead.kind === 'unreadable') {
          degraded.push(row.id);
          continue;
        }
        const summary = summaryRead.value;
        const records = collectArtifactDecisions(
          {
            planDecisions: (plan?.decisions ?? []) as CollectDecisionsInput['planDecisions'],
            revisionCapturedAt,
            closedCheckpoints: closed,
            deferredDecisions: summary?.deferred_decisions ?? [],
            summaryTs: summary?.ts ?? null,
          },
          recordWindow
        );
        if (records.length === 0) continue;
        artifacts.push({
          artifact_id: row.id,
          label: row.label ?? 'unlabelled',
          task: row.task,
          branch: row.branch,
          origin: row.origin_kind ?? null,
          records,
        });
      }

      // Skeleton (unenriched) imports carry no decision records, so an
      // empty view still discloses the imported corpus exists.
      const importedPointer = artifacts.length === 0 ? scope.importedInStore : 0;
      if (opts.json) {
        emitOk({
          artifacts,
          degraded_artifacts: degraded,
          record_window:
            recordWindow.lower === undefined && recordWindow.upper === undefined
              ? null
              : recordWindow,
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

function formatHuman(artifacts: ArtifactDecisions[], importedPointer = 0): string {
  if (artifacts.length === 0) {
    return importedPointer > 0
      ? `No decisions in scope.\n${importedTrailerLine(importedPointer)}\n`
      : 'No decisions in scope.\n';
  }
  const lines: string[] = [];
  for (const a of artifacts) {
    const imported = a.origin === 'git-import';
    lines.push(`${a.artifact_id}  ${importedTag(a.origin)}${a.label} (${a.branch})`);
    if (imported) {
      lines.push('  origin: imported from git history (synthesized — evidence-cited paraphrases)');
    }
    for (const r of a.records) {
      const provenance =
        r.source === 'plan'
          ? `plan r${r.revision_n}`
          : r.source === 'checkpoint'
            ? `cp #${r.checkpoint_n}`
            : 'summary (deferred)';
      lines.push(`  [${r.ts ?? 'unknown ts'}] (${provenance}) ${r.decision}`);
      const citation = imported && r.reason !== null ? splitEvidenceCitation(r.reason) : null;
      if (citation) {
        if (citation.prose.length > 0) lines.push(`      reason: ${citation.prose}`);
        lines.push(`      evidence: commit ${citation.sha} — "${citation.quote}"`);
      } else if (r.reason) {
        lines.push(`      reason: ${r.reason}`);
      }
      for (const alt of r.alternatives_considered ?? []) {
        lines.push(`      rejected: ${alt.option} — ${alt.rejected_because}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
