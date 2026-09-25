import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  readInterpretationProgress,
  reopenProcessingJob,
  retryProcessingJob,
} from '@orcaops/storage/history/database';

import { knowledgeStatusAction } from '../../src/commands/knowledge/status.js';
import { runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';

const publication = vi.hoisted(() => ({
  calls: 0,
  failAt: null as number | null,
  failure: null as 'unavailable' | 'governing_state_moved' | 'refused' | null,
  loseAcknowledgementAt: null as number | null,
}));
vi.mock('../../src/knowledge-worker/publication.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/knowledge-worker/publication.js')>();
  return {
    ...actual,
    async publishReconciliationPlanAndSettleAttempt(
      ...args: Parameters<typeof actual.publishReconciliationPlanAndSettleAttempt>
    ) {
      publication.calls += 1;
      if (publication.calls === publication.failAt && publication.failure === 'unavailable') {
        return {
          kind: 'unavailable' as const,
          code: 'TRANSACTION_FAILED',
          detail: 'Injected transient publication failure',
        };
      }
      if (publication.calls === publication.failAt && publication.failure === 'refused') {
        return {
          kind: 'refused' as const,
          code: 'IDENTITY_TAKEN',
          detail: 'Injected publication refusal',
        };
      }
      if (
        publication.calls === publication.failAt &&
        publication.failure === 'governing_state_moved'
      ) {
        return {
          kind: 'governing_state_moved' as const,
          record: null,
          target: null,
          current: { selection_ids: [], correction_action_ids: [] },
          detail: 'Injected governing state movement',
        };
      }
      const completed = await actual.publishReconciliationPlanAndSettleAttempt(...args);
      if (publication.calls === publication.loseAcknowledgementAt)
        throw new Error('Injected acknowledgement loss after commit');
      return completed;
    },
  };
});

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const fixtures: WorkerFixture[] = [];

afterEach(async () => {
  publication.calls = 0;
  publication.failAt = null;
  publication.failure = null;
  publication.loseAcknowledgementAt = null;
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function work(fixture: WorkerFixture) {
  const stop = new AbortController();
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log() {},
    idleExitMs: 1,
    signal: stop.signal,
    sleep: async () => stop.abort(),
    env: fixture.env,
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    revalidateMs: 100_000,
    scratchParentDir: fixture.scratchParentDir,
  });
}

async function status(fixture: WorkerFixture): Promise<Record<string, unknown>> {
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    await runInInvocationContext({ cwd: fixture.repoPath, env: fixture.env }, () =>
      knowledgeStatusAction({ json: true })
    );
  } finally {
    write.mockRestore();
  }
  return JSON.parse(output.join('').trim().split('\n').at(-1)!) as Record<string, unknown>;
}

async function segmentedFixture() {
  const task = Array.from(
    { length: 1_600 },
    (_, index) => `Note ${index} is kept until the server acknowledges it.\n`
  ).join('');
  const fixture = await knowledgeWorkerFixture({
    provider: KNOWLEDGE_PROPOSER,
    task,
    proposerAnswer: 'scripted',
  });
  fixtures.push(fixture);
  const scriptsPath = path.join(fixture.scratchParentDir, 'proposals.json');
  await writeFile(
    scriptsPath,
    JSON.stringify({
      default: {
        statements: [
          {
            quote: 'Note 0 is kept until the server acknowledges it.',
            source_form: 'stated_obligation',
            proposed_record: 'requirement',
          },
        ],
      },
    })
  );
  fixture.env.FAKE_PROPOSER_SCRIPTS = scriptsPath;
  const { jobId } = await fixture.captureAndAdmit(task);
  await fixture.writeConfig({
    enabled: true,
    max_attempts: 6,
    max_input_bytes: 80_000,
  });
  return { fixture, jobId };
}

it.each([
  {
    name: 'first unit after a transient publication failure',
    failAt: 1,
    unit: 0,
    failure: 'unavailable' as const,
    waitReason: 'publication_failed',
  },
  {
    name: 'middle unit after governing state moves',
    failAt: 2,
    unit: 1,
    failure: 'governing_state_moved' as const,
    waitReason: 'governing_state_moved',
  },
])('retries the $name', async ({ failAt, unit, failure, waitReason }) => {
  const { fixture, jobId } = await segmentedFixture();

  publication.failAt = failAt;
  publication.failure = failure;
  const interrupted = await work(fixture);
  const beforeRetry = fixture.attempts(jobId).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const failed = beforeRetry.at(-1)!;
  expect(failed.detail).toMatchObject({
    unit: { index: unit },
    unit_settled: false,
  });
  expect(failed.detail).not.toMatchObject({ interpretation_unit_receipt: expect.anything() });
  expect(fixture.job(jobId).waitReason).toBe(waitReason);
  expect(readInterpretationProgress(fixture.handle, jobId)?.receipts).toHaveLength(failAt - 1);
  expect(await status(fixture)).toMatchObject({
    queue: { jobs: { retryable_failure: 1 } },
    coverage: { claim: 'partial' },
  });

  await retryProcessingJob(fixture.handle, { jobId, now: new Date().toISOString() });
  const recovered = await work(fixture);
  const attempts = fixture.attempts(jobId).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const unitCount = (attempts[0]!.detail as { unit: { count: number } }).unit.count;

  expect(attempts[failAt]!.detail).toMatchObject({
    unit: { index: unit },
    unit_settled: true,
  });
  expect(interrupted.callsMade + recovered.callsMade).toBe(unitCount + 1);
  expect(attempts).toHaveLength(unitCount + 1);

  const published = attempts.flatMap(
    (attempt) =>
      (attempt.detail as { published?: { kind: string; id: string; revision_id: string | null }[] })
        .published ?? []
  );
  const revisions = published.filter((entry) => entry.kind === 'requirement_revision');
  expect(revisions).toHaveLength(1);
  expect(new Set(revisions.map((entry) => entry.id)).size).toBe(revisions.length);
  expect(new Set(revisions.map((entry) => entry.revision_id)).size).toBe(revisions.length);

  const retained = fixture.handle.read((view) =>
    view.all<{ requirementId: string; revisionId: string; recordSha256: string }>(
      `SELECT requirement_id AS requirementId, revision_id AS revisionId,
              record_sha256 AS recordSha256
         FROM requirement_revisions ORDER BY revision_id`
    )
  ).value;
  expect(retained).toHaveLength(revisions.length);
  expect(new Set(retained.map((entry) => entry.requirementId)).size).toBe(retained.length);
  expect(new Set(retained.map((entry) => entry.revisionId)).size).toBe(retained.length);
  expect(new Set(retained.map((entry) => entry.recordSha256)).size).toBe(retained.length);
  expect(retained.map((entry) => entry.revisionId).sort()).toEqual(
    revisions.map((entry) => entry.revision_id).sort()
  );

  expect(fixture.job(jobId).state).toBe('completed');
  expect(await status(fixture)).toMatchObject({
    queue: { jobs: { completed: 1 } },
    coverage: { claim: 'complete' },
  });
  const progress = readInterpretationProgress(fixture.handle, jobId);
  expect(progress?.receipts).toHaveLength(unitCount);
  expect(progress?.receipts[0]!.quality.outcome).toBe('accepted');
  expect(progress?.receipts.slice(1).every((receipt) => receipt.quality.outcome === 'empty')).toBe(
    true
  );

  const restarted = await work(fixture);
  expect(restarted.callsMade).toBe(0);
  expect(fixture.attempts(jobId)).toHaveLength(unitCount + 1);
  expect(readInterpretationProgress(fixture.handle, jobId)).toEqual(progress);
  expect(
    fixture.handle.read((view) =>
      view.all<{ revisionId: string }>(
        'SELECT revision_id AS revisionId FROM requirement_revisions ORDER BY revision_id'
      )
    ).value
  ).toEqual(retained.map(({ revisionId }) => ({ revisionId })));
});

it('continues a reopened job at the unit after the receipts it kept', async () => {
  const { fixture, jobId } = await segmentedFixture();

  publication.failAt = 2;
  publication.failure = 'refused';
  await work(fixture);
  const gaveUp = fixture.job(jobId);
  expect(gaveUp.state).toBe('terminal_failure');
  const kept = readInterpretationProgress(fixture.handle, jobId)?.receipts;
  expect(kept).toHaveLength(1);

  const reopened = await reopenProcessingJob(fixture.handle, {
    reopeningId: uuidv7(),
    jobId,
    expectedUpdatedAt: gaveUp.updatedAt,
    expectedPreviousSequence: null,
    attemptsAllowed: 6,
    reopenedAt: new Date().toISOString(),
    reopenedBy: 'owner@example.test',
    reopenedByBasis: 'authenticated',
    grantId: 'reopening-grant',
  });
  expect(reopened.outcome).toBe('reopened');
  await work(fixture);

  const attempts = fixture.attempts(jobId).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const unitCount = (attempts[0]!.detail as { unit: { count: number } }).unit.count;
  expect(fixture.job(jobId).state).toBe('completed');
  expect(attempts).toHaveLength(unitCount + 1);
  expect(attempts[1]!.detail).toMatchObject({ unit: { index: 1 }, unit_settled: false });
  expect(attempts[2]!.detail).toMatchObject({ unit: { index: 1 }, unit_settled: true });
  const progress = readInterpretationProgress(fixture.handle, jobId);
  expect(progress?.receipts).toHaveLength(unitCount);
  expect(progress?.receipts[0]).toEqual(kept![0]);
});

it('restarts after a lost completion acknowledgement without another provider call', async () => {
  const fixture = await knowledgeWorkerFixture({
    provider: KNOWLEDGE_PROPOSER,
    proposerAnswer: 'statement',
  });
  fixtures.push(fixture);
  const { jobId } = await fixture.captureAndAdmit();
  publication.loseAcknowledgementAt = 1;

  const uncertain = await work(fixture);

  expect(uncertain.callsMade).toBe(1);
  expect(uncertain.outcome).toBe('stopped');
  expect(fixture.job(jobId).state).toBe('completed');
  const [attempt] = fixture.attempts(jobId);
  expect(attempt).toMatchObject({
    outcome: 'succeeded',
    publishingOperationId: expect.any(String),
  });
  const detail = attempt.detail as {
    completion_request_sha256: string;
    published: { kind: string; id: string; revision_id: string | null; replay: boolean }[];
  };
  const retained = fixture.handle.read((view) =>
    view.all<{
      requirementId: string;
      revisionId: string;
      recordSha256: string;
      operationId: string;
    }>(
      `SELECT requirement_id AS requirementId, revision_id AS revisionId,
              record_sha256 AS recordSha256, operation_id AS operationId
         FROM requirement_revisions ORDER BY revision_id`
    )
  ).value;
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    requirementId: expect.any(String),
    revisionId: expect.any(String),
    recordSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    operationId: attempt.publishingOperationId,
  });
  expect(detail.completion_request_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(detail.published.map((entry) => entry.kind)).toEqual([
    'interpretation',
    'requirement_revision',
  ]);
  expect(detail.published.find((entry) => entry.kind === 'requirement_revision')).toEqual({
    kind: 'requirement_revision',
    id: retained[0]!.requirementId,
    revision_id: retained[0]!.revisionId,
    replay: false,
  });
  const receipt = fixture.handle.read((view) =>
    view.get<{ operationKind: string; resultJson: string }>(
      `SELECT operation_kind AS operationKind, result_json AS resultJson
         FROM operations WHERE operation_id=?`,
      attempt.publishingOperationId
    )
  ).value;
  expect(receipt?.operationKind).toBe('knowledge.interpretation.complete');
  expect(JSON.parse(receipt!.resultJson)).toMatchObject({
    publication: {
      published: expect.arrayContaining([
        {
          kind: 'requirement_revision',
          id: retained[0]!.requirementId,
          revisionId: retained[0]!.revisionId,
          replay: false,
        },
      ]),
    },
    publishingOperationId: attempt.publishingOperationId,
    completionRequestSha256: detail.completion_request_sha256,
  });
  const knowledgeRows = fixture.knowledgeRows();

  const restarted = await work(fixture);

  expect(restarted.callsMade).toBe(0);
  expect(publication.calls).toBe(1);
  expect(fixture.attempts(jobId)).toHaveLength(1);
  expect(fixture.knowledgeRows()).toBe(knowledgeRows);
  expect(
    fixture.handle.read((view) =>
      view.all<{
        requirementId: string;
        revisionId: string;
        recordSha256: string;
        operationId: string;
      }>(
        `SELECT requirement_id AS requirementId, revision_id AS revisionId,
                record_sha256 AS recordSha256, operation_id AS operationId
           FROM requirement_revisions ORDER BY revision_id`
      )
    ).value
  ).toEqual(retained);
  expect(
    fixture.handle.read((view) =>
      view.get<{ operationKind: string; resultJson: string }>(
        `SELECT operation_kind AS operationKind, result_json AS resultJson
           FROM operations WHERE operation_id=?`,
        attempt.publishingOperationId
      )
    ).value
  ).toEqual(receipt);
});
