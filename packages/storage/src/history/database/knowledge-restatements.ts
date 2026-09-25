// Recording that a passage of a source states, word for word, what a retained revision already
// says. Nothing about the revision moves: no successor, no standing, no adoption, neither
// counter. What the store gains is another retained occurrence of the same words, which is what a
// repeated capture really adds and what a revision identical to its predecessor, one per
// restating source, was standing in for.
//
// Word for word is decided here, inside the transaction, against two things the caller does not
// supply: the revision's own retained bytes, and the retained text of the source the passage
// names. Without the second, the hash would say only that the caller knew the statement and any
// retained source could be made to corroborate any revision.
//
// A passage the revision already cites is refused, because a carried copy is not independent
// corroboration — and for a requirement that means the passages of the revision together with the
// passage its identity was promoted from, which is where a promoted requirement's own words live.
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { readRetainedCaptureField } from './knowledge-capture-fields.js';
import {
  actingField,
  AlreadyRetained,
  attributionColumns,
  type AuthoredRecord,
  authoredRecord,
  committedNothing,
  integrity,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  replayOperation,
  requireRetainedSources,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  type Attribution,
  checkPassageRestatement,
  type PassageRestatement,
  PassageRestatementSchema,
  type RecordRevisionRef,
  type RestatingSource,
  type SourceSelector,
  SourceSelectorSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishPassageRestatement {
  readonly operationId: string;
  /** The passage restatement as authored, without `attributed_to`. */
  readonly restatement: unknown;
  /** Who noticed it, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type PassageRestatementPublication = {
  restatementId: string;
  recordSha256: string;
  /** False when this passage already restated this revision, which this call returned unwritten. */
  published: boolean;
};

// Where each kind states its words. A relationship states none, which is why the contract refuses
// one as the thing restated.
const STATED_REVISION = {
  requirement: ['requirement_revisions', 'requirement_id', 'statement'],
  decision: ['decision_revisions', 'decision_id', 'chosen_approach'],
  claim: ['claim_revisions', 'claim_id', 'statement'],
} as const;

const PassagesSchema = z.array(SourceSelectorSchema);

interface RestatedRevision {
  passages: readonly SourceSelector[];
  statement: string;
}

/** A retained payload is JSON, but a released one may be any JSON: a bare null states nothing. */
const payloadOf = (record: string): Record<string, unknown> => {
  const payload: unknown = JSON.parse(record);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    invalid('The revision this restatement names states nothing this store can read word for word');
  return payload as Record<string, unknown>;
};

/**
 * What the revision states, and every passage it already counts as its own. A requirement
 * promoted from a source keeps that passage in its identity, not in any revision, so the two are
 * read together: otherwise a promoted requirement could be restated by the very passage it was
 * promoted from.
 */
const restatedRevision = (view: ProjectReadView, ref: RecordRevisionRef): RestatedRevision => {
  const [table, column, field] = STATED_REVISION[ref.kind as keyof typeof STATED_REVISION];
  const row = view.get<{ record: string }>(
    `SELECT CAST(record_bytes AS TEXT) AS record FROM ${table} WHERE ${column}=? AND revision_id=?`,
    ref.entity_id,
    ref.revision_id
  );
  if (!row) missing('The revision this restatement names is not retained in this history');
  const payload = payloadOf(row.record);
  const statement = payload[field];
  // A released row was written before the contract had a shape, so its payload may state its
  // words somewhere this build cannot find them. Nothing can be compared word for word then.
  if (typeof statement !== 'string')
    invalid('The revision this restatement names states nothing this store can read word for word');
  const cited = PassagesSchema.safeParse(payload.passages ?? []);
  if (!cited.success)
    integrity(
      'A retained revision carries passages this build cannot read; preserve history for explicit repair'
    );
  return { passages: [...cited.data, ...promotedPassage(view, ref)], statement };
};

const promotedPassage = (view: ProjectReadView, ref: RecordRevisionRef): SourceSelector[] => {
  if (ref.kind !== 'requirement') return [];
  const origin = view.get<{
    passage_source_id: string;
    passage_location: string;
    passage_sha256: string;
  }>(
    "SELECT passage_source_id, passage_location, passage_sha256 FROM requirements WHERE requirement_id=? AND origin_kind='promoted_source'",
    ref.entity_id
  );
  return origin
    ? [
        {
          source_id: origin.passage_source_id,
          location: origin.passage_location,
          passage_sha256: origin.passage_sha256,
        },
      ]
    : [];
};

const restatingSource = (view: ProjectReadView, sourceId: string): RestatingSource => {
  const row = view.get<{
    source_kind: string;
    retention_kind: string | null;
    retained: string | null;
  }>(
    `SELECT source_kind, retention_kind, CAST(retained_bytes AS TEXT) AS retained
     FROM knowledge_sources WHERE source_id=?`,
    sourceId
  );
  if (!row) missing('The record cites a knowledge source this history does not hold');
  if (row.retention_kind === 'retained_reference') return { kind: 'retained_reference' };
  const text =
    row.source_kind === 'capture_field'
      ? readRetainedCaptureField(view, sourceId).text
      : row.retained;
  if (text === null)
    integrity('A retained source holds no text; preserve history for explicit repair');
  return { kind: 'retained_text', text };
};

const RESTATEMENT_REFUSAL = {
  RESTATED_STATEMENT_NOT_VERBATIM:
    'That passage is not word for word what the revision states; a paraphrase is a proposed revision, not a restatement',
  SOURCE_RETAINED_ONLY_BY_REFERENCE:
    'That source is held by an immutable reference and retains no text here, so nothing in it can be checked',
  STATEMENT_NOT_IN_THE_SOURCE: 'That source does not state what the revision states',
  PASSAGE_ALREADY_CITED_BY_THE_REVISION:
    'The revision already cites that passage, and its own source is not a second occurrence of it',
} as const;

const retainedPublication = (row: {
  restatement_id: string;
  record_sha256: string;
}): PassageRestatementPublication => ({
  restatementId: row.restatement_id,
  recordSha256: row.record_sha256,
  published: false,
});

const restatedAlready = (view: ProjectReadView, restatement: PassageRestatement) =>
  view.get<{ restatement_id: string; record_sha256: string }>(
    `SELECT restatement_id, record_sha256 FROM passage_restatements
     WHERE passage_source_id=? AND passage_location=? AND passage_sha256=? AND restates_kind=? AND restates_revision_id=?`,
    restatement.passage.source_id,
    restatement.passage.location,
    restatement.passage.passage_sha256,
    restatement.restates.kind,
    restatement.restates.revision_id
  );

export interface PreparedPassageRestatement {
  readonly restatement: PassageRestatement;
  readonly record: AuthoredRecord;
}

export function prepareProjectPassageRestatement(
  input: Omit<PublishPassageRestatement, 'operationId'>
): PreparedPassageRestatement {
  const restatement = parsed(
    PassageRestatementSchema,
    actingField(input.restatement, 'attributed_to', input.attributedTo),
    'A passage restatement'
  );
  return { restatement, record: authoredRecord(restatement, secretAllowList(input.secretAllow)) };
}

/**
 * The restatement this pair already has, if any, after refusing everything the store decides about
 * a new one — the words against the revision and against the source's own retained text. Null
 * means nothing is retained for it and it may be written.
 */
export function retainedProjectPassageRestatement(
  view: ProjectReadView,
  prepared: PreparedPassageRestatement
): PassageRestatementPublication | null {
  const { restatement, record } = prepared;
  const existing = restatedAlready(view, restatement);
  // One passage restates one revision once, so a second row could only repeat the first. The
  // caller gets the retained one back when it authored exactly that, and is otherwise refused
  // by the name of the restatement the pair already has.
  if (existing)
    return existing.record_sha256 === record.sha256
      ? retainedPublication(existing)
      : taken(
          `That passage already restates that revision as restatement ${existing.restatement_id}`
        );
  if (
    view.get(
      'SELECT restatement_id FROM passage_restatements WHERE restatement_id=?',
      restatement.restatement_id
    )
  )
    taken('That restatement ID already belongs to a different retained restatement');
  requireRetainedSources(view, [restatement.passage.source_id]);
  const outcome = checkPassageRestatement({
    restatement,
    restated_revision: restatedRevision(view, restatement.restates),
    passage_source: restatingSource(view, restatement.passage.source_id),
  });
  if (!outcome.ok) invalid(RESTATEMENT_REFUSAL[outcome.code]);
  return null;
}

/**
 * The in-transaction writer, so a caller's own operation can record the occurrence beside the
 * records it publishes. `published` is false when the pair already had its restatement.
 */
export function settleProjectPassageRestatement(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: PreparedPassageRestatement
): PassageRestatementPublication {
  const existing = retainedProjectPassageRestatement(transaction, prepared);
  if (existing) return existing;
  const { restatement, record } = prepared;
  const [kind, name, basis] = attributionColumns(restatement.attributed_to);
  transaction.run(
    `INSERT INTO passage_restatements (restatement_id, passage_source_id, passage_location, passage_sha256,
       restates_kind, restates_id, restates_revision_id,
       attributed_kind, attributed_to, attributed_basis, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    restatement.restatement_id,
    restatement.passage.source_id,
    restatement.passage.location,
    restatement.passage.passage_sha256,
    restatement.restates.kind,
    restatement.restates.entity_id,
    restatement.restates.revision_id,
    kind,
    name,
    basis,
    record.bytes,
    record.sha256,
    operationId
  );
  return {
    restatementId: restatement.restatement_id,
    recordSha256: record.sha256,
    published: true,
  };
}

export async function publishProjectPassageRestatement(
  handle: ProjectDatabase,
  input: PublishPassageRestatement,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareProjectPassageRestatement(input);
  const { restatement, record } = prepared;
  const op = {
    operationId,
    kind: 'knowledge.restatement.publish',
    target: {
      restatementId: restatement.restatement_id,
      restates: restatement.restates,
      passage: restatement.passage,
    },
    payload: { record: record.sha256 },
    expectedState: null,
    // A passage restatement changes nothing that stands, so it is no change of intent.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const retained = handle.read((view) => retainedProjectPassageRestatement(view, prepared)).value;
  // A passage that already restates the revision is not recorded again, and a call that publishes
  // nothing runs no operation: no receipt, and neither counter moves.
  if (retained) return committedNothing(handle, retained);
  return publishUnlessRetained(
    handle,
    op,
    (transaction: ProjectSettlement): PassageRestatementPublication => {
      const settled = settleProjectPassageRestatement(transaction, operationId, prepared);
      if (!settled.published) throw new AlreadyRetained(settled);
      return settled;
    },
    options
  );
}

export interface ProjectPassageRestatementRow {
  readonly restatementId: string;
  readonly passage: SourceSelector;
  /**
   * What identifies the text the passage is in: the source's content hash, or the source's own id
   * when it is a capture field, which owns no copy of the bytes and so has no content of its own.
   */
  readonly sourceContent: string;
  readonly restates: { kind: string; entityId: string; revisionId: string };
  readonly attribution: { kind: string; name: string | null; basis: string | null };
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

/**
 * Three counts, never one. Rows say how often the words were noticed; distinct sources say how
 * many retained sources hold them; distinct texts say how many DIFFERENT texts do, by the
 * sources' content hashes, so five captures of one unchanged document read as one text and not as
 * five corroborations. A carried copy is not independent corroboration, and only the last of the
 * three can be read as anything like it.
 */
export interface ProjectPassageRestatements {
  readonly occurrences: number;
  readonly distinctSources: number;
  readonly distinctTexts: number;
  readonly restatements: ProjectPassageRestatementRow[];
}

export function readProjectPassageRestatements(
  view: ProjectReadView,
  restates: Pick<RecordRevisionRef, 'kind' | 'entity_id' | 'revision_id'>
): ProjectPassageRestatements {
  const restatements = view
    .all<{
      restatement_id: string;
      passage_source_id: string;
      passage_location: string;
      passage_sha256: string;
      source_content: string;
      restates_kind: string;
      restates_id: string;
      restates_revision_id: string;
      attributed_kind: string;
      attributed_to: string | null;
      attributed_basis: string | null;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      `SELECT r.restatement_id, r.passage_source_id, r.passage_location, r.passage_sha256,
         ifnull(s.content_sha256, s.source_id) AS source_content,
         r.restates_kind, r.restates_id, r.restates_revision_id,
         r.attributed_kind, r.attributed_to, r.attributed_basis,
         hex(r.record_bytes) AS record_hex, r.record_sha256, r.operation_id
       FROM passage_restatements r
       JOIN knowledge_sources s ON s.source_id=r.passage_source_id
       WHERE r.restates_kind=? AND r.restates_id=? AND r.restates_revision_id=? ORDER BY r.rowid`,
      restates.kind,
      restates.entity_id,
      restates.revision_id
    )
    .map((row) => ({
      restatementId: row.restatement_id,
      passage: {
        source_id: row.passage_source_id,
        location: row.passage_location,
        passage_sha256: row.passage_sha256,
      },
      sourceContent: row.source_content,
      restates: {
        kind: row.restates_kind,
        entityId: row.restates_id,
        revisionId: row.restates_revision_id,
      },
      attribution: {
        kind: row.attributed_kind,
        name: row.attributed_to,
        basis: row.attributed_basis,
      },
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return {
    occurrences: restatements.length,
    distinctSources: new Set(restatements.map((row) => row.passage.source_id)).size,
    distinctTexts: new Set(restatements.map((row) => row.sourceContent)).size,
    restatements,
  };
}
