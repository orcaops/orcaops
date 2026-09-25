import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type InterpretationManifest, type ReconciliationPlan } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';
import {
  appendProjectCorrection,
  createProjectRequirement,
  listProjectCorrections,
  type ProjectDatabase,
  ProjectDatabaseError,
  publishProjectKnowledgeSource,
  readProjectKnowledgeSource,
  readProjectPassageRestatements,
  readProjectRequirement,
  retryProcessingJob,
} from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';

import { type KnowledgeWorkerReport, runKnowledgeWorker } from './loop.js';
import {
  publishReconciliationPlan,
  publishReconciliationPlanAndSettleAttempt,
} from './publication.js';
import { ORIGIN_BOUND_WAIT_REASONS, PERMANENT_WAIT_REASONS } from './wait-reasons.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
  type WorkerFixtureOptions,
} from './worker-fixture.test-support.js';

// Recording a grant is deliberately possible only at a terminal, as in the worker's own tests.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

/**
 * What the worker actually writes. Every test drives the real worker against a real project
 * database and settles what the fake proposer answered through the real storage writers, so the
 * rows asserted on here are the rows a reader of this project would find.
 */

const fixtures: WorkerFixture[] = [];

afterEach(async () => {
  for (const made of fixtures.splice(0)) await made.cleanup();
});

/** Three lines: an obligation, a choice, and the reason the choice states. */
const THREE_LINE_TASK = [
  'Notes are flushed to disk before the screen reports them saved.',
  'Writes go through a temporary file and a rename.',
  'A technician must not lose a note to a crash.',
].join('\n');

const AT = '2026-09-17T10:00:00.000Z';
const OWNER = { identity: 'the project owner', basis: 'authenticated' } as const;

async function fixture(options: WorkerFixtureOptions = {}): Promise<WorkerFixture> {
  const made = await knowledgeWorkerFixture({
    provider: KNOWLEDGE_PROPOSER,
    task: THREE_LINE_TASK,
    ...options,
  });
  fixtures.push(made);
  return made;
}

async function work(
  f: WorkerFixture,
  overrides: Partial<Parameters<typeof runKnowledgeWorker>[0]> = {}
): Promise<KnowledgeWorkerReport> {
  const lines: string[] = [];
  const report = await runKnowledgeWorker({
    authority: f.authority,
    projectId: f.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log: (line) => lines.push(line),
    idleExitMs: 1,
    env: f.env,
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    killGraceMs: 200,
    scratchParentDir: f.scratchParentDir,
    ...overrides,
  });
  return { ...report, detail: `${report.detail}\n${lines.join('\n')}` };
}

/** The proposer answers whatever this run asks it for. */
const answering = (f: WorkerFixture, answer: string, extra: NodeJS.ProcessEnv = {}) => ({
  env: { ...f.env, FAKE_PROPOSER_ANSWER: answer, ...extra },
});

const result = (f: WorkerFixture, jobId: string) =>
  f.attempts(jobId)[0]!.detail as Record<string, unknown>;

interface PublishedEntry {
  kind: string;
  id: string;
  revision_id: string | null;
  replay: boolean;
}

const publishedBy = (detail: unknown): PublishedEntry[] =>
  (
    ((detail as { published?: PublishedEntry[] } | null)?.published ?? []) as PublishedEntry[]
  ).filter((entry) => entry.kind !== 'interpretation');

const counters = (f: WorkerFixture) => f.handle.read(() => null).counters;

const read = <T>(f: WorkerFixture, query: Parameters<WorkerFixture['handle']['read']>[0]): T =>
  f.handle.read(query).value as T;

const rowCount = (handle: ProjectDatabase, table: string): number =>
  handle.read(
    (view) => view.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)!.count
  ).value;

/** What a settled attempt says about the immutable unit it carried. */
interface UnitProgress {
  scheduleId: string;
  unitId: string;
  index: number;
  count: number;
}

/**
 * One plan of one record, for the branches that are about what the store answers rather than
 * about what was derived. Everything in it is what `buildReconciliationPlan` produces.
 */
function plannedRequirement(): {
  manifest: InterpretationManifest;
  plan: ReconciliationPlan;
  source: Parameters<typeof publishReconciliationPlan>[0]['source'];
} {
  const sourceId = `${uuidv7()}#task#0`;
  const artifactId = uuidv7();
  const eventId = uuidv7();
  const statement = 'Notes are flushed to disk before the screen reports them saved.';
  const passage = {
    source_id: sourceId,
    location: `bytes:0-${Buffer.byteLength(statement)}`,
    passage_sha256: digest(Buffer.from(statement)),
  };
  const requirementId = uuidv7();
  const detector = { kind: 'detector' as const, detector: 'knowledge-interpretation' };
  return {
    manifest: {
      attributed_to: detector,
      sources: [
        {
          ref: 's1',
          source_id: sourceId,
          occurrence: {
            kind: 'capture_field',
            artifact_id: artifactId,
            event_id: eventId,
            field_path: 'task',
            position: 0,
          },
        },
      ],
      segments: [],
      processor_contract: 'knowledge-interpretation@2',
    } as unknown as InterpretationManifest,
    plan: {
      attributed_to: detector,
      records: [
        {
          kind: 'requirement_revision',
          identity: {
            requirement_id: requirementId,
            origin: { kind: 'promoted_source', passage, promoted_at: AT },
          },
          record: {
            requirement_id: requirementId,
            revision_id: uuidv7(),
            previous_revision_id: null,
            statement,
            rationale: null,
            subject: null,
            applicability: { all_of: [] },
            duration: { kind: 'unknown' },
            source_ids: [sourceId],
            passages: [passage],
            source_standing: 'extracted_candidate',
            attributed_to: detector,
            recorded_at: AT,
          },
          rests_on: [],
        },
      ],
    } as unknown as ReconciliationPlan,
    source: {
      artifactId,
      eventId,
      eventType: 'plan_captured',
      recordedAt: AT,
      originKind: 'captured',
      fields: [],
      omissions: [],
      sourceAuthor: OWNER,
      recordedBy: OWNER,
      planEventId: eventId,
      knowledgeBoundary: 1,
    },
  };
}

/** A retained instruction, which is what an act published on one cites. */
async function instructionSource(f: WorkerFixture, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const published = await publishProjectKnowledgeSource(f.handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'user_instruction',
        retention: { kind: 'bytes', content_sha256: digest(bytes) },
        location: 'session transcript, turn 4',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: OWNER,
    retainedBytes: bytes,
    secretAllow: [],
  });
  return published.value.sourceId;
}

describe('what the worker publishes', () => {
  it('publishes a plan through the writers and names the operation on the attempt', async () => {
    const f = await fixture();
    const { jobId, eventId } = await f.admit();

    await work(f, answering(f, 'multi'));

    const [attempt] = f.attempts(jobId);
    expect(attempt!.outcome).toBe('succeeded');
    expect(attempt!.publishingOperationId).toMatch(/^[0-9a-f-]{36}$/);
    const entries = publishedBy(result(f, jobId));
    expect(entries.map((entry) => entry.kind)).toEqual([
      'requirement_revision',
      'decision_revision',
    ]);
    expect(entries.every((entry) => !entry.replay)).toBe(true);

    // The records are readable through the readers, and the source they cite was published by
    // the same operation, which is what makes the publication one atomic step.
    const requirement = read<ReturnType<typeof readProjectRequirement>>(f, (view) =>
      readProjectRequirement(view, entries[0]!.id)
    );
    expect(requirement?.revisions).toHaveLength(1);
    expect(requirement?.revisions[0]?.sourceStanding).toBe('extracted_candidate');
    expect(requirement?.revisions[0]?.attribution).toMatchObject({ kind: 'detector' });
    expect(requirement?.revisions[0]?.operationId).toBe(attempt!.publishingOperationId);
    const source = read<ReturnType<typeof readProjectKnowledgeSource>>(f, (view) =>
      readProjectKnowledgeSource(view, `${eventId}#task#0`)
    );
    expect(source?.operationId).toBe(attempt!.publishingOperationId);
    expect(source?.interpretedBy).toMatchObject({ kind: 'detector' });
    const completionSources = (
      attempt!.detail as {
        completion_publication: { sources: { sourceId: string }[] };
      }
    ).completion_publication.sources;
    expect(completionSources.length).toBeGreaterThan(1);
    expect(
      completionSources.map(
        ({ sourceId }) =>
          read<ReturnType<typeof readProjectKnowledgeSource>>(f, (view) =>
            readProjectKnowledgeSource(view, sourceId)
          )?.operationId
      )
    ).toEqual(completionSources.map(() => attempt!.publishingOperationId));
  }, 60_000);

  it('moves no intent counter, because nothing it publishes designates anything', async () => {
    const f = await fixture();
    await f.admit();
    const before = counters(f);

    await work(f, answering(f, 'multi'));

    expect(counters(f).intentChangeCounter).toBe(before.intentChangeCounter);
  }, 60_000);

  it('records an exact repetition without minting another revision', async () => {
    const f = await fixture();
    const first = await f.admit();
    await work(f, answering(f, 'multi'));
    const requirementId = publishedBy(result(f, first.jobId))[0]!.id;
    const second = await f.admit();

    await work(f, answering(f, 'restate'));

    const entries = publishedBy(result(f, second.jobId));
    expect(entries.filter((entry) => entry.kind === 'passage_restatement')).toHaveLength(1);
    expect(entries.every((entry) => !entry.replay)).toBe(true);

    // A repetition costs a passage and not a revision: the lineage is still one revision long.
    const requirement = read<ReturnType<typeof readProjectRequirement>>(f, (view) =>
      readProjectRequirement(view, requirementId)
    );
    expect(requirement?.revisions).toHaveLength(1);
    expect(
      read<ReturnType<typeof readProjectPassageRestatements>>(f, (view) =>
        readProjectPassageRestatements(view, {
          kind: 'requirement',
          entity_id: requirementId,
          revision_id: requirement!.revisions[0]!.revisionId,
        })
      ).occurrences
    ).toBe(1);
  }, 90_000);

  it('records a quoted multiline Unicode repetition from a real capture sidecar', async () => {
    const wording = 'Save "café" notes before reporting success.\nPreserve 日本語 and 🐋.';
    const f = await fixture({ task: wording });
    const scriptsPath = path.join(f.scratchParentDir, 'restatement-answers.json');
    const proposed = {
      quote: wording,
      source_form: 'stated_obligation',
      proposed_record: 'requirement',
      intended_scope: { kind: 'project' },
    };
    const answer = answering(f, 'scripted', { FAKE_PROPOSER_SCRIPTS: scriptsPath });
    await writeFile(scriptsPath, JSON.stringify({ default: { statements: [proposed] } }));
    const first = await f.admit();
    await work(f, answer);
    expect(f.job(first.jobId).state).toBe('completed');
    const requirementId = publishedBy(result(f, first.jobId)).find(
      (entry) => entry.kind === 'requirement_revision'
    )!.id;
    const revisionsBefore = rowCount(f.handle, 'requirement_revisions');

    const task = `${wording}\n${'Additional context about offline notes.\n'.repeat(260)}`;
    const second = await f.captureAndAdmit(task);
    const retained = f.handle.read((view) =>
      view.get<{ record: string; payload: string | null }>(
        `SELECT CAST(record_bytes AS TEXT) AS record,
           CAST(sidecar_payload_bytes AS TEXT) AS payload
         FROM artifact_events WHERE artifact_id=? AND event_type='plan_captured'`,
        second.artifactId
      )
    ).value!;
    expect(retained.payload).not.toBeNull();
    expect(JSON.parse(retained.record)).not.toHaveProperty('payload');
    expect(JSON.parse(retained.payload!).task).toBe(task);
    await writeFile(
      scriptsPath,
      JSON.stringify({
        default: {
          statements: [
            { ...proposed, links: [{ statement: wording, relation: 'exact_restatement' }] },
          ],
        },
      })
    );

    await work(f, answer);

    expect(f.job(second.jobId).state).toBe('completed');
    const entries = f.attempts(second.jobId).flatMap((attempt) => publishedBy(attempt.detail));
    expect(entries.filter((entry) => entry.kind === 'passage_restatement')).toHaveLength(1);
    expect(rowCount(f.handle, 'requirement_revisions')).toBe(revisionsBefore);
    const requirement = read<ReturnType<typeof readProjectRequirement>>(f, (view) =>
      readProjectRequirement(view, requirementId)
    );
    const restatements = read<ReturnType<typeof readProjectPassageRestatements>>(f, (view) =>
      readProjectPassageRestatements(view, {
        kind: 'requirement',
        entity_id: requirementId,
        revision_id: requirement!.revisions[0]!.revisionId,
      })
    );
    expect(restatements.occurrences).toBe(1);
    expect(restatements.restatements[0]?.passage.passage_sha256).toBe(
      digest(Buffer.from(wording, 'utf8'))
    );
  }, 90_000);

  it('keeps one schedule while rejecting ambiguous repeated wording per unit', async () => {
    const repeated = 'Notes are flushed to disk before the screen reports them saved.\n'.repeat(
      2_000
    );
    const f = await fixture({ task: repeated });
    await f.writeConfig({
      enabled: true,
      max_attempts: 8,
      max_input_bytes: 80_000,
    });
    const { jobId } = await f.admit({ task: repeated });
    const before = counters(f);

    const report = await work(f, answering(f, 'restate'));

    const attempts = f.attempts(jobId).reverse();
    expect(attempts.length, report.detail).toBeGreaterThan(1);
    const units = attempts.map(
      (attempt) => (attempt.detail as unknown as { unit: UnitProgress }).unit
    );
    expect(new Set(units.map((unit) => unit.scheduleId)).size).toBe(1);
    expect(new Set(units.map((unit) => unit.unitId)).size).toBe(units.length);
    expect(units.map((unit) => unit.index)).toEqual(units.map((_, index) => index));
    expect(report.callsMade).toBe(units[0]!.count);
    expect(attempts).toHaveLength(units[0]!.count);

    expect(attempts.flatMap((attempt) => publishedBy(attempt.detail))).toEqual([]);
    expect(
      attempts.every(
        (attempt) =>
          (attempt.detail as { interpretation_quality: { outcome: string } }).interpretation_quality
            .outcome === 'all_rejected'
      )
    ).toBe(true);
    expect(counters(f).intentChangeCounter).toBe(before.intentChangeCounter);
  }, 120_000);

  it('reports repeated ambiguous observations without minting candidates', async () => {
    const observed = 'The second run of the import took nine seconds on the same machine.\n';
    const repeated = observed.repeat(2_000);
    const f = await fixture({ task: repeated });
    await f.writeConfig({
      enabled: true,
      max_attempts: 8,
      max_input_bytes: 80_000,
    });
    const { jobId } = await f.admit({ task: repeated });

    const report = await work(f, answering(f, 'observation'));

    const attempts = f.attempts(jobId).reverse();
    const units = attempts.map(
      (attempt) => (attempt.detail as unknown as { unit: UnitProgress }).unit
    );
    expect(units.length, report.detail).toBeGreaterThan(1);
    expect(attempts).toHaveLength(units[0]!.count);
    expect(report.callsMade).toBe(units[0]!.count);
    expect(f.job(jobId).state).toBe('completed');

    expect(attempts.flatMap((attempt) => publishedBy(attempt.detail))).toEqual([]);
    expect(
      attempts.every((attempt) =>
        (attempt.detail as { rejected_items: { rule: string }[] }).rejected_items.some(
          (item) => item.rule === 'CITATION_AMBIGUOUS'
        )
      )
    ).toBe(true);
  }, 120_000);

  it('mints independent records from unambiguous segments and reports ambiguous segments', async () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, index) => `Note ${index} is kept until the server acknowledges it.\n`
    ).join('');
    const f = await fixture({ task: lines });
    await f.writeConfig({
      enabled: true,
      max_attempts: 8,
      max_input_bytes: 100_000,
    });
    const { jobId } = await f.admit({ task: lines });

    await work(f, answering(f, 'observation'));

    const attempts = f.attempts(jobId).reverse();
    expect(attempts.length).toBeGreaterThan(1);
    expect(f.job(jobId).state).toBe('completed');
    const minted = attempts.map((attempt) => publishedBy(attempt.detail));
    const candidates = minted
      .flat()
      .filter((entry) => entry.kind === 'claim_revision' && !entry.replay);
    expect(candidates.length).toBeGreaterThan(1);
    expect(new Set(candidates.map((entry) => entry.id)).size).toBe(candidates.length);
    expect(
      attempts.some((attempt) =>
        (attempt.detail as { rejected_items?: { rule: string }[] }).rejected_items?.some(
          (item) => item.rule === 'CITATION_AMBIGUOUS'
        )
      )
    ).toBe(true);
  }, 120_000);

  it('parks a source that cannot finish under the limits, and takes it after the cap is raised', async () => {
    const long = 'A sentence a technician would read about saving notes.\n'.repeat(4_000);
    const f = await fixture({ task: long });
    await f.writeConfig({
      enabled: true,
      max_attempts: 1,
      max_input_bytes: 100_000,
    });
    const { jobId, eventId } = await f.admit({ task: long });

    const parked = await work(f);

    expect(parked.callsMade).toBe(0);
    expect(existsSync(f.providerStartedMarker)).toBe(false);
    // Parked, not settled: the remedy is raising a limit, which a retry can then act on.
    expect(f.job(jobId)).toMatchObject({ state: 'pending', waitReason: 'source_schedule_limit' });
    // None of the allowance is spent on a source nothing was sent for.
    expect(f.attempts(jobId)).toHaveLength(0);
    expect(
      read<ReturnType<typeof readProjectKnowledgeSource>>(f, (view) =>
        readProjectKnowledgeSource(view, `${eventId}#task#0`)
      )
    ).toBeNull();

    // The worker never frees this reason on its own: a second run leaves it where it is, and
    // only a person's retry moves it.
    expect(PERMANENT_WAIT_REASONS).toContain('source_schedule_limit');
    expect(ORIGIN_BOUND_WAIT_REASONS).not.toContain('source_schedule_limit');
    expect((await work(f)).callsMade).toBe(0);
    expect(f.job(jobId).waitReason).toBe('source_schedule_limit');

    await f.writeConfig({ enabled: true, max_attempts: 8, max_input_bytes: 100_000 });
    await retryProcessingJob(f.handle, { jobId, now: new Date().toISOString() });
    const after = await work(f);

    expect(after.callsMade).toBeGreaterThan(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 90_000);

  it('omits a restricted field while processing its unrestricted neighbor', async () => {
    const f = await fixture();
    const { jobId, eventId } = await f.admit();
    // Nothing this build publishes restricts a source, so the case is seeded the way it arises:
    // a person published the occurrence as a source of their own, with a restriction on it.
    const restricted = await publishProjectKnowledgeSource(f.handle, {
      operationId: uuidv7(),
      source: {
        source_id: uuidv7(),
        occurrence: {
          kind: 'capture_field',
          artifact_id: f.artifactId,
          event_id: eventId,
          field_path: 'task',
          position: 0,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: 'owner only',
      },
      recordedBy: OWNER,
      secretAllow: [],
    });
    const before = counters(f);

    const report = await work(f);

    expect(report.callsMade).toBe(1);
    expect(existsSync(f.providerStartedMarker)).toBe(true);
    expect(f.job(jobId)).toMatchObject({ state: 'completed', waitReason: null });
    const [attempt] = f.attempts(jobId);
    expect(attempt.configuration).toMatchObject({
      schedule_binding: {
        schedule: {
          omissions: [
            expect.objectContaining({
              field_path: 'task',
              reason: expect.stringContaining('access'),
            }),
          ],
        },
      },
    });
    expect(JSON.stringify(attempt.configuration)).not.toContain(`${eventId}#task#0`);
    expect(
      read<ReturnType<typeof readProjectKnowledgeSource>>(f, (view) =>
        readProjectKnowledgeSource(view, restricted.value.sourceId)
      )?.interpretedBy
    ).toBeNull();
    expect(counters(f).writeSequence).toBeGreaterThan(before.writeSequence);
  }, 60_000);

  it('publishes nothing after a scheduled field becomes restricted', async () => {
    const f = await fixture();
    const { jobId, eventId } = await f.admit();

    const report = await work(f, {
      beforePublication: async () => {
        await publishProjectKnowledgeSource(f.handle, {
          operationId: uuidv7(),
          source: {
            source_id: uuidv7(),
            occurrence: {
              kind: 'capture_field',
              artifact_id: f.artifactId,
              event_id: eventId,
              field_path: 'task',
              position: 0,
            },
            source_author: OWNER,
            interpreted_by: null,
            access_restriction: 'owner only',
          },
          recordedBy: OWNER,
          secretAllow: [],
        });
      },
    });

    expect(report.callsMade).toBe(1);
    expect(f.job(jobId)).toMatchObject({
      state: 'pending',
      waitReason: 'source_access_changed',
    });
    const [attempt] = f.attempts(jobId);
    expect(attempt.outcome).toBe('failed');
    expect(attempt.publishingOperationId).toBeNull();
    expect(attempt.detail).toMatchObject({
      unit_settled: false,
      withdrawn: { wait_reason: 'source_access_changed' },
    });
    expect(attempt.detail).not.toMatchObject({ interpretation_unit_receipt: expect.anything() });
    expect(rowCount(f.handle, 'requirement_revisions')).toBe(0);
    expect((await work(f)).callsMade).toBe(0);
    expect(f.attempts(jobId)).toHaveLength(1);
  }, 60_000);

  it('publishes no candidate from evidence that crosses a redacted credential', async () => {
    // Two doors, and the worker is behind both. The capture path refuses a credential outright
    // unless the person who made it named that exact token in their own allowlist, and even then
    // it retains the passage redacted — so the source an attempt reads carries no literal, and
    // the writers' own refusal (which `knowledge-interpretation.test.ts` reaches directly) is the
    // backstop for a record that somehow still would.
    const credential = `ghp_${'a'.repeat(36)}`;
    const secret = `The deploy key ${credential} is rotated every quarter.`;
    const f = await fixture({ task: secret });
    const { jobId } = await f.admit({ task: secret, secretAllow: [credential] });

    await work(f);

    const [attempt] = f.attempts(jobId);
    expect(attempt!.outcome).toBe('succeeded');
    expect(publishedBy(result(f, jobId))).toEqual([]);
    expect(rowCount(f.handle, 'requirement_revisions')).toBe(0);
    expect(await readFile(f.providerRecordPath, 'utf8')).not.toContain(credential);
  }, 60_000);
});

describe('interpreted candidate identities', () => {
  it('does not confuse a promoted passage identity with an interpreted candidate', async () => {
    const f = await fixture();
    const { jobId, eventId } = await f.admit();
    const sourceId = `${eventId}#task#0`;
    const passage = {
      source_id: sourceId,
      location: `bytes:0-${Buffer.byteLength(THREE_LINE_TASK.split('\n')[0]!)}`,
      passage_sha256: digest(Buffer.from(THREE_LINE_TASK.split('\n')[0]!)),
    };
    // Somebody promoted that passage first, and worded their requirement differently, so the
    // detector still reads a rule out of it and derives an identity for a passage the store
    // already has one for — which it refuses by the name of the requirement that passage has.
    await publishProjectKnowledgeSource(f.handle, {
      operationId: uuidv7(),
      source: {
        source_id: sourceId,
        occurrence: {
          kind: 'capture_field',
          artifact_id: f.artifactId,
          event_id: eventId,
          field_path: 'task',
          position: 0,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: null,
      },
      recordedBy: OWNER,
      secretAllow: [],
    });
    const requirementId = uuidv7();
    await createProjectRequirement(f.handle, {
      operationId: uuidv7(),
      identity: {
        requirement_id: requirementId,
        origin: { kind: 'promoted_source', passage, promoted_at: AT },
      },
      revision: {
        requirement_id: requirementId,
        revision_id: uuidv7(),
        previous_revision_id: null,
        statement: 'Notes reach the disk before the screen says they are saved.',
        rationale: null,
        subject: null,
        applicability: { all_of: [] },
        duration: { kind: 'continuing' },
        source_ids: [sourceId],
        passages: [passage],
        source_standing: 'explicit_instruction',
        recorded_at: AT,
      },
      attributedTo: { kind: 'actor', actor: OWNER },
      secretAllow: [],
    });
    const before = f.knowledgeRows();

    await work(f, answering(f, 'multi'));

    const [attempt] = f.attempts(jobId);
    expect(attempt!.outcome).toBe('succeeded');
    expect(attempt!.publishingOperationId).not.toBeNull();
    expect(f.job(jobId).state).toBe('completed');
    const candidates = publishedBy(result(f, jobId)).filter(
      (entry) => entry.kind === 'requirement_revision'
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).not.toBe(requirementId);
    expect(f.knowledgeRows()).toBeGreaterThan(before);
    expect(
      read<ReturnType<typeof readProjectRequirement>>(f, (view) =>
        readProjectRequirement(view, requirementId)
      )?.revisions
    ).toHaveLength(1);
  }, 60_000);

  it('leaves the job for later when the store could not complete the operation', async () => {
    // A store that cannot commit now is not a plan this build cannot publish, so the same plan
    // may be published by a later dispatch. Driven here rather than through the worker: the only
    // way to make a real store fail this way is to stop it writing, which would also stop the
    // settlement that has to record the attempt.
    const unavailable = {
      authority: { projectId: uuidv7() },
      read: () => {
        throw new ProjectDatabaseError('TRANSACTION_FAILED', 'Database transaction failed');
      },
    } as unknown as Parameters<typeof publishReconciliationPlan>[0]['handle'];
    const planned = plannedRequirement();

    const outcome = await publishReconciliationPlan({
      handle: unavailable,
      manifest: planned.manifest,
      plan: planned.plan,
      source: planned.source,
      operationId: uuidv7(),
    });

    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'TRANSACTION_FAILED' });
  });

  it('refuses a reconciliation plan made from a different manifest', async () => {
    const planned = plannedRequirement();
    const manifest = { ...planned.manifest, manifest_sha256: 'a'.repeat(64) };
    const plan = { ...planned.plan, manifest_sha256: 'b'.repeat(64) };

    await expect(
      publishReconciliationPlanAndSettleAttempt({
        handle: {} as Parameters<typeof publishReconciliationPlanAndSettleAttempt>[0]['handle'],
        manifest,
        plan,
        source: planned.source,
        processing: {
          generation: 1,
          jobId: uuidv7(),
          attemptId: uuidv7(),
          finishedAt: AT,
          usage: null,
          manifestSha256: manifest.manifest_sha256,
          unit: {
            scheduleId: 'c'.repeat(64),
            unitId: 'd'.repeat(64),
            index: 0,
            count: 1,
          },
          quality: null,
          outcome: { kind: 'completed', result: null, detail: null },
        },
      })
    ).rejects.toThrow('same manifest');
  });
});

describe('a governing state that moved between the manifest and the settlement', () => {
  it('fails the whole plan, retains the attempt, and a later run reconsiders', async () => {
    const f = await fixture();
    const first = await f.admit();
    await work(f, answering(f, 'multi'));
    const requirement = publishedBy(result(f, first.jobId))[0]!;
    const instructionId = await instructionSource(
      f,
      'Adopt the flush-before-reporting rule for this artifact.'
    );
    const scope = { kind: 'artifact', artifact_id: f.artifactId } as const;
    const target = {
      kind: 'requirement',
      entity_id: requirement.id,
      revision_id: requirement.revision_id,
    } as const;
    const selectionId = uuidv7();
    // Published by the provider process while the caller waits on its answer: the one window in
    // which what governs a revision can move after the manifest froze it.
    const adoptPath = path.join(f.scratchParentDir, 'adopt.json');
    await writeFile(
      adoptPath,
      JSON.stringify({
        authority: f.authority,
        selection: {
          selection_id: selectionId,
          kind: 'accepted',
          target,
          scope,
          designation: 'adopted',
          authorization: {
            kind: 'informed_instruction',
            instruction_source_id: instructionId,
            acknowledged: [target],
            scope,
          },
          expected_state: { kind: 'observed', selection_ids: [], correction_action_ids: [] },
        },
        selectedBy: OWNER,
        acceptedAt: AT,
      }),
      'utf8'
    );
    const second = await f.admit();

    const controller = new AbortController();
    const report = await work(f, {
      ...answering(f, 'restate', { FAKE_PROPOSER_ADOPT: adoptPath }),
      signal: controller.signal,
      // Inspect the first settlement before an automatic retry advances the job.
      sleep: async () => controller.abort(),
    });

    const attempts = f.attempts(second.jobId);
    expect(attempts).toHaveLength(1);
    const settled = attempts[0]!;
    expect(settled.outcome).toBe('failed');
    expect(settled.publishingOperationId).toBeNull();
    expect(f.job(second.jobId), report.detail).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'governing_state_moved',
    });
    const detail = settled.detail as {
      reconciliation_plan: { records: unknown[] };
      governing_state_moved: { current: { selection_ids: string[] } };
    };
    // The plan is retained with the attempt, and what stands now travelled back with the refusal.
    expect(detail.reconciliation_plan.records.length).toBeGreaterThan(0);
    expect(detail.governing_state_moved.current.selection_ids).toEqual([selectionId]);
    // A later selection was never overwritten and nothing of the plan reached the store.
    expect(
      read<ReturnType<typeof readProjectPassageRestatements>>(f, (view) =>
        readProjectPassageRestatements(view, {
          kind: 'requirement',
          entity_id: requirement.id,
          revision_id: requirement.revision_id!,
        })
      ).occurrences
    ).toBe(0);

    // The job is reconsidered at a newer boundary, under the same limits, and publishes then.
    await retryProcessingJob(f.handle, { jobId: second.jobId, now: new Date().toISOString() });
    await work(f, answering(f, 'restate'));

    const reconsidered = f.attempts(second.jobId)[0]!;
    expect(reconsidered.outcome).toBe('succeeded');
    expect(reconsidered.publishingOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(publishedBy(result(f, second.jobId)).length).toBeGreaterThan(0);
  }, 120_000);
});

describe("a person's correction", () => {
  it('changes what the next answer is made against without erasing the earlier revision', async () => {
    const f = await fixture();
    const first = await f.admit();
    await work(f, answering(f, 'multi'));
    const requirement = publishedBy(result(f, first.jobId))[0]!;
    const scope = { kind: 'artifact', artifact_id: f.artifactId } as const;
    const target = {
      kind: 'requirement',
      entity_id: requirement.id,
      revision_id: requirement.revision_id,
    } as const;
    const instructionId = await instructionSource(
      f,
      'Withdraw the flush-before-reporting rule: it is no longer a product promise.'
    );
    const sourceId = await instructionSource(f, 'The rule was withdrawn in review.');

    const withdrawal = await appendProjectCorrection(f.handle, {
      operationId: uuidv7(),
      action: {
        action_id: uuidv7(),
        kind: 'withdrawal',
        targets: [target],
        scope,
        source_id: sourceId,
        authorization: {
          kind: 'informed_instruction',
          instruction_source_id: instructionId,
          acknowledged: [target],
          scope,
        },
        expected_state: { kind: 'observed', selection_ids: [], correction_action_ids: [] },
        reason: 'Flushing before reporting is no longer a product promise.',
      },
      attributedTo: { kind: 'actor', actor: OWNER },
      recordedAt: AT,
      secretAllow: [],
    });

    const second = await f.admit();
    await work(f, answering(f, 'restate'));

    // The next answer was made against the corrected state: what the plan rests on names the
    // person's correction, which nothing the detector published could have put there.
    const plan = (
      f.attempts(second.jobId)[0]!.detail as {
        reconciliation_plan: {
          expected_state: { state: { correction_action_ids: string[] } }[];
        };
      }
    ).reconciliation_plan;
    expect(plan.expected_state.flatMap((entry) => entry.state.correction_action_ids)).toContain(
      withdrawal.value.actionId
    );

    // And history is intact: the revision the correction is about is still readable, with the
    // correction beside it rather than in place of it.
    const retained = read<ReturnType<typeof readProjectRequirement>>(f, (view) =>
      readProjectRequirement(view, requirement.id)
    );
    expect(retained?.revisions.map((revision) => revision.revisionId)).toEqual([
      requirement.revision_id,
    ]);
    expect(
      read<ReturnType<typeof listProjectCorrections>>(f, (view) =>
        listProjectCorrections(view, { kind: 'requirement', entityId: requirement.id })
      ).map((row) => row.kind)
    ).toContain('withdrawal');
  }, 120_000);
});
