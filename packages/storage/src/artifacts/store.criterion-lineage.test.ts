import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { appendEvent } from '../events/event-log.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import { buildDefaultSkippedSnapshotBoundary } from '../schema/diff-fingerprint.js';
import type { Plan } from '../schema/plan.js';

/**
 * Revision integrity for acceptance criteria. Removal narrows the latest plan
 * and requires acknowledgement on open or completed steps. Addition and
 * rewriting create a new obligation and are rejected once work is open or
 * complete. Close-time evidence always grades the opening revision.
 */
describe('criterion-narrowing integrity', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/criteria';
  const artifactId = '01999999-9999-7000-8000-0000000000c1';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';
  const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3KB';
  const CRIT_A1 = '01HX0K8N6ZQF8M5R2V8DZ7TCA1';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  /** Initial plan: STEP_A carries one criterion (CRIT_A1), STEP_B has none. */
  async function writeInitialPlan(): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'base000',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'deliver the slice',
        label: 'initial-label',
        plan_steps: [
          {
            step_id: STEP_A,
            text: 'step a text',
            label: 'step-a',
            acceptance_criteria: [{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }],
          },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-05-31T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'init' }
    );
  }

  /** Revise STEP_A's criterion: omit it (remove) or change its text (rewrite). */
  async function revise(
    critA: Array<{ criterion_id?: string; text: string }>,
    opts: { ack?: string[]; key?: string; stepText?: string; stepLabel?: string } = {}
  ): Promise<Plan> {
    const res = await store.revisePlan(
      {
        idempotency_key: opts.key ?? 'rev-1',
        artifact_id: artifactId,
        label: 'revised-label',
        plan_steps: [
          {
            step_id: STEP_A,
            text: opts.stepText ?? 'step a text',
            label: opts.stepLabel ?? 'step-a',
            acceptance_criteria: critA,
          },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        rationale: 'adjust criteria',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: opts.ack ?? [],
      },
      { idempotencyKey: opts.key ?? 'rev-1' }
    );
    if (res.outcome === 'conflict') throw new Error('unexpected idempotency conflict in test');
    return res.plan;
  }

  async function completeStepA(): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_A] },
      { idempotencyKey: 'cp-a-open', headSha: 'base000' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'delivered step a with 42 tests',
        files_changed: ['a.test.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [{ criterion_id: CRIT_A1, evidence: '42 tests added in a.test.ts' }],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_A],
        head_sha: 'base000',
      },
      { idempotencyKey: 'cp-a-close' }
    );
  }

  it('records a REMOVED criterion in criterion_lineage with its prior text + step', async () => {
    await writeInitialPlan();
    const plan = await revise([]); // drop CRIT_A1, no open cp → cheap
    expect(plan.criterion_lineage.removed).toEqual([
      { criterion_id: CRIT_A1, prior_step_id: STEP_A, text: 'suite has >= 42 tests' },
    ]);
    expect(plan.criterion_lineage.rewritten).toEqual([]);
  });

  it('records a REWRITTEN criterion (same id, weaker text) with prior + new text', async () => {
    await writeInitialPlan();
    const plan = await revise([{ criterion_id: CRIT_A1, text: 'suite has a couple smoke tests' }]);
    expect(plan.criterion_lineage.removed).toEqual([]);
    expect(plan.criterion_lineage.rewritten).toEqual([
      {
        criterion_id: CRIT_A1,
        prior_step_id: STEP_A,
        prior_text: 'suite has >= 42 tests',
        new_text: 'suite has a couple smoke tests',
      },
    ]);
  });

  it('criterion_lineage is projected (survives a fresh store re-read of the prior revision)', async () => {
    await writeInitialPlan();
    await revise([]);
    // A fresh ArtifactStore reads the prior revision from the sqlite plans
    // projection (not the in-memory write path) — the lineage must round-trip
    // through the `criterion_lineage` column migration 016 added.
    store.close();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    const rev1 = await store.readPlanRevision(artifactId, 1);
    expect(rev1?.criterion_lineage.removed).toEqual([
      { criterion_id: CRIT_A1, prior_step_id: STEP_A, text: 'suite has >= 42 tests' },
    ]);
  });

  describe('open-checkpoint acknowledgement', () => {
    async function openCpOnStepA(): Promise<void> {
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_A] },
        { idempotencyKey: 'cp-a-open', headSha: 'base000' }
      );
    }

    it('REMOVING a criterion on an open-cp step without ack throws', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      await expect(revise([])).rejects.toMatchObject({
        code: 'PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES',
      });
    });

    it('rejects rewriting a criterion on an open-cp step', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has a couple smoke tests' }])
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
    });

    it('does not let acknowledgement bypass an open-step rewrite', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has a couple smoke tests' }], {
          ack: [CRIT_A1],
        })
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
    });

    it('the change succeeds once the criterion_id is acknowledged', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      const plan = await revise([], { ack: [CRIT_A1] });
      expect(plan.criterion_lineage.removed.map((r) => r.criterion_id)).toEqual([CRIT_A1]);
    });

    it('changing a criterion on a step with NO open cp stays cheap (no ack needed)', async () => {
      await writeInitialPlan();
      // open a cp on STEP_B instead — STEP_A's criterion is free to change
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_B] },
        { idempotencyKey: 'cp-b-open', headSha: 'base000' }
      );
      const plan = await revise([]); // no ack
      expect(plan.criterion_lineage.removed.map((r) => r.criterion_id)).toEqual([CRIT_A1]);
    });

    it('rejects adding a criterion to an open-cp step', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }, { text: 'lint passes' }])
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
    });

    it('rejects step-text rewrites but permits label-only edits on an open step', async () => {
      await writeInitialPlan();
      await openCpOnStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }], {
          stepText: 'different obligation',
        })
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
      const plan = await revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }], {
        key: 'label-only-open',
        stepLabel: 'renamed-step-a',
      });
      expect(plan.plan_steps[0].label).toBe('renamed-step-a');
    });
  });

  describe('completed-step protection', () => {
    it('requires acknowledgement to remove a criterion from a completed step', async () => {
      await writeInitialPlan();
      await completeStepA();
      await expect(revise([])).rejects.toMatchObject({
        code: 'PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES',
      });
      const plan = await revise([], { ack: [CRIT_A1], key: 'remove-completed' });
      expect(plan.criterion_lineage.removed.map((entry) => entry.criterion_id)).toEqual([CRIT_A1]);
    });

    it('rejects criterion additions and rewrites on a completed step', async () => {
      await writeInitialPlan();
      await completeStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }, { text: 'lint passes' }])
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has a couple smoke tests' }], {
          key: 'rewrite-completed',
        })
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
    });

    it('rejects step-text rewrites but permits label-only edits on a completed step', async () => {
      await writeInitialPlan();
      await completeStepA();
      await expect(
        revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }], {
          stepText: 'different obligation',
        })
      ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
      const plan = await revise([{ criterion_id: CRIT_A1, text: 'suite has >= 42 tests' }], {
        key: 'label-only-completed',
        stepLabel: 'renamed-step-a',
      });
      expect(plan.plan_steps[0].label).toBe('renamed-step-a');
    });
  });

  describe('close validation against the OPEN-time revision', () => {
    it('records the server-derived open_plan_revision_event_id on the open cp', async () => {
      await writeInitialPlan();
      const latest = await store.readPlan(artifactId);
      await store.writeCheckpointOpened(
        // pass plan_revision_id: null explicitly — the server field must still populate
        { artifact_id: artifactId, declared_step_ids: [STEP_A], plan_revision_id: null },
        { idempotencyKey: 'cp-open', headSha: 'base000' }
      );
      // The field rides the event-log-rebuilt Checkpoint (read via
      // readCheckpoint), the authoritative source the close-fix consults — not
      // the sqlite checkpoints projection, which doesn't carry it.
      const cp = await store.readCheckpoint(artifactId, 1);
      expect(cp?.status).toBe('open');
      if (cp?.status !== 'open') throw new Error('expected open cp');
      expect(cp.open_plan_revision_event_id).toBe(latest?.source_event_id);
      expect(cp.open_plan_revision_event_id).not.toBeNull();
    });

    it('accepts evidence for a criterion removed by a LATER revision (regression)', async () => {
      await writeInitialPlan();
      // Open the cp against revision 0 (which still has CRIT_A1).
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_A] },
        { idempotencyKey: 'cp-open', headSha: 'base000' }
      );
      // A later revise removes CRIT_A1 from the latest plan — but the cp opened
      // against rev 0, so its honest evidence must still validate. Ack required
      // because STEP_A has an open cp.
      await revise([], { ack: [CRIT_A1] });
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'delivered step a with 42 tests',
            files_changed: ['a.test.ts'],
            decisions: [],
            uncertainty: ['n/a'],
            done_criteria: [{ criterion_id: CRIT_A1, evidence: '42 tests added in a.test.ts' }],
            verification: [{ command: 'pnpm test', exit_code: 0 }],
            completed_step_ids: [STEP_A],
            head_sha: 'base000',
          },
          { idempotencyKey: 'cp-close' }
        )
      ).resolves.toBeDefined();
    });

    it('rejects a completed step missing opening-revision criterion evidence', async () => {
      await writeInitialPlan();
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_A] },
        { idempotencyKey: 'cp-open', headSha: 'base000' }
      );
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'claimed step a without criterion evidence',
            files_changed: ['a.test.ts'],
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            verification: [{ command: 'pnpm test', exit_code: 0 }],
            completed_step_ids: [STEP_A],
            head_sha: 'base000',
          },
          { idempotencyKey: 'cp-close' }
        )
      ).rejects.toMatchObject({ code: 'DONE_CRITERIA_INVALID', path: 'done_criteria' });
      expect(await store.readCheckpoint(artifactId, 1)).toMatchObject({ status: 'open' });
    });

    it('fails the close loudly when the opened-against revision is missing from the cache', async () => {
      await writeInitialPlan();
      // Plant the single OPEN event with a revision token that has no matching
      // cached plan revision. The lifecycle itself remains valid; only the
      // current projection dependency is malformed.
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-05-31T12:10:00.000Z',
          idempotency_key: 'cp-open',
          payload: {
            artifact_id: artifactId,
            n: 1,
            declared_step_ids: [STEP_A],
            agent: 'other',
            policy_exceptions: [],
            plan_revision_id: null,
            open_plan_revision_event_id: '01999999-9999-7000-8000-00000000dead',
            opened_at: '2026-05-31T12:10:00.000Z',
            head_sha: 'base000',
            open_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        { eventLogPath: paths.eventsNdjson, sidecarsDir: paths.sidecarsDir }
      );
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'delivered step a',
            files_changed: ['a.test.ts'],
            decisions: [],
            uncertainty: ['n/a'],
            done_criteria: [{ criterion_id: CRIT_A1, evidence: '42 tests added in a.test.ts' }],
            completed_step_ids: [STEP_A],
            head_sha: 'base000',
          },
          { idempotencyKey: 'cp-close' }
        )
      ).rejects.toThrow(/missing from the cache — run `orcaops rebuild` and retry/);
    });

    it('fails an EMPTY-rubric close just as loudly when the opened-against revision is missing', async () => {
      await writeInitialPlan();
      const paths = artifactPathsFor(repo.path, config, artifactId);
      await appendEvent(
        {
          type: 'checkpoint_opened',
          ts: '2026-05-31T12:10:00.000Z',
          idempotency_key: 'cp-open',
          payload: {
            artifact_id: artifactId,
            n: 1,
            declared_step_ids: [STEP_A],
            agent: 'other',
            policy_exceptions: [],
            plan_revision_id: null,
            open_plan_revision_event_id: '01999999-9999-7000-8000-00000000dead',
            opened_at: '2026-05-31T12:10:00.000Z',
            head_sha: 'base000',
            open_snapshot: buildDefaultSkippedSnapshotBoundary(),
          },
        },
        { eventLogPath: paths.eventsNdjson, sidecarsDir: paths.sidecarsDir }
      );
      // No done_criteria at all — the strict open-revision rule must
      // still apply, or this close would succeed and only push would fail.
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'delivered step a',
            files_changed: ['a.test.ts'],
            decisions: [],
            uncertainty: ['n/a'],
            done_criteria: [],
            completed_step_ids: [STEP_A],
            head_sha: 'base000',
          },
          { idempotencyKey: 'cp-close' }
        )
      ).rejects.toThrow(/missing from the cache — run `orcaops rebuild` and retry/);
    });

    it('still rejects evidence for a criterion that never existed on the claimed step', async () => {
      await writeInitialPlan();
      await store.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_A] },
        { idempotencyKey: 'cp-open', headSha: 'base000' }
      );
      await expect(
        store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'delivered step a',
            files_changed: ['a.test.ts'],
            decisions: [],
            uncertainty: ['n/a'],
            done_criteria: [{ criterion_id: 'no-such-criterion', evidence: 'made it up' }],
            completed_step_ids: [STEP_A],
            head_sha: 'base000',
          },
          { idempotencyKey: 'cp-close' }
        )
      ).rejects.toMatchObject({ code: 'DONE_CRITERIA_INVALID' });
    });
  });
});
