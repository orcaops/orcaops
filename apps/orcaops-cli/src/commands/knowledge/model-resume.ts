import {
  describeProcessingModel,
  type EffectiveProcessingConfiguration,
  PROCESSING_PROCESSOR_CONTRACT,
} from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  type ProcessingJob,
  type ProcessingModelConfirmation,
  type ProjectDatabase,
  readLatestProcessingModelConfirmation,
  readProcessingJob,
  recordProcessingModelConfirmation,
} from '@orcaops/storage/history/database';

import { resolveProcessingFor } from './context.js';
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
import { readRetainedJobSource } from '../../knowledge-worker/job-source.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';
import {
  evaluateProcessingConsent,
  type ProcessingConsentDecision,
} from '../../lib/knowledge-processing-consent.js';
import { readProcessingGrants } from '../../lib/knowledge-processing-grants.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';
import { type ConsentTerminal, consentTerminal } from '../../lib/knowledge-processing-terminal.js';
import {
  compareProcessingExecutionTerms,
  describeProcessingLimits,
  processingExecutionTerms,
} from '../../lib/knowledge-processing-terms.js';
import {
  describeWakeUp,
  type ProcessingWakeUp,
  wakeProcessingWorkerForQueue,
} from '../../lib/knowledge-processing-wakeup.js';
import { resolveRepositoryContext } from '../../lib/repository-context.js';

export interface KnowledgeModelResumeOptions {
  /** The one job to resume; `all` covers every held job instead. */
  job?: string;
  all?: boolean;
  json?: boolean;
  /** The person answering. Tests replace it; no flag or variable can. */
  terminal?: ConsentTerminal;
}

interface ResumedJob {
  job_id: string;
  outcome: 'resumed' | 'consent_denied';
  /** The grant the resume rests on, when one was recorded. */
  grant_id: string | null;
  /** `CONSENT_DENIED` and its reason, when consent refused this job. */
  denial: { code: 'CONSENT_DENIED'; reason: string; message: string } | null;
}

interface DisplayedJob {
  job: ProcessingJob;
  worktreeRoot: string;
  configuration: EffectiveProcessingConfiguration;
  terms: Parameters<typeof recordProcessingModelConfirmation>[1]['terms'];
  previous: ProcessingModelConfirmation | null;
  enabled: boolean;
}

const CONFIRMATION = 'yes';

/**
 * `orcaops knowledge resume --model <job>` and `--model --all` — lift the
 * no-model choice an invocation made, for jobs a person names, at a terminal.
 *
 * It is the only thing that can: a job admitted with `--no-llm` is never
 * claimed, and no capture, retry or project resume changes that. So it is built
 * like `enable` rather than like the other scheduling verbs — it refuses
 * without an interactive terminal, has no `--yes`, shows what it is about to
 * allow before it asks, and judges consent with exactly the decision dispatch
 * will make. A denial records nothing.
 */
export async function knowledgeModelResumeAction(
  opts: KnowledgeModelResumeOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const terminal = opts.terminal ?? consentTerminal;
    const selected = (opts.job ?? '').trim();
    const all = opts.all === true;
    if (selected !== '' && all)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Name one job or pass `--all`, not both: `orcaops knowledge resume --model <job>` ' +
          'resumes that job, `orcaops knowledge resume --model --all` resumes every job this ' +
          'project admitted without a model.',
        'job'
      );
    if (selected === '' && !all)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Say which jobs to allow a model for: `orcaops knowledge resume --model <job>` for one, ' +
          'or `orcaops knowledge resume --model --all` for every job this project admitted ' +
          'without a model. `orcaops knowledge resume` on its own lifts the project pause and ' +
          'changes no job.',
        'job'
      );
    // Before anything is read, shown or asked: allowing a model is a person's
    // act at a terminal, and a pipe cannot see the terms or accept them.
    if (!terminal.isInteractive())
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'A model resume can only be given at an interactive terminal. Run `orcaops knowledge ' +
          'resume --model` yourself in a terminal; no flag, environment variable or ' +
          'non-interactive option lifts an invocation’s no-model choice.'
      );

    const written = await withProcessingWriter({}, async (handle) => {
      const jobs = held(handle, selected === '' ? null : selected);
      if (jobs.length === 0) return [] as ResumedJob[];
      const displayed = await resolveDisplayedJobs(handle, jobs);
      assertEquivalentBatch(displayed);
      writeTerminalSafeStderr(disclosure(handle, displayed));
      const answer = await terminal.ask(
        `Type "${CONFIRMATION}" to allow a model to see ${
          jobs.length === 1 ? 'this capture' : `these ${jobs.length} captures`
        }, anything else declines: `
      );
      if (answer.trim().toLowerCase() !== CONFIRMATION)
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          'Declined: no model resume was recorded and every job is left exactly as it was.'
        );
      const actor = processingActor();
      const resumed: ResumedJob[] = [];
      for (const shown of displayed) {
        const { job } = shown;
        const current = await resolveDisplayedConfiguration(shown.worktreeRoot);
        const currentTerms = processingExecutionTerms({
          projectId: handle.authority.projectId,
          job,
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
            `Job ${job.jobId}'s terms changed outside the displayed envelope (${comparison.changed.join(', ')}). Confirm the new terms again.`
          );
        const grants = readProcessingGrants({ repoRoot: shown.worktreeRoot });
        const decision = evaluateProcessingConsent({
          grants: grants.grants,
          problems: grants.problems,
          project_id: handle.authority.projectId,
          provider: current.configuration.provider.id,
          processor_contract: PROCESSING_PROCESSOR_CONTRACT,
          effective_tool_access: current.configuration.toolAccess,
          effective_limits: current.configuration.limits,
          job: { admitted_sequence: admittedSequenceOf(handle, job) },
        });
        if (!decision.ok) {
          resumed.push(denied(job.jobId, decision));
          continue;
        }
        await recordProcessingModelConfirmation(handle, {
          confirmationId: uuidv7(),
          jobId: job.jobId,
          expectedPreviousSequence: shown.previous?.confirmationSequence ?? null,
          confirmedAt: new Date().toISOString(),
          confirmedBy: actor.changedBy,
          confirmedByBasis: actor.changedByBasis,
          grantId: decision.grant_id,
          terms: shown.terms,
        });
        resumed.push({
          job_id: job.jobId,
          outcome: 'resumed',
          grant_id: decision.grant_id,
          denial: null,
        });
      }
      return resumed;
    });
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No processing job can be resumed here: ${written.problem.message}`
      );

    const resumed = written.value;
    const anyResumed = resumed.some((entry) => entry.outcome === 'resumed');
    const refusal = resumed.find((entry) => entry.denial !== null)?.denial ?? null;
    if (!anyResumed && refusal !== null)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `${refusal.code} [${refusal.reason}]: ${refusal.message} Nothing was recorded and no job ` +
          'changed.'
      );
    // A resumed job is claimable from now on, and the wake-up never throws, so
    // nothing here can undo a resume that was recorded.
    const woken =
      anyResumed && written.target !== null ? wakeProcessingWorkerForQueue(written.target) : null;
    if (json) {
      emitOk({ resumed, wake_up: woken });
      return;
    }
    writeTerminalSafeStdout(describe(resumed, woken));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function denied(
  jobId: string,
  decision: Extract<ProcessingConsentDecision, { ok: false }>
): ResumedJob {
  return {
    job_id: jobId,
    outcome: 'consent_denied',
    grant_id: null,
    denial: { code: decision.code, reason: decision.reason, message: decision.message },
  };
}

/**
 * The jobs this act covers: open jobs this project admitted without a model
 * that no resume has lifted — exactly the ones `knowledge status` counts as
 * needing one. A named job is reported as it stands instead, so a person who
 * names a job that needs nothing is told which it is.
 */
function held(handle: ProjectDatabase, jobId: string | null): ProcessingJob[] {
  if (jobId !== null) {
    const job = readProcessingJob(handle, jobId);
    if (job === null)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `No processing job with id "${jobId}" is admitted in this project.`,
        'job'
      );
    if (!job.withoutModel)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Job ${jobId} was admitted with a model, so there is no no-model choice to lift.`,
        'job'
      );
    if (!['pending', 'retryable_failure'].includes(job.state))
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Job ${jobId} is ${job.state}; only an unfinished idle job can be confirmed.`,
        'job'
      );
    return [job];
  }
  return handle
    .read((view) =>
      view.all<{ jobId: string }>(
        `SELECT job_id AS jobId FROM processing_jobs
          WHERE without_model=1 AND NOT EXISTS (
            SELECT 1 FROM processing_model_confirmations c
              WHERE c.job_id=processing_jobs.job_id
          ) AND state IN ('pending','retryable_failure')
          ORDER BY admitted_at, job_id`
      )
    )
    .value.map((row) => readProcessingJob(handle, row.jobId)!);
}

export async function resolveDisplayedConfiguration(worktreeRoot: string): Promise<{
  configuration: EffectiveProcessingConfiguration;
  enabled: boolean;
}> {
  let repository;
  try {
    repository = await resolveRepositoryContext({
      cwd: worktreeRoot,
      root: worktreeRoot,
      requireInit: false,
    });
  } catch (err) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `The originating worktree ${worktreeRoot} cannot be resolved: ${(err as Error).message}. Nothing was recorded.`
    );
  }
  const source = { kind: repository.source.kind, path: repository.source.configPath } as const;
  const resolution = await resolveProcessingFor(repository.config, source);
  if (resolution.status !== 'ready')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `The originating worktree ${worktreeRoot} has no runnable processing terms: ` +
        resolution.reasons.map((reason) => reason.message).join(' ') +
        ' Nothing was recorded.'
    );
  return {
    configuration: resolution.configuration,
    enabled: repository.config.knowledge_processing.enabled,
  };
}

async function resolveDisplayedJobs(
  handle: ProjectDatabase,
  jobs: readonly ProcessingJob[]
): Promise<DisplayedJob[]> {
  return Promise.all(
    jobs.map(async (job) => {
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
        previous: handle.read((view) => readLatestProcessingModelConfirmation(view, job.jobId))
          .value,
      };
    })
  );
}

function sharedEnvelope(displayed: DisplayedJob): string {
  const {
    project_id: _project,
    job_id: _job,
    source: _source,
    origin: _origin,
    ...terms
  } = displayed.terms;
  return JSON.stringify(terms);
}

function assertEquivalentBatch(displayed: readonly DisplayedJob[]): void {
  if (new Set(displayed.map(sharedEnvelope)).size <= 1) return;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    'The selected jobs resolve to different providers, models, effort, tools or limits in their ' +
      'originating worktrees. Confirm each job separately so every prompt states one exact envelope.'
  );
}

/** What one job would send: where the capture came from, and under what terms. */
export function sourceLine(handle: ProjectDatabase, job: ProcessingJob): string {
  const where = job.source.kind === 'capture_event' ? job.source.event_id : job.source.source_id;
  const context = readDispatchContext(job.admission);
  if (!context.ok || job.source.kind !== 'capture_event')
    return `  ${job.jobId}: source ${where}, admitted ${job.admittedAt}`;
  const read = readRetainedJobSource(handle, {
    artifactId: context.context.artifact_id,
    eventId: job.source.event_id,
  });
  const what = read.ok ? read.source.eventType : 'a source that cannot be read';
  return (
    `  ${job.jobId}: the ${what} of artifact ${context.context.artifact_id}, ` +
    `admitted ${job.admittedAt}`
  );
}

function disclosure(handle: ProjectDatabase, displayed: readonly DisplayedJob[]): string {
  const configuration = displayed[0]!.configuration;
  const lines = [
    displayed.length === 1
      ? 'This capture was made with no model, and allowing one sends its content to a provider:'
      : `These ${displayed.length} captures were made with no model, and allowing one sends their ` +
        'content to a provider:',
    ...displayed.map(
      ({ job, worktreeRoot }) => `${sourceLine(handle, job)}; originating worktree ${worktreeRoot}`
    ),
    '',
    `Provider: ${configuration.provider.id}, run on this machine.`,
    `Model: ${describeProcessingModel(configuration.model)}.`,
    'Limits in force:',
    ...describeProcessingLimits(configuration).map((limit) => `  - ${limit}`),
    ...(displayed.some((entry) => !entry.enabled)
      ? [
          'Processing is currently off in at least one originating worktree, so that job remains held until it is enabled there.',
        ]
      : []),
    'Consent is judged for each job exactly as the worker judges it; a job the grant does not',
    '  cover records nothing.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function describe(resumed: readonly ResumedJob[], woken: ProcessingWakeUp | null): string {
  if (resumed.length === 0)
    return 'No admitted processing job is waiting on a model resume, so nothing was changed.\n';
  const lines: string[] = [];
  const allowed = resumed.filter((entry) => entry.outcome === 'resumed');
  lines.push(
    allowed.length === 1
      ? '1 job may now be sent to a model.'
      : `${allowed.length} job(s) may now be sent to a model.`
  );
  for (const entry of allowed) lines.push(`  ${entry.job_id}: allowed under ${entry.grant_id}`);
  for (const entry of resumed.filter((job) => job.denial !== null))
    lines.push(
      `  ${entry.job_id}: ${entry.denial!.code} [${entry.denial!.reason}] ${entry.denial!.message}`
    );
  lines.push('The choice each invocation made is kept on record; nothing was erased.');
  lines.push(describeWakeUp(woken));
  return `${lines.join('\n')}\n`;
}
