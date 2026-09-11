import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { isUuidV7 } from '@orcaops/storage';
import {
  type HistoryRoot,
  inspectHistoryPath,
  normalizeHistoryRoot,
} from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  ProjectDatabaseError,
  type ProjectInitialization,
  type ProjectInitializationCandidate,
  readProjectInitialization,
  readProjectInitializationCandidate,
  readProjectInitializationObservation,
} from '@orcaops/storage/history/database';

import { closeSetupDatabase } from './close.js';
import { databaseSetupError } from './errors.js';
import { inspectDatabaseFilesystem } from '../context/filesystem.js';
import {
  type DatabaseGitContext,
  type DatabaseGitInventory,
  enumerateDatabaseGitContexts,
  resolveDatabaseGitContext,
  revalidateDatabaseGitContext,
  sameRepositoryCreation,
} from '../context/git-context.js';
import { type BootstrapPresence, inspectBootstrapInventory } from '../presence.js';
import {
  isPreparedCatalogEntryName,
  preparedRegistrationTarget,
} from '../registration-files-publication.js';
import {
  readProjectCatalogEntry,
  readRepositoryRegistration,
  readWorktreeRegistration,
  type RepositoryRegistration,
  type WorktreeRegistration,
} from '../registration-files.js';

export interface DatabaseSetupInspection {
  readonly state: 'fresh' | 'unregistered' | 'registered';
  readonly root: HistoryRoot;
  readonly context: DatabaseGitContext;
  readonly initialization: ProjectInitialization | ProjectInitializationCandidate | null;
  readonly registration: RepositoryRegistration | null;
  readonly worktree: WorktreeRegistration | null;
  readonly presence: BootstrapPresence<DatabaseGitInventory> | null;
}
interface InitializationPathIdentity {
  readonly path: string;
  readonly kind: 'database' | 'directory';
  readonly dev: bigint;
  readonly ino: bigint;
}
class UnsettledInitializationError extends ProjectDatabaseError {
  constructor(
    readonly projectId: string,
    readonly identity: InitializationPathIdentity,
    cause: ProjectDatabaseError
  ) {
    super(cause.code, cause.message, { cause });
  }
}
class CompetingInitializationsError extends ProjectDatabaseError {}
function unsettledCandidate(cause: unknown): cause is ProjectDatabaseError {
  return (
    cause instanceof ProjectDatabaseError &&
    (cause.code === 'ACTIVATION_PENDING' ||
      cause.code === 'HISTORY_MISSING' ||
      (cause.code === 'HISTORY_INACCESSIBLE' && cause.reason === 'contention'))
  );
}
async function initializationPathIdentity(root: HistoryRoot, projectId: string) {
  const directory = path.join(root.resolvedRoot, 'projects', projectId);
  const database = path.join(directory, 'history.sqlite3');
  for (const [candidate, kind] of [
    [database, 'database'],
    [directory, 'directory'],
  ] as const) {
    const info = await lstat(candidate, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
      throw cause;
    });
    if (info) return { path: candidate, kind, dev: info.dev, ino: info.ino };
  }
  return null;
}
function changedInitialization(): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'HISTORY_MISSING',
    'The occupied initialization changed or disappeared; preserve remaining evidence and use explicit repair'
  );
}
async function validateInitializationPathIdentity(identity: InitializationPathIdentity) {
  const current = await lstat(identity.path, { bigint: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
      throw cause;
    }
  );
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino)
    throw changedInitialization();
}
async function readDiscoveredCandidate(root: HistoryRoot, projectId: string) {
  const identity = await initializationPathIdentity(root, projectId);
  try {
    return await readProjectInitializationCandidate({
      root: root.resolvedRoot,
      projectId,
      expectedMainFileIdentity: identity?.kind === 'database' ? identity : undefined,
    });
  } catch (cause) {
    if (!unsettledCandidate(cause)) throw cause;
    const databaseObservation = readProjectInitializationObservation(cause);
    const observedIdentity: InitializationPathIdentity | null = databaseObservation
      ? { ...databaseObservation, kind: 'database' }
      : identity;
    if (!observedIdentity) throw cause;
    await validateInitializationPathIdentity(observedIdentity);
    throw new UnsettledInitializationError(projectId, observedIdentity, cause);
  }
}
export function unsettledInitialization(cause: unknown):
  | {
      readonly projectId: string;
      readonly identity: InitializationPathIdentity;
    }
  | undefined {
  return cause instanceof UnsettledInitializationError
    ? { projectId: cause.projectId, identity: cause.identity }
    : undefined;
}
export function competingInitializations(cause: unknown): boolean {
  return cause instanceof CompetingInitializationsError;
}
export async function validateSettledForeignInitialization(
  state: DatabaseSetupInspection,
  observation: NonNullable<ReturnType<typeof unsettledInitialization>>
): Promise<void> {
  // A later readable project proves a foreign initializer settled only if the exact
  // filesystem object that produced the pending observation is still authoritative.
  await validateInitializationPathIdentity(observation.identity);
  const candidate = await readProjectInitializationCandidate({
    root: state.root.resolvedRoot,
    projectId: observation.projectId,
    expectedMainFileIdentity:
      observation.identity.kind === 'database' ? observation.identity : undefined,
  });
  await validateInitializationPathIdentity(observation.identity);
  const creation = candidate.repositoryCreation;
  if (!creation)
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'The settled project lacks original repository creation evidence; inspect its ownership before initializing another project'
    );
  if (creation.commonDirectory === state.context.commonDir) {
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Setup observed its own initialization as fresh; preserve it for explicit identity repair'
    );
  }
  if (
    creation.device === state.context.repositoryCreation.device &&
    creation.inode === state.context.repositoryCreation.inode &&
    creation.birthtimeNs === state.context.repositoryCreation.birthtimeNs
  )
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Unregistered repository administration moved from its original locator; use explicit identity repair'
    );
}
export async function readValidatedSetupRegistration(
  context: DatabaseGitContext,
  root: HistoryRoot,
  projectId?: string
): Promise<DatabaseSetupInspection | null> {
  const registration = await readRepositoryRegistration({
    commonDir: context.commonDir,
    requestedRoot: root,
  });
  if (!registration) return null;
  if (projectId && registration.authority.project_id !== projectId)
    throw new ProjectDatabaseError(
      'IDENTITY_CONFLICT',
      'Repository registration identifies another project; select its original project or repair identity explicitly'
    );
  const authority = {
    resolvedRoot: registration.authority.resolved_root,
    rootKey: registration.authority.root_key,
    projectId: registration.authority.project_id,
    storeInstanceId: registration.authority.store_instance_id,
    repositoryInstanceId: registration.repository_instance_id,
  };
  await readProjectInitializationCandidate({
    root: root.resolvedRoot,
    projectId: authority.projectId,
  });
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  let initialization;
  let failure: unknown;
  try {
    initialization = readProjectInitialization(handle);
    if (initialization.initializationOperationId !== registration.initialization_operation_id)
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'Registration does not certify the original initialization operation; preserve both for explicit repair'
      );
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    closeSetupDatabase(handle, failure);
  }
  const worktree = await readWorktreeRegistration({
    gitDir: context.gitDir,
    repositoryInstanceId: authority.repositoryInstanceId,
  });
  return {
    state: 'registered',
    root,
    context,
    initialization,
    registration,
    worktree,
    presence: null,
  };
}
async function discoverInitialization(
  context: DatabaseGitContext,
  root: HistoryRoot,
  projectId?: string
): Promise<ProjectInitializationCandidate | null> {
  const directory = path.join(root.resolvedRoot, 'projects');
  const info = await inspectHistoryPath(root.resolvedRoot, directory);
  if (!info) return null;
  if (!info.isDirectory())
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Project inventory is occupied by an unknown object; preserve it for explicit identity repair'
    );
  const entries = await readdir(directory);
  const ids = new Set<string>();
  const creations = new Map<string, { operation_id: string; created_at: string }>();
  for (const entry of entries) {
    if (entry === 'catalog') {
      const catalogDirectory = path.join(directory, entry);
      const catalogInfo = await inspectHistoryPath(root.resolvedRoot, catalogDirectory);
      if (!catalogInfo?.isDirectory())
        throw new ProjectDatabaseError(
          'HISTORY_INACCESSIBLE',
          'Project catalog cannot be inspected; preserve expected history and inspect storage access'
        );
      for (const name of await readdir(catalogDirectory)) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!isUuidV7(id)) {
          // A publication in flight, and the leftover an interrupted publisher left behind,
          // are this publisher's own temporaries: preserved untouched, never adopted, and
          // never a reason to refuse. Only a name nobody here could have written is unknown.
          if (isPreparedCatalogEntryName(name)) continue;
          throw new ProjectDatabaseError(
            'IDENTITY_RECOVERY_REQUIRED',
            'Catalog contains unknown publication evidence; inspect original publications before setup'
          );
        }
        const value = await readProjectCatalogEntry({ root, projectId: id });
        if (!value)
          throw new ProjectDatabaseError(
            'HISTORY_MISSING',
            'An enumerated catalog publication disappeared; preserve expected history and retry inspection'
          );
        ids.add(id);
        creations.set(id, value.creation);
      }
    } else {
      if (!isUuidV7(entry))
        throw new ProjectDatabaseError(
          'IDENTITY_RECOVERY_REQUIRED',
          'Project inventory contains unknown ownership; preserve it for explicit identity repair'
        );
      ids.add(entry);
    }
  }
  const matches = [];
  for (const id of ids) {
    const candidate = await readDiscoveredCandidate(root, id);
    const published = creations.get(id);
    if (
      published &&
      (published.operation_id !== candidate.initializationOperationId ||
        published.created_at !== candidate.initializedAt)
    )
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'Catalog creation does not identify the original database initialization; preserve both records for explicit repair'
      );
    const creation = candidate.repositoryCreation;
    if (!creation)
      throw new ProjectDatabaseError(
        'IDENTITY_RECOVERY_REQUIRED',
        'An existing project lacks original repository creation evidence; inspect its ownership before initializing another project'
      );
    if (creation.commonDirectory !== context.commonDir) {
      if (
        creation.device === context.repositoryCreation.device &&
        creation.inode === context.repositoryCreation.inode &&
        creation.birthtimeNs === context.repositoryCreation.birthtimeNs
      )
        throw new ProjectDatabaseError(
          'IDENTITY_RECOVERY_REQUIRED',
          'Unregistered repository administration moved from its original locator; use explicit identity repair'
        );
      continue;
    }
    if (!sameRepositoryCreation(creation, context.repositoryCreation))
      throw new ProjectDatabaseError(
        'IDENTITY_RECOVERY_REQUIRED',
        'The original Git directory was replaced at this pathname; preserve unrelated initialization and repair ownership explicitly'
      );
    if (projectId && projectId !== candidate.authority.projectId)
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'Original unregistered initialization identifies a different project; select its retained project identity'
      );
    matches.push(candidate);
  }
  if (matches.length > 1)
    throw new CompetingInitializationsError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Several unregistered initializations match this repository; preserve them and use explicit identity repair'
    );
  return matches[0] ?? null;
}
/**
 * Whether the requested project directory holds a publication this repository is making.
 * A directory with no committed initialization is one; a directory whose committed
 * initialization was created by another Git administration is a foreign project that
 * happens to occupy the requested identity, and it keeps its own refusal. Discovery
 * tolerates such a project rather than matching it, so the proof is the first place that
 * sees it and must not read it as this repository's work in progress.
 */
async function publishingRequestedProject(
  root: HistoryRoot,
  projectId: string,
  context: DatabaseGitContext
): Promise<boolean> {
  let candidate;
  try {
    candidate = await readProjectInitializationCandidate({ root: root.resolvedRoot, projectId });
  } catch (cause) {
    if (
      cause instanceof ProjectDatabaseError &&
      (cause.code === 'ACTIVATION_PENDING' || cause.code === 'HISTORY_MISSING')
    )
      return true;
    throw cause;
  }
  const creation = candidate.repositoryCreation;
  return !!creation && sameRepositoryCreation(creation, context.repositoryCreation);
}
/**
 * Whether every presence the proof reported belongs to a canonical installation this
 * repository is still publishing: the requested project directory before its
 * initialization commits, and a registration marker directory holding nothing but the
 * create-once marker and its own temporaries. Neither is retained installation presence,
 * and neither may be answered with the conversion path.
 */
async function publishingInitialization(
  presence: BootstrapPresence<DatabaseGitInventory>,
  root: HistoryRoot,
  projectId: string | undefined,
  context: DatabaseGitContext
): Promise<boolean> {
  let publishing = false;
  for (const check of presence.checked) {
    if (check.state === 'absent') continue;
    if (
      projectId &&
      check.context_id === root.rootKey &&
      check.relative_location === path.join('projects', projectId)
    ) {
      if (!(await publishingRequestedProject(root, projectId, context))) return false;
      publishing = true;
      continue;
    }
    if (check.relative_location !== 'orcaops') return false;
    const marker = 'registration.json';
    // The directory was observed present a moment ago; if it is gone now there is no
    // installation evidence in it either way.
    const entries = await readdir(path.join(check.context_id, 'orcaops')).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return [] as string[];
        throw cause;
      }
    );
    if (!entries.every((name) => name === marker || preparedRegistrationTarget(name) === marker))
      return false;
    publishing = true;
  }
  return publishing;
}
export async function inspectDatabaseSetup(
  input: { cwd: string; root: string; projectId?: string },
  options: { signal?: AbortSignal } = {}
): Promise<DatabaseSetupInspection> {
  const cwd = input.cwd;
  const selectedRoot = input.root;
  const projectId = input.projectId;
  const signal = options.signal;
  try {
    if (
      typeof cwd !== 'string' ||
      !cwd ||
      typeof selectedRoot !== 'string' ||
      !selectedRoot ||
      (projectId !== undefined && !isUuidV7(projectId))
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Provide a checkout, selected data root and optional valid project identity'
      );
    signal?.throwIfAborted();
    const root = await normalizeHistoryRoot({ root: selectedRoot });
    const context = await resolveDatabaseGitContext({ cwd, signal });
    const registered = await readValidatedSetupRegistration(context, root, projectId);
    if (registered) {
      await revalidateDatabaseGitContext(context, signal);
      signal?.throwIfAborted();
      return registered;
    }
    let candidate: ProjectInitializationCandidate | null = null;
    let failure: unknown;
    try {
      candidate = await discoverInitialization(context, root, projectId);
    } catch (cause) {
      failure = cause;
    }
    const winner = await readValidatedSetupRegistration(context, root, projectId);
    if (winner) {
      await revalidateDatabaseGitContext(context, signal);
      signal?.throwIfAborted();
      return winner;
    }
    if (failure) throw failure;
    await revalidateDatabaseGitContext(context, signal);
    signal?.throwIfAborted();
    if (candidate)
      return {
        state: 'unregistered',
        root,
        context,
        initialization: candidate,
        registration: null,
        worktree: null,
        presence: null,
      };
    const inventory = await enumerateDatabaseGitContexts(context, signal);
    const presence = await inspectBootstrapInventory({ context, root, projectId }, inventory);
    const finalWinner = await readValidatedSetupRegistration(context, root, projectId);
    if (finalWinner) {
      await revalidateDatabaseGitContext(context, signal);
      signal?.throwIfAborted();
      return finalWinner;
    }
    if (!presence.history_fresh) {
      if (presence.unresolved.length)
        throw new ProjectDatabaseError(
          'IDENTITY_RECOVERY_REQUIRED',
          'Bootstrap presence cannot establish original ownership; inspect unavailable or unclassified evidence before setup'
        );
      throw (await publishingInitialization(presence, root, projectId, context))
        ? new ProjectDatabaseError(
            'ACTIVATION_PENDING',
            'A canonical installation is published but incomplete; retry the original setup or use explicit repair, preserving its existing evidence'
          )
        : new ProjectDatabaseError(
            'CONVERSION_REQUIRED',
            'Existing installation presence requires the documented conversion path; preserve existing history'
          );
    }
    await inspectDatabaseFilesystem(root.resolvedRoot, signal);
    await revalidateDatabaseGitContext(context, signal);
    signal?.throwIfAborted();
    return {
      state: 'fresh',
      root,
      context,
      initialization: null,
      registration: null,
      worktree: null,
      presence,
    };
  } catch (cause) {
    if (signal?.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Setup inspection cancelled before publication; retry only if still wanted',
        { cause }
      );
    throw databaseSetupError(cause);
  }
}
