import {
  ArtifactNotFoundError,
  ImportedArtifactLocalOnlyError,
  MissingGitRemoteError,
  ORCAOPS_CAPABILITIES,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';
import {
  createDatabaseArtifactPushConnection,
  type DatabaseArtifactPushConnection,
  type DatabaseArtifactPushConnectionDependencies,
  observeDatabaseSessionBranch,
  type PendingDatabaseArtifactPushSelection,
  type PushDatabaseArtifactOptions,
  requiresDatabasePushOwnerRef,
  selectPendingDatabaseArtifactPushes,
} from '@orcaops/core/history/database-push';
import { canonicalJson } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  openProjectDatabase,
  type ProjectArtifactSnapshot,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectWait,
  readProjectArtifact,
} from '@orcaops/storage/history/database';
import { readProjectSessionBranch } from '@orcaops/storage/history/database/session-branch';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { CLI_VERSION } from './cli-version.js';
import { assertNoSecretsOutbound } from './cloud-secret-gate.js';
import {
  type DatabaseCaptureCommandContext,
  resolveDatabaseCaptureContext,
} from './database-capture-context.js';
import { closeFailedHistoryRead } from './history-reader-close.js';
import { getInvocationCloudBaseUrl } from './invocation-context.js';

export type DatabaseCloudSelection =
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | { readonly kind: 'resync' };

export interface DatabaseCloudSession extends Pick<
  DatabaseArtifactPushConnection,
  'cloudClient' | 'artifactPushClient' | 'target' | 'wireRepoUrl' | 'sessionRepoUrl' | 'workingDir'
> {
  readonly resyncSelection?: readonly PendingDatabaseArtifactPushSelection[];
  readonly handle: ProjectDatabase;
  readonly context: DatabaseCaptureCommandContext;
  close(): void;
}

export interface ConnectDatabaseCloudSessionInput {
  readonly context: DatabaseCaptureCommandContext;
  readonly handle: ProjectDatabase;
  readonly selection: DatabaseCloudSelection;
  readonly baseUrl?: string;
  readonly operation?: string;
  readonly signal?: AbortSignal;
  readonly target?: RemoteTarget;
  readonly onWait?: (wait: ProjectWait) => void;
}

export type OpenDatabaseCloudSessionInput = Omit<
  ConnectDatabaseCloudSessionInput,
  'context' | 'handle'
>;

export interface DatabaseCloudSessionDependencies {
  readonly resolveCredentials?: typeof resolveCredentialStore;
  readonly connection?: DatabaseArtifactPushConnectionDependencies;
  readonly openWriter?: typeof openProjectDatabase;
}

export function databaseCloudPushOptions(
  session: DatabaseCloudSession,
  options: Pick<PushDatabaseArtifactOptions, 'force' | 'signal' | 'onWait'> = {}
): PushDatabaseArtifactOptions {
  return {
    target: session.target,
    repoUrl: session.wireRepoUrl,
    client: session.artifactPushClient,
    sourcePlanClient: session.cloudClient,
    repoRoot: session.context.registered.git.worktreeRoot,
    session: { repoUrl: session.sessionRepoUrl, workingDir: session.workingDir },
    ...options,
  };
}

function selectedArtifact(handle: ProjectDatabase, artifactId: string): ProjectArtifactSnapshot {
  const artifact = readProjectArtifact(handle, artifactId);
  if (!artifact) throw new ArtifactNotFoundError(artifactId);
  if (artifact.thread.plan?.origin?.kind === 'git-import')
    throw new ImportedArtifactLocalOnlyError(artifactId);
  return artifact;
}

export async function connectDatabaseCloudSession(
  input: ConnectDatabaseCloudSessionInput,
  dependencies: DatabaseCloudSessionDependencies = {}
): Promise<DatabaseCloudSession> {
  try {
    const connection = await prepareDatabaseCloudConnection(input, dependencies);
    await observeDatabaseCloudSession(input, connection);
    return {
      ...connection,
      handle: input.handle,
      context: input.context,
      close() {},
    };
  } catch (cause) {
    throwDatabaseCloudSessionFailure(cause, input.signal);
  }
}

function throwDatabaseCloudSessionFailure(cause: unknown, signal?: AbortSignal): never {
  if (signal?.aborted && !(cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED'))
    throw new ProjectDatabaseError('CANCELLED', 'Database cloud session cancelled', { cause });
  throw cause;
}

async function prepareDatabaseCloudConnection(
  input: ConnectDatabaseCloudSessionInput,
  dependencies: DatabaseCloudSessionDependencies
) {
  input.signal?.throwIfAborted();
  const rawRepoUrl = await input.context.repo.getRemoteUrl();
  if (!rawRepoUrl) throw new MissingGitRemoteError();
  assertNoSecretsOutbound(
    'database cloud sync',
    [
      ['repo_url', rawRepoUrl],
      ['working_dir', input.context.registered.git.worktreeRoot],
      ['current_branch', input.context.registered.git.branch],
    ],
    input.context.config.redact.allow
  );
  if (input.selection.kind === 'artifact')
    selectedArtifact(input.handle, input.selection.artifactId);
  let resyncSelection: readonly PendingDatabaseArtifactPushSelection[] | null = null;
  const selection = input.selection;
  const requires =
    selection.kind === 'artifact'
      ? (target: Readonly<RemoteTarget>) =>
          requiresDatabasePushOwnerRef(input.handle, selection.artifactId, { ...target })
            ? [ORCAOPS_CAPABILITIES.SOURCE_PLAN_OWNER_REF]
            : []
      : (target: Readonly<RemoteTarget>) => {
          resyncSelection = selectPendingDatabaseArtifactPushes(input.handle, { ...target });
          return resyncSelection.some((selected) => selected.requiresSourcePlanOwnerRef)
            ? [ORCAOPS_CAPABILITIES.SOURCE_PLAN_OWNER_REF]
            : [];
        };
  input.signal?.throwIfAborted();
  const connection = await createDatabaseArtifactPushConnection(
    {
      baseUrl: resolveCloudTarget(input.baseUrl ?? getInvocationCloudBaseUrl()),
      credentialStore: (dependencies.resolveCredentials ?? resolveCredentialStore)(),
      cliVersion: CLI_VERSION,
      rawRepoUrl,
      workingDir: input.context.registered.git.worktreeRoot,
      signal: input.signal,
      target: input.target,
      requires,
      operation:
        input.operation ??
        (input.selection.kind === 'artifact'
          ? 'project database artifact push'
          : 'project database artifact resync'),
    },
    dependencies.connection
  );
  if (input.selection.kind === 'resync' && resyncSelection === null)
    throw new Error('Authenticated resync connection did not qualify pending work');
  return {
    ...connection,
    ...(resyncSelection === null ? {} : { resyncSelection: [...resyncSelection] }),
  };
}

async function observeDatabaseCloudSession(
  input: ConnectDatabaseCloudSessionInput,
  connection: DatabaseArtifactPushConnection
) {
  const subject =
    input.selection.kind === 'artifact'
      ? input.selection.artifactId
      : input.context.registered.authority.projectId;
  const selected = readProjectSessionBranch(input.handle, {
    target: connection.target,
    repoUrl: connection.sessionRepoUrl,
    workingDir: connection.workingDir,
  });
  const branch = input.context.registered.git.branch;
  const resultVersion =
    branch === null
      ? null
      : selected?.state.current_branch === branch
        ? String(selected.selection.version)
        : String(BigInt(selected?.selection.version ?? 0) + 1n);
  const identity = canonicalJson([
    connection.target,
    connection.sessionRepoUrl,
    connection.workingDir,
    branch,
    input.context.registered.git.headOid,
    resultVersion,
  ]);
  const operationId = artifactOperationId(subject, identity, 'cloud.session.observation');
  const revisionId = artifactOperationId(subject, identity, 'cloud.session.revision');
  await observeDatabaseSessionBranch(
    input.handle,
    input.context.registered,
    {
      operationId,
      revisionId,
      target: connection.target,
      repoUrl: connection.sessionRepoUrl,
      secretAllow: input.context.config.redact.allow,
    },
    { signal: input.signal, onWait: input.onWait }
  );
}

export async function openDatabaseCloudSession(
  input: OpenDatabaseCloudSessionInput,
  dependencies: DatabaseCloudSessionDependencies = {}
): Promise<DatabaseCloudSession> {
  const context = await resolveDatabaseCaptureContext({ signal: input.signal });
  let handle: ProjectDatabase | null = null;
  try {
    const connection = await prepareDatabaseCloudConnection(
      { ...input, context, handle: context.project.database },
      dependencies
    );
    input.signal?.throwIfAborted();
    handle = await (dependencies.openWriter ?? openProjectDatabase)({
      authority: context.registered.authority,
      mode: 'writer',
      signal: input.signal,
    });
    await observeDatabaseCloudSession({ ...input, context, handle }, connection);
    return {
      ...connection,
      handle,
      context,
      close() {
        try {
          handle?.close();
        } finally {
          context.close();
        }
      },
    };
  } catch (cause) {
    if (handle) closeFailedHistoryRead(handle);
    closeFailedHistoryRead(context);
    throwDatabaseCloudSessionFailure(cause, input.signal);
  }
}
