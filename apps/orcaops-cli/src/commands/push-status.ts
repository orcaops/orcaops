import { HistoryScopeError } from '@orcaops/project-scope/history';
import { DETERMINISTIC_CLOUD_SYNC_KINDS } from '@orcaops/storage';
import { readProjectCloudSyncStatus } from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { toCloudErrorEnvelope } from '../io/cloud-error-envelope.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';

export interface PushStatusOptions {
  json?: boolean;
}

interface PendingRow {
  artifact_id: string;
  target: RemoteTarget | null;
  branch: string;
  started_at: string;
  cloud_synced_at: string | null;
  last_push_attempt_at: string | null;
  last_push_error_kind: string | null;
  last_push_error_message: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
  next_attempt_seconds_from_now: number | null;
}

/**
 * `orcaops push-status` — list local artifacts that have not reached
 * cloud yet, with the failure state from the most recent eager-push
 * attempt. Shows EVERYTHING in the drain candidate set (never-synced or
 * post-sync activity) regardless of per-artifact backoff, so the user
 * can see what's stuck even if the implicit drain is currently waiting.
 *
 * Top-level command name (with hyphen) rather than a `push status`
 * subcommand: the flat name predates `enablePositionalOptions()`
 * (parent/child option sharing is routable now) and stays for
 * CLI-surface stability; the hyphen also keeps `orcaops push status`
 * from parsing as `push` with a stray argument.
 */
export async function pushStatusAction(opts: PushStatusOptions = {}): Promise<void> {
  try {
    const ctx = await resolveDatabaseHistoryCommandContext({ profile: 'collection' });
    try {
      if (!ctx.scope.completeness.complete) {
        const issue = ctx.scope.completeness.issues[0];
        throw new HistoryScopeError(
          issue?.code ?? 'HISTORY_MISSING',
          issue?.message ?? 'Restore the selected project history before inspecting pending uploads'
        );
      }
      const nowMs = Date.now();
      const pending: PendingRow[] = ctx.scope.projects.flatMap((project) => {
        if (!project.database)
          throw new HistoryScopeError('HISTORY_MISSING', 'Restore the registered project database');
        return readProjectCloudSyncStatus(project.database)
          .rows.filter((row) => row.pending)
          .map((r) => ({
            artifact_id: r.artifactId,
            target: r.target,
            branch: r.branch,
            started_at: r.startedAt,
            cloud_synced_at: r.syncedAt,
            last_push_attempt_at: r.lastAttemptAt,
            last_push_error_kind: r.lastError?.kind ?? null,
            last_push_error_message: r.lastError?.message ?? null,
            consecutive_failures: r.consecutiveFailures,
            next_attempt_at: r.nextAttemptAt,
            next_attempt_seconds_from_now:
              r.nextAttemptAt === null
                ? null
                : Math.round((Date.parse(r.nextAttemptAt) - nowMs) / 1000),
          }));
      });

      if (opts.json) {
        emitOk({ pending });
        return;
      }
      writeTerminalSafeStdout(formatHumanSyncStatus(pending));
    } finally {
      ctx.scope.close();
    }
  } catch (err) {
    if (opts.json) {
      emitError(toCloudErrorEnvelope(err));
      return;
    }
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatHumanSyncStatus(pending: PendingRow[]): string {
  if (pending.length === 0) {
    return 'No artifacts pending cloud sync.\n';
  }
  const lines: string[] = [`Pending cloud sync (${pending.length}):`, ''];
  for (const p of pending) {
    const stateBits: string[] = [];
    if (p.consecutive_failures > 0)
      stateBits.push(`${p.consecutive_failures}× ${p.last_push_error_kind}`);
    else if (p.cloud_synced_at === null) stateBits.push('no recorded upload');
    else stateBits.push('post-sync activity');

    const nextBit =
      p.next_attempt_seconds_from_now === null
        ? 'due now'
        : p.next_attempt_seconds_from_now <= 0
          ? 'due now'
          : `next attempt in ${p.next_attempt_seconds_from_now}s`;

    lines.push(`  ${p.artifact_id}  (${p.branch})`);
    if (p.target)
      lines.push(
        `    target: ${p.target.server_url} / ${p.target.org_id} / ${p.target.account_id}`
      );
    lines.push(`    state: ${stateBits.join(', ')} — ${nextBit}`);
    if (p.last_push_error_message) {
      lines.push(`    last error: ${p.last_push_error_message}`);
    }
  }
  lines.push('');
  // A bare retry is only honest advice when at least one stuck artifact can
  // actually clear with it; deterministic kinds need their remediation first.
  const deterministic = new Set<string>(DETERMINISTIC_CLOUD_SYNC_KINDS);
  const retryable = pending.filter(
    (p) => p.last_push_error_kind === null || !deterministic.has(p.last_push_error_kind)
  );
  if (retryable.length === pending.length) {
    lines.push('Run `orcaops resync --force` to retry stuck artifacts ignoring backoff.');
  } else if (retryable.length > 0) {
    lines.push(
      'Run `orcaops resync --force` to retry the transient failures ignoring backoff. ' +
        'For content-invalid, run `orcaops doctor`, preserve the retained artifact and report ' +
        'the diagnostic for investigation. upgrade-required needs a newer orcaops install, ' +
        'then `orcaops resync`.'
    );
  } else {
    lines.push(
      'A bare retry will not clear these. For content-invalid, run `orcaops doctor`, preserve ' +
        'the retained artifact and report the diagnostic for investigation; `orcaops rebuild` ' +
        'cannot recreate or change retained history. upgrade-required needs a newer orcaops ' +
        'install, then `orcaops resync`.'
    );
  }
  lines.push('');
  return lines.join('\n');
}
