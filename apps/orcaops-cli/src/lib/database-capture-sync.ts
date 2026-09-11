import {
  classifyCloudSyncFailure,
  MissingGitRemoteError,
  NotConnectedError,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';
import {
  type ArtifactPushClient,
  listPendingDatabaseArtifactPushIds,
  pushDatabaseArtifact,
  type PushDatabaseArtifactOptions,
} from '@orcaops/core/history/database-push';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectCloudSyncState,
} from '@orcaops/storage/history/database';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import {
  connectDatabaseCloudSession,
  databaseCloudPushOptions,
  type DatabaseCloudSessionDependencies,
} from './database-cloud-session.js';
import { getInvocationCloudBaseUrl } from './invocation-context.js';
import { toCloudErrorEnvelope } from '../io/cloud-error-envelope.js';
import { writeTerminalSafeStderr } from '../io/output.js';

export interface CaptureCloudSyncSession {
  readonly target: PushDatabaseArtifactOptions['target'];
  readonly repoUrl: string;
  readonly client: ArtifactPushClient;
}
export interface CaptureCloudSyncDeps {
  readonly openCloudSyncSession?: () => Promise<CaptureCloudSyncSession>;
  readonly cloud?: DatabaseCloudSessionDependencies;
}

type PauseReason = 'not_authenticated' | 'push_failed' | 'content_invalid' | 'upgrade_required';
export type CaptureCloudSyncStatus =
  | { status: 'ok'; hash: string }
  | {
      status: 'skipped';
      reason: 'replay' | 'unchanged' | 'drain_disabled' | 'missing_remote' | 'no_cloud_configured';
    }
  | {
      status: 'paused';
      reason: PauseReason;
      code: string;
      message: string;
      action: string;
      pending?: number;
    };

export async function syncDatabaseCapture(
  context: DatabaseCaptureCommandContext,
  handle: ProjectDatabase,
  artifactId: string,
  options: ProjectOperationOptions & { replayed?: boolean } = {},
  deps: CaptureCloudSyncDeps = {}
): Promise<CaptureCloudSyncStatus> {
  if (options.replayed) return { status: 'skipped', reason: 'replay' };
  if (context.env.ORCAOPS_DISABLE_DRAIN === '1')
    return { status: 'skipped', reason: 'drain_disabled' };
  let target: PushDatabaseArtifactOptions['target'] | undefined;
  const paused = (reason: PauseReason, code: string, detail: string): CaptureCloudSyncStatus => {
    const action =
      reason === 'not_authenticated'
        ? 'Run `orcaops resync`; if your session has ended, run `orcaops login`.'
        : reason === 'content_invalid'
          ? 'Run `orcaops doctor`, preserve the registered database and its companion files, and report the diagnostic. Do not edit retained events or checksums.'
          : reason === 'upgrade_required'
            ? 'Upgrade your Orcaops install, then run `orcaops resync`.'
            : code === 'STALE_CONTEXT'
              ? 'Run `orcaops push-status` to inspect the original operation. If delivery is unknown, preserve it and report the diagnostic; status cannot prove remote absence. Otherwise run `orcaops resync`.'
              : 'Run `orcaops resync --force` to retry; an unknown remote outcome still requires inspection before any resend.';
    let pending: number | undefined;
    try {
      if (target) pending = listPendingDatabaseArtifactPushIds(handle, target).length;
    } catch {
      // Counting pending work must not hide an already-committed capture or its sync failure.
    }
    const message = `This capture is saved locally, but its current state is not confirmed on the cloud. ${detail}`;
    writeTerminalSafeStderr(`Cloud sync paused: ${message}\n${action}\n`);
    return {
      status: 'paused',
      reason,
      code,
      message,
      action,
      ...(pending === undefined ? {} : { pending }),
    };
  };
  try {
    if (options.signal?.aborted)
      throw new ProjectDatabaseError('CANCELLED', 'Capture sync cancelled after local commit');
    let pushOptions: PushDatabaseArtifactOptions;
    if (deps.openCloudSyncSession) {
      pushOptions = { ...(await deps.openCloudSyncSession()), ...options };
    } else {
      if (!(await context.repo.getRemoteUrl()))
        return { status: 'skipped', reason: 'missing_remote' };
      const credentials = (deps.cloud?.resolveCredentials ?? resolveCredentialStore)();
      const baseUrl = resolveCloudTarget(getInvocationCloudBaseUrl());
      if (!(await credentials.read(baseUrl)))
        return { status: 'skipped', reason: 'no_cloud_configured' };
      const session = await connectDatabaseCloudSession(
        {
          context,
          handle,
          selection: { kind: 'artifact', artifactId },
          operation: 'capture cloud sync',
          ...options,
        },
        { ...deps.cloud, resolveCredentials: () => credentials }
      );
      pushOptions = databaseCloudPushOptions(session, options);
    }
    target = pushOptions.target;
    const outcome = await pushDatabaseArtifact(handle, artifactId, pushOptions);
    const state = readProjectCloudSyncState(handle, artifactId, target);
    if (state === null || state.pending || (outcome.status === 'pushed' && !outcome.cloudApplied))
      return paused('push_failed', 'STALE_CONTEXT', 'The artifact changed during synchronization.');
    return outcome.status === 'skipped'
      ? { status: 'skipped', reason: 'unchanged' }
      : { status: 'ok', hash: outcome.hash };
  } catch (cause) {
    if (
      (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') ||
      options.signal?.aborted
    )
      throw cause;
    if (cause instanceof MissingGitRemoteError)
      return { status: 'skipped', reason: 'missing_remote' };
    const failure = classifyCloudSyncFailure(cause);
    const mapped = toCloudErrorEnvelope(cause);
    const code =
      mapped instanceof Error && 'code' in mapped && typeof mapped.code === 'string'
        ? mapped.code
        : 'CLOUD_ERROR';
    const reason =
      cause instanceof NotConnectedError
        ? 'not_authenticated'
        : failure.kind === 'content-invalid'
          ? 'content_invalid'
          : failure.kind === 'upgrade-required'
            ? 'upgrade_required'
            : 'push_failed';
    return paused(
      reason,
      code,
      failure.message ?? 'Cloud synchronization failed after local commit.'
    );
  }
}
