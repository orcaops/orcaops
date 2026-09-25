import type { ProjectReadView } from './connection.js';
import { knowledgeBoundaryAt } from './knowledge-read-boundary.js';
import { invalid } from './knowledge-record-input.js';
import { interpretationCandidateSourceState } from './knowledge-retrieval.js';
import { restrictedSourceLabels } from './knowledge-revision-sources.js';
import {
  type InterpretationTarget,
  type KnowledgeEquivalenceDisposition,
  KnowledgeEquivalenceDispositionSchema,
  type KnowledgeInterpretation,
  KnowledgeInterpretationSchema,
} from '../../schema/knowledge-contract.js';

export type InterpretationReadRoute = 'origin_task' | 'source' | 'exact_target' | 'project';

export interface ProjectKnowledgeInterpretation {
  interpretation: KnowledgeInterpretation;
  route: InterpretationReadRoute;
  writeSequence: number;
  equivalenceStatus: 'proposed' | 'rejected' | null;
  rejection: KnowledgeEquivalenceDisposition | null;
}

export interface InterpretationReadLimit {
  kind: string;
  detail: string;
}

export interface ProjectInterpretationRead {
  interpretations: ProjectKnowledgeInterpretation[];
  limits: InterpretationReadLimit[];
}

export interface ProjectInterpretationQuestion {
  projectId: string;
  boundary: number;
  artifactIds: readonly string[];
  eventIds: readonly string[];
  targets: readonly InterpretationTarget[];
  projectFallback: boolean;
  maxEntries?: number;
  maxBytes?: number;
  preferredFieldPaths?: readonly string[];
}

const ROUTES: readonly InterpretationReadRoute[] = [
  'origin_task',
  'source',
  'exact_target',
  'project',
];

interface RoutedRow {
  interpretation_id: string;
  write_sequence: number;
  byte_length: number;
  origin_source_id: string;
  target_kind: 'requirement' | 'decision' | 'claim' | null;
  target_id: string | null;
  target_revision_id: string | null;
}

const ROUTED_COLUMNS = `i.interpretation_id, o.committed_write_sequence AS write_sequence,
  length(i.record_bytes) AS byte_length, i.origin_source_id, i.target_kind, i.target_id,
  i.target_revision_id`;

interface SqlMatch {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

interface RoutePage {
  readonly total: number;
  readonly rows: readonly RoutedRow[];
}

function routePage(
  view: ProjectReadView,
  input: ProjectInterpretationQuestion,
  route: InterpretationReadRoute,
  limit: number
): RoutePage {
  const artifacts = [...new Set(input.artifactIds)].sort();
  const events = [...new Set(input.eventIds)].sort();
  const targets = [
    ...new Map(
      input.targets.map((target) => [
        `${target.kind}:${target.entity_id}:${target.revision_id}`,
        target,
      ])
    ).values(),
  ];
  const origin: SqlMatch | null =
    artifacts.length === 0
      ? null
      : {
          sql: 'i.origin_artifact_id IN (SELECT value FROM json_each(?))',
          parameters: [JSON.stringify(artifacts)],
        };
  const source: SqlMatch | null =
    events.length === 0
      ? null
      : {
          sql: `EXISTS (
            SELECT 1 FROM knowledge_interpretation_evidence matched_evidence
            JOIN knowledge_sources matched_source
              ON matched_source.source_id=matched_evidence.source_id
            WHERE matched_evidence.interpretation_id=i.interpretation_id
              AND matched_source.source_kind='capture_field'
              AND matched_source.event_id IN (SELECT value FROM json_each(?))
          )`,
          parameters: [JSON.stringify(events)],
        };
  const target: SqlMatch | null =
    targets.length === 0
      ? null
      : {
          sql: `i.target_kind IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(?) route_target
            WHERE i.target_kind=json_extract(route_target.value,'$.kind')
              AND i.target_id=json_extract(route_target.value,'$.entity_id')
              AND i.target_revision_id=json_extract(route_target.value,'$.revision_id')
          )`,
          parameters: [JSON.stringify(targets)],
        };
  if (
    (route === 'origin_task' && origin === null) ||
    (route === 'source' && source === null) ||
    (route === 'exact_target' && target === null) ||
    (route === 'project' && !input.projectFallback)
  )
    return { total: 0, rows: [] };

  const prior =
    route === 'origin_task'
      ? []
      : route === 'source'
        ? [origin]
        : route === 'exact_target'
          ? [origin, source]
          : [origin, source, target];
  const own =
    route === 'origin_task'
      ? origin!
      : route === 'source'
        ? source!
        : route === 'exact_target'
          ? target!
          : {
              sql: "i.intended_scope_kind='project' AND i.intended_scope_value IS NULL",
              parameters: [],
            };
  const conditions = [own.sql];
  const parameters = [...own.parameters];
  for (const excluded of prior) {
    if (excluded === null) continue;
    conditions.push(`(${excluded.sql}) IS NOT TRUE`);
    parameters.push(...excluded.parameters);
  }
  if (route === 'exact_target')
    conditions[0] =
      "i.outcome_kind IN ('exact_restatement','proposed_equivalence','candidate_revision')";
  const sourceJoin =
    route === 'source'
      ? `knowledge_sources route_source
         JOIN knowledge_interpretation_evidence route_evidence
           ON route_evidence.source_id=route_source.source_id
         JOIN knowledge_interpretations i
           ON i.interpretation_id=route_evidence.interpretation_id`
      : route === 'exact_target'
        ? `json_each(?) route_target
           CROSS JOIN knowledge_interpretations i INDEXED BY knowledge_interpretation_target
             ON i.target_kind=json_extract(route_target.value,'$.kind')
            AND i.target_id=json_extract(route_target.value,'$.entity_id')
            AND i.target_revision_id=json_extract(route_target.value,'$.revision_id')`
        : route === 'project'
          ? 'knowledge_interpretations i INDEXED BY knowledge_interpretation_scope'
          : 'knowledge_interpretations i';
  if (route === 'source') {
    conditions[0] = `route_source.source_kind='capture_field'
      AND route_source.event_id IN (SELECT value FROM json_each(?))`;
  }
  const from = `FROM ${sourceJoin} JOIN operations o ON o.operation_id=i.operation_id`;
  const where = `WHERE ${conditions.join(' AND ')} AND o.committed_write_sequence<=?`;
  const total =
    view.get<{ total: number }>(
      `SELECT count(DISTINCT i.interpretation_id) AS total ${from} ${where}`,
      ...parameters,
      input.boundary
    )?.total ?? 0;
  if (limit === 0) return { total, rows: [] };
  const distinct = route === 'source' ? 'DISTINCT ' : '';
  const rows = view.all<RoutedRow>(
    `SELECT ${distinct}${ROUTED_COLUMNS} ${from} ${where}
     ORDER BY ${
       input.preferredFieldPaths?.length
         ? `coalesce((SELECT CAST(priority.key AS INTEGER)
       FROM json_each(?) priority JOIN knowledge_sources origin ON origin.source_id=i.origin_source_id
       WHERE replace(replace(origin.field_path,'[','.'),']','')=priority.value LIMIT 1),2147483647),`
         : ''
     }
       o.committed_write_sequence, i.interpretation_id LIMIT ?`,
    ...parameters,
    input.boundary,
    ...(input.preferredFieldPaths?.length
      ? [JSON.stringify(input.preferredFieldPaths.slice(0, 128))]
      : []),
    limit
  );
  return { total, rows };
}

function restrictedInterpretation(
  view: ProjectReadView,
  row: RoutedRow,
  boundary: number
): 'available' | 'restricted' | 'unreadable' {
  const sourceIds = new Set([row.origin_source_id]);
  for (const evidence of view.all<{ source_id: string }>(
    'SELECT source_id FROM knowledge_interpretation_evidence WHERE interpretation_id=? ORDER BY position',
    row.interpretation_id
  ))
    sourceIds.add(evidence.source_id);
  if (restrictedSourceLabels(view, [...sourceIds]).length > 0) return 'restricted';
  if (row.target_kind === null || row.target_id === null || row.target_revision_id === null)
    return 'available';
  const target = { kind: row.target_kind, entity_id: row.target_id };
  const state = interpretationCandidateSourceState(
    view,
    target,
    [row.target_revision_id],
    boundary
  );
  if (state.restrictions.length > 0) return 'restricted';
  return state.readable ? 'available' : 'unreadable';
}

function decoded<T>(text: string, parse: (value: unknown) => T | null): T | null {
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function readProjectKnowledgeInterpretations(
  view: ProjectReadView,
  input: ProjectInterpretationQuestion
): ProjectInterpretationRead {
  const identity = view.get<{ project_id: string }>(
    'SELECT project_id FROM store_identity WHERE singleton=1'
  );
  if (identity?.project_id !== input.projectId)
    invalid('Interpretations must be read from the named project');
  if (
    !Number.isSafeInteger(input.boundary) ||
    input.boundary < 0 ||
    input.boundary > knowledgeBoundaryAt(view)
  )
    invalid('Interpretations require a committed knowledge boundary');
  const maxEntries = input.maxEntries ?? 100;
  const maxBytes = input.maxBytes ?? 1_048_576;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > 1000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > 4_194_304
  )
    invalid('Interpretation reads require bounded entry and byte limits');
  const interpretations: ProjectKnowledgeInterpretation[] = [];
  const limits: InterpretationReadLimit[] = [];
  let bytes = 0;
  let scanned = 0;
  let decodedBytes = 0;
  for (const route of ROUTES) {
    const page = routePage(
      view,
      input,
      route,
      interpretations.length < maxEntries ? Math.max(0, 1000 - scanned) : 0
    );
    if (page.total === 0) continue;
    scanned += page.rows.length;
    const rows: RoutedRow[] = [];
    let restricted = 0;
    let unreadableTargets = 0;
    for (const row of page.rows) {
      const status = restrictedInterpretation(view, row, input.boundary);
      if (status === 'restricted') restricted += 1;
      else if (status === 'unreadable') unreadableTargets += 1;
      else rows.push(row);
    }
    let kept = 0;
    let unreadableRecords = 0;
    let examined = 0;
    for (const row of rows) {
      if (interpretations.length >= maxEntries) break;
      examined += 1;
      if (bytes + row.byte_length > maxBytes || decodedBytes + row.byte_length > 4_194_304)
        continue;
      decodedBytes += row.byte_length;
      const payload = view.get<{ payload: string }>(
        'SELECT CAST(record_bytes AS TEXT) AS payload FROM knowledge_interpretations WHERE interpretation_id=?',
        row.interpretation_id
      );
      const interpretation =
        payload === null
          ? null
          : decoded(payload.payload, (value) => {
              const parsed = KnowledgeInterpretationSchema.safeParse(value);
              return parsed.success ? parsed.data : null;
            });
      if (interpretation === null || interpretation.interpretation_id !== row.interpretation_id) {
        unreadableRecords += 1;
        continue;
      }
      const dispositionSize = view.get<{ byte_length: number }>(
        `SELECT length(d.record_bytes) AS byte_length
         FROM knowledge_equivalence_dispositions d JOIN operations o ON o.operation_id=d.operation_id
         WHERE d.interpretation_id=? AND o.committed_write_sequence<=?`,
        row.interpretation_id,
        input.boundary
      );
      const rejectionBytes = dispositionSize?.byte_length ?? 0;
      if (
        bytes + row.byte_length + rejectionBytes > maxBytes ||
        decodedBytes + rejectionBytes > 4_194_304
      )
        continue;
      decodedBytes += rejectionBytes;
      const disposition =
        dispositionSize === null
          ? null
          : view.get<{ payload: string }>(
              `SELECT CAST(d.record_bytes AS TEXT) AS payload
         FROM knowledge_equivalence_dispositions d JOIN operations o ON o.operation_id=d.operation_id
         WHERE d.interpretation_id=? AND o.committed_write_sequence<=?`,
              row.interpretation_id,
              input.boundary
            );
      const rejection =
        disposition === null
          ? null
          : decoded(disposition.payload, (value) => {
              const parsed = KnowledgeEquivalenceDispositionSchema.safeParse(value);
              return parsed.success ? parsed.data : null;
            });
      if (
        dispositionSize !== null &&
        (rejection === null || rejection.interpretation_id !== row.interpretation_id)
      ) {
        unreadableRecords += 1;
        continue;
      }
      const cost =
        row.byte_length + (disposition === null ? 0 : Buffer.byteLength(disposition.payload));
      if (bytes + cost > maxBytes) continue;
      interpretations.push({
        interpretation,
        route,
        writeSequence: row.write_sequence,
        rejection,
        equivalenceStatus:
          interpretation.canonical_outcome.kind === 'proposed_equivalence'
            ? rejection === null
              ? 'proposed'
              : 'rejected'
            : null,
      });
      bytes += cost;
      kept += 1;
    }
    const unreadable = unreadableTargets + unreadableRecords;
    const omitted = page.total - kept;
    const unexamined = page.total - restricted - unreadableTargets - examined;
    if (omitted > 0)
      limits.push({
        kind: 'interpretations_omitted',
        detail: `${omitted} interpretation(s) on route ${route} omitted: ${restricted} restricted, ${unreadable} unreadable, ${examined - kept - unreadableRecords} outside the byte bounds, ${unexamined} not examined within the read bounds.`,
      });
  }
  return { interpretations, limits };
}
