import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactPathsFor,
  ArtifactStore,
  type Config,
  getDefaultConfig,
  PathContainmentError,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { buildResume, writeResume } from './builder.js';

describe('buildResume / writeResume', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/work';
  const startedAt = '2026-04-25T12:00:00.000Z';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  // ── Declared-completion path (the only path; no inference fallback) ──

  it('a single cp claiming a step renders that step ☑ with attribution', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'Redis middleware', label: 'step-1', acceptance_criteria: [] },
        {
          step_id: 'step-2',
          text: 'mount on /api/charge',
          label: 'step-2',
          acceptance_criteria: [],
        },
        { step_id: 'step-3', text: 'tests', label: 'step-3', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wired Redis middleware',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-1' }
    );

    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.plan_event_id).toBe((await store.readPlan('a1'))!.source_event_id);
    expect(out.data.steps).toHaveLength(3);
    expect(out.data.steps[0]).toMatchObject({
      step_id: 'step-1',
      idx: 1,
      text: 'Redis middleware',
      done: true,
      evidence_checkpoint: 1,
    });
    expect(out.data.steps[1].done).toBe(false);
    expect(out.data.steps[2].done).toBe(false);
  });

  it('unions claims across multiple cps; each step gets the cp that claimed it', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'step one', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 'step two', label: 'step-2', acceptance_criteria: [] },
        { step_id: 'step-3', text: 'step three', label: 'step-3', acceptance_criteria: [] },
        { step_id: 'step-4', text: 'step four', label: 'step-4', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1', 'step-2'] },
      { idempotencyKey: 'cp-open-2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1', 'step-2'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-2' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-3'] },
      { idempotencyKey: 'cp-open-3', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-3'],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'cp-close-3' }
    );

    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.steps[0]).toMatchObject({ done: true, evidence_checkpoint: 1 });
    expect(out.data.steps[1]).toMatchObject({ done: true, evidence_checkpoint: 1 });
    expect(out.data.steps[2]).toMatchObject({ done: true, evidence_checkpoint: 2 });
    expect(out.data.steps[3].done).toBe(false);
  });

  it('two cps claiming the same step are forbidden by the open-time disjointness rule', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-4', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'first claim',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-4' }
    );
    await expect(
      store.writeCheckpointOpened(
        { artifact_id: 'a1', declared_step_ids: ['step-1'] },
        { idempotencyKey: 'cp-open-5', headSha: 'cafef00d' }
      )
    ).rejects.toThrow(/OPEN_CP_OVERLAP/);
  });

  it('a cp with completed_step_ids=[] claims nothing', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'Redis middleware', label: 'step-1', acceptance_criteria: [] },
        {
          step_id: 'step-2',
          text: 'mount on /api/charge',
          label: 'step-2',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    // Shape under test: cp summary describes work but doesn't claim it.
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-6', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wired Redis middleware module — totally did the thing',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-6' }
    );
    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.steps.every((s) => !s.done)).toBe(true);
  });

  // ── Open uncertainty / summary integration ──────

  it('aggregates open uncertainty across checkpoints (deduped, first-seen wins)', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-7', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: ['ttl strategy', 'multi-region eviction'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-7' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-2'] },
      { idempotencyKey: 'cp-open-8', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2',
        files_changed: [],
        decisions: [],
        uncertainty: ['ttl strategy', 'shadow mode toggle'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'cp-close-8' }
    );

    const out = await buildResume({ store, artifactId: 'a1' });
    const items = out.data.open_uncertainty.map((u) => u.item);
    expect(items).toEqual(['ttl strategy', 'multi-region eviction', 'shadow mode toggle']);
    expect(out.data.open_uncertainty[0].checkpoint).toBe(1);
    expect(out.data.open_uncertainty[2].checkpoint).toBe(2);
  });

  // ── Decisions (the WHY a resuming agent inherits) ─────────

  it('aggregates plan + checkpoint decisions in order with distinct provenance (NOT deduped)', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      decisions: [
        {
          decision: 'imperative in-transaction enqueueCommand',
          reason: 'atomic with the write',
          revision_n: 0,
          alternatives_considered: [
            {
              option: 'event-listener trigger',
              rejected_because: 'async gap risked double-dispatch',
            },
          ],
        },
      ],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-dec-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [
          {
            decision: 'token bucket over fixed window',
            reason: 'avoids boundary burst',
            alternatives_considered: [
              { option: 'fixed-window counter', rejected_because: 'allows a 2x boundary burst' },
            ],
          },
        ],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-dec-1' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-2'] },
      { idempotencyKey: 'cp-open-dec-2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2',
        files_changed: [],
        // Same decision text as cp1 (different reason) proves we do NOT
        // dedup — unlike open_uncertainty above.
        decisions: [
          { decision: 'token bucket over fixed window', reason: 'kept consistent with cp1' },
          { decision: 'reuse the existing redis client', reason: 'no new connection pool' },
        ],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'cp-close-dec-2' }
    );

    const out = await buildResume({ store, artifactId: 'a1' });
    // Plan-time decisions come first (source 'plan', revision-tagged), then
    // checkpoint-close decisions in cp order. Not deduped.
    expect(out.data.decisions).toEqual([
      {
        decision: 'imperative in-transaction enqueueCommand',
        reason: 'atomic with the write',
        source: 'plan',
        revision_n: 0,
        alternatives_considered: [
          {
            option: 'event-listener trigger',
            rejected_because: 'async gap risked double-dispatch',
          },
        ],
      },
      {
        decision: 'token bucket over fixed window',
        reason: 'avoids boundary burst',
        source: 'checkpoint',
        checkpoint: 1,
        alternatives_considered: [
          { option: 'fixed-window counter', rejected_because: 'allows a 2x boundary burst' },
        ],
      },
      {
        decision: 'token bucket over fixed window',
        reason: 'kept consistent with cp1',
        source: 'checkpoint',
        checkpoint: 2,
      },
      {
        decision: 'reuse the existing redis client',
        reason: 'no new connection pool',
        source: 'checkpoint',
        checkpoint: 2,
      },
    ]);
    // Rendered in the markdown ("## decisions") with provenance labels that
    // distinguish a plan decision from a checkpoint decision.
    expect(out.markdown).toContain('## decisions');
    expect(out.markdown).toContain('**imperative in-transaction enqueueCommand** _(plan rev 0)_');
    expect(out.markdown).toContain('**token bucket over fixed window** _(cp 1)_');
    expect(out.markdown).toContain('avoids boundary burst');
    // ... and in the paste-ready agent prompt (the load-bearing cross-agent surface).
    expect(out.data.agent_prompt).toContain('Decisions made so far:');
    expect(out.data.agent_prompt).toContain(
      'imperative in-transaction enqueueCommand: atomic with the write _(plan rev 0)_'
    );
    expect(out.data.agent_prompt).toContain(
      'reuse the existing redis client: no new connection pool _(cp 2)_'
    );
    // alternatives_considered (the rejected option) flows to all three surfaces —
    // this is the rationale the cross-agent channel exists to preserve.
    expect(out.markdown).toContain(
      '_considered_ **event-listener trigger** — rejected because async gap risked double-dispatch'
    );
    expect(out.markdown).toContain(
      '_considered_ **fixed-window counter** — rejected because allows a 2x boundary burst'
    );
    expect(out.data.agent_prompt).toContain(
      'considered event-listener trigger — rejected because async gap risked double-dispatch'
    );
    // Exactly the two decisions that recorded alternatives render a considered line;
    // the other two (no alternatives) stay clean.
    expect(out.markdown.match(/_considered_/g)?.length).toBe(2);
  });

  it('renders "_None recorded._" for decisions and omits the prompt block when none exist', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });

    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.decisions).toEqual([]);
    expect(out.markdown).toMatch(/## decisions\n\n_None recorded\._/);
    expect(out.data.agent_prompt).not.toContain('Decisions made so far');
  });

  it('marks the artifact as complete when a summary exists; pulls open_items from it', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-9', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 's1 work',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-9' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: 'a1',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: ['follow-up X', 'follow-up Y'],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });

    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.is_complete).toBe(true);
    expect(out.data.open_items).toEqual(['follow-up X', 'follow-up Y']);
    expect(out.markdown).toContain('_This artifact is already marked complete');
  });

  // ── Agent prompt block ───────────────────────────────────────────────

  it('emits an agent prompt block with completed/remaining/open sections', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add rate limiting',
      label: 'lbl',
      plan_steps: [
        {
          step_id: 'step-1',
          text: 'implement Redis middleware',
          label: 'step-1',
          acceptance_criteria: [],
        },
        {
          step_id: 'step-2',
          text: 'mount on /api/charge',
          label: 'step-2',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-10', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'wired',
        files_changed: [],
        decisions: [],
        uncertainty: ['ttl strategy'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-10' }
    );

    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.agent_prompt).toContain('Continue work on: add rate limiting');
    expect(out.data.agent_prompt).toContain('Completed:');
    expect(out.data.agent_prompt).toContain('- step-1 — implement Redis middleware');
    expect(out.data.agent_prompt).toContain('Remaining:');
    expect(out.data.agent_prompt).toContain('- step-2 — mount on /api/charge');
    expect(out.data.agent_prompt).toContain('Open questions:');
    expect(out.data.agent_prompt).toContain('- ttl strategy');
  });

  // ── Throws / persistence / shape ────────────────────────────────────

  it('throws when no plan exists for the artifact', async () => {
    await expect(buildResume({ store, artifactId: 'missing00' })).rejects.toThrow(/no plan/);
  });

  it('last_checkpoint_head_sha reflects the highest-n checkpoint', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-11', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-11' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: 'a1', declared_step_ids: ['step-2'] },
      { idempotencyKey: 'cp-open-12', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a1',
        n: 2,
        summary: 'cp2',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'cp-close-12' }
    );
    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.last_checkpoint_head_sha).toBe('bbbb2222');
  });

  it('null last_checkpoint_head_sha when there are zero checkpoints', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    const out = await buildResume({ store, artifactId: 'a1' });
    expect(out.data.last_checkpoint_head_sha).toBeNull();
    expect(out.data.checkpoint_count).toBe(0);
  });

  // ── Open checkpoints + uncovered plan steps render ────────

  it('emits ## open checkpoints + ## uncovered plan steps when populated', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-open',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'multi-agent dispatch',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 's2', label: 'step-2', acceptance_criteria: [] },
        { step_id: 'step-3', text: 's3', label: 'step-3', acceptance_criteria: [] },
        { step_id: 'step-4', text: 's4', label: 'step-4', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    // cp 1: closed, claims [1].
    await store.writeCheckpointOpened(
      { artifact_id: 'a-open', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-A', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-open',
        n: 1,
        summary: 's1 done',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-A' }
    );
    // cp 2: open, declares [2,3] — agent_session_id present.
    await store.writeCheckpointOpened(
      {
        artifact_id: 'a-open',
        declared_step_ids: ['step-2', 'step-3'],
        agent_session_id: 'subagent-b',
      },
      { idempotencyKey: 'cp-open-B', headSha: 'cafef00d' }
    );

    const out = await buildResume({ store, artifactId: 'a-open' });
    // Data shape — open_checkpoints includes the in-flight cp 2.
    expect(out.data.open_checkpoints).toHaveLength(1);
    expect(out.data.open_checkpoints[0]).toMatchObject({
      n: 2,
      declared_step_ids: ['step-2', 'step-3'],
      agent_session_id: 'subagent-b',
    });
    expect(out.data.open_checkpoints[0].idle_for_seconds).toBeGreaterThanOrEqual(0);
    // Uncovered = step 4 (1 closed-claimed, 2/3 open-declared, 4 free).
    expect(out.data.uncovered_step_ids).toEqual(['step-4']);

    // Markdown shape — sections appear with cp + step content.
    expect(out.markdown).toContain('## open checkpoints');
    expect(out.markdown).toContain('**cp 2**');
    expect(out.markdown).toContain('declared step_ids [step-2, step-3]');
    expect(out.markdown).toContain('agent_session_id: `subagent-b`');
    expect(out.markdown).toContain('## uncovered plan steps');
    expect(out.markdown).toContain('- 4. step-4 — s4');

    // Agent prompt shape — both bullets surfaced for resumed agent.
    expect(out.data.agent_prompt).toContain('Open checkpoints (in-flight from prior session):');
    expect(out.data.agent_prompt).toContain(
      '- cp 2: declared step_ids [step-2, step-3] agent_session_id=subagent-b'
    );
    expect(out.data.agent_prompt).toContain('Uncovered plan steps');
    expect(out.data.agent_prompt).toContain('- 4. step-4 — s4');
  });

  it('omits ## open checkpoints / ## uncovered plan steps when both are empty', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-clean',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'only-step', label: 'step-1', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    await store.writeCheckpointOpened(
      { artifact_id: 'a-clean', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-clean', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-clean',
        n: 1,
        summary: 'done',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-clean' }
    );
    const out = await buildResume({ store, artifactId: 'a-clean' });
    expect(out.data.open_checkpoints).toEqual([]);
    expect(out.data.uncovered_step_ids).toEqual([]);
    expect(out.markdown).not.toContain('## open checkpoints');
    expect(out.markdown).not.toContain('## uncovered plan steps');
  });

  it('writeResume persists to <artifact>/resume.md', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    const out = await writeResume({ store, artifactId: 'a1' });
    expect(out.path).toMatch(/resume\.md$/);
    const onDisk = await readFile(out.path, 'utf8');
    expect(onDisk).toBe(out.markdown);
  });

  it('writeResume refuses a symlinked cache file without changing its target', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a1',
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
    const resumePath = artifactPathsFor(repo.path, config, 'a1').resumeMd;
    const target = path.join(repo.path, 'source.md');
    await writeFile(target, 'unchanged', 'utf8');
    await symlink(target, resumePath);

    await expect(writeResume({ store, artifactId: 'a1' })).rejects.toThrow(PathContainmentError);
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });
});
