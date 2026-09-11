import { setTimeout as delay } from 'node:timers/promises';

import { prepareArtifactListingMetadata, replaceArtifactListingMetadata } from './artifacts.js';
import {
  assertProjectDatabasePath,
  claimProjectConnection,
  openProjectDatabase,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  readProjectCounters,
  rollbackProjectConnection,
  validateProjectIdentity,
} from './connection.js';
import {
  isDatabaseContention,
  isRetryableTransactionFailure,
  ProjectDatabaseError,
} from './errors.js';
import {
  replaceArtifactQueryMetadata,
  replaceExecutionQueryMetadata,
} from './query-metadata-records.js';
import { prepareProjectQueryMetadata } from './query-metadata-snapshot.js';
import { validateProjectSchemaDefinition } from './schema-validation.js';
import { replaceArtifactSearchRows } from './search-records.js';
import type { ProjectOperationOptions, ProjectWait } from './transactions.js';

export interface ProjectQueryRebuildResult {
  artifactCount: number;
  executionCount: number;
  counters: ProjectCounters;
}
const queryTables = [
  'artifact_plan_step_history',
  'artifact_query_metadata',
  'execution_query_metadata',
  'execution_query_branches',
  'artifact_search_sources',
  'artifact_search_state',
  'artifact_touched_files',
  'artifact_metadata',
  'artifact_branches',
] as const;
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Query rebuild cancelled before commit; retry the explicit rebuild if still wanted'
    );
}
async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (cause) {
    cancelled(signal);
    throw cause;
  }
  cancelled(signal);
}

function closeRebuild(handle: ProjectDatabase, committed: boolean, failure?: unknown): void {
  try {
    handle.close();
  } catch (closeFailure) {
    if (committed) return;
    throw new ProjectDatabaseError(
      failure instanceof ProjectDatabaseError ? failure.code : 'TRANSACTION_FAILED',
      failure instanceof ProjectDatabaseError
        ? failure.message
        : 'Rebuild connection could not close; inspect storage before retrying',
      {
        cause: new AggregateError(
          failure === undefined ? [closeFailure] : [failure, closeFailure],
          'Rebuild and connection close failed'
        ),
      }
    );
  }
}

export async function rebuildProjectQueryMetadata(
  input: { authority: ProjectDatabaseAuthority; authorize: () => void },
  options: ProjectOperationOptions = {}
): Promise<ProjectQueryRebuildResult> {
  const authority = Object.freeze({ ...input.authority });
  const signal = options.signal;
  const observer = options.onWait;
  const authorized: unknown = input.authorize();
  if (authorized !== undefined)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Rebuild authorization and refusal checks must finish synchronously before opening storage'
    );
  cancelled(signal);
  const handle = await openProjectDatabase({ authority, mode: 'writer', signal });
  let state;
  let prepared: Awaited<ReturnType<typeof prepareProjectQueryMetadata>>;
  let listings: { row: ReturnType<typeof prepareArtifactListingMetadata>; branches: string[] }[];
  try {
    prepared = await prepareProjectQueryMetadata(handle, signal);
    listings = prepared.artifacts.map(({ snapshot }) => ({
      row: prepareArtifactListingMetadata(snapshot.thread),
      branches: [
        ...new Set(snapshot.thread.artifactJson!.branch_lineage.map((entry) => entry.branch)),
      ],
    }));
    state = claimProjectConnection(handle);
  } catch (cause) {
    const failure =
      cause instanceof ProjectDatabaseError
        ? cause
        : new ProjectDatabaseError(
            signal?.aborted ? 'CANCELLED' : 'TRANSACTION_FAILED',
            signal?.aborted
              ? 'Query preparation cancelled; no indexes changed'
              : 'Query preparation failed; correct the cause or preserve storage for explicit repair before retrying',
            { cause }
          );
    closeRebuild(handle, false, failure);
    throw failure;
  }
  const database = state.database;
  let wroteWait = false;
  let committed = false;
  let failure: unknown;
  const waiting = (reason: ProjectWait['reason'], attempt: number) => {
    if (observer) observer({ operation: 'query.rebuild', reason, attempt });
    else if (process.stderr.isTTY) {
      process.stderr.write(
        `\r${['|', '/', '-', String.fromCharCode(92)][attempt % 4]} Waiting for query.rebuild; Ctrl-C to cancel. `
      );
      wroteWait = true;
    } else if (!wroteWait) {
      process.stderr.write('Waiting for query.rebuild; Ctrl-C to cancel.\n');
      wroteWait = true;
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let admission = 0; ; admission++) {
        cancelled(signal);
        assertProjectDatabasePath(handle);
        try {
          database.exec('BEGIN IMMEDIATE');
          break;
        } catch (cause) {
          if (database.inTransaction || !isDatabaseContention(cause)) throw cause;
          waiting('admission', admission + 1);
          await pause(25, signal);
        }
      }
      try {
        cancelled(signal);
        validateProjectIdentity(database, authority);
        validateProjectSchemaDefinition(database, prepared.schemaVersion);
        const counters = readProjectCounters(database);
        if (counters.writeSequence !== prepared.counters.writeSequence)
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'History changed after query preparation; retry the explicit rebuild against current history'
          );
        const transaction = {
          run: (sql: string, ...parameters: unknown[]) => database.prepare(sql).run(...parameters),
        };
        for (const table of queryTables) database.exec(`DELETE FROM ${table}`);
        for (const listing of listings)
          replaceArtifactListingMetadata(transaction, listing.row, listing.branches);
        for (const artifact of prepared.artifacts) {
          replaceArtifactSearchRows(transaction, artifact.search);
          replaceArtifactQueryMetadata(transaction, artifact.query);
        }
        for (const execution of prepared.executions)
          replaceExecutionQueryMetadata(transaction, execution);
        cancelled(signal);
        assertProjectDatabasePath(handle);
        database.exec('COMMIT');
        committed = true;
        return {
          artifactCount: prepared.artifacts.length,
          executionCount: prepared.executions.length,
          counters,
        };
      } catch (cause) {
        rollbackProjectConnection(state, cause);
        if (cause instanceof ProjectDatabaseError) throw cause;
        if (!isRetryableTransactionFailure(cause)) throw cause;
        if (attempt === 2)
          throw new ProjectDatabaseError(
            'TRANSACTION_RETRY_EXHAUSTED',
            'Query rebuild retries exhausted; retry the explicit rebuild after contention is resolved',
            { cause }
          );
        waiting('transaction-retry', attempt + 1);
        await pause(attempt === 0 ? 25 : 100, signal);
      }
    }
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'Query rebuild produced no result; inspect storage before retrying'
    );
  } catch (cause) {
    try {
      rollbackProjectConnection(state, cause);
    } catch (rollbackFailure) {
      failure = rollbackFailure;
      throw rollbackFailure;
    }
    failure =
      cause instanceof ProjectDatabaseError
        ? cause
        : new ProjectDatabaseError(
            'TRANSACTION_FAILED',
            'Query rebuild failed; correct the cause or preserve storage for explicit repair before retrying',
            { cause }
          );
    throw failure;
  } finally {
    state.busy = false;
    closeRebuild(handle, committed, failure);
    if (wroteWait && process.stderr.isTTY) {
      try {
        process.stderr.write('\n');
      } catch {
        /* Progress cannot replace a committed rebuild. */
      }
    }
  }
}
