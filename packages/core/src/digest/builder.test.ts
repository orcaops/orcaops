import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactPathsFor,
  ArtifactStore,
  type Config,
  type EvaluatorDispositionPayload,
  type EvaluatorRunPayload,
  getDefaultConfig,
  uuidv7,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  buildDigest,
  demoteBodyHeadings,
  type DigestSourcePlan,
  type DigestUsage,
  usageFingerprint,
  writeDigest,
} from './builder.js';

describe('usageFingerprint', () => {
  const baseSession = {
    agent: 'claude-code',
    session_id: 's1',
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 200,
    record_count: 5,
  };
  const attributed_estimate = {
    input_tokens: 30,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40,
  };

  it('is unchanged for an all-standard session (no rich detail)', () => {
    const u: DigestUsage = { has_usage: true, sessions: [{ ...baseSession }], attributed_estimate };
    expect(usageFingerprint(u)).toBe('claude-code:s1:100:50:10:200:5|@:30:10:0:40');
  });

  it('flips when a dimensions/rate-class change is added (cached digest goes stale)', () => {
    const plain: DigestUsage = {
      has_usage: true,
      sessions: [{ ...baseSession }],
      attributed_estimate,
    };
    const rich: DigestUsage = {
      has_usage: true,
      sessions: [
        { ...baseSession, detail: { dimensions: { web_search_requests: 3 }, model_breakdown: [] } },
      ],
      attributed_estimate,
    };
    expect(usageFingerprint(rich)).not.toBe(usageFingerprint(plain));
  });

  it('does not fold a non-rich detail (no spurious staleness)', () => {
    const plain: DigestUsage = {
      has_usage: true,
      sessions: [{ ...baseSession }],
      attributed_estimate,
    };
    const notRich: DigestUsage = {
      has_usage: true,
      sessions: [
        {
          ...baseSession,
          detail: {
            model_breakdown: [
              {
                model: 'm',
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 200,
              },
            ],
          },
        },
      ],
      attributed_estimate,
    };
    // No dimensions and no non-default rate class → not rich → identical fingerprint.
    expect(usageFingerprint(notRich)).toBe(usageFingerprint(plain));
  });
});

describe('buildDigest / writeDigest', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/rate-limit';
  const startedAt = '2026-04-25T12:00:00.000Z';
  // Pinned literal: tests just need a stable handle, not a real UUIDv7.
  const artifactId = '01999999-9999-7000-8000-000000000001';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  /**
   * Mint + write an evaluator_run_recorded event with the current
   * `EvaluatorRunPayload` shape. Returns the assigned `run_id` so callers can chain a
   * paired disposition (acknowledged / dismissed / policy-excepted).
   *
   * Test-only namespace: `test-pack/<id>` — the test fixtures don't
   * configure a real pack, so refs only need to be stable strings; the
   * digest builder groups + renders by `evaluator_ref` verbatim.
   */
  async function seedRun(
    artId: string,
    p: {
      evaluator_id: string;
      phase: 'post-plan' | 'post-plan-revision' | 'checkpoint-open' | 'checkpoint-close' | 'pre-pr';
      severity: 'info' | 'warn' | 'block';
      verdict: 'pass' | 'info' | 'violation';
      body: string;
      ts: string;
      package_id?: string;
      checkpoint_n?: number;
    }
  ): Promise<string> {
    const packageId = p.package_id ?? 'test-pack';
    const runId = uuidv7();
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artId,
      evaluator_ref: `${packageId}/${p.evaluator_id}`,
      package_id: packageId,
      evaluator_id: p.evaluator_id,
      phase: p.phase,
      severity: p.severity,
      run_status: 'completed',
      verdict: p.verdict,
      body: p.body,
      ts: p.ts,
      ...(p.checkpoint_n !== undefined ? { checkpoint_n: p.checkpoint_n } : {}),
    };
    await store.writeEvaluatorRunPayload(artId, payload, { idempotencyKey: `run-${runId}` });
    return runId;
  }

  /**
   * Mint + write a paired disposition event resolving an earlier run.
   * Mirrors what the real `block acknowledge` / `block dismiss` CLI
   * flow produces, and what the cp-open inline policy-exception path
   * mints automatically.
   */
  async function seedDisposition(
    artId: string,
    p: {
      run_id: string;
      evaluator_ref: string;
      disposition: 'acknowledged' | 'dismissed' | 'policy-excepted';
      reason: string;
      ts: string;
    }
  ): Promise<string> {
    const dispositionId = uuidv7();
    const payload: EvaluatorDispositionPayload = {
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: dispositionId,
      artifact_id: artId,
      run_id: p.run_id,
      evaluator_ref: p.evaluator_ref,
      disposition: p.disposition,
      reason: p.reason,
      agent_session_id: null,
      ts: p.ts,
    };
    await store.writeEvaluatorDisposition(artId, payload, {
      idempotencyKey: `disp-${dispositionId}`,
    });
    return dispositionId;
  }

  /**
   * Seed a complete artifact thread covering every interesting case for
   * the renderer:
   *   - plan-mentions-tests (post-plan, warn) → process notes (pass)
   *   - api-signature-drift (post-cp, block, violation -> acknowledged)
   *     → release checks (acknowledged latest wins)
   *   - 2 checkpoints with files + decisions + uncertainty
   *   - summary with open_items, tests, deferred decisions
   */
  async function seedFullThread(): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add rate limiting to /api/charge',
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
      touched_scope: ['payments'],
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
      { artifact_id: artifactId, declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-1', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'wired Redis middleware',
        files_changed: ['src/middleware/rateLimiter.ts'],
        decisions: [
          { decision: 'token bucket over fixed window', reason: 'smoother burst handling' },
        ],
        uncertainty: ['ttl strategy if multi-region redis is added later'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-1' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: ['step-2'] },
      { idempotencyKey: 'cp-open-2', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 2,
        summary: 'mounted on /api/charge',
        files_changed: ['src/app.ts', 'src/middleware/rateLimiter.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-2'],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'cp-close-2' }
    );
    await seedRun(artifactId, {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'pass',
      body: 'PASS\n\nplan mentions tests',
      ts: '2026-04-25T12:00:01.000Z',
    });
    const apiViolationRunId = await seedRun(artifactId, {
      evaluator_id: 'api-signature-drift',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\n## findings\n- removed: `function refund(...)`',
      ts: '2026-04-25T12:30:01.000Z',
      checkpoint_n: 2,
    });
    await seedDisposition(artifactId, {
      run_id: apiViolationRunId,
      evaluator_ref: 'test-pack/api-signature-drift',
      disposition: 'acknowledged',
      reason: 'refund() was unused per grep',
      ts: '2026-04-25T12:31:00.000Z',
    });
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'rate limiter shipped',
      tests_written: ['tests/rateLimiter.test.ts'],
      tests_run: ['pnpm test rateLimiter'],
      open_items: ['ttl strategy for multi-region'],
      deferred_decisions: ['429 response shape (deferred to product)'],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });
  }

  it('renders plan decisions with plan-provenance distinct from cp, and deferred decisions in their own group', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
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
      decisions: [
        {
          decision: 'imperative in-transaction enqueueCommand',
          reason: 'atomic with the write',
          revision_n: 0,
          alternatives_considered: [
            { option: 'event-listener trigger', rejected_because: 'async double-dispatch' },
          ],
          evidence: {
            kind: 'git-commit',
            commit_sha: 'a'.repeat(40),
            quote: 'use an in-transaction enqueue command',
          },
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
      { artifact_id: artifactId, declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cpo-pd', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'did step 1',
        files_changed: [],
        decisions: [{ decision: 'token bucket over fixed window', reason: 'smooths burst' }],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cpc-pd' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: ['follow-up: rate-limit headers'],
      deferred_decisions: ['429 response shape (deferred to product)'],
      head_sha: 'aaaa1111',
      ts: '2026-04-25T13:00:00.000Z',
    });

    const out = await buildDigest({ store, artifactId });

    // Plan + checkpoint decisions coexist under "key decisions" with distinct labels.
    expect(out.markdown).toContain('## key decisions  _(captured)_');
    expect(out.markdown).toContain('**imperative in-transaction enqueueCommand** _(plan rev 0)_');
    expect(out.markdown).toContain('**token bucket over fixed window** _(cp 1)_');
    // The plan decision's rejected alternative renders as a sub-bullet.
    expect(out.markdown).toContain(
      '_considered_ **event-listener trigger** — rejected because async double-dispatch'
    );
    expect(out.markdown).toContain(
      `_evidence_ commit ${'a'.repeat(40)} — use an in-transaction enqueue command`
    );
    expect(out.data.decisions[0]?.evidence).toEqual({
      kind: 'git-commit',
      commit_sha: 'a'.repeat(40),
      quote: 'use an in-transaction enqueue command',
    });
    // out.data.decisions is plan-first, each tagged with its source.
    expect(out.data.decisions.map((d) => [d.source, d.revision_n ?? d.checkpoint])).toEqual([
      ['plan', 0],
      ['checkpoint', 1],
    ]);
    // Deferred decisions render in their OWN group adjacent to key decisions —
    // NOT folded into "open items".
    expect(out.markdown).toContain('## deferred decisions  _(unresolved)_');
    const deferredIdx = out.markdown.indexOf('## deferred decisions');
    const openItemsIdx = out.markdown.indexOf('## open items');
    expect(deferredIdx).toBeGreaterThan(-1);
    expect(deferredIdx).toBeLessThan(openItemsIdx);
    expect(out.markdown.slice(openItemsIdx)).not.toContain('429 response shape');
  });

  // ── Section structure (top-level happy path) ────────────────────────

  it('renders structured non_goals with rationale + excluded source refs', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'narrow slice',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'do step 1', label: 'step-1', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: startedAt,
      non_goals: [
        {
          text: 'no schema migration',
          rationale: 'the schema is frozen for this release',
          source_refs: ['section 2.3'],
        },
        { text: 'no auth changes', rationale: 'auth is a separate slice', source_refs: [] },
      ],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });

    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('## non-goals  _(captured)_');
    expect(out.markdown).toContain('- no schema migration');
    expect(out.markdown).toContain('  - rationale: the schema is frozen for this release');
    expect(out.markdown).toContain('  - excludes: section 2.3');
    // A non-goal that names no source item shows its rationale but no
    // "excludes" line.
    expect(out.markdown).toContain('  - rationale: auth is a separate slice');
  });

  it('renders the canonical sections from a complete thread', async () => {
    await seedFullThread();
    const out = await buildDigest({
      store,
      artifactId,
      evaluatorDescriptions: new Map([
        ['test-pack/plan-mentions-tests', 'flags plans that do not mention tests.'],
        ['test-pack/api-signature-drift', 'detects removed/changed public exports.'],
      ]),
    });

    expect(out.markdown).toContain(
      `# digest — \`feat/rate-limit\` / \`${artifactId}\` (2 checkpoints)`
    );
    expect(out.markdown).toContain('## outcome  _(captured)_');
    expect(out.markdown).toContain('## why  _(captured)_');
    expect(out.markdown).toContain('## what changed  _(inferred from checkpoints)_');
    expect(out.markdown).toContain('## key decisions  _(captured)_');
    expect(out.markdown).toContain('## release checks');
    expect(out.markdown).toContain('## process notes');
    expect(out.markdown).toContain('## open items  _(captured)_');
    expect(out.markdown).toContain('## tests  _(captured)_');

    // The summary outcome must reach the reviewer, including any dispositions
    // an amended summary added.
    expect(out.data.outcome).toBe('rate limiter shipped');
    expect(out.markdown).toContain('rate limiter shipped');
    // Outcome is the "what happened" counterpart to `## why`'s intent, so it
    // reads above the checkpoint walk.
    expect(out.markdown.indexOf('## outcome')).toBeLessThan(out.markdown.indexOf('## why'));

    expect(out.markdown).toContain('add rate limiting to /api/charge');
    expect(out.data.is_complete).toBe(true);
    expect(out.data.completed_at).toBe('2026-04-25T13:30:00.000Z');
    expect(out.data.checkpoint_count).toBe(2);
    expect(out.data.checkpoints[0].verification).toEqual([
      { command: 'fixture verification', exit_code: 0 },
    ]);
    expect(out.markdown).not.toContain('fixture verification');
  });

  // ── Predicate: which evaluators land in which section ────────────────

  it('routes pre-pr evaluator results to release_checks (any status)', async () => {
    await seedFullThread();
    // Add a pre-pr pass to confirm it lands in release_checks.
    await seedRun(artifactId, {
      evaluator_id: 'review-note',
      phase: 'pre-pr',
      severity: 'info',
      verdict: 'pass',
      body: 'PASS',
      ts: '2026-04-25T13:25:00.000Z',
    });
    const out = await buildDigest({ store, artifactId });
    const refs = out.data.release_checks.map((r) => r.evaluator_ref).sort();
    expect(refs).toContain('test-pack/review-note');
    expect(
      out.data.process_notes.find((r) => r.evaluator_ref === 'test-pack/review-note')
    ).toBeUndefined();
  });

  it('routes checkpoint-close block-severity results to release_checks (any status)', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    const apiRow = out.data.release_checks.find(
      (r) => r.evaluator_ref === 'test-pack/api-signature-drift'
    );
    expect(apiRow).toBeDefined();
    expect(apiRow?.severity).toBe('block');
    expect(apiRow?.phase).toBe('checkpoint-close');
    // Acknowledged (latest disposition wins over the underlying violation).
    expect(apiRow?.status).toBe('acknowledged');
    expect(apiRow?.ackReason).toBe('refund() was unused per grep');
  });

  it('routes post-plan evaluators to process_notes (regardless of severity/status)', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    const planRow = out.data.process_notes.find(
      (r) => r.evaluator_ref === 'test-pack/plan-mentions-tests'
    );
    expect(planRow).toBeDefined();
    expect(planRow?.phase).toBe('post-plan');
  });

  it('routes checkpoint-close warn/info results to process_notes (even on violation)', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-warn-cp',
      branch: 'feat/x',
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
      { artifact_id: 'a-warn-cp', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-3', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-warn-cp',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-3' }
    );
    // Warn-severity violation at post-cp — explicit severity choice means
    // it stays in process notes (not a merge-blocker by author intent).
    await seedRun('a-warn-cp', {
      evaluator_id: 'scope-creep-detect',
      phase: 'checkpoint-close',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION\n\nscope drifted',
      ts: '2026-04-25T12:30:01.000Z',
      checkpoint_n: 1,
    });
    const out = await buildDigest({ store, artifactId: 'a-warn-cp' });
    expect(out.data.release_checks).toEqual([]);
    expect(out.data.process_notes).toHaveLength(1);
    expect(out.data.process_notes[0].evaluator_ref).toBe('test-pack/scope-creep-detect');
    expect(out.data.process_notes[0].status).toBe('violation');
  });

  // ── Renderer: release checks ─────────────────────────────────────────

  it('release_checks empty state explains how to populate it', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
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
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('## release checks');
    expect(out.markdown).toContain('_No release-relevant checks ran.');
    expect(out.markdown).toMatch(/pre-pr.*evaluator.*block-severity checkpoint-close/);
  });

  it('release_checks table includes a phase column and inlines non-pass bodies', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('| evaluator | phase | severity | status |');
    expect(out.markdown).toContain(
      '| test-pack/api-signature-drift | checkpoint-close | block | acknowledged |'
    );
    // Inline expansion for the non-pass row.
    expect(out.markdown).toContain('### test-pack/api-signature-drift (acknowledged)');
    expect(out.markdown).toContain('**Acknowledged:** refund() was unused per grep');
    expect(out.markdown).toContain('removed: `function refund');
  });

  // ── Renderer: process notes ──────────────────────────────────────────

  it('process_notes collapses to a one-line tally when every check passed', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    // The fixture has only plan-mentions-tests in process_notes, all pass.
    expect(out.markdown).toContain('## process notes');
    expect(out.markdown).toContain('_All 1 process check passed._');
    // No expanded entry for the passing evaluator.
    expect(out.markdown).not.toContain('### test-pack/plan-mentions-tests');
  });

  it('process_notes shows tally + non-pass detail + passed list when mixed', async () => {
    // Same fixture, but with plan-mentions-tests as a VIOLATION instead of pass,
    // and a second passing post-plan evaluator to populate the tally line.
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-mix',
      branch: 'feat/x',
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
    await seedRun('a-mix', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION\n\nNone of plan_steps mentioned `test`.',
      ts: '2026-04-25T12:00:01.000Z',
    });
    await seedRun('a-mix', {
      evaluator_id: 'sensitive-scope-flag',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'pass',
      body: 'PASS',
      ts: '2026-04-25T12:00:02.000Z',
    });

    const out = await buildDigest({
      store,
      artifactId: 'a-mix',
      evaluatorDescriptions: new Map([
        ['test-pack/plan-mentions-tests', 'flags plans that do not mention tests.'],
      ]),
    });
    expect(out.markdown).toContain('⚠ 1 of 2 process checks flagged a concern.');
    // Non-pass row expanded with description + body and timing in the heading.
    expect(out.markdown).toContain('### test-pack/plan-mentions-tests (violation, post-plan)');
    expect(out.markdown).toContain('_flags plans that do not mention tests._');
    expect(out.markdown).toContain('None of plan_steps mentioned');
    // Passed tally for the other one.
    expect(out.markdown).toContain('_Passed: test-pack/sensitive-scope-flag (post-plan, warn)._');
  });

  it('process_notes empty state when no evaluators fired at all', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
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
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('## process notes');
    expect(out.markdown).toContain('_No process checks ran._');
  });

  // ── Renderer: per-cp blocks under "what changed" ─────────────────────

  it('renders each checkpoint as its own block with the agent narrative + Files list', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });

    expect(out.markdown).toContain('### checkpoint 1');
    expect(out.markdown).toContain('wired Redis middleware');
    expect(out.markdown).toContain('### checkpoint 2');
    expect(out.markdown).toContain('mounted on /api/charge');

    const cp1Idx = out.markdown.indexOf('### checkpoint 1');
    const cp2Idx = out.markdown.indexOf('### checkpoint 2');
    const cp1Block = out.markdown.slice(cp1Idx, cp2Idx);
    expect(cp1Block).toContain('- `src/middleware/rateLimiter.ts`');
    expect(cp1Block).not.toContain('- `src/app.ts`');

    expect(out.data.checkpoints).toHaveLength(2);
    expect(out.data.checkpoints[0].n).toBe(1);
    expect(out.data.checkpoints[0].summary).toContain('wired Redis middleware');
    expect(out.data.checkpoints[0].files_changed).toEqual(['src/middleware/rateLimiter.ts']);
    expect(out.data.checkpoints[1].files_changed).toEqual([
      'src/app.ts',
      'src/middleware/rateLimiter.ts',
    ]);
  });

  // ── Renderer: descriptions on non-pass process notes ─────────────────

  it('joins multi-line evaluator descriptions onto one line when rendered inline', async () => {
    // plan-mentions-tests as a VIOLATION so the description renders inline
    // (passes don't expand, so the description rendering is invisible there).
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-desc',
      branch: 'feat/desc',
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
    await seedRun('a-desc', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION',
      ts: '2026-04-25T12:00:01.000Z',
    });
    const out = await buildDigest({
      store,
      artifactId: 'a-desc',
      evaluatorDescriptions: new Map([
        // Hard-wrapped mid-sentence — a first-line-only truncation would
        // lose everything after "in the".
        [
          'test-pack/plan-mentions-tests',
          'Plans for new functionality must explicitly mention tests in the\nplan_steps array; deterministic check on token overlap.',
        ],
      ]),
    });
    expect(out.markdown).toContain(
      '_Plans for new functionality must explicitly mention tests in the plan_steps array; deterministic check on token overlap._'
    );
    expect(out.markdown).not.toContain('mention tests in the\n');
  });

  it('omits the description italic when no descriptions map is passed', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-nodesc',
      branch: 'feat/nd',
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
    await seedRun('a-nodesc', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION body here.',
      ts: '2026-04-25T12:00:01.000Z',
    });
    const out = await buildDigest({ store, artifactId: 'a-nodesc' });
    expect(out.markdown).toContain('### test-pack/plan-mentions-tests (violation, post-plan)');
    expect(out.markdown).toContain('VIOLATION body here.');
    // The description italic line never appears (no description provided).
    expect(out.markdown).not.toMatch(/^_.*plan-mentions-tests.*_$/m);
  });

  // ── Open-items dedupe ────────────────────────────────────────────────

  it('drops cp uncertainty that is substantially covered by a summary open_item (≥60% token overlap)', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-dup',
      branch: 'feat/dup',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
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
      { artifact_id: 'a-dup', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-4', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-dup',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: ['shadow mode rollout to production next'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-4' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: 'a-dup',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: ['plan shadow mode rollout for production rollout'],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-dup' });
    expect(out.markdown).toContain(
      '- plan shadow mode rollout for production rollout _(from summary)_'
    );
    expect(out.markdown).not.toContain('_(from cp 1)_');
    expect(out.data.open_uncertainty).toEqual([]);
  });

  it('drops a verbose cp uncertainty when a concise summary open_item describes the same thing (bidirectional dedup)', async () => {
    // The cp uncertainty
    // is 24 tokens with extra qualifying words; the summary open_item is
    // 17 tokens and concise. Single-direction "cp ⊆ summary" check
    // matched at only 58% (just below the 0.6 threshold) because the cp
    // had extra prose; the reverse "summary ⊆ cp" matches at 76% because
    // nearly every word in the concise summary appears in the longer cp
    // text. Bidirectional containment catches this — they're clearly the
    // same observation in different words.
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-bidir',
      branch: 'feat/bidir',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
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
      { artifact_id: 'a-bidir', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-5', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-bidir',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: [
          // 24-ish tokens, verbose phrasing.
          "Sub-second tier uses .toFixed(1), so 59999ms (still < 60000) renders as '60.0s'. Acceptable rounding artifact at the tier boundary, but worth flagging if any caller is sensitive to display-vs-tier consistency.",
        ],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-5' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: 'a-bidir',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [
        // 17-ish tokens, concise restatement of the same observation.
        "Sub-second tier renders 59999ms as '60.0s' due to .toFixed(1) at the tier boundary. Cosmetic; revisit if any caller is display-vs-tier sensitive.",
      ],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-bidir' });
    // The cp uncertainty MUST be dropped — the summary already says it.
    expect(out.data.open_uncertainty).toEqual([]);
    expect(out.markdown).not.toContain('_(from cp 1)_');
    // The summary version stays.
    expect(out.markdown).toContain('_(from summary)_');
  });

  it('keeps cp uncertainty that is NOT covered by any summary open_item', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-keep',
      branch: 'feat/keep',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
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
      { artifact_id: 'a-keep', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-6', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-keep',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: ['ttl strategy if multi-region redis is added later'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-6' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: 'a-keep',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: ['choose deployment strategy for staging'],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-keep' });
    expect(out.markdown).toContain(
      '- ttl strategy if multi-region redis is added later _(from cp 1)_'
    );
    expect(out.data.open_uncertainty).toHaveLength(1);
  });

  // ── Incomplete thread + error path ──────────────────────────────────

  it('marks an incomplete thread (no summary) and still renders cleanly', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
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

    const out = await buildDigest({ store, artifactId });
    expect(out.data.is_complete).toBe(false);
    expect(out.data.completed_at).toBeNull();
    expect(out.data.plan_coverage_complete).toBe(false);
    expect(out.data.uncompleted_steps).toEqual([{ step_id: 'step-1', label: 'step-1' }]);
    expect(out.markdown).toContain('_Thread is incomplete — no summary captured yet._');
    expect(out.markdown).toContain('## ⚠ incomplete plan steps');
    expect(out.markdown).toContain('- `step-1` — step-1');
    expect(out.markdown).toContain('_None recorded._'); // decisions section
    expect(out.markdown).toContain('_No release-relevant checks ran.');
    expect(out.markdown).toContain('_No process checks ran._');
    expect(out.markdown).toContain('_No tests recorded in summary._');
    // No summary → no outcome, and the section stays out entirely rather than
    // rendering an empty-state line the incomplete-thread blockquote already covers.
    expect(out.data.outcome).toBeNull();
    expect(out.markdown).not.toContain('## outcome');
  });

  // ── Open items vs checkpoint uncertainty ────────────────────────────

  it('renders undeduped cp uncertainty under its own heading, not as an open item', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-uncert',
      branch: 'feat/uncert',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T11:00:00.000Z',
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
      { artifact_id: 'a-uncert', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'cp-open-uncert', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-uncert',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        // Deliberately unrelated to the open_item below, so isCoveredBy does not
        // dedup it and the uncertainty section actually renders.
        uncertainty: ['whether the retry backoff jitter is fair under contention'],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-uncert' }
    );
    await store.writeSummary({
      schema_version: 1,
      artifact_id: 'a-uncert',
      outcome: 'shipped the limiter',
      tests_written: [],
      tests_run: [],
      open_items: ['document the operator runbook'],
      deferred_decisions: [],
      head_sha: 'cccc3333',
      ts: '2026-04-25T13:30:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-uncert' });

    // Checkpoint uncertainty carries no recorded resolution status, so filing it
    // under "open items" asserted something the schema cannot know. It gets its
    // own disclaiming heading; `## open items` is summary-declared work only.
    expect(out.markdown).toContain(
      '## checkpoint uncertainties  _(resolution status not encoded)_'
    );

    const openIdx = out.markdown.indexOf('## open items');
    const uncertaintyIdx = out.markdown.indexOf('## checkpoint uncertainties');
    expect(openIdx).toBeLessThan(uncertaintyIdx);

    // The open-items block holds the summary item and NOT the uncertainty.
    const openBlock = out.markdown.slice(openIdx, uncertaintyIdx);
    expect(openBlock).toContain('- document the operator runbook _(from summary)_');
    expect(openBlock).not.toContain('retry backoff jitter');

    // The uncertainty renders below, attributed to its checkpoint.
    expect(out.markdown.slice(uncertaintyIdx)).toContain(
      '- whether the retry backoff jitter is fair under contention _(from cp 1)_'
    );
  });

  it('throws when the artifact has no plan', async () => {
    await expect(buildDigest({ store, artifactId: 'missing00' })).rejects.toThrow(/no plan/);
  });

  // ── Body-heading demotion (so inlined evaluator content can't break section depth) ──

  it('demotes H1-H6 in inlined evaluator bodies so the digest section structure holds', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-demote',
      branch: 'feat/demote',
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
    // Evaluator body uses ## and ### headings — these would otherwise
    // collide with the digest's own H2/H3 sections.
    await seedRun('a-demote', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION\n\n## findings\n- one\n- two\n\n### details\nmore',
      ts: '2026-04-25T12:00:01.000Z',
    });
    const out = await buildDigest({ store, artifactId: 'a-demote' });
    // The body's `## findings` should be rendered as `#### findings` so
    // it nests under the digest's `### plan-mentions-tests (...)` heading.
    expect(out.markdown).toContain('#### findings');
    expect(out.markdown).toContain('##### details');
    // The original H2 must NOT survive in the rendered digest body.
    expect(out.markdown).not.toMatch(/^## findings$/m);
  });

  it('demoteBodyHeadings: only true heading lines are touched', () => {
    expect(demoteBodyHeadings('## hello\nbody\n### nested', 2)).toBe(
      '#### hello\nbody\n##### nested'
    );
  });

  it('demoteBodyHeadings: clamps at H6 (markdown max)', () => {
    expect(demoteBodyHeadings('##### deep', 5)).toBe('###### deep');
  });

  it('demoteBodyHeadings: leaves # inside fenced code blocks alone', () => {
    const body = '## real heading\n\n```bash\n#!/bin/sh\n# a comment\n```\n\n### after';
    const out = demoteBodyHeadings(body, 2);
    // Real headings demoted; in-fence # untouched.
    expect(out).toContain('#### real heading');
    expect(out).toContain('##### after');
    expect(out).toContain('#!/bin/sh');
    expect(out).toContain('# a comment');
  });

  it('demoteBodyHeadings: levels=0 is a no-op', () => {
    const body = '## a\nb\n### c';
    expect(demoteBodyHeadings(body, 0)).toBe(body);
  });

  // ── Policy exceptions surface in digest ────────────────────

  it('surfaces policy_exceptions[] from closed cps in digest data + markdown', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-pe',
      branch: 'feat/pe',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
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
    // cp 1 with a policy_exceptions[] applied at open — closes successfully.
    await store.writeCheckpointOpened(
      {
        artifact_id: 'a-pe',
        declared_step_ids: ['step-1', 'step-2', 'step-3', 'step-4'],
        policy_exceptions: [
          { evaluator: 'checkpoint-scope-density', reason: 'shipping atomically per design.md' },
        ],
      },
      { idempotencyKey: 'cp-open-pe', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-pe',
        n: 1,
        summary: 'all four steps in one cp by design',
        files_changed: ['file.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1', 'step-2', 'step-3', 'step-4'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'cp-close-pe' }
    );

    const out = await buildDigest({ store, artifactId: 'a-pe' });
    expect(out.data.policy_exceptions).toEqual([
      {
        cp_n: 1,
        evaluator_ref: 'checkpoint-scope-density',
        reason: 'shipping atomically per design.md',
      },
    ]);
    // Per-cp inline render under "what changed".
    expect(out.markdown).toContain('**Policy exceptions:**');
    expect(out.markdown).toContain(
      '- `checkpoint-scope-density` — shipping atomically per design.md'
    );
    // Top-level roll-up section.
    expect(out.markdown).toContain('## policy exceptions');
    expect(out.markdown).toContain(
      '- **cp 1** `checkpoint-scope-density` — shipping atomically per design.md'
    );
  });

  it('surfaces policy_exceptions[] from abandoned cps in digest data', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-pe-abn',
      branch: 'feat/pe-abn',
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
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
    await store.writeCheckpointOpened(
      {
        artifact_id: 'a-pe-abn',
        declared_step_ids: ['step-1', 'step-2', 'step-3'],
        policy_exceptions: [
          { evaluator: 'checkpoint-scope-density', reason: 'follow-on cp will split this' },
        ],
      },
      { idempotencyKey: 'cp-open-pe-abn', headSha: 'cafef00d' }
    );
    await store.writeCheckpointAbandoned(
      {
        artifact_id: 'a-pe-abn',
        n: 1,
        reason: 'subagent timed out',
      },
      { idempotencyKey: 'cp-abn-pe-abn' }
    );

    const out = await buildDigest({ store, artifactId: 'a-pe-abn' });
    // Even though abandoned cps don't appear in d.checkpoints (closed-only),
    // their policy_exceptions still flow through to the top-level section.
    expect(out.data.policy_exceptions).toEqual([
      {
        cp_n: 1,
        evaluator_ref: 'checkpoint-scope-density',
        reason: 'follow-on cp will split this',
      },
    ]);
    expect(out.markdown).toContain('## policy exceptions');
    expect(out.markdown).toContain(
      '- **cp 1** `checkpoint-scope-density` — follow-on cp will split this'
    );
  });

  it('omits ## policy exceptions when no cp recorded one', async () => {
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    expect(out.data.policy_exceptions).toEqual([]);
    expect(out.markdown).not.toContain('## policy exceptions');
  });

  it('writeDigest persists to <artifact>/digest.md', async () => {
    await seedFullThread();
    const out = await writeDigest({ store, artifactId });
    expect(out.path).toMatch(/digest\.md$/);
    const onDisk = await readFile(out.path, 'utf8');
    expect(onDisk).toBe(out.markdown);
  });

  it('writeDigest writes a digest.meta.json sidecar pinned to the artifact source_event_id', async () => {
    await seedFullThread();
    await writeDigest({ store, artifactId });
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const meta = JSON.parse(await readFile(paths.digestMeta, 'utf8'));
    const artifact = await store.readArtifact(artifactId);
    // Built-from id matches the live source_event_id → digest is "current"
    // right after writeDigest. The snapshot reader (Step B) compares them.
    expect(typeof meta.source_event_id).toBe('string');
    expect(meta.source_event_id).toBe(artifact!.source_event_id);
  });

  // ── multi-run-per-ref + multi-revision scenarios ─────

  /**
   * Scenario (a) gates the prior_resolved digest footnote. Seed three
   * consecutive runs against the same evaluator_ref:
   *   1. violation at t0 → dismissed at t0+1m (reason: false-positive)
   *   2. violation at t1 → acknowledged at t1+1m (reason: intentional)
   *   3. violation at t2 (latest, unresolved)
   *
   * The latest run's row should carry `prior_resolved` indicating two
   * prior resolutions, the most recent being `acknowledged`.
   */
  it('multi-run-per-ref with prior resolution: latest row carries prior_resolved metadata', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-prior',
      branch: 'feat/prior',
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
      { artifact_id: 'a-prior', declared_step_ids: ['step-1'] },
      { idempotencyKey: 'pr-cp1-open', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: 'a-prior',
        n: 1,
        summary: 'cp1',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'pr-cp1-close' }
    );

    const ref = 'test-pack/security-check';

    const run1 = await seedRun('a-prior', {
      evaluator_id: 'security-check',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\nfirst hit',
      ts: '2026-04-25T12:00:00.000Z',
      checkpoint_n: 1,
    });
    await seedDisposition('a-prior', {
      run_id: run1,
      evaluator_ref: ref,
      disposition: 'dismissed',
      reason: 'false positive',
      ts: '2026-04-25T12:01:00.000Z',
    });
    const run2 = await seedRun('a-prior', {
      evaluator_id: 'security-check',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\nsecond hit',
      ts: '2026-04-25T12:10:00.000Z',
      checkpoint_n: 1,
    });
    await seedDisposition('a-prior', {
      run_id: run2,
      evaluator_ref: ref,
      disposition: 'acknowledged',
      reason: 'intentional',
      ts: '2026-04-25T12:11:00.000Z',
    });
    await seedRun('a-prior', {
      evaluator_id: 'security-check',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\nthird hit',
      ts: '2026-04-25T12:20:00.000Z',
      checkpoint_n: 1,
    });

    const out = await buildDigest({ store, artifactId: 'a-prior' });
    const row = out.data.release_checks.find((r) => r.evaluator_ref === ref);
    expect(row).toBeDefined();
    expect(row?.status).toBe('violation');
    expect(row?.prior_resolved).toEqual({
      count: 2,
      last_disposition: 'acknowledged',
      last_reason: 'intentional',
    });
    // Markdown footnote rendered under the row body.
    expect(out.markdown).toContain('previously resolved 2 time(s)');
    expect(out.markdown).toContain('last resolution: acknowledged');
    expect(out.markdown).toContain('intentional');
  });

  it('multi-run-per-ref with NO prior resolution: row omits prior_resolved', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-noprior',
      branch: 'feat/noprior',
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
    await seedRun('a-noprior', {
      evaluator_id: 'fresh-violation',
      phase: 'pre-pr',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION first time',
      ts: '2026-04-25T12:00:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-noprior' });
    const row = out.data.release_checks.find(
      (r) => r.evaluator_ref === 'test-pack/fresh-violation'
    );
    expect(row).toBeDefined();
    expect(row?.prior_resolved).toBeUndefined();
    expect(out.markdown).not.toContain('previously resolved');
  });

  /**
   * Scenario (b) gates the multi-revision digest path: a plan revised
   * twice with evaluator runs at each revision level should render with
   * `plan_revision_count: 2` and latest-wins per evaluator_ref.
   */
  it('multi-revision artifact: plan_revision_count reflects revisions; latest-wins per ref', async () => {
    await store.writePlan({
      schema_version: 4,
      artifact_id: 'a-rev',
      branch: 'feat/rev',
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
    // Initial fire at rev 0.
    await seedRun('a-rev', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION rev0',
      ts: '2026-04-25T12:00:00.000Z',
    });
    // Revise to rev 1 (add step-2).
    await store.revisePlan(
      {
        idempotency_key: 'rev-1-key',
        artifact_id: 'a-rev',
        label: 'lbl rev1',
        plan_steps: [
          { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
          { text: 's2', label: 'step-2', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        rationale: 'add s2',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        decisions: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'rev-1-key' }
    );
    // Re-fire on the revision (post-plan-revision phase).
    await seedRun('a-rev', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan-revision',
      severity: 'warn',
      verdict: 'pass',
      body: 'PASS rev1',
      ts: '2026-04-25T12:06:00.000Z',
    });
    // Revise to rev 2 (add step-3).
    await store.revisePlan(
      {
        idempotency_key: 'rev-2-key',
        artifact_id: 'a-rev',
        label: 'lbl rev2',
        plan_steps: [
          { step_id: 'step-1', text: 's1', label: 'step-1', acceptance_criteria: [] },
          { text: 's2', label: 'step-2', acceptance_criteria: [] },
          { text: 's3', label: 'step-3', acceptance_criteria: [] },
        ],
        touched_scope: [],
        non_goals: [],
        rationale: 'add s3',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        decisions: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'rev-2-key' }
    );
    await seedRun('a-rev', {
      evaluator_id: 'plan-mentions-tests',
      phase: 'post-plan-revision',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION rev2',
      ts: '2026-04-25T12:11:00.000Z',
    });

    const out = await buildDigest({ store, artifactId: 'a-rev' });
    expect(out.data.plan_revision_count).toBe(2);
    // Latest-wins: the rev2 violation should appear, not rev0/rev1.
    const row = out.data.process_notes.find(
      (r) => r.evaluator_ref === 'test-pack/plan-mentions-tests'
    );
    expect(row).toBeDefined();
    expect(row?.body).toContain('VIOLATION rev2');
    expect(row?.status).toBe('violation');
  });

  // ── acknowledged blocks + decision alternatives ──────────────

  async function seedBareThread(
    artId: string,
    decisions: Array<{
      decision: string;
      reason: string;
      alternatives_considered?: Array<{ option: string; rejected_because: string }>;
    }> = []
  ): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artId,
      branch,
      base_sha: 'cafef00d',
      agent: 'claude-code',
      agent_session_id: null,
      task: 'task',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'do a thing', label: 'step-1', acceptance_criteria: [] },
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
      { artifact_id: artId, declared_step_ids: ['step-1'] },
      { idempotencyKey: `${artId}-o1`, headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artId,
        n: 1,
        summary: 'did the thing',
        files_changed: [],
        decisions,
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-1'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: `${artId}-c1` }
    );
  }

  it('renders decision alternatives_considered as sub-bullets under key decisions', async () => {
    await seedBareThread('a-alt', [
      {
        decision: 'token bucket',
        reason: 'smoother bursts',
        alternatives_considered: [
          { option: 'fixed window', rejected_because: 'burst-at-boundary' },
        ],
      },
    ]);
    const out = await buildDigest({ store, artifactId: 'a-alt' });
    expect(out.data.decisions[0].alternatives_considered).toEqual([
      { option: 'fixed window', rejected_because: 'burst-at-boundary' },
    ]);
    expect(out.markdown).toContain(
      '_considered_ **fixed window** — rejected because burst-at-boundary'
    );
  });

  it('omits the alternatives sub-bullet when a decision records none', async () => {
    await seedBareThread('a-noalt', [{ decision: 'just do it', reason: 'obvious' }]);
    const out = await buildDigest({ store, artifactId: 'a-noalt' });
    expect(out.data.decisions[0].alternatives_considered).toBeUndefined();
    expect(out.markdown).not.toContain('_considered_');
  });

  it('renders accepted pre-PR warnings with their exact review identity and reason', async () => {
    const artId = 'a-accepted-warning';
    await seedBareThread(artId);
    const runId = await seedRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      severity: 'warn',
      verdict: 'violation',
      body: 'VIOLATION\n\nThe fallback differs from the source plan.',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const review = await store.writePrePrChecked(artId, {
      head_sha: 'aaaa1111',
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: [runId],
    });
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artId,
        outcome: 'shipped the agreed fallback',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        accepted_warnings: [
          {
            review_id: review.event_id,
            run_id: runId,
            evaluator_ref: 'test-pack/plan-conformance-pre-pr',
            reason: 'The fallback was approved during implementation.',
          },
        ],
        head_sha: 'aaaa1111',
        ts: '2026-04-25T13:00:00.000Z',
      },
      { idempotencyKey: 'summary-accepted-warning' }
    );
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.accepted_warnings).toEqual([
      expect.objectContaining({ review_id: review.event_id, run_id: runId }),
    ]);
    expect(out.markdown).toContain('pre-PR warnings accepted for finalization');
    expect(out.markdown).toContain('The fallback was approved during implementation.');
    expect(out.markdown).toContain(review.event_id);
    expect(out.markdown).toContain(runId);
  });

  it('surfaces an acknowledged block near the top, before the why section', async () => {
    await seedBareThread('a-ackblk');
    const runId = await seedRun('a-ackblk', {
      evaluator_id: 'api-signature-drift',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\n## findings\n- removed: `function refund(...)`',
      ts: '2026-04-25T12:30:00.000Z',
      checkpoint_n: 1,
    });
    await seedDisposition('a-ackblk', {
      run_id: runId,
      evaluator_ref: 'test-pack/api-signature-drift',
      disposition: 'acknowledged',
      reason: 'refund() was unused per grep',
      ts: '2026-04-25T12:31:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: 'a-ackblk' });
    expect(out.data.acknowledged_blocks).toHaveLength(1);
    expect(out.data.acknowledged_blocks[0]).toMatchObject({
      evaluator_ref: 'test-pack/api-signature-drift',
      phase: 'checkpoint-close',
      reason: 'refund() was unused per grep',
    });
    const md = out.markdown;
    expect(md).toContain('block resolved by acknowledgement');
    expect(md).toContain('refund() was unused per grep');
    // Placement: the acknowledged-blocks section precedes "## why".
    expect(md.indexOf('resolved by acknowledgement')).toBeLessThan(md.indexOf('## why'));
  });

  it('omits a dismissed block from the acknowledged-blocks section', async () => {
    await seedBareThread('a-disblk');
    const runId = await seedRun('a-disblk', {
      evaluator_id: 'api-signature-drift',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\nremoved an export',
      ts: '2026-04-25T12:30:00.000Z',
      checkpoint_n: 1,
    });
    await seedDisposition('a-disblk', {
      run_id: runId,
      evaluator_ref: 'test-pack/api-signature-drift',
      disposition: 'dismissed',
      reason: 'false positive',
      ts: '2026-04-25T12:31:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: 'a-disblk' });
    expect(out.data.acknowledged_blocks).toHaveLength(0);
    expect(out.markdown).not.toContain('resolved by acknowledgement');
  });

  it('keeps an acknowledged block even after a later run of the same evaluator passes (regression)', async () => {
    await seedBareThread('a-ackthenpass');
    const violationRunId = await seedRun('a-ackthenpass', {
      evaluator_id: 'api-signature-drift',
      phase: 'checkpoint-close',
      severity: 'block',
      verdict: 'violation',
      body: 'VIOLATION\n\nremoved an export',
      ts: '2026-04-25T12:30:00.000Z',
      checkpoint_n: 1,
    });
    await seedDisposition('a-ackthenpass', {
      run_id: violationRunId,
      evaluator_ref: 'test-pack/api-signature-drift',
      disposition: 'acknowledged',
      reason: 'intentional removal',
      ts: '2026-04-25T12:31:00.000Z',
    });
    // A later run of the SAME evaluator passes — collapseEvaluatorRuns'
    // latest-row would now be 'pass', but the historical acknowledgement
    // must still surface.
    await seedRun('a-ackthenpass', {
      evaluator_id: 'api-signature-drift',
      phase: 'pre-pr',
      severity: 'block',
      verdict: 'pass',
      body: 'PASS\n\nno drift now',
      ts: '2026-04-25T12:40:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: 'a-ackthenpass' });
    expect(out.data.acknowledged_blocks).toHaveLength(1);
    expect(out.data.acknowledged_blocks[0].reason).toBe('intentional removal');
    expect(out.markdown).toContain('resolved by acknowledgement');
  });

  // Delivery-coverage visibility (all-missing case).
  it('renders "delivery coverage UNVERIFIED" when step-coverage ran but no step has criteria', async () => {
    // seedFullThread plan has 3 steps, none with acceptance_criteria (all-missing);
    // a step-coverage run flips step_coverage_active true.
    await seedFullThread();
    await seedRun(artifactId, {
      evaluator_id: 'step-coverage',
      phase: 'pre-pr',
      severity: 'warn',
      verdict: 'pass',
      body: 'PASS step-coverage ran',
      ts: '2026-04-25T13:00:00.000Z',
      package_id: 'core',
    });
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('delivery coverage UNVERIFIED');
  });

  it('stays silent on the all-missing case when no step-coverage run exists', async () => {
    // seedFullThread records non step-coverage runs only, so step_coverage_active is false.
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).not.toContain('delivery coverage UNVERIFIED');
  });

  // ── resolved-overlap legend on a first-closer's snapshot ─────────
  async function seedConcurrentPair(artId: string): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artId,
        branch,
        base_sha: 'cafef00d',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'concurrent notifications',
        label: `overlap-${artId.slice(-4)}`,
        plan_steps: [
          { step_id: 'step-a', text: 'A', label: 'a', acceptance_criteria: [] },
          { step_id: 'step-b', text: 'B', label: 'b', acceptance_criteria: [] },
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
      },
      { idempotencyKey: `plan-${artId}` }
    );
    // Both open before any close → a concurrent window.
    await store.writeCheckpointOpened(
      { artifact_id: artId, declared_step_ids: ['step-a'] },
      { idempotencyKey: `${artId}-open-1`, headSha: 'cafef00d' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artId, declared_step_ids: ['step-b'] },
      { idempotencyKey: `${artId}-open-2`, headSha: 'cafef00d' }
    );
  }

  it('renders a "group resolved" legend on a first-closer whose group later fully closed', async () => {
    const artId = 'a-overlap-resolved';
    await seedConcurrentPair(artId);
    // cp2 (higher n) closes FIRST while cp1 is still open → provisional snapshot.
    await store.writeCheckpointClosed(
      {
        artifact_id: artId,
        n: 2,
        summary: 'cpB',
        files_changed: ['notify-shared.js'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-b'],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'a-overlap-resolved-close-2' }
    );
    // cp1 closes LAST → the group is fully closed (finalized).
    await store.writeCheckpointClosed(
      {
        artifact_id: artId,
        n: 1,
        summary: 'cpA',
        files_changed: ['notify-shared.js'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-a'],
        head_sha: 'aaaa1111',
      },
      { idempotencyKey: 'a-overlap-resolved-close-1' }
    );
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.markdown).toContain('group resolved');
    expect(out.markdown).toContain('finalized once every member closed');
  });

  it('no "group resolved" legend while the overlap group is still open', async () => {
    const artId = 'a-overlap-open';
    await seedConcurrentPair(artId);
    // Only cp2 closes; cp1 stays open → group NOT finalized.
    await store.writeCheckpointClosed(
      {
        artifact_id: artId,
        n: 2,
        summary: 'cpB',
        files_changed: ['notify-shared.js'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: ['step-b'],
        head_sha: 'bbbb2222',
      },
      { idempotencyKey: 'a-overlap-open-close-2' }
    );
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.markdown).not.toContain('group resolved');
  });

  // ── cross-revision criterion lineage in the digest ─────
  it('renders criteria removed/rewritten in an EARLIER revision even when a LATER revision is clean', async () => {
    // rev0: STEP_X carries two criteria. rev1 removes CRIT_1 and rewrites CRIT_2
    // weaker. rev2 makes an unrelated text edit (clean criteria). The digest
    // reads the LATEST plan, whose criterion_lineage is empty at rev2 — so a
    // latest-only reader would render nothing. The cross-revision walk must
    // still surface the rev1 narrowing with its text.
    const STEP_X = '01HX0K8N6ZQF8M5R2V8DZ7T3X1';
    const CRIT_1 = '01HX0K8N6ZQF8M5R2V8DZ7TC01';
    const CRIT_2 = '01HX0K8N6ZQF8M5R2V8DZ7TC02';
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'base000',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'deliver with criteria',
        label: 'lbl',
        plan_steps: [
          {
            step_id: STEP_X,
            text: 'build the suite',
            label: 'build-suite',
            acceptance_criteria: [
              { criterion_id: CRIT_1, text: 'suite has >= 42 tests' },
              { criterion_id: CRIT_2, text: 'coverage >= 90 percent' },
            ],
          },
        ],
        touched_scope: [],
        non_goals: [],
        started_at: startedAt,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
        decisions: [],
      },
      { idempotencyKey: 'lineage-init' }
    );
    // rev1: drop CRIT_1, rewrite CRIT_2 weaker. No open cp → no ack needed.
    const rev1 = await store.revisePlan(
      {
        idempotency_key: 'lineage-rev1',
        artifact_id: artifactId,
        label: 'lbl r1',
        plan_steps: [
          {
            step_id: STEP_X,
            text: 'build the suite',
            label: 'build-suite',
            acceptance_criteria: [{ criterion_id: CRIT_2, text: 'coverage >= 50 percent' }],
          },
        ],
        touched_scope: [],
        non_goals: [],
        rationale: 'trim scope',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
        decisions: [],
      },
      { idempotencyKey: 'lineage-rev1' }
    );
    expect(rev1.outcome).not.toBe('conflict');
    // rev2: unrelated text edit; criteria untouched → rev2 lineage is clean.
    const rev2 = await store.revisePlan(
      {
        idempotency_key: 'lineage-rev2',
        artifact_id: artifactId,
        label: 'lbl r2',
        plan_steps: [
          {
            step_id: STEP_X,
            text: 'build the suite (refined)',
            label: 'build-suite',
            acceptance_criteria: [{ criterion_id: CRIT_2, text: 'coverage >= 50 percent' }],
          },
        ],
        touched_scope: [],
        non_goals: [],
        rationale: 'reword step',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
        decisions: [],
      },
      { idempotencyKey: 'lineage-rev2' }
    );
    expect(rev2.outcome).not.toBe('conflict');

    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).toContain('acceptance criteria changed mid-flight');
    // The removed criterion's text survives even though it's gone from the latest plan.
    expect(out.markdown).toContain('suite has >= 42 tests');
    // The rewrite renders as prior → new.
    expect(out.markdown).toContain('coverage >= 90 percent → coverage >= 50 percent');
    // Tagged with the revision that made the change (rev1, not rev2).
    expect(out.markdown).toContain('rev 1');
    // Structured data carries both, aggregated across revisions.
    expect(out.data.criterion_changes.removed).toHaveLength(1);
    expect(out.data.criterion_changes.removed[0].text).toBe('suite has >= 42 tests');
    expect(out.data.criterion_changes.rewritten).toHaveLength(1);
  });

  it('stays silent on criterion changes for an unrevised plan', async () => {
    // seedFullThread is a single-revision plan with no criteria changes.
    await seedFullThread();
    const out = await buildDigest({ store, artifactId });
    expect(out.markdown).not.toContain('acceptance criteria changed mid-flight');
    expect(out.data.criterion_changes.removed).toHaveLength(0);
    expect(out.data.criterion_changes.rewritten).toHaveLength(0);
  });
});

describe('buildDigest — plan conformance section', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/conformance';
  const startedAt = '2026-04-25T12:00:00.000Z';

  // Content-free DigestData must never carry this — guards the digest --json leak.
  const PIN_CONTENT = 'Phase 1: anchor plumbing\nPhase 2: evaluator\n';
  const SOURCE_PIN = {
    source_ref: { kind: 'local' as const, locator: 'docs/plan.md' },
    content: PIN_CONTENT,
    hash: 'a'.repeat(64),
    baseline: null,
  };

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writePlanFor(artId: string, pin: typeof SOURCE_PIN | null): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artId,
        branch,
        base_sha: 'cafef00d',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'implement the slice',
        label: 'the slice',
        plan_steps: [{ step_id: 'step-1', text: 'do it', label: 'do it', acceptance_criteria: [] }],
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
      },
      pin
        ? { idempotencyKey: `plan-${artId}`, sourcePlan: pin }
        : { idempotencyKey: `plan-${artId}` }
    );
  }

  async function seedConformanceRun(
    artId: string,
    opts: {
      evaluator_id: string;
      phase: 'post-plan' | 'post-plan-revision' | 'pre-pr';
      verdict: 'pass' | 'info' | 'violation';
      body: string;
      ts: string;
    }
  ): Promise<void> {
    const runId = uuidv7();
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artId,
      evaluator_ref: `core/${opts.evaluator_id}`,
      package_id: 'core',
      evaluator_id: opts.evaluator_id,
      phase: opts.phase,
      severity: 'warn',
      run_status: 'completed',
      verdict: opts.verdict,
      body: opts.body,
      ts: opts.ts,
    };
    await store.writeEvaluatorRunPayload(artId, payload, { idempotencyKey: `run-${runId}` });
  }

  // seedRun hardcodes run_status:'completed' + a non-null verdict, so a
  // skipped run is written directly (the when_llm=required no-LLM path).
  async function seedSkippedConformanceRun(
    artId: string,
    opts: { evaluator_id: string; phase: 'pre-pr'; ts: string; reason?: string }
  ): Promise<void> {
    const runId = uuidv7();
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artId,
      evaluator_ref: `core/${opts.evaluator_id}`,
      package_id: 'core',
      evaluator_id: opts.evaluator_id,
      phase: opts.phase,
      severity: 'warn',
      run_status: 'skipped',
      verdict: null,
      body:
        'SKIPPED\n\n' +
        (opts.reason ?? 'filters.when_llm=required but no LLM provider is configured'),
      ts: opts.ts,
    };
    await store.writeEvaluatorRunPayload(artId, payload, { idempotencyKey: `run-${runId}` });
  }

  // run_status:'error' requires a structured `error` and verdict:null (the
  // payload superRefine enforces both). Shape mirrors the runner's markdown
  // timeout path (engines/llm.ts packErrorRun): code 'LLM_ERROR', message
  // 'TIMEOUT: …', body 'ERROR (LLM_ERROR)\n\n…' — a faithful stand-in for the
  // runner's timeout path.
  async function seedErroredConformanceRun(
    artId: string,
    opts: { evaluator_id: string; phase: 'pre-pr'; ts: string }
  ): Promise<void> {
    const runId = uuidv7();
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artId,
      evaluator_ref: `core/${opts.evaluator_id}`,
      package_id: 'core',
      evaluator_id: opts.evaluator_id,
      phase: opts.phase,
      severity: 'warn',
      run_status: 'error',
      verdict: null,
      error: { code: 'LLM_ERROR', message: 'TIMEOUT: Claude timed out after 30000ms' },
      body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: Claude timed out after 30000ms',
      ts: opts.ts,
    };
    await store.writeEvaluatorRunPayload(artId, payload, { idempotencyKey: `run-${runId}` });
  }

  it('(a) pinned + pre-pr run → hoists the conformance body, content-free summary', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a1';
    await writePlanFor(artId, SOURCE_PIN);
    await seedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      verdict: 'violation',
      body: 'VIOLATION\n\n## plan conformance\n\nSilent gaps: 1.',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.source_plan).toEqual({
      pinned: true,
      locator: 'docs/plan.md',
      hash: 'a'.repeat(64),
    });
    // The full pinned plan must NOT reach DigestData (digest --json leak guard).
    expect(JSON.stringify(out.data)).not.toContain('Phase 1: anchor plumbing');
    expect(out.data.plan_conformance?.evaluator_ref).toBe('core/plan-conformance-pre-pr');
    expect(out.markdown).toContain('## plan conformance');
    expect(out.markdown).toContain('Source plan: `docs/plan.md`');
    expect(out.markdown).toContain('Silent gaps: 1.');
  });

  it('(b) pinned + post-plan AND pre-pr runs → pre-pr wins and refs are de-duped', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a2';
    await writePlanFor(artId, SOURCE_PIN);
    await seedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-post-plan',
      phase: 'post-plan',
      verdict: 'pass',
      body: 'PASS\n\nearly look ok',
      ts: '2026-04-25T12:10:00.000Z',
    });
    await seedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      verdict: 'violation',
      body: 'VIOLATION\n\nfinal drift detected',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.plan_conformance?.evaluator_ref).toBe('core/plan-conformance-pre-pr');
    // De-dup: conformance refs never also appear in release_checks / process_notes.
    const allRows = [...out.data.release_checks, ...out.data.process_notes];
    expect(allRows.some((r) => r.evaluator_ref.startsWith('core/plan-conformance-'))).toBe(false);
    expect(out.markdown).toContain('final drift detected');
  });

  it('(c) pinned + skipped run → "no LLM" label, not the raw SKIPPED body', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a3';
    await writePlanFor(artId, SOURCE_PIN);
    await seedSkippedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.plan_conformance?.status).toBe('skipped');
    expect(out.markdown).toContain('no LLM was configured');
    expect(out.markdown).toContain('UNVERIFIED');
    expect(out.markdown).not.toContain('filters.when_llm=required but no LLM');
  });

  it('names an unavailable provider and its override origin for a skipped conformance run', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a8';
    await writePlanFor(artId, SOURCE_PIN);
    await seedSkippedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      ts: '2026-04-25T12:30:00.000Z',
      reason:
        'resolved provider codex is not installed ' +
        '(selected by your .orcaops/evaluators.yaml override)',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.markdown).toContain('resolved provider codex is not installed');
    expect(out.markdown).toContain('selected by your .orcaops/evaluators.yaml override');
    expect(out.markdown).toContain('UNVERIFIED');
  });

  it('(d) pinned + no conformance run → "did not run" note', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a4';
    await writePlanFor(artId, SOURCE_PIN);
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.source_plan?.pinned).toBe(true);
    expect(out.data.plan_conformance).toBeNull();
    expect(out.markdown).toContain('plan-conformance` did not run');
    // A warning with no remedy is a warning nobody acts on. The evaluator
    // ships disabled, so naming the config key is the whole action.
    expect(out.markdown).toContain('.orcaops/evaluators.yaml');
  });

  it('(e) no pin, no conformance row → absence note', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a5';
    await writePlanFor(artId, null);
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.source_plan).toBeNull();
    expect(out.data.plan_conformance).toBeNull();
    expect(out.markdown).toContain('no source plan pinned');
  });

  it('(f) no pin BUT a conformance row exists → plan_conformance forced null', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a6';
    await writePlanFor(artId, null);
    await seedConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      verdict: 'info',
      body: 'INFO\n\nNo source plan was pinned for this artifact.',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.source_plan).toBeNull();
    // Forced null even though a row exists — digest --json matches the markdown.
    expect(out.data.plan_conformance).toBeNull();
    expect(out.markdown).toContain('no source plan pinned');
    // De-dup still applies regardless of pin.
    const allRows = [...out.data.release_checks, ...out.data.process_notes];
    expect(allRows.some((r) => r.evaluator_ref.startsWith('core/plan-conformance-'))).toBe(false);
  });

  it('(g) pinned + errored run → UNVERIFIED label, not the raw error body', async () => {
    const artId = '01999999-9999-7000-8000-0000000000a7';
    await writePlanFor(artId, SOURCE_PIN);
    await seedErroredConformanceRun(artId, {
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      ts: '2026-04-25T12:30:00.000Z',
    });
    const out = await buildDigest({ store, artifactId: artId });
    expect(out.data.plan_conformance?.status).toBe('error');
    // The error reads as UNVERIFIED, never as a verdict — the raw ERROR body
    // must not leak through (else a timeout reads as "ran clean").
    expect(out.markdown).toContain('UNVERIFIED');
    expect(out.markdown).not.toContain('timed out after 30000ms');
    // "Hoisted section only": the conformance ref stays out of release_checks /
    // process_notes for the error state too (cases (b)/(f) cover completed runs).
    const allRows = [...out.data.release_checks, ...out.data.process_notes];
    expect(allRows.some((r) => r.evaluator_ref.startsWith('core/plan-conformance-'))).toBe(false);
  });

  it('DigestSourcePlan.content?:never makes a spread that re-leaks content a compile error', () => {
    // The real assertion is the `@ts-expect-error` below: supplying pinned +
    // locator (and hash via the spread) leaves the leaked `content: string`
    // as the ONLY type error (the spread's extra source_ref is bypassed). If
    // `content?: never` is ever dropped, the expected error disappears and
    // this @ts-expect-error fails typecheck — a permanent leak guard.
    // @ts-expect-error - the spread re-introduces `content`, rejected by `content?: never`
    const _noLeak: DigestSourcePlan = { ...SOURCE_PIN, pinned: true, locator: 'x' };
    void _noLeak;
    expect(true).toBe(true);
  });
});
