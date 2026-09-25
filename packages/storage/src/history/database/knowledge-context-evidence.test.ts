// The composed read carrying each identity's assessments, over real project databases.
import { afterEach, expect, it } from 'vitest';

import { publishProjectKnowledgeAssessment } from './knowledge-assessments.js';
import { projectKnowledgeContext } from './knowledge-context.js';
import { publishProjectObservation } from './knowledge-observations.js';
import { knowledgeBoundaryAt } from './knowledge-read-boundary.js';
import {
  type AuthorityStore,
  authorityStore,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import { AGENT, discardKnowledgeStores, OWNER } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectationRevisionRef } from '../../schema/knowledge-contract.js';

afterEach(discardKnowledgeStores);

async function observation(store: AuthorityStore): Promise<string> {
  const observationId = uuidv7();
  await publishProjectObservation(store.handle, {
    operationId: uuidv7(),
    observation: {
      observation_id: observationId,
      source_id: store.sourceId,
      method: { name: 'vitest', configuration_sha256: null },
      execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits: [],
    },
    observedBy: AGENT,
    secretAllow: [],
  });
  return observationId;
}

async function assess(
  store: AuthorityStore,
  input: {
    expectation: ExpectationRevisionRef;
    observationId: string;
    release: string;
    conclusion: 'supported' | 'contradicted';
    environment?: string | null;
    coverageLimits?: string[];
  }
): Promise<string> {
  const assessmentId = uuidv7();
  await publishProjectKnowledgeAssessment(store.handle, {
    operationId: uuidv7(),
    assessment: {
      assessment_id: assessmentId,
      expectations: [input.expectation],
      exception_ids: [],
      implementation: {
        kind: 'selected',
        inputs: [{ kind: 'release', identity: input.release }],
        environment: input.environment ?? null,
      },
      evidence: [
        {
          source: { kind: 'observation', observation_id: input.observationId },
          role: input.conclusion === 'supported' ? 'supports' : 'contradicts',
          limitations: null,
        },
      ],
      method: { name: 'release review', configuration_sha256: null },
      conclusions: [
        {
          expectation: input.expectation,
          conclusion: input.conclusion,
          reason: `the offline smoke ${input.conclusion === 'supported' ? 'passed' : 'failed'}`,
        },
      ],
      check_states: [],
      coverage_limits: input.coverageLimits ?? ['only the offline smoke ran'],
      observed_write_sequence: 0,
      observed_intent_counter: 0,
    },
    assessedBy: OWNER,
    secretAllow: [],
  });
  return assessmentId;
}

const composed = (
  store: AuthorityStore,
  change: { boundary?: number; assessments?: boolean } = {}
) =>
  store.handle.read((view) =>
    projectKnowledgeContext(view, {
      projectId: store.authority.projectId,
      scope: store.project,
      boundary: change.boundary ?? 'now',
      mode: change.boundary === undefined ? 'current' : 'historical',
      subject: {
        kind: 'identities',
        targets: [{ kind: 'requirement', entity_id: store.requirementId }],
      },
      assessments: change.assessments ?? true,
    })
  ).value;

it('carries each assessment under the exact revision it judged, with its own basis', async () => {
  const store = await authorityStore();
  const observationId = await observation(store);
  const assessmentId = await assess(store, {
    expectation: store.target,
    observationId,
    release: '0.2.1',
    conclusion: 'supported',
    environment: 'ci-linux',
  });

  const entry = composed(store).entries[0];

  expect(entry?.assessments).toHaveLength(1);
  const held = entry?.assessments?.[0];
  expect(held?.expectation).toEqual(store.target);
  expect(held?.assessment.assessmentId).toBe(assessmentId);
  expect(held?.assessment.conclusion).toBe('supported');
  expect(held?.assessment.implementation).toEqual({
    kind: 'selected',
    inputs: [{ kind: 'release', identity: '0.2.1' }],
    environment: 'ci-linux',
  });
  expect(held?.assessment.evidence).toEqual([
    { kind: 'observation', id: observationId, role: 'supports' },
  ]);
  expect(held?.assessment.coverageLimits).toEqual(['only the offline smoke ran']);
  expect(held?.assessment.exceptionIds).toEqual([]);
});

it('keeps the counters an assessment observed apart from the sequence it was recorded at', async () => {
  const store = await authorityStore();
  const observationId = await observation(store);
  await assess(store, {
    expectation: store.target,
    observationId,
    release: '0.2.1',
    conclusion: 'supported',
  });

  const held = composed(store).entries[0]?.assessments?.[0]?.assessment;

  expect(held?.observedWriteSequence).toBe(0);
  expect(held?.observedIntentCounter).toBe(0);
  expect(held?.writeSequence).toBeGreaterThan(0);
});

it('carries an assessment of a superseded revision beside the one that governs', async () => {
  const store = await authorityStore();
  const observationId = await observation(store);
  const older = await assess(store, {
    expectation: store.target,
    observationId,
    release: '0.2.1',
    conclusion: 'contradicted',
  });
  const successor = await successorRevision(store);
  const newer = await assess(store, {
    expectation: successor,
    observationId,
    release: '0.2.1',
    conclusion: 'supported',
  });

  const entry = composed(store).entries[0];

  expect(entry?.assessments?.map((held) => held.assessment.assessmentId)).toEqual([older, newer]);
  expect(entry?.assessments?.map((held) => held.expectation.revision_id)).toEqual([
    store.revisionId,
    successor.revision_id,
  ]);
});

it('names an assessment published after the boundary apart from the ones it carries', async () => {
  const store = await authorityStore();
  const observationId = await observation(store);
  const before = store.handle.read((view) => knowledgeBoundaryAt(view)).value;
  const assessmentId = await assess(store, {
    expectation: store.target,
    observationId,
    release: '0.2.1',
    conclusion: 'supported',
  });

  const entry = composed(store, { boundary: before }).entries[0];

  expect(entry?.assessments).toEqual([]);
  expect(entry?.laterAssessments).toEqual([assessmentId]);
});

it('composes no assessments and no intent counter for a read that did not ask for them', async () => {
  const store = await authorityStore();
  const observationId = await observation(store);
  await assess(store, {
    expectation: store.target,
    observationId,
    release: '0.2.1',
    conclusion: 'supported',
  });

  const context = composed(store, { assessments: false });

  expect(context.entries[0]?.assessments).toBeUndefined();
  expect(context.entries[0]?.laterAssessments).toBeUndefined();
  expect(context.intentCounter).toBeUndefined();
});

it('reads the intent counter beside the assessments it is judged against', async () => {
  const store = await authorityStore();

  expect(composed(store).intentCounter).toBe(
    store.handle.read((view) =>
      view.get<{ intent_change_counter: number }>(
        'SELECT intent_change_counter FROM project_counters WHERE singleton = 1'
      )
    ).value?.intent_change_counter
  );
});
