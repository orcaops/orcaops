import {
  describeProcessingModel,
  type KnowledgeProcessingCoverage,
  type KnowledgeProcessingResolution,
  type ProcessingConfigSource,
  resolveKnowledgeProcessing,
} from '@orcaops/core';
import {
  measurePreparedInputRequest,
  PROVIDER_CAPABILITIES,
  type ProviderProbeSnapshot,
  resolveNoToolCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import { readProjectId } from '@orcaops/project-scope';
import type { Config } from '@orcaops/storage';

import { reportProcessingConsent } from './context.js';
import { WORKER_PAUSE_ACTOR } from '../../knowledge-worker/wait-reasons.js';
import type { ProcessingConsentDecision } from '../../lib/knowledge-processing-consent.js';
import { processingCoverageOf } from '../../lib/knowledge-processing-coverage.js';
import type { ProcessingHistory } from '../../lib/knowledge-processing-queue.js';
import {
  describeProcessingLimits,
  describeProcessingToolAccess,
} from '../../lib/knowledge-processing-terms.js';
import { resolveRepositoryContext } from '../../lib/repository-context.js';
import type { DoctorCheck } from '../doctor.js';

export interface KnowledgeProcessingCheckInput {
  repoRoot: string;
  config: Config;
  /** The availability doctor already probed; this check spawns nothing of its own. */
  providerAvailability: ProviderProbeSnapshot;
  history: ProcessingHistory;
}

/**
 * What background knowledge processing would do right now, in plain terms, and
 * what to run to change it. It makes no model call, starts no worker, repairs
 * nothing, and reads the grant store without touching it.
 */
export async function checkKnowledgeProcessing(
  input: KnowledgeProcessingCheckInput
): Promise<DoctorCheck> {
  const repository = await resolveRepositoryContext({ cwd: input.repoRoot });
  const source: ProcessingConfigSource = {
    kind: repository.source.kind,
    path: repository.source.configPath,
  };
  const resolution = resolveKnowledgeProcessing({
    config: input.config,
    source,
    providerAvailability: input.providerAvailability,
    llm: {
      capabilities: PROVIDER_CAPABILITIES,
      selectDefaultProvider,
      resolveNoToolCall,
      measurePreparedInputRequest,
    },
  });
  const settings = describeSettings(resolution, source);
  // One computation of what processing has interpreted, shared with `knowledge status`, so both
  // print the same numbers and the same claim.
  const coverageWith = (consent: ProcessingConsentDecision | null) =>
    processingCoverageOf({
      enabled: input.config.knowledge_processing.enabled,
      source,
      resolution,
      history: input.history,
      consent,
    });

  if (resolution.status === 'paused') {
    const disabled = resolution.reasons.find((reason) => reason.code === 'disabled');
    if (disabled)
      return {
        name: 'knowledge-processing',
        status: 'pass',
        summary: 'off — no captured content is sent to a model for interpretation',
        details: [
          `  ${disabled.message}`,
          '  Run `orcaops knowledge enable` at a terminal to turn it on.',
        ],
      };
    return {
      name: 'knowledge-processing',
      status: 'warn',
      summary: 'enabled, but unavailable with these settings',
      details: [
        ...resolution.reasons.map((reason) => `  ${reason.message}`),
        ...settings,
        ...describeQueue(coverageWith(null)),
      ],
    };
  }

  const consent = reportProcessingConsent({
    repoRoot: repository.repoRoot,
    projectId: await readProjectId(repository.repo),
    configuration: resolution.configuration,
    backlog: input.history.backlog,
  });
  if (!consent.decision.ok)
    return {
      name: 'knowledge-processing',
      status: 'warn',
      summary: `enabled, but not consented [${consent.decision.reason}]`,
      details: [
        `  ${consent.decision.message}`,
        // An unsafe grant store is reported, never repaired.
        ...consent.problems.map((problem) => `  ${problem.message}`),
        '  Run `orcaops knowledge enable` at a terminal to record consent.',
        ...settings,
        ...describeQueue(coverageWith(consent.decision)),
      ],
    };

  const paused = input.history.control?.paused === true ? input.history.control : null;
  if (paused) {
    // The worker pauses too, when a safety property did not hold or the same
    // local condition ended attempt after attempt. Reading that as a person's
    // decision would send someone looking for the person.
    const byWorker = paused.changedBy === WORKER_PAUSE_ACTOR;
    return {
      name: 'knowledge-processing',
      status: 'warn',
      summary: byWorker
        ? 'paused for this project by the background worker'
        : 'paused for this project by a person',
      details: [
        byWorker
          ? `  The worker paused it at ${paused.changedAt}` +
            `${paused.reason === null ? '.' : `: ${paused.reason}`}`
          : `  Paused by ${paused.changedBy ?? 'an unnamed local user'} ` +
            `(${paused.changedByBasis}) at ${paused.changedAt}` +
            `${paused.reason === null ? '' : `: ${paused.reason}`}`,
        '  Run `orcaops knowledge resume` to let claiming start again.',
        ...settings,
        ...describeQueue(coverageWith(consent.decision)),
      ],
    };
  }

  const coverage = coverageWith(consent.decision);
  const queue = input.history.queue;
  if (input.history.problem !== null || queue === null)
    return {
      name: 'knowledge-processing',
      status: input.history.problem?.code === 'no_history' ? 'pass' : 'warn',
      summary:
        input.history.problem?.code === 'no_history'
          ? 'configuration and consent ready; nothing has been admitted yet'
          : 'configuration and consent ready, but the queue cannot be read',
      details: [
        `  ${input.history.problem?.message ?? 'The queue could not be read.'}`,
        ...settings,
        ...describeQueue(coverage),
      ],
    };

  const stuck = queue.jobs.terminal_failure;
  const parked = queue.waiting.filter((wait) => wait.nextRetryAt === null);
  if (stuck > 0 || parked.length > 0)
    return {
      name: 'knowledge-processing',
      status: 'warn',
      summary: `failing — ${stuck} job(s) gave up and ${parked.reduce((n, wait) => n + wait.jobs, 0)} wait on nothing`,
      details: [
        ...parked.map(
          (wait) => `  ${wait.jobs} job(s) wait on ${wait.waitReason} with no retry due`
        ),
        ...(stuck > 0
          ? [
              '  `orcaops knowledge status` lists the jobs that gave up and why; ' +
                '`orcaops knowledge reopen <job>` gives one a fresh attempt allowance at a terminal.',
            ]
          : []),
        ...(parked.length > 0
          ? [
              '  `orcaops knowledge status` lists the queue; `orcaops knowledge retry` makes a ' +
                'waiting job due now.',
            ]
          : []),
        ...settings,
        ...describeQueue(coverage),
      ],
    };

  const open = coverage.jobs?.open ?? 0;
  return {
    name: 'knowledge-processing',
    status: 'pass',
    summary:
      open === 0
        ? 'configuration and consent ready; caught up'
        : `configuration and consent ready; ${open} job(s) pending`,
    details: [
      ...settings,
      ...describeQueue(coverage),
      '  A background worker starts after a capture while processing is on here, and after ' +
        '`knowledge enable`, `resume` and `retry`. It sends nothing without a grant covering ' +
        'the job. This check starts none.',
    ],
  };
}

function describeSettings(
  resolution: KnowledgeProcessingResolution,
  source: ProcessingConfigSource
): string[] {
  const where = `  Configured in ${source.kind === 'none' ? 'no file (defaults)' : source.path}`;
  if (resolution.status === 'paused')
    return [where, `  Provider: ${resolution.provider ?? 'none could be selected'}`];
  const configuration = resolution.configuration;
  return [
    where,
    `  Provider: ${configuration.provider.id} (${configuration.provider.selection})`,
    ...describeProcessingToolAccess(configuration).map((line) => `  ${line}`),
    `  Model: ${describeProcessingModel(configuration.model)}`,
    ...describeProcessingLimits(configuration).map((limit) => `  Limit: ${limit}`),
    ...configuration.notices.map((notice) => `  ${notice.message}`),
  ];
}

function describeQueue(coverage: KnowledgeProcessingCoverage): string[] {
  const claim = `  Coverage: ${coverage.claim.replaceAll('_', ' ')}. ${coverage.statement}`;
  const jobs = coverage.jobs;
  if (jobs === null)
    return [
      coverage.history_problem === null || coverage.history_problem.code === 'no_history'
        ? '  Nothing has been admitted for processing yet.'
        : `  The queue cannot be read: ${coverage.history_problem.message}`,
      claim,
    ];
  return [
    jobs.open === 0
      ? '  Nothing is waiting in the queue.'
      : `  ${jobs.open} job(s) admitted and waiting; ${jobs.completed} completed, ` +
        `${jobs.gave_up} gave up.`,
    ...(jobs.awaiting_model_resume > 0
      ? [
          `  ${jobs.awaiting_model_resume} job(s) were captured with no model; ` +
            '`orcaops knowledge resume --model <job>` at a terminal allows one.',
        ]
      : []),
    claim,
  ];
}
