import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactStore,
  type Config,
  type EvaluatorRunPayload,
  getDefaultConfig,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { deriveArtifactThreadStatus } from './thread-status.js';

/**
 * Integration tests pinning the behavior-facing corrections in
 * `deriveArtifactThreadStatus`: the summary gate and block supersession.
 * Drive a real ArtifactStore so the SQLite projection the function reads
 * is materialized the same way the live CLI sees it.
 */
describe('deriveArtifactThreadStatus — summary gate + block supersession', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  const artifactId = '01999999-9999-7000-8000-0000000c0a01';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });
  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writePlan(): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'feat/x',
      base_sha: 'base',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'one', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 'two', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
  }

  async function openCp(n: number, stepIds: string[]): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: stepIds },
      { idempotencyKey: `open-${n}`, headSha: 'base' }
    );
  }

  async function closeCp(n: number, stepIds: string[]): Promise<void> {
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n,
        summary: `cp ${n}`,
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: stepIds,
        head_sha: 'base',
      },
      { idempotencyKey: `close-${n}` }
    );
  }

  function blockRun(runId: string, verdict: 'violation' | 'pass', ts: string): EvaluatorRunPayload {
    return {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/blocker',
      package_id: 'test-pack',
      evaluator_id: 'blocker',
      phase: 'checkpoint-close',
      severity: 'block',
      run_status: 'completed',
      verdict,
      body: verdict,
      ts,
    };
  }

  it('summary is READY with no open cp + no block even when pre-pr never ran (not blocked_by eval-pr)', async () => {
    await writePlan();
    await openCp(1, ['step-1', 'step-2']);
    await closeCp(1, ['step-1', 'step-2']);

    const st = deriveArtifactThreadStatus(store, artifactId)!;
    expect(st.thread['eval-pr']).toMatchObject({ status: 'ready' }); // pre-pr never ran
    expect(st.thread.summary).toEqual({ status: 'ready', blocked_by: [] });
    expect(st.blocking_evaluators).toEqual([]);
  });

  it('summary is BLOCKED by an OPEN checkpoint, never by eval-pr', async () => {
    await writePlan();
    await openCp(1, ['step-1', 'step-2']); // left open

    const st = deriveArtifactThreadStatus(store, artifactId)!;
    expect(st.thread.summary.status).toBe('blocked');
    const blockedBy = (st.thread.summary as { blocked_by: string[] }).blocked_by;
    expect(blockedBy).toContain('checkpoint');
    expect(blockedBy).not.toContain('eval-pr');
  });

  it('summary is BLOCKED by an unresolved block (mapped to its phase node), never eval-pr for a missing pre-pr', async () => {
    await writePlan();
    await openCp(1, ['step-1', 'step-2']);
    await closeCp(1, ['step-1', 'step-2']);
    await store.writeEvaluatorRunPayload(
      artifactId,
      blockRun('run-v', 'violation', '2026-04-25T12:30:00.000Z'),
      {
        idempotencyKey: 'run-v',
      }
    );

    const st = deriveArtifactThreadStatus(store, artifactId)!;
    expect(st.thread.summary.status).toBe('blocked');
    const blockedBy = (st.thread.summary as { blocked_by: string[] }).blocked_by;
    // checkpoint-close phase maps to eval-cp, NOT eval-pr.
    expect(blockedBy).toContain('eval-cp');
    expect(blockedBy).not.toContain('eval-pr');
    expect(st.blocking_evaluators.map((b) => b.evaluator_ref)).toEqual(['test-pack/blocker']);
    expect(st.blocking_evaluators[0]?.failure_kind).toBe('violation');
  });

  it('reports a block-severity evaluator error until a successful rerun', async () => {
    await writePlan();
    await openCp(1, ['step-1', 'step-2']);
    await closeCp(1, ['step-1', 'step-2']);
    await store.writeEvaluatorRunPayload(
      artifactId,
      {
        ...blockRun('run-error', 'violation', '2026-04-25T12:30:00.000Z'),
        run_status: 'error',
        verdict: null,
        body: '',
        error: { code: 'ENGINE_FAILED', message: 'runner unavailable' },
      },
      { idempotencyKey: 'run-error' }
    );

    const blocked = deriveArtifactThreadStatus(store, artifactId)!;
    expect(blocked.blocking_evaluators).toMatchObject([
      { run_id: 'run-error', failure_kind: 'error' },
    ]);
    expect(blocked.thread.summary.status).toBe('blocked');

    await store.writeEvaluatorRunPayload(
      artifactId,
      blockRun('run-pass-after-error', 'pass', '2026-04-25T12:40:00.000Z'),
      { idempotencyKey: 'run-pass-after-error' }
    );
    expect(deriveArtifactThreadStatus(store, artifactId)!.blocking_evaluators).toEqual([]);
  });

  it('a passing rerun supersedes a violation: blocking_evaluators empty + summary ready', async () => {
    await writePlan();
    await openCp(1, ['step-1', 'step-2']);
    await closeCp(1, ['step-1', 'step-2']);
    await store.writeEvaluatorRunPayload(
      artifactId,
      blockRun('run-v', 'violation', '2026-04-25T12:30:00.000Z'),
      {
        idempotencyKey: 'run-v',
      }
    );
    await store.writeEvaluatorRunPayload(
      artifactId,
      blockRun('run-p', 'pass', '2026-04-25T12:40:00.000Z'),
      {
        idempotencyKey: 'run-p',
      }
    );

    const st = deriveArtifactThreadStatus(store, artifactId)!;
    // The raw disposition filter would still list run-v here; supersession
    // (computeUnresolvedBlocks) clears it, agreeing with next_actions.
    expect(st.blocking_evaluators).toEqual([]);
    expect(st.thread.summary).toEqual({ status: 'ready', blocked_by: [] });
  });
});
