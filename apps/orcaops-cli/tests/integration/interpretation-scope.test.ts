import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { listProjectCorrections } from '@orcaops/storage/history/database';

import { capturePlanAction } from '../../src/commands/capture/plan.js';
import {
  knowledgeLookupAction,
  type KnowledgeLookupAnswer,
} from '../../src/commands/knowledge/lookup.js';
import { runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const TASK_INSTRUCTION = 'Assemble the calibration packet for this run.';
const TASK_QUESTION = 'Which storage shelf should receive the finished packet?';
const PROJECT_RULE =
  'For every prism calibration, record the reference lamp serial number before warming the chamber.';
const OBSERVATION = 'The amber reference lamp currently takes 18 seconds to warm.';
const CORRECTED_FACT = 'The amber reference lamp currently takes 7 seconds to warm.';

const fixtures: WorkerFixture[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function output<T>(fixture: WorkerFixture, action: () => Promise<void>): Promise<T> {
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runInInvocationContext(
      {
        cwd: fixture.repoPath,
        env: {
          ...fixture.env,
          ORCAOPS_DISABLE_DRAIN: '1',
          ORCAOPS_KNOWLEDGE_WORKER_START: '0',
        },
      },
      action
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return JSON.parse(chunks.join('')) as T;
}

async function capture(
  fixture: WorkerFixture,
  input: {
    task: string;
    step: string;
    criterion: string;
  }
): Promise<{ artifactId: string; jobId: string }> {
  const filename = path.join(fixture.scratchParentDir, `capture-${uuidv7()}.json`);
  await writeFile(
    filename,
    JSON.stringify({
      idempotency_key: uuidv7(),
      task: input.task,
      label: 'Prism calibration',
      plan_steps: [
        {
          text: input.step,
          label: 'Calibration packet',
          acceptance_criteria: [{ text: input.criterion }],
        },
      ],
      touched_scope: ['calibration'],
    }),
    'utf8'
  );
  const captured = await output<{
    ok: true;
    artifact_id: string;
    plan_event_id: string;
  }>(fixture, () => capturePlanAction({ input: filename }));
  expect(captured.ok).toBe(true);
  const job = fixture.handle.read((view) =>
    view.get<{ jobId: string }>(
      `SELECT job_id AS jobId FROM processing_jobs
         WHERE source_kind='capture_event' AND source_id=?`,
      captured.plan_event_id
    )
  ).value;
  if (job == null) throw new Error('the captured plan admitted no processing job');
  return { artifactId: captured.artifact_id, jobId: job.jobId };
}

async function work(fixture: WorkerFixture, script: Record<string, unknown>) {
  const filename = path.join(fixture.scratchParentDir, `answers-${uuidv7()}.json`);
  await writeFile(filename, JSON.stringify({ default: script }), 'utf8');
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log() {},
    idleExitMs: 1,
    env: {
      ...fixture.env,
      FAKE_PROPOSER_ANSWER: 'scripted',
      FAKE_PROPOSER_SCRIPTS: filename,
    },
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    killGraceMs: 200,
    scratchParentDir: fixture.scratchParentDir,
  });
}

async function lookup(
  fixture: WorkerFixture,
  identity: string,
  scope: string
): Promise<KnowledgeLookupAnswer> {
  return output(fixture, () => knowledgeLookupAction({ identity: [identity], scope, json: true }));
}

function decoded<T extends { recordHex: string }>(row: T): unknown {
  return JSON.parse(Buffer.from(row.recordHex, 'hex').toString('utf8'));
}

it('normalizes task-local scope while preserving candidates and non-authoritative corrections', async () => {
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(fixture);
  const first = await capture(fixture, {
    task: `${TASK_INSTRUCTION}\n${TASK_QUESTION}`,
    step: PROJECT_RULE,
    criterion: OBSERVATION,
  });

  const interpreted = await work(fixture, {
    statements: [
      {
        quote: TASK_INSTRUCTION,
        source_form: 'task_local_criterion',
        proposed_record: 'none',
        intended_scope: { kind: 'current_task' },
      },
      {
        quote: TASK_QUESTION,
        source_form: 'question',
        proposed_record: 'none',
        intended_scope: { kind: 'current_task' },
      },
      {
        quote: PROJECT_RULE,
        source_form: 'stated_obligation',
        proposed_record: 'requirement',
        intended_scope: { kind: 'project' },
      },
      {
        quote: OBSERVATION,
        source_form: 'observation',
        proposed_record: 'claim',
        intended_scope: { kind: 'project' },
      },
    ],
  });

  expect(interpreted.callsMade).toBe(1);
  expect(fixture.job(first.jobId).state).toBe('completed');
  const interpretations = fixture.handle.read((view) =>
    view.all<{
      sourceForm: string;
      proposedRecord: string;
      scopeKind: string;
      scopeValue: string | null;
      outcomeKind: string;
      recordHex: string;
    }>(
      `SELECT source_form AS sourceForm, proposed_record_kind AS proposedRecord,
              intended_scope_kind AS scopeKind, intended_scope_value AS scopeValue,
              outcome_kind AS outcomeKind, hex(record_bytes) AS recordHex
         FROM knowledge_interpretations WHERE origin_artifact_id=? ORDER BY source_form`,
      first.artifactId
    )
  ).value;
  const taskOnly = interpretations.filter(({ proposedRecord }) => proposedRecord === 'none');
  expect(taskOnly).toHaveLength(2);
  expect(taskOnly).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceForm: 'task_local_criterion',
        scopeKind: 'artifact',
        scopeValue: first.artifactId,
        outcomeKind: 'none',
      }),
      expect.objectContaining({
        sourceForm: 'question',
        scopeKind: 'artifact',
        scopeValue: first.artifactId,
        outcomeKind: 'none',
      }),
    ])
  );
  expect(taskOnly.map(decoded)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        wording: TASK_INSTRUCTION,
        source_origin: expect.objectContaining({
          task: expect.objectContaining({ artifact_id: first.artifactId }),
        }),
        intended_scope: { kind: 'artifact', artifact_id: first.artifactId },
        canonical_outcome: { kind: 'none', target: null },
      }),
      expect.objectContaining({
        wording: TASK_QUESTION,
        source_origin: expect.objectContaining({
          task: expect.objectContaining({ artifact_id: first.artifactId }),
        }),
        intended_scope: { kind: 'artifact', artifact_id: first.artifactId },
        canonical_outcome: { kind: 'none', target: null },
      }),
    ])
  );

  const requirements = fixture.handle.read((view) =>
    view.all<{ recordHex: string }>(
      'SELECT hex(record_bytes) AS recordHex FROM requirement_revisions'
    )
  ).value;
  expect(requirements).toHaveLength(1);
  expect(decoded(requirements[0]!)).toMatchObject({
    statement: PROJECT_RULE,
    source_standing: 'extracted_candidate',
  });
  expect(
    interpretations.find(({ proposedRecord }) => proposedRecord === 'requirement')
  ).toMatchObject({ scopeKind: 'project', scopeValue: null, outcomeKind: 'candidate_revision' });
  expect(
    fixture.handle.read(
      (view) => view.get<{ n: number }>('SELECT count(*) AS n FROM decision_revisions')!.n
    ).value
  ).toBe(0);

  const originalClaims = fixture.handle.read((view) =>
    view.all<{ claimId: string; revisionId: string; recordHex: string; recordSha256: string }>(
      `SELECT claim_id AS claimId, revision_id AS revisionId,
              hex(record_bytes) AS recordHex, record_sha256 AS recordSha256
         FROM claim_revisions ORDER BY rowid`
    )
  ).value;
  expect(originalClaims).toHaveLength(1);
  const claim = originalClaims[0]!;
  expect(decoded(claim)).toMatchObject({ statement: OBSERVATION });

  const second = await capture(fixture, {
    task: `${CORRECTED_FACT} Correct the earlier warm-up observation.`,
    step: 'Update the packet with the corrected warm-up measurement.',
    criterion: 'The packet shows the corrected measurement.',
  });
  const corrected = await work(fixture, {
    corrections: [
      {
        kind: 'factual_correction',
        statement: OBSERVATION,
        account: CORRECTED_FACT,
      },
    ],
  });

  expect(corrected.callsMade).toBe(1);
  expect(fixture.job(second.jobId).state).toBe('completed');
  expect(
    fixture.handle.read((view) =>
      view.all<{ claimId: string; revisionId: string; recordHex: string; recordSha256: string }>(
        `SELECT claim_id AS claimId, revision_id AS revisionId,
                hex(record_bytes) AS recordHex, record_sha256 AS recordSha256
           FROM claim_revisions ORDER BY rowid`
      )
    ).value
  ).toEqual(originalClaims);
  const corrections = fixture.handle.read((view) =>
    listProjectCorrections(view, { kind: 'claim', entityId: claim.claimId })
  ).value;
  expect(corrections).toHaveLength(1);
  expect(corrections[0]).toMatchObject({
    kind: 'factual_correction',
    changedWhatStands: false,
    authorizationKind: null,
    authorizationId: null,
    adopted: null,
    targets: [{ kind: 'claim', entityId: claim.claimId, revisionId: claim.revisionId }],
  });
  expect(decoded(corrections[0]!)).toMatchObject({
    kind: 'factual_correction',
    corrected_account: CORRECTED_FACT,
  });

  const answer = await lookup(fixture, `claim:${claim.claimId}`, `artifact:${second.artifactId}`);
  expect(answer.applicable).toEqual([]);
  expect(answer.proposals).toContainEqual(
    expect.objectContaining({
      key: `claim:${claim.claimId}`,
      kind: 'correction',
      correction: expect.objectContaining({
        action_id: corrections[0]!.actionId,
        kind: 'factual_correction',
        accepted_by: null,
      }),
    })
  );
  expect(
    fixture.handle.read((view) => view.get<{ n: number }>('SELECT count(*) AS n FROM adoptions')!.n)
      .value
  ).toBe(0);
});
