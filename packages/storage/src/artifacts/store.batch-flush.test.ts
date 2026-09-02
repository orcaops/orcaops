import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArtifactStore } from './store.js';
import type { ArchiveMirror } from '../archive/mirror.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

const ARTIFACT_ID = '01999999-9999-7000-8000-0000000000ab';
const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

function planInput() {
  return {
    schema_version: 4 as const,
    artifact_id: ARTIFACT_ID,
    branch: 'feat/x',
    base_sha: 'abc123',
    agent: 'claude-code' as const,
    agent_session_id: null,
    task: 'do the thing',
    label: 'do-thing',
    plan_steps: [{ step_id: STEP_ID, text: 'step 1', label: 's1', acceptance_criteria: [] }],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-04-26T12:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}

/**
 * The archive copy must never get ahead of the durable hot log: a batched
 * (deferred-fsync) append has to complete its durability acknowledgement
 * before the event is mirrored, or a power loss could leave the archive
 * holding events the authoritative log lost.
 */
describe('ArtifactStore — batched appends vs the archive mirror', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  it('flushes the hot log before every archive mirror inside a batch', async () => {
    // `dirtyBatchedArtifacts` is non-empty exactly while a deferred append
    // awaits its flush; observing it empty from inside the mirror proves the
    // flush ordering without instrumenting fsync itself.
    const unflushedAtMirror: number[] = [];
    const archive = {
      mirrorEventRecord: async () => {
        unflushedAtMirror.push(
          (store as unknown as { dirtyBatchedArtifacts: Set<string> }).dirtyBatchedArtifacts.size
        );
      },
    } as unknown as ArchiveMirror;
    store = new ArtifactStore({ repoRoot: repo.path, config, archive });

    await store.withArtifactEventBatch(ARTIFACT_ID, async () => {
      await store.writePlan(planInput(), { idempotencyKey: 'plan-1' });
      await store.writeCheckpointOpened(
        { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_ID] },
        { idempotencyKey: 'open-1', headSha: 'cafef00d' }
      );
    });

    expect(unflushedAtMirror).toHaveLength(2);
    expect(unflushedAtMirror).toEqual([0, 0]);
  });
});
