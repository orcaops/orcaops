import {
  describeProcessingModel,
  type EffectiveProcessingConfiguration,
  PROCESSING_PROCESSOR_CONTRACT,
} from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  type ProcessingConfirmationTerms,
  type ProcessingJob,
  type ProjectDatabase,
  readAllProcessingJobAttempts,
  readLatestProcessingJobReopening,
  readLatestProcessingModelConfirmation,
  readProcessingJob,
  reopenProcessingJob,
} from '@orcaops/storage/history/database';

import { resolveDisplayedConfiguration, sourceLine } from './model-resume.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { readDispatchContext } from '../../knowledge-worker/dispatch-context.js';
import { admittedSequenceOf } from '../../knowledge-worker/dispatch.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';
import {
  evaluateProcessingConsent,
  type ProcessingConsentDecision,
} from '../../lib/knowledge-processing-consent.js';
import { describeProcessingFailure } from '../../lib/knowledge-processing-failure.js';
import { readProcessingGrants } from '../../lib/knowledge-processing-grants.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';
import { type ConsentTerminal, consentTerminal } from '../../lib/knowledge-processing-terminal.js';
import {
  compareProcessingExecutionTerms,
  describeProcessingLimits,
  describeProcessingToolAccess,
  processingExecutionTerms,
} from '../../lib/knowledge-processing-terms.js';
import {
  describeWakeUp,
  type ProcessingWakeUp,
  wakeProcessingWorkerForQueue,
} from '../../lib/knowledge-processing-wakeup.js';

export interface KnowledgeReopenOptions {
  job?: string;
  json?: boolean;
  /** The person answering. Tests replace it; no flag or variable can. */
  terminal?: ConsentTerminal;
}

interface ReopenedJob {
  job_id: string;
  reopening_sequence: number;
  attempts_allowed: number;
  grant_id: string;
  /** The job was captured with no model and needs a model confirmation that fits its terms. */
  model_resume_required: boolean;
}

interface Displayed {
  job: ProcessingJob;
  worktreeRoot: string;
  configuration: EffectiveProcessingConfiguration;
  enabled: boolean;
  terms: ProcessingConfirmationTerms;
  previousSequence: number | null;
}

const CONFIRMATION = 'yes';

/**
 * `orcaops knowledge reopen <job>` — give one job that gave up a fresh attempt
 * allowance. Every attempt is a paid call, so it is built like `knowledge
 * resume --model`: it refuses without an interactive terminal, has no `--yes`,
 * shows why the job gave up and the terms it would run under before it asks,
 * and judges consent and those terms again after the answer. It never allows a
 * model for a job captured without one; that stays `resume --model`'s act.
 */
export async function knowledgeReopenAction(opts: KnowledgeReopenOptions = {}): Promise<void> {
  const json = opts.json === true;
  try {
    const terminal = opts.terminal ?? consentTerminal;
    const jobId = (opts.job ?? '').trim();
    if (jobId === '')
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Name the job to reopen: `orcaops knowledge reopen <job>`. `orcaops knowledge status` ' +
          'lists the jobs that gave up.',
        'job'
      );
    // Before anything is read, shown or asked: reopening allows new paid calls, which is a
    // person's act at a terminal, and a pipe cannot see the terms or accept them.
    if (!terminal.isInteractive())
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'A job can only be reopened at an interactive terminal. Run `orcaops knowledge reopen ' +
          '<job>` yourself in a terminal; no flag, environment variable or non-interactive ' +
          'option reopens one.'
      );

    const written = await withProcessingWriter({}, async (handle) => {
      const shown = await display(handle, gaveUp(handle, jobId));
      refuseDenied(consentFor(handle, shown.job, shown.worktreeRoot, shown.configuration));
      const needsModelResume = modelResumeRequired(handle, shown.job, shown.terms);
      writeTerminalSafeStderr(disclosure(handle, shown, needsModelResume));
      const answer = await terminal.ask(
        `Type "${CONFIRMATION}" to reopen this job, anything else declines: `
      );
      if (answer.trim().toLowerCase() !== CONFIRMATION)
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          'Declined: the job was not reopened and nothing was recorded.'
        );

      const current = await resolveDisplayedConfiguration(shown.worktreeRoot);
      const currentTerms = processingExecutionTerms({
        projectId: handle.authority.projectId,
        job: shown.job,
        worktreeRoot: shown.worktreeRoot,
        configuration: current.configuration,
      });
      const comparison = compareProcessingExecutionTerms({
        frozen: shown.terms,
        current: currentTerms,
        phase: 'dispatch',
      });
      if (!comparison.ok)
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Job ${jobId}'s terms changed outside what was shown (${comparison.changed.join(', ')}). ` +
            'Nothing was recorded; reopen it again to see the new terms.'
        );
      const decision = refuseDenied(
        consentFor(handle, shown.job, shown.worktreeRoot, current.configuration)
      );
      const actor = processingActor();
      const reopened = await reopenProcessingJob(handle, {
        reopeningId: uuidv7(),
        jobId,
        expectedUpdatedAt: shown.job.updatedAt,
        expectedPreviousSequence: shown.previousSequence,
        attemptsAllowed: shown.terms.max_attempts,
        reopenedAt: new Date().toISOString(),
        reopenedBy: actor.changedBy,
        reopenedByBasis: actor.changedByBasis,
        grantId: decision.grant_id,
      });
      if (reopened.outcome !== 'reopened')
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Job ${jobId} changed while it was shown and is now ${reopened.job.state}. Nothing was ` +
            'recorded.'
        );
      return {
        job_id: jobId,
        reopening_sequence: reopened.reopening.reopeningSequence,
        attempts_allowed: reopened.reopening.attemptsAllowed,
        grant_id: decision.grant_id,
        model_resume_required: modelResumeRequired(handle, reopened.job, currentTerms),
      } satisfies ReopenedJob;
    });
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No processing job can be reopened here: ${written.problem.message}`
      );

    // A reopened job is claimable from now on, and the wake-up never throws, so
    // nothing here can undo a reopening that was recorded.
    const woken = written.target === null ? null : wakeProcessingWorkerForQueue(written.target);
    if (json) {
      emitOk({ reopened: written.value, wake_up: woken });
      return;
    }
    writeTerminalSafeStdout(describe(written.value, woken));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function gaveUp(handle: ProjectDatabase, jobId: string): ProcessingJob {
  const job = readProcessingJob(handle, jobId);
  if (job === null)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No processing job with id "${jobId}" is admitted in this project.`,
      'job'
    );
  if (job.state === 'completed')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Job ${jobId} completed, and a completed job is never run again.`,
      'job'
    );
  if (job.state !== 'terminal_failure')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Job ${jobId} is ${job.state} and has not given up; \`orcaops knowledge retry ${jobId}\` ` +
        'makes a waiting job due now.',
      'job'
    );
  return job;
}

async function display(handle: ProjectDatabase, job: ProcessingJob): Promise<Displayed> {
  const context = readDispatchContext(job.admission);
  if (!context.ok)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Job ${job.jobId} has no usable originating worktree: ${context.detail}`
    );
  const worktreeRoot = context.context.origin.worktree_root;
  const resolved = await resolveDisplayedConfiguration(worktreeRoot);
  return {
    job,
    worktreeRoot,
    configuration: resolved.configuration,
    enabled: resolved.enabled,
    terms: processingExecutionTerms({
      projectId: handle.authority.projectId,
      job,
      worktreeRoot,
      configuration: resolved.configuration,
    }),
    previousSequence:
      handle.read((view) => readLatestProcessingJobReopening(view, job.jobId)).value
        ?.reopeningSequence ?? null,
  };
}

function consentFor(
  handle: ProjectDatabase,
  job: ProcessingJob,
  worktreeRoot: string,
  configuration: EffectiveProcessingConfiguration
): ProcessingConsentDecision {
  const grants = readProcessingGrants({ repoRoot: worktreeRoot });
  return evaluateProcessingConsent({
    grants: grants.grants,
    problems: grants.problems,
    project_id: handle.authority.projectId,
    provider: configuration.provider.id,
    processor_contract: PROCESSING_PROCESSOR_CONTRACT,
    effective_tool_access: configuration.toolAccess,
    effective_limits: configuration.limits,
    job: { admitted_sequence: admittedSequenceOf(handle, job) },
  });
}

function refuseDenied(
  decision: ProcessingConsentDecision
): Extract<ProcessingConsentDecision, { ok: true }> {
  if (decision.ok) return decision;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `${decision.code} [${decision.reason}]: ${decision.message} Nothing was recorded and the job ` +
      'was not reopened.'
  );
}

/** The check dispatch makes before it runs a job captured with no model. */
function modelResumeRequired(
  handle: ProjectDatabase,
  job: ProcessingJob,
  terms: ProcessingConfirmationTerms
): boolean {
  if (!job.withoutModel) return false;
  const confirmation = handle.read((view) =>
    readLatestProcessingModelConfirmation(view, job.jobId)
  ).value;
  return (
    confirmation === null ||
    !compareProcessingExecutionTerms({
      frozen: confirmation.terms,
      current: terms,
      phase: 'dispatch',
    }).ok
  );
}

function modelResumeNotice(jobId: string): string {
  return (
    'This capture was made with no model, and its current terms are not covered by a model ' +
    'confirmation. Reopening does not allow a model: the job waits until you run ' +
    `\`orcaops knowledge resume --model ${jobId}\` at a terminal.`
  );
}

function disclosure(handle: ProjectDatabase, shown: Displayed, needsModelResume: boolean): string {
  const { job, configuration, terms } = shown;
  const attempts = readAllProcessingJobAttempts(handle, job.jobId);
  const lastAttemptDetail = attempts[0]?.detail ?? null;
  const lines = [
    `Job ${job.jobId} gave up at ${job.updatedAt}. ` +
      describeProcessingFailure(job.result, lastAttemptDetail),
    `${sourceLine(handle, job)}; originating worktree ${shown.worktreeRoot}`,
    `  ${attempts.length} attempt(s) made so far` +
      (shown.previousSequence === null
        ? '.'
        : `, and it was reopened ${shown.previousSequence} time(s) before.`),
    '',
    `Reopening allows up to ${terms.max_attempts} more attempt(s), and every attempt is a paid ` +
      'call. A later configuration change can lower this allowance but not raise it. The ' +
      'earlier attempts and the reason it gave up are kept.',
    `Provider: ${configuration.provider.id}, run on this machine.`,
    `Model: ${describeProcessingModel(configuration.model)}.`,
    ...describeProcessingToolAccess(configuration),
    'Limits in force:',
    ...describeProcessingLimits(configuration).map((limit) => `  - ${limit}`),
    ...(shown.enabled
      ? []
      : [
          'Processing is currently off in the originating worktree, so the job waits until it is ' +
            'turned on there.',
        ]),
    ...(needsModelResume ? [modelResumeNotice(job.jobId)] : []),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function describe(reopened: ReopenedJob, woken: ProcessingWakeUp | null): string {
  const lines = [
    `Job ${reopened.job_id} is reopened with an allowance of ${reopened.attempts_allowed} ` +
      'attempt(s).',
    ...(reopened.model_resume_required ? [modelResumeNotice(reopened.job_id)] : []),
    describeWakeUp(woken),
  ];
  return `${lines.join('\n')}\n`;
}
