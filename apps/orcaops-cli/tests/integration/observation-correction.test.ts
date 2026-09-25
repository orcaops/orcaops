import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { InterpretationManifest } from '@orcaops/core';
import { listProjectCorrections, type ProjectDatabase } from '@orcaops/storage/history/database';

import {
  knowledgeLookupAction,
  type KnowledgeLookupAnswer,
} from '../../src/commands/knowledge/lookup.js';
import { planJobAttempt } from '../../src/knowledge-worker/attempt-plan.js';
import { decideDispatch } from '../../src/knowledge-worker/dispatch.js';
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

const AVAILABILITY = { claude: 'present', codex: 'absent' } as const;
const OBSERVATION = 'Observation: the nightly audit sync took 41 seconds.';
const CORRECTED_ACCOUNT =
  'The saved timer output shows 9 seconds for that same nightly audit sync.';
const CORRECTION_SOURCE = `${CORRECTED_ACCOUNT} Correct the earlier observation.`;
const GREENHOUSE_SOURCE = 'The cedar greenhouse inspection on Monday found 18 damaged seedlings.';
const GREENHOUSE_CLAIM = 'The Monday cedar greenhouse inspection found 18 damaged seedlings.';
const GREENHOUSE_CORRECTION =
  'I misread the cedar greenhouse inspection sheet from Monday: it counted 6 damaged seedlings, not 18.';
const GREENHOUSE_CORRECTED_CLAIM =
  'The Monday cedar greenhouse inspection counted 6 damaged seedlings.';

const fixtures: WorkerFixture[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture(): Promise<WorkerFixture> {
  const value = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(value);
  return value;
}

function work(value: WorkerFixture, env: NodeJS.ProcessEnv = value.env) {
  return runKnowledgeWorker({
    authority: value.authority,
    projectId: value.projectId,
    providerAvailability: AVAILABILITY,
    log() {},
    idleExitMs: 1,
    env,
    heartbeatMs: 250,
    leaseTermMs: 5_000,
    killGraceMs: 200,
    scratchParentDir: value.scratchParentDir,
  });
}

async function manifestFor(value: WorkerFixture, jobId: string): Promise<InterpretationManifest> {
  const decision = await decideDispatch({
    handle: value.handle,
    job: value.job(jobId),
    projectId: value.projectId,
    providerAvailability: AVAILABILITY,
  });
  if (decision.outcome !== 'ready' || decision.retrieval === null)
    throw new Error(`the correction source was not dispatchable: ${JSON.stringify(decision)}`);
  const plan = planJobAttempt({
    source: decision.source,
    projectId: value.projectId,
    configuration: decision.configuration,
    attemptsRemaining: decision.configuration.maxAttempts,
    retained: [],
    completedUnitIds: [],
    retrieval: decision.retrieval,
  });
  if (plan.outcome !== 'ready')
    throw new Error(`the correction source was not scheduled: ${JSON.stringify(plan)}`);
  return plan.request.manifest;
}

async function scriptsFor(
  value: WorkerFixture,
  manifest: InterpretationManifest,
  script: Record<string, unknown>
): Promise<string> {
  const file = path.join(value.scratchParentDir, `script-${manifest.unit_id}.json`);
  await writeFile(file, JSON.stringify({ default: script }), 'utf8');
  return file;
}

async function lookup(
  value: WorkerFixture,
  identity: string,
  scope?: string
): Promise<KnowledgeLookupAnswer> {
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runInInvocationContext({ cwd: value.repoPath, env: value.env }, () =>
      knowledgeLookupAction({ identity: [identity], scope, json: true })
    );
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return JSON.parse(output.join('')) as KnowledgeLookupAnswer;
}

function retainedClaim(value: WorkerFixture) {
  return value.handle.read((view) =>
    view.all<{
      claimId: string;
      revisionId: string;
      recordHex: string;
      recordSha256: string;
    }>(
      `SELECT claim_id AS claimId, revision_id AS revisionId,
              hex(record_bytes) AS recordHex, record_sha256 AS recordSha256
         FROM claim_revisions ORDER BY rowid`
    )
  ).value;
}

function rowCount(handle: ProjectDatabase, table: string): number {
  return handle.read((view) => view.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n)
    .value;
}

it('retrieves an earlier observation and publishes its proposed factual correction', async () => {
  const value = await fixture();
  const first = await value.captureAndAdmit(OBSERVATION);

  const observed = await work(value, { ...value.env, FAKE_PROPOSER_ANSWER: 'observation' });

  expect(observed.callsMade).toBe(1);
  expect(value.job(first.jobId).state).toBe('completed');
  const original = retainedClaim(value);
  expect(original).toHaveLength(1);
  const claim = original[0]!;
  expect(JSON.parse(Buffer.from(claim.recordHex, 'hex').toString('utf8'))).toMatchObject({
    claim_id: claim.claimId,
    revision_id: claim.revisionId,
    statement: OBSERVATION,
    source_standing: 'extracted_candidate',
    attributed_to: { kind: 'detector', detector: 'knowledge-interpretation' },
  });

  const second = await value.captureAndAdmit(CORRECTION_SOURCE);
  const manifest = await manifestFor(value, second.jobId);
  const supplied = manifest.revisions.filter(
    (revision) =>
      revision.revision.kind === 'claim' &&
      revision.revision.entity_id === claim.claimId &&
      revision.revision.revision_id === claim.revisionId
  );
  expect(supplied).toEqual([
    expect.objectContaining({
      statement: OBSERVATION,
      source_standing: 'extracted_candidate',
      attributed_to: { kind: 'detector', detector: 'knowledge-interpretation' },
    }),
  ]);

  const scripts = await scriptsFor(value, manifest, {
    corrections: [
      {
        kind: 'factual_correction',
        statement: OBSERVATION,
        account: CORRECTED_ACCOUNT,
      },
    ],
  });
  const corrected = await work(value, {
    ...value.env,
    FAKE_PROPOSER_ANSWER: 'scripted',
    FAKE_PROPOSER_SCRIPTS: scripts,
  });

  expect(corrected.callsMade).toBe(1);
  expect(value.job(second.jobId).state).toBe('completed');
  const [attempt] = value.attempts(second.jobId);
  expect(attempt!.detail).toMatchObject({ manifest_sha256: manifest.manifest_sha256 });
  const providerRecordBytes = await readFile(value.providerRecordPath, 'utf8');
  const providerRecord = JSON.parse(providerRecordBytes) as {
    stdin: string;
  };
  expect(providerRecord.stdin).toContain(OBSERVATION);
  expect(providerRecord.stdin).toMatch(/k1r1 {2}claim {2}unadopted, extracted_candidate/u);
  expect(providerRecord.stdin).not.toContain(claim.revisionId);
  expect(retainedClaim(value)).toEqual(original);
  const corrections = value.handle.read((view) =>
    listProjectCorrections(view, { kind: 'claim', entityId: claim.claimId })
  ).value;
  expect(corrections).toHaveLength(1);
  expect(corrections[0]).toMatchObject({
    kind: 'factual_correction',
    changeClass: 'factual_correction',
    changedWhatStands: false,
    authorizationKind: null,
    authorizationId: null,
    adopted: null,
    targets: [{ kind: 'claim', entityId: claim.claimId, revisionId: claim.revisionId }],
  });
  expect(JSON.parse(Buffer.from(corrections[0]!.recordHex, 'hex').toString('utf8'))).toMatchObject({
    kind: 'factual_correction',
    corrected_account: CORRECTED_ACCOUNT,
  });

  const answer = await lookup(value, `claim:${claim.claimId}`, `artifact:${second.artifactId}`);
  expect(answer.applicable).toEqual([]);
  expect(answer.entries).toHaveLength(1);
  expect(answer.entries[0]!.governing_state.correction_action_ids).toEqual([]);
  expect(answer.proposals).toContainEqual(
    expect.objectContaining({
      key: `claim:${claim.claimId}`,
      kind: 'correction',
      correction: expect.objectContaining({
        action_id: corrections[0]!.actionId,
        kind: 'factual_correction',
        accepted_by: null,
      }),
      attributed_to: { kind: 'detector', detector: 'knowledge-interpretation' },
    })
  );
  expect(await readFile(value.providerRecordPath, 'utf8')).toBe(providerRecordBytes);
  expect(rowCount(value.handle, 'adoptions')).toBe(0);
});

it('rejects a correction target absent from the retrieved manifest', async () => {
  const value = await fixture();
  const admitted = await value.captureAndAdmit(CORRECTION_SOURCE);
  const manifest = await manifestFor(value, admitted.jobId);
  expect(manifest.revisions).toEqual([]);
  const scripts = await scriptsFor(value, manifest, {
    corrections: [
      {
        kind: 'factual_correction',
        ref: 'k1r1',
        account: CORRECTED_ACCOUNT,
      },
    ],
  });

  const report = await work(value, {
    ...value.env,
    FAKE_PROPOSER_ANSWER: 'scripted',
    FAKE_PROPOSER_SCRIPTS: scripts,
  });

  expect(report.callsMade).toBe(1);
  expect(value.job(admitted.jobId).state).toBe('completed');
  const [attempt] = value.attempts(admitted.jobId);
  expect(
    (attempt!.detail as { rejected_items: { rule: string }[] }).rejected_items.map(
      (item) => item.rule
    )
  ).toContain('REVISION_NOT_IN_MANIFEST');
  expect(rowCount(value.handle, 'correction_actions')).toBe(0);
  expect(rowCount(value.handle, 'adoptions')).toBe(0);
});

it('stores final link outcomes consistently with a factual correction', async () => {
  const value = await fixture();
  const seed = await value.captureAndAdmit(GREENHOUSE_SOURCE);
  const seedManifest = await manifestFor(value, seed.jobId);
  const seedScripts = await scriptsFor(value, seedManifest, {
    statements: [
      {
        quote: GREENHOUSE_SOURCE,
        wording: GREENHOUSE_CLAIM,
        source_form: 'observation',
        proposed_record: 'claim',
        intended_scope: { kind: 'unknown' },
      },
    ],
  });

  await work(value, {
    ...value.env,
    FAKE_PROPOSER_ANSWER: 'scripted',
    FAKE_PROPOSER_SCRIPTS: seedScripts,
  });
  expect(value.job(seed.jobId).state).toBe('completed');
  const [seedClaim] = retainedClaim(value);
  if (seedClaim === undefined) throw new Error('the seed observation published no claim');

  const correction = await value.captureAndAdmit(
    `${GREENHOUSE_CORRECTION} Please correct the earlier observation for that same inspection.`
  );
  const correctionManifest = await manifestFor(value, correction.jobId);
  const correctionScripts = await scriptsFor(value, correctionManifest, {
    statements: [
      {
        quote: GREENHOUSE_CORRECTION,
        wording: GREENHOUSE_CORRECTED_CLAIM,
        source_form: 'observation',
        proposed_record: 'claim',
        intended_scope: { kind: 'unknown' },
        links: [{ statement: GREENHOUSE_CLAIM, relation: 'contradicts' }],
      },
    ],
    corrections: [
      {
        kind: 'factual_correction',
        statement: GREENHOUSE_CLAIM,
        account: GREENHOUSE_CORRECTION,
      },
    ],
  });

  const report = await work(value, {
    ...value.env,
    FAKE_PROPOSER_ANSWER: 'scripted',
    FAKE_PROPOSER_SCRIPTS: correctionScripts,
  });

  expect(report.callsMade).toBe(1);
  const job = value.job(correction.jobId);
  expect(job.state).toBe('completed');
  const jobQuality = (
    job.result as {
      interpretation_quality: {
        proposed: Record<string, number>;
        accepted: Record<string, number>;
        held_back: Record<string, number>;
        rejected: Record<string, number>;
        diagnostics: { collection: string; rule: string }[];
      };
    }
  ).interpretation_quality;
  const [attempt] = value.attempts(correction.jobId);
  const attemptDetail = attempt!.detail as {
    reconciliation_plan: {
      quality: {
        proposed: Record<string, number>;
        accepted: Record<string, number>;
        held_back: Record<string, number>;
        rejected: Record<string, number>;
      };
      held_back: { reason: string; item: { kind: string } }[];
    };
  };
  const attemptQuality = attemptDetail.reconciliation_plan.quality;
  expect(attemptQuality).toEqual({
    proposed: { statements: 1, corrections: 1, links: 1, uncertainties: 0, alternatives: 0 },
    accepted: { statements: 1, corrections: 1, links: 0, uncertainties: 0, alternatives: 0 },
    held_back: { statements: 0, corrections: 0, links: 1, uncertainties: 0, alternatives: 0 },
    rejected: { statements: 0, corrections: 0, links: 0, uncertainties: 0, alternatives: 0 },
  });
  expect(jobQuality).toMatchObject(attemptQuality);
  expect(jobQuality.diagnostics).toContainEqual(
    expect.objectContaining({
      collection: 'links',
      rule: 'RECONCILIATION_INTENDED_SCOPE_NOT_NAMEABLE',
    })
  );
  expect(attemptDetail.reconciliation_plan.held_back).toContainEqual(
    expect.objectContaining({
      reason: 'intended_scope_not_nameable',
      item: expect.objectContaining({ kind: 'link' }),
    })
  );
  expect(rowCount(value.handle, 'record_relationships')).toBe(0);

  const corrections = value.handle.read((view) =>
    listProjectCorrections(view, { kind: 'claim', entityId: seedClaim.claimId })
  ).value;
  expect(corrections).toHaveLength(1);
  expect(JSON.parse(Buffer.from(corrections[0]!.recordHex, 'hex').toString('utf8'))).toMatchObject({
    kind: 'factual_correction',
    corrected_account: GREENHOUSE_CORRECTION,
  });
});
