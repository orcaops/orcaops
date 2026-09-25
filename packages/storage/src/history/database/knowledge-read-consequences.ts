// What the store can say about what else a change reaches: the typed relationships on either side
// of an identity, the recorded assumptions that name it, the assessments that weighed it, the
// artifacts that touched a path, the identities that share its subject, and the identities whose
// standing moved after a boundary.
//
// Every reader here is passive and reads at the caller's boundary. None of them decides that
// anything IS affected — that is the traversal's job, in core, over these rows. What they owe the
// traversal is the rows and, where the store cannot make a mapping, a limit saying so: an answer
// that quietly returned fewer rows would read as "nothing depends on this", which is the one thing
// a consequence answer must never say without having looked.
//
// Two reads here cost more than a seek, and both say so in a limit rather than hiding it: an
// assessment's selected inputs are one JSON column with nothing indexing them, and nothing indexes
// the write sequence an operation committed at, so the acts that move a revision's standing are
// read in full and filtered. Adding a column or an index for either is a schema change this slice
// does not make. `knowledge-consequence-plans.test.ts` names the queries that plan as scans.
import { type ProjectReadView } from './connection.js';
import {
  assessmentColumns,
  type AssessmentSelection,
  decodeAssessment,
  type ProjectAssessmentRow,
} from './knowledge-assessments.js';
import { type InputIdentity } from './knowledge-observations.js';
import { writeSequencesOf } from './knowledge-read-boundary.js';
import type { ExpectationRevisionRef, RecordRevisionRef } from '../../schema/knowledge-contract.js';
import type { KnowledgeReadRequest, KnowledgeTarget } from '../../schema/knowledge-resolution.js';

/** What a reader could not reach, in the words the answer carries it in. */
export interface ProjectConsequenceLimit {
  readonly kind: string;
  readonly detail: string;
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');

const distinctSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

// ── typed relationships ──────────────────────────────────────────────────────

export interface ProjectConsequenceRelationship {
  readonly relationshipId: string;
  readonly relation: string;
  readonly standing: string;
  readonly from: RecordRevisionRef;
  readonly to: RecordRevisionRef;
  readonly scope: { readonly kind: string; readonly value: string | null };
  readonly attributedTo: {
    readonly kind: string;
    readonly identity: string | null;
    readonly basis: string | null;
  };
  readonly explanation: string | null;
  readonly writeSequence: number;
}

export interface ProjectConsequenceRelationships {
  readonly identity: KnowledgeTarget;
  /** Established by an actor: the store says somebody made this link stand. */
  readonly established: readonly ProjectConsequenceRelationship[];
  /** Suggested and never established, which is all background processing can write. */
  readonly suggested: readonly ProjectConsequenceRelationship[];
  /** Rows on this identity published after the boundary, which this read did not follow. */
  readonly later: number;
}

interface RelationshipRow {
  relationship_id: string;
  relation: string;
  from_entity_kind: string;
  from_entity_id: string;
  from_revision_id: string;
  to_entity_kind: string;
  to_entity_id: string;
  to_revision_id: string;
  scope_kind: string;
  scope_value: string | null;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
  standing: string;
  explanation: string | null;
  operation_id: string;
}

const RELATIONSHIP_COLUMNS = `SELECT relationship_id, relation, from_entity_kind, from_entity_id,
    from_revision_id, to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value,
    attributed_kind, attributed_to, attributed_basis, standing, explanation, operation_id
  FROM record_relationships`;

/**
 * Each end has an index of its own, so the two sides are asked for separately rather than with an
 * `OR` that neither index leads: `record_relationship_from_entity` for the side a link points from
 * and `record_relationship_endpoints` for the side it points at.
 */
const RELATIONSHIPS_FROM = `${RELATIONSHIP_COLUMNS} WHERE from_entity_kind=? AND from_entity_id=? ORDER BY relationship_id`;
const RELATIONSHIPS_TO = `${RELATIONSHIP_COLUMNS} WHERE to_entity_kind=? AND to_entity_id=? ORDER BY relationship_id`;

const relationshipOf = (
  row: RelationshipRow,
  writeSequence: number
): ProjectConsequenceRelationship => ({
  relationshipId: row.relationship_id,
  relation: row.relation,
  standing: row.standing,
  from: {
    kind: row.from_entity_kind,
    entity_id: row.from_entity_id,
    revision_id: row.from_revision_id,
  } as RecordRevisionRef,
  to: {
    kind: row.to_entity_kind,
    entity_id: row.to_entity_id,
    revision_id: row.to_revision_id,
  } as RecordRevisionRef,
  scope: { kind: row.scope_kind, value: row.scope_value },
  // 'author' is the released word for an actor; a detector carries a name and no basis.
  attributedTo: {
    kind: row.attributed_kind === 'author' ? 'actor' : row.attributed_kind,
    identity: row.attributed_to,
    basis: row.attributed_basis,
  },
  explanation: row.explanation,
  writeSequence,
});

/**
 * Every relationship naming one identity from either end at the boundary, with what stands kept
 * apart from what was only ever suggested. A suggested link is a proposal — a detector's, or an
 * actor's before anyone established it — and folding the two together would let an extracted
 * guess read like a recorded dependency.
 */
export function readProjectRelationshipsOfIdentity(
  view: ProjectReadView,
  identity: KnowledgeTarget,
  request: KnowledgeReadRequest
): ProjectConsequenceRelationships {
  const rows = new Map<string, RelationshipRow>();
  for (const query of [RELATIONSHIPS_FROM, RELATIONSHIPS_TO])
    for (const row of view.all<RelationshipRow>(query, identity.kind, identity.entity_id))
      rows.set(row.relationship_id, row);
  const sequences = writeSequencesOf(
    view,
    [...rows.values()].map((row) => row.operation_id)
  );
  const established: ProjectConsequenceRelationship[] = [];
  const suggested: ProjectConsequenceRelationship[] = [];
  let later = 0;
  for (const row of [...rows.values()].sort((left, right) =>
    left.relationship_id < right.relationship_id ? -1 : 1
  )) {
    const writeSequence = sequences.get(row.operation_id);
    if (writeSequence === undefined) continue;
    if (writeSequence > request.knowledge_boundary) {
      later += 1;
      continue;
    }
    const relationship = relationshipOf(row, writeSequence);
    if (row.standing === 'established') established.push(relationship);
    else suggested.push(relationship);
  }
  return { identity, established, suggested, later };
}

// ── recorded assumptions ─────────────────────────────────────────────────────

export interface ProjectAssumptionMention {
  readonly decision: RecordRevisionRef;
  /** Which of the decision's two lists the wording sits in. */
  readonly where: 'assumption' | 'reconsideration_condition';
  readonly position: number;
  readonly text: string;
  readonly names: string;
  readonly authoredBy: {
    readonly kind: string;
    readonly identity: string | null;
    readonly basis: string | null;
  };
  readonly writeSequence: number;
}

export interface ProjectAssumptionMentions {
  readonly mentions: readonly ProjectAssumptionMention[];
  /** How many decision revisions were read to find them. */
  readonly read: number;
  readonly limits: readonly ProjectConsequenceLimit[];
}

interface DecisionRevisionRow {
  revision_id: string;
  decision_id: string;
  attributed_kind: string;
  authored_by: string | null;
  attributed_basis: string | null;
  payload: string;
  operation_id: string;
}

const listOf = (payload: Record<string, unknown>, field: string): string[] => {
  const held = payload[field];
  return Array.isArray(held)
    ? held.filter((entry): entry is string => typeof entry === 'string')
    : [];
};

/**
 * The decision revisions whose recorded assumptions or reconsideration conditions name one of
 * these identities.
 *
 * Nothing indexes the words of an assumption, and no column may be added for one here, so this is
 * a bounded read of exactly the decision revisions the caller already holds — the ones its answer
 * carries — by primary key, with the bound named as a limit. A decision this answer never looked
 * at is not reported as having no assumption about the change; it is reported as not looked at.
 */
export function readProjectAssumptionsNaming(
  view: ProjectReadView,
  input: { readonly names: readonly string[]; readonly decisionRevisionIds: readonly string[] },
  request: KnowledgeReadRequest
): ProjectAssumptionMentions {
  const names = distinctSorted(input.names).filter((name) => name.length > 0);
  const ids = distinctSorted(input.decisionRevisionIds);
  const limits: ProjectConsequenceLimit[] = [
    {
      kind: 'assumptions_not_indexed',
      detail:
        `Recorded assumptions and reconsideration conditions are prose inside a decision ` +
        `revision, and no column indexes their words. ${ids.length} decision revision(s) this ` +
        `answer already carries were read for a mention; any decision outside them was not ` +
        `looked at, and is not reported as having no assumption about this change.`,
    },
  ];
  if (names.length === 0 || ids.length === 0) return { mentions: [], read: 0, limits };
  const rows = view.all<DecisionRevisionRow>(
    `SELECT revision_id, decision_id, attributed_kind, authored_by, attributed_basis,
       CAST(record_bytes AS TEXT) AS payload, operation_id
     FROM decision_revisions WHERE revision_id IN (${placeholders(ids)}) ORDER BY revision_id`,
    ...ids
  );
  const sequences = writeSequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  const mentions: ProjectAssumptionMention[] = [];
  for (const row of rows) {
    const writeSequence = sequences.get(row.operation_id);
    if (writeSequence === undefined || writeSequence > request.knowledge_boundary) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const decision = {
      kind: 'decision',
      entity_id: row.decision_id,
      revision_id: row.revision_id,
    } as RecordRevisionRef;
    const authoredBy = {
      kind: row.attributed_kind,
      identity: row.authored_by,
      basis: row.attributed_basis,
    };
    for (const [field, where] of [
      ['assumptions', 'assumption'],
      ['reconsideration_conditions', 'reconsideration_condition'],
    ] as const)
      listOf(payload as Record<string, unknown>, field).forEach((text, position) => {
        for (const name of names)
          if (text.includes(name))
            mentions.push({
              decision,
              where,
              position,
              text,
              names: name,
              authoredBy,
              writeSequence,
            });
      });
  }
  return { mentions, read: rows.length, limits };
}

// ── assessments ──────────────────────────────────────────────────────────────

export interface ProjectConsequenceAssessment {
  readonly assessment: ProjectAssessmentRow;
  /** Which question reached it: the expectation it concluded about, or an input it selected. */
  readonly reached: 'expectation' | 'selected_input';
  readonly expectation: ExpectationRevisionRef | null;
  readonly conclusion: string | null;
  readonly input: InputIdentity | null;
  readonly writeSequence: number;
}

export interface ProjectConsequenceAssessments {
  readonly assessments: readonly ProjectConsequenceAssessment[];
  /** Assessments published after the boundary, by id, which this read did not follow. */
  readonly later: readonly string[];
  readonly limits: readonly ProjectConsequenceLimit[];
}

interface ConclusionSelection extends AssessmentSelection {
  expectation_kind: 'requirement' | 'decision';
  expectation_id: string;
  expectation_revision_id: string;
  conclusion: string;
  write_sequence: number;
}

const inputKey = (input: InputIdentity) => `${input.kind}\0${input.identity}`;

/**
 * The assessments that named one of these expectation revisions, or selected one of these inputs.
 *
 * The expectation side is an index seek. The input side is not: an assessment's selected inputs
 * are one JSON column with nothing indexing them, so this reads the assessments that identified
 * software at all and compares their inputs here, and says so. Adding a column for it is a schema
 * change this slice does not make.
 */
export function readProjectAssessmentsNaming(
  view: ProjectReadView,
  input: {
    readonly expectations: readonly ExpectationRevisionRef[];
    readonly inputs: readonly InputIdentity[];
  },
  request: KnowledgeReadRequest
): ProjectConsequenceAssessments {
  const found = new Map<string, ProjectConsequenceAssessment>();
  const later = new Set<string>();
  const limits: ProjectConsequenceLimit[] = [];
  for (const expectation of input.expectations) {
    const rows = view.all<ConclusionSelection>(
      `SELECT ${assessmentColumns('a')}, c.expectation_kind, c.expectation_id,
         c.expectation_revision_id, c.conclusion, o.committed_write_sequence AS write_sequence
         FROM knowledge_assessment_conclusions c
         JOIN knowledge_assessments a ON a.assessment_id=c.assessment_id
         JOIN operations o ON o.operation_id=a.operation_id
        WHERE c.expectation_kind=? AND c.expectation_id=? AND c.expectation_revision_id=?
        ORDER BY o.committed_write_sequence, a.assessment_id`,
      expectation.kind,
      expectation.entity_id,
      expectation.revision_id
    );
    for (const row of rows) {
      if (row.write_sequence > request.knowledge_boundary) {
        later.add(row.assessment_id);
        continue;
      }
      found.set(`expectation\0${row.assessment_id}\0${expectation.revision_id}`, {
        assessment: decodeAssessment(view, row),
        reached: 'expectation',
        expectation: {
          kind: row.expectation_kind,
          entity_id: row.expectation_id,
          revision_id: row.expectation_revision_id,
        },
        conclusion: row.conclusion,
        input: null,
        writeSequence: row.write_sequence,
      });
    }
  }
  if (input.inputs.length > 0) {
    const asked = new Map(input.inputs.map((entry) => [inputKey(entry), entry]));
    const rows = view.all<AssessmentSelection & { write_sequence: number }>(
      `SELECT ${assessmentColumns('a')}, o.committed_write_sequence AS write_sequence
         FROM knowledge_assessments a JOIN operations o ON o.operation_id=a.operation_id
        WHERE a.implementation_kind='selected' ORDER BY a.assessment_id`
    );
    limits.push({
      kind: 'selected_inputs_not_indexed',
      detail:
        `An assessment's selected inputs are one JSON column with no index over them, so the ` +
        `${rows.length} assessment(s) that identified software were read and compared here. ` +
        `Assessments that identified none cannot name an input and were not read.`,
    });
    for (const row of rows) {
      const inputs = JSON.parse(row.implementation_inputs_json ?? '[]') as InputIdentity[];
      for (const held of inputs) {
        const match = asked.get(inputKey(held));
        if (match === undefined) continue;
        if (row.write_sequence > request.knowledge_boundary) {
          later.add(row.assessment_id);
          continue;
        }
        found.set(`selected_input\0${row.assessment_id}\0${inputKey(held)}`, {
          assessment: decodeAssessment(view, row),
          reached: 'selected_input',
          expectation: null,
          conclusion: null,
          input: match,
          writeSequence: row.write_sequence,
        });
      }
    }
  }
  return {
    assessments: [...found.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([, entry]) => entry),
    later: [...later].sort(),
    limits,
  };
}

// ── code associations ────────────────────────────────────────────────────────

export interface ProjectCodeAssociation {
  readonly artifactId: string;
  /** The path the artifact recorded a touch of. */
  readonly filePath: string;
  /** The path or pattern the caller asked about. */
  readonly asked: string;
  /** True when the recorded path is the one asked about, rather than a pattern it matched. */
  readonly recordedTouch: boolean;
}

export interface ProjectCodeAssociations {
  readonly asked: string;
  readonly associations: readonly ProjectCodeAssociation[];
  readonly limits: readonly ProjectConsequenceLimit[];
}

/**
 * The artifacts that recorded a touch of this path, and the artifacts whose recorded paths match
 * it as a pattern, kept apart.
 *
 * An exact recorded path is a touch this history retained. A pattern match is this reader's own
 * inference about which recorded paths the caller meant, and the two must not read alike. A path
 * no artifact recorded is a limit — the store holds no association for it — and never an answer
 * that nothing depends on the file.
 */
export function readProjectArtifactsTouching(
  view: ProjectReadView,
  asked: string
): ProjectCodeAssociations {
  const exact = view.all<{ artifact_id: string; file_path: string }>(
    'SELECT artifact_id, file_path FROM artifact_touched_files WHERE file_path=? ORDER BY artifact_id',
    asked
  );
  const matched = view.all<{ artifact_id: string; file_path: string }>(
    `SELECT artifact_id, file_path FROM artifact_touched_files
      WHERE file_path<>? AND orcaops_history_touching(file_path, ?)=1
      ORDER BY artifact_id, file_path`,
    asked,
    asked
  );
  const associations = [
    ...exact.map((row) => ({
      artifactId: row.artifact_id,
      filePath: row.file_path,
      asked,
      recordedTouch: true,
    })),
    ...matched.map((row) => ({
      artifactId: row.artifact_id,
      filePath: row.file_path,
      asked,
      recordedTouch: false,
    })),
  ];
  return {
    asked,
    associations,
    limits:
      associations.length > 0
        ? []
        : [
            {
              kind: 'no_code_association',
              detail:
                `No artifact of this history recorded a touch of \`${asked}\`, and no recorded ` +
                `path matches it as a pattern. The store holds no association for that code, ` +
                `which is not the same as nothing depending on it.`,
            },
          ],
  };
}

export interface ProjectArtifactPlanEvent {
  readonly artifactId: string;
  readonly planEventId: string;
}

/**
 * The plan events of these artifacts, in the order they were appended. An artifact a code
 * association reached is a dead end without them: a task's uses are keyed to its plan event, so
 * this is how a changed file leads on to the expectations the work was planned against.
 */
export function readProjectPlanEventsOf(
  view: ProjectReadView,
  artifactIds: readonly string[]
): ProjectArtifactPlanEvent[] {
  return distinctSorted(artifactIds).flatMap((artifactId) =>
    view
      .all<{
        event_id: string;
      }>(
        `SELECT event_id FROM artifact_events WHERE artifact_id=?
           AND event_type IN ('plan_captured','plan_revised') ORDER BY ordinal`,
        artifactId
      )
      .map((row) => ({ artifactId, planEventId: row.event_id }))
  );
}

/**
 * The paths these artifacts recorded a touch of. Each artifact is asked for on its own, because
 * the touched-file table is keyed by artifact first and that is the seek this read wants.
 */
export function readProjectFilesTouchedBy(
  view: ProjectReadView,
  artifactIds: readonly string[]
): ProjectCodeAssociation[] {
  return distinctSorted(artifactIds).flatMap((artifactId) =>
    view
      .all<{
        file_path: string;
      }>(
        'SELECT file_path FROM artifact_touched_files WHERE artifact_id=? ORDER BY file_path',
        artifactId
      )
      .map((row) => ({
        artifactId,
        filePath: row.file_path,
        asked: artifactId,
        recordedTouch: true,
      }))
  );
}

// ── shared subjects ──────────────────────────────────────────────────────────

export interface ProjectSubjectNeighbour {
  readonly subjectId: string;
  /** The revision whose subject this is. */
  readonly of: RecordRevisionRef;
  readonly identity: KnowledgeTarget;
}

export interface ProjectSubjectNeighbours {
  readonly neighbours: readonly ProjectSubjectNeighbour[];
  readonly limits: readonly ProjectConsequenceLimit[];
}

const SUBJECT_OF_REQUIREMENT_REVISIONS = `SELECT revision_id, requirement_id AS entity_id, subject_id
  FROM requirement_revisions WHERE revision_id IN`;
const SUBJECT_OF_DECISION_REVISIONS = `SELECT revision_id, decision_id AS entity_id, subject_id
  FROM decision_revisions WHERE revision_id IN`;

const REQUIREMENTS_OF_SUBJECT = `SELECT DISTINCT requirement_id FROM requirement_revisions
  WHERE subject_id=? ORDER BY requirement_id`;

/**
 * The requirements some revision of which names the same subject as one of these revisions.
 *
 * A shared subject is not a recorded link between two records — it says the two are about the same
 * area — so what this returns is a candidate the caller must mark inferred. Only requirements are
 * reached: a decision and a claim record a subject with no index over it, exactly as a subject
 * lookup already reports, and scanning every revision for one is not a read this makes.
 */
export function readProjectIdentitiesSharingSubject(
  view: ProjectReadView,
  revisions: readonly RecordRevisionRef[]
): ProjectSubjectNeighbours {
  const requirements = distinctSorted(
    revisions.filter((entry) => entry.kind === 'requirement').map((entry) => entry.revision_id)
  );
  const decisions = distinctSorted(
    revisions.filter((entry) => entry.kind === 'decision').map((entry) => entry.revision_id)
  );
  const subjects: { revision: RecordRevisionRef; subjectId: string }[] = [];
  for (const [query, kind, ids] of [
    [SUBJECT_OF_REQUIREMENT_REVISIONS, 'requirement', requirements],
    [SUBJECT_OF_DECISION_REVISIONS, 'decision', decisions],
  ] as const) {
    if (ids.length === 0) continue;
    for (const row of view.all<{
      revision_id: string;
      entity_id: string;
      subject_id: string | null;
    }>(`${query} (${placeholders(ids)}) ORDER BY revision_id`, ...ids))
      if (row.subject_id !== null)
        subjects.push({
          revision: {
            kind,
            entity_id: row.entity_id,
            revision_id: row.revision_id,
          } as RecordRevisionRef,
          subjectId: row.subject_id,
        });
  }
  const neighbours: ProjectSubjectNeighbour[] = [];
  for (const { revision, subjectId } of subjects)
    for (const row of view.all<{ requirement_id: string }>(REQUIREMENTS_OF_SUBJECT, subjectId)) {
      if (row.requirement_id === revision.entity_id) continue;
      neighbours.push({
        subjectId,
        of: revision,
        identity: { kind: 'requirement', entity_id: row.requirement_id },
      });
    }
  return {
    neighbours,
    limits:
      subjects.length === 0
        ? []
        : [
            {
              kind: 'subject_index_only',
              detail:
                'Identities sharing a subject are reached through the subject index on ' +
                'requirement revisions. Decisions and claims record a subject with no index over ' +
                'it, so records of those kinds naming the same subject were not looked for.',
            },
          ],
  };
}

// ── what moved after a boundary ──────────────────────────────────────────────

export interface ProjectStandingMove {
  readonly revision: RecordRevisionRef;
  /** The act that moved it: an adoption, a correction, or an established replacement. */
  readonly because: 'adoption' | 'correction' | 'replacement';
  readonly actId: string;
  readonly writeSequence: number;
}

export interface ProjectStandingMoves {
  readonly since: number;
  readonly moves: readonly ProjectStandingMove[];
  readonly limits: readonly ProjectConsequenceLimit[];
}

/**
 * The exact revisions whose recorded standing an act moved after a boundary: an adoption, a
 * correction that changed what stands, or an established replacement.
 *
 * Nothing indexes an operation's write sequence, so each of the three acts is read in full and
 * filtered here. The read is bounded by `maxMoves` and says what it cost; a truncated sweep is a
 * named limit rather than a shorter list of identities to traverse.
 */
export function readProjectStandingMovedSince(
  view: ProjectReadView,
  since: number,
  request: KnowledgeReadRequest,
  bounds: { readonly maxMoves: number }
): ProjectStandingMoves {
  const rows = [
    ...view
      .all<{
        act_id: string;
        target_kind: string;
        target_id: string;
        target_revision_id: string;
        write_sequence: number;
      }>(
        `SELECT s.adoption_id AS act_id, s.target_kind, s.target_id, s.target_revision_id,
           o.committed_write_sequence AS write_sequence
           FROM adoptions s JOIN operations o ON o.operation_id=s.operation_id`
      )
      .map((row) => ({ ...row, because: 'adoption' as const })),
    ...view
      .all<{
        act_id: string;
        target_kind: string;
        target_id: string;
        target_revision_id: string;
        write_sequence: number;
      }>(
        `SELECT t.action_id AS act_id, t.target_kind, t.target_id, t.target_revision_id,
           o.committed_write_sequence AS write_sequence
           FROM correction_targets t
           JOIN correction_actions a ON a.action_id=t.action_id
           JOIN operations o ON o.operation_id=t.operation_id
          WHERE a.changed_what_stands=1`
      )
      .map((row) => ({ ...row, because: 'correction' as const })),
    ...view
      .all<{
        act_id: string;
        target_kind: string;
        target_id: string;
        target_revision_id: string;
        write_sequence: number;
      }>(
        `SELECT r.relationship_id AS act_id, r.to_entity_kind AS target_kind,
           r.to_entity_id AS target_id, r.to_revision_id AS target_revision_id,
           o.committed_write_sequence AS write_sequence
           FROM record_relationships r JOIN operations o ON o.operation_id=r.operation_id
          WHERE r.relation='supersedes' AND r.standing='established'`
      )
      .map((row) => ({ ...row, because: 'replacement' as const })),
  ]
    .filter((row) => row.write_sequence > since && row.write_sequence <= request.knowledge_boundary)
    .sort(
      (left, right) =>
        left.write_sequence - right.write_sequence || (left.act_id < right.act_id ? -1 : 1)
    );
  const moves = rows.slice(0, bounds.maxMoves).map((row) => ({
    revision: {
      kind: row.target_kind,
      entity_id: row.target_id,
      revision_id: row.target_revision_id,
    } as RecordRevisionRef,
    because: row.because,
    actId: row.act_id,
    writeSequence: row.write_sequence,
  }));
  const limits: ProjectConsequenceLimit[] = [
    {
      kind: 'standing_sweep_unindexed',
      detail:
        `Nothing indexes the write sequence an operation committed at, so the adoptions, ` +
        `corrections and established replacements of this history were read in full and ` +
        `filtered to the ${rows.length} act(s) after write sequence ${since}.`,
    },
  ];
  if (rows.length > moves.length)
    limits.push({
      kind: 'standing_moves_truncated',
      detail:
        `${rows.length - moves.length} act(s) that moved a revision's standing after write ` +
        `sequence ${since} were not traversed: this answer follows at most ${bounds.maxMoves}, ` +
        `oldest first.`,
    });
  return { since, moves, limits };
}
