import { initializeUnboundExecution } from '../execution.js';
import {
  type AppendProjectArtifactEvents,
  composeArtifactAppend,
  type ProjectArtifactSnapshot,
  readProjectArtifact,
  restoreArtifactAppendRequest,
} from './artifacts.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { CaptureExecutionContext } from './execution-capture.js';
import {
  readProjectExecution,
  restoreExecutionRecords,
  settleExecutionRecords,
} from './execution-records.js';
import {
  prepareArtifactQueryMetadata,
  replaceArtifactQueryMetadata,
} from './query-metadata-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';

async function prepareImportedArtifactSettlement(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents
) {
  const prior: ProjectArtifactSnapshot | null =
    input.expectedRevision === null ? null : readProjectArtifact(handle, input.artifactId);
  const request = restoreArtifactAppendRequest(input);
  const composed = await composeArtifactAppend({
    projectId: handle.authority.projectId,
    request,
    prior,
    sourceSnapshot: { selection: null, record: null },
  });
  if (!composed.thread.plan)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An imported artifact has no captured plan to date its execution from; preserve it for explicit repair'
    );
  const query = await prepareArtifactQueryMetadata(composed.thread, composed.revision.generation);
  const previous = readProjectExecution(handle, input.artifactId);
  const execution = restoreExecutionRecords({
    state: previous
      ? previous.state
      : initializeUnboundExecution({
          artifactId: input.artifactId,
          operationId: input.operationId,
          reason: composed.thread.summary ? 'completed' : 'legacy_unknown',
          ts: composed.thread.plan.started_at,
          origin: composed.thread.plan.origin?.kind === 'git-import' ? 'git-import' : 'captured',
        }),
    artifactRevision: composed.revision,
    previous,
    operationId: input.operationId,
    secretAllow: [],
  });
  return {
    request,
    revision: composed.revision,
    artifactRevision: composed.revision,
    thread: composed.thread,
    previousExecutionVersion: previous?.version ?? null,
    settle(transaction: Parameters<typeof composed.settle>[0]) {
      const artifact = composed.settle(transaction);
      replaceArtifactQueryMetadata(transaction, query);
      settleExecutionRecords(transaction, execution);
      return artifact;
    },
  };
}

export async function prepareProjectImportedArtifactSettlement(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext }
) {
  const prepared = await prepareImportedArtifactSettlement(handle, input);
  const previous = readProjectExecution(handle, input.artifactId);
  if (
    prepared.thread.plan?.origin?.kind !== 'git-import' ||
    !prepared.thread.summary ||
    (input.execution.kind === 'create'
      ? previous !== null
      : previous === null ||
        previous.version !== input.execution.expectedVersion ||
        previous.state.binding_generation !== input.execution.expectedGeneration)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Imported retention requires the exact git-import artifact and unbound execution expectation'
    );
  return prepared;
}

/**
 * Append a single imported (git-import origin) artifact's events AND its unbound
 * execution record in one transaction — the per-artifact composition
 * `importProjectHistory` performs, exposed for the incremental seed writer.
 *
 * Imported history has no live execution binding, so the authored execution-capture
 * create path refuses a git-import origin. But a git-import artifact still carries an
 * unbound execution record (`execution_current` / `execution_initializations`), like
 * every artifact `importProjectHistory` writes: without it `readProjectExecution`
 * returns null and a later amend/revise/enrich through the execution-capture path
 * misclassifies or refuses the artifact. This settles the append, its query metadata,
 * and the unbound execution together so a seeded artifact is byte-for-byte the shape of
 * an imported one.
 *
 * `create` (expectedRevision null) and `resume` (an existing partial with no execution
 * record) both flow through here; the reason is derived from whether the composed thread
 * is complete.
 */
export async function appendProjectImportedArtifact(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents,
  options: ProjectOperationOptions = {}
) {
  const prepared = await prepareImportedArtifactSettlement(handle, input);
  return runProjectOperation(
    handle,
    { ...prepared.request.operation, kind: 'capture.append' },
    (transaction) => {
      prepared.settle(transaction);
      return { generation: prepared.revision.generation };
    },
    options
  );
}
