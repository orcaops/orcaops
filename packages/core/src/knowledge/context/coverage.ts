// What background processing has and has not interpreted, as one field every answer carries.
//
// "Completed through this source sequence" is about PROCESSING, not about discovery: it says the
// worker settled every job admitted at or before the boundary, never that every requirement in
// those sources was found. So the claim is derived from what the queue and the configuration
// actually say, and a completeness number exists only on the one claim that earns it. Disabled,
// failed and never-processed history can never read as a complete, empty requirement set.
//
// Pure: every input is an argument, so the same facts always give the same coverage and the same
// wording, and `knowledge status`, `doctor` and a context answer cannot drift apart.
import type { ProcessingQueue } from '@orcaops/storage/history/database';

import type { ProcessingConfigSource, ProcessingPauseReason } from '../processing-config.js';

export type KnowledgeProcessingClaim = 'complete' | 'partial' | 'not_processed' | 'unknown';

export type KnowledgeProcessingHistoryCode = 'no_history' | 'upgrade_required' | 'unreadable';

export interface KnowledgeProcessingHistoryProblem {
  code: KnowledgeProcessingHistoryCode;
  message: string;
}

/** Whether a grant covers a job admitted now, as the consent decision answered it. */
export interface KnowledgeProcessingConsent {
  granted: boolean;
  /** The denial reason the decision named, or null when it granted. */
  reason: string | null;
}

export interface KnowledgeProcessingJobs {
  /** Currently unfinished among jobs admitted through the requested boundary. */
  open: number;
  /** Open jobs held on a recorded wait reason. */
  waiting: number;
  /** Open jobs whose invocation-level no-model choice nothing has lifted. */
  awaiting_model_resume: number;
  completed: number;
  /** Jobs that stopped unsuccessfully; earlier units may already have committed. */
  gave_up: number;
}

const NOTHING_ADMITTED: KnowledgeProcessingJobs = {
  open: 0,
  waiting: 0,
  awaiting_model_resume: 0,
  completed: 0,
  gave_up: 0,
};

export interface KnowledgeProcessingFacts {
  /** `knowledge_processing.enabled` as the governing configuration file carries it. */
  enabled: boolean;
  configuration_source: ProcessingConfigSource;
  /** Why a turned-on workload would still not run. */
  pause_reasons: readonly ProcessingPauseReason[];
  /** Null when no provider and limits resolved, so consent was never evaluated. */
  consent: KnowledgeProcessingConsent | null;
  /** The durable project-wide pause, which no configuration expresses. */
  project_paused: boolean;
  history_problem: KnowledgeProcessingHistoryProblem | null;
  /** Null when the queue could not be read. */
  jobs: KnowledgeProcessingJobs | null;
  /** The write sequence of the newest admitting operation, or null when nothing was admitted. */
  latest_admitted_sequence: number | null;
  /** Sources the live capture path should have admitted through this read. */
  eligible_sources: number;
  /** Eligible sources with no retained job. */
  missing_eligible_sources: number;
  /** The newest eligible source operation through this read. */
  latest_eligible_sequence: number | null;
  /** The knowledge boundary that selected the eligible-source cohort and limits the answer. */
  boundary: number | null;
  extraction?: ProcessingQueue['extraction'];
}

export interface KnowledgeProcessingCoverage extends KnowledgeProcessingFacts {
  claim: KnowledgeProcessingClaim;
  /**
   * The eligible-source watermark whose selected cohort is currently settled. This does not say
   * that interpretation output committed after the answer's boundary is visible in that answer.
   * Null on every claim but `complete`.
   */
  completed_through: number | null;
  /** The claim in one sentence, saying what it is and is not about. */
  statement: string;
}

const NOT_ABOUT_DISCOVERY =
  'That is about processing, not proof that every requirement in those sources was found.';

function claimOf(facts: KnowledgeProcessingFacts): KnowledgeProcessingClaim {
  // A history this build cannot read says nothing about what was interpreted, whatever
  // configuration says now: processing may have run under an earlier release and left work here.
  const problem = facts.history_problem;
  if (problem !== null && problem.code !== 'no_history') return 'unknown';
  // A repository with no history holds no queue, so a queue that could not be read is explained
  // there and is the ordinary empty case. Anywhere else a queue nothing could read says nothing
  // about what was interpreted, and `unknown` is the only honest claim.
  if (facts.jobs === null && problem === null) return 'unknown';
  if (!facts.enabled) return 'not_processed';
  if (problem !== null || facts.jobs === null || facts.eligible_sources === 0)
    return 'not_processed';
  if (
    facts.jobs.open > 0 ||
    facts.jobs.gave_up > 0 ||
    facts.project_paused ||
    facts.missing_eligible_sources > 0
  )
    return 'partial';
  return 'complete';
}

function statementOf(claim: KnowledgeProcessingClaim, facts: KnowledgeProcessingFacts): string {
  const jobs = facts.jobs ?? NOTHING_ADMITTED;
  const at = facts.boundary === null ? 'this read' : `write sequence ${facts.boundary}`;
  switch (claim) {
    case 'complete':
      return (
        `Current processing status is complete for eligible sources admitted through source ` +
        `sequence ${completedThrough(facts) ?? 'none'} and selected at ${at}. This answer's ` +
        `knowledge is independently limited to ${at}; interpretation output committed after ` +
        `that boundary may be absent. ` +
        NOT_ABOUT_DISCOVERY
      );
    case 'partial':
      return (
        `Current processing status is behind for the eligible-source cohort selected through ` +
        `${at}: ${jobs.open} job(s) admitted and not finished, ${jobs.gave_up} gave up, ` +
        `${facts.missing_eligible_sources} eligible source(s) have no admitted job, and the ` +
        `newest eligible source is sequence ${facts.latest_eligible_sequence ?? 'none'}` +
        `${facts.project_paused ? ', with the project paused' : ''}. Captures published since may ` +
        'carry requirements nothing has interpreted yet, so this answer claims no completeness.'
      );
    case 'not_processed':
      if ((facts.extraction?.settledUnits ?? 0) > 0)
        return (
          `Background processing is off now; the sampled history retains ${facts.extraction!.settledUnits} ` +
          'settled unit(s), including any work saved before a job stopped. This answer claims ' +
          'no completeness. Raw captures are still searchable.'
        );
      if (jobs.completed === 0 && (jobs.open > 0 || jobs.gave_up > 0))
        return (
          'Background processing is off now. Retained jobs may include earlier partial work; ' +
          'this answer claims no completeness. Raw captures are still searchable.'
        );
      // Processing that ran and was then turned off interpreted something, and saying it
      // interpreted nothing would be false about work this store holds. The claim stays: what is
      // off now covers nothing since, and nothing here may read as complete.
      return jobs.completed > 0
        ? `Background processing is off now; ${jobs.completed} job(s) were interpreted earlier ` +
            'and nothing since, so no automatic relationship covers the captures after them and ' +
            'this answer claims no completeness. Raw captures are still searchable.'
        : 'Background processing has interpreted nothing here, so no automatic relationship ' +
            'covers these captures and this answer claims no completeness. Raw captures are ' +
            'still searchable.';
    case 'unknown':
      return (
        'How much has been interpreted is unknown: ' +
        `${facts.history_problem?.message ?? 'the processing history could not be read.'} ` +
        'This answer claims no completeness.'
      );
  }
}

function extractionStatement(facts: KnowledgeProcessingFacts): string {
  const extraction = facts.extraction;
  if (extraction === undefined) return ' Extraction quality and field coverage were not read.';
  const rejected = Object.values(extraction.items.rejected).reduce((sum, count) => sum + count, 0);
  const held = Object.values(extraction.items.heldBack).reduce((sum, count) => sum + count, 0);
  return (
    ` Extraction sample: ${extraction.sampledJobs} job(s), ${extraction.omittedJobs} other job(s) ` +
    `outside the sample; ${extraction.settledUnits}/${extraction.scheduledUnits} scheduled unit(s) ` +
    `settled, ${extraction.notStartedJobs} job(s) not started and ${extraction.unreadableJobs} ` +
    `job(s) with unreadable progress. Unit outcomes: ${extraction.outcomes.accepted} accepted, ` +
    `${extraction.outcomes.partial} partial, ${extraction.outcomes.all_rejected} all rejected, ` +
    `${extraction.outcomes.empty} empty; ${rejected} rejected item(s), ${held} held back. ` +
    `${extraction.scheduledFieldOmissions} field omission(s); ` +
    `${extraction.omittedFieldDetails + extraction.omittedOmissionDetails} field/omission ` +
    'detail(s) not shown. Settled does not mean semantically correct or approved.'
  );
}

function completedThrough(facts: KnowledgeProcessingFacts): number | null {
  if (facts.latest_eligible_sequence === null || facts.boundary === null) return null;
  return facts.latest_eligible_sequence;
}

/** The facts as one field, with the claim they support and nothing they do not. */
export function knowledgeProcessingCoverage(
  facts: KnowledgeProcessingFacts
): KnowledgeProcessingCoverage {
  const claim = claimOf(facts);
  return {
    ...facts,
    claim,
    completed_through: claim === 'complete' ? completedThrough(facts) : null,
    statement: statementOf(claim, facts) + extractionStatement(facts),
  };
}
