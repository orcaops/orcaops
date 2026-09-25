import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { DecisionRevisionSchema, KnowledgeInterpretationSchema } from '@orcaops/storage';

import { runKnowledgeWorker } from './loop.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from './worker-fixture.test-support.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const fixtures: WorkerFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function work(
  fixture: WorkerFixture,
  script: object,
  options: { codex?: boolean; damage?: string } = {}
) {
  const scriptsPath = path.join(fixture.scratchParentDir, 'proposer-answers.json');
  await writeFile(scriptsPath, JSON.stringify({ default: script }));
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: options.codex
      ? { claude: 'absent', codex: 'present' }
      : { claude: 'present', codex: 'absent' },
    env: {
      ...fixture.env,
      FAKE_PROPOSER_ANSWER: 'scripted',
      FAKE_PROPOSER_SCRIPTS: scriptsPath,
      ...(options.damage === undefined ? {} : { FAKE_PROPOSER_JSON_DAMAGE: options.damage }),
    },
    idleExitMs: 1,
    heartbeatMs: 250,
    leaseTermMs: 2_000,
    killGraceMs: 200,
    scratchParentDir: fixture.scratchParentDir,
    log: () => undefined,
  });
}

it.each(
  (['claude', 'codex'] as const).flatMap((providerId) =>
    ['trailing-comma', 'extra-brace'].map((damage) => ({ providerId, damage }))
  )
)(
  'saves repaired $providerId output with its original answer and keeps content validation ($damage)',
  async ({ providerId, damage }) => {
    const fixture = await knowledgeWorkerFixture({
      provider: KNOWLEDGE_PROPOSER,
      providerId,
    });
    fixtures.push(fixture);
    const rule = 'Cart totals must be checked before checkout completes.';
    const { jobId } = await fixture.admit({ task: rule });
    expect(
      await work(
        fixture,
        {
          statements: [
            {
              quote: rule,
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              intended_scope: { kind: 'project' },
            },
            {
              quote: rule,
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              intended_scope: { kind: 'project' },
              citation_fault: 'unknown_segment',
            },
          ],
        },
        { codex: providerId === 'codex', damage }
      )
    ).toMatchObject({ callsMade: 1 });

    const job = fixture.job(jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({
      interpretation_quality: {
        outcome: 'partial',
        accepted: { statements: 1 },
        rejected: { statements: 1 },
      },
    });
    const attempts = fixture.attempts(jobId);
    expect(attempts).toHaveLength(1);
    const detail = attempts[0].detail as {
      json_repair: {
        originalBody: string;
        repairedBody: string;
        edits: Array<{ offset: number; removed: string; inserted: string }>;
      };
    };
    const repair = detail.json_repair;
    expect(() => JSON.parse(repair.originalBody)).toThrow();
    expect(JSON.parse(repair.repairedBody).statements).toHaveLength(2);
    expect(repair.edits).toHaveLength(1);
    expect(job.result).toMatchObject({ json_repair: repair });
    expect(
      fixture.handle.read((view) => ({
        requirements: view.get<{ count: number }>(
          'SELECT count(*) AS count FROM requirement_revisions'
        )!.count,
        adoptions: view.get<{ count: number }>('SELECT count(*) AS count FROM adoptions')!.count,
      })).value
    ).toEqual({ requirements: 1, adoptions: 0 });
  },
  30_000
);

it('does not publish a repaired answer with the wrong manifest', async () => {
  const fixture = await knowledgeWorkerFixture({
    provider: KNOWLEDGE_PROPOSER,
    providerId: 'codex',
  });
  fixtures.push(fixture);
  const { jobId } = await fixture.admit();
  expect(
    await work(
      fixture,
      { manifest_sha256: '0'.repeat(64) },
      { codex: true, damage: 'trailing-comma' }
    )
  ).toMatchObject({ callsMade: 1 });
  expect(fixture.job(jobId).state).not.toBe('completed');
  expect(fixture.attempts(jobId)[0].detail).toMatchObject({
    json_repair: { originalBody: expect.any(String), repairedBody: expect.any(String) },
    failures: expect.arrayContaining([expect.objectContaining({ rule: 'MANIFEST_MISMATCH' })]),
  });
  expect(
    fixture.handle.read(
      (view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM knowledge_interpretations')!
          .count
    ).value
  ).toBe(0);
}, 30_000);

it('saves an independent rule and cited rejected alternative despite invalid optional parts', async () => {
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(fixture);
  const observation = 'Cart totals are checked before checkout completes.';
  const earlier = await fixture.admit({ task: observation });
  expect(
    await work(fixture, {
      statements: [
        {
          quote: observation,
          source_form: 'observation',
          proposed_record: 'claim',
          intended_scope: { kind: 'project' },
        },
      ],
    })
  ).toMatchObject({ callsMade: 1 });
  expect(fixture.job(earlier.jobId).state).toBe('completed');

  const rule = 'Cart totals must be checked before checkout completes.';
  const decision = 'Use the embedded queue.';
  const option = 'Use a hosted queue.';
  const rejection = 'The hosted queue needs a network connection.';
  const { jobId } = await fixture.admit({ task: [rule, decision, option, rejection].join('\n') });
  expect(
    await work(fixture, {
      statements: [
        {
          quote: rule,
          source_form: 'stated_obligation',
          proposed_record: 'requirement',
          intended_scope: { kind: 'project' },
          links: [{ statement: observation, relation: 'exact_restatement' }],
        },
        {
          quote: decision,
          source_form: 'stated_decision',
          proposed_record: 'decision',
          intended_scope: { kind: 'project' },
          alternatives: [
            { option, rejected_because: rejection },
            { option, rejected_because: 'An unstated licensing restriction rules it out.' },
          ],
        },
      ],
    })
  ).toMatchObject({ callsMade: 1 });

  const job = fixture.job(jobId);
  expect(job.state).toBe('completed');
  const expectedQuality = {
    outcome: 'partial',
    proposed: { statements: 2, links: 1, alternatives: 2 },
    accepted: { statements: 2, links: 0, alternatives: 1 },
    rejected: { statements: 0, links: 1, alternatives: 1 },
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ collection: 'links', rule: 'IDENTITY_KIND_MISMATCH' }),
      expect.objectContaining({ collection: 'alternatives', rule: 'ITEM_SCHEMA_INVALID' }),
    ]),
  };
  expect(job.result).toMatchObject({ interpretation_quality: expectedQuality });
  expect(fixture.attempts(jobId)).toHaveLength(1);
  expect(fixture.attempts(jobId)[0].detail).toMatchObject({
    interpretation_quality: expectedQuality,
  });

  const saved = fixture.handle.read((view) => ({
    requirements: view.all<{ recordHex: string }>(
      'SELECT hex(record_bytes) AS recordHex FROM requirement_revisions'
    ),
    decisions: view.all<{ recordHex: string }>(
      'SELECT hex(record_bytes) AS recordHex FROM decision_revisions'
    ),
    interpretations: view.all<{ recordHex: string }>(
      'SELECT hex(record_bytes) AS recordHex FROM knowledge_interpretations'
    ),
    relationships: view.get<{ count: number }>(
      'SELECT count(*) AS count FROM record_relationships'
    )!.count,
  })).value;
  const decode = (row: { recordHex: string }): unknown =>
    JSON.parse(Buffer.from(row.recordHex, 'hex').toString('utf8'));
  expect(saved.requirements).toHaveLength(1);
  expect(decode(saved.requirements[0])).toMatchObject({
    statement: rule,
    source_standing: 'extracted_candidate',
  });
  expect(saved.decisions).toHaveLength(1);
  expect(DecisionRevisionSchema.parse(decode(saved.decisions[0]))).toMatchObject({
    chosen_approach: decision,
    alternatives: [{ option, rejected_because: rejection }],
    source_standing: 'extracted_candidate',
  });
  const interpretation = saved.interpretations
    .map((row) => KnowledgeInterpretationSchema.parse(decode(row)))
    .find((row) => row.wording === decision);
  expect(interpretation?.evidence.map((citation) => citation.quote)).toEqual(
    expect.arrayContaining([decision, option, rejection])
  );
  expect(saved.relationships).toBe(0);
}, 30_000);
