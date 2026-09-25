import type { ProjectReadView } from './connection.js';
import type { KnowledgeTarget } from '../../schema/knowledge-resolution.js';

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');
const batches = <T>(values: readonly T[]) => {
  const held: T[][] = [];
  for (let start = 0; start < values.length; start += 256)
    held.push(values.slice(start, start + 256));
  return held;
};

export interface RevisionSourceState {
  readonly readable: boolean;
  readonly sourceIds: readonly string[];
}

function payloadSources(
  payload: string,
  kind: Exclude<KnowledgeTarget['kind'], 'relationship'>,
  legacy: boolean
): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const recordSourceIds = record.source_ids ?? (legacy ? [] : null);
  const recordPassages = record.passages ?? (legacy ? [] : null);
  if (!Array.isArray(recordSourceIds) || !Array.isArray(recordPassages)) return null;
  if (
    !legacy &&
    (recordSourceIds.length === 0 || (kind !== 'requirement' && recordPassages.length === 0))
  )
    return null;
  const sourceIds: string[] = [];
  for (const sourceId of recordSourceIds) {
    if (typeof sourceId !== 'string' || sourceId.length === 0) return null;
    sourceIds.push(sourceId);
  }
  for (const passage of recordPassages) {
    if (
      passage === null ||
      typeof passage !== 'object' ||
      Array.isArray(passage) ||
      typeof (passage as Record<string, unknown>).source_id !== 'string' ||
      (passage as Record<string, string>).source_id.length === 0
    )
      return null;
    sourceIds.push((passage as Record<string, string>).source_id);
  }
  return sourceIds;
}

export function revisionSourceState(
  view: ProjectReadView,
  target: KnowledgeTarget,
  revisionIds: readonly string[]
): RevisionSourceState {
  if (target.kind === 'relationship') return { readable: true, sourceIds: [] };
  const ids = [...new Set(revisionIds)].sort();
  if (ids.length === 0) return { readable: true, sourceIds: [] };
  const table = `${target.kind}_revisions`;
  const identity = `${target.kind}_id`;
  type RevisionRow = {
    revision_id: string;
    source_event_id?: string;
    source_standing: string | null;
    byte_length: number;
    payload: string | null;
  };
  const rows: RevisionRow[] = [];
  for (const batch of batches(ids))
    rows.push(
      ...view.all<RevisionRow>(
        `SELECT revision_id, ${target.kind === 'requirement' ? '' : 'source_event_id,'}
           source_standing, length(record_bytes) AS byte_length,
           CASE WHEN length(record_bytes)<=4194304 THEN CAST(record_bytes AS TEXT) END AS payload
         FROM ${table} WHERE ${identity}=? AND revision_id IN (${placeholders(batch)})
         ORDER BY revision_id`,
        target.entity_id,
        ...batch
      )
    );
  if (rows.length !== ids.length) return { readable: false, sourceIds: [] };
  const sourceIds = new Set<string>();
  const mustBeRetained = new Set<string>();
  if (target.kind === 'requirement') {
    const origin = view.get<{ passage_source_id: string | null }>(
      'SELECT passage_source_id FROM requirements WHERE requirement_id=?',
      target.entity_id
    );
    if (origin === null) return { readable: false, sourceIds: [] };
    if (origin.passage_source_id !== null) {
      sourceIds.add(origin.passage_source_id);
      if (rows.some((row) => row.source_standing !== null))
        mustBeRetained.add(origin.passage_source_id);
    }
  }
  const unreadable = (): RevisionSourceState => ({
    readable: false,
    sourceIds: [...sourceIds].sort(),
  });
  for (const row of rows) {
    if (row.source_event_id !== undefined) {
      sourceIds.add(row.source_event_id);
      if (row.source_standing !== null) mustBeRetained.add(row.source_event_id);
    }
    if (row.payload === null) return unreadable();
    const decoded = payloadSources(
      row.payload,
      target.kind,
      row.source_standing === null && target.kind !== 'requirement'
    );
    if (decoded === null) return unreadable();
    for (const sourceId of decoded) {
      sourceIds.add(sourceId);
      if (row.source_standing !== null) mustBeRetained.add(sourceId);
    }
  }
  const held = [...sourceIds].sort();
  const required = [...mustBeRetained].sort();
  if (required.length > 0) {
    const retained = new Set<string>();
    for (const batch of batches(required))
      for (const row of view.all<{ source_id: string }>(
        `SELECT source_id FROM knowledge_sources WHERE source_id IN (${placeholders(batch)})`,
        ...batch
      ))
        retained.add(row.source_id);
    if (required.some((sourceId) => !retained.has(sourceId))) return unreadable();
  }
  return { readable: true, sourceIds: held };
}

export function restrictedSourceLabels(
  view: ProjectReadView,
  sourceIds: readonly string[]
): string[] {
  const ids = [...new Set(sourceIds)].sort();
  if (ids.length === 0) return [];
  const restrictions = new Set<string>();
  for (const batch of batches(ids))
    for (const row of view.all<{ restriction: string }>(
      `SELECT DISTINCT access_restriction AS restriction FROM knowledge_sources
       WHERE source_id IN (${placeholders(batch)}) AND access_restriction IS NOT NULL`,
      ...batch
    ))
      restrictions.add(row.restriction);
  return [...restrictions].sort();
}
