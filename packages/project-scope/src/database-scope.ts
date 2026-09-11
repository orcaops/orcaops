import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  type DatabaseHistoryContext,
  readDatabaseHistoryContext,
} from '@orcaops/core/history/database-read';
import {
  isPreparedCatalogEntryName,
  type ProjectCatalogEntry,
  readProjectCatalogEntry,
  type RepositoryRegistration,
} from '@orcaops/core/history/registration';
import { isUuidV7 } from '@orcaops/storage';
import {
  type HistoryRoot,
  inspectHistoryPath,
  normalizeHistoryRoot,
} from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  readProjectInitialization,
  readProjectInitializationCandidate,
} from '@orcaops/storage/history/database';

import { hasGitBoundary, validateHistorySelector } from './history-selector.js';
import {
  type HistoryCompleteness,
  type HistoryIssue,
  HistoryScopeError,
  type HistoryScopeInput,
  type HistoryScopeKind,
} from './history-types.js';

export interface DatabaseHistoryProject {
  projectId: string;
  authority: ProjectDatabaseAuthority | null;
  database: ProjectDatabase | null;
  completeness: HistoryCompleteness;
}
export interface DatabaseHistoryScope {
  root: HistoryRoot;
  kind: HistoryScopeKind;
  selection: 'default' | 'explicit';
  branch: { value: string | null; source: 'current' | 'explicit' | 'all' | 'unavailable' };
  gitContext: DatabaseHistoryContext['git'] | null;
  contextIssues: HistoryIssue[];
  projects: DatabaseHistoryProject[];
  completeness: HistoryCompleteness;
  close(): void;
}
function issue(cause: unknown, projectId: string | null, resource?: string): HistoryIssue {
  return {
    code: cause instanceof Error && 'code' in cause ? String(cause.code) : 'HISTORY_INACCESSIBLE',
    project_id: projectId,
    ...(resource ? { resource } : {}),
    message:
      cause instanceof Error
        ? cause.message
        : 'History cannot be inspected; check access and preserve existing history',
  };
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'History scope inspection cancelled');
}
async function inventory(root: HistoryRoot, issues: HistoryIssue[]) {
  const directory = path.join(root.resolvedRoot, 'projects');
  const ids = new Set<string>();
  const catalogIds = new Set<string>();
  const info = await inspectHistoryPath(root.resolvedRoot, directory);
  if (!info) return { ids, catalogIds };
  if (!info.isDirectory())
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Project inventory is not a directory; preserve it for explicit repair'
    );
  for (const entry of await readdir(directory)) {
    if (
      entry === '.DS_Store' &&
      (await inspectHistoryPath(root.resolvedRoot, path.join(directory, entry)))?.isFile()
    )
      continue;
    if (entry === 'catalog') {
      const catalog = path.join(directory, entry);
      try {
        const stat = await inspectHistoryPath(root.resolvedRoot, catalog);
        if (!stat?.isDirectory())
          throw new ProjectDatabaseError(
            'HISTORY_INACCESSIBLE',
            'Project catalog is unavailable; inspect its original publications'
          );
        for (const name of await readdir(catalog)) {
          if (
            name === '.DS_Store' &&
            (await inspectHistoryPath(root.resolvedRoot, path.join(catalog, name)))?.isFile()
          )
            continue;
          const id = name.endsWith('.json') ? name.slice(0, -5) : '';
          if (isUuidV7(id)) {
            ids.add(id);
            catalogIds.add(id);
          }
          // A publication in flight, and the leftover an interrupted publisher left behind,
          // are the catalog publisher's own temporaries. Reporting them as unknown ownership
          // would make discovery permanently incomplete while every database is healthy.
          else if (!isPreparedCatalogEntryName(name))
            issues.push(
              issue(
                new ProjectDatabaseError(
                  'IDENTITY_RECOVERY_REQUIRED',
                  'Catalog contains unknown ownership; preserve the entry for explicit repair'
                ),
                null,
                `catalog/${name}`
              )
            );
        }
      } catch (cause) {
        issues.push(issue(cause, null, 'catalog'));
      }
    } else if (isUuidV7(entry)) ids.add(entry);
    else
      issues.push(
        issue(
          new ProjectDatabaseError(
            'IDENTITY_RECOVERY_REQUIRED',
            'Project inventory contains unknown ownership; preserve the entry for explicit repair'
          ),
          null,
          entry
        )
      );
  }
  return { ids, catalogIds };
}
function registrationAuthority(registration: RepositoryRegistration): ProjectDatabaseAuthority {
  return {
    resolvedRoot: registration.authority.resolved_root,
    rootKey: registration.authority.root_key,
    projectId: registration.authority.project_id,
    storeInstanceId: registration.authority.store_instance_id,
    repositoryInstanceId: registration.repository_instance_id,
  };
}
function validateCatalog(
  catalog: ProjectCatalogEntry | null,
  initialized: { initializationOperationId: string; initializedAt: string }
) {
  if (
    catalog &&
    (catalog.creation.operation_id !== initialized.initializationOperationId ||
      catalog.creation.created_at !== initialized.initializedAt)
  )
    throw new ProjectDatabaseError(
      'IDENTITY_CONFLICT',
      'Catalog creation differs from committed initialization; preserve both records for explicit repair'
    );
}
async function hasLegacyOnlyLayout(root: HistoryRoot, projectId: string): Promise<boolean> {
  const directory = path.join(root.resolvedRoot, 'projects', projectId);
  if (!(await inspectHistoryPath(root.resolvedRoot, directory))?.isDirectory()) return false;
  const entries = await readdir(directory);
  // Old mirrors may remain after conversion; canonical evidence still requires its original database.
  if (entries.some((name) => name.startsWith('history.sqlite3') || name === 'history-format.json'))
    return false;
  if (!entries.includes('artifacts') || !entries.includes('usage')) return false;
  for (const name of ['artifacts', 'usage'])
    if (!(await inspectHistoryPath(root.resolvedRoot, path.join(directory, name)))?.isDirectory())
      return false;
  return true;
}

async function openProject(
  root: HistoryRoot,
  projectId: string,
  registration?: RepositoryRegistration,
  expectedCatalog = false
): Promise<DatabaseHistoryProject> {
  let database: ProjectDatabase | null = null;
  let authority: ProjectDatabaseAuthority | null = registration
    ? registrationAuthority(registration)
    : null;
  try {
    if (authority) {
      if (authority.resolvedRoot !== root.resolvedRoot || authority.rootKey !== root.rootKey)
        throw new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'Select the registered data root; a project read never relocates history'
        );
    }
    const catalog = await readProjectCatalogEntry({ root, projectId });
    if (expectedCatalog && !catalog)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'An observed catalog publication disappeared; preserve expected history and retry inspection'
      );
    if (!authority && !catalog && !expectedCatalog && (await hasLegacyOnlyLayout(root, projectId)))
      throw new HistoryScopeError(
        'LEGACY_HISTORY_PRESENT',
        'Legacy file history is present without a canonical database. Preview it with `orcaops history convert` from its original repository; if already converted, restore the original database.'
      );
    if (!authority) {
      const candidate = await readProjectInitializationCandidate({
        root: root.resolvedRoot,
        projectId,
      });
      authority = candidate.authority;
      validateCatalog(catalog, candidate);
    }
    database = await openProjectDatabase({ authority, mode: 'reader' });
    const initialized = readProjectInitialization(database);
    validateCatalog(catalog, initialized);
    if (
      registration &&
      registration.initialization_operation_id !== initialized.initializationOperationId
    )
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'Registration does not certify this initialization; preserve original authority for explicit repair'
      );
    return { projectId, authority, database, completeness: { complete: true, issues: [] } };
  } catch (cause) {
    try {
      database?.close();
    } catch (closing) {
      return {
        projectId,
        authority,
        database: null,
        completeness: {
          complete: false,
          issues: [issue(cause, projectId), issue(closing, projectId)],
        },
      };
    }
    return {
      projectId,
      authority,
      database: null,
      completeness: { complete: false, issues: [issue(cause, projectId)] },
    };
  }
}

export async function resolveDatabaseHistoryScope(
  raw: HistoryScopeInput & { signal?: AbortSignal } = {}
): Promise<DatabaseHistoryScope> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide a history scope selection object');
  const input = {
    ...raw,
    selector: { ...raw.selector },
    env: { ...(raw.env ?? process.env) },
    gitContext: raw.gitContext && structuredClone(raw.gitContext),
  };
  validateHistorySelector(input);
  cancelled(input.signal);
  const cwd = input.cwd ?? process.cwd();
  const selector = input.selector;
  const kind = selector.scope ?? 'project';
  const selection =
    selector.scope !== undefined || selector.projectId !== undefined ? 'explicit' : 'default';
  const root = await normalizeHistoryRoot({
    root: input.root,
    env: input.env,
    home: input.home,
    cwd,
  });
  const gitBoundary = await hasGitBoundary(cwd);
  const inGit = input.gitContext !== null && gitBoundary;
  if (!gitBoundary && kind !== 'all-projects' && !selector.projectId)
    throw new HistoryScopeError(
      'PROJECT_REQUIRED',
      'Outside a repository, select --project <id> or --scope all-projects'
    );
  const contextIssues: HistoryIssue[] = [];
  let context: DatabaseHistoryContext | null = null;
  if (inGit) {
    try {
      const current = await readDatabaseHistoryContext({ cwd, signal: input.signal });
      context = current;
      if (
        input.gitContext &&
        (['worktreeRoot', 'gitDir', 'commonDir', 'branch', 'headOid'] as const).some(
          (key) => input.gitContext![key] !== current.git[key]
        )
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Git context differs from the selected read context; retry the read'
        );
      if (context.headIssue)
        contextIssues.push(
          issue(context.headIssue, context.registration?.authority.project_id ?? null)
        );
      if (context.worktreeIssue)
        contextIssues.push(
          issue(context.worktreeIssue, context.registration?.authority.project_id ?? null)
        );
    } catch (cause) {
      cancelled(input.signal);
      contextIssues.push(issue(cause, selector.projectId ?? null));
      context = null;
    }
  }
  const currentId = context?.registration?.authority.project_id ?? null;
  const selectedId = selector.projectId ?? currentId;
  const sameProject =
    currentId !== null && (selector.projectId === undefined || selector.projectId === currentId);
  let gitContext = selector.projectId !== undefined && !sameProject ? null : (context?.git ?? null);
  let registration = sameProject ? (context?.registration ?? undefined) : undefined;
  if (
    kind === 'all-projects' &&
    registration &&
    (registration.authority.resolved_root !== root.resolvedRoot ||
      registration.authority.root_key !== root.rootKey)
  ) {
    contextIssues.push(
      issue(
        new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'Current repository uses another registered data root; these project reads do not attach it'
        ),
        currentId
      )
    );
    registration = undefined;
    gitContext = null;
  }
  if (kind === 'worktree' && !gitContext?.worktreeId)
    throw new HistoryScopeError(
      'WORKTREE_SCOPE_UNAVAILABLE',
      'Worktree scope requires its existing validated marker; use --scope project',
      { context: gitContext, issues: contextIssues }
    );
  if ((input.gitRange !== undefined || input.profile === 'git-history') && !gitContext)
    throw new HistoryScopeError(
      'GIT_CONTEXT_UNAVAILABLE',
      'Git history selection requires a matching repository context'
    );
  const branch: DatabaseHistoryScope['branch'] =
    selector.branch !== undefined
      ? { value: selector.branch, source: 'explicit' }
      : input.profile === 'status' && (selection === 'default' || kind === 'worktree')
        ? {
            value: gitContext?.branch ?? null,
            source: gitContext?.branch ? 'current' : 'unavailable',
          }
        : { value: null, source: 'all' };
  const issues: HistoryIssue[] = [];
  const projects: DatabaseHistoryProject[] = [];
  let ids = new Set<string>();
  let catalogIds = new Set<string>();
  if (kind === 'all-projects') {
    try {
      ({ ids, catalogIds } = await inventory(root, issues));
    } catch (cause) {
      issues.push(issue(cause, null));
    }
    if (registration) ids.add(registration.authority.project_id);
  } else if (selectedId) ids.add(selectedId);
  else
    issues.push(
      ...(contextIssues.length
        ? contextIssues
        : [
            issue(
              new HistoryScopeError(
                'PROJECT_IDENTITY_UNAVAILABLE',
                'Current project registration is unavailable. Run `orcaops doctor` before recovery; use first-use setup only after confirming no prior history exists, otherwise restore the verified original registration and database.'
              ),
              null
            ),
          ])
    );
  try {
    for (const projectId of [...ids].sort()) {
      cancelled(input.signal);
      const project = await openProject(
        root,
        projectId,
        registration?.authority.project_id === projectId ? registration : undefined,
        catalogIds.has(projectId)
      );
      projects.push(project);
      issues.push(...project.completeness.issues);
    }
    cancelled(input.signal);
  } catch (cause) {
    const failures: unknown[] = [];
    for (const project of projects) {
      try {
        project.database?.close();
      } catch (closing) {
        failures.push(closing);
      }
    }
    if (failures.length) {
      const combined = new AggregateError(
        [cause, ...failures],
        'Scope inspection and reader cleanup failed'
      );
      if (cause instanceof ProjectDatabaseError)
        throw new ProjectDatabaseError(cause.code, cause.message, { cause: combined });
      throw new ProjectDatabaseError(
        'HISTORY_INACCESSIBLE',
        'Scope inspection and reader cleanup failed; close the affected readers before retrying',
        { cause: combined }
      );
    }
    throw cause;
  }
  const readers = projects.flatMap((project) => (project.database ? [project.database] : []));
  let closed = false;
  return {
    root,
    kind,
    selection,
    branch,
    gitContext,
    contextIssues,
    projects,
    completeness: { complete: issues.length === 0, issues },
    close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const database of readers) {
        try {
          database.close();
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length)
        throw new ProjectDatabaseError(
          'HISTORY_INACCESSIBLE',
          'Project reader cleanup failed; close the affected readers before retrying',
          { cause: new AggregateError(failures, 'Project reader cleanup failed') }
        );
    },
  };
}
