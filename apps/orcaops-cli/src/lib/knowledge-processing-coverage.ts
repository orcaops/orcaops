import {
  knowledgeProcessingCoverage,
  type KnowledgeProcessingCoverage,
  type KnowledgeProcessingJobs,
  type KnowledgeProcessingResolution,
  type ProcessingConfigSource,
} from '@orcaops/core';

import type { ProcessingConsentDecision } from './knowledge-processing-consent.js';
import type { ProcessingHistory } from './knowledge-processing-queue.js';

export interface ProcessingCoverageInput {
  /** `knowledge_processing.enabled` as the governing configuration file carries it. */
  enabled: boolean;
  source: ProcessingConfigSource;
  /**
   * Omitted by a caller that did not resolve the workload, which means no pause reason is named.
   * The claim never rests on one — a durable project pause reaches it through the queue instead —
   * so leaving it out withholds detail and can never turn a `partial` answer into a `complete` one.
   */
  resolution?: KnowledgeProcessingResolution;
  history: ProcessingHistory;
  /** Null when no provider and limits resolved, so consent was never evaluated. */
  consent: ProcessingConsentDecision | null;
  /**
   * The knowledge boundary the answer this coverage belongs to was read at. Omitted, the store's
   * own committed sequence is used, which is the boundary `status` and `doctor` ask about.
   */
  boundary?: number | null;
}

/**
 * The one computation of what background processing has interpreted, from the configuration and
 * the queue that `knowledge status`, `doctor` and a context answer all already read. They report
 * the same numbers and the same claim because all three come from here; a second reading of the
 * queue elsewhere is how two surfaces start disagreeing.
 *
 * It reads nothing of its own — every input is the caller's — so it starts no worker, opens no
 * store and writes nothing.
 */
export function processingCoverageOf(input: ProcessingCoverageInput): KnowledgeProcessingCoverage {
  const { history, resolution } = input;
  const queue = history.queue;
  const jobs: KnowledgeProcessingJobs | null =
    history.problem !== null || queue === null
      ? null
      : {
          open: queue.jobs.pending + queue.jobs.running + queue.jobs.retryable_failure,
          waiting: queue.waiting.reduce((total, group) => total + group.jobs, 0),
          awaiting_model_resume: queue.awaitingModelResume,
          completed: queue.jobs.completed,
          gave_up: queue.jobs.terminal_failure,
        };
  return knowledgeProcessingCoverage({
    enabled: input.enabled,
    configuration_source: input.source,
    // `disabled` is no reason a turned-on workload would still not run, and `enabled` beside it
    // already says so. Leaving it in would make this list depend on whether the caller resolved
    // with enablement assumed, which is how two surfaces start printing different ones.
    pause_reasons:
      resolution?.status === 'paused'
        ? resolution.reasons.filter((reason) => reason.code !== 'disabled')
        : [],
    consent:
      input.consent === null
        ? null
        : { granted: input.consent.ok, reason: input.consent.ok ? null : input.consent.reason },
    project_paused: history.control?.paused === true,
    history_problem: history.problem,
    jobs,
    latest_admitted_sequence: queue?.latestAdmittedSequence ?? null,
    eligible_sources: queue?.eligibleSources ?? 0,
    missing_eligible_sources: queue?.missingEligibleSources ?? 0,
    latest_eligible_sequence: queue?.latestEligibleSequence ?? null,
    boundary: input.boundary === undefined ? history.boundary : input.boundary,
    extraction: queue?.extraction,
  });
}
