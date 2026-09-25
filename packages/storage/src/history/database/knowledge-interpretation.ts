// Publishing everything one interpretation attempt derived, in one operation. The processing
// entry point also settles attempt progress inside that operation: its deferred receipt reference
// lets publication and ownership-fenced progress commit together. A refusal anywhere rolls both
// back.
//
// Nothing here may carry authority. The attribution is a detector's or the call is refused, and
// what a detector may write is what the family writers already hold it to: an extracted candidate,
// a suggested relationship and a proposing correction, which their contract schemas refuse
// anything else of, and a background use connected later, which `prepareProjectTaskUses` refuses
// anything else of because no schema pairs a use's role with who discovered it. None of it is a
// rule of this module's.
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { parseWorkContext, requireStoreScope } from './knowledge-authority.js';
import {
  type ClaimOccurrence,
  prepareProjectClaimRevision,
  settleProjectClaimRevision,
} from './knowledge-claims.js';
import { prepareProjectCorrection, settleProjectCorrection } from './knowledge-corrections.js';
import {
  type DecisionOccurrence,
  prepareProjectDecisionRevision,
  settleProjectDecisionRevision,
} from './knowledge-decisions.js';
import {
  prepareProjectKnowledgeInterpretation,
  retainedProjectKnowledgeInterpretation,
  settleProjectKnowledgeInterpretation,
} from './knowledge-interpretations.js';
import {
  AlreadyRetained,
  committedNothing,
  invalid,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  RecordIdSchema,
  replayOperation,
  requireRevisionContinues,
  retriedOperation,
  revisionLineage,
  taken,
} from './knowledge-record-input.js';
import {
  prepareProjectRelationship,
  readProjectRelationship,
  settleProjectRelationship,
} from './knowledge-relationships.js';
import {
  insertRequirementIdentity,
  insertRequirementRevision,
  prepareRequirementIdentity,
  prepareRequirementRevision,
  refuseTakenRequirementRevision,
  requireRequirementOrigin,
  requireRevisionReferences,
  retainedPromotedPassage,
} from './knowledge-requirements.js';
import {
  prepareProjectPassageRestatement,
  retainedProjectPassageRestatement,
  settleProjectPassageRestatement,
} from './knowledge-restatements.js';
import {
  prepareProjectKnowledgeSource,
  retainedCaptureOccurrence,
  retainedProjectKnowledgeSource,
  settleProjectKnowledgeSource,
} from './knowledge-sources.js';
import {
  requireExpectedState,
  resolveProjectKnowledge,
  StaleKnowledgeState,
} from './knowledge-standing.js';
import {
  prepareProjectTaskUses,
  prepareTaskUseDiscovery,
  retainedProjectTaskUse,
  settleProjectTaskUses,
} from './knowledge-task-uses.js';
import { runProcessingMaintenance } from './processing-maintenance.js';
import { readProcessingAttemptFromView, readProcessingJobFromView } from './processing-reader.js';
import {
  type ProcessingOutcome,
  settleProcessingAttemptInTransaction,
} from './processing-schedule.js';
import { type ProjectOperation } from './transactions.js';
import { runProjectOperation } from './transactions.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  type Attribution,
  type AuthorityScope,
  type ExpectedState,
  ExpectedStateSchema,
  type GoverningState,
  type Relationship,
} from '../../schema/knowledge-contract.js';
import {
  InterpretationAttemptScheduleBindingSchema,
  type InterpretationProcessingSchedule,
  InterpretationQualitySchema,
  type InterpretationUnitReceipt,
  InterpretationUnitReceiptSchema,
  type ScheduledInterpretationSegment,
  ScheduledInterpretationSegmentSchema,
} from '../../schema/knowledge-processing-contract.js';
import { type KnowledgeTarget } from '../../schema/knowledge-resolution.js';

/** One identity a record rests on, and the governing state it was read at. */
const RestsOnSchema = z.array(
  z.strictObject({
    target: z.strictObject({
      kind: z.enum(['requirement', 'decision', 'claim', 'relationship']),
      entity_id: RecordIdSchema,
    }),
    state: ExpectedStateSchema,
  })
);
export type InterpretedRestsOn = z.infer<typeof RestsOnSchema>;

/**
 * One record of a reconciliation plan, with the governing state it rests on. The record itself is
 * unknown here: the family writer's own contract schema is what parses it, so this module never
 * decides what a requirement, a relationship or a correction may say.
 */
export type InterpretedRecord =
  | {
      kind: 'interpretation';
      record?: unknown;
      interpretation?: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'requirement_revision';
      /** The identity this attempt mints, or null when the revision continues a lineage. */
      identity: unknown | null;
      record?: unknown;
      revision?: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'decision_revision';
      record?: unknown;
      revision?: unknown;
      occurrence: DecisionOccurrence;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'claim_revision';
      record?: unknown;
      revision?: unknown;
      occurrence: ClaimOccurrence;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'passage_restatement';
      record?: unknown;
      restatement?: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'relationship';
      record?: unknown;
      relationship?: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'correction';
      record?: unknown;
      action?: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    }
  | {
      kind: 'task_use';
      record?: unknown;
      use?: unknown;
      discovery: unknown;
      rests_on?: unknown;
      restsOn?: unknown;
    };

export interface PublishInterpretation {
  readonly operationId: string;
  /** The ordered source occurrences this unit read, published before anything cites them. */
  readonly sources?: readonly unknown[];
  /** Released single-source publication input. New processing uses `sources`. */
  readonly source?: unknown;
  /** The exact scheduled segments supplied to this unit. */
  readonly segments?: readonly unknown[];
  readonly processorContract?: string;
  /** The actor whose capture this source is, which a publishing session will own one day. */
  readonly recordedBy: Actor;
  /** The detector every published record is attributed to. An actor is refused. */
  readonly attributedTo: Attribution;
  /** The scope a governing state is read at: the scope the source itself sits in. */
  readonly scope: AuthorityScope;
  readonly records: readonly InterpretedRecord[];
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type PublishedInterpretedRecord = {
  kind: InterpretedRecord['kind'];
  id: string;
  /** The revision this record is, or for a task use the revision it uses; null for the rest. */
  revisionId: string | null;
  /** True when the store already held exactly this record, so nothing was written for it. */
  replay: boolean;
};

export type PublishedInterpretationSource = {
  requestedSourceId: string;
  sourceId: string;
  replay: boolean;
};

export type InterpretationPublication = {
  sources: PublishedInterpretationSource[];
  sourceId: string;
  sourceReplay: boolean;
  published: PublishedInterpretedRecord[];
};

/**
 * What governs one of the identities a record rests on moved since the manifest froze it. The
 * publication is rolled back whole and the attempt is retained, so a newer selection is never
 * overwritten and the job is reconsidered at a newer boundary.
 */
export class StaleInterpretedState extends StaleKnowledgeState {
  constructor(
    readonly record: { kind: string; id: string },
    readonly target: KnowledgeTarget,
    current: GoverningState
  ) {
    super(current);
  }
}

/** A record prepared outside the transaction: what it is, and how to answer and write it. */
interface PreparedRecord {
  readonly kind: InterpretedRecord['kind'];
  readonly id: string;
  readonly revisionId: string | null;
  readonly restsOn: InterpretedRestsOn;
  /** The authored bytes this record contributes to the operation receipt. */
  readonly sha256: string;
  readonly candidateTarget?: {
    kind: 'requirement' | 'decision' | 'claim';
    id: string;
    revisionId: string;
  };
  /** Whether the store already holds exactly this record, so nothing is written for it. */
  retained(view: ProjectReadView): boolean;
  /** Writes the record, answering whether a row was actually added. */
  settle(transaction: ProjectSettlement, operation: Readonly<ProjectOperation>): boolean;
}

interface RecordPublicationContext {
  readonly segments: readonly ScheduledInterpretationSegment[];
  readonly canonicalSourceId: (requestedSourceId: string) => string;
}

/**
 * What a repeat of one record is answered with. A record the store already holds byte for byte is
 * this attempt's own derivation reaching the same identity again, so it is answered by writing
 * nothing; anything else under the same identity is a different record wearing a repeat's
 * clothes, and is refused by the name of the record that identity already has.
 */
function retainedHash(
  view: ProjectReadView,
  table: string,
  column: string,
  id: string
): string | null {
  const row = view.get<{ record_sha256: string }>(
    `SELECT record_sha256 FROM ${table} WHERE ${column}=?`,
    id
  );
  return row ? row.record_sha256 : null;
}

function answeredRepeat(retained: string | null, authored: string, what: string, id: string) {
  if (retained === null) return false;
  if (retained === authored) return true;
  return taken(`${what} ${id} is already retained as a different record`);
}

/**
 * Whether a retained relationship is the one this plan derived. Its table keeps no payload, so
 * the columns are compared rather than bytes — every one of them except the explanation, which is
 * derived prose naming the passage that suggested the edge. A relationship's id is derived from
 * the edge, the scope and the source, so two of them under one id are one edge suggested from two
 * passages of one source; there is no second edge to add, and the row keeps the wording of the
 * passage that first noticed it.
 */
function sameRelationship(
  row: NonNullable<ReturnType<typeof readProjectRelationship>>,
  authored: Relationship
): boolean {
  const scopeValue = authored.scope.kind === 'artifact' ? authored.scope.artifact_id : null;
  const [attributedKind, attributedIdentity] =
    authored.attributed_to.kind === 'detector'
      ? ['detector', authored.attributed_to.detector]
      : ['author', authored.attributed_to.actor.identity];
  return (
    row.relation === authored.relation &&
    row.from.kind === authored.from.kind &&
    row.from.entityId === authored.from.entity_id &&
    row.from.revisionId === authored.from.revision_id &&
    row.to.kind === authored.to.kind &&
    row.to.entityId === authored.to.entity_id &&
    row.to.revisionId === authored.to.revision_id &&
    row.scope.kind === authored.scope.kind &&
    row.scope.value === scopeValue &&
    row.standing === authored.standing &&
    row.attributedTo.kind === attributedKind &&
    row.attributedTo.identity === attributedIdentity &&
    JSON.stringify(row.sourceIds) === JSON.stringify(authored.source_ids)
  );
}

function prepareRecord(
  record: InterpretedRecord,
  input: PublishInterpretation,
  projectId: string,
  context: RecordPublicationContext
): PreparedRecord {
  const restsOn = parsed(
    RestsOnSchema,
    record.rests_on ?? record.restsOn,
    'The governing state a record rests on'
  );
  const common = { restsOn };
  const { attributedTo, secretAllow, operationId } = input;

  if (record.kind === 'interpretation') {
    if (restsOn.length !== 0) invalid('An interpretation carries no governing-state expectation');
    if (input.processorContract === undefined)
      invalid('A knowledge interpretation requires its processor contract');
    const prepared = prepareProjectKnowledgeInterpretation({
      interpretation: record.record ?? record.interpretation,
      processorContract: input.processorContract,
      attributedTo,
      secretAllow,
    });
    const authored = prepared.interpretation;
    return {
      ...common,
      kind: record.kind,
      id: authored.interpretation_id,
      revisionId: authored.canonical_outcome.target?.revision_id ?? null,
      sha256: prepared.record.sha256,
      ...(authored.canonical_outcome.kind === 'candidate_revision'
        ? {
            candidateTarget: {
              kind: authored.canonical_outcome.target.kind,
              id: authored.canonical_outcome.target.entity_id,
              revisionId: authored.canonical_outcome.target.revision_id,
            },
          }
        : {}),
      retained: (view) => retainedProjectKnowledgeInterpretation(view, prepared) !== null,
      settle: (transaction) => {
        settleProjectKnowledgeInterpretation(transaction, operationId, prepared, context);
        return true;
      },
    };
  }

  if (record.kind === 'requirement_revision') {
    const revision = prepareRequirementRevision({
      operationId,
      revision: record.record ?? record.revision,
      attributedTo,
      secretAllow,
    });
    const identity =
      record.identity === null ? null : prepareRequirementIdentity(record.identity, secretAllow);
    if (identity !== null) {
      if (identity.identity.requirement_id !== revision.revision.requirement_id)
        invalid('The first revision belongs to the identity created with it');
      if (revision.revision.previous_revision_id !== null)
        invalid('A requirement is created with its first revision, which continues nothing');
    }
    const { revision: authored, record: bytes } = revision;
    if (
      input.processorContract !== undefined &&
      (authored.interpretation === null || authored.interpretation === undefined)
    )
      invalid('A detector candidate requirement revision requires its interpretation provenance');
    return {
      ...common,
      kind: record.kind,
      id: authored.requirement_id,
      revisionId: authored.revision_id,
      sha256: bytes.sha256,
      retained: (view) => {
        const held = answeredRepeat(
          retainedHash(view, 'requirement_revisions', 'revision_id', authored.revision_id),
          bytes.sha256,
          'Requirement revision',
          authored.revision_id
        );
        if (held) return true;
        // One promoted passage is one identity: a passage that already has a requirement is
        // never promoted again, whatever this attempt derived for it.
        if (identity !== null) {
          const promoted = retainedPromotedPassage(view, identity.identity.origin);
          if (promoted && promoted.record_sha256 !== identity.record.sha256)
            taken(
              `That passage is already requirement ${promoted.requirement_id}; publish a revision of it that restates the passage instead of promoting the passage again`
            );
        }
        return false;
      },
      settle: (transaction) => {
        refuseTakenRequirementRevision(transaction, authored.revision_id);
        requireRevisionReferences(transaction, authored);
        if (identity === null) {
          if (
            !transaction.get(
              'SELECT requirement_id FROM requirements WHERE requirement_id=?',
              authored.requirement_id
            )
          )
            invalid('The revision continues a requirement this publication does not create');
          requireRevisionContinues(
            revisionLineage(
              transaction,
              'requirement_revisions',
              'requirement_id',
              authored.requirement_id
            ),
            authored
          );
          insertRequirementRevision(transaction, revision);
          return true;
        }
        if (
          transaction.get(
            'SELECT requirement_id FROM requirements WHERE requirement_id=?',
            authored.requirement_id
          )
        )
          taken('That requirement identity already exists; publish a revision of it instead');
        requireRequirementOrigin(transaction, identity.identity);
        insertRequirementRevision(transaction, revision);
        insertRequirementIdentity(transaction, identity, authored.revision_id, operationId);
        return true;
      },
    };
  }

  if (record.kind === 'decision_revision') {
    const prepared = prepareProjectDecisionRevision({
      revision: record.record ?? record.revision,
      attributedTo,
      occurrence: record.occurrence,
      secretAllow,
    });
    const { revision: authored, record: bytes } = prepared;
    if (
      input.processorContract !== undefined &&
      (authored.interpretation === null || authored.interpretation === undefined)
    )
      invalid('A detector candidate decision revision requires its interpretation provenance');
    return {
      ...common,
      kind: record.kind,
      id: authored.decision_id,
      revisionId: authored.revision_id,
      sha256: bytes.sha256,
      retained: (view) =>
        answeredRepeat(
          retainedHash(view, 'decision_revisions', 'revision_id', authored.revision_id),
          bytes.sha256,
          'Decision revision',
          authored.revision_id
        ),
      settle: (transaction) => {
        settleProjectDecisionRevision(transaction, operationId, prepared);
        return true;
      },
    };
  }

  if (record.kind === 'claim_revision') {
    const prepared = prepareProjectClaimRevision({
      revision: record.record ?? record.revision,
      attributedTo,
      occurrence: record.occurrence,
      secretAllow,
    });
    const { revision: authored, record: bytes } = prepared;
    if (
      input.processorContract !== undefined &&
      (authored.interpretation === null || authored.interpretation === undefined)
    )
      invalid('A detector candidate claim revision requires its interpretation provenance');
    return {
      ...common,
      kind: record.kind,
      id: authored.claim_id,
      revisionId: authored.revision_id,
      sha256: bytes.sha256,
      retained: (view) =>
        answeredRepeat(
          retainedHash(view, 'claim_revisions', 'revision_id', authored.revision_id),
          bytes.sha256,
          'Claim revision',
          authored.revision_id
        ),
      settle: (transaction) => {
        settleProjectClaimRevision(transaction, operationId, prepared);
        return true;
      },
    };
  }

  if (record.kind === 'passage_restatement') {
    const prepared = prepareProjectPassageRestatement({
      restatement: record.record ?? record.restatement,
      attributedTo,
      secretAllow,
    });
    return {
      ...common,
      kind: record.kind,
      id: prepared.restatement.restatement_id,
      revisionId: null,
      sha256: prepared.record.sha256,
      retained: (view) => retainedProjectPassageRestatement(view, prepared) !== null,
      settle: (transaction) =>
        settleProjectPassageRestatement(transaction, operationId, prepared).published,
    };
  }

  if (record.kind === 'relationship') {
    const prepared = prepareProjectRelationship(
      {
        relationship: record.record ?? record.relationship,
        attributedTo,
        secretAllow,
      },
      projectId
    );
    const authored = prepared.relationship;
    return {
      ...common,
      kind: record.kind,
      id: authored.relationship_id,
      revisionId: null,
      sha256: prepared.record.sha256,
      retained: (view) => {
        const row = readProjectRelationship(view, authored.relationship_id);
        if (row === null) return false;
        if (sameRelationship(row, authored)) return true;
        return taken(
          `Relationship ${authored.relationship_id} is already retained as a different record`
        );
      },
      settle: (transaction, operation) => {
        settleProjectRelationship(transaction, operation, prepared, projectId);
        return true;
      },
    };
  }

  if (record.kind === 'correction') {
    const prepared = prepareProjectCorrection(
      { action: record.record ?? record.action, attributedTo, secretAllow },
      projectId
    );
    const authored = prepared.action;
    return {
      ...common,
      kind: record.kind,
      id: authored.action_id,
      revisionId: null,
      sha256: prepared.record.sha256,
      retained: (view) =>
        answeredRepeat(
          retainedHash(view, 'correction_actions', 'action_id', authored.action_id),
          prepared.record.sha256,
          'Correction',
          authored.action_id
        ),
      settle: (transaction, operation) => {
        settleProjectCorrection(transaction, operation, prepared, projectId);
        return true;
      },
    };
  }

  const discovery = prepareTaskUseDiscovery(record.discovery);
  const prepared = prepareProjectTaskUses([record.record ?? record.use], secretAllow, discovery);
  const use = prepared.uses[0]!;
  return {
    ...common,
    kind: 'task_use',
    // A use has no id of its own: what makes it the same use is the plan event, the revision and
    // the role, which is what the table is keyed on and what a repeat is answered by.
    id: `${use.plan_event_id}:${use.target.revision_id}:${use.role}`,
    revisionId: use.target.revision_id,
    sha256: prepared.authoredSha256[0]!,
    retained: (view) => retainedProjectTaskUse(view, use) !== null,
    settle: (transaction, operation) =>
      settleProjectTaskUses(transaction, operation, prepared, discovery).uses[0]!.published,
  };
}

/**
 * Whether what governs each identity a record rests on is still what the manifest froze. The
 * resolver answer is memoized for the whole settlement, which is sound because nothing this
 * operation writes enters a governing state: every record it publishes is an extracted candidate,
 * a suggestion or a proposal, and the resolver counts none of those.
 */
function expectedStateCheck(
  view: ProjectReadView,
  projectId: string,
  scope: AuthorityScope
): (record: PreparedRecord) => void {
  const work = parseWorkContext(undefined);
  const governing = new Map<string, GoverningState>();
  return (record) => {
    for (const rests of record.restsOn) {
      const key = `${rests.target.kind}:${rests.target.entity_id}`;
      let current = governing.get(key);
      if (current === undefined) {
        current = resolveProjectKnowledge(
          view,
          rests.target,
          projectId,
          scope,
          work
        ).governing_state;
        governing.set(key, current);
      }
      try {
        requireExpectedState(rests.state as ExpectedState, current);
      } catch (error) {
        if (error instanceof StaleKnowledgeState)
          throw new StaleInterpretedState(
            { kind: record.kind, id: record.id },
            rests.target,
            error.current
          );
        throw error;
      }
    }
  };
}

/** The record with every requested source id replaced by its retained canonical id. */
function citing<T>(value: T, aliases: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return (aliases.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => citing(item, aliases)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        citing(item, aliases),
      ])
    ) as T;
  return value;
}

interface PreparedInterpretationSource {
  source: ReturnType<typeof prepareProjectKnowledgeSource> | null;
  requested: {
    source_id: string;
    occurrence: ReturnType<typeof prepareProjectKnowledgeSource>['source']['occurrence'];
  };
  occurrence: ReturnType<typeof prepareProjectKnowledgeSource>['source']['occurrence'];
  sourceId: string;
  accessRestriction: string | null;
  authoredSha256: string;
  payload: string | null;
}

export interface ResolvedInterpretationSource {
  requestedSourceId: string;
  sourceId: string;
  occurrence: PreparedInterpretationSource['occurrence'];
}

function prepareInterpretationSources(
  handle: ProjectDatabase,
  input: Pick<PublishInterpretation, 'sources' | 'recordedBy' | 'secretAllow'>,
  operationId: string | null
): PreparedInterpretationSource[] {
  const supplied = input.sources ?? [];
  if (supplied.length === 0) invalid('An interpretation unit supplies at least one source');
  const occurrences = new Set<string>();
  const requestedIds = new Set<string>();
  return supplied.map((value): PreparedInterpretationSource => {
    const authored = prepareProjectKnowledgeSource({
      source: value,
      recordedBy: input.recordedBy,
      secretAllow: input.secretAllow,
    });
    const occurrenceKey = canonicalJson(authored.source.occurrence);
    if (occurrences.has(occurrenceKey) || requestedIds.has(authored.source.source_id))
      invalid('An interpretation unit supplies each source occurrence and requested ID once');
    occurrences.add(occurrenceKey);
    requestedIds.add(authored.source.source_id);
    const existing = handle.read((view) =>
      retainedCaptureOccurrence(view, authored.source.occurrence)
    ).value;
    const source = existing === null ? authored : null;
    const sourceId = existing === null ? authored.source.source_id : existing.sourceId;
    return {
      source,
      requested: {
        source_id: authored.source.source_id,
        occurrence: authored.source.occurrence,
      },
      occurrence: authored.source.occurrence,
      sourceId,
      accessRestriction: authored.source.access_restriction,
      authoredSha256: authored.record.sha256,
      payload:
        source !== null || (operationId !== null && existing?.operationId === operationId)
          ? authored.record.sha256
          : null,
    };
  });
}

export function resolveProjectInterpretationSources(
  handle: ProjectDatabase,
  input: {
    sources: readonly unknown[];
    recordedBy: Actor;
    secretAllow: readonly string[];
  }
): ResolvedInterpretationSource[] {
  return prepareInterpretationSources(handle, input, null).map((source) => ({
    requestedSourceId: source.requested.source_id,
    sourceId: source.sourceId,
    occurrence: source.occurrence,
  }));
}

interface PreparedInterpretation {
  sources: PreparedInterpretationSource[];
  segments: ScheduledInterpretationSegment[];
  records: PreparedRecord[];
  operation: ProjectOperation;
  alreadyRetained(view: ProjectReadView): InterpretationPublication | null;
  settle(
    transaction: ProjectSettlement,
    settling: Readonly<ProjectOperation>,
    checkAllExpectedState?: boolean
  ): InterpretationPublication;
}

function prepareInterpretation(
  handle: ProjectDatabase,
  input: PublishInterpretation,
  operationKind = 'knowledge.interpretation.publish',
  operationTarget: DatabaseJson | null = null,
  operationPayload: DatabaseJson | null = null
): PreparedInterpretation {
  const operationId = operationIdentity(input.operationId);
  if (input.attributedTo.kind !== 'detector')
    invalid('Background interpretation publishes what a detector proposed, never an actor');
  const projectId = handle.authority.projectId;
  const scope = requireStoreScope(projectId, input.scope);
  const suppliedSources = input.sources ?? (input.source === undefined ? [] : [input.source]);
  const sources = prepareInterpretationSources(
    handle,
    { sources: suppliedSources, recordedBy: input.recordedBy, secretAllow: input.secretAllow },
    operationId
  );
  const aliases = new Map(sources.map((source) => [source.requested.source_id, source.sourceId]));
  const segments = (input.segments ?? []).map((segment) =>
    parsed(ScheduledInterpretationSegmentSchema, segment, 'A scheduled interpretation segment')
  );
  if (new Set(segments.map((segment) => segment.segment_id)).size !== segments.length)
    invalid('An interpretation unit supplies each scheduled segment once');
  if (segments.some((segment) => !aliases.has(segment.source_id)))
    invalid('Every scheduled segment belongs to a source supplied by this unit');
  const context: RecordPublicationContext = {
    segments,
    canonicalSourceId: (requestedSourceId) => {
      const canonical = aliases.get(requestedSourceId);
      if (canonical === undefined) invalid('A scheduled segment names a source outside this unit');
      return canonical;
    },
  };
  const records = input.records
    .map((record) => citing(record, aliases))
    .sort(
      (left, right) =>
        Number(right.kind === 'interpretation') - Number(left.kind === 'interpretation')
    )
    .map((record) => prepareRecord(record, input, projectId, context));
  const operation = {
    operationId,
    kind: operationKind,
    target:
      operationTarget ??
      ({
        sources: sources.map((source) => ({
          requestedSourceId: source.requested.source_id,
          sourceId: source.sourceId,
        })),
        records: records.map((record) => ({ kind: record.kind, id: record.id })),
      } satisfies DatabaseJson),
    payload:
      operationPayload ??
      ({
        sources: sources.map((source) => source.payload),
        records: records.map((record) => record.sha256),
      } satisfies DatabaseJson),
    expectedState: records.map((record) => record.restsOn),
    intentChange: false,
  };
  const alreadyRetained = (view: ProjectReadView): InterpretationPublication | null => {
    try {
      if (
        sources.some(
          (source) =>
            source.source !== null && retainedProjectKnowledgeSource(view, source.source) === null
        )
      )
        return null;
      if (!records.every((record) => record.retained(view))) return null;
    } catch {
      return null;
    }
    const publication: InterpretationPublication = {
      sources: sources.map((source) => ({
        requestedSourceId: source.requested.source_id,
        sourceId: source.sourceId,
        replay: true,
      })),
      sourceId: sources[0]!.sourceId,
      sourceReplay: true,
      published: records.map((record) => ({
        kind: record.kind,
        id: record.id,
        revisionId: record.revisionId,
        replay: true,
      })),
    };
    return publication;
  };
  const settle = (
    transaction: ProjectSettlement,
    settling: Readonly<ProjectOperation>,
    checkAllExpectedState = false
  ): InterpretationPublication => {
    const check = expectedStateCheck(transaction, projectId, scope);
    if (checkAllExpectedState) records.forEach(check);
    const settledSources = sources.map((source) =>
      source.source === null
        ? { sourceId: source.sourceId, published: false }
        : settleProjectKnowledgeSource(transaction, operationId, source.source)
    );
    const published = records.map((record) => {
      if (record.retained(transaction))
        return { kind: record.kind, id: record.id, revisionId: record.revisionId, replay: true };
      check(record);
      const wrote = record.settle(transaction, settling);
      return {
        kind: record.kind,
        id: record.id,
        revisionId: record.revisionId,
        replay: !wrote,
      };
    });
    for (const record of records) {
      const target = record.candidateTarget;
      if (target === undefined) continue;
      const table =
        target.kind === 'requirement'
          ? ['requirement_revisions', 'requirement_id']
          : target.kind === 'decision'
            ? ['decision_revisions', 'decision_id']
            : ['claim_revisions', 'claim_id'];
      if (
        !transaction.get(
          `SELECT revision_id FROM ${table[0]} WHERE ${table[1]}=? AND revision_id=?`,
          target.id,
          target.revisionId
        )
      )
        invalid('A candidate interpretation outcome requires its exact retained revision');
    }
    const publication: InterpretationPublication = {
      sources: settledSources.map((source, index) => ({
        requestedSourceId: sources[index]!.requested.source_id,
        sourceId: source.sourceId,
        replay: !source.published,
      })),
      sourceId: settledSources[0]!.sourceId,
      sourceReplay: !settledSources[0]!.published,
      published,
    };
    return publication;
  };
  return {
    sources,
    segments,
    records,
    operation,
    alreadyRetained,
    settle,
  };
}

/**
 * Publish a whole reconciliation plan. One operation: every record commits together or none does,
 * which is what lets the attempt name a single publishing operation and what stops a half-written
 * plan a reconsideration would have to untangle.
 */
export async function publishInterpretedKnowledge(
  handle: ProjectDatabase,
  input: PublishInterpretation,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  if (input.attributedTo.kind !== 'detector')
    invalid('Background interpretation publishes what a detector proposed, never an actor');
  if (input.sources === undefined && input.records.length === 0) {
    const sourceId = (input.source as { source_id?: unknown } | undefined)?.source_id;
    if (typeof sourceId !== 'string') invalid('An interpretation supplies its source occurrence');
    return committedNothing(handle, {
      sources: [],
      sourceId,
      sourceReplay: true,
      published: [],
    });
  }
  const prepared = prepareInterpretation(handle, input);
  if (retriedOperation(handle, operationId))
    return replayOperation(handle, prepared.operation, options);

  // A plan whose every record the store already holds writes nothing at all, so it runs no
  // operation: no receipt, no write sequence and neither counter.
  const retained = handle.read(prepared.alreadyRetained).value;
  if (retained !== null) return committedNothing(handle, retained);

  return publishUnlessRetained(
    handle,
    prepared.operation,
    (transaction: ProjectSettlement, settling): InterpretationPublication => {
      const result = prepared.settle(transaction, settling);
      // Another process committed the whole plan between the read above and this settlement.
      // Writing nothing is the only honest repeat, so the transaction rolls back.
      if (
        result.sources.every((source) => source.replay) &&
        result.published.every((entry) => entry.replay)
      )
        throw new AlreadyRetained(result);
      return result;
    },
    options
  );
}

export interface InterpretationUnitProgress {
  scheduleId: string;
  unitId: string;
  index: number;
  count: number;
}

export type InterpretationProgressOutcome =
  | { kind: 'completed'; result: DatabaseJson; detail: DatabaseJson }
  | { kind: 'unit_completed'; retryAt: string; detail: DatabaseJson };

export interface SettleInterpretationProgress {
  generation: number;
  jobId: string;
  attemptId: string;
  finishedAt: string;
  usage: DatabaseJson;
  manifestSha256: string;
  unit: InterpretationUnitProgress;
  quality: unknown;
  outcome: InterpretationProgressOutcome;
}

export interface PublishProcessingInterpretation extends PublishInterpretation {
  readonly sources: readonly unknown[];
  readonly segments: readonly unknown[];
  readonly processorContract: string;
  processing: SettleInterpretationProgress;
}

export interface InterpretationCompletion {
  publication: InterpretationPublication;
  receipt: InterpretationUnitReceipt;
  publishingOperationId: string | null;
  completionRequestSha256: string;
}

export interface InterpretationProgress {
  schedule: InterpretationProcessingSchedule;
  receipts: InterpretationUnitReceipt[];
}

const COMPLETION_REQUEST_SHA256 = 'completion_request_sha256';
const COMPLETION_PUBLICATION = 'completion_publication';
const INTERPRETATION_QUALITY = 'interpretation_quality';
const INTERPRETATION_UNIT_RECEIPT = 'interpretation_unit_receipt';

const PublishedInterpretationRecordKindSchema = z.enum([
  'interpretation',
  'requirement_revision',
  'decision_revision',
  'claim_revision',
  'passage_restatement',
  'relationship',
  'correction',
  'task_use',
]);

const InterpretationPublicationSchema = z.strictObject({
  sources: z.array(
    z.strictObject({
      requestedSourceId: z.string(),
      sourceId: z.string(),
      replay: z.boolean(),
    })
  ),
  sourceId: z.string(),
  sourceReplay: z.boolean(),
  published: z.array(
    z.strictObject({
      kind: PublishedInterpretationRecordKindSchema,
      id: z.string(),
      revisionId: z.string().nullable(),
      replay: z.boolean(),
    })
  ),
});

const RetainedPublishedRecordsSchema = z.array(
  z.strictObject({
    kind: PublishedInterpretationRecordKindSchema,
    id: z.string(),
    revision_id: z.string().nullable(),
    replay: z.boolean(),
  })
);

function recordObject(value: DatabaseJson): Record<string, DatabaseJson> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, DatabaseJson>)
    : null;
}

function retainedBinding(
  view: ProjectReadView,
  attemptId: string,
  configuration: DatabaseJson
): z.infer<typeof InterpretationAttemptScheduleBindingSchema> {
  const raw = recordObject(configuration)?.schedule_binding;
  const parsedBinding = InterpretationAttemptScheduleBindingSchema.safeParse(raw);
  if (!parsedBinding.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The processing attempt has no valid immutable interpretation schedule binding'
    );
  const binding = parsedBinding.data;
  if (binding.schedule !== null && binding.schedule_attempt_id !== attemptId)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A full interpretation schedule must name the attempt that retained it'
    );
  return binding;
}

function retainedSchedule(
  view: ProjectReadView,
  attemptId: string,
  binding: z.infer<typeof InterpretationAttemptScheduleBindingSchema>
) {
  if (binding.schedule !== null) return binding.schedule;
  const first = readProcessingAttemptFromView(view, binding.schedule_attempt_id);
  if (first === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The attempt retaining the immutable interpretation schedule is missing'
    );
  const firstBinding = retainedBinding(view, first.attemptId, first.configuration);
  if (
    firstBinding.schedule === null ||
    firstBinding.schedule_attempt_id !== first.attemptId ||
    binding.unit === null ||
    firstBinding.schedule.schedule_id !== binding.unit.schedule_id
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The referenced interpretation schedule is absent or conflicts with this attempt'
    );
  if (first.attemptNumber >= (readProcessingAttemptFromView(view, attemptId)?.attemptNumber ?? 0))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An interpretation attempt must reference an earlier schedule-bearing attempt'
    );
  return firstBinding.schedule;
}

function completionDetail(
  detail: DatabaseJson,
  publication: InterpretationPublication,
  receipt: InterpretationUnitReceipt
): DatabaseJson {
  const supplied = recordObject(detail);
  if (
    supplied !== null &&
    [
      COMPLETION_REQUEST_SHA256,
      COMPLETION_PUBLICATION,
      INTERPRETATION_QUALITY,
      INTERPRETATION_UNIT_RECEIPT,
      'published',
      'publishing_operation_id',
    ].some((key) => key in supplied)
  )
    invalid('Processing detail may not supply storage completion receipt fields');
  return {
    ...(supplied ?? { worker_detail: detail }),
    [COMPLETION_REQUEST_SHA256]: receipt.completion_request_sha256,
    [COMPLETION_PUBLICATION]: publication,
    [INTERPRETATION_QUALITY]: receipt.quality,
    [INTERPRETATION_UNIT_RECEIPT]: receipt,
    published: publication.published.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      revision_id: entry.revisionId,
      replay: entry.replay,
    })),
    publishing_operation_id: receipt.publishing_operation_id,
  };
}

function processingOutcome(
  progress: SettleInterpretationProgress,
  publication: InterpretationPublication,
  receipt: InterpretationUnitReceipt
): ProcessingOutcome {
  const detail = completionDetail(progress.outcome.detail, publication, receipt);
  return progress.outcome.kind === 'completed'
    ? {
        kind: 'succeeded',
        publishingOperationId: receipt.publishing_operation_id,
        result: progress.outcome.result,
        detail,
      }
    : {
        kind: 'retryable_failure',
        waitReason: 'source_unit_pending',
        retryAt: progress.outcome.retryAt,
        detail,
      };
}

function completionRequestSha256(
  prepared: PreparedInterpretation,
  progress: SettleInterpretationProgress
): string {
  const normalized = {
    sources: prepared.sources.map((source) => ({
      requested: source.requested,
      canonical_source_id: source.sourceId,
      record_sha256: source.authoredSha256,
    })),
    segments: prepared.segments,
    records: prepared.records.map((record) => ({
      kind: record.kind,
      id: record.id,
      revision_id: record.revisionId,
      record_sha256: record.sha256,
      rests_on: record.restsOn,
    })),
    processing: {
      job_id: progress.jobId,
      attempt_id: progress.attemptId,
      manifest_sha256: progress.manifestSha256,
      unit: progress.unit,
      quality: progress.quality,
      finished_at: progress.finishedAt,
      usage: progress.usage,
      outcome: progress.outcome,
    },
  };
  return createHash('sha256').update(serializeDatabaseValue(normalized)).digest('hex');
}

function requireUnrestrictedCompletionSources(
  view: ProjectReadView,
  prepared: PreparedInterpretation
): void {
  for (const source of prepared.sources) {
    if (source.accessRestriction !== null)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'An interpretation completion cannot publish a restricted source'
      );
    if (source.occurrence.kind !== 'capture_field')
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'An interpretation completion source is not a scheduled capture field'
      );
    const retainedById = view.get<{
      eventId: string | null;
      fieldPath: string | null;
      position: number | null;
    }>(
      `SELECT event_id AS eventId, field_path AS fieldPath, position
       FROM knowledge_sources WHERE source_id=?`,
      source.sourceId
    );
    if (
      retainedById !== null &&
      (retainedById.eventId !== source.occurrence.event_id ||
        retainedById.fieldPath !== source.occurrence.field_path ||
        retainedById.position !== source.occurrence.position)
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'An interpretation completion source identity now belongs to another occurrence'
      );
    const retainedOccurrence = view.get<{
      sourceId: string;
      accessRestriction: string | null;
    }>(
      `SELECT source_id AS sourceId, access_restriction AS accessRestriction
       FROM knowledge_sources
       WHERE source_kind='capture_field' AND event_id=? AND field_path=? AND position=?`,
      source.occurrence.event_id,
      source.occurrence.field_path,
      source.occurrence.position
    );
    if (retainedOccurrence === null) continue;
    if (retainedOccurrence.sourceId !== source.sourceId)
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'An interpretation source occurrence acquired a different canonical identity'
      );
    if (retainedOccurrence.accessRestriction !== null)
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'An interpretation source occurrence became restricted before completion'
      );
  }
}

function completionAttempt(
  view: ProjectReadView,
  input: PublishProcessingInterpretation,
  prepared: PreparedInterpretation
) {
  const attempt = readProcessingAttemptFromView(view, input.processing.attemptId);
  if (attempt === null)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The processing attempt is missing; preserve history for explicit repair'
    );
  if (attempt.jobId !== input.processing.jobId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The processing attempt belongs to a different job'
    );
  const job = readProcessingJobFromView(view, input.processing.jobId);
  if (job === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The processing job is missing; preserve history for explicit repair'
    );
  if (job.source.kind !== 'capture_event')
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The interpretation unit does not belong to a capture-event processing job'
    );
  const configuration =
    attempt.configuration !== null &&
    typeof attempt.configuration === 'object' &&
    !Array.isArray(attempt.configuration)
      ? attempt.configuration
      : null;
  const processorContract = configuration?.processor_contract ?? null;
  if (
    processorContract !== job.processorContract ||
    input.processorContract !== job.processorContract
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The processing attempt contract does not match its job'
    );
  if (configuration?.manifest_sha256 !== input.processing.manifestSha256)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The completion manifest differs from the immutable processing attempt'
    );
  const binding = retainedBinding(view, attempt.attemptId, attempt.configuration);
  const schedule = retainedSchedule(view, attempt.attemptId, binding);
  const expected = input.processing.unit;
  if (
    binding.unit === null ||
    binding.unit.schedule_id !== expected.scheduleId ||
    binding.unit.unit_id !== expected.unitId ||
    binding.unit.index !== expected.index ||
    binding.unit.count !== expected.count
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The completion unit differs from the immutable processing attempt'
    );
  if (schedule.source_event_id !== job.source.event_id)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The immutable interpretation schedule belongs to a different capture event'
    );
  const scheduledUnit = schedule.units[expected.index];
  if (
    scheduledUnit === undefined ||
    scheduledUnit.unit_id !== expected.unitId ||
    canonicalJson(scheduledUnit.segments) !== canonicalJson(prepared.segments)
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The completion segments differ from the exact immutable scheduled unit'
    );
  const requestedSourceIds = [
    ...new Set(scheduledUnit.segments.map((segment) => segment.source_id)),
  ];
  if (
    canonicalJson(prepared.sources.map((source) => source.requested.source_id)) !==
    canonicalJson(requestedSourceIds)
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The completion sources differ from the ordered sources of the scheduled unit'
    );
  for (const source of prepared.sources) {
    const occurrence = source.occurrence;
    if (
      occurrence.kind !== 'capture_field' ||
      occurrence.event_id !== job.source.event_id ||
      view.get<{ artifactId: string }>(
        'SELECT artifact_id AS artifactId FROM artifact_events WHERE event_id=?',
        occurrence.event_id
      )?.artifactId !== occurrence.artifact_id
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'An interpreted capture source does not belong to the processing job'
      );
  }
  if (attempt.outcome === null) {
    requireUnrestrictedCompletionSources(view, prepared);
    const progress = readInterpretationProgressFromView(view, input.processing.jobId);
    if (progress === null)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The processing job has no retained interpretation schedule'
      );
    if (progress.receipts.some((receipt) => receipt.unit_id === expected.unitId))
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The scheduled interpretation unit already has a completion receipt'
      );
    if (progress.receipts.length !== expected.index)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Interpretation units must settle in contiguous schedule order'
      );
  }
  const quality = parsed(
    InterpretationQualitySchema,
    input.processing.quality,
    'Interpretation extraction quality'
  );
  if (quality.diagnostics.length > 128)
    invalid('An interpretation attempt retains at most 128 diagnostic details');
  for (const diagnostic of quality.diagnostics) {
    if (diagnostic.unit_id !== expected.unitId)
      invalid('Every diagnostic names the unit this attempt settles');
    const segment = scheduledUnit.segments.find(
      (candidate) =>
        candidate.source_id === diagnostic.source_id &&
        candidate.occurrence.field_path === diagnostic.field_path
    );
    if (segment === undefined)
      invalid('Every diagnostic names a source field supplied to this unit');
  }
  const aliases = new Map(
    prepared.sources.map((source) => [source.requested.source_id, source.sourceId])
  );
  const primaryRanges = scheduledUnit.segments
    .filter((segment) => segment.purpose === 'primary')
    .map((segment) => ({
      segment_id: segment.segment_id,
      source_id: aliases.get(segment.source_id)!,
      prepared_start_utf8: segment.prepared_range.start,
      prepared_end_utf8: segment.prepared_range.end,
    }));
  return { attempt, binding, schedule, quality, primaryRanges };
}

function noReceiptReplayFromView(
  view: ProjectReadView,
  input: PublishProcessingInterpretation,
  prepared: PreparedInterpretation,
  requestSha256: string
): InterpretationCompletion | null {
  const { attempt } = completionAttempt(view, input, prepared);
  if (attempt.outcome === null) return null;
  const detail = attempt.detail;
  const retainedDetail =
    detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
  const retainedSha256 = retainedDetail?.[COMPLETION_REQUEST_SHA256] ?? null;
  if (retainedSha256 !== requestSha256)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This processing attempt already settled a different completion request'
    );
  const publication = retainedDetail?.[COMPLETION_PUBLICATION] as
    | InterpretationPublication
    | undefined;
  if (publication === undefined)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained processing completion is missing its publication or job; preserve history for explicit repair'
    );
  const retainedReceipt = InterpretationUnitReceiptSchema.safeParse(
    retainedDetail?.[INTERPRETATION_UNIT_RECEIPT]
  );
  if (!retainedReceipt.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained processing completion has no valid storage-authored unit receipt'
    );
  return {
    publication: parsed(InterpretationPublicationSchema, publication, 'Completion publication'),
    receipt: retainedReceipt.data,
    publishingOperationId: attempt.publishingOperationId,
    completionRequestSha256: requestSha256,
  };
}

function noReceiptReplay(
  handle: ProjectDatabase,
  input: PublishProcessingInterpretation,
  prepared: PreparedInterpretation,
  requestSha256: string
) {
  const replay = handle.read((view) =>
    noReceiptReplayFromView(view, input, prepared, requestSha256)
  ).value;
  return replay === null ? null : committedNothing(handle, replay);
}

async function settleNoPublication(
  handle: ProjectDatabase,
  input: PublishProcessingInterpretation,
  prepared: PreparedInterpretation,
  requestSha256: string,
  options: ProjectOperationOptions
) {
  const replay = noReceiptReplay(handle, input, prepared, requestSha256);
  if (replay !== null) return replay;
  const value = await runProcessingMaintenance(
    handle,
    'processing.interpretation.complete',
    (transaction) => {
      const replay = noReceiptReplayFromView(transaction, input, prepared, requestSha256);
      if (replay !== null) return replay;
      const validated = completionAttempt(transaction, input, prepared);
      const retained = prepared.alreadyRetained(transaction);
      if (retained === null)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The interpretation is no longer wholly retained; retry its publication'
        );
      const publication = prepared.settle(transaction, prepared.operation, true);
      const receipt: InterpretationUnitReceipt = {
        schema: 'orcaops.interpretation_unit_receipt/v1',
        job_id: input.processing.jobId,
        schedule_id: input.processing.unit.scheduleId,
        unit_id: input.processing.unit.unitId,
        unit_index: input.processing.unit.index,
        unit_count: input.processing.unit.count,
        manifest_sha256: input.processing.manifestSha256,
        requested_source_ids: publication.sources.map((source) => source.requestedSourceId),
        canonical_source_ids: publication.sources.map((source) => source.sourceId),
        primary_ranges: validated.primaryRanges,
        quality: validated.quality,
        completion_request_sha256: requestSha256,
        publishing_operation_id: null,
      };
      const settlement = settleProcessingAttemptInTransaction(transaction, {
        ...input.processing,
        outcome: processingOutcome(input.processing, publication, receipt),
      });
      return {
        publication,
        receipt,
        publishingOperationId: settlement.attempt.publishingOperationId,
        completionRequestSha256: requestSha256,
      };
    },
    options
  );
  return committedNothing(handle, value);
}

export async function publishInterpretedKnowledgeAndSettleAttempt(
  handle: ProjectDatabase,
  input: PublishProcessingInterpretation,
  options: ProjectOperationOptions = {}
) {
  if (input.operationId !== input.processing.attemptId)
    invalid('An interpretation completion uses its durable attempt ID as its operation ID');
  const prepared = prepareInterpretation(handle, input);
  handle.read((view) => completionAttempt(view, input, prepared));
  const requestSha256 = completionRequestSha256(prepared, input.processing);
  const operation: ProjectOperation = {
    ...prepared.operation,
    kind: 'knowledge.interpretation.complete',
    target: {
      sources: prepared.sources.map((source) => source.sourceId),
      records: prepared.records.map((record) => ({ kind: record.kind, id: record.id })),
      processing: {
        jobId: input.processing.jobId,
        attemptId: input.processing.attemptId,
        unit: { ...input.processing.unit },
      },
    },
    payload: {
      sources: prepared.sources.map((source) => source.payload),
      records: prepared.records.map((record) => record.sha256),
      completionRequestSha256: requestSha256,
    },
  };
  if (retriedOperation(handle, input.operationId))
    return replayOperation(handle, operation, options);
  const replay = noReceiptReplay(handle, input, prepared, requestSha256);
  if (replay !== null) return replay;
  const { unit, outcome } = input.processing;
  if (
    !/^[0-9a-f]{64}$/.test(input.processing.manifestSha256) ||
    !/^[0-9a-f]{64}$/.test(unit.scheduleId) ||
    !/^[0-9a-f]{64}$/.test(unit.unitId) ||
    !Number.isSafeInteger(unit.index) ||
    unit.index < 0 ||
    !Number.isSafeInteger(unit.count) ||
    unit.count < 1 ||
    unit.index >= unit.count
  )
    invalid('Provide the exact bounded schedule, unit, index and count');
  if ((outcome.kind === 'completed') !== (unit.index + 1 === unit.count))
    invalid('Only the final scheduled unit completes a processing job');
  if (handle.read(prepared.alreadyRetained).value !== null)
    return settleNoPublication(handle, input, prepared, requestSha256, options);
  try {
    return await runProjectOperation(
      handle,
      operation,
      (transaction, settling) => {
        const current = completionAttempt(transaction, input, prepared);
        const publication = prepared.settle(transaction, settling, true);
        if (
          publication.sources.every((source) => source.replay) &&
          publication.published.every((entry) => entry.replay)
        )
          throw new AlreadyRetained(publication);
        const receipt: InterpretationUnitReceipt = {
          schema: 'orcaops.interpretation_unit_receipt/v1',
          job_id: input.processing.jobId,
          schedule_id: input.processing.unit.scheduleId,
          unit_id: input.processing.unit.unitId,
          unit_index: input.processing.unit.index,
          unit_count: input.processing.unit.count,
          manifest_sha256: input.processing.manifestSha256,
          requested_source_ids: publication.sources.map((source) => source.requestedSourceId),
          canonical_source_ids: publication.sources.map((source) => source.sourceId),
          primary_ranges: current.primaryRanges,
          quality: current.quality,
          completion_request_sha256: requestSha256,
          publishing_operation_id: input.operationId,
        };
        const settlement = settleProcessingAttemptInTransaction(
          transaction,
          {
            ...input.processing,
            outcome: processingOutcome(input.processing, publication, receipt),
          },
          input.operationId
        );
        return {
          publication,
          receipt,
          publishingOperationId: settlement.attempt.publishingOperationId,
          completionRequestSha256: requestSha256,
        };
      },
      options
    );
  } catch (error) {
    if (error instanceof AlreadyRetained)
      return settleNoPublication(handle, input, prepared, requestSha256, options);
    throw error;
  }
}

interface InterpretationAttemptReceiptRow {
  attemptId: string;
  attemptNumber: number;
  configurationJson: string;
  outcome: string | null;
  detailJson: string | null;
  publishingOperationId: string | null;
}

function decodeRetainedJson(value: string, what: string): DatabaseJson {
  try {
    return JSON.parse(value) as DatabaseJson;
  } catch {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      `The retained ${what} is not valid JSON`
    );
  }
}

function receiptPublication(detail: Record<string, DatabaseJson>): InterpretationPublication {
  const publication = InterpretationPublicationSchema.safeParse(detail[COMPLETION_PUBLICATION]);
  if (!publication.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained interpretation unit receipt has no valid publication receipt'
    );
  return publication.data;
}

function verifiedReceipt(
  view: ProjectReadView,
  jobId: string,
  row: InterpretationAttemptReceiptRow,
  binding: z.infer<typeof InterpretationAttemptScheduleBindingSchema>,
  schedule: InterpretationProcessingSchedule
): InterpretationUnitReceipt | null {
  if (row.detailJson === null) return null;
  const rawDetail = decodeRetainedJson(row.detailJson, 'processing attempt detail');
  const detail = recordObject(rawDetail);
  if (detail === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained processing attempt detail is not an object'
    );
  const rawReceipt = detail[INTERPRETATION_UNIT_RECEIPT];
  const hasCompletionField = [
    COMPLETION_REQUEST_SHA256,
    COMPLETION_PUBLICATION,
    INTERPRETATION_QUALITY,
    'published',
    'publishing_operation_id',
  ].some((key) => key in detail);
  if (rawReceipt === undefined) {
    if (hasCompletionField)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A retained interpretation completion is missing its storage-authored unit receipt'
      );
    return null;
  }
  if (row.outcome === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An unsettled processing attempt cannot carry a completed unit receipt'
    );
  const parsedReceipt = InterpretationUnitReceiptSchema.safeParse(rawReceipt);
  if (!parsedReceipt.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained interpretation unit receipt has an unsupported or malformed shape'
    );
  const receipt = parsedReceipt.data;
  if (
    receipt.job_id !== jobId ||
    binding.unit === null ||
    receipt.schedule_id !== binding.unit.schedule_id ||
    receipt.unit_id !== binding.unit.unit_id ||
    receipt.unit_index !== binding.unit.index ||
    receipt.unit_count !== binding.unit.count ||
    receipt.manifest_sha256 !==
      recordObject(decodeRetainedJson(row.configurationJson, 'processing attempt configuration'))
        ?.manifest_sha256 ||
    detail[COMPLETION_REQUEST_SHA256] !== receipt.completion_request_sha256 ||
    canonicalJson(detail[INTERPRETATION_QUALITY]) !== canonicalJson(receipt.quality) ||
    detail.publishing_operation_id !== receipt.publishing_operation_id ||
    row.publishingOperationId !== receipt.publishing_operation_id
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained interpretation unit receipt conflicts with its settled attempt'
    );
  const publication = receiptPublication(detail);
  const published = RetainedPublishedRecordsSchema.safeParse(detail.published);
  if (!published.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained interpretation unit receipt has no valid published-record ledger'
    );
  const publicationRecords = publication.published.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    revision_id: entry.revisionId,
    replay: entry.replay,
  }));
  if (
    canonicalJson(publication.sources.map((source) => source.requestedSourceId)) !==
      canonicalJson(receipt.requested_source_ids) ||
    canonicalJson(publication.sources.map((source) => source.sourceId)) !==
      canonicalJson(receipt.canonical_source_ids) ||
    canonicalJson(published.data) !== canonicalJson(publicationRecords)
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An interpretation unit receipt conflicts with its retained publication ledger'
    );
  const whollyReplayed =
    publication.sources.every((source) => source.replay) &&
    publication.published.every((entry) => entry.replay);
  if ((receipt.publishing_operation_id === null) !== whollyReplayed)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An interpretation unit receipt conflicts with its publication operation identity'
    );
  if (receipt.publishing_operation_id !== null) {
    const operation = view.get<{ operationKind: string; targetJson: string }>(
      `SELECT operation_kind AS operationKind, target_json AS targetJson
       FROM operations WHERE operation_id=?`,
      receipt.publishing_operation_id
    );
    if (operation === null)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The operation named by an interpretation unit receipt is missing'
      );
    const target = recordObject(
      decodeRetainedJson(operation.targetJson, 'interpretation completion operation target')
    );
    const processing = recordObject(target?.processing ?? null);
    if (
      operation.operationKind !== 'knowledge.interpretation.complete' ||
      processing?.jobId !== jobId ||
      processing?.attemptId !== row.attemptId ||
      canonicalJson(processing?.unit) !==
        canonicalJson({
          scheduleId: binding.unit.schedule_id,
          unitId: binding.unit.unit_id,
          index: binding.unit.index,
          count: binding.unit.count,
        })
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'An interpretation unit receipt names a different publication operation'
      );
  }
  const unit = schedule.units[receipt.unit_index];
  if (unit === undefined || unit.unit_id !== receipt.unit_id)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An interpretation unit receipt does not name its exact scheduled unit'
    );
  const aliases = new Map(
    receipt.requested_source_ids.map((sourceId, index) => [
      sourceId,
      receipt.canonical_source_ids[index]!,
    ])
  );
  const expectedRanges = unit.segments
    .filter((segment) => segment.purpose === 'primary')
    .map((segment) => ({
      segment_id: segment.segment_id,
      source_id: aliases.get(segment.source_id),
      prepared_start_utf8: segment.prepared_range.start,
      prepared_end_utf8: segment.prepared_range.end,
    }));
  if (
    expectedRanges.some((range) => range.source_id === undefined) ||
    canonicalJson(expectedRanges) !== canonicalJson(receipt.primary_ranges)
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'An interpretation unit receipt does not cover the exact scheduled primary ranges'
    );
  return receipt;
}

export function readInterpretationProgressFromView(
  view: ProjectReadView,
  jobId: string
): InterpretationProgress | null {
  const job = readProcessingJobFromView(view, jobId);
  if (job === null) return null;
  const rows = view.all<InterpretationAttemptReceiptRow>(
    `SELECT attempt_id AS attemptId, attempt_number AS attemptNumber,
       configuration_json AS configurationJson, outcome, detail_json AS detailJson,
       publishing_operation_id AS publishingOperationId
     FROM processing_attempts WHERE job_id=? ORDER BY attempt_number`,
    jobId
  );
  if (rows.length === 0) return null;
  const bound = rows.map((row) => {
    const configuration = decodeRetainedJson(
      row.configurationJson,
      'processing attempt configuration'
    );
    const binding = retainedBinding(view, row.attemptId, configuration);
    return { row, binding };
  });
  const definitions = bound.filter(({ binding }) => binding.schedule !== null);
  if (definitions.length === 0)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A processing job with attempts is missing its immutable interpretation schedule'
    );
  if (definitions.length > 1)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A processing job retains more than one full interpretation schedule'
    );
  const retainedScheduleValue = definitions[0]!.binding.schedule!;
  const receiptsByUnit = new Map<string, InterpretationUnitReceipt>();
  for (const { row, binding } of bound) {
    if (binding.unit === null) {
      if (
        retainedScheduleValue.units.length !== 0 ||
        row.outcome === null ||
        row.detailJson === null
      )
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Only the no-call empty schedule attempt may omit a selected interpretation unit'
        );
      const detail = recordObject(
        decodeRetainedJson(row.detailJson, 'empty-schedule processing attempt detail')
      );
      const quality = InterpretationQualitySchema.safeParse(detail?.[INTERPRETATION_QUALITY]);
      if (
        !quality.success ||
        quality.data.outcome !== 'empty' ||
        Object.values(quality.data.proposed).some((count) => count !== 0) ||
        INTERPRETATION_UNIT_RECEIPT in (detail ?? {})
      )
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'An empty interpretation schedule must retain empty quality and no unit receipt'
        );
      continue;
    }
    if (
      binding.schedule_attempt_id !== rows[0]!.attemptId ||
      binding.unit.schedule_id !== retainedScheduleValue.schedule_id
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A processing attempt does not reference the job immutable interpretation schedule'
      );
    const receipt = verifiedReceipt(view, jobId, row, binding, retainedScheduleValue);
    if (receipt === null) continue;
    const previous = receiptsByUnit.get(receipt.unit_id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(receipt))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A scheduled interpretation unit has conflicting completion receipts'
      );
    receiptsByUnit.set(receipt.unit_id, receipt);
  }
  const receipts = [...receiptsByUnit.values()].sort(
    (left, right) => left.unit_index - right.unit_index
  );
  receipts.forEach((receipt, index) => {
    if (receipt.unit_index !== index)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Interpretation progress contains a hole before a settled unit'
      );
  });
  return { schedule: retainedScheduleValue, receipts };
}

export function readInterpretationProgress(
  handle: ProjectDatabase,
  jobId: string
): InterpretationProgress | null {
  return handle.read((view) => readInterpretationProgressFromView(view, jobId)).value;
}
