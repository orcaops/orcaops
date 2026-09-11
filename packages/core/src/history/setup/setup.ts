import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { uuidv7 } from '@orcaops/storage';
import {
  initializeRepositoryDatabase,
  openProjectDatabase,
  ProjectDatabaseError,
  type ProjectDatabaseErrorCode,
  type ProjectInitialization,
  readProjectDisplayName,
  readProjectInitialization,
  retainProjectDisplayName,
} from '@orcaops/storage/history/database';

import { closeSetupDatabase } from './close.js';
import { createDatabaseSetupDirectory } from './directories.js';
import { databaseSetupError } from './errors.js';
import {
  prepareDatabaseSetupInput,
  refuseSetupSecrets,
  type SetupProjectDatabaseInput,
} from './input.js';
import {
  competingInitializations,
  type DatabaseSetupInspection,
  inspectDatabaseSetup,
  readValidatedSetupRegistration,
  unsettledInitialization,
  validateSettledForeignInitialization,
} from './inspection.js';
import { suggestRepositoryDisplayName } from './project-name.js';
import { inspectDatabaseFilesystem } from '../context/filesystem.js';
import { revalidateDatabaseGitContext } from '../context/git-context.js';
import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
  publishWorktreeRegistration,
  readWorktreeRegistration,
  type RepositoryRegistration,
  type WorktreeRegistration,
} from '../registration-files.js';

export type { SetupProjectDatabaseInput } from './input.js';
export interface DatabaseSetupWait {
  readonly operation: 'initialize project history';
  readonly attempt: number;
  readonly elapsedMs: number;
}
export interface DatabaseSetupResult {
  readonly status: 'complete' | 'partial';
  readonly initialization: ProjectInitialization;
  readonly registration: RepositoryRegistration;
  readonly worktree: WorktreeRegistration | null;
  readonly pending: ReadonlyArray<{
    resource: 'catalog' | 'worktree';
    code: ProjectDatabaseErrorCode;
    message: string;
  }>;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Setup cancelled before publication; preserve any original initialization and retry explicitly when ready'
    );
}
async function admitWrites(state: DatabaseSetupInspection, signal?: AbortSignal): Promise<void> {
  for (const directory of new Set([
    state.root.resolvedRoot,
    state.context.commonDir,
    state.context.gitDir,
  ]))
    await inspectDatabaseFilesystem(directory, signal);
  await revalidateDatabaseGitContext(state.context, signal);
  cancelled(signal);
}
/**
 * An observation that cannot yet decide the question, as opposed to a verdict about
 * ownership: an initialization that has not committed, its directory before the database
 * is created, and a canonical database another writer is holding. Missing history stays
 * missing if the wait expires; it never authorizes replacement initialization.
 */
function unsettledObservation(cause: unknown): cause is ProjectDatabaseError {
  return (
    (cause instanceof ProjectDatabaseError &&
      (cause.code === 'ACTIVATION_PENDING' ||
        cause.code === 'HISTORY_MISSING' ||
        (cause.code === 'HISTORY_INACCESSIBLE' && cause.reason === 'contention'))) ||
    competingInitializations(cause)
  );
}
async function waitForInitialization(
  input: SetupProjectDatabaseInput,
  signal: AbortSignal | undefined,
  onWait: ((wait: DatabaseSetupWait) => void) | undefined,
  initialCause?: ProjectDatabaseError
): Promise<DatabaseSetupInspection> {
  const start = performance.now();
  let attempt = 0;
  let observed = initialCause;
  let registrationRequired = competingInitializations(initialCause);
  const initializations = new Map<
    string,
    NonNullable<ReturnType<typeof unsettledInitialization>>
  >();
  function retainInitialization(
    initialization: NonNullable<ReturnType<typeof unsettledInitialization>>
  ) {
    const existing = initializations.get(initialization.identity.path);
    if (
      existing &&
      (existing.projectId !== initialization.projectId ||
        existing.identity.dev !== initialization.identity.dev ||
        existing.identity.ino !== initialization.identity.ino)
    )
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The occupied initialization changed or disappeared; preserve remaining evidence and use explicit repair'
      );
    if (!existing) initializations.set(initialization.identity.path, initialization);
  }
  const initialInitialization = unsettledInitialization(initialCause);
  let unscopedObservation = initialCause !== undefined && initialInitialization === undefined;
  if (initialInitialization) retainInitialization(initialInitialization);
  while (performance.now() - start < 2000) {
    cancelled(signal);
    const wait: DatabaseSetupWait = {
      operation: 'initialize project history',
      attempt: ++attempt,
      elapsedMs: performance.now() - start,
    };
    if (onWait) onWait(wait);
    else if (process.stderr.isTTY) process.stderr.write(`\rWaiting to ${wait.operation}…`);
    try {
      await delay(Math.min(100, attempt * 20), undefined, { signal });
    } catch {
      cancelled(signal);
    }
    try {
      const state = await inspectDatabaseSetup(input, { signal });
      if (state.state === 'fresh') {
        if (unscopedObservation || !initializations.size)
          throw new ProjectDatabaseError(
            'HISTORY_MISSING',
            'The occupied initialization disappeared; preserve remaining evidence and use explicit repair'
          );
        for (const initialization of initializations.values())
          await validateSettledForeignInitialization(state, initialization);
      }
      if (registrationRequired && state.state !== 'registered') continue;
      return state;
    } catch (cause) {
      if (!unsettledObservation(cause)) throw cause;
      if (competingInitializations(cause)) registrationRequired = true;
      const initialization = unsettledInitialization(cause);
      if (initialization) retainInitialization(initialization);
      else unscopedObservation = true;
      observed = cause;
    }
  }
  // The budget expiring never improves the diagnosis. Whatever the last observation was —
  // a contended database, a marker that is not a bounded regular file, one that changed
  // while it was read — it is reported exactly as it was seen, with its cause chain. The
  // generic message is only for a wait that observed nothing.
  if (observed) throw observed;
  throw new ProjectDatabaseError(
    'ACTIVATION_PENDING',
    'A collided initialization has not committed; retry the original setup or use explicit repair, preserving its occupied database'
  );
}
async function inspectSettledSetup(
  input: SetupProjectDatabaseInput,
  signal: AbortSignal | undefined,
  onWait: ((wait: DatabaseSetupWait) => void) | undefined
): Promise<DatabaseSetupInspection> {
  try {
    return await inspectDatabaseSetup(input, { signal });
  } catch (cause) {
    // A publication another initializer has not finished is not a refusal: the same
    // bounded wait that serves a witnessed collision adopts it once it commits, and still
    // reports what it observed when it does not.
    if (!unsettledObservation(cause)) throw cause;
    return waitForInitialization(input, signal, onWait, cause);
  }
}
export async function setupProjectDatabase(
  received: SetupProjectDatabaseInput,
  options: { signal?: AbortSignal; onWait?: (wait: DatabaseSetupWait) => void } = {}
): Promise<DatabaseSetupResult> {
  const input = prepareDatabaseSetupInput(received);
  const signal = options.signal;
  const onWait = options.onWait;
  let settled: DatabaseSetupInspection | null = null;
  try {
    cancelled(signal);
    let state = await inspectSettledSetup(input, signal, onWait);
    if (state.state === 'registered') settled = state;
    const displayName = await suggestRepositoryDisplayName(state.context.commonDir, signal);
    await admitWrites(state, signal);
    refuseSetupSecrets(
      { root: state.root, context: state.context.repositoryCreation },
      input.secretAllow
    );
    if (state.state !== 'registered') {
      if (state.state === 'fresh') {
        const authority = {
          ...state.root,
          projectId: input.projectId ?? uuidv7(),
          storeInstanceId: uuidv7(),
          repositoryInstanceId: uuidv7(),
        };
        const initializationOperationId = uuidv7();
        const initializedAt = new Date().toISOString();
        const earlyWinner = await readValidatedSetupRegistration(
          state.context,
          state.root,
          input.projectId
        );
        if (earlyWinner) state = earlyWinner;
        else {
          await revalidateDatabaseGitContext(state.context, signal);
          await createDatabaseSetupDirectory(
            state.root.resolvedRoot,
            path.join(state.root.resolvedRoot, 'projects', authority.projectId),
            signal
          );
          await revalidateDatabaseGitContext(state.context, signal);
          cancelled(signal);
          try {
            const handle = await initializeRepositoryDatabase({
              authority,
              initializationOperationId,
              initializedAt,
              repositoryCreation: state.context.repositoryCreation,
              authorize() {
                cancelled(signal);
                refuseSetupSecrets(input.authoredPayloads, input.secretAllow);
              },
            });
            let initialization;
            let failure: unknown;
            try {
              initialization = readProjectInitialization(handle);
            } catch (cause) {
              failure = cause;
              throw cause;
            } finally {
              closeSetupDatabase(handle, failure);
            }
            state = { ...state, state: 'unregistered', initialization };
          } catch (cause) {
            if (unsettledObservation(cause))
              state = await waitForInitialization(
                { ...input, projectId: authority.projectId },
                signal,
                onWait,
                cause
              );
            else if (cause instanceof ProjectDatabaseError && cause.code === 'IDENTITY_CONFLICT')
              state = await inspectSettledSetup(
                { ...input, projectId: authority.projectId },
                signal,
                onWait
              );
            else throw cause;
          }
        }
      }
      if (state.state !== 'registered') {
        if (!state.initialization)
          throw new ProjectDatabaseError(
            'IDENTITY_RECOVERY_REQUIRED',
            'No committed initialization was validated; preserve candidates for explicit repair'
          );
        await admitWrites(state, signal);
        refuseSetupSecrets(
          { root: state.root, context: state.context.repositoryCreation },
          input.secretAllow
        );
        try {
          const publication = await publishRepositoryRegistration({
            commonDir: state.context.commonDir,
            expected: state.initialization.authority,
            initializationOperationId: state.initialization.initializationOperationId,
            signal,
          });
          state = { ...state, state: 'registered', registration: publication.registration };
          settled = state;
        } catch (cause) {
          const winner = await readValidatedSetupRegistration(
            state.context,
            state.root,
            input.projectId
          );
          if (!winner) throw cause;
          state = winner;
          settled = winner;
        }
        const winner = await readValidatedSetupRegistration(
          state.context,
          state.root,
          input.projectId
        );
        if (!winner)
          throw new ProjectDatabaseError(
            'ACTIVATION_PENDING',
            'Published registration is not observable; preserve initialization and retry the original setup'
          );
        state = winner;
      }
    }
    settled = state;
    const initialization = state.initialization!;
    const registration = state.registration!;
    const nameReader = await openProjectDatabase({
      authority: initialization.authority,
      mode: 'reader',
    });
    let hasName: boolean;
    try {
      hasName = readProjectDisplayName(nameReader) !== null;
    } finally {
      nameReader.close();
    }
    if (!hasName) {
      const writer = await openProjectDatabase({
        authority: initialization.authority,
        mode: 'writer',
        signal,
      });
      try {
        await retainProjectDisplayName(writer, { operationId: uuidv7(), displayName }, { signal });
      } finally {
        writer.close();
      }
    }
    const pending: Array<{
      resource: 'catalog' | 'worktree';
      code: ProjectDatabaseErrorCode;
      message: string;
    }> = [];
    try {
      cancelled(signal);
      await revalidateDatabaseGitContext(state.context, signal);
      await publishProjectCatalogEntry({
        expected: initialization.authority,
        initializationOperationId: initialization.initializationOperationId,
        signal,
      });
    } catch (cause) {
      const error = databaseSetupError(cause);
      if (error.code !== 'HISTORY_UNWRITABLE') throw error;
      pending.push({ resource: 'catalog', code: error.code, message: error.message });
    }
    let worktree: WorktreeRegistration | null = state.worktree;
    try {
      cancelled(signal);
      await revalidateDatabaseGitContext(state.context, signal);
      const confirmed = await readValidatedSetupRegistration(
        state.context,
        state.root,
        initialization.authority.projectId
      );
      if (!confirmed?.initialization)
        throw new ProjectDatabaseError(
          'ACTIVATION_PENDING',
          'The known registration is no longer observable; preserve initialization and inspect it before retrying'
        );
      if (
        confirmed.initialization.authority.storeInstanceId !==
          initialization.authority.storeInstanceId ||
        confirmed.initialization.authority.repositoryInstanceId !==
          initialization.authority.repositoryInstanceId ||
        confirmed.initialization.initializationOperationId !==
          initialization.initializationOperationId ||
        confirmed.initialization.initializedAt !== initialization.initializedAt
      )
        throw new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'The known initialization changed before worktree publication; preserve both identities for explicit repair'
        );
      worktree = await readWorktreeRegistration({
        gitDir: state.context.gitDir,
        repositoryInstanceId: initialization.authority.repositoryInstanceId,
      });
      if (!worktree) {
        try {
          worktree = (
            await publishWorktreeRegistration({
              gitDir: state.context.gitDir,
              repositoryInstanceId: initialization.authority.repositoryInstanceId,
              worktreeId: uuidv7(),
              operationId: uuidv7(),
              signal,
            })
          ).registration;
        } catch (cause) {
          worktree = await readWorktreeRegistration({
            gitDir: state.context.gitDir,
            repositoryInstanceId: initialization.authority.repositoryInstanceId,
          });
          if (!worktree) throw cause;
        }
      }
    } catch (cause) {
      const error = databaseSetupError(cause);
      pending.push({ resource: 'worktree', code: error.code, message: error.message });
    }
    return {
      status: pending.length ? 'partial' : 'complete',
      initialization,
      registration,
      worktree,
      pending,
    };
  } catch (cause) {
    if (settled?.initialization && settled.registration) {
      const error = signal?.aborted
        ? new ProjectDatabaseError(
            'CANCELLED',
            'Secondary setup publication cancelled; retry using the retained registration'
          )
        : databaseSetupError(cause);
      return {
        status: 'partial',
        initialization: settled.initialization,
        registration: settled.registration,
        worktree: settled.worktree,
        pending: (['catalog', 'worktree'] as const).map((resource) => ({
          resource,
          code: error.code,
          message: error.message,
        })),
      };
    }
    if (signal?.aborted && !settled)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Setup cancelled before a complete registration was validated; preserve any initialization and retry explicitly',
        { cause }
      );
    throw databaseSetupError(cause);
  }
}
