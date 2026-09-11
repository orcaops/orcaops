import { isDeepStrictEqual } from 'node:util';

import {
  assertNoSecretsInPayload,
  type BranchLineageEntry,
  BranchLineageEntrySchema,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import {
  type AppendProjectArtifactEvents,
  appendProjectArtifactEvents,
  openProjectDatabase,
  ProjectDatabaseError,
  queryProjectArtifacts,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { writeTerminalSafeStderr } from '../io/output.js';
import {
  createContextRevalidator,
  historyRepository,
  requireRepositoryScope,
} from '../lib/database-branch-history.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { runCapture } from '../lib/run-capture.js';

export interface LineageOptions {
  /** Override the branch sync operates on (defaults to the current git branch). */
  branch?: string;
  json?: boolean;
}

interface LineageResult extends Record<string, unknown> {
  branch: string;
  head_sha: string;
  /** Rebase / amend updates: latest entry on current branch advanced to HEAD. */
  updated: Array<{ artifact_id: string; prior_sha: string; new_sha: string }>;
  /** Artifacts whose latest entry on current branch already pointed at HEAD. */
  skipped: Array<{ artifact_id: string; reason: 'already-current' }>;
  /** Merge detection: artifacts whose other-branch lineage SHA is now reachable from HEAD. */
  merged: Array<{
    artifact_id: string;
    source_branch: string;
    source_sha: string;
    new_sha: string;
  }>;
}

/** Lineage records observed Git ancestry; it never adopts or reopens artifact execution. */
export async function lineageAction(received: LineageOptions = {}): Promise<void> {
  await runCapture(async () => {
    const opts = structuredClone(received);
    if (
      opts.branch !== undefined &&
      (typeof opts.branch !== 'string' || !opts.branch.trim() || /[\r\n\0]/u.test(opts.branch))
    )
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Provide a nonempty branch name.', 'branch');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    let context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>> | undefined;
    try {
      context = await resolveDatabaseHistoryCommandContext({ profile: 'git-history' });
      const selected = requireRepositoryScope(context.scope);
      const repo = historyRepository(selected.git.worktreeRoot);
      const branch = opts.branch ?? selected.git.branch ?? 'HEAD';
      const headSha = selected.git.headOid;
      if (!headSha)
        throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Lineage requires a committed Git HEAD.');
      const ts = new Date().toISOString();
      assertNoSecretsInPayload({ ...opts, branch, headSha }, context.config.redact.allow);
      const revalidate = createContextRevalidator(context.scope);
      const result: LineageResult = {
        branch,
        head_sha: headSha,
        updated: [],
        skipped: [],
        merged: [],
      };
      const prepared: Array<{
        request: AppendProjectArtifactEvents;
        prior: BranchLineageEntry;
        event: 'rebased' | 'merged';
      }> = [];
      const rows = queryProjectArtifacts(selected.database, { profile: 'details' }).rows;
      for (const row of rows) {
        if (controller.signal.aborted)
          throw new ProjectDatabaseError('CANCELLED', 'Lineage synchronization cancelled.');
        let lineage: BranchLineageEntry[];
        try {
          lineage = BranchLineageEntrySchema.array().parse(
            JSON.parse(row.detailsJson!).branchLineage
          );
        } catch (cause) {
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'Retained lineage metadata is invalid; preserve history for explicit repair.',
            { cause }
          );
        }
        const revision = {
          generation: row.generation,
          orderedHash: row.orderedHash,
          eventCount: row.eventCount,
          byteLength: row.byteLength,
          tailEventId: row.tailEventId,
        };
        const retained = readProjectArtifact(selected.database, row.artifactId, revision);
        if (!retained)
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'Selected lineage history changed; repeat the original command.'
          );
        if (!isDeepStrictEqual(retained.thread.artifactJson!.branch_lineage, lineage))
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'Lineage metadata disagrees with retained history; explicitly rebuild the derived rows.'
          );
        const prior = retained.thread.artifactJson!.branch_lineage.at(-1);
        if (!prior) continue;
        if (prior.head_sha === headSha) {
          if (prior.branch === branch)
            result.skipped.push({ artifact_id: row.artifactId, reason: 'already-current' });
          continue;
        }
        const event = prior.branch === branch ? 'rebased' : 'merged';
        if (event === 'merged') {
          const ancestry = await repo.checkReachability(prior.head_sha, headSha);
          if (ancestry === 'unknown')
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              'Cannot determine retained commit ancestry. Run `orcaops doctor` and restore the unavailable Git evidence.'
            );
          if (ancestry === 'unreachable') continue;
        }
        const entry = BranchLineageEntrySchema.parse({ branch, head_sha: headSha, ts, event });
        const operationId = uuidv7();
        const draft = await prepareArtifactDraft(
          {
            artifactId: row.artifactId,
            priorEvents: retained.thread.events,
            authoredPayload: entry,
            secretAllow: context.config.redact.allow,
            idempotencyBlocks: [],
          },
          (semantics) =>
            semantics.appendBranchLineage(row.artifactId, entry, { idempotencyKey: operationId })
        );
        if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
        prepared.push({
          prior,
          event,
          request: {
            operationId,
            artifactId: row.artifactId,
            expectedRevision: revision,
            eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
            sidecarPayloads: draft.events.flatMap((event) =>
              event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
            ),
            secretAllow: [...context.config.redact.allow],
          },
        });
      }
      if (controller.signal.aborted)
        throw new ProjectDatabaseError('CANCELLED', 'Lineage synchronization cancelled.');
      if (!prepared.length) return result;
      await revalidate();
      if (controller.signal.aborted)
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Lineage synchronization cancelled before writer open.'
        );
      const writer = await openProjectDatabase({
        authority: selected.authority,
        mode: 'writer',
        signal: controller.signal,
      });
      let waiting = false;
      try {
        for (const item of prepared) {
          await appendProjectArtifactEvents(writer, item.request, {
            signal: controller.signal,
            onWait: () => {
              if (waiting) return;
              waiting = true;
              writeTerminalSafeStderr(
                'Waiting for lineage synchronization on the selected project database; Ctrl-C cancels the wait.\n'
              );
            },
          });
          if (item.event === 'rebased')
            result.updated.push({
              artifact_id: item.request.artifactId,
              prior_sha: item.prior.head_sha,
              new_sha: headSha,
            });
          else
            result.merged.push({
              artifact_id: item.request.artifactId,
              source_branch: item.prior.branch,
              source_sha: item.prior.head_sha,
              new_sha: headSha,
            });
        }
      } finally {
        writer.close();
      }
      return result;
    } catch (cause) {
      throw historyScopeCommandError(cause);
    } finally {
      context?.scope.close();
      process.off('SIGINT', interrupt);
    }
  });
}
