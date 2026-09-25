// The fixed evaluation set measured through the whole interpretation path: a real project
// database holding the knowledge the set says already exists, a real capture of each case's
// source, the real worker with a fake provider on the binary override, and the seven counts scored
// over what the readers give back — never over the plan the attempt retained.
//
// Every case gets a project of its own, so what one case publishes is never what a later case's
// retrieval finds. The number is then comparable with the pure harness's, which judges each case
// against the knowledge the set names for it and nothing else.
//
// No real provider is run: `RUN_LLM_TESTS` and `RUN_REAL_USAGE_TESTS` play no part, and the only
// subprocess is the fake proposer the worker's own tests use.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';

import {
  type InterpretationManifest,
  type ProposalFailure,
  type PublishableRecord,
  type ReconciliationPlan,
} from '@orcaops/core';
import {
  type EvaluationCase,
  type EvaluationCounts,
  placeRelatedRecords,
  scoreCase,
  SCRIPTED_ANSWERS,
  wireScript,
} from '@orcaops/core/knowledge/interpretation/evaluation';
import { type InterpretationProcessingSchedule, uuidv7 } from '@orcaops/storage';
import type {
  Attribution,
  AuthorityScope,
  KnowledgeReadRequest,
  KnowledgeTarget,
  RecordRevisionRef,
  RevisionStanding,
} from '@orcaops/storage';
import {
  listProjectTaskUses,
  type ProjectReadView,
  readInterpretationProgress,
  readProjectCorrection,
  readProjectGoverningState,
  readProjectPassageRestatements,
  readProjectRelationship,
} from '@orcaops/storage/history/database';

import * as attemptPlan from '../../src/knowledge-worker/attempt-plan.js';
import { decideDispatch } from '../../src/knowledge-worker/dispatch.js';
import type { RetainedJobSource } from '../../src/knowledge-worker/job-source.js';
import { type KnowledgeWorkerReport, runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import { publishReconciliationPlan } from '../../src/knowledge-worker/publication.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';

/** Which fake-provider behaviour answers a run. */
export type MeasuredProposer = 'scripted' | 'empty' | 'every-line';

const AVAILABILITY = { claude: 'present', codex: 'absent' } as const;

const MEASURED_TABLES = [
  'knowledge_sources',
  'knowledge_interpretations',
  'knowledge_interpretation_evidence',
  'knowledge_equivalence_dispositions',
  'requirements',
  'requirement_revisions',
  'decisions',
  'decision_revisions',
  'claims',
  'claim_revisions',
  'claim_revision_observations',
  'passage_restatements',
  'record_relationships',
  'correction_actions',
  'correction_targets',
  'task_uses',
] as const;

const measuredRows = (fixture: WorkerFixture): number =>
  fixture.handle.read((view) =>
    MEASURED_TABLES.reduce(
      (total, table) =>
        total + (view.get<{ total: number }>(`SELECT count(*) AS total FROM ${table}`)?.total ?? 0),
      0
    )
  ).value;

/** What one published entry the attempt recorded says about itself. */
interface PublishedEntry {
  kind: string;
  id: string;
  revision_id: string | null;
  replay: boolean;
}

export interface MeasuredCase {
  name: string;
  counts: EvaluationCounts;
  notes: readonly string[];
  /** The identities the set says this source is related to, and what the manifest carried. */
  expected: readonly string[];
  carried: readonly string[];
  found: readonly string[];
  /** The retrieval limits the manifest reported. */
  limits: readonly string[];
  calls: number;
  /** The immutable source schedule the worker actually retained. */
  schedule: { scheduleId: string; count: number };
  /** Every attempt's settled outcome, oldest first. */
  outcomes: readonly string[];
  jobState: string;
  jobWaitReason: string | null;
  /** Every rule the attempts retained as a refused answer or a dropped item. */
  rejectedRules: readonly string[];
  published: readonly string[];
  /** The operations the case's publications ran under; a replay adds none. */
  operationIds: readonly string[];
  /** Knowledge rows the case added to the corpus the fixture started from. */
  rowsAdded: number;
  /** The designation every published revision carries, which for a candidate is none. */
  designations: readonly (string | null)[];
}

export interface Measurement {
  proposer: MeasuredProposer;
  cases: readonly MeasuredCase[];
  counts: EvaluationCounts;
  /** Case–identity pairs the set expects, and how many of them the manifests carried. */
  expectedPairs: number;
  foundPairs: number;
  entriesCarried: number;
  calls: number;
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

const add = (left: EvaluationCounts, right: EvaluationCounts): EvaluationCounts => ({
  false_merges: left.false_merges + right.false_merges,
  incorrect_equivalences: left.incorrect_equivalences + right.incorrect_equivalences,
  missed_equivalences: left.missed_equivalences + right.missed_equivalences,
  unauthorized_promotions: left.unauthorized_promotions + right.unauthorized_promotions,
  unsupported_citations: left.unsupported_citations + right.unsupported_citations,
  missed_statements: left.missed_statements + right.missed_statements,
  unexpected_records: left.unexpected_records + right.unexpected_records,
});

const attributionOf = (column: {
  kind: string;
  name?: string | null;
  identity?: string | null;
  basis?: string | null;
}): Attribution =>
  column.kind === 'detector'
    ? { kind: 'detector', detector: (column.name ?? column.identity ?? '') as string }
    : ({
        kind: 'actor',
        actor: {
          identity: column.name ?? column.identity ?? null,
          basis: column.basis ?? 'unknown',
        },
      } as Attribution);

const decoded = (recordHex: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(recordHex, 'hex').toString('utf8')) as Record<string, unknown>;

const readRequest = (scope: AuthorityScope, boundary: number): KnowledgeReadRequest => ({
  scope,
  mode: 'current',
  knowledge_boundary: boundary,
  implementation: { kind: 'none_selected' },
  applicability: {},
  exceptions_judged_at: null,
  exception_conditions: {},
});

/**
 * How one published revision stands now. A revision's acting attribution is the one thing the
 * writers take out of the record and into a column of their own, so it is read back through the
 * resolver rather than out of the retained bytes: the question the score asks — whether anything
 * was published under something other than the detector — is then asked of what the store holds.
 */
function standingOf(
  view: ProjectReadView,
  input: {
    target: KnowledgeTarget;
    revisionId: string;
    projectId: string;
    scope: AuthorityScope;
    boundary: number;
  }
): RevisionStanding | null {
  const state = readProjectGoverningState(
    view,
    input.target,
    input.projectId,
    readRequest(input.scope, input.boundary)
  );
  return (
    state.resolved.revisions.find((entry) => entry.revision.revision_id === input.revisionId) ??
    null
  );
}

interface ReadContext {
  projectId: string;
  scope: AuthorityScope;
  boundary: number;
  planEventId: string;
  /** Every revision a restatement published here could name. */
  candidates: readonly RecordRevisionRef[];
}

interface ReadRecord {
  record: PublishableRecord;
  designation: string | null;
}

/**
 * What the store holds for one published entry, back in the shape the harness scores. Candidate
 * revisions and interpretations are decoded from their retained bytes, never from the plan that
 * proposed them; standing and sidecar rows come from their public storage readers.
 */
function publishedRecord(
  view: ProjectReadView,
  entry: PublishedEntry,
  context: ReadContext
): ReadRecord | null {
  const revision = (kind: 'requirement' | 'decision' | 'claim'): ReadRecord | null => {
    if (entry.revision_id === null) return null;
    const table =
      kind === 'requirement'
        ? 'requirement_revisions'
        : kind === 'decision'
          ? 'decision_revisions'
          : 'claim_revisions';
    const row = view.get<{ recordHex: string }>(
      `SELECT hex(record_bytes) AS recordHex FROM ${table} WHERE revision_id=?`,
      entry.revision_id
    );
    if (row === null) return null;
    const standing = standingOf(view, {
      target: { kind, entity_id: entry.id },
      revisionId: entry.revision_id,
      projectId: context.projectId,
      scope: context.scope,
      boundary: context.boundary,
    });
    return {
      designation: standing?.designation ?? null,
      record: {
        kind: `${kind}_revision`,
        ...(kind === 'requirement' ? { identity: null } : {}),
        rests_on: [],
        record: decoded(row.recordHex),
      } as unknown as PublishableRecord,
    };
  };

  if (entry.kind === 'requirement_revision') return revision('requirement');
  if (entry.kind === 'decision_revision') return revision('decision');
  if (entry.kind === 'claim_revision') return revision('claim');
  if (entry.kind === 'interpretation') {
    const row = view.get<{ recordHex: string }>(
      'SELECT hex(record_bytes) AS recordHex FROM knowledge_interpretations WHERE interpretation_id=?',
      entry.id
    );
    return row === null
      ? null
      : {
          designation: null,
          record: {
            kind: 'interpretation',
            rests_on: [],
            record: decoded(row.recordHex),
          } as unknown as PublishableRecord,
        };
  }
  if (entry.kind === 'passage_restatement') {
    for (const candidate of context.candidates) {
      const row = readProjectPassageRestatements(view, candidate).restatements.find(
        (found) => found.restatementId === entry.id
      );
      if (row === undefined) continue;
      return {
        designation: null,
        record: {
          kind: 'passage_restatement',
          rests_on: [],
          record: { ...decoded(row.recordHex), attributed_to: attributionOf(row.attribution) },
        } as unknown as PublishableRecord,
      };
    }
    return null;
  }
  if (entry.kind === 'relationship') {
    const row = readProjectRelationship(view, entry.id);
    if (row === null) return null;
    return {
      designation: null,
      record: {
        kind: 'relationship',
        rests_on: [],
        record: {
          relationship_id: row.relationshipId,
          relation: row.relation,
          standing: row.standing,
          attributed_to: attributionOf(row.attributedTo),
          authorization: row.authorizationJson === null ? null : { id: row.authorizationId },
          source_ids: row.sourceIds,
        },
      } as unknown as PublishableRecord,
    };
  }
  if (entry.kind === 'correction') {
    const row = readProjectCorrection(view, entry.id);
    if (row === null) return null;
    return {
      designation: null,
      record: {
        kind: 'correction',
        rests_on: [],
        record: {
          ...decoded(row.recordHex),
          attributed_to: attributionOf(row.attributedTo),
          authorization: row.authorizationId === null ? null : { id: row.authorizationId },
        },
      } as unknown as PublishableRecord,
    };
  }
  // A use has no id of its own: the plan event, the revision and the role are what make it the
  // same use, and are what the publication names it by.
  const use = listProjectTaskUses(view, context.planEventId).find(
    (row) => `${row.planEventId}:${row.target.revisionId}:${row.role}` === entry.id
  );
  if (use === undefined) return null;
  return {
    designation: null,
    record: {
      kind: 'task_use',
      rests_on: [],
      record: {
        ...decoded(use.recordHex),
        selection: {
          kind: use.selectionKind,
          discovered_at: use.discoveredAt,
          discovered_by: use.discoveredBy === null ? null : attributionOf(use.discoveredBy),
        },
      },
    } as unknown as PublishableRecord,
  };
}

const publishedBy = (detail: unknown): PublishedEntry[] =>
  ((detail as { published?: PublishedEntry[] } | null)?.published ?? []) as PublishedEntry[];

const retainedPlan = (detail: unknown): ReconciliationPlan | null =>
  ((detail as { reconciliation_plan?: ReconciliationPlan } | null)?.reconciliation_plan ??
    null) as ReconciliationPlan | null;

/**
 * The citation rules the harness counts, read back out of what the attempts retained: a rejected
 * answer retains its failures, and an accepted one retains the items validation dropped.
 */
function retainedFailures(detail: unknown): ProposalFailure[] {
  const record = (detail ?? {}) as {
    failures?: { rule: string; detail?: string }[];
    rejected_items?: { rule: string; detail?: string }[];
  };
  return [...(record.failures ?? []), ...(record.rejected_items ?? [])].map(
    (failure) =>
      ({
        rule: failure.rule,
        item: { kind: 'proposal' },
        detail: failure.detail ?? '',
      }) as ProposalFailure
  );
}

interface Dispatched {
  manifest: InterpretationManifest;
  schedule: InterpretationProcessingSchedule;
  source: RetainedJobSource;
  planEventId: string;
  limits: readonly string[];
}

async function dispatched(fixture: WorkerFixture, jobId: string): Promise<Dispatched> {
  const decision = await decideDispatch({
    handle: fixture.handle,
    job: fixture.job(jobId),
    projectId: fixture.projectId,
    providerAvailability: AVAILABILITY,
  });
  if (decision.outcome !== 'ready' || decision.retrieval === null) {
    throw new Error(`the measured job was not dispatchable: ${JSON.stringify(decision)}`);
  }
  const planned = attemptPlan.planJobAttempt({
    source: decision.source,
    projectId: fixture.projectId,
    configuration: decision.configuration,
    attemptsRemaining: decision.configuration.maxAttempts,
    retained: [],
    completedUnitIds: [],
    retrieval: decision.retrieval,
  });
  if (planned.outcome !== 'ready')
    throw new Error(`the measured source was not schedulable: ${JSON.stringify(planned)}`);
  return {
    manifest: planned.request.manifest,
    schedule: planned.schedule,
    source: decision.source,
    planEventId: decision.source.planEventId ?? decision.source.eventId,
    limits: decision.retrieval.omissions.map((omission) => omission.kind),
  };
}

function work(
  fixture: WorkerFixture,
  env: NodeJS.ProcessEnv,
  beforePublication?: () => void | Promise<void>
): Promise<KnowledgeWorkerReport> {
  const stop = new AbortController();
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: AVAILABILITY,
    log: () => {},
    idleExitMs: 1,
    signal: stop.signal,
    sleep: async () => stop.abort(),
    env,
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    killGraceMs: 200,
    scratchParentDir: fixture.scratchParentDir,
    beforePublication,
  });
}

export interface ReplayOutcome {
  /** Every record the second settlement reached, and whether the store already held it. */
  published: readonly PublishedEntry[];
  /** The operations the second settlement ran. A plan the store already holds runs none. */
  operationIds: readonly string[];
  counts: EvaluationCounts;
  rowsAdded: number;
}

export interface CaseRun {
  fixture: WorkerFixture;
  source: RetainedJobSource;
  measured: MeasuredCase;
  /** The source-wide manifest used to score the complete case. */
  manifest: InterpretationManifest;
  /** Every plan the attempts retained, in the order they were settled. */
  plans: readonly ReconciliationPlan[];
  publications: readonly {
    plan: ReconciliationPlan;
    manifest: InterpretationManifest;
  }[];
  /**
   * The same case scored over the plans the attempts retained instead of over what the store
   * holds. The two agree whenever the publication went through, and part company exactly when it
   * did not — which is what makes the store the thing the measurement reads.
   */
  scoredFromPlan: EvaluationCounts;
  /**
   * Settle every plan this case produced a second time, through the same writers. A completed job
   * is never reopened, so this is where the replay the store guarantees can be watched: the same
   * source and the same proposal derive the same identities, and the second settlement writes
   * nothing.
   */
  replay(): Promise<ReplayOutcome>;
}

export async function runMeasuredCase(input: {
  evaluated: EvaluationCase;
  corpus: readonly EvaluationCase[];
  proposer: MeasuredProposer;
  /** Runs after the job is admitted and the manifest is known, and before the worker takes it. */
  beforeWork?: (
    fixture: WorkerFixture,
    manifest: InterpretationManifest,
    source: RetainedJobSource
  ) => Promise<void>;
  /** Runs after reconciliation is retained and immediately before publication. */
  beforePublication?: (fixture: WorkerFixture) => void | Promise<void>;
}): Promise<CaseRun> {
  const { evaluated, proposer } = input;
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  try {
    await placeRelatedRecords(fixture.handle, {
      projectId: fixture.projectId,
      cases: input.corpus,
    });
    const { jobId } = await fixture.captureAndAdmit(evaluated.source_text);

    const plan = await dispatched(fixture, jobId);

    const scriptsFile = path.join(fixture.scratchParentDir, 'scripted-answers.json');
    const fixtureSourceId = evaluated.manifest.sources[0]?.source_id;
    const script = fixtureSourceId === undefined ? undefined : SCRIPTED_ANSWERS[fixtureSourceId];
    const wired = script === undefined ? undefined : wireScript(evaluated, script);
    const fixtureRange = evaluated.manifest.segments[0]?.prepared_range;
    const selectedUnit =
      wired?.only_unit === undefined
        ? undefined
        : (plan.schedule.units.find((unit) =>
            unit.segments.some(
              (segment) =>
                fixtureRange !== undefined &&
                segment.purpose === 'primary' &&
                segment.prepared_range.start <= fixtureRange.start &&
                segment.prepared_range.end >= fixtureRange.end
            )
          ) ?? plan.schedule.units[0]);
    const liveWire =
      wired === undefined
        ? undefined
        : wired.only_unit === undefined
          ? wired
          : { ...wired, only_unit: selectedUnit?.unit_id };
    await writeFile(
      scriptsFile,
      JSON.stringify(
        liveWire === undefined
          ? {}
          : Object.fromEntries(plan.schedule.units.map((unit) => [unit.unit_id, liveWire])),
        null,
        2
      ),
      'utf8'
    );
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      FAKE_PROPOSER_ANSWER: proposer,
      FAKE_PROPOSER_SCRIPTS: scriptsFile,
    };

    await input.beforeWork?.(fixture, plan.manifest, plan.source);
    // Taken last, so a caller that put knowledge in the store before the worker ran is not
    // counted among the rows this case added.
    const baselineRows = measuredRows(fixture);

    const invocationManifests = new Map<string, InterpretationManifest>();
    const planAttempt = attemptPlan.planJobAttempt;
    const planning = vi.spyOn(attemptPlan, 'planJobAttempt').mockImplementation((request) => {
      const result = planAttempt(request);
      if (result.outcome === 'ready') {
        const manifest = result.request.manifest;
        invocationManifests.set(manifest.manifest_sha256, manifest);
      }
      return result;
    });
    let report: KnowledgeWorkerReport;
    try {
      report = await work(fixture, env, () => input.beforePublication?.(fixture));
    } finally {
      planning.mockRestore();
    }
    const measured = read({
      fixture,
      evaluated,
      jobId,
      dispatched: plan,
      calls: report.callsMade,
      baselineRows,
      invocationManifests: [...invocationManifests.values()],
    });
    const progress = readInterpretationProgress(fixture.handle, jobId);
    const receipts = new Set(
      (progress?.receipts ?? []).map(
        (receipt) => `${receipt.unit_id}\0${receipt.completion_request_sha256}`
      )
    );
    const attempts = settled(fixture, jobId);
    const plans = attempts.flatMap((attempt) => {
      const retained = retainedPlan(attempt.detail);
      return retained === null ? [] : [retained];
    });
    const publications = attempts.flatMap((attempt) => {
      const receipt = (
        attempt.detail as {
          interpretation_unit_receipt?: {
            unit_id: string;
            completion_request_sha256: string;
          };
        } | null
      )?.interpretation_unit_receipt;
      if (
        receipt === undefined ||
        !receipts.has(`${receipt.unit_id}\0${receipt.completion_request_sha256}`)
      )
        return [];
      const retained = retainedPlan(attempt.detail);
      if (retained === null) return [];
      const detail = attempt.detail as { manifest_sha256?: unknown };
      const manifest = invocationManifests.get(retained.manifest_sha256);
      if (detail.manifest_sha256 !== retained.manifest_sha256 || manifest === undefined)
        throw new Error('A retained plan has no matching observed invocation manifest.');
      return [{ plan: retained, manifest }];
    });
    return {
      fixture,
      source: plan.source,
      measured,
      manifest: plan.manifest,
      plans,
      publications,
      scoredFromPlan: scoreCase({
        expected: evaluated.expected,
        manifest: plan.manifest,
        plan: {
          records: plans.flatMap((retained) => retained.records),
        } as unknown as ReconciliationPlan,
        failures: attempts.flatMap((attempt) => retainedFailures(attempt.detail)),
      }).counts,
      replay: async () => {
        const published: PublishedEntry[] = [];
        const operationIds: string[] = [];
        for (const publication of publications) {
          const outcome = await publishReconciliationPlan({
            handle: fixture.handle,
            manifest: publication.manifest,
            plan: publication.plan,
            source: plan.source,
            operationId: uuidv7(),
          });
          if (outcome.kind !== 'published')
            throw new Error(`a replayed settlement was not published: ${JSON.stringify(outcome)}`);
          published.push(...outcome.published);
          if (outcome.operationId !== null) operationIds.push(outcome.operationId);
        }
        const after = read({
          fixture,
          evaluated,
          jobId,
          dispatched: plan,
          calls: report.callsMade,
          baselineRows,
          invocationManifests: [...invocationManifests.values()],
        });
        return {
          published,
          operationIds,
          counts: after.counts,
          rowsAdded: measuredRows(fixture) - baselineRows,
        };
      },
    };
  } catch (cause) {
    await fixture.cleanup();
    throw cause;
  }
}

const settled = (fixture: WorkerFixture, jobId: string) =>
  fixture
    .attempts(jobId)
    .filter((attempt) => attempt.outcome !== null)
    // Oldest first, so a divided job reads as the order its units were taken.
    .reverse();

function read(input: {
  fixture: WorkerFixture;
  evaluated: EvaluationCase;
  jobId: string;
  dispatched: Dispatched;
  calls: number;
  baselineRows: number;
  invocationManifests: readonly InterpretationManifest[];
}): MeasuredCase {
  const { fixture, evaluated } = input;
  const manifest = input.dispatched.manifest;
  const attempts = settled(fixture, input.jobId);
  const entries = new Map<string, PublishedEntry>();
  for (const attempt of attempts)
    for (const entry of publishedBy(attempt.detail))
      entries.set(`${entry.kind}\0${entry.id}\0${entry.revision_id ?? ''}`, entry);

  const context: ReadContext = {
    projectId: fixture.projectId,
    scope: { kind: 'artifact', artifact_id: input.dispatched.source.artifactId },
    boundary: fixture.handle.read(() => null).counters.writeSequence,
    planEventId: input.dispatched.planEventId,
    candidates: input.invocationManifests.flatMap((entry) =>
      entry.revisions.map((revision) => revision.revision)
    ),
  };
  const found = fixture.handle.read((view) =>
    [...entries.values()].map((entry) => {
      const record = publishedRecord(view, entry, context);
      if (record === null)
        throw new Error(
          `the readers hold no ${entry.kind} ${entry.id} the attempt says it published`
        );
      return record;
    })
  ).value;

  const failures = attempts.flatMap((attempt) => retainedFailures(attempt.detail));
  const scored = scoreCase({
    expected: evaluated.expected,
    manifest,
    plan: { records: found.map((entry) => entry.record) } as unknown as ReconciliationPlan,
    failures,
  });

  const carried = [
    ...new Set(
      input.invocationManifests.flatMap((entry) =>
        entry.related_knowledge.map((related) => related.resolved.target.entity_id)
      )
    ),
  ];
  const expected = [
    ...new Set(
      evaluated.manifest.related_knowledge.map((entry) => entry.resolved.target.entity_id)
    ),
  ];
  const job = fixture.job(input.jobId);
  return {
    name: evaluated.name,
    counts: scored.counts,
    notes: scored.notes,
    expected,
    carried,
    found: expected.filter((entity) => carried.includes(entity)),
    limits: input.dispatched.limits,
    calls: input.calls,
    schedule: {
      scheduleId: input.dispatched.schedule.schedule_id,
      count: input.dispatched.schedule.units.length,
    },
    outcomes: attempts.map((attempt) => attempt.outcome as string),
    jobState: job.state,
    jobWaitReason: job.waitReason,
    rejectedRules: [...new Set(failures.map((failure) => failure.rule as string))].sort(),
    published: [...entries.values()].map((entry) => entry.kind).sort(),
    operationIds: attempts
      .map((attempt) => attempt.publishingOperationId)
      .filter((id): id is string => id !== null),
    rowsAdded: measuredRows(fixture) - input.baselineRows,
    designations: found.map((entry) => entry.designation),
  };
}

export function totals(proposer: MeasuredProposer, cases: readonly MeasuredCase[]): Measurement {
  const withRelated = cases.filter((entry) => entry.expected.length > 0);
  return {
    proposer,
    cases,
    counts: cases.reduce((total, entry) => add(total, entry.counts), NONE),
    expectedPairs: withRelated.reduce((total, entry) => total + entry.expected.length, 0),
    foundPairs: withRelated.reduce((total, entry) => total + entry.found.length, 0),
    entriesCarried: cases.reduce((total, entry) => total + entry.carried.length, 0),
    calls: cases.reduce((total, entry) => total + entry.calls, 0),
  };
}
