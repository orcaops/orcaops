import path from 'node:path';
import { z } from 'zod';

import { isValidGlobSyntax } from '@orcaops/evaluator-protocol';

import { UuidV7Schema } from '../../ids/uuidv7.js';
import { CounterSchema, DigestSchema } from '../event-integrity.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { artifactActivityPredicate } from './query-activity.js';
import { assertQueryMetadataComplete } from './query-metadata-records.js';

const time = z.number().int().safe();
const text = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n\0]/u.test(value));
const inputSchema = z.strictObject({
  artifactIds: z.array(UuidV7Schema).optional(),
  worktreeId: UuidV7Schema.optional(),
  branch: text.refine((value) => value.trim().length > 0).optional(),
  origin: z.enum(['all', 'captured', 'imported']).default('all'),
  state: z.enum(['planned', 'active', 'blocked', 'summarized']).optional(),
  touching: text.optional(),
  sinceMs: time.optional(),
  untilMs: time.optional(),
  activeSinceMs: time.optional(),
  activeUntilMs: time.optional(),
  limit: CounterSchema.refine((value) => value > 0).optional(),
  offset: CounterSchema.default(0),
  profile: z.enum(['watch', 'details', 'provenance', 'versions']).default('watch'),
});
export type ProjectArtifactQuery = z.input<typeof inputSchema>;
const rowSchema = z.strictObject({
  artifactId: UuidV7Schema,
  generation: CounterSchema.refine((value) => value > 0),
  orderedHash: DigestSchema,
  eventCount: CounterSchema.refine((value) => value > 0),
  byteLength: CounterSchema.refine((value) => value > 0),
  tailEventId: UuidV7Schema,
  label: z.string().nullable(),
  task: z.string().nullable(),
  agent: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  startedAt: z.string(),
  startedMs: time.nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  bindingUpdatedAt: z.string().nullable(),
  bindingBranch: z.string().nullable(),
  state: z.enum(['planned', 'active', 'blocked', 'summarized']),
  origin: z.enum(['captured', 'git-import']),
  checkpointCount: CounterSchema,
  openCheckpointCount: CounterSchema,
  planRevisionCount: CounterSchema,
  planStepCount: CounterSchema,
  completedPlanStepCount: CounterSchema,
  executionVersion: CounterSchema.nullable(),
  bindingGeneration: CounterSchema.nullable(),
  currentWorktreeId: UuidV7Schema.nullable(),
  associationsUnknown: z.union([z.literal(0), z.literal(1)]),
  watchJson: z.string().nullable(),
  detailsJson: z.string().nullable(),
  provenanceJson: z.string().nullable(),
  executionJson: z.string().nullable(),
});
export type ProjectArtifactQueryRow = z.infer<typeof rowSchema>;
export function prepareProjectArtifactQuery(input: ProjectArtifactQuery) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide valid artifact query filters', {
      cause: parsed.error,
    });
  const value = parsed.data;
  if (value.touching !== undefined) {
    const normalized = value.touching.replace(/\\/gu, '/');
    if (
      !value.touching.trim() ||
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(value.touching) ||
      normalized.split('/').includes('..') ||
      !isValidGlobSyntax(value.touching)
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Touching requires a valid project-relative glob without parent traversal'
      );
  }
  for (const [lower, upper] of [
    [value.sinceMs, value.untilMs],
    [value.activeSinceMs, value.activeUntilMs],
  ])
    if (lower !== undefined && upper !== undefined && lower > upper)
      throw new ProjectDatabaseError('INVALID_INPUT', 'History time window is inverted');
  return value;
}
export function assertProjectArtifactQueryComplete(
  view: ProjectReadView,
  input: Pick<ProjectArtifactQuery, 'artifactIds' | 'activeSinceMs' | 'activeUntilMs'>
) {
  const ids = input.artifactIds === undefined ? null : JSON.stringify(input.artifactIds);
  if (
    view.get(
      `SELECT a.artifact_id FROM artifacts a LEFT JOIN artifact_revisions r
      ON r.artifact_id=a.artifact_id AND r.generation=a.current_generation
      WHERE r.artifact_id IS NULL AND (? IS NULL OR a.artifact_id IN (SELECT value FROM json_each(?))) LIMIT 1`,
      ids,
      ids
    )
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A selected original artifact revision is missing; preserve history for explicit repair'
    );
  assertQueryMetadataComplete(view, { artifactIds: input.artifactIds });
  if (
    (input.activeSinceMs !== undefined || input.activeUntilMs !== undefined) &&
    view.get(
      `SELECT q.artifact_id FROM artifact_query_metadata q WHERE
    (? IS NULL OR q.artifact_id IN (SELECT value FROM json_each(?))) AND
    (json_type(q.details_json,'$.activity') IS NOT 'object'
      OR json_type(q.details_json,'$.activity.checkpoints') IS NOT 'array'
      OR CASE WHEN json_type(q.details_json,'$.activity.startedAt')='text'
        THEN orcaops_history_time(json_extract(q.details_json,'$.activity.startedAt')) IS NULL ELSE 1 END
      OR CASE json_type(q.details_json,'$.activity.summaryAt')
        WHEN 'null' THEN 0
        WHEN 'text' THEN orcaops_history_time(json_extract(q.details_json,'$.activity.summaryAt')) IS NULL
        ELSE 1 END
      OR EXISTS (SELECT 1 FROM json_each(q.details_json,'$.activity.checkpoints') interval
        WHERE CASE WHEN interval.type='object' THEN
          CASE WHEN json_type(interval.value,'$.openedAt')='text'
            THEN orcaops_history_time(json_extract(interval.value,'$.openedAt')) IS NULL ELSE 1 END
          OR CASE json_type(interval.value,'$.endedAt')
            WHEN 'null' THEN 0
            WHEN 'text' THEN orcaops_history_time(json_extract(interval.value,'$.endedAt')) IS NULL
            ELSE 1 END
        ELSE 1 END)) LIMIT 1`,
      ids,
      ids
    )
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Activity query metadata is incomplete; explicitly rebuild from original records'
    );
}

const associated =
  'EXISTS (SELECT 1 FROM execution_associations s WHERE s.artifact_id=a.artifact_id AND s.worktree_id=?)';

export function projectArtifactQueryFilters(
  input: ReturnType<typeof prepareProjectArtifactQuery>,
  includeWorktree = true
) {
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  const add = (sql: string, ...values: Array<string | number>) => {
    clauses.push(sql);
    parameters.push(...values);
  };
  if (input.artifactIds !== undefined)
    add('a.artifact_id IN (SELECT value FROM json_each(?))', JSON.stringify(input.artifactIds));
  if (input.branch !== undefined)
    add(
      `(EXISTS (SELECT 1 FROM artifact_branches b WHERE b.artifact_id=a.artifact_id AND b.branch=?)
      OR EXISTS (SELECT 1 FROM execution_query_branches b WHERE b.artifact_id=a.artifact_id AND b.branch=?))`,
      input.branch,
      input.branch
    );
  if (input.origin !== 'all')
    add('m.origin_kind=?', input.origin === 'imported' ? 'git-import' : 'captured');
  if (input.state !== undefined) add('m.state=?', input.state);
  if (input.touching !== undefined)
    add(
      'EXISTS (SELECT 1 FROM artifact_touched_files f WHERE f.artifact_id=a.artifact_id AND orcaops_history_touching(f.file_path, ?)=1)',
      input.touching
    );
  if (input.sinceMs !== undefined) add('orcaops_history_time(m.started_at)>=?', input.sinceMs);
  if (input.untilMs !== undefined) add('orcaops_history_time(m.started_at)<=?', input.untilMs);
  const activity = artifactActivityPredicate(input.activeSinceMs, input.activeUntilMs);
  if (activity) add(activity.sql, ...activity.parameters);
  if (includeWorktree && input.worktreeId !== undefined) add(associated, input.worktreeId);
  return { where: clauses.length ? clauses.join(' AND ') : '1', parameters };
}

export function countUnknownProjectAssociations(
  view: ProjectReadView,
  input: ReturnType<typeof prepareProjectArtifactQuery>
): number {
  if (input.worktreeId === undefined) return 0;
  const unassociated = projectArtifactQueryFilters(input, false);
  return view.get<{ count: number }>(
    `SELECT count(*) AS count FROM artifacts a
    JOIN artifact_metadata m ON m.artifact_id=a.artifact_id
    LEFT JOIN execution_initializations i ON i.artifact_id=a.artifact_id
    WHERE ${unassociated.where} AND coalesce(i.associations_unknown,1)=1 AND NOT ${associated}`,
    ...unassociated.parameters,
    input.worktreeId
  )!.count;
}

export function selectProjectArtifactRows(view: ProjectReadView, raw: ProjectArtifactQuery = {}) {
  const input = prepareProjectArtifactQuery(raw);
  assertProjectArtifactQueryComplete(view, input);
  const from = `FROM artifacts a
    JOIN artifact_revisions r ON r.artifact_id=a.artifact_id AND r.generation=a.current_generation
    JOIN artifact_metadata m ON m.artifact_id=a.artifact_id
    JOIN artifact_query_metadata q ON q.artifact_id=a.artifact_id
    LEFT JOIN execution_initializations i ON i.artifact_id=a.artifact_id
    LEFT JOIN execution_current c ON c.artifact_id=a.artifact_id
    LEFT JOIN execution_query_metadata e ON e.artifact_id=a.artifact_id`;
  const unknownAssociations = countUnknownProjectAssociations(view, input);
  const { where, parameters } = projectArtifactQueryFilters(input);
  const counts = view.get<{ captured: number; imported: number }>(
    `SELECT coalesce(sum(m.origin_kind='captured'),0) AS captured,
      coalesce(sum(m.origin_kind='git-import'),0) AS imported ${from} WHERE ${where}`,
    ...parameters
  )!;
  const rows = view.all<ProjectArtifactQueryRow>(
    `SELECT a.artifact_id AS artifactId,r.generation,r.ordered_hash AS orderedHash,
      r.event_count AS eventCount,r.byte_length AS byteLength,r.tail_event_id AS tailEventId,
      ${input.profile === 'versions' ? 'NULL' : 'm.label'} AS label,
      ${input.profile === 'versions' ? 'NULL' : 'm.task'} AS task,
      m.agent,m.branch,m.base_sha AS baseSha,m.started_at AS startedAt,
      orcaops_history_time(m.started_at) AS startedMs,m.completed_at AS completedAt,m.updated_at AS updatedAt,
      e.binding_updated_at AS bindingUpdatedAt,e.binding_branch AS bindingBranch,
      m.state,m.origin_kind AS origin,
      m.checkpoint_count AS checkpointCount,m.open_checkpoint_count AS openCheckpointCount,
      m.plan_revision_count AS planRevisionCount,q.plan_step_count AS planStepCount,
      q.completed_plan_step_count AS completedPlanStepCount,c.version AS executionVersion,
      c.binding_generation AS bindingGeneration,c.current_worktree_id AS currentWorktreeId,
      coalesce(i.associations_unknown,1) AS associationsUnknown,
      ${input.profile === 'watch' ? 'q.watch_json' : 'NULL'} AS watchJson,
      ${input.profile === 'details' || input.profile === 'provenance' ? 'q.details_json' : 'NULL'} AS detailsJson,
      ${input.profile === 'provenance' ? 'q.provenance_json' : 'NULL'} AS provenanceJson,
      ${input.profile === 'details' ? 'e.state_json' : 'NULL'} AS executionJson
      ${from} WHERE ${where}
      ORDER BY startedMs IS NULL ASC, startedMs DESC, a.artifact_id COLLATE BINARY ASC LIMIT ? OFFSET ?`,
    ...parameters,
    input.limit ?? -1,
    input.offset
  );
  return { rows, counts, unknownAssociations };
}
export function queryProjectArtifacts(handle: ProjectDatabase, input: ProjectArtifactQuery = {}) {
  const prepared = prepareProjectArtifactQuery(input);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => selectProjectArtifactRows(view, prepared));
  return hydrateProjectArtifactRows(snapshot);
}

export function hydrateProjectArtifactRows(snapshot: {
  value: ReturnType<typeof selectProjectArtifactRows>;
  counters: ProjectCounters;
}) {
  try {
    return {
      ...snapshot.value,
      rows: snapshot.value.rows.map((row) => rowSchema.parse(row)),
      counters: snapshot.counters,
    };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Selected artifact query metadata is invalid; explicitly rebuild from original records',
      { cause }
    );
  }
}
