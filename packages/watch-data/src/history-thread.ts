import {
  type ArtifactThread,
  type ClosedCheckpoint,
  type OpenCheckpoint,
  resolveRecordedFingerprintBaseline,
  validateCheckpointFingerprintManifest,
} from '@orcaops/storage';
import type { ProjectArtifactQueryRow } from '@orcaops/storage/history/database';
import { HistoryMetadataDetailsSchema } from '@orcaops/storage/history/metadata-row';

import { deriveSteps } from './presenters.js';
import type {
  ArtifactStatus,
  LastClosed,
  WatchCheckpoint,
  WatchCheckpointStep,
  WatchDecision,
  WatchDecisionAlternative,
  WatchStep,
} from './types.js';

const WatchMetadataSchema = HistoryMetadataDetailsSchema.shape.watch;
export type WatchMetadata = ReturnType<typeof WatchMetadataSchema.parse>;

/** The bounded Watch column of one selected row, validated against its persisted schema. */
export function parseWatchMetadata(row: ProjectArtifactQueryRow): WatchMetadata {
  if (row.watchJson === null) throw new Error('Watch metadata column is absent from the row');
  return WatchMetadataSchema.parse(JSON.parse(row.watchJson));
}

/** Retained revision token: a thread hydrated from the same token needs no re-hydration. */
export function revisionToken(row: Pick<ProjectArtifactQueryRow, 'generation' | 'orderedHash'>) {
  return `${row.generation}:${row.orderedHash}`;
}

export function artifactStatus(state: ProjectArtifactQueryRow['state']): ArtifactStatus {
  return state === 'summarized' ? 'complete' : 'active';
}

/** ISO-8601 to epoch ms, or null when absent or unparseable. */
export function timestampMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Drill-in detail hydrated from one exact retained artifact thread. */
export interface ThreadDetail {
  planSteps: WatchStep[];
  checkpoints: WatchCheckpoint[];
  planDecisions: WatchDecision[];
  nonGoals: string[];
  lastClosed: LastClosed | null;
}

export async function threadDetail(thread: ArtifactThread): Promise<ThreadDetail> {
  const open = thread.checkpoints.filter((cp): cp is OpenCheckpoint => cp.status === 'open');
  const closed = thread.checkpoints.filter((cp): cp is ClosedCheckpoint => cp.status === 'closed');
  const last = closed.at(-1) ?? null;
  const steps = thread.plan?.plan_steps ?? [];
  const closedClaimed = new Set(closed.flatMap((cp) => cp.completed_step_ids));
  const openDeclared = new Set(open.flatMap((cp) => cp.declared_step_ids));
  const stepById = new Map<string, WatchCheckpointStep>(
    steps.map((step, index) => [step.step_id, { idx: index + 1, label: step.label || step.text }])
  );
  return {
    planSteps: deriveSteps(
      steps.map((step, index) => ({ ...step, idx: index + 1 })),
      closedClaimed,
      openDeclared
    ),
    checkpoints: buildCheckpoints(open, closed, stepById, await diffStats(thread, closed)),
    planDecisions: parseDecisions(thread.plan?.decisions ?? []),
    nonGoals: parseNonGoals(thread.plan?.non_goals ?? []),
    lastClosed: last
      ? {
          closed_at: last.closed_at,
          summary: last.summary,
          uncertaintyCount: last.uncertainty.length,
        }
      : null,
  };
}

/**
 * Line tallies live only in each close event's fingerprint manifest, which the
 * exact read has already decoded; a close without a manifest leaves its
 * checkpoint at null ("unknown", never zero). The last close for an n wins.
 */
async function diffStats(
  thread: ArtifactThread,
  closed: readonly ClosedCheckpoint[]
): Promise<Map<number, { added: number; removed: number }>> {
  const byN = new Map<number, { added: number; removed: number }>();
  const events = new Map(thread.events.map((event) => [event.record.event_id, event]));
  for (const checkpoint of closed) {
    const payload = events.get(checkpoint.source_event_ids.closed)?.payload as
      | { diff_fingerprint_manifest?: unknown }
      | undefined;
    if (payload?.diff_fingerprint_manifest === undefined) continue;
    const validated = await validateCheckpointFingerprintManifest({
      artifactId: thread.artifactId,
      checkpointN: checkpoint.n,
      openTreeSha: checkpoint.open_snapshot.tree_sha,
      closeTreeSha: checkpoint.close_snapshot.tree_sha,
      summary: checkpoint.diff_fingerprint_summary,
      manifest: payload.diff_fingerprint_manifest,
      recoveredOpenTreeSha: resolveRecordedFingerprintBaseline(thread, checkpoint),
    });
    if (!validated.available) continue;
    let added = 0;
    let removed = 0;
    for (const hunk of validated.manifest.hunks) {
      added += hunk.added_line_count;
      removed += hunk.deleted_line_count;
    }
    byN.set(checkpoint.n, { added, removed });
  }
  return byN;
}

function buildCheckpoints(
  open: readonly OpenCheckpoint[],
  closed: readonly ClosedCheckpoint[],
  stepById: ReadonlyMap<string, WatchCheckpointStep>,
  stats: ReadonlyMap<number, { added: number; removed: number }>
): WatchCheckpoint[] {
  const resolve = (ids: readonly string[]): WatchCheckpointStep[] =>
    ids
      .map((id) => stepById.get(id))
      .filter((step): step is WatchCheckpointStep => step !== undefined)
      .sort((a, b) => a.idx - b.idx);
  return [
    ...open.map((cp) => ({
      n: cp.n,
      status: 'open' as const,
      summary: null,
      uncertainties: [],
      decisions: [],
      steps: resolve(cp.declared_step_ids),
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
    })),
    ...closed.map((cp) => ({
      n: cp.n,
      status: 'closed' as const,
      summary: cp.summary,
      uncertainties: [...cp.uncertainty],
      decisions: parseDecisions(cp.decisions),
      steps: resolve(cp.completed_step_ids),
      linesAdded: stats.get(cp.n)?.added ?? null,
      linesRemoved: stats.get(cp.n)?.removed ?? null,
      filesChanged: cp.files_changed.length,
    })),
  ].sort((a, b) => a.n - b.n);
}

/** Parse loosely-typed decisions (cp or plan) into {decision, reason, alternatives?}. */
export function parseDecisions(raw: readonly unknown[]): WatchDecision[] {
  const out: WatchDecision[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'decision' in entry && 'reason' in entry) {
      const value = entry as {
        decision: unknown;
        reason: unknown;
        alternatives_considered?: unknown;
      };
      if (typeof value.decision === 'string' && typeof value.reason === 'string') {
        const alternatives = parseAlternatives(value.alternatives_considered);
        out.push(
          alternatives.length > 0
            ? { decision: value.decision, reason: value.reason, alternatives }
            : { decision: value.decision, reason: value.reason }
        );
      }
    }
  }
  return out;
}

function parseAlternatives(raw: unknown): WatchDecisionAlternative[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchDecisionAlternative[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'option' in entry && 'rejected_because' in entry) {
      const value = entry as { option: unknown; rejected_because: unknown };
      if (typeof value.option === 'string' && typeof value.rejected_because === 'string')
        out.push({ option: value.option, reason: value.rejected_because });
    }
  }
  return out;
}

/** Extract the exclusion text from plan non_goals (string or {text} shapes). */
export function parseNonGoals(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object' && 'text' in entry) {
      const text = (entry as { text: unknown }).text;
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}
