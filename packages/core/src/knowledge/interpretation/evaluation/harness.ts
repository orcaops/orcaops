import type { LlmProvider } from '@orcaops/llm';
import {
  type AuthorityScope,
  canonicalJson,
  type CorrectionAction,
  type InterpretationTarget,
  isProposingCorrection,
  type RecordRevisionRef,
} from '@orcaops/storage';

import type { ByteSpan } from '../bytes.js';
import { spansOverlap } from '../bytes.js';
import type { InterpretationManifest } from '../manifest.js';
import {
  buildReconciliationPlan,
  type PublishableRecord,
  type ReconciliationPlan,
} from '../reconciliation.js';
import {
  buildInterpretationRequest,
  type InterpretationAttemptRequest,
  type PreparedInputMeasure,
} from '../request.js';
import { CITATION_RULES, type ProposalFailure, validateProposal } from '../validation.js';

export type ProposerAnswer =
  | { status: 'answered'; body: string }
  | { status: 'failed'; code: string; message: string };

/** Anything that turns a request into an answer: a script, a fake provider, a model. */
export type Proposer = (request: InterpretationAttemptRequest) => Promise<ProposerAnswer>;

export interface ExpectedPassage extends ByteSpan {
  source_id?: string;
  record: 'requirement' | 'decision' | 'claim';
  alternate_spans?: readonly (ByteSpan & { source_id?: string })[];
}

export interface ExpectedReuse {
  kind: 'requirement' | 'decision';
  entity_id: string;
}

/** A passage that states an existing revision word for word, and whose lineage. */
export interface ExpectedRestatement extends ByteSpan {
  source_id?: string;
  kind: 'requirement' | 'decision' | 'claim';
  entity_id: string;
  alternate_spans?: readonly (ByteSpan & { source_id?: string })[];
}

export interface ExpectedCorrection {
  kind: CorrectionAction['kind'];
  targets: readonly RecordRevisionRef[];
}

export interface ExpectedOutcome {
  /** Passages a correct answer turns into a candidate, with the kind each takes. */
  published: readonly ExpectedPassage[];
  /** The only existing lineages this source may continue. Any other is a false merge. */
  reuse: readonly ExpectedReuse[];
  /** The only passages this source restates, and what each of them restates. */
  restated: readonly ExpectedRestatement[];
  /** Passages that must never become a continuing requirement, decision or claim. */
  never_published: readonly (ByteSpan & { source_id?: string })[];
  corrections?: readonly ExpectedCorrection[];
  /** Exact revisions a detector may propose as semantic equivalents. */
  equivalences?: readonly InterpretationTarget[];
}

export interface EvaluationCase {
  name: string;
  /** Synthetic fixture input before deterministic preparation or unit selection. */
  source_text: string;
  manifest: InterpretationManifest;
  source_scope?: AuthorityScope;
  expected: ExpectedOutcome;
}

/**
 * Five counts, never one number. They answer different questions — did it merge
 * two obligations, did it give something standing it may not give, did it cite
 * what is not there, did it miss what is there, and did it record what nobody
 * asked for — and averaging them would let a false merge be paid for by a lucky
 * extraction. The last exists because zero merges and zero promotions is what a
 * proposer that answers nothing scores, and a proposer that makes every sentence
 * a requirement can buy it too.
 */
export interface EvaluationCounts {
  false_merges: number;
  incorrect_equivalences: number;
  missed_equivalences: number;
  unauthorized_promotions: number;
  unsupported_citations: number;
  missed_statements: number;
  unexpected_records: number;
}

export interface CaseOutcome {
  name: string;
  answered: boolean;
  /** True when validation refused the whole answer as untrustworthy. */
  rejected: boolean;
  plan: ReconciliationPlan | null;
  failures: readonly ProposalFailure[];
  counts: EvaluationCounts;
  notes: readonly string[];
}

export interface EvaluationReport {
  cases: readonly CaseOutcome[];
  counts: EvaluationCounts;
  answered: number;
  rejected: number;
}

export interface EvaluationOptions {
  provider: LlmProvider;
  measure: PreparedInputMeasure;
  processed_at: string;
  /** The time the evaluated sources were recorded at, which their records keep. */
  source_recorded_at: string;
}

const NONE: EvaluationCounts = {
  false_merges: 0,
  incorrect_equivalences: 0,
  missed_equivalences: 0,
  unauthorized_promotions: 0,
  unsupported_citations: 0,
  missed_statements: 0,
  unexpected_records: 0,
};

export async function runEvaluation(
  proposer: Proposer,
  cases: readonly EvaluationCase[],
  options: EvaluationOptions
): Promise<EvaluationReport> {
  const outcomes: CaseOutcome[] = [];
  for (const evaluated of cases) {
    outcomes.push(await runCase(proposer, evaluated, options));
  }
  return {
    cases: outcomes,
    counts: outcomes.reduce((total, outcome) => add(total, outcome.counts), NONE),
    answered: outcomes.filter((outcome) => outcome.answered).length,
    rejected: outcomes.filter((outcome) => outcome.rejected).length,
  };
}

export async function runCase(
  proposer: Proposer,
  evaluated: EvaluationCase,
  options: EvaluationOptions
): Promise<CaseOutcome> {
  const request = buildInterpretationRequest(evaluated.manifest, options);
  const answer = await proposer(request);
  if (answer.status === 'failed') {
    const scored = scoreCase({
      expected: evaluated.expected,
      manifest: evaluated.manifest,
      plan: null,
      failures: [],
    });
    return {
      name: evaluated.name,
      answered: false,
      rejected: false,
      plan: null,
      failures: [],
      counts: scored.counts,
      notes: [`the proposer failed: ${answer.code} ${answer.message}`, ...scored.notes],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch (err) {
    parsed = { unparseable: err instanceof Error ? err.message : String(err) };
  }
  const validation = validateProposal({ manifest: evaluated.manifest, answer: parsed });
  const plan =
    validation.outcome === 'accepted'
      ? buildReconciliationPlan({
          manifest: evaluated.manifest,
          validated: validation.validated,
          processed_at: options.processed_at,
          source_recorded_at: options.source_recorded_at,
        })
      : null;
  const scored = scoreCase({
    expected: evaluated.expected,
    manifest: evaluated.manifest,
    plan,
    failures: validation.failures,
  });
  return {
    name: evaluated.name,
    answered: true,
    rejected: validation.outcome === 'rejected',
    plan,
    failures: validation.failures,
    counts: scored.counts,
    notes: scored.notes,
  };
}

/**
 * Score one plan against what the case expects. Separate from the run so a
 * hand-built plan can be scored directly, which is how the counts are shown to
 * move independently of one another.
 */
export function scoreCase(input: {
  expected: ExpectedOutcome;
  manifest: InterpretationManifest;
  plan: ReconciliationPlan | null;
  failures: readonly ProposalFailure[];
}): { counts: EvaluationCounts; notes: string[] } {
  const { expected, manifest, plan } = input;
  const notes: string[] = [];
  const counts: EvaluationCounts = { ...NONE };

  const invalidEvidence = (failure: ProposalFailure) =>
    failure.item.kind === 'citation' || CITATION_RULES.includes(failure.rule);
  counts.unsupported_citations = input.failures.filter(invalidEvidence).length;
  for (const failure of input.failures) {
    if (invalidEvidence(failure)) notes.push(`${failure.rule}: ${failure.detail}`);
  }

  const records = plan?.records ?? [];
  const proposedEquivalences = records.flatMap((record) =>
    record.kind === 'interpretation' &&
    record.record.canonical_outcome.kind === 'proposed_equivalence'
      ? [record.record.canonical_outcome.target]
      : []
  );
  const equivalenceMatches = matchOneToOne(
    expected.equivalences ?? [],
    proposedEquivalences,
    (want, found) => canonicalJson(want) === canonicalJson(found)
  );
  proposedEquivalences.forEach((target, index) => {
    if (equivalenceMatches.actual.has(index)) return;
    counts.incorrect_equivalences += 1;
    notes.push(
      `an interpretation proposed unsupported equivalence to ${target.kind} revision ${target.revision_id}`
    );
  });
  (expected.equivalences ?? []).forEach((target, index) => {
    if (equivalenceMatches.expected.has(index)) return;
    counts.missed_equivalences += 1;
    notes.push(
      `no interpretation proposed equivalence to ${target.kind} revision ${target.revision_id}`
    );
  });
  const published = records.flatMap((record) => publishedExpectation(record, records) ?? []);
  const publicationMatches = matchOneToOne(
    expected.published,
    published,
    (want, found) => want.record === found.kind && matchesPassage(want, found.passages)
  );

  for (const [index, record] of published.entries()) {
    // Three different questions about one published record. A promotion is a
    // passage the case says is NOT a lasting obligation becoming one, or
    // becoming the wrong kind of one. An unexpected record is anything the
    // case's `published` does not name, which includes every promotion and also
    // an extra candidate over a passage nobody judged. A merge is about which
    // lineage it continued, and is deliberately not made a promotion too, or the
    // two could never move apart.
    if (!publicationMatches.actual.has(index)) {
      counts.unexpected_records += 1;
      notes.push(
        `a ${record.kind} was published from ${passagesLabel(record.passages)}, without a distinct complete expected statement`
      );
    }
    const forbidden = expected.never_published.find((span) =>
      record.passages.some(
        (passage) =>
          (span.source_id === undefined || span.source_id === passage.source_id) &&
          spansOverlap(span, passage)
      )
    );
    const wrongKind = expected.published.find(
      (want) =>
        [want, ...(want.alternate_spans ?? [])].some((span) =>
          record.passages.some(
            (passage) =>
              (span.source_id === undefined || span.source_id === passage.source_id) &&
              spansOverlap(span, passage)
          )
        ) && want.record !== record.kind
    );
    if (forbidden !== undefined) {
      counts.unauthorized_promotions += 1;
      notes.push(
        `bytes ${forbidden.start}-${forbidden.end} became a ${record.kind}, which they may never be`
      );
    } else if (wrongKind !== undefined) {
      counts.unauthorized_promotions += 1;
      notes.push(
        `bytes ${wrongKind.start}-${wrongKind.end} became a ${record.kind} where the source states a ${wrongKind.record}`
      );
    }
    if (record.continues !== null) {
      const allowed = expected.reuse.some(
        (want) => want.kind === record.kind && want.entity_id === record.entity_id
      );
      if (!allowed) {
        counts.false_merges += 1;
        notes.push(
          `the plan continued ${record.kind} ${record.entity_id}, a lineage this source does not restate`
        );
      }
    }
  }

  for (const [index, want] of expected.published.entries()) {
    if (!publicationMatches.expected.has(index)) {
      counts.missed_statements += 1;
      notes.push(`no ${want.record} was published from bytes ${want.start}-${want.end}`);
    }
  }
  for (const want of expected.reuse) {
    const found = published.some(
      (record) =>
        record.kind === want.kind &&
        record.entity_id === want.entity_id &&
        record.continues !== null
    );
    if (!found) {
      counts.missed_statements += 1;
      notes.push(`${want.kind} ${want.entity_id} was not continued`);
    }
  }

  // A restatement gives nothing standing, so an unasked-for one is an
  // unexpected record and never a promotion. Recording a repetition as a
  // revision instead is counted where it lands: a candidate no expectation
  // names, continuing a lineage the case does not say this source continues.
  const restated = records.flatMap((record) =>
    record.kind === 'passage_restatement'
      ? [
          {
            revision: record.record.restates,
            passage: passageSpan(record.record.passage.location, record.record.passage.source_id),
          },
        ]
      : []
  );
  const sameRestatement = (want: ExpectedRestatement, found: (typeof restated)[number]) =>
    want.kind === found.revision.kind &&
    want.entity_id === found.revision.entity_id &&
    matchesPassage(want, [found.passage]);
  const restatementMatches = matchOneToOne(expected.restated, restated, sameRestatement);
  for (const [index, found] of restated.entries()) {
    if (restatementMatches.actual.has(index)) continue;
    counts.unexpected_records += 1;
    notes.push(
      `bytes ${found.passage.start}-${found.passage.end} were recorded as restating ` +
        `${found.revision.kind} ${found.revision.entity_id}, which no expectation names`
    );
  }
  for (const [index, want] of expected.restated.entries()) {
    if (restatementMatches.expected.has(index)) continue;
    counts.missed_statements += 1;
    notes.push(`bytes ${want.start}-${want.end} did not restate ${want.kind} ${want.entity_id}`);
  }

  const corrections = records.flatMap((record) =>
    record.kind === 'correction' ? [record.record] : []
  );
  const wantedCorrections = expected.corrections ?? [];
  const targetsKey = (targets: readonly RecordRevisionRef[]) =>
    canonicalJson([...new Set(targets.map((target) => canonicalJson(target)))].sort());
  const correctionMatches = matchOneToOne(
    wantedCorrections,
    corrections,
    (want, found) =>
      want.kind === found.kind && targetsKey(want.targets) === targetsKey(found.targets)
  );
  for (const [index, found] of corrections.entries()) {
    if (correctionMatches.actual.has(index)) continue;
    counts.unexpected_records += 1;
    notes.push(`unexpected correction kind ${found.kind} for targets ${targetsKey(found.targets)}`);
  }
  for (const [index, want] of wantedCorrections.entries()) {
    if (correctionMatches.expected.has(index)) continue;
    counts.missed_statements += 1;
    notes.push(`missing correction kind ${want.kind} for targets ${targetsKey(want.targets)}`);
  }

  for (const record of records) {
    for (const note of standingBeyondADetector(record, manifest)) {
      counts.unauthorized_promotions += 1;
      notes.push(note);
    }
  }
  return { counts, notes };
}

interface PublishedExpectation {
  kind: 'requirement' | 'decision' | 'claim';
  entity_id: string;
  passages: readonly ActualPassage[];
  /** The revision this one continues, or null when the identity is new. */
  continues: string | null;
}

function publishedExpectation(
  record: PublishableRecord,
  records: readonly PublishableRecord[]
): PublishedExpectation | null {
  const passages =
    record.kind === 'requirement_revision' ||
    record.kind === 'decision_revision' ||
    record.kind === 'claim_revision'
      ? interpretedStatementPassages(record.record, records)
      : [];
  if (record.kind === 'requirement_revision') {
    return {
      kind: 'requirement',
      entity_id: record.record.requirement_id,
      passages,
      continues: record.record.previous_revision_id,
    };
  }
  if (record.kind === 'decision_revision') {
    return {
      kind: 'decision',
      entity_id: record.record.decision_id,
      passages,
      continues: record.record.previous_revision_id,
    };
  }
  if (record.kind === 'claim_revision') {
    return {
      kind: 'claim',
      entity_id: record.record.claim_id,
      passages,
      continues: record.record.previous_revision_id,
    };
  }
  return null;
}

function interpretedStatementPassages(
  revision: Extract<
    PublishableRecord,
    { kind: 'requirement_revision' | 'decision_revision' | 'claim_revision' }
  >['record'],
  records: readonly PublishableRecord[]
): ActualPassage[] {
  const support = revision.interpretation;
  if (support === null || support === undefined) {
    return revision.passages.map((passage) => passageSpan(passage.location, passage.source_id));
  }
  const interpretation = records.find(
    (record) =>
      record.kind === 'interpretation' &&
      record.record.interpretation_id === support.interpretation_id
  );
  if (interpretation?.kind !== 'interpretation') return [];
  const rationalePositions = new Set(
    interpretation.record.rationale.kind === 'stated'
      ? interpretation.record.rationale.evidence_positions
      : []
  );
  return interpretation.record.evidence.flatMap((evidence, index) =>
    rationalePositions.has(index)
      ? []
      : [
          {
            source_id: evidence.source_id,
            start: evidence.prepared_start_utf8,
            end: evidence.prepared_end_utf8,
          },
        ]
  );
}

interface ActualPassage extends ByteSpan {
  source_id: string;
}

function matchesPassage(
  expected: ByteSpan & {
    source_id?: string;
    alternate_spans?: readonly (ByteSpan & { source_id?: string })[];
  },
  actual: readonly ActualPassage[]
): boolean {
  return [expected, ...(expected.alternate_spans ?? [])].some((want) =>
    actual.some(
      (found) =>
        (want.source_id === undefined || want.source_id === found.source_id) &&
        want.start === found.start &&
        want.end === found.end
    )
  );
}

function passagesLabel(passages: readonly ActualPassage[]): string {
  return (
    passages
      .map((passage) => `${passage.source_id} bytes ${passage.start}-${passage.end}`)
      .join(', ') || 'no cited bytes'
  );
}

function matchOneToOne<E, A>(
  expected: readonly E[],
  actual: readonly A[],
  matches: (expected: E, actual: A) => boolean
) {
  const owner = new Map<number, number>();
  const assign = (expectedIndex: number, seen: Set<number>): boolean => {
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex++) {
      if (seen.has(actualIndex) || !matches(expected[expectedIndex], actual[actualIndex])) continue;
      seen.add(actualIndex);
      const previous = owner.get(actualIndex);
      if (previous === undefined || assign(previous, seen)) {
        owner.set(actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  };
  // Reassign earlier matches when an alternate citation is another statement's only match.
  for (let index = 0; index < expected.length; index++) assign(index, new Set());
  return { expected: new Set(owner.values()), actual: new Set(owner.keys()) };
}

function passageSpan(location: string, source_id: string): ActualPassage {
  const match = /^(?:prepared-)?bytes:(\d+)-(\d+)$/u.exec(location);
  return match === null
    ? { source_id, start: -1, end: -1 }
    : { source_id, start: Number(match[1]), end: Number(match[2]) };
}

/** Standing no detector may give: everything here is a promotion nobody authorized. */
function standingBeyondADetector(
  record: PublishableRecord,
  manifest: InterpretationManifest
): string[] {
  const notes: string[] = [];
  const detector =
    manifest.attributed_to.kind === 'detector' ? manifest.attributed_to.detector : null;
  const attributedToTheDetector = (attribution: { kind: string; detector?: string }) =>
    attribution.kind === 'detector' && attribution.detector === detector;

  if (
    record.kind === 'requirement_revision' ||
    record.kind === 'decision_revision' ||
    record.kind === 'claim_revision'
  ) {
    const revision = record.record;
    if (!attributedToTheDetector(revision.attributed_to))
      notes.push('a revision was attributed to someone other than the detector');
    if (revision.source_standing !== 'extracted_candidate')
      notes.push(
        `a revision was recorded as ${revision.source_standing}, not an extracted candidate`
      );
  }
  if (record.kind === 'interpretation') {
    if (!attributedToTheDetector(record.record.attributed_to))
      notes.push('an interpretation was attributed to someone other than the detector');
    const encoded = canonicalJson(record.record);
    for (const forbidden of ['authorization', 'designation', 'adopted', 'selection']) {
      if (encoded.includes(`"${forbidden}"`))
        notes.push(`an interpretation carried forbidden authority field ${forbidden}`);
    }
  }
  if (record.kind === 'claim_revision' && record.record.verification !== null)
    notes.push('a claim revision carried a verification, which a detector never establishes');
  if (
    record.kind === 'passage_restatement' &&
    !attributedToTheDetector(record.record.attributed_to)
  )
    notes.push('a passage restatement was attributed to someone other than the detector');
  if (record.kind === 'relationship') {
    if (record.record.standing !== 'suggested')
      notes.push('a relationship was established rather than suggested');
    if (record.record.authorization !== null) notes.push('a relationship carried an authorization');
    if (!attributedToTheDetector(record.record.attributed_to))
      notes.push('a relationship was attributed to someone other than the detector');
  }
  if (record.kind === 'correction') {
    if (!isProposingCorrection(record.record.kind))
      notes.push(`a ${record.record.kind} changes what stands, which a detector never does`);
    if (record.record.authorization !== null) notes.push('a correction carried an authorization');
    if (!attributedToTheDetector(record.record.attributed_to))
      notes.push('a correction was attributed to someone other than the detector');
  }
  if (record.kind === 'task_use') {
    if (record.record.selection.kind !== 'connected_later')
      notes.push('a task use claimed the plan selected it');
    if (record.record.role !== 'background')
      notes.push(`a task use claimed the role ${record.record.role}`);
  }
  return notes;
}

function add(left: EvaluationCounts, right: EvaluationCounts): EvaluationCounts {
  return {
    false_merges: left.false_merges + right.false_merges,
    incorrect_equivalences: left.incorrect_equivalences + right.incorrect_equivalences,
    missed_equivalences: left.missed_equivalences + right.missed_equivalences,
    unauthorized_promotions: left.unauthorized_promotions + right.unauthorized_promotions,
    unsupported_citations: left.unsupported_citations + right.unsupported_citations,
    missed_statements: left.missed_statements + right.missed_statements,
    unexpected_records: left.unexpected_records + right.unexpected_records,
  };
}
