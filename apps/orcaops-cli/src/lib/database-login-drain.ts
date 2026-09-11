import { classifyCloudSyncFailure } from '@orcaops/core';
import { pushDatabaseArtifact } from '@orcaops/core/history/database-push';
import type { CredentialStore } from '@orcaops/sdk';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import {
  readProjectCloudSyncStatus,
  recordProjectCloudSyncFailure,
} from '@orcaops/storage/history/database';
import { canonicalRemoteTarget } from '@orcaops/storage/history/remote-target';

import { resolveDatabaseCaptureContext } from './database-capture-context.js';
import {
  databaseCloudPushOptions,
  type DatabaseCloudSession,
  type DatabaseCloudSessionDependencies,
  openDatabaseCloudSession,
} from './database-cloud-session.js';
import { getInvocationEnv } from './invocation-context.js';

export interface DatabaseLoginDrainOptions {
  baseUrl: string;
  orgId: string;
  accountId: string;
  credentialStore: CredentialStore;
}

export interface DatabaseLoginDrainSummary {
  attempted: number;
  timedOut: boolean;
  skippedForeignOrg: number;
}

export interface DatabaseLoginDrainDependencies {
  cloud?: DatabaseCloudSessionDependencies;
  totalBudgetMs?: number;
  perPushTimeoutMs?: number;
}

export async function drainDatabaseAfterLogin(
  input: DatabaseLoginDrainOptions,
  dependencies: DatabaseLoginDrainDependencies = {}
): Promise<DatabaseLoginDrainSummary | null> {
  if (getInvocationEnv().ORCAOPS_DISABLE_DRAIN === '1') return null;
  const options = { ...input };
  let rows: ReturnType<typeof readProjectCloudSyncStatus>['rows'];
  let target;
  try {
    target = canonicalRemoteTarget({
      server_url: options.baseUrl,
      org_id: options.orgId,
      account_id: options.accountId,
    });
    const context = await resolveDatabaseCaptureContext();
    try {
      rows = readProjectCloudSyncStatus(context.project.database).rows;
    } finally {
      context.close();
    }
  } catch {
    return null;
  }
  const now = Date.now();
  const expected = canonicalJson(target);
  const eligible = rows.filter(
    (row) => row.pending && (row.nextAttemptAt === null || Date.parse(row.nextAttemptAt) <= now)
  );
  const own = eligible.filter(
    (row) => row.target === null || canonicalJson(row.target) === expected
  );
  const ownIds = new Set(own.map((row) => row.artifactId));
  const result: DatabaseLoginDrainSummary = {
    attempted: 0,
    timedOut: false,
    skippedForeignOrg: new Set(
      eligible.filter((row) => !ownIds.has(row.artifactId)).map((row) => row.artifactId)
    ).size,
  };
  const candidates = own
    .sort(
      (a, b) =>
        Number(a.syncedAt !== null) - Number(b.syncedAt !== null) ||
        b.startedAt.localeCompare(a.startedAt) ||
        a.artifactId.localeCompare(b.artifactId)
    )
    .slice(0, 20);
  const deadline = Date.now() + (dependencies.totalBudgetMs ?? 3000);
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.timedOut = true;
      break;
    }
    const stop = new AbortController();
    const timer = setTimeout(
      () => stop.abort(),
      Math.min(remaining, dependencies.perPushTimeoutMs ?? 2000)
    );
    let session: DatabaseCloudSession | undefined;
    const attemptStartedAt = new Date().toISOString();
    result.attempted++;
    try {
      session = await openDatabaseCloudSession(
        {
          selection: { kind: 'artifact', artifactId: candidate.artifactId },
          baseUrl: options.baseUrl,
          target,
          signal: stop.signal,
          operation: 'pending upload after login',
        },
        { ...dependencies.cloud, resolveCredentials: () => options.credentialStore }
      );
      await pushDatabaseArtifact(
        session.handle,
        candidate.artifactId,
        databaseCloudPushOptions(session, { signal: stop.signal })
      );
    } catch (cause) {
      // Authentication already succeeded; a failed optional upload cannot undo login.
      if (stop.signal.aborted) result.timedOut = true;
      const code = cause instanceof Error && 'code' in cause ? cause.code : null;
      if (
        session &&
        !['SECRET_IN_PAYLOAD', 'CLOUD_TARGET_CHANGED', 'AUTHORITY_MISMATCH'].includes(String(code))
      ) {
        const observation = new AbortController();
        const timeout = setTimeout(
          () => observation.abort(),
          Math.max(1, Math.min(2000, deadline - Date.now()))
        );
        try {
          const failure = stop.signal.aborted
            ? { kind: 'timeout' as const, message: null }
            : classifyCloudSyncFailure(cause);
          await recordProjectCloudSyncFailure(
            session.handle,
            {
              operationId: uuidv7(),
              revisionId: uuidv7(),
              artifactId: candidate.artifactId,
              target,
              ...failure,
              attemptStartedAt,
              attemptedAt: new Date().toISOString(),
            },
            { signal: observation.signal, secretAllow: session.context.config.redact.allow }
          );
        } catch {
          // Optional failure bookkeeping must not turn a completed login into a failure.
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        session?.close();
      } catch {
        /* Login remains successful if its optional drain cannot close cleanly. */
      }
    }
  }
  return result;
}
