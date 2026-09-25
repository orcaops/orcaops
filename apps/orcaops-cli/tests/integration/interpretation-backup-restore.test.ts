import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { knowledgeEquivalenceDispositionId, uuidv7 } from '@orcaops/storage';
import {
  openProjectDatabase,
  projectDatabasePath,
  readInterpretationProgress,
  rejectProjectKnowledgeEquivalence,
} from '@orcaops/storage/history/database';

import {
  publishPendingBackup,
  restoreProjectDatabaseBackup,
  writePendingBackup,
} from '../../../../packages/storage/src/history/database/database-backup.js';
import { runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';

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
const PARAPHRASE = 'Audit exports order invoices from lowest number to highest.';
const OWNER = { identity: 'the project owner', basis: 'authenticated' } as const;

async function work(fixture: WorkerFixture, statement: Record<string, unknown>) {
  const scripts = path.join(fixture.scratchParentDir, `${uuidv7()}.json`);
  await writeFile(scripts, JSON.stringify({ default: { statements: [statement] } }));
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log() {},
    idleExitMs: 1,
    env: { ...fixture.env, FAKE_PROPOSER_ANSWER: 'scripted', FAKE_PROPOSER_SCRIPTS: scripts },
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    scratchParentDir: fixture.scratchParentDir,
  });
}

const retainedCounts = (fixture: WorkerFixture) =>
  fixture.handle.read((view) => ({
    interpretations: view.get<{ count: number }>(
      'SELECT count(*) AS count FROM knowledge_interpretations'
    )!.count,
    evidence: view.get<{ count: number }>(
      'SELECT count(*) AS count FROM knowledge_interpretation_evidence'
    )!.count,
    rejections: view.get<{ count: number }>(
      'SELECT count(*) AS count FROM knowledge_equivalence_dispositions'
    )!.count,
  })).value;

it('restores interpretations, evidence, a rejected equivalence and its unit receipt', async () => {
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(fixture);
  const first = await fixture.captureAndAdmit(RULE);
  await work(fixture, {
    quote: RULE,
    source_form: 'stated_obligation',
    proposed_record: 'requirement',
    intended_scope: { kind: 'project' },
  });
  expect(fixture.job(first.jobId).state).toBe('completed');

  const second = await fixture.captureAndAdmit(PARAPHRASE);
  await work(fixture, {
    quote: PARAPHRASE,
    source_form: 'stated_obligation',
    proposed_record: 'requirement',
    intended_scope: { kind: 'project' },
    links: [{ statement: RULE, relation: 'equivalent_to' }],
  });
  expect(fixture.job(second.jobId).state).toBe('completed');
  const interpretationId = fixture.handle.read((view) =>
    view.get<{ id: string }>(
      `SELECT interpretation_id AS id FROM knowledge_interpretations
         WHERE outcome_kind='proposed_equivalence'`
    )
  ).value?.id;
  if (interpretationId === undefined) throw new Error('the proposed equivalence was not retained');
  const identity = {
    interpretation_id: interpretationId,
    disposition: 'rejected' as const,
    reason: 'Keep the independently worded interpretation.',
    decided_by: OWNER,
  };
  await rejectProjectKnowledgeEquivalence(fixture.handle, {
    operationId: uuidv7(),
    disposition: {
      interpretation_id: interpretationId,
      disposition: 'rejected',
      reason: identity.reason,
      disposition_id: knowledgeEquivalenceDispositionId(identity),
      recorded_at: new Date().toISOString(),
    },
    decidedBy: OWNER,
    secretAllow: [],
  });

  const before = retainedCounts(fixture);
  expect(before.interpretations).toBeGreaterThan(1);
  expect(before.evidence).toBeGreaterThan(1);
  expect(before.rejections).toBe(1);
  const progress = readInterpretationProgress(fixture.handle, second.jobId);
  expect(progress?.receipts).toHaveLength(1);

  const file = projectDatabasePath(fixture.authority);
  const backup = publishPendingBackup(
    await writePendingBackup({ file, authority: fixture.authority })
  );
  fixture.handle.close();
  await restoreProjectDatabaseBackup({ authority: fixture.authority, backup: backup.name });
  const restored = await openProjectDatabase({ authority: fixture.authority, mode: 'reader' });
  try {
    expect(
      restored.read((view) => ({
        interpretations: view.get<{ count: number }>(
          'SELECT count(*) AS count FROM knowledge_interpretations'
        )!.count,
        evidence: view.get<{ count: number }>(
          'SELECT count(*) AS count FROM knowledge_interpretation_evidence'
        )!.count,
        rejections: view.get<{ count: number }>(
          'SELECT count(*) AS count FROM knowledge_equivalence_dispositions'
        )!.count,
      })).value
    ).toEqual(before);
    expect(readInterpretationProgress(restored, second.jobId)).toEqual(progress);
  } finally {
    restored.close();
  }
}, 120_000);
