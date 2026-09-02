import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

import { loadReadOnlyProjectConfig, Repo, scrubAndBound } from '@orcaops/core';
import {
  type ArchiveArtifactIssue,
  archiveProjectDir,
  archiveRoot,
  ArtifactStore,
  indexRoot,
  isUuidV7,
  loadRegistry,
  openProjectIndex,
  prepareArtifactStoreForRead,
  type ProjectIndex,
  type ProjectIndexMeta,
  type ProjectionHealth,
  refreshProjectIndex,
  type RefreshResult,
  type Registry,
  registryPath,
  type Store,
} from '@orcaops/storage';

import { PROJECT_ID_CONFIG_KEY, ProjectIdentityError, readProjectId } from './project-identity.js';
import { discoverGitRoot, resolveExplicitOverride } from './resolve-root.js';

/**
 * The cross-project row-source seam, shared by the CLI's
 * `--all-projects` fan-out and the `watch` dashboard. Fans out over every
 * archived project's disposable index. The current repo's project has one hot
 * handle and can also carry its retained archive index for consumers that
 * merge sibling-worktree history.
 * Works from OUTSIDE any repo too — the resolve here is doctor-style
 * non-throwing, and the archive dir listing is the authoritative project
 * enumeration (the registry contributes display names only).
 *
 * ALS-free: `cwd` / `env` / `rootOverride` are parameters (defaulting to
 * `process.cwd()` / `process.env`). The CLI's `lib/project-scope.ts` shim
 * threads its invocation context in; the watch app passes the child env.
 */
export interface ProjectHandle {
  projectId: string;
  displayName: string;
  store: Store;
  /** True when this is the current repo's hot store, not an index. */
  hot: boolean;
  /**
   * The hot ArtifactStore (projection reads: readPlan/readSummary) —
   * present only on the hot handle. Index-served projects read thread
   * content from archive events instead (`loadArtifactThreadFromArchive`
   * over `projectDir`).
   */
  hotStore?: ArtifactStore;
  /**
   * The hot project's ARCHIVE index store, opened only when
   * `includeArchiveForHot` is set. Consumers merge its rows with `store`'s,
   * deduped by artifact id, freshest projection winning — this is how
   * agents running in **sibling worktrees** of the same repo (whose events
   * live in another checkout but are serialized into the shared archive log)
   * become visible. Absent on index handles (their `store` already IS the
   * archive index).
   */
  archiveStore?: Store;
  /**
   * Archive high-waters captured by the same successful refresh that produced
   * `archiveStore`. Unlike the disposable sidecar file, this is also populated
   * for the in-memory fallback tier.
   */
  archiveMeta?: ProjectIndexMeta;
  /** `<dataRoot>/<project-id>` archive dir (`<dataRoot>/projects/<id>`). */
  projectDir: string;
  /** Archive projection problems currently affecting this handle. */
  issues: ProjectScopeIssue[];
  /**
   * Re-run this handle's incremental index refresh (meta high-water skips
   * unchanged artifacts, so this is cheap per tick). Present on index
   * handles and on the hot handle when it carries an `archiveStore`;
   * **undefined for a pure-hot handle** (the hot store needs no refresh —
   * it is written live under the same lock). Consumers never touch the
   * retained `ProjectIndex` directly; this closure owns it.
   */
  refresh?: () => Promise<void>;
  close(): void;
}

export interface ArtifactUnavailableProjectScopeIssue {
  kind: 'artifact_unavailable';
  project_id: string;
  project: string;
  artifact_id: string;
  message: string;
}

export interface ProjectIdentityUnavailableScopeIssue {
  kind: 'project_identity_unavailable';
  source: 'hot' | 'archive';
  project_id: null;
  project: string;
  message: string;
}

export interface ProjectIndexDegradedScopeIssue {
  kind: 'project_index_degraded';
  project_id: string;
  project: string;
  message: string;
}

export interface HotProjectionIncompleteScopeIssue {
  kind: 'hot_projection_incomplete';
  project_id: string | null;
  project: string;
  health: ProjectionHealth;
  message: string;
}

export type ProjectScopeIssue =
  | ArtifactUnavailableProjectScopeIssue
  | ProjectIdentityUnavailableScopeIssue
  | ProjectIndexDegradedScopeIssue
  | HotProjectionIncompleteScopeIssue;

/**
 * A repo that has a readable `.orcaops` hot store but no usable project id.
 * This covers both an unminted id and an identity validation/read issue.
 * It is a distinct domain state, not a degraded {@link ProjectHandle}: the
 * invariant is that every member of `projects[]` carries a non-null
 * `projectId`, so an identity-less hot store lives on its own
 * {@link AllProjectsScope} field, where it stays visible (Watch renders it
 * while identity is repaired). A watcher NEVER mints — it is strictly
 * read-only, no git-config writes.
 */
export interface UnidentifiedProjectHandle {
  projectId: null;
  displayName: string;
  store: Store;
  hot: true;
  hotStore: ArtifactStore;
  close(): void;
}

export interface AllProjectsScope {
  projects: ProjectHandle[];
  /** Dynamic aggregate: handle refreshes replace their current issue set. */
  readonly issues: ProjectScopeIssue[];
  /** The current checkout when it has `.orcaops` but no usable id (only
   *  populated under `allowUnidentifiedHot`). */
  unidentifiedHot?: UnidentifiedProjectHandle;
  /** Prepare hot projections immediately before a long-lived consumer reads them. */
  prepareHotStoresForRead(): Promise<void>;
  close(): void;
}

export interface CurrentProjectArchive {
  projectId: string;
  displayName: string;
  store: Store;
  meta: ProjectIndexMeta;
  projectDir: string;
  issues: ProjectScopeIssue[];
  close(): void;
}

export interface OpenCurrentProjectArchiveOptions {
  repo: Repo;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}

/** Open only the identified current project's retained archive projection. */
export async function openCurrentProjectArchive(
  opts: OpenCurrentProjectArchiveOptions
): Promise<CurrentProjectArchive | null> {
  const projectId = await readProjectId(opts.repo);
  if (projectId === null) return null;

  const env = opts.env ?? process.env;
  const dataRoot = archiveRoot(env);
  const idxRoot = indexRoot(env);
  const registry = await loadRegistry(registryPath(dataRoot));
  const displayName =
    registry.projects[projectId]?.display_name || (await repoDisplayName(opts.repo, opts.repoRoot));
  const projectDir = archiveProjectDir(dataRoot, projectId);
  const index = await openProjectIndex(idxRoot, projectId);
  const result = await refreshScopedIndex(projectDir, index, idxRoot, projectId, displayName);
  return {
    projectId,
    displayName,
    store: index.store,
    meta: result.meta,
    projectDir,
    issues: result.issues,
    close: index.close,
  };
}

export interface OpenAllProjectsOptions {
  /** Directory the command was invoked from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Env to resolve roots/data dirs against. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The parsed `--root` flag, if any (wins over `env.ORCAOPS_ROOT`). */
  rootOverride?: string;
  /**
   * Also open the hot project's ARCHIVE index (as `archiveStore` on the hot
   * handle) so sibling-worktree agents become visible. Default OFF; the CLI
   * opts in and each reader owns its command-specific union and degradation
   * behavior.
   */
  includeArchiveForHot?: boolean;
  /**
   * Return a readable `.orcaops` repo with no usable id as `unidentifiedHot`
   * instead of dropping it. Default OFF — the CLI only fans out over minted
   * projects.
   */
  allowUnidentifiedHot?: boolean;
  /**
   * Surface failures after an initialized hot checkout has been found instead
   * of degrading to archive-only discovery. Watch uses this so a poisoned or
   * unreadable live checkout cannot disappear behind a stale projection.
   */
  throwOnHotOpenError?: boolean;
}

export async function openAllProjects(
  opts: OpenAllProjectsOptions = {}
): Promise<AllProjectsScope> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const includeArchiveForHot = opts.includeArchiveForHot ?? false;
  const allowUnidentifiedHot = opts.allowUnidentifiedHot ?? false;

  const dataRoot = archiveRoot(env);
  const idxRoot = indexRoot(env);
  const registry = await loadRegistry(registryPath(dataRoot));
  const displayName = (id: string): string => registry.projects[id]?.display_name || id;

  const projects: ProjectHandle[] = [];
  const discoveryIssues: ProjectScopeIssue[] = [];
  let unidentifiedHot: UnidentifiedProjectHandle | undefined;
  let unidentifiedProjectionIssue: HotProjectionIncompleteScopeIssue | null = null;

  const hot = await openCurrentHotProject(
    cwd,
    env,
    opts.rootOverride,
    registry,
    allowUnidentifiedHot,
    opts.throwOnHotOpenError ?? false
  );

  if (hot?.kind === 'identity_issue') {
    discoveryIssues.push(hot.issue);
    if (hot.unidentified) {
      const artifactStore = hot.unidentified.artifactStore;
      unidentifiedHot = {
        projectId: null,
        displayName: hot.unidentified.displayName,
        store: artifactStore.store,
        hot: true,
        hotStore: artifactStore,
        close: () => artifactStore.close(),
      };
    }
  } else if (hot && hot.projectId !== null) {
    const pid = hot.projectId;
    const projectName = registry.projects[pid]?.display_name || hot.displayName;
    const artifactStore = hot.artifactStore;
    const closers: Array<() => void> = [() => artifactStore.close()];
    let archiveStore: Store | undefined;
    let archiveMeta: ProjectIndexMeta | undefined;
    let refresh: (() => Promise<void>) | undefined;
    let issues: ProjectScopeIssue[] = [];
    if (includeArchiveForHot) {
      // The hot handle ALSO opens/refreshes its own archive index so a
      // consumer can merge in sibling-worktree rows. The loop below still
      // skips this project id, so there is exactly one handle for it.
      const archiveDir = archiveProjectDir(dataRoot, pid);
      const index = await openProjectIndex(idxRoot, pid);
      const result = await refreshScopedIndex(archiveDir, index, idxRoot, pid, projectName);
      archiveStore = index.store;
      archiveMeta = result.meta;
      issues = result.issues;
      closers.push(index.close);
      refresh = async () => {
        const next = await refreshScopedIndex(archiveDir, index, idxRoot, pid, projectName);
        if (next.meta.generation >= (handle.archiveMeta?.generation ?? -1)) {
          handle.archiveMeta = next.meta;
          handle.issues = [
            ...next.issues,
            ...handle.issues.filter((issue) => issue.kind === 'hot_projection_incomplete'),
          ];
        }
      };
    }
    const handle: ProjectHandle = {
      projectId: pid,
      displayName: projectName,
      store: artifactStore.store,
      hot: true,
      hotStore: artifactStore,
      archiveStore,
      archiveMeta,
      projectDir: archiveProjectDir(dataRoot, pid),
      issues,
      refresh,
      close: () => {
        for (const c of closers) c();
      },
    };
    projects.push(handle);
  } else if (hot) {
    // hot.projectId === null → a `.orcaops` repo with no minted id.
    const artifactStore = hot.artifactStore;
    unidentifiedHot = {
      projectId: null,
      displayName: hot.displayName,
      store: artifactStore.store,
      hot: true,
      hotStore: artifactStore,
      close: () => artifactStore.close(),
    };
  }

  const hotProjectId = hot?.kind === 'project' && hot.projectId !== null ? hot.projectId : null;

  const archived = await listArchivedProjectIds(dataRoot);
  discoveryIssues.push(...archived.issues);
  for (const projectId of archived.projectIds) {
    if (hotProjectId !== null && projectId === hotProjectId) continue;
    const projectDir = archiveProjectDir(dataRoot, projectId);
    const projectName = displayName(projectId);
    const index = await openProjectIndex(idxRoot, projectId);
    const result = await refreshScopedIndex(projectDir, index, idxRoot, projectId, projectName);
    const handle: ProjectHandle = {
      projectId,
      displayName: projectName,
      store: index.store,
      hot: false,
      projectDir,
      archiveMeta: result.meta,
      issues: result.issues,
      refresh: async () => {
        const next = await refreshScopedIndex(projectDir, index, idxRoot, projectId, projectName);
        if (next.meta.generation >= (handle.archiveMeta?.generation ?? -1)) {
          handle.archiveMeta = next.meta;
          handle.issues = next.issues;
        }
      },
      close: index.close,
    };
    projects.push(handle);
  }

  const scope: AllProjectsScope = {
    projects,
    get issues() {
      return [
        ...discoveryIssues,
        ...projects.flatMap((project) => project.issues),
        ...(unidentifiedProjectionIssue ? [unidentifiedProjectionIssue] : []),
      ];
    },
    unidentifiedHot,
    prepareHotStoresForRead: async () => {
      for (const project of projects) {
        if (!project.hotStore) continue;
        const issue = await prepareHotProjection(
          project.hotStore,
          project.projectId,
          project.displayName
        );
        project.issues = [
          ...project.issues.filter((existing) => existing.kind !== 'hot_projection_incomplete'),
          ...(issue ? [issue] : []),
        ];
      }
      unidentifiedProjectionIssue = unidentifiedHot
        ? await prepareHotProjection(unidentifiedHot.hotStore, null, unidentifiedHot.displayName)
        : null;
    },
    close: () => {
      for (const p of projects) p.close();
      unidentifiedHot?.close();
    },
  };
  await scope.prepareHotStoresForRead();
  return scope;
}

async function prepareHotProjection(
  store: ArtifactStore,
  projectId: string | null,
  project: string
): Promise<HotProjectionIncompleteScopeIssue | null> {
  const preparation = await prepareArtifactStoreForRead({ store });
  if (preparation.issue === null && preparation.projectionHealth === 'healthy') return null;
  const detail = preparation.issue
    ? `${preparation.issue.kind}: ${preparation.issue.message}`
    : `projection health is ${preparation.projectionHealth}; ` +
      `${store.store.projectionSkippedArtifacts} durable artifact(s) were skipped`;
  return {
    kind: 'hot_projection_incomplete',
    project_id: projectId,
    project,
    health: preparation.projectionHealth,
    message: scrubAndBound(
      `Local artifact data may be incomplete (${detail}). ` +
        'Run `orcaops doctor`, repair or explicitly remove unreadable durable sources, ' +
        'then run `orcaops rebuild`.',
      500
    ),
  };
}

async function refreshScopedIndex(
  projectDir: string,
  index: ProjectIndex,
  indexRootDir: string,
  projectId: string,
  project: string
): Promise<{ meta: ProjectIndexMeta; issues: ProjectScopeIssue[] }> {
  try {
    const result = await refreshProjectIndex(projectDir, index, indexRootDir, projectId);
    return {
      meta: result.meta,
      issues: scopeIssues(projectId, project, result),
    };
  } catch (error) {
    return {
      meta: index.meta,
      issues: [
        {
          kind: 'project_index_degraded',
          project_id: projectId,
          project,
          message: scrubAndBound(
            `Could not refresh the disposable archive index: ${
              error instanceof Error ? error.message : String(error)
            }`,
            500
          ),
        },
      ],
    };
  }
}

function scopeIssues(
  projectId: string,
  project: string,
  result: Pick<RefreshResult, 'artifact_issues' | 'index_issues'>
): ProjectScopeIssue[] {
  return [
    ...result.artifact_issues.map((issue: ArchiveArtifactIssue) => ({
      ...issue,
      project_id: projectId,
      project,
    })),
    ...result.index_issues.map((issue) => ({
      kind: 'project_index_degraded' as const,
      project_id: projectId,
      project,
      message: scrubAndBound(issue.message, 500),
    })),
  ];
}

/**
 * Human-readable project name: the git common-dir's parent basename (i.e. the
 * repo), so every worktree of a repo shows the REPO name rather than the
 * branch-named worktree dir. Common-dir is shared across worktrees, matching the
 * repo-level projectId. Falls back to the worktree basename if it can't be read.
 */
export async function repoDisplayName(repo: Repo, fallbackRoot: string): Promise<string> {
  try {
    return path.basename(path.dirname(await repo.getCommonDirAbsolute()));
  } catch {
    return path.basename(fallbackRoot);
  }
}

/**
 * Current repo's hot store, when the cwd is inside an initialized repo.
 * Returns `projectId: null` for a `.orcaops` repo with no minted id when
 * `allowUnidentifiedHot` is set; with the flag off, that tier returns a
 * disclosed `identity_issue` (an unminted repo has no archive dir, so no
 * other tier serves its rows). Discovery and unrelated I/O failures degrade
 * to `null` (the archive index for that project, if any, still serves it).
 * Identity validation and read failures become explicit scope issues:
 * treating either as absence would silently hide the authoritative hot
 * project.
 */
async function openCurrentHotProject(
  cwd: string,
  env: NodeJS.ProcessEnv,
  rootOverride: string | undefined,
  registry: Registry,
  allowUnidentifiedHot: boolean,
  throwOnHotOpenError: boolean
): Promise<
  | {
      kind: 'project';
      projectId: string | null;
      displayName: string;
      artifactStore: ArtifactStore;
    }
  | {
      kind: 'identity_issue';
      issue: ProjectIdentityUnavailableScopeIssue;
      unidentified?: {
        displayName: string;
        artifactStore: ArtifactStore;
      };
    }
  | null
> {
  let root: string | null = null;
  let repo: Repo | null = null;
  let initialized = false;
  try {
    const abscwd = path.resolve(cwd);
    root =
      (await resolveExplicitOverride(abscwd, env, rootOverride)) ?? (await discoverGitRoot(abscwd));
    if (!root) return null;
    await access(path.join(root, '.orcaops'));
    initialized = true;
    repo = new Repo(root);
    const projectId = await readProjectId(repo);
    if (!projectId && !allowUnidentifiedHot) {
      if (throwOnHotOpenError) {
        const validationStore = await openHotArtifactStore(root);
        validationStore.close();
      }
      // Identity lives in git config --local, which a fresh clone loses
      // while the machine archive persists — so only the LOCAL hot rows
      // drop here; any previously archived rows still serve through the
      // archive-discovery loop. Disclose the drop instead of returning
      // silently.
      return {
        kind: 'identity_issue',
        issue: {
          kind: 'project_identity_unavailable',
          source: 'hot',
          project_id: null,
          project: await repoDisplayName(repo, root),
          message:
            'this repo has no minted orcaops project id; its local hot-store ' +
            'artifacts are not included in --all-projects. ' +
            (await projectIdentityRecoveryGuidance(repo, registry)),
        },
      };
    }
    return {
      kind: 'project',
      projectId: projectId ?? null,
      displayName: await repoDisplayName(repo, root),
      artifactStore: await openHotArtifactStore(root),
    };
  } catch (error) {
    if (error instanceof ProjectIdentityError && root !== null) {
      const project = repo === null ? path.basename(root) : await repoDisplayName(repo, root);
      let unidentified:
        | {
            displayName: string;
            artifactStore: ArtifactStore;
          }
        | undefined;
      if (allowUnidentifiedHot || throwOnHotOpenError) {
        try {
          const artifactStore = await openHotArtifactStore(root);
          if (allowUnidentifiedHot) {
            unidentified = { displayName: project, artifactStore };
          } else {
            artifactStore.close();
          }
        } catch (storeError) {
          if (throwOnHotOpenError) throw storeError;
          // The identity issue remains visible even when the hot store itself
          // cannot be opened safely.
        }
      }
      return {
        kind: 'identity_issue',
        issue: {
          kind: 'project_identity_unavailable',
          source: 'hot',
          project_id: null,
          project,
          message: error.message,
        },
        unidentified,
      };
    }
    if (
      throwOnHotOpenError &&
      root !== null &&
      (initialized || (error as NodeJS.ErrnoException).code !== 'ENOENT')
    ) {
      throw error;
    }
    return null;
  }
}

async function openHotArtifactStore(repoRoot: string): Promise<ArtifactStore> {
  return new ArtifactStore({ repoRoot, config: await loadReadOnlyProjectConfig(repoRoot) });
}

/** Read-only recovery guidance derived from registry hints, never identity. */
export async function projectIdentityRecoveryGuidance(
  repo: Repo,
  registry: Registry
): Promise<string> {
  let remote: string | null = null;
  let rootCommitShas: string[] = [];
  try {
    remote = await repo.getRemoteUrl();
  } catch {
    // Registry hints are optional; retain the generic restore path.
  }
  try {
    rootCommitShas = await repo.getRootCommitShas();
  } catch {
    // Registry hints are optional; retain the generic restore path.
  }

  const rootCommits = new Set(rootCommitShas);
  const candidates = Object.entries(registry.projects)
    .filter(
      ([projectId, hints]) =>
        isUuidV7(projectId) &&
        ((remote !== null && hints.remotes.includes(remote)) ||
          hints.root_commit_shas.some((sha) => rootCommits.has(sha)))
    )
    .map(([projectId]) => projectId)
    .sort();

  if (candidates.length === 1) {
    const projectId = candidates[0];
    return (
      `The archive registry matches project ${projectId}; before capturing, restore it with ` +
      `\`git config --local ${PROJECT_ID_CONFIG_KEY} ${projectId}\`.`
    );
  }
  if (candidates.length > 1) {
    return (
      `The archive registry has multiple matching project ids: ${candidates.join(', ')}. ` +
      `Identify the owner, then restore it with \`git config --local ${PROJECT_ID_CONFIG_KEY} <id>\` ` +
      'before capturing.'
    );
  }
  return (
    'If this repo was previously archived, restore its id with ' +
    `\`git config --local ${PROJECT_ID_CONFIG_KEY} <id>\` before capturing; ` +
    'the archive registry has no unique remote or root-commit match. If this is a genuinely ' +
    'new repository, its first archive-enabled capture will mint an id.'
  );
}

async function listArchivedProjectIds(
  dataRoot: string
): Promise<{ projectIds: string[]; issues: ProjectIdentityUnavailableScopeIssue[] }> {
  try {
    const entries = await readdir(path.join(dataRoot, 'projects'), { withFileTypes: true });
    const projectIds: string[] = [];
    const issues: ProjectIdentityUnavailableScopeIssue[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isUuidV7(entry.name)) {
        projectIds.push(entry.name);
        continue;
      }
      const project = scrubAndBound(entry.name, 128);
      issues.push({
        kind: 'project_identity_unavailable',
        source: 'archive',
        project_id: null,
        project,
        message:
          `archive project directory ${JSON.stringify(project)} is not named with a canonical ` +
          'UUIDv7 project id; inspect the archive projects directory and rename or remove it.',
      });
    }
    return { projectIds: projectIds.sort(), issues };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { projectIds: [], issues: [] };
    }
    throw err;
  }
}
