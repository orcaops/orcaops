import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '../../events/canonical-json.js';
import { ExecutionStateSchema } from '../execution-schema.js';
import {
  hydrateProjectLifecycleCompletions,
  selectProjectLifecycleCompletions,
} from './capture-lifecycles.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { ProjectFocusScope } from './execution-focus-input.js';
import {
  hydrateProjectExecutionFocus,
  prepareProjectFocusRead,
  readProjectExecutionFocus,
  selectProjectExecutionFocus,
} from './execution-focus.js';
import { ArtifactQueryDetailsSchema } from './query-metadata-records.js';
import {
  hydrateProjectArtifactRows,
  prepareProjectArtifactQuery,
  type ProjectArtifactQueryRow,
  selectProjectArtifactRows,
} from './query.js';
import { hydrateProjectUsageAccounting, selectProjectUsageAccounting } from './usage-accounting.js';

export interface ProjectTaskContextInput {
  branch?: string;
  worktreeId?: string;
  focusScope?: ProjectFocusScope;
}

export function readProjectTaskContext(handle: ProjectDatabase, raw: ProjectTaskContextInput = {}) {
  let input: ProjectTaskContextInput;
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !['branch', 'worktreeId', 'focusScope'].includes(key))
    )
      throw new Error('Invalid task context selectors');
    input = structuredClone(raw);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide fixed task context selectors', {
      cause,
    });
  }
  const query = prepareProjectArtifactQuery({
    branch: input.branch,
    worktreeId: input.worktreeId,
    profile: 'details',
  });
  assertProjectDatabasePath(handle);
  const scopeJson =
    input.focusScope === undefined ? null : prepareProjectFocusRead(handle, input.focusScope);
  const preflight =
    input.focusScope === undefined ? null : readProjectExecutionFocus(handle, input.focusScope);
  const focusedId = preflight?.status === 'present' ? preflight.pin.artifact_id : null;
  const snapshot = handle.read((view) => {
    const selected = selectProjectArtifactRows(view, query);
    const focus = scopeJson === null ? null : selectProjectExecutionFocus(view, scopeJson);
    const focused =
      focusedId === null || selected.rows.some((row) => row.artifactId === focusedId)
        ? null
        : selectProjectArtifactRows(view, { artifactIds: [focusedId], profile: 'details' });
    const lifecycles = selected.rows.map((row) => ({
      artifactId: row.artifactId,
      records: selectProjectLifecycleCompletions(view, row.artifactId),
    }));
    const usage: ReturnType<typeof selectProjectUsageAccounting>[] = [];
    const ids = selected.rows.map((row) => row.artifactId);
    for (let offset = 0; offset < ids.length; offset += 500)
      usage.push(selectProjectUsageAccounting(view, ids.slice(offset, offset + 500)));
    if (!ids.length) usage.push(selectProjectUsageAccounting(view, []));
    return { selected, focus, focused, lifecycles, usage };
  });
  const counters = snapshot.counters;
  const focus =
    scopeJson === null
      ? null
      : hydrateProjectExecutionFocus(scopeJson, { value: snapshot.value.focus, counters });
  if (
    preflight &&
    focus &&
    (preflight.status !== focus.status ||
      !isDeepStrictEqual(preflight.selection, focus.selection) ||
      (preflight.status === 'present' &&
        focus.status === 'present' &&
        (!preflight.pinBytes.equals(focus.pinBytes) || preflight.pinHash !== focus.pinHash)))
  )
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Session focus changed during task inspection; repeat the original selection'
    );
  const selected = hydrateProjectArtifactRows({ value: snapshot.value.selected, counters });
  try {
    const artifacts = selected.rows.map((row, index) => {
      return {
        ...decodeTaskArtifact(row),
        lifecycles: hydrateProjectLifecycleCompletions({
          value: snapshot.value.lifecycles[index].records,
          counters,
        }).records,
      };
    });
    const snapshots = new Map<
      string,
      ReturnType<typeof selectProjectUsageAccounting>['snapshots'][number]
    >();
    const links = new Map<
      string,
      ReturnType<typeof selectProjectUsageAccounting>['links'][number]
    >();
    for (const batch of snapshot.value.usage) {
      for (const row of batch.snapshots) {
        const previous = snapshots.get(row.eventId);
        if (previous && canonicalJson(previous) !== canonicalJson(row))
          throw new Error('Usage identity differs across selected batches');
        snapshots.set(row.eventId, row);
      }
      for (const row of batch.links) {
        const previous = links.get(row.eventId);
        if (previous && canonicalJson(previous) !== canonicalJson(row))
          throw new Error('Usage link identity differs across selected batches');
        links.set(row.eventId, row);
      }
    }
    const focusedRow =
      snapshot.value.focused === null
        ? null
        : hydrateProjectArtifactRows({ value: snapshot.value.focused, counters }).rows[0];
    if (focusedId && !focusedRow && !artifacts.some(({ row }) => row.artifactId === focusedId))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The original focused artifact is missing; preserve its retained history'
      );
    const focusedArtifact = focusedRow
      ? decodeTaskArtifact(focusedRow)
      : (artifacts.find(({ row }) => row.artifactId === focusedId) ?? null);
    return {
      artifacts,
      focusedArtifact,
      focus,
      counts: selected.counts,
      unknownAssociations: selected.unknownAssociations,
      usage: hydrateProjectUsageAccounting(
        handle.authority.projectId,
        artifacts.map(({ row }) => row.artifactId),
        {
          value: { snapshots: [...snapshots.values()], links: [...links.values()] },
          counters,
        }
      ),
      counters,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained task context is invalid; preserve history for explicit repair',
      { cause }
    );
  }
}

function decodeTaskArtifact(row: ProjectArtifactQueryRow) {
  const details = ArtifactQueryDetailsSchema.parse(JSON.parse(row.detailsJson!));
  const execution =
    row.executionJson === null ? null : ExecutionStateSchema.parse(JSON.parse(row.executionJson));
  if (
    (execution === null) !== (row.executionVersion === null) ||
    (execution &&
      (execution.artifact_id !== row.artifactId ||
        execution.binding_generation !== row.bindingGeneration))
  )
    throw new Error('Execution metadata differs from its selected artifact');
  return { row, details, execution };
}
