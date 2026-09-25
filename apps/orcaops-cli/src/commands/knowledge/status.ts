import { describeProcessingModel } from '@orcaops/core';

import { readProcessingSurface, reportProcessingConsent } from './context.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { processingCoverageOf } from '../../lib/knowledge-processing-coverage.js';
import { describeProcessingFailure } from '../../lib/knowledge-processing-failure.js';
import {
  type ProcessingHistory,
  type ProcessingHistoryRequest,
  readProcessingHistory,
} from '../../lib/knowledge-processing-queue.js';
import {
  describeProcessingLimits,
  describeProcessingToolAccess,
} from '../../lib/knowledge-processing-terms.js';

export interface KnowledgeStatusOptions {
  json?: boolean;
  /** How many of the jobs that gave up to list. */
  limit?: number;
  /** The project-database reading. Tests replace it; no flag can. */
  history?: (request: ProcessingHistoryRequest) => Promise<ProcessingHistory>;
  now?: () => Date;
}

/**
 * `orcaops knowledge status` — what configuration says, what the settings
 * resolve to, whether consent covers them, and what is waiting in the queue. It
 * reads: no worker is started, no grant store is repaired, no database is
 * written or upgraded, nothing is prompted for.
 */
export async function knowledgeStatusAction(opts: KnowledgeStatusOptions = {}): Promise<void> {
  try {
    const limit = opts.limit ?? GAVE_UP_SHOWN;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--limit must be a positive integer.',
        'limit'
      );
    const surface = await readProcessingSurface();
    const paused = surface.resolution.status === 'paused' ? surface.resolution.reasons : [];
    const configuration =
      surface.resolution.status === 'ready' ? surface.resolution.configuration : null;
    const history = await (opts.history ?? readProcessingHistory)({
      gaveUpLimit: limit,
      ...(configuration === null ? {} : { limits: configuration.limits }),
    });
    const consent =
      configuration === null
        ? null
        : reportProcessingConsent({
            repoRoot: surface.repository.repoRoot,
            projectId: surface.projectId,
            configuration,
            backlog: history.backlog,
          });
    const queue = history.queue;
    const control = history.control;
    const leaseExpired = isLeaseExpired(history.lease, (opts.now ?? (() => new Date()))());
    const coverage = processingCoverageOf({
      enabled: surface.enabled,
      source: surface.source,
      resolution: surface.resolution,
      history,
      consent: consent?.decision ?? null,
    });

    if (opts.json === true) {
      emitOk({
        enabled: coverage.enabled,
        configuration_source: coverage.configuration_source,
        project_id: surface.projectId,
        settings:
          configuration === null
            ? null
            : {
                provider: configuration.provider,
                tool_access: configuration.toolAccess,
                model: configuration.model,
                limits: configuration.limits,
                notices: configuration.notices,
              },
        pause_reasons: coverage.pause_reasons,
        consent: consent?.decision ?? null,
        grant_store_problems: consent?.problems ?? [],
        backlog: history.backlog,
        history_problem: coverage.history_problem,
        queue,
        gave_up:
          history.gaveUp === null
            ? null
            : {
                total: history.gaveUp.total,
                jobs: history.gaveUp.jobs.map(({ job, lastAttemptDetail }) => ({
                  job_id: job.jobId,
                  gave_up_at: job.updatedAt,
                  reason: describeProcessingFailure(job.result, lastAttemptDetail),
                  result: job.result,
                  last_attempt_detail: lastAttemptDetail,
                })),
              },
        control,
        lease: history.lease,
        lease_expired: leaseExpired,
        usage: history.usage,
        coverage,
      });
      return;
    }

    const lines = [
      surface.enabled
        ? `Knowledge processing: on in ${surface.source.path}.`
        : surface.source.kind === 'none'
          ? 'Knowledge processing: off. No orcaops configuration file exists, and it is off by default.'
          : `Knowledge processing: off. knowledge_processing.enabled is false in ${surface.source.path}.`,
    ];
    if (configuration === null) {
      lines.push(
        surface.enabled
          ? 'It would not run with these settings:'
          : 'Turning it on would not make it run with these settings:'
      );
      for (const reason of paused) lines.push(`  - ${reason.message}`);
    } else {
      lines.push(
        surface.enabled ? 'Resolved settings:' : 'Resolved settings if it were turned on:',
        `  Provider: ${configuration.provider.id} (${configuration.provider.selection})`,
        ...describeProcessingToolAccess(configuration).map((line) => `  ${line}`),
        `  Model: ${describeProcessingModel(configuration.model)}`,
        '  Limits:',
        ...describeProcessingLimits(configuration).map((limit) => `    - ${limit}`)
      );
    }
    lines.push(
      consent === null
        ? 'Consent: not evaluated, because no provider and limits could be resolved.'
        : consent.decision.ok
          ? `Consent: granted (${consent.decision.grant_id}).`
          : `Consent: not granted [${consent.decision.reason}] ${consent.decision.message}`
    );
    lines.push(...describeQueue(history, leaseExpired));
    lines.push(`Coverage: ${coverage.claim.replaceAll('_', ' ')}. ${coverage.statement}`);
    lines.push(
      'A background worker starts after a capture when processing is on here; it sends nothing ' +
        'to a provider without a grant that covers the job. One worker at a time holds the ' +
        'project’s processing lease; this command starts none.'
    );
    if (!surface.enabled || consent?.decision.ok !== true)
      lines.push('Run `orcaops knowledge enable` at a terminal to turn processing on.');
    writeTerminalSafeStdout(`${lines.join('\n')}\n`);
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * A wait reason as a person reads it. `source_chunk_pending` is the one that
 * needs saying: the attempt it names succeeded, and the job is open only
 * because the source takes more than one call, so it is progress and not a
 * failure.
 */
function describeWait(waitReason: string): string {
  return waitReason === 'source_chunk_pending'
    ? 'Partly interpreted, more of the source to come'
    : `Waiting on ${waitReason}`;
}

// Must match the expiry test in `takeProcessingLease`.
function isLeaseExpired(lease: ProcessingHistory['lease'], now: Date): boolean {
  return (
    lease !== null &&
    lease.ownerId !== null &&
    lease.expiresAt !== null &&
    Date.parse(lease.expiresAt) <= now.getTime()
  );
}

const GAVE_UP_SHOWN = 5;

const NOTHING_ADMITTED = [
  'Queue: nothing has been admitted for processing yet.',
  '  Seeded, imported and converted history is never queued, and neither replaying a capture ' +
    'nor restoring a backup queues anything new; only captures made here are.',
];

function describeQueue(history: ProcessingHistory, leaseExpired: boolean): string[] {
  const queue = history.queue;
  if (history.problem !== null || queue === null) {
    return history.problem === null || history.problem.code === 'no_history'
      ? NOTHING_ADMITTED
      : [
          'Queue: the project database cannot be read, so what is waiting is unknown.',
          `  ${history.problem.message}`,
        ];
  }
  const lines =
    history.backlog.latest_admitted_sequence === null
      ? [...NOTHING_ADMITTED]
      : [
          `Queue: ${history.backlog.paused_jobs} job(s) admitted and not finished ` +
            `(newest admitted at write sequence ${history.backlog.latest_admitted_sequence}).`,
        ];
  const states = Object.entries(queue.jobs).filter(([, count]) => count > 0);
  if (states.length > 0)
    lines.push(`  By state: ${states.map(([state, count]) => `${state} ${count}`).join(', ')}`);
  for (const wait of queue.waiting) {
    lines.push(
      `  ${describeWait(wait.waitReason)}: ${wait.jobs} job(s)` +
        (wait.nextRetryAt === null ? ', no retry is due' : `, next retry at ${wait.nextRetryAt}`)
    );
  }
  const gaveUp = history.gaveUp;
  if (gaveUp !== null && gaveUp.total > 0) {
    lines.push(
      `  Gave up: ${gaveUp.total} job(s). Run \`orcaops knowledge reopen <job>\` at a terminal ` +
        'to give one a fresh attempt allowance:'
    );
    for (const { job, lastAttemptDetail } of gaveUp.jobs)
      lines.push(
        `    ${job.jobId} (${job.updatedAt}): ${describeProcessingFailure(job.result, lastAttemptDetail)}`
      );
    const unlisted = gaveUp.total - gaveUp.jobs.length;
    if (unlisted > 0)
      lines.push(
        `    …and ${unlisted} more; \`orcaops knowledge status --limit <n>\` lists more of them.`
      );
  }
  if (queue.awaitingModelResume > 0)
    lines.push(
      `  ${queue.awaitingModelResume} job(s) were captured with no model. Run ` +
        '`orcaops knowledge resume --model <job>`, or `--model --all`, at a terminal to allow ' +
        'one; nothing else lifts that choice.'
    );
  const control = history.control;
  lines.push(
    control?.paused === true
      ? `  Paused by ${control.changedBy ?? 'an unknown actor'} (${control.changedByBasis}) at ` +
          `${control.changedAt}${control.reason === null ? '' : `: ${control.reason}`}`
      : '  Not paused.'
  );
  const lease = history.lease;
  lines.push(
    lease?.ownerId == null
      ? '  Worker lease: not held. A capture made while processing is on, `knowledge enable`, ' +
          '`resume` or `retry` starts one.'
      : leaseExpired
        ? `  Worker lease: expired at ${lease.expiresAt} (last held by ${lease.ownerId}, ` +
          `generation ${lease.ownerGeneration}); the next worker takes it.`
        : `  Worker lease: held by ${lease.ownerId} (generation ` +
          `${lease.ownerGeneration}), expires ${lease.expiresAt}`
  );
  if (history.usage)
    lines.push(
      `  Calls this hour: ${history.usage.calls.used}/${history.usage.calls.limit}` +
        (history.usage.spend.budgetUsd === null
          ? '; no daily budget applies.'
          : `; spent today $${history.usage.spend.usedUsd} of $${history.usage.spend.budgetUsd}.`)
    );
  return lines;
}
