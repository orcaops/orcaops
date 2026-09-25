// Observations and task-independent assessments through real project databases and the public
// writers. The rules the tables hold on their own are in `knowledge-evidence-schema.test.ts`; what
// is here is what a caller actually reaches.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  publishProjectKnowledgeAssessment,
  readProjectKnowledgeAssessment,
} from './knowledge-assessments.js';
import { publishProjectContinuingClaimRevision } from './knowledge-claims.js';
import { publishProjectException } from './knowledge-exceptions.js';
import {
  listProjectClaimRevisionObservations,
  publishProjectObservation,
  publishProjectObservedRun,
  readProjectObservation,
} from './knowledge-observations.js';
import { runObservedProcess } from './knowledge-observed-run.js';
import { knowledgeBoundaryAt, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectExpectationAssessments } from './knowledge-read-evidence.js';
import { authorityStore, informedBy } from '../../../tests/knowledge-authority-store.js';
import {
  AGENT,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((at) => rm(at, { recursive: true, force: true })));
  await discardKnowledgeStores();
});

const READER = new URL('../../../tests/observed-input-reader.mjs', import.meta.url).pathname;
const METHOD = { name: 'observed-input-reader', configuration_sha256: null };

/** Real files a runner can hand over, in a directory this test removes afterwards. */
async function retainedInputs(contents: Readonly<Record<string, string>>) {
  const at = await mkdtemp(path.join(tmpdir(), 'evidence-inputs-'));
  directories.push(at);
  const inputs = [];
  for (const [name, text] of Object.entries(contents)) {
    await writeFile(path.join(at, name), text, 'utf8');
    inputs.push({ name, path: path.join(at, name) });
  }
  return { at, inputs };
}

const observedRun = (at: string, inputs: { name: string; path: string }[]) =>
  runObservedProcess({
    runner: 'orcaops-observed-run',
    argv: [process.execPath, READER],
    cwd: at,
    env: { PATH: process.env.PATH ?? '' },
    inputs,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });

const AT = '2026-09-17T15:00:00.000Z';
const CONFIGURATION = 'f'.repeat(64);
const BASE = 'a'.repeat(40);

const observation = (sourceId: string, change: Record<string, unknown> = {}) => ({
  observation_id: uuidv7(),
  source_id: sourceId,
  method: { name: 'vitest', configuration_sha256: CONFIGURATION },
  execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
  input_basis: 'unknown',
  known_inputs: [],
  outcome: 'passed',
  detail: null,
  retained_artifacts: [],
  started_at: AT,
  finished_at: AT,
  limits: [],
  ...change,
});

const publish = (
  handle: Parameters<typeof publishProjectObservation>[0],
  record: unknown,
  secretAllow: readonly string[] = []
) =>
  publishProjectObservation(handle, {
    operationId: uuidv7(),
    observation: record,
    observedBy: AGENT,
    secretAllow,
  });

it('records an agent-reported command as itself, on an unknown basis', async () => {
  const { handle, sourceId } = await authorityStore();
  const before = counters(handle);
  const record = observation(sourceId);
  const published = await publish(handle, record);
  const row = read(handle, (view) => readProjectObservation(view, record.observation_id))!;
  expect(row).toMatchObject({
    sourceId,
    observedBy: AGENT.identity,
    observedByBasis: AGENT.basis,
    method: { name: 'vitest', configurationSha256: CONFIGURATION },
    executionKind: 'agent_reported',
    runner: null,
    consumedInputs: null,
    inputBasis: 'unknown',
    knownInputs: [],
    outcome: 'passed',
    evaluatorRunId: null,
    recordSha256: published.value.recordSha256,
  });
  const after = counters(handle);
  expect(after.writeSequence).toBe(before.writeSequence + 1);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
});

it('records a human observation whose inputs are only partly identified', async () => {
  const { handle, sourceId } = await authorityStore();
  const record = observation(sourceId, {
    execution: { kind: 'human_observation' },
    input_basis: 'partial',
    known_inputs: [{ kind: 'git_commit', identity: BASE }],
    outcome: 'observed',
    limits: ['the reviewer read the diff, not the running software'],
  });
  await publish(handle, record);
  expect(read(handle, (view) => readProjectObservation(view, record.observation_id))).toMatchObject(
    {
      executionKind: 'human_observation',
      inputBasis: 'partial',
      knownInputs: [{ kind: 'git_commit', identity: BASE }],
      consumedInputs: null,
    }
  );
});

it('refuses a runner-established execution a caller merely wrote down', async () => {
  const { handle, sourceId } = await authorityStore();
  // The table's rule is about the shape of a record, and writing one array twice satisfies it.
  // Nothing in this shape is false about its own JSON, and all of it is false about the world.
  const inputs = [
    { kind: 'file', identity: `src/upload.ts@sha256:${'0'.repeat(64)}` },
    { kind: 'git_commit', identity: 'b'.repeat(40) },
  ];
  for (const forged of [
    observation(sourceId, {
      execution: {
        kind: 'runner_established',
        runner: 'orcaops-observed-run',
        consumed_inputs: inputs,
      },
      input_basis: 'snapshot_bound',
      known_inputs: inputs,
      detail: 'nothing ran',
    }),
    // Nor by claiming a weaker basis: the kind is what is refused, not the basis it rests on.
    observation(sourceId, {
      execution: {
        kind: 'runner_established',
        runner: 'orcaops-observed-run',
        consumed_inputs: inputs,
      },
      input_basis: 'partial',
      known_inputs: inputs,
    }),
  ])
    await expect(publish(handle, forged)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_observations')).toBe(0);
  // The two the fixture published, and no third from either refusal.
  expect(rowCount(handle, 'knowledge_sources')).toBe(2);
});

it('refuses a run this runner did not establish, however closely it is shaped like one', async () => {
  const { handle, sourceId } = await authorityStore();
  const { at, inputs } = await retainedInputs({ 'upload.ts': 'export const upload = () => 1;\n' });
  const established = await observedRun(at, inputs);
  const forged = { observation: { ...established.observation }, result: established.result };
  await expect(
    publishProjectObservedRun(handle, {
      operationId: uuidv7(),
      observation: { observation_id: uuidv7(), source_id: sourceId, method: METHOD },
      observedBy: AGENT,
      run: forged as typeof established,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_observations')).toBe(0);
});

it('records a snapshot-bound basis for what a runner established, and refuses a caller that restates it', async () => {
  const { handle, sourceId } = await authorityStore();
  const { at, inputs } = await retainedInputs({
    'upload.ts': 'export const upload = () => retry(3);\n',
    'retry.ts': 'export const retry = (n: number) => n;\n',
  });
  const run = await observedRun(at, inputs);
  const observationId = uuidv7();
  await publishProjectObservedRun(handle, {
    operationId: uuidv7(),
    observation: { observation_id: observationId, source_id: sourceId, method: METHOD },
    observedBy: AGENT,
    run,
    secretAllow: [],
  });
  const row = read(handle, (view) => readProjectObservation(view, observationId))!;
  expect(row.inputBasis).toBe('snapshot_bound');
  expect(row.executionKind).toBe('runner_established');
  expect(row.consumedInputs).toEqual(row.knownInputs);
  expect(row.consumedInputs).toHaveLength(2);

  // The run supplies every field it established, so a caller that names one of them is refused
  // rather than quietly overruled.
  await expect(
    publishProjectObservedRun(handle, {
      operationId: uuidv7(),
      observation: {
        observation_id: uuidv7(),
        source_id: sourceId,
        method: METHOD,
        input_basis: 'snapshot_bound',
      },
      observedBy: AGENT,
      run,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_observations')).toBe(1);
});

it('stores one lookup copy for a set of inputs, whatever order and repetition it arrives in', async () => {
  const { handle, sourceId } = await authorityStore();
  const { at, inputs } = await retainedInputs({
    'a.ts': 'export const a = 1;\n',
    'b.ts': 'export const b = 2;\n',
    'c.ts': 'export const c = 3;\n',
  });
  const run = await observedRun(at, inputs);
  const stored = new Set<string>();
  for (const order of [inputs, [...inputs].reverse(), [inputs[1]!, inputs[0]!, inputs[2]!]]) {
    const id = uuidv7();
    await publishProjectObservedRun(handle, {
      operationId: uuidv7(),
      observation: { observation_id: id, source_id: sourceId, method: METHOD },
      observedBy: AGENT,
      run: await observedRun(at, order),
      secretAllow: [],
    });
    stored.add(
      JSON.stringify(read(handle, (view) => readProjectObservation(view, id))!.knownInputs)
    );
  }
  expect(stored.size).toBe(1);
  expect(run.observation.known_inputs).toHaveLength(3);
});

it('refuses an observation of a source this history does not hold', async () => {
  const { handle } = await authorityStore();
  await expect(publish(handle, observation(uuidv7()))).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  expect(rowCount(handle, 'knowledge_observations')).toBe(0);
});

it('replays an identical observation retry and refuses a changed field under the same operation', async () => {
  const { handle, sourceId } = await authorityStore();
  const operationId = uuidv7();
  const record = observation(sourceId);
  const first = await publishProjectObservation(handle, {
    operationId,
    observation: record,
    observedBy: AGENT,
    secretAllow: [],
  });
  const replayed = await publishProjectObservation(handle, {
    operationId,
    observation: record,
    observedBy: AGENT,
    secretAllow: [],
  });
  expect(replayed.value).toEqual(first.value);
  expect(rowCount(handle, 'knowledge_observations')).toBe(1);
  // One source, published by the store the fixture built, and no second one from either call.
  expect(rowCount(handle, 'knowledge_sources')).toBe(2);
  await expect(
    publishProjectObservation(handle, {
      operationId,
      observation: { ...record, outcome: 'failed' },
      observedBy: AGENT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'knowledge_observations')).toBe(1);
  expect(rowCount(handle, 'knowledge_sources')).toBe(2);
});

it('names the observations a claim revision rests on, in the order it named them', async () => {
  const { handle, sourceId } = await authorityStore();
  const first = observation(sourceId, { outcome: 'failed' });
  const second = observation(sourceId);
  for (const record of [first, second]) await publish(handle, record);
  const revisionId = uuidv7();
  await publishProjectContinuingClaimRevision(handle, {
    operationId: uuidv7(),
    revision: {
      claim_id: uuidv7(),
      revision_id: revisionId,
      previous_revision_id: null,
      statement: 'Retrying an upload after a gateway error uploads the file twice.',
      subject: null,
      applicability: { all_of: [] },
      source_ids: [sourceId],
      passages: [
        {
          source_id: sourceId,
          location: 'checkpoint 3 / findings[0]',
          passage_sha256: CONFIGURATION,
        },
      ],
      source_standing: 'agent_proposal',
      observation_ids: [second.observation_id, first.observation_id],
      verification: null,
      recorded_at: AT,
    },
    attributedTo: { kind: 'actor', actor: AGENT },
    secretAllow: [],
    occurrence: { source_id: sourceId, location: 'checkpoint 3 / findings[0]' },
  });
  expect(
    read(handle, (view) => listProjectClaimRevisionObservations(view, revisionId)).map(
      (row) => row.observationId
    )
  ).toEqual([second.observation_id, first.observation_id]);
});

const assessment = (change: Record<string, unknown> = {}) => ({
  assessment_id: uuidv7(),
  exception_ids: [],
  implementation: {
    kind: 'selected',
    inputs: [{ kind: 'release', identity: '0.2.1' }],
    environment: 'macOS 15.3 arm64',
  },
  evidence: [],
  method: { name: 'release review', configuration_sha256: null },
  check_states: [],
  coverage_limits: [],
  observed_write_sequence: 0,
  observed_intent_counter: 0,
  ...change,
});

it('assesses a selected release against an expectation with no task, artifact or pull request', async () => {
  const { handle, sourceId, target } = await authorityStore();
  const evidence = observation(sourceId, { outcome: 'passed' });
  await publish(handle, evidence);
  const before = counters(handle);
  const record = assessment({
    expectations: [target],
    evidence: [
      {
        source: { kind: 'observation', observation_id: evidence.observation_id },
        role: 'supports',
        limitations: 'the smoke suite only, on one platform',
      },
    ],
    conclusions: [
      {
        expectation: target,
        conclusion: 'supported',
        reason: 'Capture completed with the network down.',
      },
    ],
    check_states: [
      { check: 'the integration suite', state: 'skipped', detail: 'no provider was configured' },
      { check: 'the prior release report', state: 'stale_evidence', detail: null },
    ],
    coverage_limits: ['nothing was run on Windows'],
    observed_write_sequence: before.writeSequence,
    observed_intent_counter: before.intentChangeCounter,
  });
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: record,
    assessedBy: OWNER,
    secretAllow: [],
  });
  const row = read(handle, (view) => readProjectKnowledgeAssessment(view, record.assessment_id))!;
  expect(row).toMatchObject({
    assessedBy: OWNER.identity,
    implementation: {
      kind: 'selected',
      inputs: [{ kind: 'release', identity: '0.2.1' }],
      environment: 'macOS 15.3 arm64',
    },
    observedWriteSequence: before.writeSequence,
    observedIntentCounter: before.intentChangeCounter,
  });
  expect(row.conclusions).toEqual([{ expectation: target, conclusion: 'supported' }]);
  expect(row.evidence).toEqual([
    { kind: 'observation', id: evidence.observation_id, role: 'supports' },
  ]);
  // Errors, skipped checks, missing inputs and stale evidence are states of the checks, and a
  // reader that folded one into the conclusions would make a skipped check read as a verdict.
  expect(row.checkStates).toEqual([
    { check: 'the integration suite', state: 'skipped' },
    { check: 'the prior release report', state: 'stale_evidence' },
  ]);
  const after = counters(handle);
  expect(after.writeSequence).toBe(before.writeSequence + 1);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
});

it('refuses a satisfaction claim when no software was identified', async () => {
  const { handle, target } = await authorityStore();
  await expect(
    publishProjectKnowledgeAssessment(handle, {
      operationId: uuidv7(),
      assessment: assessment({
        expectations: [target],
        implementation: { kind: 'none_selected' },
        conclusions: [
          { expectation: target, conclusion: 'supported', reason: 'the tests passed somewhere' },
        ],
      }),
      assessedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_assessments')).toBe(0);
});

it('assesses without an implementation as long as it concludes nothing about satisfaction', async () => {
  const { handle, target } = await authorityStore();
  const record = assessment({
    expectations: [target],
    implementation: { kind: 'none_selected' },
    conclusions: [
      {
        expectation: target,
        conclusion: 'unresolved',
        reason: 'no build was selected, so applicability stays unresolved',
      },
    ],
  });
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: record,
    assessedBy: OWNER,
    secretAllow: [],
  });
  expect(
    read(handle, (view) => readProjectKnowledgeAssessment(view, record.assessment_id))!
      .implementation
  ).toEqual({ kind: 'none_selected' });
});

it('refuses either counter stamped later than this history has committed', async () => {
  const { handle, target } = await authorityStore();
  const committed = counters(handle);
  for (const stamped of [
    { observed_write_sequence: committed.writeSequence + 1 },
    { observed_intent_counter: committed.intentChangeCounter + 1 },
    { observed_intent_counter: Number.MAX_SAFE_INTEGER },
  ])
    await expect(
      publishProjectKnowledgeAssessment(handle, {
        operationId: uuidv7(),
        assessment: assessment({
          expectations: [target],
          conclusions: [{ expectation: target, conclusion: 'not_assessed', reason: 'deferred' }],
          observed_write_sequence: committed.writeSequence,
          observed_intent_counter: committed.intentChangeCounter,
          ...stamped,
        }),
        assessedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_assessments')).toBe(0);
  expect(read(handle, knowledgeBoundaryAt)).toBe(committed.writeSequence);
});

it('refuses a credential in what an observation or an assessment says, before any write', async () => {
  const { handle, sourceId, target } = await authorityStore();
  const secret = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
  await expect(
    publish(handle, observation(sourceId, { detail: `the token ${secret} was accepted` }))
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  await expect(
    publishProjectKnowledgeAssessment(handle, {
      operationId: uuidv7(),
      assessment: assessment({
        expectations: [target],
        conclusions: [
          {
            expectation: target,
            conclusion: 'not_assessed',
            reason: `deferred: ${secret} expired`,
          },
        ],
      }),
      assessedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(rowCount(handle, 'knowledge_observations')).toBe(0);
  expect(rowCount(handle, 'knowledge_assessments')).toBe(0);

  // What somebody has read and judged dead stays publishable, and the writer never decides that.
  await publish(handle, observation(sourceId, { detail: `the token ${secret} was accepted` }), [
    secret,
  ]);
  expect(rowCount(handle, 'knowledge_observations')).toBe(1);
});

it('refuses an assessment that names an expectation, an exception or evidence this history lacks', async () => {
  const store = await authorityStore();
  const { handle, target } = store;
  const missing = { kind: 'requirement' as const, entity_id: uuidv7(), revision_id: uuidv7() };
  const refused = [
    assessment({
      expectations: [missing],
      conclusions: [{ expectation: missing, conclusion: 'not_assessed', reason: 'deferred' }],
    }),
    assessment({
      expectations: [target],
      conclusions: [{ expectation: target, conclusion: 'not_assessed', reason: 'deferred' }],
      exception_ids: [uuidv7()],
    }),
    assessment({
      expectations: [target],
      conclusions: [{ expectation: target, conclusion: 'not_assessed', reason: 'deferred' }],
      evidence: [
        {
          source: { kind: 'observation', observation_id: uuidv7() },
          role: 'context',
          limitations: null,
        },
      ],
    }),
  ];
  for (const record of refused)
    await expect(
      publishProjectKnowledgeAssessment(handle, {
        operationId: uuidv7(),
        assessment: record,
        assessedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'knowledge_assessments')).toBe(0);
});

it('keeps the exceptions in force with the assessment that was made under them', async () => {
  const store = await authorityStore();
  const { handle, target } = store;
  const exceptionId = uuidv7();
  const work = { work_context: ['shared-builder'] };
  await publishProjectException(handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: target,
      context: {
        all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['shared-builder'] }],
      },
      scope: store.project,
      rationale:
        'The shared builder has no loopback network namespace to run the offline smoke in.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [target], store.project),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work,
    secretAllow: [],
  });
  const record = assessment({
    expectations: [target],
    exception_ids: [exceptionId],
    conclusions: [
      { expectation: target, conclusion: 'not_assessed', reason: 'excepted on this builder' },
    ],
  });
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: record,
    assessedBy: OWNER,
    secretAllow: [],
  });
  const bytes = Buffer.from(
    read(handle, (view) => readProjectKnowledgeAssessment(view, record.assessment_id))!.recordHex,
    'hex'
  );
  expect((JSON.parse(bytes.toString()) as { exception_ids: string[] }).exception_ids).toEqual([
    exceptionId,
  ]);
});

it('replays an identical assessment retry and refuses a changed field under the same operation', async () => {
  const { handle, target } = await authorityStore();
  const operationId = uuidv7();
  const record = assessment({
    expectations: [target],
    conclusions: [{ expectation: target, conclusion: 'not_assessed', reason: 'deferred' }],
  });
  const first = await publishProjectKnowledgeAssessment(handle, {
    operationId,
    assessment: record,
    assessedBy: OWNER,
    secretAllow: [],
  });
  const replayed = await publishProjectKnowledgeAssessment(handle, {
    operationId,
    assessment: record,
    assessedBy: OWNER,
    secretAllow: [],
  });
  expect(replayed.value).toEqual(first.value);
  expect(rowCount(handle, 'knowledge_assessment_conclusions')).toBe(1);
  await expect(
    publishProjectKnowledgeAssessment(handle, {
      operationId,
      assessment: { ...record, coverage_limits: ['nothing was run on Windows'] },
      assessedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('shows an expectation its assessments with their own basis, and names the later ones apart', async () => {
  const { handle, sourceId, target, project } = await authorityStore();
  const evidence = observation(sourceId);
  await publish(handle, evidence);
  const earlier = assessment({
    expectations: [target],
    implementation: { kind: 'none_selected' },
    conclusions: [{ expectation: target, conclusion: 'unresolved', reason: 'no build selected' }],
  });
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: earlier,
    assessedBy: OWNER,
    secretAllow: [],
  });
  const boundary = read(handle, knowledgeBoundaryAt);
  const later = assessment({
    expectations: [target],
    evidence: [
      {
        source: { kind: 'observation', observation_id: evidence.observation_id },
        role: 'supports',
        limitations: null,
      },
    ],
    conclusions: [
      { expectation: target, conclusion: 'supported', reason: 'the offline smoke passed' },
    ],
  });
  await publishProjectKnowledgeAssessment(handle, {
    operationId: uuidv7(),
    assessment: later,
    assessedBy: OWNER,
    secretAllow: [],
  });

  const at = (boundaryAt: number | 'now') =>
    read(handle, (view) =>
      readProjectExpectationAssessments(
        view,
        target,
        knowledgeReadRequest(view, { scope: project, mode: 'historical', boundary: boundaryAt })
      )
    );
  const then = at(boundary);
  expect(then.coverage.boundary).toBe(boundary);
  expect(then.assessments).toHaveLength(1);
  expect(then.assessments[0]).toMatchObject({
    assessmentId: earlier.assessment_id,
    conclusion: 'unresolved',
    implementation: { kind: 'none_selected' },
  });
  expect(then.later).toEqual([later.assessment_id]);

  const now = at('now');
  expect(now.assessments.map((entry) => entry.assessmentId)).toEqual([
    earlier.assessment_id,
    later.assessment_id,
  ]);
  expect(now.assessments[1]).toMatchObject({
    conclusion: 'supported',
    implementation: { kind: 'selected', inputs: [{ kind: 'release', identity: '0.2.1' }] },
    evidence: [{ kind: 'observation', id: evidence.observation_id, role: 'supports' }],
  });
  expect(now.later).toEqual([]);
});
