import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from './sqlite.js';

/** `findArtifactIdsByStepId` + `getStoreStats`. */

describe('findArtifactIdsByStepId / getStoreStats', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-step-stats-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function seedArtifact(id: string, status: 'active' | 'complete' = 'active'): void {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch: 'main',
      task: `task ${id}`,
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-06-30T10:00:00.000Z',
      completed_at: null,
      status,
    });
  }

  function seedPlan(artifactId: string, revisionN: number, stepIds: string[]): void {
    store.upsertPlanRevision({
      plan: {
        artifact_id: artifactId,
        revision_n: revisionN,
        captured_at: '2026-06-30T10:00:00.000Z',
        label: `plan ${artifactId} r${revisionN}`,
        rationale: revisionN === 0 ? null : 'revised',
        touched_scope: '[]',
        non_goals: '[]',
        decisions: '[]',
        step_lineage: '{"added":[],"dropped":[],"unchanged":[],"rewritten":[]}',
        criterion_lineage: '{"added":[],"carried":[],"removed":[],"rewritten":[]}',
        prior_event_id: null,
        source_event_id: `evt-${artifactId}-${revisionN}`,
      },
      steps: stepIds.map((step_id, idx) => ({
        step_id,
        idx: idx + 1,
        text: `text for ${step_id}`,
        label: `label ${step_id}`,
        acceptance_criteria: '[]',
      })),
    });
  }

  it('findArtifactIdsByStepId: distinct hits across revisions and artifacts; unknown → []', () => {
    seedArtifact('a-1');
    seedPlan('a-1', 0, ['step-x', 'step-y']);
    seedPlan('a-1', 1, ['step-x']); // step-x in two revisions → still one artifact hit

    seedArtifact('a-2');
    seedPlan('a-2', 0, ['step-x']); // pathological shared id → second hit

    expect(store.findArtifactIdsByStepId('step-x')).toEqual(['a-1', 'a-2']);
    expect(store.findArtifactIdsByStepId('step-y')).toEqual(['a-1']);
    expect(store.findArtifactIdsByStepId('nope')).toEqual([]);
  });

  it('getStoreStats: counts grouped by status', () => {
    seedArtifact('a-1', 'active');
    seedArtifact('a-2', 'complete');
    store.upsertCheckpoint({
      status: 'open',
      artifact_id: 'a-1',
      n: 1,
      declared_step_ids: ['s'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-06-30T11:00:00.000Z',
      head_sha: 'cafef00d',
    });
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: 'a-2',
      n: 1,
      declared_step_ids: ['t'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-06-30T11:00:00.000Z',
      closed_at: '2026-06-30T12:00:00.000Z',
      summary: 'done',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: ['t'],
      head_sha: 'cafef00d',
    });
    store.upsertSummary({
      artifact_id: 'a-2',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      ts: '2026-06-30T13:00:00.000Z',
    });

    expect(store.getStoreStats()).toEqual({
      artifacts: { total: 2, by_status: { active: 1, complete: 1 } },
      checkpoints: { total: 2, by_status: { closed: 1, open: 1 } },
      summaries: { total: 1 },
    });
  });

  it('getStoreStats on an empty store is all zeros', () => {
    expect(store.getStoreStats()).toEqual({
      artifacts: { total: 0, by_status: {} },
      checkpoints: { total: 0, by_status: {} },
      summaries: { total: 0 },
    });
  });
});
