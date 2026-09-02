import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { type Config, getDefaultConfig } from '../schema/config.js';
import type { SourcePlanPin } from '../schema/source-plan.js';

const passingPrePrReview = (headSha: string) => ({
  head_sha: headSha,
  outcome: 'passed' as const,
  evaluator_set_fingerprint: 'a'.repeat(64),
  review_context_fingerprint: 'b'.repeat(64),
  run_ids: [],
});

// non_goals are structured { text, rationale, source_refs }.
const NG_INITIAL = {
  text: 'no-initial-pivots',
  rationale: 'out of scope for the initial slice',
  source_refs: [] as string[],
};
const NG_SECOND = {
  text: 'no-second-pivots',
  rationale: 'deferred to a later artifact',
  source_refs: [] as string[],
};

/**
 * `readPlanRevision` returns a fully-validated Plan projection for a
 * specific revision_n. Used by the evaluator bridge to populate
 * `EvaluatorContext.prior_plan` on post-plan-revision evaluators.
 *
 * The three `revision-*-stable` checkers (revision-non-goals-stable,
 * revision-touched-scope-stable, revision-diff-bounded) compare the
 * current plan against the prior revision to detect scope drift; if
 * `readPlanRevision` returns the wrong shape, those evaluators silently
 * pass instead of flagging real drift.
 */
describe('ArtifactStore.readPlanRevision', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/x';
  const artifactId = '01999999-9999-7000-8000-000000000001';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';
  const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3KB';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
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
        agent_session_id: 'session-init',
        task: 'do the thing',
        label: 'initial-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: ['initial-scope'],
        non_goals: [NG_INITIAL],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'init-plan-key', sourcePlan }
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
        non_goals: [NG_INITIAL, NG_SECOND],
        decisions: [],
        rationale: 'discovered a missing step c',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'revise-add-c' }
    );
  }

  it('returns null when the artifact does not exist', async () => {
    const result = await store.readPlanRevision('unknown-artifact-id', 0);
    expect(result).toBeNull();
  });

  it('accumulates plan decisions across revisions (append-only, monotonic revision_n, per-revision readback)', async () => {
    // rev 0: initial plan carries one decision (revision_n stamped by the CLI caller).
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'do the thing',
        label: 'rev0-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [
          {
            decision: 'imperative in-transaction enqueueCommand',
            reason: 'atomic with the write; no eventual-consistency window',
            revision_n: 0,
            alternatives_considered: [
              {
                option: 'event-listener trigger',
                rejected_because: 'async gap risked double-dispatch',
              },
            ],
          },
        ],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'cumulate-init' }
    );

    // rev 1: revise supplies only the NEW decision (base shape — no revision_n).
    await store.revisePlan(
      {
        idempotency_key: 'cumulate-r1',
        artifact_id: artifactId,
        label: 'rev1-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [
          { decision: 'config-loader pass before mount', reason: 'discovered prerequisite' },
        ],
        rationale: 'add a decision',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'cumulate-r1' }
    );

    // rev 2: another new decision.
    await store.revisePlan(
      {
        idempotency_key: 'cumulate-r2',
        artifact_id: artifactId,
        label: 'rev2-label',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [
          { decision: 'token bucket over fixed window', reason: 'smooths burst-at-boundary' },
        ],
        rationale: 'add another decision',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'cumulate-r2' }
    );

    // Latest (rev 2) holds the full cumulative set, each tagged with its origin revision.
    const latest = await store.readPlan(artifactId);
    expect(latest?.decisions.map((d) => [d.decision, d.revision_n])).toEqual([
      ['imperative in-transaction enqueueCommand', 0],
      ['config-loader pass before mount', 1],
      ['token bucket over fixed window', 2],
    ]);
    // The rev-0 decision keeps its alternatives through all the cumulation.
    expect(latest?.decisions[0].alternatives_considered).toEqual([
      { option: 'event-listener trigger', rejected_because: 'async gap risked double-dispatch' },
    ]);

    // Per-revision readback: each prior revision holds exactly the decisions known
    // at that point (load-bearing — feeds prior_plan.decisions for evaluators).
    const rev0 = await store.readPlanRevision(artifactId, 0);
    expect(rev0?.decisions.map((d) => d.decision)).toEqual([
      'imperative in-transaction enqueueCommand',
    ]);
    const rev1 = await store.readPlanRevision(artifactId, 1);
    expect(rev1?.decisions.map((d) => [d.decision, d.revision_n])).toEqual([
      ['imperative in-transaction enqueueCommand', 0],
      ['config-loader pass before mount', 1],
    ]);
  });

  it('revise idempotency keys on the new decisions (same -> replay, different -> conflict)', async () => {
    await writeInitialPlan();
    const reviseWith = (key: string, decisions: Array<{ decision: string; reason: string }>) =>
      store.revisePlan(
        {
          idempotency_key: key,
          artifact_id: artifactId,
          label: 'rev-label',
          plan_steps: [
            { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
            { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
          ],
          touched_scope: ['initial-scope'],
          non_goals: [NG_INITIAL],
          decisions,
          rationale: 'first revise',
          prior_plan_event_id: null,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: key }
      );

    const first = await reviseWith('rk', [{ decision: 'use X', reason: 'because Y' }]);
    expect(first.outcome).toBe('created');

    // Same key + byte-identical new decisions -> replay (no second revision).
    const replay = await reviseWith('rk', [{ decision: 'use X', reason: 'because Y' }]);
    expect(replay.outcome).toBe('replay');

    // Same key + DIFFERENT decisions -> conflict: the extract shape filters the
    // committed cumulative set to THIS revision's new entries and strips
    // revision_n, so a changed decision is detected as a conflicting payload.
    const conflict = await reviseWith('rk', [{ decision: 'use Z', reason: 'because W' }]);
    expect(conflict.outcome).toBe('conflict');

    // The replay never advanced the revision; latest is revision 1 with the
    // first decision stamped at revision_n 1.
    const latest = await store.readPlan(artifactId);
    expect(latest?.revision_n).toBe(1);
    expect(latest?.decisions).toEqual([{ decision: 'use X', reason: 'because Y', revision_n: 1 }]);
  });

  it('readPlan recovers rev-1 decisions from a stale rev-0 plan.json after a plan_revised', async () => {
    // rev 0 carries a decision; snapshot its on-disk projection.
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'sha-base',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'do the thing',
        label: 'recov-rev0',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [{ decision: 'd0 decision', reason: 'r0', revision_n: 0 }],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'recov-init' }
    );
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const staleRev0Json = await readFile(paths.planJson, 'utf8');

    // rev 1 adds a decision (advances the event log + rewrites plan.json to rev 1).
    await store.revisePlan(
      {
        idempotency_key: 'recov-r1',
        artifact_id: artifactId,
        label: 'recov-rev1',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [{ decision: 'd1 decision', reason: 'r1' }],
        rationale: 'add d1',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'recov-r1' }
    );

    // Simulate a crash AFTER the plan_revised was appended but BEFORE plan.json
    // was rewritten: restore the stale rev-0 projection (its source_event_id
    // still points at the plan_captured event).
    await writeFile(paths.planJson, staleRev0Json);

    // Recovery must see that the latest plan event is the plan_revised (not the
    // capture the stale projection points at) and REBUILD -> rev 1 with both
    // decisions. `plan_revised` must be in `relevantTypes`, else a stale
    // projection is trusted as current and the rev-1 decision is lost on read.
    const recovered = await store.readPlan(artifactId);
    expect(recovered?.revision_n).toBe(1);
    expect(recovered?.decisions.map((d) => [d.decision, d.revision_n])).toEqual([
      ['d0 decision', 0],
      ['d1 decision', 1],
    ]);
  });

  it('keeps the pinned source plan immutable across a plan revise', async () => {
    // Populated baseline: the toEqual below also proves writePlan round-trips
    // the authoring baseline and a plan_revised never disturbs it.
    const pin: SourcePlanPin = {
      source_ref: { kind: 'local', locator: 'plans/rate-limit.md' },
      content: '# slice plan\n\n- pin\n- non_goals\n',
      hash: 'b'.repeat(64),
      baseline: {
        repo_url: 'https://github.com/acme/widgets',
        branch: 'feature/pin-baseline',
        head_sha: 'c'.repeat(40),
      },
    };
    await writeInitialPlan(pin);
    await revisePlanAddStepC();

    const paths = artifactPathsFor(repo.path, config, artifactId);
    const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
    // The pin is projected off the plan_captured event only; a
    // plan_revised must never disturb it (freeze-at-capture).
    expect(artifactJson.source_plan).toEqual(pin);
    expect(artifactJson.plan_revision_count).toBe(1);
  });

  it('does NOT finalize on pre_pr_checked — plan revise still succeeds (decoupling)', async () => {
    await writeInitialPlan();
    await store.writePrePrChecked(artifactId, passingPrePrReview('sha-prepr'));
    // pre-pr is a repeatable gate, not finalization: a passing pre-pr must
    // NOT freeze plan revision.
    await expect(revisePlanAddStepC()).resolves.toBeUndefined();

    const paths = artifactPathsFor(repo.path, config, artifactId);
    const artifactJson = JSON.parse(await readFile(paths.artifactJson, 'utf8'));
    expect(artifactJson.plan_revision_count).toBe(1);
    // The revise advanced the event log → the pre-pr marker is now stale.
    expect(artifactJson.pre_pr_checked_source_event_id).not.toBe(artifactJson.source_event_id);
  });

  it('still finalizes on summary_captured — plan revise is rejected', async () => {
    await writeInitialPlan();
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'done',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-04-26T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-1' }
    );
    await expect(revisePlanAddStepC()).rejects.toThrow(/frozen post-finalization/);
  });

  it('returns null when revision_n is negative', async () => {
    await writeInitialPlan();
    expect(await store.readPlanRevision(artifactId, -1)).toBeNull();
  });

  it('returns null when revision_n exceeds the latest revision', async () => {
    await writeInitialPlan();
    expect(await store.readPlanRevision(artifactId, 1)).toBeNull();
    expect(await store.readPlanRevision(artifactId, 99)).toBeNull();
  });

  it('returns the initial plan when revision_n=0 on a freshly captured artifact', async () => {
    await writeInitialPlan();
    const result = await store.readPlanRevision(artifactId, 0);
    expect(result).not.toBeNull();
    expect(result!.revision_n).toBe(0);
    expect(result!.label).toBe('initial-label');
    expect(result!.plan_steps).toEqual([
      { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
      { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
    ]);
    expect(result!.touched_scope).toEqual(['initial-scope']);
    expect(result!.non_goals).toEqual([NG_INITIAL]);
    expect(result!.rationale).toBeNull();
    expect(result!.revised_at).toBeNull();
    expect(result!.prior_plan_event_id).toBeNull();
  });

  it('returns the prior revision after a revise (revision_n=0 carries the initial plan shape)', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();

    const prior = await store.readPlanRevision(artifactId, 0);
    expect(prior).not.toBeNull();
    expect(prior!.revision_n).toBe(0);
    expect(prior!.label).toBe('initial-label');
    expect(prior!.plan_steps).toEqual([
      { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
      { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
    ]);
    // Prior touched_scope / non_goals are the initial values, not the
    // revised ones — this is the property the three revision-*-stable
    // checkers depend on.
    expect(prior!.touched_scope).toEqual(['initial-scope']);
    expect(prior!.non_goals).toEqual([NG_INITIAL]);
    expect(prior!.rationale).toBeNull();
    expect(prior!.prior_plan_event_id).toBeNull();
  });

  it('returns the latest revision shape when revision_n equals latest (short-circuits to readPlan)', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();

    const latest = await store.readPlanRevision(artifactId, 1);
    expect(latest).not.toBeNull();
    expect(latest!.revision_n).toBe(1);
    expect(latest!.label).toBe('revised-label');
    expect(latest!.plan_steps).toHaveLength(3);
    expect(latest!.plan_steps[2].label).toBe('step-c');
    expect(latest!.touched_scope).toEqual(['initial-scope', 'new-scope']);
    expect(latest!.non_goals).toEqual([NG_INITIAL, NG_SECOND]);
    expect(latest!.rationale).toBe('discovered a missing step c');
    expect(latest!.revised_at).not.toBeNull();
  });

  it('carries artifact-stable fields (branch, base_sha, agent, agent_session_id, task, started_at) from the latest plan into the prior revision', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();

    const prior = await store.readPlanRevision(artifactId, 0);
    expect(prior!.branch).toBe(branch);
    expect(prior!.base_sha).toBe('sha-base');
    expect(prior!.agent).toBe('claude-code');
    expect(prior!.agent_session_id).toBe('session-init');
    expect(prior!.task).toBe('do the thing');
    expect(prior!.started_at).toBe('2026-04-26T12:00:00.000Z');
  });

  it('survives two revisions and returns each prior revision intact', async () => {
    await writeInitialPlan();
    await revisePlanAddStepC();
    // Second revise — drop step C.
    await store.revisePlan(
      {
        idempotency_key: 'revise-drop-c',
        artifact_id: artifactId,
        label: 'revised-label-2',
        plan_steps: [
          { step_id: STEP_A, text: 'step a text', label: 'step-a', acceptance_criteria: [] },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
        touched_scope: ['initial-scope'],
        non_goals: [NG_INITIAL],
        decisions: [],
        rationale: 'step c was wrong, backing it out',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'revise-drop-c' }
    );

    const rev0 = await store.readPlanRevision(artifactId, 0);
    const rev1 = await store.readPlanRevision(artifactId, 1);
    const rev2 = await store.readPlanRevision(artifactId, 2);
    const rev3 = await store.readPlanRevision(artifactId, 3);

    expect(rev0!.revision_n).toBe(0);
    expect(rev0!.label).toBe('initial-label');
    expect(rev1!.revision_n).toBe(1);
    expect(rev1!.label).toBe('revised-label');
    expect(rev1!.plan_steps).toHaveLength(3);
    expect(rev2!.revision_n).toBe(2);
    expect(rev2!.label).toBe('revised-label-2');
    expect(rev2!.plan_steps).toHaveLength(2);
    expect(rev2!.rationale).toBe('step c was wrong, backing it out');
    expect(rev3).toBeNull();
  });

  it('idempotency: re-omitting a minted criterion replays; changing criterion text conflicts', async () => {
    await writeInitialPlan();
    const reviseInput = {
      idempotency_key: 'revise-add-criterion',
      artifact_id: artifactId,
      label: 'revised-label',
      plan_steps: [
        {
          step_id: STEP_A,
          text: 'step a text',
          label: 'step-a',
          acceptance_criteria: [{ text: 'ship a passing test' }],
        },
        { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
      ],
      touched_scope: ['initial-scope'],
      non_goals: [NG_INITIAL],
      decisions: [],
      rationale: 'add an acceptance criterion to step a',
      prior_plan_event_id: null,
      acknowledge_drops_completed_steps: [],
      acknowledge_criteria_changes: [],
    };

    const first = await store.revisePlan(reviseInput, { idempotencyKey: 'revise-add-criterion' });
    expect(first.outcome).toBe('created');
    const mintedId =
      first.outcome === 'created'
        ? first.plan.plan_steps[0].acceptance_criteria[0].criterion_id
        : '';
    expect(mintedId).not.toBe('');

    // Same key, same input (criterion_id still omitted) -> replay, not a new
    // mint or a conflict. The extract helper nulls the minted id (recorded in
    // criterion_lineage.added) so the committed shape matches the re-omitted input.
    const replay = await store.revisePlan(reviseInput, { idempotencyKey: 'revise-add-criterion' });
    expect(replay.outcome).toBe('replay');
    if (replay.outcome === 'replay') {
      expect(replay.plan.plan_steps[0].acceptance_criteria[0].criterion_id).toBe(mintedId);
    }

    // Same key, CHANGED criterion text -> conflict (the replay shape differs
    // even though the omitted criterion_id normalizes the same way).
    const conflict = await store.revisePlan(
      {
        ...reviseInput,
        plan_steps: [
          {
            step_id: STEP_A,
            text: 'step a text',
            label: 'step-a',
            acceptance_criteria: [{ text: 'ship TWO passing tests' }],
          },
          { step_id: STEP_B, text: 'step b text', label: 'step-b', acceptance_criteria: [] },
        ],
      },
      { idempotencyKey: 'revise-add-criterion' }
    );
    expect(conflict.outcome).toBe('conflict');
  });
});
