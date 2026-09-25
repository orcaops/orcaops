import {
  describeProcessingModel,
  type EffectiveProcessingConfiguration,
  type PerCallSpendLimit,
  PROCESSING_PROCESSOR_CONTRACT,
} from '@orcaops/core';
import type { EffectiveModel, LlmProvider } from '@orcaops/llm';
import {
  compareProcessingExecutionTerms,
  type ProcessingConfirmationTerms,
  type ProcessingJob,
} from '@orcaops/storage/history/database';

import type { ProcessingLimits, ProcessingSourceScope } from './knowledge-processing-consent.js';
import type { ProcessingGrantTerms } from './knowledge-processing-grants.js';
import type { ProcessingBacklog } from './knowledge-processing-queue.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * What a person is shown before consenting, and the terms the grant records.
 * {@link draftProcessingDisclosure} builds both from one input, so the grant
 * can only ever bind what was on the screen.
 */

export interface ProcessingTermsContext {
  /** The project store identity, never a name taken from repository configuration. */
  project_id: string;
  configuration: EffectiveProcessingConfiguration;
  backlog: ProcessingBacklog;
  /** The explicit choice to cover captures admitted before the grant. */
  include_backlog: boolean;
}

export interface ProcessingDisclosure {
  terms: ProcessingGrantTerms;
  /** Exactly the text shown before the question is asked. */
  text: string;
}

export interface ProcessingExecutionTermsContext {
  projectId: string;
  job: Pick<ProcessingJob, 'jobId' | 'source' | 'processorContract'>;
  worktreeRoot: string;
  configuration: EffectiveProcessingConfiguration;
}

export function processingExecutionTerms(
  context: ProcessingExecutionTermsContext
): ProcessingConfirmationTerms {
  const { configuration, job } = context;
  return {
    v: 1,
    project_id: context.projectId,
    job_id: job.jobId,
    source: job.source,
    origin: { worktree_root: context.worktreeRoot },
    processor_contract: job.processorContract,
    provider: configuration.provider,
    model:
      configuration.model.selection === 'provider_default'
        ? { selection: 'provider_default', id: null }
        : { selection: configuration.model.selection, id: configuration.model.id },
    effort:
      configuration.effort.selection === 'provider_default'
        ? { selection: 'provider_default', value: null }
        : {
            selection: configuration.effort.selection,
            value: configuration.effort.value,
          },
    tool_access: configuration.toolAccess,
    limits: configuration.limits,
    output_token_cap: configuration.outputTokenCap,
    timeout_ms: configuration.timeoutMs,
    max_attempts: configuration.maxAttempts,
  };
}

export { compareProcessingExecutionTerms };

export function draftProcessingDisclosure(context: ProcessingTermsContext): ProcessingDisclosure {
  const { configuration, backlog } = context;
  const terms: ProcessingGrantTerms = {
    project_id: context.project_id,
    provider: configuration.provider.id,
    processor_contract: PROCESSING_PROCESSOR_CONTRACT,
    source_scope: sourceScope(backlog, context.include_backlog),
    disclosed: {
      tool_access: configuration.toolAccess,
      model: disclosedModel(configuration.model),
      limits: configuration.limits,
      paused_backlog_count: backlog.paused_jobs,
    },
  };
  return { terms, text: render(terms, configuration, backlog) };
}

/**
 * The boundary a "captures from now on" grant is measured against.
 *
 * The sequence comes from the project database, never from input: a grant that
 * excluded the backlog but named 0 would cover every job ever admitted. When
 * the database reports nothing admitted at all, 0 IS that boundary — no job
 * exists at or below it to exclude. When it reports work waiting but cannot
 * name the sequence, the boundary the person chose cannot be recorded, so the
 * grant is refused rather than widened to fit.
 */
function sourceScope(backlog: ProcessingBacklog, includeBacklog: boolean): ProcessingSourceScope {
  const choice = includeBacklog ? 'included' : 'excluded';
  if (backlog.latest_admitted_sequence !== null) {
    return { admitted_after_sequence: backlog.latest_admitted_sequence, backlog: choice };
  }
  if (backlog.paused_jobs > 0) {
    throw new OrcaopsError(
      ErrorCodes.RECOVERY_REQUIRED,
      `${backlog.paused_jobs} job(s) are admitted and waiting, but the project database cannot ` +
        'say which admission sequence they stop at, so a grant cannot be bounded to captures ' +
        'from now on. Nothing was recorded and nothing was changed.'
    );
  }
  return { admitted_after_sequence: 0, backlog: choice };
}

/**
 * A model orcaops selected, however it was selected, against one the provider
 * picks for itself. Which setting chose it stays in the shown text, where
 * {@link describeProcessingModel} words it.
 */
function disclosedModel(model: EffectiveModel): ProcessingGrantTerms['disclosed']['model'] {
  return model.selection === 'provider_default'
    ? { selection: 'provider_default' }
    : { selection: 'explicit', id: model.id };
}

/** Exact, never rounded: a rounded amount in a money disclosure is a wrong amount. */
function usd(amount: number): string {
  return `$${amount}`;
}

function perCallCostLine(cap: PerCallSpendLimit, provider: LlmProvider): string {
  if (cap === 'none') return 'no per-call dollar cap applies';
  if (cap.holds === 'ceiling') {
    return `${usd(cap.usd)} per call, a hard ceiling: no call costs more`;
  }
  return (
    `${usd(cap.usd)} per call, best effort and not a cap: ${provider} stops a call only after ` +
    'the amount is exceeded, so one response can cost more'
  );
}

function perDayCostLine(cap: ProcessingLimits['max_cost_usd_per_day']): string {
  return cap === 'none'
    ? 'no daily dollar budget applies'
    : `${usd(cap)} per day across this project database, reserved before each call`;
}

/**
 * Every limit a call runs under, in one wording, so the terms a person accepts
 * and the ones `status` reports back cannot drift apart. The dollar lines say
 * which kind of promise each amount is, and an absent amount says so rather
 * than being left out.
 */
export function describeProcessingLimits(
  configuration: EffectiveProcessingConfiguration
): string[] {
  const { limits } = configuration;
  return [
    configuration.toolAccess === 'codex_restricted'
      ? `${limits.max_calls_per_hour} worker attempts per hour across this project database`
      : `${limits.max_calls_per_hour} calls per hour across this project database`,
    configuration.toolAccess === 'codex_restricted'
      ? `${configuration.maxAttempts} worker attempts per job; one Codex execution may make multiple model requests`
      : `${configuration.maxAttempts} attempts per job, and every attempt is a paid call`,
    `${configuration.timeoutMs} ms for one call`,
    `${limits.max_input_bytes} bytes of prepared input per call`,
    `${limits.max_output_bytes} response bytes kept per call`,
    ...(configuration.outputTokenCap.kind === 'enforced'
      ? [`${configuration.outputTokenCap.tokens} generated tokens per call`]
      : []),
    perCallCostLine(limits.max_cost_usd_per_call, configuration.provider.id),
    perDayCostLine(limits.max_cost_usd_per_day),
    ...(limits.max_cost_usd_per_call === 'none' || limits.max_cost_usd_per_day === 'none'
      ? ['a call-count limit is not a dollar limit']
      : []),
  ];
}

const NON_LIVE_HISTORY =
  'Seeded, imported and converted history is never sent, and replaying a capture queues ' +
  'nothing new. Restoring a backup queues nothing new either, but the jobs saved in it come ' +
  'back as they were and are sent if this grant covers them.';

function scopeLine(scope: ProcessingSourceScope, backlog: ProcessingBacklog): string {
  if (scope.backlog === 'included') {
    return (
      'Existing captures: sent. This grant covers captures already admitted as well as ' +
      `captures from now on. ${NON_LIVE_HISTORY}`
    );
  }
  return (
    'Existing captures: not sent. This grant covers only captures admitted from now on' +
    (backlog.latest_admitted_sequence === null
      ? '.'
      : ` (after admission sequence ${scope.admitted_after_sequence}).`) +
    ` ${NON_LIVE_HISTORY}`
  );
}

function waitingLine(backlog: ProcessingBacklog): string {
  if (backlog.latest_admitted_sequence === null) {
    return 'Already waiting: nothing has been admitted for processing yet, so no job is waiting.';
  }
  return backlog.paused_jobs === 1
    ? 'Already waiting: 1 job is admitted and waiting.'
    : `Already waiting: ${backlog.paused_jobs} jobs are admitted and waiting.`;
}

function render(
  terms: ProcessingGrantTerms,
  configuration: EffectiveProcessingConfiguration,
  backlog: ProcessingBacklog
): string {
  const lines = [
    'Background knowledge processing sends captured content to a model provider.',
    'These are the terms the grant records; nothing wider is ever covered by it.',
    '',
    `Provider: ${terms.provider}, run on this machine.`,
    `Model: ${describeProcessingModel(configuration.model)}.`,
    'What is sent: prepared captured content — plans, checkpoints, summaries and the',
    '  reasoning recorded with them — and the project history a job is allowed to read.',
    ...describeProcessingToolAccess(configuration),
    'Limits in force:',
    ...describeProcessingLimits(configuration).map((limit) => `  - ${limit}`),
    ...configuration.notices
      .filter((notice) => notice.code.startsWith('inherited_'))
      .map((notice) => `  ${notice.message}`),
    scopeLine(terms.source_scope, backlog),
    waitingLine(backlog),
    'These settings govern knowledge processing on this machine’s project database.',
    'They do not cover evaluator calls, other clones, or other machines.',
  ];
  return `${lines.join('\n')}\n`;
}

export function describeProcessingToolAccess(
  configuration: EffectiveProcessingConfiguration
): string[] {
  if (configuration.toolAccess === 'none') {
    return [
      'Tool access: none. The provider cannot read this repository, run commands, or',
      '  reach anything orcaops does not put in the request itself.',
    ];
  }
  return [
    'Tool access: Codex restricted. Codex runs under a deny-root sandbox with only minimal',
    '  runtime reads; command network access is disabled, supported tool categories are off,',
    '  and there is no approval path, but not every tool is absent.',
    '  Observed tool use discards the answer, but the provider event stream is not a complete',
    '  audit. This is not a no-tool guarantee; residual platform and provider risks remain.',
    '  One Codex execution can make continuation model requests after a denied tool action;',
    '  max_calls_per_hour counts worker processes, not underlying model or HTTP requests, even',
    '  though transport retries are zero.',
    'Host preflight: Codex CLI 0.154.0 or newer is required; this profile is verified on macOS.',
    '  Existing $CODEX_HOME/AGENTS.override.md or AGENTS.md instructions may also be sent to',
    '  the provider; Orcaops does not modify those files or authentication.',
    '  max_input_bytes bounds Orcaops-supplied instructions, prepared payload and schema, not',
    '  Codex-added base or global context, so it is not a total prompt-size limit.',
  ];
}
