import { HistoryScopeError, validateHistorySelector } from '@orcaops/project-scope/history';
import { AgentUsageSnapshotPayloadSchema, type ArtifactThread } from '@orcaops/storage';
import { readProjectUsageAccounting } from '@orcaops/storage/history/database';

import { requireRepositoryScope } from './database-branch-history.js';
import type { DiffArtifact, DiffContext } from './database-diff.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface DatabaseExportOptions {
  commit?: string;
  out?: string;
  notes?: boolean;
  project?: string;
  json?: boolean;
}

const EXPORT_KEYS = ['commit', 'out', 'notes', 'project', 'json'] as const;

export function validateDatabaseExport(raw: DatabaseExportOptions = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide export options as an object');
  const options = { ...raw };
  for (const key of Object.keys(options))
    if (!(EXPORT_KEYS as readonly string[]).includes(key))
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, `Unsupported export option "${key}"`, key);
  const selector = { projectId: options.project };
  validateHistorySelector({ profile: 'git-history', selector });
  return { options, selector } as const;
}

/**
 * Retained usage snapshots for the project, keyed by artifact. Read once per export:
 * the record emits one conversation per (artifact, checkpoint, match kind) and a
 * per-conversation read would reopen the ledger for every range.
 *
 * A snapshot whose retained record is incomplete is skipped: it cannot establish which
 * model produced the tokens, and a partial breakdown would move the argmax.
 */
export function readExportUsageSnapshots(context: DiffContext) {
  const { database } = requireRepositoryScope(context.scope);
  const byArtifact = new Map<
    string,
    Array<{ checkpointN: number | null; models: Map<string, number> }>
  >();
  let events: ReturnType<typeof readProjectUsageAccounting>['events'];
  try {
    events = readProjectUsageAccounting(database).events;
  } catch {
    // Usage is accounting, not history: an unreadable ledger leaves every contributor
    // without a model_id rather than refusing the trace.
    return byArtifact;
  }
  for (const event of events) {
    if (
      event.record.type !== 'agent_usage_snapshot_recorded' ||
      event.completeness.state !== 'complete'
    )
      continue;
    const parsed = AgentUsageSnapshotPayloadSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.artifact_id === null) continue;
    const models = new Map<string, number>();
    for (const entry of parsed.data.model_breakdown)
      models.set(entry.model, (models.get(entry.model) ?? 0) + entry.cumulative.output_tokens);
    const rows = byArtifact.get(parsed.data.artifact_id) ?? [];
    rows.push({ checkpointN: parsed.data.checkpoint_n, models });
    byArtifact.set(parsed.data.artifact_id, rows);
  }
  return byArtifact;
}

/**
 * Dominant model for one (artifact, checkpoint): the retained snapshots for the
 * artifact, preferring rows stamped with this checkpoint, decided by output tokens.
 * Null when nothing was recorded — the contributor then carries `type: 'ai'` with no
 * model_id rather than a guessed one.
 */
export function dominantExportModel(
  snapshots: ReturnType<typeof readExportUsageSnapshots>,
  artifactId: string,
  checkpointN: number
): string | null {
  const rows = snapshots.get(artifactId) ?? [];
  const scoped = rows.filter((row) => row.checkpointN === checkpointN);
  const pool = scoped.length > 0 ? scoped : rows;
  const totals = new Map<string, number>();
  for (const row of pool)
    for (const [model, tokens] of row.models) totals.set(model, (totals.get(model) ?? 0) + tokens);
  // Ties break on the model name so the choice is deterministic across reads.
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export interface ExportArtifactOrigin {
  origin: 'git-import' | null;
  authors: string[];
}

/** Plan origin per artifact: an imported artifact's recorded commit-author set. */
export function exportArtifactOrigins(
  artifacts: readonly DiffArtifact[]
): Map<string, ExportArtifactOrigin> {
  return new Map(
    artifacts.map((artifact) => {
      const plan: ArtifactThread['plan'] = artifact.thread.plan;
      const origin = plan?.origin;
      return [
        artifact.id,
        {
          origin: origin?.kind === 'git-import' ? ('git-import' as const) : null,
          authors: origin?.kind === 'git-import' ? [...(origin.authors ?? [])] : [],
        },
      ];
    })
  );
}
