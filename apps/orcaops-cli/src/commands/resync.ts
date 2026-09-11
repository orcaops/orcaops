import { resyncDatabaseArtifacts } from '@orcaops/core/history/database-push';
import type { ProjectWait } from '@orcaops/storage/history/database';

import { toCloudErrorEnvelope } from '../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStderr } from '../io/output.js';
import {
  databaseCloudPushOptions,
  type DatabaseCloudSession,
  type DatabaseCloudSessionDependencies,
  openDatabaseCloudSession,
} from '../lib/database-cloud-session.js';

export interface ResyncOptions {
  json?: boolean;
  baseUrl?: string;
  force?: boolean;
}

export type ResyncSession = DatabaseCloudSession;

export interface ResyncDeps {
  openSession?: (input: {
    baseUrl?: string;
    signal: AbortSignal;
    onWait: (wait: ProjectWait) => void;
  }) => Promise<ResyncSession>;
  cloud?: DatabaseCloudSessionDependencies;
}

/**
 * Retry artifacts whose last cloud push may have failed.
 *
 * The project database scan flushes each pending artifact through the same authenticated builder
 * and grouped dispatch as `push`.
 */
export async function resyncAction(opts: ResyncOptions = {}, deps: ResyncDeps = {}): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let waiting = false;
  const onWait = () => {
    if (waiting) return;
    waiting = true;
    writeTerminalSafeStderr(
      'Waiting for resync on the selected project database; Ctrl-C cancels the wait.\n'
    );
  };
  try {
    const session = deps.openSession
      ? await deps.openSession({ baseUrl: opts.baseUrl, signal: controller.signal, onWait })
      : await openDatabaseCloudSession(
          {
            selection: { kind: 'resync' },
            baseUrl: opts.baseUrl,
            signal: controller.signal,
            onWait,
          },
          deps.cloud
        );
    try {
      const result = await resyncDatabaseArtifacts(session.handle, {
        ...databaseCloudPushOptions(session, {
          force: opts.force,
          signal: controller.signal,
          onWait,
        }),
        ...(session.resyncSelection ? { selection: session.resyncSelection } : {}),
      });
      emitOk(result);
    } finally {
      session.close();
    }
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  } finally {
    process.off('SIGINT', interrupt);
  }
}
