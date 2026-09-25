import { afterEach, expect, it } from 'vitest';

import {
  prepareArtifactAppend,
  prepareArtifactAppendRequest,
  readProjectArtifact,
} from './artifacts.js';
import { openProjectDatabase, type ProjectReadView } from './connection.js';
import { knowledgeBoundaryAt, revisionGoverningState } from './knowledge-read-boundary.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  activeTaskSelectionAtBoundary,
  projectTaskKnowledgeContext,
} from './knowledge-task-context.js';
import { runProjectOperation } from './transactions.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  instructedBy,
} from '../../../tests/knowledge-authority-store.js';
import {
  capturePlan,
  counters,
  discardKnowledgeStores,
  OWNER,
} from '../../../tests/knowledge-store.js';
import { prepareArtifactDraft } from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const anotherPlan = () => ({
  artifactId: uuidv7(),
  planEventId: uuidv7(),
  steps: [
    {
      stepId: uuidv7(),
      criteria: [{ criterionId: uuidv7(), text: 'Keep this task independent.' }],
    },
  ],
});

async function preparedPlanRevision(store: Awaited<ReturnType<typeof authorityStore>>) {
  const retained = readProjectArtifact(store.handle, store.plan.artifactId)!;
  const revisedEventId = uuidv7();
  const draft = await prepareArtifactDraft(
    {
      artifactId: store.plan.artifactId,
      priorEvents: retained.thread.events,
      authoredPayload: {},
      secretAllow: [],
      idempotencyBlocks: [],
    },
    (semantics) =>
      semantics.revisePlan(
        {
          artifact_id: store.plan.artifactId,
          prior_plan_event_id: store.plan.planEventId,
          idempotency_key: revisedEventId,
          label: 'Revised task context',
          rationale: 'Exercise a write between context reads.',
          touched_scope: [],
          non_goals: [],
          decisions: [],
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
          plan_steps: [
            {
              text: 'Keep the context coherent',
              label: 'Coherent context',
              acceptance_criteria: [{ text: 'one snapshot answers the task' }],
            },
          ],
        },
        { idempotencyKey: revisedEventId, invokedByAgent: 'codex' }
      )
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  const input = {
    operationId: uuidv7(),
    artifactId: store.plan.artifactId,
    expectedRevision: retained.revision,
    eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
    sidecarPayloads: draft.events.flatMap((event) =>
      event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
    ),
    secretAllow: [],
  };
  const request = prepareArtifactAppendRequest(input);
  const prepared = await prepareArtifactAppend(store.handle, request);
  return { prepared, request, revisedEventId: draft.events[0]!.record.event_id };
}

it('keeps an artifact-local adoption out of another task authority', async () => {
  const store = await authorityStore();
  const other = anotherPlan();
  await capturePlan(store.handle, other);
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.artifact,
      instructedBy(store.instructionId, store.artifact)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  const read = (artifactId: string) =>
    store.handle.read((view) =>
      projectTaskKnowledgeContext(view, {
        projectId: store.authority.projectId,
        artifactId,
        boundary: 'now',
        plan: { kind: 'latest_visible' },
      })
    ).value;
  const own = read(store.plan.artifactId).knowledge.entries[0]!;
  const elsewhere = read(other.artifactId).knowledge.entries[0]!;

  expect(revisionGoverningState(own.resolved, store.revisionId).standing).toBe('adopted');
  expect(revisionGoverningState(elsewhere.resolved, store.revisionId).standing).not.toBe('adopted');
});

it('selects only plans visible at the requested boundary', async () => {
  const store = await authorityStore();
  const beforeOtherPlan = counters(store.handle).writeSequence;
  const other = anotherPlan();
  await capturePlan(store.handle, other);

  const historical = store.handle.read((view) =>
    projectTaskKnowledgeContext(view, {
      projectId: store.authority.projectId,
      artifactId: store.plan.artifactId,
      boundary: beforeOtherPlan,
      plan: { kind: 'latest_visible' },
    })
  ).value;
  expect(historical.selectedPlan?.planEventId).toBe(store.plan.planEventId);
  expect(historical.knowledge.request.knowledge_boundary).toBe(beforeOtherPlan);
  expect(historical.processing.latestEligibleSequence).toBeLessThanOrEqual(beforeOtherPlan);

  expect(() =>
    store.handle.read((view) =>
      projectTaskKnowledgeContext(view, {
        projectId: store.authority.projectId,
        artifactId: other.artifactId,
        boundary: beforeOtherPlan,
        plan: { kind: 'exact', planEventId: other.planEventId },
      })
    )
  ).toThrow(/not a plan .* visible at this knowledge boundary/u);
});

it('keeps a current plan while assessing explicitly selected older software', async () => {
  const store = await authorityStore();
  const implementation = {
    kind: 'selected' as const,
    inputs: [{ kind: 'git_commit' as const, identity: 'a'.repeat(40) }],
    environment: null,
  };

  const task = store.handle.read((view) =>
    projectTaskKnowledgeContext(view, {
      projectId: store.authority.projectId,
      artifactId: store.plan.artifactId,
      boundary: 'now',
      plan: { kind: 'latest_visible' },
      implementation,
    })
  ).value;

  expect(task.selectedPlan?.planEventId).toBe(store.plan.planEventId);
  expect(task.knowledge.request).toMatchObject({ mode: 'current', implementation });
});

it('keeps one snapshot when a plan revision commits between context queries', async () => {
  const store = await authorityStore();
  const revision = await preparedPlanRevision(store);
  const reader = await openProjectDatabase({ authority: store.authority, mode: 'reader' });
  let committed: ReturnType<typeof runProjectOperation> | null = null;
  try {
    const task = reader.read((view) => {
      let firstQuery = true;
      const interleaved: ProjectReadView = {
        get: <T>(sql: string, ...parameters: unknown[]) => {
          const value = view.get<T>(sql, ...parameters);
          if (firstQuery) {
            firstQuery = false;
            committed = runProjectOperation(
              store.handle,
              revision.request.operation,
              (transaction) => ({
                ...revision.prepared.settle(transaction),
                revision: { ...revision.prepared.revision },
              })
            );
          }
          return value;
        },
        all: <T>(sql: string, ...parameters: unknown[]) => view.all<T>(sql, ...parameters),
      };
      return projectTaskKnowledgeContext(interleaved, {
        projectId: store.authority.projectId,
        artifactId: store.plan.artifactId,
        boundary: 'now',
        plan: { kind: 'latest_visible' },
      });
    }).value;
    await committed;

    expect(task.selectedPlan?.planEventId).toBe(store.plan.planEventId);
    expect(task.knowledge.request.knowledge_boundary).toBeLessThan(
      store.handle.read(() => null).counters.writeSequence
    );
    const fresh = reader.read((view) =>
      projectTaskKnowledgeContext(view, {
        projectId: store.authority.projectId,
        artifactId: store.plan.artifactId,
        boundary: 'now',
        plan: { kind: 'latest_visible' },
      })
    ).value;
    expect(fresh.selectedPlan?.planEventId).toBe(revision.revisedEventId);
  } finally {
    reader.close();
  }
});

it('reports active-branch ambiguity instead of choosing a task', async () => {
  const store = await authorityStore();
  const other = anotherPlan();
  await capturePlan(store.handle, other);

  const active = store.handle.read((view) =>
    activeTaskSelectionAtBoundary(view, 'main', knowledgeBoundaryAt(view))
  ).value;

  expect(active).toEqual({
    kind: 'ambiguous',
    artifactIds: [store.plan.artifactId, other.artifactId].sort(),
  });
});
