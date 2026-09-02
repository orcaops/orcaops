import { DETERMINISTIC_CLOUD_SYNC_KINDS } from '@orcaops/storage';

import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext } from '../lib/context.js';

export interface PushStatusOptions {
  json?: boolean;
}

interface PendingRow {
  artifact_id: string;
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
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const nowMs = Date.now();
      const rows = ctx.store.store.getCloudSyncPendingArtifacts();
      const pending: PendingRow[] = rows.map((r) => {
        const nextMs = r.next_attempt_at ? Date.parse(r.next_attempt_at) : null;
        return {
          artifact_id: r.id,
          branch: r.branch,
          started_at: r.started_at,
          cloud_synced_at: r.cloud_synced_at,
          last_push_attempt_at: r.cloud_last_push_attempt_at,
          last_push_error_kind: r.cloud_last_push_error_kind,
          last_push_error_message: r.cloud_last_push_error_message,
          consecutive_failures: r.cloud_consecutive_failures,
          next_attempt_at: r.next_attempt_at,
          next_attempt_seconds_from_now:
            nextMs === null ? null : Math.round((nextMs - nowMs) / 1000),
        };
      });

      if (opts.json) {
        emitOk({ pending });
        return;
      }
      writeTerminalSafeStdout(formatHumanSyncStatus(pending));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) {
      emitError(err);
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
    else if (p.cloud_synced_at === null) stateBits.push('never synced');
    else stateBits.push('post-sync activity');

    const nextBit =
      p.next_attempt_seconds_from_now === null
        ? 'due now'
        : p.next_attempt_seconds_from_now <= 0
          ? 'due now'
          : `next attempt in ${p.next_attempt_seconds_from_now}s`;

    lines.push(`  ${p.artifact_id}  (${p.branch})`);
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
        'content-invalid and upgrade-required entries will not clear until their remediation ' +
        '(scrub+rebuild / a newer orcaops install) is done.'
    );
  } else {
    lines.push(
      'A bare retry will not clear these: content-invalid needs scrub+rebuild (`orcaops doctor` ' +
        'shows the offending field), upgrade-required needs a newer orcaops install — then `orcaops resync`.'
    );
  }
  lines.push('');
  return lines.join('\n');
}
