import type { InterpretationManifest, PublishableRecord, ReconciliationPlan } from '@orcaops/core';
import type { ScheduledInterpretationSegment } from '@orcaops/storage';
import {
  type InterpretedRecord,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  type PublishInterpretation,
  publishInterpretedKnowledge,
  publishInterpretedKnowledgeAndSettleAttempt,
  readProcessingAttempt,
  readProcessingJob,
  readProcessingLease,
  type SettleInterpretationProgress,
  StaleInterpretedState,
  StaleKnowledgeState,
} from '@orcaops/storage/history/database';

import type { RetainedJobSource } from './job-source.js';

/**
 * Making a reconciliation plan's records real, through the store's own writers and in one
 * operation with nothing else.
 *
 * What this module decides is only how a plan's records become the writers' arguments: which
 * field is the acting attribution the writer takes as its own, which of a revision's passages is
 * the occurrence its table keys on, and what each record rests on. Everything about whether a
 * record may be written — its shape, its standing, its authority, the state it observed — belongs
 * to the writers, which is why nothing here re-judges any of it.
 *
 * The source occurrence is published first and in the same operation, because a revision may
 * cite no source this history does not hold.
 */

/** What the attempt's result records about one record the publication reached. */
export interface PublishedRecordEntry {
  kind: string;
  id: string;
  revision_id: string | null;
  /** True when the store already held this exact record, so this publication wrote nothing. */
  replay: boolean;
}

export type PublicationOutcome =
  | {
      kind: 'published';
      /**
       * The operation every record was written by, or null when the store already held all of
       * them and so ran no operation at all. An attempt may only name an operation that stands.
       */
      operationId: string | null;
      published: PublishedRecordEntry[];
      detail: string;
    }
  /**
   * What governs an identity the plan read moved between the manifest and the settlement. The
   * whole publication rolled back, so a newer selection was never overwritten.
   */
  | {
      kind: 'governing_state_moved';
      /** Which record met the moved state; null when a writer refused before naming one. */
      record: { kind: string; id: string } | null;
      target: { kind: string; entity_id: string } | null;
      current: { selection_ids: readonly string[]; correction_action_ids: readonly string[] };
      detail: string;
    }
  /** The store refused the plan on its own terms — a secret, a taken identity, a missing row. */
  | { kind: 'refused'; code: string; detail: string }
  /** The store could not complete the operation now; the same plan may be published later. */
  | { kind: 'unavailable'; code: string; detail: string };

export type CompletionPublicationOutcome =
  | Extract<PublicationOutcome, { kind: 'governing_state_moved' | 'refused' | 'unavailable' }>
  | { kind: 'ownership_lost'; detail: string }
  | {
      kind: 'settled';
      operationId: string | null;
      published: PublishedRecordEntry[];
      detail: string;
    };

/**
 * Background processing has no person at a terminal, and an allowlist is what a person has read
 * and judged dead. So nothing is allowed through, and a source carrying a refused credential
 * fails the publication rather than being published because nobody was there to object.
 */
const NOTHING_ALLOWED: readonly string[] = [];

export function interpretationSourceInput(
  manifest: InterpretationManifest,
  source: RetainedJobSource
) {
  return {
    sources: manifest.sources.map((entry) => ({
      source_id: entry.source_id,
      occurrence: entry.occurrence,
      source_author: source.sourceAuthor,
      interpreted_by: manifest.attributed_to,
      access_restriction: null,
    })),
    segments: manifest.segments.map(
      ({ ref: _ref, source_ref: _sourceRef, text: _text, ...segment }) =>
        segment satisfies ScheduledInterpretationSegment
    ),
    recordedBy: source.recordedBy,
    secretAllow: NOTHING_ALLOWED,
  };
}

/**
 * Codes that say the store could not commit now rather than that it will not take this plan, so a
 * later dispatch may publish the same plan. Every other refusal is about the plan itself.
 * `STALE_CONTEXT` is not among them: a moved governing state is a `StaleKnowledgeState`, which is
 * answered before this list is consulted.
 */
const TRANSIENT_CODES: readonly string[] = [
  'TRANSACTION_FAILED',
  'TRANSACTION_RETRY_EXHAUSTED',
  'CANCELLED',
];

const withoutField = (record: object, field: string): Record<string, unknown> => {
  const { [field]: _removed, ...rest } = record as Record<string, unknown>;
  return rest;
};

const restsOn = (record: PublishableRecord) =>
  record.rests_on.map((entry) => ({
    target: { kind: entry.target.kind, entity_id: entry.target.entity_id },
    state: entry.state,
  }));

/**
 * The passage a revision's released table keys its occurrence on. The contract requires a
 * decision and a claim revision to cite at least one, and the plan's records cite exactly the
 * passage the statement was read from.
 */
function occurrenceOf(passages: readonly { source_id: string; location: string }[]) {
  const passage = passages[0];
  if (passage === undefined)
    throw new TypeError('A planned revision cites the passage it was read from.');
  return { source_id: passage.source_id, location: passage.location };
}

function interpretedRecord(record: PublishableRecord): InterpretedRecord {
  const rests_on = restsOn(record);
  switch (record.kind) {
    case 'interpretation':
      return {
        kind: 'interpretation',
        record: withoutField(record.record, 'attributed_to'),
        rests_on,
      };
    case 'requirement_revision':
      return {
        kind: 'requirement_revision',
        identity: record.identity,
        revision: withoutField(record.record, 'attributed_to'),
        restsOn: rests_on,
      };
    case 'decision_revision':
      return {
        kind: 'decision_revision',
        revision: withoutField(record.record, 'attributed_to'),
        occurrence: occurrenceOf(record.record.passages),
        restsOn: rests_on,
      };
    case 'claim_revision':
      return {
        kind: 'claim_revision',
        revision: withoutField(record.record, 'attributed_to'),
        occurrence: occurrenceOf(record.record.passages),
        restsOn: rests_on,
      };
    case 'passage_restatement':
      return {
        kind: 'passage_restatement',
        restatement: withoutField(record.record, 'attributed_to'),
        restsOn: rests_on,
      };
    case 'relationship':
      return {
        kind: 'relationship',
        relationship: withoutField(record.record, 'attributed_to'),
        restsOn: rests_on,
      };
    case 'correction':
      return {
        kind: 'correction',
        action: withoutField(record.record, 'attributed_to'),
        restsOn: rests_on,
      };
    default: {
      // The selection is the store's to derive from the operation that writes the use, so the
      // discovery travels beside the use rather than inside it. A detector's use is always a
      // connection found later, which the plan builder is what guarantees.
      const { selection } = record.record;
      if (selection.kind !== 'connected_later')
        throw new TypeError("A detector's task use is a connection found after the task.");
      return {
        kind: 'task_use',
        use: withoutField(record.record, 'selection'),
        discovery: {
          discovered_at: selection.discovered_at,
          discovered_by: selection.discovered_by,
        },
        restsOn: rests_on,
      };
    }
  }
}

/**
 * Everything the publication writes, as the storage writers take it. Pure, so a test can read
 * what one plan would publish without a database.
 */
export function interpretationPublicationInput(input: {
  manifest: InterpretationManifest;
  plan: ReconciliationPlan;
  source: RetainedJobSource;
  operationId: string;
}): PublishInterpretation & {
  readonly sources: readonly unknown[];
  readonly segments: readonly unknown[];
  readonly processorContract: string;
} {
  const { manifest, plan, source, operationId } = input;
  if (plan.manifest_sha256 !== manifest.manifest_sha256)
    throw new TypeError('A reconciliation plan must name the same manifest being published.');
  return {
    operationId,
    ...interpretationSourceInput(manifest, source),
    processorContract: manifest.processor_contract,
    attributedTo: plan.attributed_to,
    scope: { kind: 'artifact', artifact_id: source.artifactId },
    records: plan.records.map(interpretedRecord),
  };
}

/**
 * Publish a plan. Every record commits with the source and with each other or none of them does,
 * so the attempt names one publishing operation and a reconsideration never meets half a plan.
 */
export async function publishReconciliationPlan(input: {
  handle: ProjectDatabase;
  manifest: InterpretationManifest;
  plan: ReconciliationPlan;
  source: RetainedJobSource;
  operationId: string;
}): Promise<PublicationOutcome> {
  const { handle, operationId } = input;
  try {
    const result = await publishInterpretedKnowledge(handle, interpretationPublicationInput(input));
    const published = result.value.published.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      revision_id: entry.revisionId,
      replay: entry.replay,
    }));
    const written = published.filter((entry) => !entry.replay).length;
    return {
      kind: 'published',
      // A publication that wrote nothing ran no operation, so there is no receipt for the attempt
      // to name and `settleProcessingAttempt` would refuse one.
      operationId: result.replayed ? null : operationId,
      published,
      detail: result.replayed
        ? `${published.length} record(s) were already retained, so nothing was written.`
        : `${written} record(s) published and ${published.length - written} replayed under ` +
          `operation ${operationId}.`,
    };
  } catch (error) {
    // A writer of one record checks an expected state of its own, so a moved state reaches here
    // either named by the publication or unnamed from inside a family writer.
    if (error instanceof StaleKnowledgeState) {
      const named = error instanceof StaleInterpretedState ? error : null;
      return {
        kind: 'governing_state_moved',
        record: named === null ? null : named.record,
        target:
          named === null ? null : { kind: named.target.kind, entity_id: named.target.entity_id },
        current: {
          selection_ids: error.current.selection_ids,
          correction_action_ids: error.current.correction_action_ids,
        },
        detail:
          (named === null
            ? 'What governs an identity this plan read moved since its manifest'
            : `What governs ${named.target.kind} ${named.target.entity_id} moved since this ` +
              `attempt's manifest, so ${named.record.kind} ${named.record.id} was not published`) +
          ', and neither was anything else in the plan. The plan is retained and reconsidered at ' +
          'a newer boundary.',
      };
    }
    if (error instanceof ProjectDatabaseError) {
      // The message never carries the refused content: the store's secret refusal says what to do
      // and names nothing it found.
      return {
        kind: TRANSIENT_CODES.includes(error.code) ? 'unavailable' : 'refused',
        code: error.code,
        detail: `The store refused this publication [${error.code}]: ${error.message}`,
      };
    }
    throw error;
  }
}

export async function publishReconciliationPlanAndSettleAttempt(
  input: {
    handle: ProjectDatabase;
    manifest: InterpretationManifest;
    plan: ReconciliationPlan;
    source: RetainedJobSource;
    processing: SettleInterpretationProgress;
  },
  options: ProjectOperationOptions = {}
): Promise<CompletionPublicationOutcome> {
  const { handle, processing } = input;
  if (processing.manifestSha256 !== input.manifest.manifest_sha256)
    throw new TypeError('A processing completion must name the manifest being published.');
  try {
    const result = await publishInterpretedKnowledgeAndSettleAttempt(
      handle,
      {
        ...interpretationPublicationInput({
          manifest: input.manifest,
          plan: input.plan,
          source: input.source,
          operationId: processing.attemptId,
        }),
        processing,
      },
      options
    );
    const published = result.value.publication.published.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      revision_id: entry.revisionId,
      replay: entry.replay,
    }));
    const written = published.filter((entry) => !entry.replay).length;
    const operationId = result.value.publishingOperationId;
    return {
      kind: 'settled',
      operationId,
      published,
      detail:
        operationId === null
          ? `${published.length} record(s) were already retained, so no authored operation was written.`
          : `${written} record(s) published and ${published.length - written} replayed under operation ${operationId}.`,
    };
  } catch (error) {
    if (error instanceof StaleKnowledgeState) {
      const named = error instanceof StaleInterpretedState ? error : null;
      return {
        kind: 'governing_state_moved',
        record: named === null ? null : named.record,
        target:
          named === null ? null : { kind: named.target.kind, entity_id: named.target.entity_id },
        current: {
          selection_ids: error.current.selection_ids,
          correction_action_ids: error.current.correction_action_ids,
        },
        detail:
          (named === null
            ? 'What governs an identity this plan read moved since its manifest'
            : `What governs ${named.target.kind} ${named.target.entity_id} moved since this ` +
              `attempt's manifest, so ${named.record.kind} ${named.record.id} was not published`) +
          ', and neither was unit progress. The plan is retained and reconsidered at a newer boundary.',
      };
    }
    if (error instanceof ProjectDatabaseError) {
      if (error.code === 'STALE_CONTEXT') {
        const lease = readProcessingLease(handle);
        const job = readProcessingJob(handle, processing.jobId);
        const attempt = readProcessingAttempt(handle, processing.attemptId);
        if (
          lease?.ownerGeneration !== processing.generation ||
          job?.state !== 'running' ||
          job.claimedGeneration !== processing.generation ||
          attempt?.ownerGeneration !== processing.generation ||
          attempt.outcome !== null
        )
          return {
            kind: 'ownership_lost',
            detail: `This worker no longer owns the attempt, so neither publication nor unit progress committed: ${error.message}`,
          };
        return {
          kind: 'unavailable',
          code: error.code,
          detail: `The completion changed while it was committing and can be retried: ${error.message}`,
        };
      }
      return {
        kind: TRANSIENT_CODES.includes(error.code) ? 'unavailable' : 'refused',
        code: error.code,
        detail: `The store refused this completion [${error.code}]: ${error.message}`,
      };
    }
    throw error;
  }
}
