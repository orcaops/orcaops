import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { retrieveRelatedKnowledge } from '@orcaops/storage/history/database';

import { knowledgeEquivalenceRejectAction } from '../../src/commands/knowledge/equivalence.js';
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

vi.mock('node:tty', async (original) => ({
  ...(await original<typeof import('node:tty')>()),
  isatty: () => true,
}));

const fixtures: WorkerFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const RULE = 'Audit exports must sort invoice entries by ascending invoice number.';
const PARAPHRASE =
  'Always put the smallest invoice number first when sorting audit export entries.';

async function work(fixture: WorkerFixture, script: unknown) {
  const filename = path.join(fixture.scratchParentDir, 'answers.json');
  await writeFile(filename, JSON.stringify({ default: script }));
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log() {},
    idleExitMs: 1,
    env: { ...fixture.env, FAKE_PROPOSER_SCRIPTS: filename, FAKE_PROPOSER_ANSWER: 'scripted' },
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    killGraceMs: 200,
    scratchParentDir: fixture.scratchParentDir,
  });
}

async function output(fixture: WorkerFixture, action: () => Promise<void>): Promise<unknown> {
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runInInvocationContext({ cwd: fixture.repoPath, env: fixture.env }, action);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return JSON.parse(chunks.join(''));
}

it('discovers a reworded rule through ordinary retrieval and keeps a rejected match independently readable', async () => {
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(fixture);
  const first = await fixture.captureAndAdmit(RULE);
  expect(
    (
      await work(fixture, {
        statements: [
          {
            quote: RULE,
            source_form: 'stated_obligation',
            proposed_record: 'requirement',
            intended_scope: { kind: 'project' },
          },
        ],
      })
    ).callsMade
  ).toBe(1);
  expect(
    fixture.job(first.jobId),
    JSON.stringify(
      fixture
        .attempts(first.jobId)
        .map((attempt) => ({ outcome: attempt.outcome, detail: attempt.detail }))
    )
  ).toMatchObject({ state: 'completed' });
  const original = fixture.handle.read((view) =>
    view.all<{ revisionId: string; recordHex: string }>(
      'SELECT revision_id AS revisionId, hex(record_bytes) AS recordHex FROM requirement_revisions'
    )
  ).value;
  expect(original).toHaveLength(1);

  const second = await fixture.captureAndAdmit(PARAPHRASE);
  const secondJob = fixture.job(second.jobId);
  if (secondJob.source.kind !== 'capture_event') throw new Error('Expected the new capture job');
  const secondEventId = secondJob.source.event_id;
  const boundary = fixture.handle.read(() => null).counters.writeSequence;
  const retrieved = fixture.handle.read((view) =>
    retrieveRelatedKnowledge(view, {
      projectId: fixture.projectId,
      source: {
        artifactId: second.artifactId,
        eventId: secondEventId,
        planEventId: secondEventId,
        text: PARAPHRASE,
      },
      scope: { kind: 'artifact', artifact_id: second.artifactId },
      boundary,
      bounds: {
        maxIdentities: 24,
        maxStatementBytes: 16384,
        maxSearchTerms: 12,
        maxSearchHits: 50,
        maxSourcesFollowed: 64,
      },
    })
  ).value;
  const discovered = retrieved.entries.find((entry) =>
    entry.statements.some((statement) => statement.revision.revision_id === original[0]!.revisionId)
  );
  expect(discovered!.resolved.basis.scope).toEqual({
    kind: 'artifact',
    artifact_id: second.artifactId,
  });
  expect(
    discovered!.statements.find(
      (statement) => statement.revision.revision_id === original[0]!.revisionId
    )!.intended_scope
  ).toEqual({ kind: 'project' });
  expect(
    (
      await work(fixture, {
        statements: [
          {
            quote: PARAPHRASE,
            wording: 'Audit exports order invoices from lowest number to highest.',
            source_form: 'stated_obligation',
            proposed_record: 'requirement',
            intended_scope: { kind: 'project' },
            links: [{ statement: RULE, relation: 'equivalent_to' }],
          },
        ],
      })
    ).callsMade
  ).toBe(1);
  expect(fixture.job(second.jobId).state).toBe('completed');
  const providerBeforeRead = await readFile(fixture.providerRecordPath, 'utf8');
  expect(JSON.parse(providerBeforeRead).stdin).toContain(RULE);

  const lookup = async () =>
    (await output(fixture, () =>
      knowledgeLookupAction({
        text: 'audit export invoice',
        scope: `artifact:${second.artifactId}`,
        json: true,
      })
    )) as KnowledgeLookupAnswer;
  const before = await lookup();
  const match = before.interpretations?.find(
    ({ interpretation }) => interpretation.source_origin.task?.artifact_id === second.artifactId
  );
  expect(match).toMatchObject({
    equivalenceStatus: 'proposed',
    interpretation: {
      wording: 'Audit exports order invoices from lowest number to highest.',
      evidence: [{ quote: PARAPHRASE }],
      canonical_outcome: {
        kind: 'proposed_equivalence',
        target: { revision_id: original[0]!.revisionId },
      },
    },
  });
  const interpretationId = match!.interpretation.interpretation_id;
  const rejectionFile = path.join(fixture.scratchParentDir, 'reject.json');
  await writeFile(
    rejectionFile,
    JSON.stringify({
      operation_id: uuidv7(),
      interpretation_id: interpretationId,
      disposition: 'rejected',
      reason: 'Keep this interpretation separate until its scope is confirmed.',
      recorded_at: new Date().toISOString(),
    })
  );
  const reject = () => knowledgeEquivalenceRejectAction({ input: rejectionFile, json: true });
  expect(await output(fixture, reject)).toMatchObject({
    ok: true,
    interpretation_id: interpretationId,
  });
  expect(await output(fixture, reject)).toMatchObject({
    ok: true,
    interpretation_id: interpretationId,
  });
  const after = await lookup();
  expect(
    after.interpretations?.find(
      ({ interpretation }) => interpretation.interpretation_id === interpretationId
    )
  ).toMatchObject({
    interpretation: match!.interpretation,
    equivalenceStatus: 'rejected',
    rejection: { reason: 'Keep this interpretation separate until its scope is confirmed.' },
  });
  expect(after.applicable).toEqual([]);
  const retained = fixture.handle.read((view) => ({
    originals: view.all(
      'SELECT revision_id AS revisionId, hex(record_bytes) AS recordHex FROM requirement_revisions'
    ),
    adoptions: view.get<{ n: number }>('SELECT count(*) AS n FROM adoptions')!.n,
    uses: view.get<{ n: number }>('SELECT count(*) AS n FROM task_uses')!.n,
    rejections: view.get<{ n: number }>(
      'SELECT count(*) AS n FROM knowledge_equivalence_dispositions'
    )!.n,
  })).value;
  expect(retained).toEqual({ originals: original, adoptions: 0, uses: 0, rejections: 1 });
  expect(await readFile(fixture.providerRecordPath, 'utf8')).toBe(providerBeforeRead);
});
