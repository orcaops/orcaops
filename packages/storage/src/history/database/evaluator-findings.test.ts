import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';

import {
  type CapturedPlan,
  discardKnowledgeStores,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { recordChecksum } from '../event-integrity.js';
import { decodeArtifactInput } from './artifact-events.js';
import {
  type ArtifactRevision,
  prepareArtifactAppendRequest,
  readProjectArtifact,
} from './artifacts.js';
import type { ProjectDatabase } from './connection.js';
import {
  type EvaluatorRunEvidence,
  EvaluatorRunEvidenceSchema,
} from './evaluator-findings-input.js';
import {
  findProjectEvaluatorFindingRecurrence,
  pendingEvaluatorEvidenceRows,
  prepareEvaluatorEvidence,
  readProjectEvaluatorRunFindings,
  restorePendingEvaluatorEvidence,
} from './evaluator-findings.js';
import {
  appendProjectExecutionCapture,
  prepareExecutionCaptureRequest,
  prepareExecutionCaptureSettlement,
  restoreExecutionCaptureRequest,
} from './execution-capture.js';
import { readProjectExecution } from './execution-records.js';
import { readProjectObservation } from './knowledge-observations.js';
import { evaluatorRunRecordId } from './knowledge-run-observations.js';
import { runProjectOperation } from './transactions.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-17T09:10:00.000Z';
const EVALUATOR = 'core/step-coverage';
const EVIDENCE_TABLES = [
  'evaluator_run_contexts',
  'evaluator_run_findings',
  'evaluator_findings',
  'evaluator_findings_unreadable',
];

function runPayload(artifactId: string, runId: string, ref = EVALUATOR): EvaluatorRunPayload {
  const [packageId, evaluatorId] = ref.split('/');
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: runId,
    artifact_id: artifactId,
    evaluator_ref: ref,
    package_id: packageId!,
    evaluator_id: evaluatorId!,
    phase: 'post-plan',
    severity: 'info',
    run_status: 'completed',
    verdict: 'pass',
    body: 'Every declared step is covered.',
    ts: AT,
  };
}

const basis = {
  context_sha256: 'd'.repeat(64),
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  evaluator_version: null,
  producer_payload: null,
} satisfies EvaluatorRunEvidence['basis'];

const established = (runId: string, ...keys: (string | undefined)[]): EvaluatorRunEvidence => ({
  run_id: runId,
  findings: {
    status: 'established',
    record: {
      schema: 'orcaops.evaluator_run_findings/v1',
      run_id: runId,
      findings: keys.map((key, index) => ({
        ...(key === undefined ? {} : { key }),
        title: `Criterion ${index + 1} is satisfied by the delivered tests`,
      })),
    },
  },
  basis,
});

const offeredNone = (runId: string): EvaluatorRunEvidence => ({
  run_id: runId,
  findings: { status: 'none' },
  basis,
});

const unreadable = (runId: string): EvaluatorRunEvidence => ({
  run_id: runId,
  findings: {
    status: 'unreadable',
    record: {
      schema: 'orcaops.evaluator_findings_unreadable/v1',
      run_id: runId,
      source: 'markdown-block',
      detail: 'the findings block was opened and never closed',
    },
  },
  basis,
});

function eventBytes(runs: readonly EvaluatorRunPayload[]): Buffer {
  return Buffer.concat(
    runs.map((payload) => {
      const record = {
        event_id: uuidv7(),
        type: 'evaluator_run_recorded' as const,
        ts: payload.ts,
        schema_version: 1,
        idempotency_key: uuidv7(),
        payload,
      };
      return Buffer.from(`${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`);
    })
  );
}

interface CaptureRunsInput {
  runs: readonly EvaluatorRunPayload[];
  evidence?: readonly unknown[];
  operationId?: string;
  bytes?: Buffer;
  /** The revision the first attempt declared, so a retry of it declares the same one. */
  expectedRevision?: ArtifactRevision;
  secretAllow?: readonly string[];
  /** Refuse once the settlement has written, to watch both halves roll back. */
  refuseAfterSettlement?: boolean;
}

function captureInput(
  handle: ProjectDatabase,
  plan: CapturedPlan,
  worktreeId: string,
  input: CaptureRunsInput
): Parameters<typeof appendProjectExecutionCapture>[1] {
  const artifact = readProjectArtifact(handle, plan.artifactId)!;
  const owner = readProjectExecution(handle, plan.artifactId)!;
  return {
    artifactId: plan.artifactId,
    operationId: input.operationId ?? uuidv7(),
    expectedRevision: input.expectedRevision ?? artifact.revision,
    eventBytes: input.bytes ?? eventBytes(input.runs),
    sidecarPayloads: [],
    secretAllow: input.secretAllow ?? [],
    ...(input.evidence === undefined ? {} : { evaluatorEvidence: input.evidence }),
    execution: {
      kind: 'task' as const,
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: worktreeId,
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
      expectedVersion: owner.version,
      expectedGeneration: owner.state.binding_generation,
      explicitTarget: true,
    },
  } as Parameters<typeof appendProjectExecutionCapture>[1];
}

async function captureRuns(
  handle: ProjectDatabase,
  plan: CapturedPlan,
  worktreeId: string,
  input: CaptureRunsInput
): Promise<string> {
  const capture = captureInput(handle, plan, worktreeId, input);
  const operationId = capture.operationId;
  if (!input.refuseAfterSettlement) {
    await appendProjectExecutionCapture(handle, capture);
    return operationId;
  }
  const prepared = prepareExecutionCaptureRequest(handle, capture);
  const settlement = await prepareExecutionCaptureSettlement(handle, prepared);
  await runProjectOperation(handle, prepared.operation, (transaction) => {
    settlement.settle(transaction);
    throw new Error('refused once the settlement had written');
  });
  return operationId;
}

async function store() {
  const { handle, plan, worktreeId } = await plannedKnowledgeStore();
  return { handle, plan, worktreeId };
}

const evidenceRows = (handle: ProjectDatabase) =>
  Object.fromEntries(EVIDENCE_TABLES.map((table) => [table, rowCount(handle, table)]));
const nothingRetained = Object.fromEntries(EVIDENCE_TABLES.map((table) => [table, 0]));

it('writes a run and the findings it established in one transaction, or neither', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [established(runId, 'criterion/c1')],
      refuseAfterSettlement: true,
    })
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
  expect(
    read(handle, (view) =>
      view.get("SELECT event_id FROM artifact_events WHERE event_type = 'evaluator_run_recorded'")
    )
  ).toBeNull();
  expect(readProjectEvaluatorRunFindings(handle, runId)).toEqual({ status: 'not-retained' });

  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [established(runId, 'criterion/c1')],
  });

  const retained = readProjectEvaluatorRunFindings(handle, runId);
  expect(retained.status).toBe('established');
  expect(
    read(handle, (view) =>
      view.get("SELECT event_id FROM artifact_events WHERE event_type = 'evaluator_run_recorded'")
    )
  ).not.toBeNull();
});

it('retains the handed-over record whole, under the hash of its own bytes', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const evidence = established(runId, 'criterion/c1', undefined);
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [evidence],
  });

  const retained = readProjectEvaluatorRunFindings(handle, runId);
  if (retained.status !== 'established') throw new Error(retained.status);
  expect(JSON.parse(retained.recordBytes.toString('utf8'))).toEqual(
    evidence.findings.status === 'established' ? evidence.findings.record : null
  );
  expect(retained.recordSha256).toBe(
    createHash('sha256').update(retained.recordBytes).digest('hex')
  );
  expect(retained.notice).toBeNull();
  expect(retained.findings.map((finding) => [finding.position, finding.key])).toEqual([
    [0, 'criterion/c1'],
    [1, null],
  ]);
  expect(retained.basis).toMatchObject({
    artifactId: plan.artifactId,
    evaluatorRef: EVALUATOR,
    baseSha: basis.base_sha,
    headSha: basis.head_sha,
    contextSha256: basis.context_sha256,
    evaluatorVersion: null,
    producerPayload: null,
    producerPayloadSha256: null,
  });
});

it('writes no second copy when the same settlement is retried unchanged', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const operationId = uuidv7();
  const bytes = eventBytes([runPayload(plan.artifactId, runId)]);
  const input = {
    runs: [],
    bytes,
    operationId,
    expectedRevision: readProjectArtifact(handle, plan.artifactId)!.revision,
    evidence: [established(runId, 'criterion/c1')],
  };
  await captureRuns(handle, plan, worktreeId, input);
  const before = evidenceRows(handle);

  await captureRuns(handle, plan, worktreeId, input);

  expect(evidenceRows(handle)).toEqual(before);
  expect(before).toEqual({
    evaluator_run_contexts: 1,
    evaluator_run_findings: 1,
    evaluator_findings: 1,
    evaluator_findings_unreadable: 0,
  });
});

it('refuses a retry of one settlement whose findings changed', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const operationId = uuidv7();
  const bytes = eventBytes([runPayload(plan.artifactId, runId)]);
  const expectedRevision = readProjectArtifact(handle, plan.artifactId)!.revision;
  await captureRuns(handle, plan, worktreeId, {
    runs: [],
    bytes,
    operationId,
    expectedRevision,
    evidence: [established(runId, 'criterion/c1')],
  });
  const before = evidenceRows(handle);

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [],
      bytes,
      operationId,
      expectedRevision,
      evidence: [established(runId, 'criterion/c2')],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  expect(evidenceRows(handle)).toEqual(before);
});

it('refuses findings for a run the settlement does not establish, and writes nothing', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [established(uuidv7(), 'criterion/c1')],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: /must name a run this settlement establishes/,
  });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
  expect(
    read(handle, (view) =>
      view.get("SELECT event_id FROM artifact_events WHERE event_type = 'evaluator_run_recorded'")
    )
  ).toBeNull();
});

it('retains an unreadable record with no finding of its own', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [unreadable(runId)],
  });

  const retained = readProjectEvaluatorRunFindings(handle, runId);
  if (retained.status !== 'unreadable') throw new Error(retained.status);
  expect([retained.source, retained.detail]).toEqual([
    'markdown-block',
    'the findings block was opened and never closed',
  ]);
  expect(rowCount(handle, 'evaluator_findings')).toBe(0);
  expect(rowCount(handle, 'evaluator_run_findings')).toBe(0);
});

it('writes nothing for a run that hands nothing over', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  await captureRuns(handle, plan, worktreeId, { runs: [runPayload(plan.artifactId, runId)] });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
  expect(readProjectEvaluatorRunFindings(handle, runId)).toEqual({ status: 'not-retained' });
});

it('tells a run whose producer offered nothing from one nothing was retained for', async () => {
  const { handle, plan, worktreeId } = await store();
  const silent = uuidv7();
  const older = uuidv7();
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, older)],
  });
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, silent)],
    evidence: [offeredNone(silent)],
  });

  expect(readProjectEvaluatorRunFindings(handle, older)).toEqual({ status: 'not-retained' });
  const offered = readProjectEvaluatorRunFindings(handle, silent);
  expect(offered.status).toBe('none');
  // Neither answer is a finding identity, and neither invents one.
  expect(rowCount(handle, 'evaluator_findings')).toBe(0);
});

it('recurs a key within one artifact and evaluator, and never outside it', async () => {
  const first = await store();
  const second = await plannedKnowledgeStore();
  const runs = [uuidv7(), uuidv7()];
  for (const runId of runs)
    await captureRuns(first.handle, first.plan, first.worktreeId, {
      runs: [runPayload(first.plan.artifactId, runId)],
      evidence: [established(runId, 'criterion/c1')],
    });
  const elsewhere = uuidv7();
  await captureRuns(second.handle, second.plan, second.worktreeId, {
    runs: [runPayload(second.plan.artifactId, elsewhere)],
    evidence: [established(elsewhere, 'criterion/c1')],
  });
  const otherEvaluator = uuidv7();
  await captureRuns(first.handle, first.plan, first.worktreeId, {
    runs: [runPayload(first.plan.artifactId, otherEvaluator, 'core/completion-claims')],
    evidence: [established(otherEvaluator, 'criterion/c1')],
  });

  const recurrence = findProjectEvaluatorFindingRecurrence(first.handle, {
    artifactId: first.plan.artifactId,
    evaluatorRef: EVALUATOR,
    key: 'criterion/c1',
  });
  expect(recurrence.map((finding) => finding.runId).sort()).toEqual([...runs].sort());
  expect(
    findProjectEvaluatorFindingRecurrence(first.handle, {
      artifactId: second.plan.artifactId,
      evaluatorRef: EVALUATOR,
      key: 'criterion/c1',
    })
  ).toEqual([]);
});

it('offers no recurrence for a finding whose producer named no key', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [established(runId, undefined)],
  });

  expect(rowCount(handle, 'evaluator_findings')).toBe(1);
  expect(
    read(handle, (view) =>
      view.all('SELECT finding_key FROM evaluator_findings WHERE finding_key IS NOT NULL')
    )
  ).toEqual([]);
  expect(() =>
    findProjectEvaluatorFindingRecurrence(handle, {
      artifactId: plan.artifactId,
      evaluatorRef: EVALUATOR,
      key: '',
    })
  ).toThrow(/exact artifact, evaluator reference and finding key/);
});

it('refuses a handed-over record carrying a refused credential, and writes nothing', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const evidence = established(runId, 'criterion/c1');
  if (evidence.findings.status !== 'established') throw new Error('unreachable');
  evidence.findings.record.findings[0]!.detail = 'AKIAIOSFODNN7EXAMPLE is the access key';

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [evidence],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
});

it('refuses two handovers for one run', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [established(runId, 'criterion/c1'), unreadable(runId)],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: /hands over what became of its findings once/,
  });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
});

it('refuses a findings record that names another run than the handover it arrived in', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const evidence = { ...established(uuidv7(), 'criterion/c1'), run_id: runId };

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [evidence],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: /names the run it was established for/,
  });

  expect(evidenceRows(handle)).toEqual(nothingRetained);
});

it('names the settlement that retained it on every row', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const operationId = await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [established(runId, 'criterion/c1')],
  });

  for (const table of ['evaluator_run_contexts', 'evaluator_run_findings', 'evaluator_findings'])
    expect(
      read(handle, (view) =>
        view.all<{ operation_id: string }>(`SELECT operation_id FROM ${table}`)
      )
    ).toEqual([{ operation_id: operationId }]);
  expect(
    read(handle, (view) =>
      view.get<{ payload_json: string }>(
        'SELECT payload_json FROM operations WHERE operation_id = ?',
        operationId
      )
    )!.payload_json
  ).toContain('evaluator_evidence');
});

it('keeps the record a settlement compares out of the authored event bytes', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  await captureRuns(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [established(runId, 'criterion/c1')],
  });

  const bytes = read(handle, (view) =>
    view.get<{ record: string }>(
      "SELECT CAST(record_bytes AS TEXT) AS record FROM artifact_events WHERE event_type = 'evaluator_run_recorded'"
    )
  )!.record;
  expect(bytes).not.toContain('criterion/c1');
  expect(canonicalJson(JSON.parse(bytes).payload)).not.toContain('findings');
});

it('settles a capture admitted under an allowlist from what it retained', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const allowed = 'AKIAIOSFODNN7EXAMPLE';
  const evidence = established(runId, 'criterion/c1');
  if (evidence.findings.status !== 'established') throw new Error('unreachable');
  evidence.findings.record.findings[0]!.detail = `the documented example key ${allowed}`;
  const capture = captureInput(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [evidence],
    secretAllow: [allowed],
  });

  const admitted = prepareExecutionCaptureRequest(handle, capture);
  const retained = pendingEvaluatorEvidenceRows(admitted.request.evidence!);

  // What `readProjectPendingCapture` hands the settlement: the retained handover, and no
  // allowlist, because the act that named one has already been admitted.
  const restored = restoreExecutionCaptureRequest(handle, {
    ...capture,
    secretAllow: [],
    evaluatorEvidence: restorePendingEvaluatorEvidence(retained),
  });
  expect(restored.request.evidence!.digest).toBe(admitted.request.evidence!.digest);
  expect(restored.operation.payload).toEqual(admitted.operation.payload);

  const settlement = await prepareExecutionCaptureSettlement(handle, restored);
  await runProjectOperation(handle, restored.operation, (transaction) =>
    settlement.settle(transaction)
  );

  const read = readProjectEvaluatorRunFindings(handle, runId);
  if (read.status !== 'established') throw new Error(read.status);
  expect(read.findings[0]!.detail).toContain(allowed);
});

it('refuses a basis an authored capture is not allowed to write, and settles an allowed one', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const allowed = 'AKIAIOSFODNN7EXAMPLE';
  // The run's basis is retained as a record of its own, so what an authored capture may write to
  // it is scanned there rather than through the findings beside it.
  const evidence = {
    ...established(runId, 'criterion/c1'),
    basis: { ...basis, evaluator_version: `built from the example key ${allowed}` },
  };

  await expect(
    captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [evidence],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(evidenceRows(handle)).toEqual(nothingRetained);

  const capture = captureInput(handle, plan, worktreeId, {
    runs: [runPayload(plan.artifactId, runId)],
    evidence: [evidence],
    secretAllow: [allowed],
  });
  const admitted = prepareExecutionCaptureRequest(handle, capture);
  const restored = restoreExecutionCaptureRequest(handle, {
    ...capture,
    secretAllow: [],
    evaluatorEvidence: restorePendingEvaluatorEvidence(
      pendingEvaluatorEvidenceRows(admitted.request.evidence!)
    ),
  });
  const settlement = await prepareExecutionCaptureSettlement(handle, restored);
  await runProjectOperation(handle, restored.operation, (transaction) =>
    settlement.settle(transaction)
  );

  expect(
    read(handle, (view) =>
      view.get<{ evaluator_version: string }>(
        'SELECT evaluator_version FROM evaluator_run_contexts'
      )
    )!.evaluator_version
  ).toContain(allowed);
});

it("refuses an observation an authored settlement is not allowed to write, and leaves a restored one's alone", () => {
  const runId = uuidv7();
  const artifactId = uuidv7();
  const allowed = 'AKIAIOSFODNN7EXAMPLE';
  // The observation a run becomes names the evaluator as its method, so content admitted on the
  // event under an allowlist reaches a record the settlement derives rather than one it was
  // handed. Retained events are not scanned again, which is why this builds them that way.
  const incoming = decodeArtifactInput(
    eventBytes([runPayload(artifactId, runId, `core/${allowed}`)]),
    [],
    [],
    false
  );
  const prepared = (authored: boolean, secretAllow: readonly string[]) =>
    prepareEvaluatorEvidence({
      artifactId,
      incoming,
      evidence: [established(runId, 'criterion/c1')],
      secretAllow,
      authored,
    });

  expect(() => prepared(true, [])).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
  expect(prepared(true, [allowed])?.entries[0]?.observation).not.toBeNull();
  expect(prepared(false, [])?.entries[0]?.observation).not.toBeNull();
});

it('refuses a handover an authored capture is not allowed to write', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const evidence = established(runId, 'criterion/c1');
  if (evidence.findings.status !== 'established') throw new Error('unreachable');
  evidence.findings.record.findings[0]!.detail = 'AKIAIOSFODNN7EXAMPLE is the access key';

  expect(() =>
    prepareExecutionCaptureRequest(
      handle,
      captureInput(handle, plan, worktreeId, {
        runs: [runPayload(plan.artifactId, runId)],
        evidence: [evidence],
      })
    )
  ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
});

describe('what a retained handover must already be', () => {
  const ESCAPE = String.fromCodePoint(0x1b);
  const NUL = String.fromCodePoint(0);
  const record = (findings: unknown[]) => ({
    run_id: 'r1',
    findings: {
      status: 'established',
      record: { schema: 'orcaops.evaluator_run_findings/v1', run_id: 'r1', findings },
    },
    basis,
  });
  const location = { kind: 'file', path: 'src/a.ts' };

  it.each([
    [
      'more findings than the bound',
      record(Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` }))),
    ],
    ['a title past the bound', record([{ title: 'x'.repeat(501) }])],
    ['a detail past the bound', record([{ title: 't', detail: 'x'.repeat(4097) }])],
    [
      'more locations than the bound',
      record([{ title: 't', locations: Array.from({ length: 11 }, () => location) }]),
    ],
    ['terminal control in a title', record([{ title: `${ESCAPE}[31mred` }])],
    ['terminal control in a detail', record([{ title: 't', detail: `a${NUL}b` }])],
    [
      'terminal control in an unreadable detail',
      {
        run_id: 'r1',
        findings: {
          status: 'unreadable',
          record: {
            schema: 'orcaops.evaluator_findings_unreadable/v1',
            run_id: 'r1',
            source: 'envelope',
            detail: `offered${ESCAPE}[0m and unreadable`,
          },
        },
        basis,
      },
    ],
  ])('refuses %s', (_case, candidate) => {
    expect(EvaluatorRunEvidenceSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts what the runner bounds and scrubs', () => {
    const accepted = record([
      {
        key: 'criterion/c1',
        title: 'x'.repeat(500),
        detail: 'x'.repeat(4096),
        locations: [location],
      },
      { title: 'a line with a\ttab', detail: 'a detail\nover two lines' },
    ]);
    expect(EvaluatorRunEvidenceSchema.safeParse(accepted).success).toBe(true);
  });

  it('refuses an unbounded handover before the settlement writes anything', async () => {
    const { handle, plan, worktreeId } = await store();
    const runId = uuidv7();
    const evidence = established(runId, 'criterion/c1');
    if (evidence.findings.status !== 'established') throw new Error('unreachable');
    evidence.findings.record.findings[0]!.detail = 'x'.repeat(4097);

    await expect(
      captureRuns(handle, plan, worktreeId, {
        runs: [runPayload(plan.artifactId, runId)],
        evidence: [evidence],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(evidenceRows(handle)).toEqual(nothingRetained);
  });
});

it('leaves the operation payload of an append that hands nothing over exactly as it was', async () => {
  const { handle, plan, worktreeId } = await store();
  const runId = uuidv7();
  const bytes = eventBytes([runPayload(plan.artifactId, runId)]);
  const manifest = prepareArtifactAppendRequest({
    artifactId: plan.artifactId,
    operationId: uuidv7(),
    expectedRevision: readProjectArtifact(handle, plan.artifactId)!.revision,
    eventBytes: bytes,
    sidecarPayloads: [],
    secretAllow: [],
  }).operation.payload;

  // Every receipt a released build wrote identifies its events by this bare manifest. An edit
  // that wrapped it whether or not findings were handed over would make each of them identify
  // different content, and nothing else would notice.
  expect(Array.isArray(manifest)).toBe(true);
  expect(manifest).toEqual([
    {
      eventId: expect.any(String),
      recordHash: expect.any(String),
      sidecarHash: null,
    },
  ]);
  expect(
    prepareExecutionCaptureRequest(
      handle,
      captureInput(handle, plan, worktreeId, { runs: [], bytes })
    ).operation.payload
  ).toEqual({ events: manifest, execution: expect.any(Object) });

  const withFindings = prepareExecutionCaptureRequest(
    handle,
    captureInput(handle, plan, worktreeId, {
      runs: [],
      bytes,
      evidence: [established(runId, 'criterion/c1')],
    })
  ).operation.payload as Record<string, unknown>;
  expect(withFindings.events).toEqual(manifest);
  expect(withFindings.evaluator_evidence).toEqual(expect.any(String));
});

describe('the observation a retained run is', () => {
  it('records what the run was given and never claims it read the tree it saw', async () => {
    const { handle, plan, worktreeId } = await store();
    const runId = uuidv7();
    await captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [established(runId, 'criterion/c1')],
    });
    const id = evaluatorRunRecordId(runId);
    const observation = read(handle, (view) => readProjectObservation(view, id))!;
    expect(observation).toMatchObject({
      sourceId: id,
      evaluatorRunId: runId,
      executionKind: 'runner_established',
      runner: 'orcaops-evaluator-runner',
      method: { name: EVALUATOR, configurationSha256: basis.context_sha256 },
      outcome: 'observed',
      // Partial, never snapshot bound: the runner built the context and handed it over, and the
      // commits are what the run saw rather than what anything establishes it read.
      inputBasis: 'partial',
    });
    expect(observation.consumedInputs).toEqual([
      { kind: 'evaluator_context', identity: basis.context_sha256 },
    ]);
    expect(observation.knownInputs).toEqual(
      expect.arrayContaining([
        { kind: 'evaluator_context', identity: basis.context_sha256 },
        { kind: 'git_commit', identity: basis.base_sha },
        { kind: 'git_commit', identity: basis.head_sha },
      ])
    );
    // The source owns no second copy of the run: it names the occurrence the run is stated at.
    expect(
      read(handle, (view) =>
        view.get(
          'SELECT source_kind, event_id, field_path FROM knowledge_sources WHERE source_id=?',
          id
        )
      )
    ).toMatchObject({ source_kind: 'capture_field', field_path: 'payload' });
  });

  it('observes nothing for a run whose producer was never asked', async () => {
    const { handle, plan, worktreeId } = await store();
    // A skipped run and a consent refusal are recorded so the refusal stays loud; neither ran a
    // producer, so neither established an execution to observe. An error run did not complete.
    for (const run_status of ['skipped', 'error'] as const) {
      const runId = uuidv7();
      await captureRuns(handle, plan, worktreeId, {
        runs: [
          {
            ...runPayload(plan.artifactId, runId),
            run_status,
            verdict: null,
            ...(run_status === 'error'
              ? { error: { code: 'CONSENT_DENIED', message: 'the user refused' } }
              : {}),
          } as EvaluatorRunPayload,
        ],
        evidence: [offeredNone(runId)],
      });
      expect(readProjectEvaluatorRunFindings(handle, runId).status).toBe('none');
      expect(
        read(handle, (view) => readProjectObservation(view, evaluatorRunRecordId(runId)))
      ).toBe(null);
    }
    expect(rowCount(handle, 'evaluator_run_contexts')).toBe(2);
    expect(rowCount(handle, 'knowledge_observations')).toBe(0);
    expect(rowCount(handle, 'knowledge_sources')).toBe(0);
  });

  it('observes nothing for a run whose context names no digest', async () => {
    const { handle, plan, worktreeId } = await store();
    const runId = uuidv7();
    await captureRuns(handle, plan, worktreeId, {
      runs: [runPayload(plan.artifactId, runId)],
      evidence: [{ ...offeredNone(runId), basis: { ...basis, context_sha256: null } }],
    });
    expect(rowCount(handle, 'evaluator_run_contexts')).toBe(1);
    expect(rowCount(handle, 'knowledge_observations')).toBe(0);
  });

  it('is rolled back with the run event it belongs to', async () => {
    const { handle, plan, worktreeId } = await store();
    const runId = uuidv7();
    await expect(
      captureRuns(handle, plan, worktreeId, {
        runs: [runPayload(plan.artifactId, runId)],
        evidence: [established(runId, 'criterion/c1')],
        refuseAfterSettlement: true,
      })
    ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(rowCount(handle, 'knowledge_observations')).toBe(0);
    expect(rowCount(handle, 'knowledge_sources')).toBe(0);
  });
});
