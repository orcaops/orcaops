import { isDeepStrictEqual } from 'node:util';

import { Repo } from '@orcaops/core';
import {
  requireDatabaseExecutionContext,
  setupProjectDatabase,
} from '@orcaops/core/history/database-capture';
import { HistoryScopeError } from '@orcaops/project-scope/history';
import type { DatabaseHistoryProject } from '@orcaops/project-scope/history/database';
import {
  assertNoSecretsInPayload,
  type Config,
  isUuidV7,
  type SecretFinding,
} from '@orcaops/storage';
import type { DatabaseJson } from '@orcaops/storage/history/database';
import {
  openProjectDatabase,
  type ProjectDatabase,
  ProjectDatabaseError,
  queryProjectArtifacts,
  readProjectArtifact,
} from '@orcaops/storage/history/database';
import type { ExecutionBinding } from '@orcaops/storage/history/execution';
import { resolveShellKey, type ShellKey } from '@orcaops/storage/history/execution-focus';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { registerMissingDatabaseWorktree } from './database-worktree-registration.js';
import { closeFailedHistoryRead } from './history-reader-close.js';
import { getInvocationEnv, getInvocationInvokedByAgent } from './invocation-context.js';
import { type InvokingAgentResolution, resolveInvokingAgent } from './invoking-agent.js';
import { type ArtifactCandidate, ErrorCodes, OrcaopsError } from '../io/errors.js';

type RegisteredContext = Awaited<ReturnType<typeof requireDatabaseExecutionContext>>;

export interface DatabaseCaptureCommandContext {
  scope: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>['scope'];
  config: Config;
  project: DatabaseHistoryProject & { database: ProjectDatabase };
  registered: RegisteredContext;
  binding: ExecutionBinding;
  env: NodeJS.ProcessEnv;
  repo: Repo;
  invokingAgent: InvokingAgentResolution;
  shellKey: ShellKey;
  close(): void;
}

/**
 * What a fresh repository can be told before it has any history: enough to refuse the
 * authored payload and to name the branch the assembled form carries.
 */
export interface FreshCaptureRepository {
  readonly config: Config;
  readonly branch: string | null;
  readonly worktreeRoot: string;
  readonly root: string;
}
export interface ResolveDatabaseCaptureContext {
  registerWorktree?: boolean | ((config: Config) => void);
  project?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * Supplied only by `capture plan`, the one verb that creates history from nothing. It
   * refuses the authored payload and returns it for the setup to refuse again, so nothing
   * is initialized for input that is about to be rejected. Every other verb leaves this
   * absent and a repository with no history stays refused.
   */
  initialize?: (repository: FreshCaptureRepository) => Promise<readonly unknown[]>;
}

export async function resolveDatabaseCaptureContext(
  options: ResolveDatabaseCaptureContext = {}
): Promise<DatabaseCaptureCommandContext> {
  const env = { ...(options.env ?? getInvocationEnv()) };
  const project = options.project;
  if (project !== undefined && !isUuidV7(project))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide an exact project UUID');
  const shellKey = resolveShellKey({ env });
  const invokingAgent = resolveInvokingAgent({ flag: getInvocationInvokedByAgent(), env });
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'exact',
    selector: { projectId: project },
    env,
  });
  try {
    const { scope } = context;
    const selected = scope.projects[0];
    // A repository with NO registration at all is fresh: the first plan capture may start
    // its history. A REGISTERED project whose database is gone is not — that is missing
    // history, and reinitializing it would silently replace what was lost.
    if (scope.projects.length === 0 && options.initialize && scope.gitContext) {
      const authoredPayloads = await options.initialize({
        config: context.config,
        branch: scope.gitContext.branch,
        worktreeRoot: scope.gitContext.worktreeRoot,
        root: scope.root.resolvedRoot,
      });
      const setup = {
        cwd: scope.gitContext.worktreeRoot,
        root: scope.root.resolvedRoot,
        authoredPayloads: JSON.parse(JSON.stringify(authoredPayloads)) as DatabaseJson[],
        secretAllow: [...context.config.redact.allow],
      };
      scope.close();
      // Setup owns the identity and receipt of the initialization, so an interrupted first
      // capture resumes it here rather than creating a second project.
      await setupProjectDatabase(setup, { signal: options.signal });
      const { initialize: _initialize, ...rest } = options;
      return resolveDatabaseCaptureContext(rest);
    }
    if (scope.projects.length !== 1 || !selected?.authority || !selected.database)
      throw new HistoryScopeError(
        selected?.completeness.issues[0]?.code ?? 'HISTORY_MISSING',
        'Select the original registered project and available history before capturing; do not initialize a replacement'
      );
    if (!scope.gitContext)
      throw new ProjectDatabaseError(
        'IDENTITY_RECOVERY_REQUIRED',
        'Capture requires its original registered worktree context'
      );
    if (scope.gitContext.worktreeId === null && options.registerWorktree) {
      if (typeof options.registerWorktree === 'function') options.registerWorktree(context.config);
      await registerMissingDatabaseWorktree(
        {
          cwd: scope.gitContext.worktreeRoot,
          root: scope.root.resolvedRoot,
          projectId: selected.projectId,
          expectedAuthority: selected.authority,
          secretAllow: context.config.redact.allow,
        },
        { signal: options.signal }
      );
    }
    const registered = await requireDatabaseExecutionContext(
      {
        cwd: scope.gitContext.worktreeRoot,
        root: scope.root.resolvedRoot,
        projectId: selected.projectId,
      },
      { signal: options.signal }
    );
    if (
      !isDeepStrictEqual(registered.authority, selected.authority) ||
      !isDeepStrictEqual(selected.database.authority, selected.authority) ||
      registered.authority.rootKey !== scope.root.rootKey ||
      registered.authority.resolvedRoot !== scope.root.resolvedRoot ||
      (scope.gitContext.worktreeId !== null &&
        registered.git.worktreeId !== scope.gitContext.worktreeId) ||
      registered.git.repositoryInstanceId !== scope.gitContext.repositoryInstanceId ||
      (
        [
          'worktreeRoot',
          'gitDir',
          'commonDir',
          'repositoryCreation',
          'administrativeIdentity',
        ] as const
      ).some((key) => !isDeepStrictEqual(registered.git[key], scope.gitContext![key]))
    )
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'The original project, store or worktree authority changed during capture selection'
      );
    if (
      registered.git.branch !== scope.gitContext.branch ||
      registered.git.headOid !== scope.gitContext.headOid
    )
      throw new ProjectDatabaseError(
        'EXECUTION_CONTEXT_CHANGED',
        'The Git context changed during capture selection; repeat the capture against the intended checkout'
      );
    const repo = new Repo(registered.git.worktreeRoot, {
      env: {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
      },
    });
    return {
      scope,
      config: context.config,
      project: selected as DatabaseHistoryProject & { database: ProjectDatabase },
      registered,
      binding: registered.binding,
      env,
      repo,
      invokingAgent,
      shellKey,
      close: () => scope.close(),
    };
  } catch (cause) {
    closeFailedHistoryRead(context.scope);
    throw cause;
  }
}

export function openDatabaseCaptureWriter(
  context: DatabaseCaptureCommandContext,
  signal?: AbortSignal
) {
  return openProjectDatabase({
    authority: { ...context.registered.authority },
    mode: 'writer',
    signal,
  });
}

/**
 * Refuse-tier findings throw `SecretInPayloadError`; warn-tier findings ride the
 * success envelope. Both the raw authored payload and the fully assembled input
 * (branch, source-plan pin, baseline) pass through here before any writer opens.
 */
export function refuseCaptureInput(
  value: unknown,
  allow: readonly string[]
): readonly SecretFinding[] {
  return assertNoSecretsInPayload(value, allow);
}

export interface PreparedDatabaseCapture<TRaw, TInput> {
  readonly raw: TRaw;
  readonly input: TInput;
  readonly context: DatabaseCaptureCommandContext;
  readonly secretWarnings: readonly SecretFinding[];
}

export async function prepareDatabaseCapture<TRaw, TInput = TRaw>(input: {
  parse: () => TRaw | Promise<TRaw>;
  assemble?: (raw: TRaw, context: DatabaseCaptureCommandContext) => TInput | Promise<TInput>;
  project?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Only `capture plan` passes this; see ResolveDatabaseCaptureContext.initialize. */
  initialize?: (raw: TRaw, repository: FreshCaptureRepository) => Promise<readonly unknown[]>;
}): Promise<PreparedDatabaseCapture<TRaw, TInput>> {
  const raw = structuredClone(await input.parse());
  const initialize = input.initialize;
  const context = await resolveDatabaseCaptureContext({
    registerWorktree: (config) => {
      refuseCaptureInput(raw, config.redact.allow);
    },
    project: input.project,
    env: input.env,
    signal: input.signal,
    ...(initialize
      ? { initialize: (repository) => initialize(structuredClone(raw), repository) }
      : {}),
  });
  try {
    const allow = context.config.redact.allow;
    const rawWarnings = refuseCaptureInput(raw, allow);
    // The assembled scan sees the same paths the file era reported (`branch`,
    // `source_plan.baseline.branch`), so warn-tier findings keep their names.
    const assembled = input.assemble
      ? await input.assemble(structuredClone(raw), context)
      : ({ ...(raw as object), branch: context.registered.git.branch } as unknown as TInput);
    const assembledWarnings = refuseCaptureInput(assembled, allow);
    return Object.freeze({
      raw,
      input: structuredClone(assembled),
      context,
      secretWarnings: [...rawWarnings, ...assembledWarnings],
    });
  } catch (cause) {
    context.close();
    throw cause;
  }
}

export interface DatabaseCaptureArtifactSelection {
  artifactId: string;
  via: 'explicit' | 'single-active';
}

/**
 * Explicit ids must exist; otherwise the single in-flight captured artifact on the
 * branch is the target, zero refuses and several return labelled candidates. The
 * branch scope is deliberate: neither the session pin nor SHA reachability may
 * retarget a write to another branch's artifact.
 */
export function selectDatabaseCaptureArtifact(
  handle: ProjectDatabase,
  options: { explicitId?: string; branch: string | null }
): DatabaseCaptureArtifactSelection {
  if (options.explicitId !== undefined) {
    if (!isUuidV7(options.explicitId) || !readProjectArtifact(handle, options.explicitId))
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifact with id "${options.explicitId}".`,
        'artifact_id'
      );
    return { artifactId: options.explicitId, via: 'explicit' };
  }
  const branch = options.branch;
  if (branch === null)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'No current branch; pass artifact_id explicitly to capture on a detached HEAD.',
      'artifact_id'
    );
  const rows = queryProjectArtifacts(handle, {
    branch,
    origin: 'captured',
    profile: 'versions',
  }).rows.filter((row) => row.completedAt === null);
  if (rows.length === 1) return { artifactId: rows[0].artifactId, via: 'single-active' };
  if (rows.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No active artifact on branch "${branch}". Pass artifact_id explicitly, or run \`orcaops capture plan\` first.`,
      'artifact_id'
    );
  const candidates: ArtifactCandidate[] = rows.map((row) => ({
    id: row.artifactId,
    label: row.label && row.label !== 'unlabelled' ? row.label : (row.task ?? row.artifactId),
    task: row.task ?? '',
    state: row.state,
    checkpoint_count: row.checkpointCount,
    last_activity_at: row.updatedAt,
    created_by_session_id: null,
  }));
  const summary = candidates.map((c) => `${c.id} (${c.label}, ${c.state})`).join('; ');
  throw new OrcaopsError(
    ErrorCodes.AMBIGUOUS_ARTIFACT,
    `${candidates.length} active artifacts on branch "${branch}"; pass artifact_id explicitly. Candidates: ${summary}.`,
    'artifact_id',
    { candidates }
  );
}
