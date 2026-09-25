// The knowledge boundary every read here is taken at, and what each reader says about the records
// it could not state.
//
// A boundary is a write sequence — the committing operation's `committed_write_sequence`, which is
// what `knowledgeRecordsOf` puts on every record it returns. `knowledgeBoundaryAt` reads what "now"
// is. Nothing defaults a boundary: a read that quietly picked its own would answer a question
// nobody asked, and the answer would not say which one. The caller names a sequence or asks for
// now, and a sequence later than the committed one is refused rather than read as now, because a
// caller asking about records this store has not published is asking about something else.
import { type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { invalid } from './knowledge-record-input.js';
import type {
  ApplicabilityInputs,
  Attribution,
  AuthorityScope,
} from '../../schema/knowledge-contract.js';
import type {
  BranchScopedRow,
  KnowledgeReadRequest,
  LaterKnowledgeRecord,
  ResolutionOmission,
  ResolvedKnowledge,
  RevisionStanding,
  SelectedImplementation,
  UnresolvedPoint,
} from '../../schema/knowledge-resolution.js';

const COMMITTED = 'SELECT write_sequence FROM project_counters WHERE singleton = 1';

/** The write sequence of the newest committed operation: what "now" is for a read. */
export function knowledgeBoundaryAt(view: ProjectReadView): number {
  const row = view.get<{ write_sequence: number }>(COMMITTED);
  if (row === null || !Number.isSafeInteger(row.write_sequence) || row.write_sequence < 0)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The project write sequence is missing or outside the safe integer range; explicit repair is required'
    );
  return row.write_sequence;
}

/** A write sequence, or `now` for whatever is committed when the read is taken. */
export type KnowledgeBoundary = number | 'now';

export interface KnowledgeReadAt {
  readonly scope: AuthorityScope;
  readonly mode: 'current' | 'historical';
  readonly boundary: KnowledgeBoundary;
  /** The exact implementation identity this read is about, or its explicit absence. */
  readonly implementation?: SelectedImplementation;
  /** A dimension nobody supplies stays unresolved, never waived and never assumed met. */
  readonly applicability?: ApplicabilityInputs;
  /** `null` leaves a time-ended exception unresolved rather than assuming now. */
  readonly exceptionsJudgedAt?: string | null;
  readonly exceptionConditions?: Readonly<Record<string, boolean>>;
  /** Who the read is for, which only an assignment reads. */
  readonly acting?: Attribution | null;
}

export function knowledgeReadRequest(
  view: ProjectReadView,
  at: KnowledgeReadAt
): KnowledgeReadRequest {
  const committed = knowledgeBoundaryAt(view);
  if (at.boundary !== 'now') {
    if (!Number.isSafeInteger(at.boundary) || at.boundary < 0)
      invalid('A knowledge boundary is a write sequence: a whole number no smaller than zero');
    if (at.boundary > committed)
      invalid(
        'A knowledge boundary later than the committed write sequence names records this history has not published; read at the current boundary instead'
      );
  }
  return {
    scope: at.scope,
    mode: at.mode,
    knowledge_boundary: at.boundary === 'now' ? committed : at.boundary,
    implementation: at.implementation ?? { kind: 'none_selected' },
    applicability: at.applicability ?? {},
    exceptions_judged_at: at.exceptionsJudgedAt ?? null,
    exception_conditions: at.exceptionConditions ?? {},
    ...(at.acting === undefined ? {} : { acting: at.acting }),
  };
}

/** The write sequence each of these operations committed at, for rows that carry an operation id. */
export function writeSequencesOf(
  view: ProjectReadView,
  operationIds: readonly string[]
): Map<string, number> {
  const asked = [...new Set(operationIds)];
  if (asked.length === 0) return new Map();
  return new Map(
    view
      .all<{
        operation_id: string;
        committed_write_sequence: number;
      }>(
        `SELECT operation_id, committed_write_sequence FROM operations
         WHERE operation_id IN (${asked.map(() => '?').join(',')})`,
        ...asked
      )
      .map((row) => [row.operation_id, row.committed_write_sequence])
  );
}

/**
 * What the governing state says about one revision, from the entries the resolver returned for it.
 * `departed` is an entry that stands where it was adopted and not in this read, which is what an
 * act in a narrower scope on an informed instruction leaves behind.
 */
export type RevisionGoverningStanding = 'adopted' | 'background' | 'departed' | 'not_standing';

const PRECEDENCE: readonly RevisionGoverningStanding[] = [
  'adopted',
  'background',
  'departed',
  'not_standing',
];

const standingOfEntry = (entry: RevisionStanding): RevisionGoverningStanding => {
  if (entry.standing !== 'stands') return 'not_standing';
  if (entry.departed_in_scope.length > 0) return 'departed';
  return entry.designation === 'adopted' ? 'adopted' : 'background';
};

export interface RevisionGoverningState {
  readonly standing: RevisionGoverningStanding;
  /** Every entry the resolver returned for the revision, one per scope it was acted on in. */
  readonly entries: readonly RevisionStanding[];
  /** False when the store held no readable revision record, so nothing but its standing is known. */
  readonly supplied: boolean;
}

export function revisionGoverningState(
  resolved: ResolvedKnowledge,
  revisionId: string
): RevisionGoverningState {
  const entries = resolved.revisions.filter((entry) => entry.revision.revision_id === revisionId);
  let standing: RevisionGoverningStanding = 'not_standing';
  for (const entry of entries)
    if (PRECEDENCE.indexOf(standingOfEntry(entry)) < PRECEDENCE.indexOf(standing))
      standing = standingOfEntry(entry);
  return {
    standing,
    entries,
    // The resolver leaves every described field null for a revision it was not given, so one
    // non-null source standing is what says the record itself was read.
    supplied: entries.some((entry) => entry.source_standing !== null),
  };
}

/**
 * What a read was taken at and what it left out. Omissions, unresolved points, records published
 * after the boundary and branch-scoped rows are the resolver's own, in its own vocabulary, so no
 * surface has to learn a second one.
 */
export interface KnowledgeReadCoverage {
  readonly scope: AuthorityScope;
  readonly mode: 'current' | 'historical';
  readonly boundary: number;
  readonly omitted: readonly ResolutionOmission[];
  readonly unresolved: readonly UnresolvedPoint[];
  readonly later: readonly LaterKnowledgeRecord[];
  readonly branchScoped: readonly BranchScopedRow[];
}

const distinct = <T>(entries: readonly T[], key: (entry: T) => string): T[] => {
  const kept = new Map<string, T>();
  for (const entry of entries) if (!kept.has(key(entry))) kept.set(key(entry), entry);
  return [...kept.values()];
};

/**
 * One coverage statement over every identity a reader resolved. A reader that resolves several
 * identities reports each one's omissions once, so a record left out of one answer is not hidden by
 * another answer that never named it.
 */
export function knowledgeReadCoverage(
  request: KnowledgeReadRequest,
  answers: readonly ResolvedKnowledge[],
  extraUnresolved: readonly UnresolvedPoint[] = []
): KnowledgeReadCoverage {
  return {
    scope: request.scope,
    mode: request.mode,
    boundary: request.knowledge_boundary,
    omitted: distinct(
      answers.flatMap((answer) => answer.omissions),
      (entry) => JSON.stringify([entry.record, entry.record_id, entry.reason])
    ),
    unresolved: distinct(
      [...answers.flatMap((answer) => answer.unresolved), ...extraUnresolved],
      (entry) => JSON.stringify([entry.about, entry.reason, entry.record_ids])
    ),
    later: distinct(
      answers.flatMap((answer) => answer.later_annotations),
      (entry) => JSON.stringify([entry.record, entry.record_id])
    ),
    branchScoped: distinct(
      answers.flatMap((answer) => answer.branch_scoped),
      (entry) => entry.record_id
    ),
  };
}
