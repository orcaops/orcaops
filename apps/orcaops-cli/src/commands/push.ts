import {
  DatabaseArtifactPushUnavailableError,
  pushDatabaseArtifact,
} from '@orcaops/core/history/database-push';
import type { ProjectWait } from '@orcaops/storage/history/database';

import { toCloudErrorEnvelope } from '../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStderr } from '../io/output.js';
import {
  databaseCloudPushOptions,
  type DatabaseCloudSession,
  type DatabaseCloudSessionDependencies,
  openDatabaseCloudSession,
} from '../lib/database-cloud-session.js';

export interface PushOptions {
  force?: boolean;
  baseUrl?: string;
  json?: boolean;
}

export type PushSession = DatabaseCloudSession;

export interface PushDeps {
  openSession?: (input: {
    artifactId: string;
    baseUrl?: string;
    signal: AbortSignal;
    onWait: (wait: ProjectWait) => void;
  }) => Promise<PushSession>;
  cloud?: DatabaseCloudSessionDependencies;
}

/**
 * Push one artifact's grouped cloud upload over the project database.
 *
 * The authenticated session preserves the database authority, distinct wire/session repository
 * identities and Source Plan read client through admission and grouped dispatch.
 */
export async function pushAction(
  artifactId: string,
  opts: PushOptions = {},
  deps: PushDeps = {}
): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let waiting = false;
  const onWait = () => {
    if (waiting) return;
    waiting = true;
    writeTerminalSafeStderr(
      'Waiting for push on the selected project database; Ctrl-C cancels the wait.\n'
    );
  };
  try {
    if (!artifactId || artifactId.length === 0)
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'artifact_id is required.');
    const session = deps.openSession
      ? await deps.openSession({
          artifactId,
          baseUrl: opts.baseUrl,
          signal: controller.signal,
          onWait,
        })
      : await openDatabaseCloudSession(
          {
            selection: { kind: 'artifact', artifactId },
            baseUrl: opts.baseUrl,
            signal: controller.signal,
            onWait,
          },
          deps.cloud
        );
    try {
      const outcome = await pushDatabaseArtifact(session.handle, artifactId, {
        ...databaseCloudPushOptions(session, {
          force: opts.force,
          signal: controller.signal,
          onWait,
        }),
      });
      emitOk(outcome);
    } finally {
      session.close();
    }
  } catch (err) {
    if (err instanceof DatabaseArtifactPushUnavailableError)
      emitError(new OrcaopsError(ErrorCodes.CLOUD_PUSH_UNAVAILABLE, err.message));
    else emitError(toCloudErrorEnvelope(err));
  } finally {
    process.off('SIGINT', interrupt);
  }
}
