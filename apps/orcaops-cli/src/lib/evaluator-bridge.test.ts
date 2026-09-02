import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, Repo } from '@orcaops/core';
import { ArtifactStore, type Config, type SourcePlanPin } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import type { CliContext } from './context.js';
import { buildEvaluatorContext } from './evaluator-bridge.js';

/**
 * The bridge populates `EvaluatorContext.prior_plan` for
 * post-plan-revision evaluators when a prior revision exists.
 *
 * `buildBaseContext` MUST populate `prior_plan`: with it null, the three
 * `revision-*-stable` checkers (non-goals-stable, touched-scope-stable,
 * diff-bounded) pass regardless of actual drift — they read a null
 * priorPlan as "nothing to compare against".
 */
describe('buildEvaluatorContext — prior_plan population', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let ctx: CliContext;

  const branch = 'feat/prior-plan-test';
  const artifactId = '01999999-9999-7000-8000-000000000001';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';
  const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3KB';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // loadConfig needs `.orcaops/` to exist; createTempRepo doesn't set
    // it up. Build a minimal config in-memory instead.
    config = (await loadConfig(repo.path).catch(() => null)) as unknown as Config;
    if (!config) {
      // loadConfig refused — synthesize a default via storage's helper.
      const { getDefaultConfig } = await import('@orcaops/storage');
      config = getDefaultConfig();
    }
    store = new ArtifactStore({ repoRoot: repo.path, config });
    ctx = {
      repoRoot: repo.path,
      config,
      gates: { cloud: false },
      repo: new Repo(repo.path),
      store,
      archive: null,
      healedProjection: false,
      healResult: null,
      invokingAgent: { agent: 'claude-code', source: 'ambient' },
    };
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writeInitialPlan(sourcePlan?: SourcePlanPin): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'do the thing',
        label: 'initial-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: ['initial-scope'],
        non_goals: [
          {
            text: 'no-initial-pivots',
            rationale: 'out of scope for the initial slice',
            source_refs: [],
          },
        ],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      sourcePlan
        ? { idempotencyKey: 'init-plan-key', sourcePlan }
        : { idempotencyKey: 'init-plan-key' }
    );
  }

  async function revisePlanAddStepC(): Promise<void> {
    await store.revisePlan(
      {
        idempotency_key: 'revise-add-c',
        artifact_id: artifactId,
        label: 'revised-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
          { text: 'step c text', label: 'step-c', acceptance_criteria: [] },
        ],
        touched_scope: ['initial-scope', 'new-scope'],
        non_goals: [
          {
            text: 'no-initial-pivots',
            rationale: 'out of scope for the initial slice',
            source_refs: [],
          },
          { text: 'no-second-pivots', rationale: 'deferred to a later artifact', source_refs: [] },
        ],
        rationale: 'discovered a missing step c',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
        decisions: [],
      },
      { idempotencyKey: 'revise-add-c' }
    );
  }

  it('returns null prior_plan on post-plan (initial capture has no prior)', async () => {
    await writeInitialPlan();
    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'post-plan',
    });
    expect(evalCtx.prior_plan).toBeNull();
  });

  it('maps a pinned source_plan into the context (explicit mapper carries content)', async () => {
    // Populated baseline: the strict context schema rejects unknown keys, so
    // the exact toEqual below also pins that the by-name mapper DROPS the
    // baseline — the evaluator context stays origin/git-state agnostic.
    const pin: SourcePlanPin = {
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'Step 1: anchor\nStep 2: evaluator\n',
      hash: 'b'.repeat(64),
      baseline: {
        repo_url: 'https://github.com/acme/widgets',
        branch: 'main',
        head_sha: 'c'.repeat(40),
      },
    };
    await writeInitialPlan(pin);
    const evalCtx = await buildEvaluatorContext({ ctx, artifactId, firesAt: 'post-plan' });
    // The evaluator context carries the full content (the conformance judge
    // reads it) — unlike the content-free digest summary.
    expect(evalCtx.source_plan).toEqual({
      source_ref: { kind: 'local', locator: 'docs/plan.md' },
      content: 'Step 1: anchor\nStep 2: evaluator\n',
      hash: 'b'.repeat(64),
    });
  });

  it('source_plan is null when the artifact was not pinned', async () => {
    await writeInitialPlan();
    const evalCtx = await buildEvaluatorContext({ ctx, artifactId, firesAt: 'post-plan' });
    expect(evalCtx.source_plan).toBeNull();
  });

  it('returns null prior_plan on post-plan-revision when revision_n is 0', async () => {
    // No revise — only the initial capture exists; revision_n stays 0.
    await writeInitialPlan();
    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'post-plan-revision',
    });
    expect(evalCtx.prior_plan).toBeNull();
  });

  it('populates prior_plan on post-plan-revision when revision_n > 0', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'post-plan-revision',
    });
    expect(evalCtx.prior_plan).not.toBeNull();
    expect(evalCtx.prior_plan!.revision_n).toBe(0);
    expect(evalCtx.prior_plan!.label).toBe('initial-label');
    expect(evalCtx.prior_plan!.plan_steps).toHaveLength(2);
    expect(evalCtx.prior_plan!.plan_steps.map((s) => s.step_id)).toEqual([STEP_A, STEP_B]);
    // Prior touched_scope / non_goals are the initial values — the
    // three revision-*-stable checkers depend on this. non_goals are
    // structured (text + rationale + source_refs), not flattened.
    expect(evalCtx.prior_plan!.touched_scope).toEqual(['initial-scope']);
    expect(evalCtx.prior_plan!.non_goals).toEqual([
      {
        text: 'no-initial-pivots',
        rationale: 'out of scope for the initial slice',
        source_refs: [],
      },
    ]);
    // Current plan should reflect the revision.
    expect(evalCtx.plan.revision_n).toBe(1);
    expect(evalCtx.plan.label).toBe('revised-label');
    expect(evalCtx.plan.plan_steps).toHaveLength(3);
  });

  it('keeps a revision pass pinned when a newer plan is already live', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();
    const revisionOne = await store.readPlan(artifactId);
    const initialPlan = await store.readPlanRevision(artifactId, 0);
    if (revisionOne === null || initialPlan === null) throw new Error('missing plan fixture');

    await store.revisePlan(
      {
        idempotency_key: 'revise-after-pinned-pass',
        artifact_id: artifactId,
        label: 'newer-label',
        plan_steps: revisionOne.plan_steps.map((step) => ({
          step_id: step.step_id,
          text: step.text,
          label: step.label,
          acceptance_criteria: step.acceptance_criteria,
        })),
        touched_scope: ['newer-scope'],
        non_goals: revisionOne.non_goals,
        rationale: 'advance while the earlier pass is pending',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
        decisions: [],
      },
      { idempotencyKey: 'revise-after-pinned-pass' }
    );

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'post-plan-revision',
      planOverride: revisionOne,
      priorPlanOverride: initialPlan,
    });
    expect(evalCtx.plan.revision_n).toBe(1);
    expect(evalCtx.plan.label).toBe('revised-label');
    expect(evalCtx.prior_plan?.revision_n).toBe(0);
    expect((await store.readPlan(artifactId))?.revision_n).toBe(2);
  });

  it('returns null prior_plan on non-revision phases even with revisions present', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();

    for (const firesAt of ['post-plan', 'checkpoint-open', 'checkpoint-close', 'pre-pr'] as const) {
      const evalCtx = await buildEvaluatorContext({
        ctx,
        artifactId,
        firesAt,
      });
      expect(evalCtx.prior_plan, `prior_plan should be null on ${firesAt}`).toBeNull();
    }
  });
});

/**
 * The bridge's `toSummaryContext` populates the protocol-side
 * `deferred_decisions` and `written_at` fields from the real Summary
 * event — never a hardcoded `deferred_decisions: []` nor a synthesized
 * `ts: plan.started_at`. Both fields are evaluator inputs, so substituting
 * defaults would give checks a false account of the captured summary.
 */
describe('buildEvaluatorContext — summary fields', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let ctx: CliContext;

  const branch = 'feat/summary-fields-test';
  const artifactId = '01999999-9999-7000-8000-000000000002';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KD';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    const { getDefaultConfig } = await import('@orcaops/storage');
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    ctx = {
      repoRoot: repo.path,
      config,
      gates: { cloud: false },
      repo: new Repo(repo.path),
      store,
      archive: null,
      healedProjection: false,
      healResult: null,
      invokingAgent: { agent: 'claude-code', source: 'ambient' },
    };
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writeMinimalPlan(): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'summary fields test',
        label: 'summary-fields',
        plan_steps: [
          { step_id: STEP_A, text: 'do the thing', label: 'do-it', acceptance_criteria: [] },
        ],
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
      },
      { idempotencyKey: 'plan-key' }
    );
  }

  it('returns summary: null when no summary has been captured', async () => {
    await writeMinimalPlan();
    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'pre-pr',
    });
    expect(evalCtx.summary).toBeNull();
  });

  it('populates deferred_decisions and written_at from the real summary event', async () => {
    await writeMinimalPlan();
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'shipped with caveats',
        tests_written: ['wrote a unit test'],
        tests_run: ['ran the suite'],
        open_items: ['follow up on edge case X'],
        deferred_decisions: [
          'punted on caching strategy — revisit when load profile is known',
          'left auth integration to follow-up artifact',
        ],
        head_sha: 'sha-head',
        ts: '2026-04-26T13:30:00.000Z',
      },
      { idempotencyKey: 'summary-key' }
    );

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'pre-pr',
    });
    expect(evalCtx.summary).not.toBeNull();
    expect(evalCtx.summary!.deferred_decisions).toEqual([
      'punted on caching strategy — revisit when load profile is known',
      'left auth integration to follow-up artifact',
    ]);
    // written_at must be the summary event's real timestamp, NOT
    // plan.started_at.
    expect(evalCtx.summary!.written_at).toBe('2026-04-26T13:30:00.000Z');
    expect(evalCtx.summary!.written_at).not.toBe(evalCtx.plan.started_at);
  });

  it('preserves an empty deferred_decisions array (default) when none were captured', async () => {
    await writeMinimalPlan();
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'clean',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-head',
        ts: '2026-04-26T14:00:00.000Z',
      },
      { idempotencyKey: 'summary-empty-key' }
    );

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'pre-pr',
    });
    expect(evalCtx.summary!.deferred_decisions).toEqual([]);
    expect(evalCtx.summary!.written_at).toBe('2026-04-26T14:00:00.000Z');
  });
});

describe('buildEvaluatorContext — verified-close verification mapping', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let ctx: CliContext;

  const artifactId = '01999999-9999-7000-8000-00000000000b';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = (await loadConfig(repo.path).catch(() => null)) as unknown as Config;
    if (!config) {
      const { getDefaultConfig } = await import('@orcaops/storage');
      config = getDefaultConfig();
    }
    store = new ArtifactStore({ repoRoot: repo.path, config });
    ctx = {
      repoRoot: repo.path,
      config,
      gates: { cloud: false },
      repo: new Repo(repo.path),
      store,
      archive: null,
      healedProjection: false,
      healResult: null,
      invokingAgent: { agent: 'claude-code', source: 'ambient' },
    };
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'feat/verify',
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'verification mapping',
        label: 'verification-mapping',
        plan_steps: [{ step_id: STEP_A, text: 'step a', label: 'step-a', acceptance_criteria: [] }],
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
      },
      { idempotencyKey: 'plan-key' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_A] },
      { idempotencyKey: 'open-key', headSha: 'cafef00d' }
    );
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function closeWith(verification?: Array<Record<string, unknown>>): Promise<void> {
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'done',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        ...(verification !== undefined ? { verification: verification as never } : {}),
        completed_step_ids: verification === undefined ? [] : [STEP_A],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'close-key' }
    );
  }

  it('OMITS the verification key from the context when nothing was cited', async () => {
    await closeWith();
    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'checkpoint-close',
      checkpointN: 1,
    });
    // Key-absence must survive into the object JSON.stringify serializes —
    // separately-built packs re-validate with their own (older, strict)
    // schema copy and would throw unrecognized_keys on an always-present key.
    expect(evalCtx.current_checkpoint).toBeDefined();
    expect('verification' in (evalCtx.current_checkpoint as Record<string, unknown>)).toBe(false);
  });

  it('carries cited verification entries into the context field-picked', async () => {
    await closeWith([
      { command: 'pnpm test', exit_code: 0, output_digest: 'turbo 23/23', note: 'full gate' },
    ]);
    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'checkpoint-close',
      checkpointN: 1,
    });
    const cp = evalCtx.current_checkpoint as Record<string, unknown>;
    expect(cp.verification).toEqual([
      { command: 'pnpm test', exit_code: 0, output_digest: 'turbo 23/23', note: 'full gate' },
    ]);
  });
});
