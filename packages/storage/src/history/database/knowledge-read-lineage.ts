// The tips of one identity's revision lineage at a knowledge boundary: the revisions no later
// revision visible there names as its predecessor.
//
// Several revisions may name the same predecessor, so a lineage branches and a read has as many
// tips as it has branches. A tip is not an adoption: it is the end of a chain of authored
// revisions, and what stands is the governing state beside it.
//
// The passage restatement counts are attached the way the contract's step 5 attaches them — an
// attachment that changes nothing that stands. They say how often the words were noticed, how many
// retained sources hold them and how many distinct texts do, and no rule here turns on one.
import { type ProjectReadView } from './connection.js';
import {
  type KnowledgeReadCoverage,
  knowledgeReadCoverage,
  type RevisionGoverningStanding,
  revisionGoverningState,
  writeSequencesOf,
} from './knowledge-read-boundary.js';
import { type GoverningStateReader, governingStateReader } from './knowledge-read-governing.js';
import {
  type ProjectPassageRestatements,
  readProjectPassageRestatements,
} from './knowledge-restatements.js';
import { type RecordRevisionRef } from '../../schema/knowledge-contract.js';
import {
  type KnowledgeReadRequest,
  type KnowledgeTarget,
  type RevisionStanding,
  type UnresolvedPoint,
} from '../../schema/knowledge-resolution.js';

/** Every revision table keys its revisions on its own identity column, and all three are indexed. */
const LINEAGE_QUERY: Readonly<Record<string, string>> = {
  requirement: lineageQuery('requirement_revisions', 'requirement_id'),
  decision: lineageQuery('decision_revisions', 'decision_id'),
  claim: lineageQuery('claim_revisions', 'claim_id'),
};

function lineageQuery(table: string, identity: string): string {
  return `SELECT r.revision_id, r.previous_revision_id, r.operation_id,
       o.committed_write_sequence AS write_sequence
     FROM ${table} r JOIN operations o ON o.operation_id=r.operation_id
     WHERE r.${identity}=?`;
}

export interface ProjectLineageRevision {
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly writeSequence: number;
  readonly operationId: string;
}

export interface ProjectLineageTip extends ProjectLineageRevision {
  readonly revision: RecordRevisionRef;
  readonly standing: RevisionGoverningStanding;
  /** The resolver's own entries for the revision, one per scope it was acted on in. */
  readonly entries: readonly RevisionStanding[];
  readonly restatements: ProjectPassageRestatements;
}

export interface ProjectLineageTips {
  readonly target: KnowledgeTarget;
  readonly coverage: KnowledgeReadCoverage;
  /** Every revision of the identity visible at the boundary, tips and predecessors alike. */
  readonly revisions: readonly ProjectLineageRevision[];
  readonly tips: readonly ProjectLineageTip[];
}

/**
 * The restatements of one revision, without the ones published after the boundary. A restatement
 * carries no standing, so the boundary is the only thing that can hide one, and dropping a row
 * means recounting: the three counts are over the rows that were there.
 */
function restatementsAt(
  held: ProjectPassageRestatements,
  boundary: number,
  sequences: ReadonlyMap<string, number>
): ProjectPassageRestatements {
  const kept = held.restatements.filter(
    (row) => (sequences.get(row.operationId) ?? Number.MAX_SAFE_INTEGER) <= boundary
  );
  if (kept.length === held.restatements.length) return held;
  return {
    occurrences: kept.length,
    distinctSources: new Set(kept.map((row) => row.passage.source_id)).size,
    distinctTexts: new Set(kept.map((row) => row.sourceContent)).size,
    restatements: kept,
  };
}

/**
 * A caller that already resolves identities at this boundary passes its own reader, so an
 * identity it has asked about is not resolved a second time here. Every answer in one reader comes
 * from one snapshot and one boundary, so a reader built for another request would answer another
 * question; the caller that shares one shares its request too.
 */
export function readProjectLineageTips(
  view: ProjectReadView,
  target: KnowledgeTarget,
  projectId: string,
  request: KnowledgeReadRequest,
  reader?: GoverningStateReader
): ProjectLineageTips {
  const query = LINEAGE_QUERY[target.kind];
  if (query === undefined)
    return {
      target,
      coverage: knowledgeReadCoverage(request, []),
      revisions: [],
      tips: [],
    };
  const revisions = view
    .all<{
      revision_id: string;
      previous_revision_id: string | null;
      operation_id: string;
      write_sequence: number;
    }>(query, target.entity_id)
    .filter((row) => row.write_sequence <= request.knowledge_boundary)
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      writeSequence: row.write_sequence,
      operationId: row.operation_id,
    }));
  const superseded = new Set(
    revisions.flatMap((entry) =>
      entry.previousRevisionId === null ? [] : [entry.previousRevisionId]
    )
  );
  const governing = reader ?? governingStateReader(view, projectId, request);
  const unsupplied: UnresolvedPoint[] = [];
  const held = revisions
    .filter((entry) => !superseded.has(entry.revisionId))
    .map((entry) => {
      const revision = {
        kind: target.kind,
        entity_id: target.entity_id,
        revision_id: entry.revisionId,
      } as RecordRevisionRef;
      return { entry, revision, restatements: readProjectPassageRestatements(view, revision) };
    });
  const sequences = writeSequencesOf(
    view,
    held.flatMap((tip) => tip.restatements.restatements.map((row) => row.operationId))
  );
  const tips = held.map(({ entry, revision, restatements }) => {
    const state = revisionGoverningState(governing.at(target), entry.revisionId);
    // A revision row the store holds but whose record it cannot read — a released row that
    // recorded no standing, or a payload that will not read as its contract record — is named
    // here rather than dropped, so a tip never goes missing in silence.
    if (!state.supplied)
      unsupplied.push({
        about: 'revision',
        record_ids: [entry.revisionId],
        reason: 'revision_not_supplied',
      });
    return {
      ...entry,
      revision,
      standing: state.standing,
      entries: state.entries,
      restatements: restatementsAt(restatements, request.knowledge_boundary, sequences),
    };
  });
  return {
    target,
    // This identity's answer, never every answer the reader holds: a shared reader carries the
    // identities its other callers asked about, and a lineage read reports what it read.
    coverage: knowledgeReadCoverage(
      request,
      held.length === 0 ? [] : [governing.at(target)],
      unsupplied
    ),
    revisions,
    tips,
  };
}
