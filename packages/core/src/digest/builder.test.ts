import { describe, expect, it } from 'vitest';

import {
  type ArtifactDraftSemantics,
  type ArtifactThread,
  type EvaluatorDispositionPayload,
  type EvaluatorRunPayload,
  prepareArtifactDraft,
  reconstructArtifactThread,
  uuidv7,
} from '@orcaops/storage';

import {
  buildThreadDigest,
  demoteBodyHeadings,
  type DigestSourcePlan,
  type DigestUsage,
  usageFingerprint,
} from './builder.js';

const startedAt = '2026-04-25T12:00:00.000Z';
const sourcePin = {
  source_ref: { kind: 'local' as const, locator: 'docs/plan.md' },
  content: 'Phase 1: retain exact input\nPRIVATE PLAN BODY\n',
  hash: 'a'.repeat(64),
  baseline: null,
};

type SeedContext = {
  artifactId: string;
  stepIds: string[];
  planSteps: Array<{
    step_id: string;
    label: string;
    text: string;
    acceptance_criteria: Array<{ criterion_id: string; text: string }>;
  }>;
  semantics: ArtifactDraftSemantics;
};

async function prepareThread(
  seed?: (context: SeedContext) => Promise<void>,
  options: {
    artifactId?: string;
    sourcePlan?: typeof sourcePin | null;
    task?: string;
    planSteps?: Array<{
      step_id: string;
      label: string;
      text: string;
      acceptance_criteria: Array<{ criterion_id: string; text: string }>;
    }>;
    decisions?: Array<{
      decision: string;
      reason: string;
      revision_n: number;
      alternatives_considered?: Array<{ option: string; rejected_because: string }>;
      evidence?: { kind: 'git-commit'; commit_sha: string; quote: string };
    }>;
    nonGoals?: Array<{ text: string; rationale: string; source_refs: string[] }>;
    secretAllow?: string[];
  } = {}
): Promise<ArtifactThread> {
  const artifactId = options.artifactId ?? uuidv7();
  const stepIds = options.planSteps?.map((step) => step.step_id) ?? [uuidv7(), uuidv7()];
  const planSteps =
    options.planSteps ??
    stepIds.map((stepId, index) => ({
      step_id: stepId,
      label: `Step ${index + 1}`,
      text: `Complete retained step ${index + 1}`,
      acceptance_criteria: [{ criterion_id: uuidv7(), text: `Criterion ${index + 1}` }],
    }));
  const prepared = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: [],
      authoredPayload: {},
      secretAllow: options.secretAllow ?? [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      await semantics.writePlan(
        {
          schema_version: 4,
          artifact_id: artifactId,
          branch: 'feat/rate-limit',
          base_sha: 'a'.repeat(40),
          agent: 'codex',
          agent_session_id: null,
          task: options.task ?? 'Add rate limiting',
          label: 'Rate limiting',
          plan_steps: planSteps,
          touched_scope: ['payments'],
          non_goals: options.nonGoals ?? [],
          decisions: options.decisions ?? [],
          started_at: startedAt,
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
          prior_plan_event_id: null,
        },
        {
          idempotencyKey: `plan-${artifactId}`,
          ...(options.sourcePlan ? { sourcePlan: options.sourcePlan } : {}),
        }
      );
      await seed?.({ artifactId, stepIds, planSteps, semantics });
    }
  );
  if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
  const events = prepared.events.map((event) => ({
    record: event.record,
    payload: JSON.parse(event.payloadBytes.toString('utf8')),
  }));
  return reconstructArtifactThread(artifactId, events);
}

async function closeCheckpoint(
  { artifactId, stepIds, planSteps, semantics }: SeedContext,
  options: {
    n?: number;
    completed?: string[];
    files?: string[];
    uncertainty?: string[];
    decisions?: Array<{ decision: string; reason: string }>;
    policyExceptions?: Array<{ evaluator: string; reason: string }>;
  } = {}
) {
  const n = options.n ?? 1;
  await semantics.writeCheckpointOpened(
    {
      artifact_id: artifactId,
      declared_step_ids: [stepIds[n - 1] ?? stepIds[0]!],
      ...(options.policyExceptions ? { policy_exceptions: options.policyExceptions } : {}),
    },
    { idempotencyKey: `open-${n}`, headSha: String(n).repeat(40) }
  );
  const completed = options.completed ?? [stepIds[n - 1] ?? stepIds[0]!];
  const doneCriteria = planSteps
    .filter((step) => completed.includes(step.step_id))
    .flatMap((step) =>
      step.acceptance_criteria.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        evidence: `Verified ${criterion.text}`,
      }))
    );
  await semantics.writeCheckpointClosed(
    {
      artifact_id: artifactId,
      n,
      summary: `Completed checkpoint ${n}`,
      files_changed: options.files ?? [`src/file-${n}.ts`],
      decisions: options.decisions ?? [],
      uncertainty: options.uncertainty ?? [],
      done_criteria: doneCriteria,
      verification: [{ command: `pnpm test checkpoint-${n}`, exit_code: 0 }],
      completed_step_ids: completed,
      head_sha: String(n + 2).repeat(40),
    },
    { idempotencyKey: `close-${n}` }
  );
}

async function recordRun(
  context: SeedContext,
  input: {
    evaluator: string;
    phase: EvaluatorRunPayload['phase'];
    severity: EvaluatorRunPayload['severity'];
    verdict: 'pass' | 'info' | 'violation' | 'skipped' | 'error';
    body: string;
    ts?: string;
    checkpointN?: number;
  }
) {
  const [packageId = 'test-pack', evaluatorId = 'check'] = input.evaluator.split('/');
  const runId = uuidv7();
  const outcome =
    input.verdict === 'error'
      ? ({
          run_status: 'error',
          verdict: null,
          error: { code: 'LLM_ERROR', message: input.body },
        } as const)
      : input.verdict === 'skipped'
        ? ({ run_status: 'skipped', verdict: null } as const)
        : ({ run_status: 'completed', verdict: input.verdict } as const);
  await context.semantics.writeEvaluatorRunPayload(
    context.artifactId,
    {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: context.artifactId,
      evaluator_ref: input.evaluator,
      package_id: packageId,
      evaluator_id: evaluatorId,
      phase: input.phase,
      severity: input.severity,
      ...outcome,
      body: input.body,
      ts: input.ts ?? '2026-04-25T12:30:00.000Z',
      ...(input.checkpointN === undefined ? {} : { checkpoint_n: input.checkpointN }),
    },
    { idempotencyKey: `run-${runId}` }
  );
  return runId;
}

async function recordDisposition(
  context: SeedContext,
  runId: string,
  evaluator: string,
  disposition: EvaluatorDispositionPayload['disposition']
) {
  const dispositionId = uuidv7();
  await context.semantics.writeEvaluatorDisposition(
    context.artifactId,
    {
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: dispositionId,
      artifact_id: context.artifactId,
      run_id: runId,
      evaluator_ref: evaluator,
      disposition,
      reason: 'Reviewed and accepted',
      agent_session_id: null,
      ts: '2026-04-25T12:31:00.000Z',
    },
    { idempotencyKey: `disposition-${dispositionId}` }
  );
}

async function recordSkippedConformance(context: SeedContext, reason: string) {
  const runId = uuidv7();
  await context.semantics.writeEvaluatorRunPayload(
    context.artifactId,
    {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: context.artifactId,
      evaluator_ref: 'core/plan-conformance-pre-pr',
      package_id: 'core',
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      severity: 'warn',
      run_status: 'skipped',
      verdict: null,
      body: `SKIPPED\n\n${reason}`,
      ts: '2026-04-25T12:30:00.000Z',
    },
    { idempotencyKey: `run-${runId}` }
  );
}

async function recordErroredConformance(context: SeedContext) {
  const runId = uuidv7();
  await context.semantics.writeEvaluatorRunPayload(
    context.artifactId,
    {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: context.artifactId,
      evaluator_ref: 'core/plan-conformance-pre-pr',
      package_id: 'core',
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      severity: 'warn',
      run_status: 'error',
      verdict: null,
      error: { code: 'LLM_ERROR', message: 'TIMEOUT: provider timed out' },
      body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out',
      ts: '2026-04-25T12:30:00.000Z',
    },
    { idempotencyKey: `run-${runId}` }
  );
}

const usage: DigestUsage = {
  has_usage: true,
  sessions: [
    {
      agent: 'codex',
      session_id: 'session-1',
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 200,
      record_count: 5,
      detail: { dimensions: { web_search_requests: 3 }, model_breakdown: [] },
    },
  ],
  attributed_estimate: {
    input_tokens: 30,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40,
  },
};

describe('usageFingerprint', () => {
  it('includes usage dimensions without changing the scalar-only form', () => {
    const plain = structuredClone(usage);
    delete plain.sessions[0]!.detail;
    expect(usageFingerprint(plain)).toBe('codex:session-1:100:50:10:200:5|@:30:10:0:40');
    expect(usageFingerprint(usage)).not.toBe(usageFingerprint(plain));
  });

  it('ignores model-only detail with the default rate class', () => {
    const plain = structuredClone(usage);
    delete plain.sessions[0]!.detail;
    const modelOnly = structuredClone(plain);
    modelOnly.sessions[0]!.detail = {
      model_breakdown: [
        {
          model: 'gpt',
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
        },
      ],
    };
    expect(usageFingerprint(modelOnly)).toBe(usageFingerprint(plain));
  });
});

describe('buildThreadDigest', () => {
  it('renders retained plan, checkpoint, summary, usage, decisions, and evidence labels', async () => {
    const thread = await prepareThread(
      async (context) => {
        await closeCheckpoint(context, {
          decisions: [{ decision: 'Use token buckets', reason: 'Smooth bursts' }],
          uncertainty: ['Multi-region TTL remains uncertain'],
        });
        await context.semantics.writeSummary({
          schema_version: 1,
          artifact_id: context.artifactId,
          outcome: 'Rate limiter shipped',
          tests_written: ['rate-limit.test.ts'],
          tests_run: ['pnpm test rate-limit'],
          open_items: ['Choose a multi-region TTL'],
          deferred_decisions: ['429 response shape'],
          head_sha: 'f'.repeat(40),
          ts: '2026-04-25T13:00:00.000Z',
        });
      },
      {
        decisions: [
          {
            decision: 'Retain the original operation',
            reason: 'Retries cannot retarget',
            revision_n: 0,
            alternatives_considered: [
              { option: 'Recompute on retry', rejected_because: 'the baseline can move' },
            ],
            evidence: {
              kind: 'git-commit',
              commit_sha: 'b'.repeat(40),
              quote: 'freeze original request bytes',
            },
          },
        ],
        nonGoals: [
          {
            text: 'No schema changes',
            rationale: 'Storage is stable',
            source_refs: ['contract §2'],
          },
        ],
      }
    );
    const out = buildThreadDigest({ thread, usage });
    expect(out.data).toMatchObject({
      artifact_id: thread.artifactId,
      is_complete: true,
      outcome: 'Rate limiter shipped',
      plan_coverage_complete: false,
      uncompleted_steps: [{ step_id: thread.plan!.plan_steps[1]!.step_id, label: 'Step 2' }],
      tests_written: ['rate-limit.test.ts'],
      tests_run: ['pnpm test rate-limit'],
      usage,
    });
    expect(out.markdown).toContain('_(captured)_');
    expect(out.markdown).toContain('_(agent-reported checkpoint conclusions)_');
    expect(out.markdown).toContain('_(plan rev 0)_');
    expect(out.markdown).toContain('_(cp 1)_');
    expect(out.markdown).toContain('freeze original request bytes');
    expect(out.markdown).toContain('## deferred decisions  _(unresolved)_');
    expect(out.source_event_id).toBe(thread.artifactJson!.source_event_id);
    expect(out.usage_fingerprint).toBe(usageFingerprint(usage));
  });

  it('orders release checks and preserves acknowledged violation history', async () => {
    const thread = await prepareThread(async (context) => {
      const acknowledged = await recordRun(context, {
        evaluator: 'test-pack/api-drift',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION\n\n## Removed API',
        ts: '2026-04-25T12:10:00.000Z',
      });
      await recordDisposition(context, acknowledged, 'test-pack/api-drift', 'acknowledged');
      await recordRun(context, {
        evaluator: 'test-pack/pre-pr',
        phase: 'pre-pr',
        severity: 'warn',
        verdict: 'pass',
        body: 'PASS',
        ts: '2026-04-25T12:20:00.000Z',
      });
      await recordRun(context, {
        evaluator: 'test-pack/process-note',
        phase: 'post-plan',
        severity: 'warn',
        verdict: 'info',
        body: 'INFO\n\nUseful context',
        ts: '2026-04-25T12:30:00.000Z',
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks.map((row) => row.evaluator_ref)).toEqual([
      'test-pack/api-drift',
      'test-pack/pre-pr',
    ]);
    expect(out.data.process_notes.map((row) => row.evaluator_ref)).toEqual([
      'test-pack/process-note',
    ]);
    expect(out.data.acknowledged_blocks).toEqual([
      expect.objectContaining({ evaluator_ref: 'test-pack/api-drift' }),
    ]);
    expect(out.markdown).toContain('#### Removed API');
  });

  it('keeps an acknowledged block after a later evaluator pass', async () => {
    const thread = await prepareThread(async (context) => {
      const runId = await recordRun(context, {
        evaluator: 'test-pack/repeated',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION once',
      });
      await recordDisposition(context, runId, 'test-pack/repeated', 'acknowledged');
      await recordRun(context, {
        evaluator: 'test-pack/repeated',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'pass',
        body: 'PASS later',
        ts: '2026-04-25T12:40:00.000Z',
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({ status: 'pass', body: 'PASS later' });
    expect(out.data.acknowledged_blocks).toEqual([
      expect.objectContaining({ evaluator_ref: 'test-pack/repeated' }),
    ]);
  });

  it('redacts secrets from structured data and markdown', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const thread = await prepareThread(undefined, {
      task: `Do not expose ${secret}`,
      secretAllow: [secret],
    });
    const out = buildThreadDigest({ thread });
    expect(JSON.stringify(out.data)).not.toContain(secret);
    expect(out.markdown).not.toContain(secret);
    expect(out.markdown).toContain('[REDACTED_SECRET]');
    expect(buildThreadDigest({ thread, redactSecrets: false }).markdown).toContain(secret);
  });

  it('renders a content-free pinned source plan and hoists conformance', async () => {
    const thread = await prepareThread(
      async (context) => {
        await recordRun(context, {
          evaluator: 'core/plan-conformance-pre-pr',
          phase: 'pre-pr',
          severity: 'warn',
          verdict: 'violation',
          body: 'VIOLATION\n\nSilent gaps: 1.',
        });
      },
      { sourcePlan: sourcePin }
    );
    const out = buildThreadDigest({ thread });
    expect(out.data.source_plan).toEqual({
      pinned: true,
      locator: 'docs/plan.md',
      hash: 'a'.repeat(64),
    });
    expect(JSON.stringify(out.data)).not.toContain('PRIVATE PLAN BODY');
    expect(out.data.plan_conformance?.evaluator_ref).toBe('core/plan-conformance-pre-pr');
    expect([...out.data.release_checks, ...out.data.process_notes]).toHaveLength(0);
    expect(out.markdown).toContain('Silent gaps: 1.');
  });

  it('forces conformance null without a pin', async () => {
    const thread = await prepareThread(async (context) => {
      await recordRun(context, {
        evaluator: 'core/plan-conformance-pre-pr',
        phase: 'pre-pr',
        severity: 'warn',
        verdict: 'info',
        body: 'INFO\n\nNo pin',
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.source_plan).toBeNull();
    expect(out.data.plan_conformance).toBeNull();
    expect(out.markdown).toContain('no source plan pinned');
  });

  it('gives the pre-PR conformance run priority and removes both runs from other sections', async () => {
    const thread = await prepareThread(
      async (context) => {
        await recordRun(context, {
          evaluator: 'core/plan-conformance-post-plan',
          phase: 'post-plan',
          severity: 'warn',
          verdict: 'pass',
          body: 'PASS early',
          ts: '2026-04-25T12:10:00.000Z',
        });
        await recordRun(context, {
          evaluator: 'core/plan-conformance-pre-pr',
          phase: 'pre-pr',
          severity: 'warn',
          verdict: 'violation',
          body: 'VIOLATION final drift',
          ts: '2026-04-25T12:20:00.000Z',
        });
      },
      { sourcePlan: sourcePin }
    );
    const out = buildThreadDigest({ thread });
    expect(out.data.plan_conformance).toMatchObject({
      evaluator_ref: 'core/plan-conformance-pre-pr',
      body: 'VIOLATION final drift',
    });
    expect([...out.data.release_checks, ...out.data.process_notes]).toEqual([]);
  });

  it('renders provider-specific guidance for skipped conformance without its raw body', async () => {
    const reason =
      'resolved provider codex is not installed ' +
      '(selected by your .orcaops/evaluators.yaml override)';
    const thread = await prepareThread((context) => recordSkippedConformance(context, reason), {
      sourcePlan: sourcePin,
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.plan_conformance?.status).toBe('skipped');
    expect(out.markdown).toContain(reason);
    expect(out.markdown).toContain('UNVERIFIED');
    expect(out.markdown).not.toContain('SKIPPED');
  });

  it('distinguishes a missing conformance run from an errored run', async () => {
    const missing = buildThreadDigest({
      thread: await prepareThread(undefined, { sourcePlan: sourcePin }),
    });
    expect(missing.data.plan_conformance).toBeNull();
    expect(missing.markdown).toContain('plan-conformance` did not run');
    expect(missing.markdown).toContain('`orcaops eval add-pack @orcaops/evaluator-pack core`');
    expect(missing.markdown).toContain('`core/plan-conformance-*` is disabled');

    const errored = buildThreadDigest({
      thread: await prepareThread(recordErroredConformance, { sourcePlan: sourcePin }),
    });
    expect(errored.data.plan_conformance?.status).toBe('error');
    expect(errored.markdown).toContain('UNVERIFIED');
    expect(errored.markdown).not.toContain('provider timed out');
  });

  it.each([
    {
      checkpoint:
        "Sub-second tier uses .toFixed(1), so 59999ms renders as '60.0s' at the tier boundary; revisit if callers require display consistency.",
      summary:
        "Sub-second tier renders 59999ms as '60.0s' due to .toFixed(1) at the tier boundary.",
    },
    {
      checkpoint:
        "Sub-second tier renders 59999ms as '60.0s' due to .toFixed(1) at the tier boundary.",
      summary:
        "Sub-second tier uses .toFixed(1), so 59999ms renders as '60.0s' at the tier boundary; revisit if callers require display consistency.",
    },
  ])(
    'deduplicates uncertainty in both containment directions but retains unrelated findings',
    async ({ checkpoint, summary }) => {
      const unrelated = 'TTL strategy remains unknown for multi-region Redis';
      const thread = await prepareThread(async (context) => {
        await closeCheckpoint(context, { uncertainty: [checkpoint, unrelated] });
        await context.semantics.writeSummary({
          schema_version: 1,
          artifact_id: context.artifactId,
          outcome: 'Delivered',
          tests_written: [],
          tests_run: [],
          open_items: [summary],
          deferred_decisions: [],
          head_sha: 'f'.repeat(40),
          ts: '2026-04-25T13:00:00.000Z',
        });
      });
      const out = buildThreadDigest({ thread });
      expect(out.data.open_uncertainty).toEqual([{ item: unrelated, checkpoint: 1 }]);
      expect(out.markdown).toContain(`${summary} _(from summary)_`);
      expect(out.markdown).toContain(`${unrelated} _(from cp 1)_`);
    }
  );

  it('renders empty, all-pass, and mixed evaluator process states distinctly', async () => {
    const empty = buildThreadDigest({ thread: await prepareThread() });
    expect(empty.markdown).toContain('_No process checks ran._');
    expect(empty.markdown).toContain('_No release-relevant checks ran.');

    const passed = buildThreadDigest({
      thread: await prepareThread(async (context) => {
        await recordRun(context, {
          evaluator: 'test-pack/passed',
          phase: 'post-plan',
          severity: 'warn',
          verdict: 'pass',
          body: 'PASS',
        });
      }),
    });
    expect(passed.markdown).toContain('_All 1 process check passed._');
    expect(passed.markdown).not.toContain('### test-pack/passed');

    const mixed = buildThreadDigest({
      thread: await prepareThread(async (context) => {
        await recordRun(context, {
          evaluator: 'test-pack/problem',
          phase: 'post-plan',
          severity: 'warn',
          verdict: 'violation',
          body: 'VIOLATION\n\nMissing a control',
        });
        await recordRun(context, {
          evaluator: 'test-pack/passed',
          phase: 'post-plan',
          severity: 'warn',
          verdict: 'pass',
          body: 'PASS',
          ts: '2026-04-25T12:40:00.000Z',
        });
      }),
      evaluatorDescriptions: new Map([
        ['test-pack/problem', 'Checks the first line\nand the wrapped continuation.'],
      ]),
    });
    expect(mixed.markdown).toContain('⚠ 1 of 2 process checks flagged a concern.');
    expect(mixed.markdown).toContain('_Checks the first line and the wrapped continuation._');
    expect(mixed.markdown).toContain('_Passed: test-pack/passed (post-plan, warn)._');
  });

  it('lists skipped process checks as not run instead of as concerns', async () => {
    const out = buildThreadDigest({
      thread: await prepareThread(async (context) => {
        await recordRun(context, {
          evaluator: 'test-pack/passed',
          phase: 'checkpoint-close',
          severity: 'warn',
          verdict: 'pass',
          body: 'PASS',
        });
        await recordRun(context, {
          evaluator: 'test-pack/deterministic-only',
          phase: 'checkpoint-close',
          severity: 'info',
          verdict: 'skipped',
          body: 'SKIPPED\n\nfilters.when_llm=absent but an LLM provider is configured',
          ts: '2026-04-25T12:40:00.000Z',
        });
      }),
    });
    expect(out.markdown).not.toContain('flagged a concern');
    expect(out.markdown).not.toContain('### test-pack/deterministic-only');
    expect(out.markdown).toContain('_1 of 2 process checks passed; 1 skipped._');
    expect(out.markdown).toContain(
      '_Skipped (did not run): test-pack/deterministic-only (checkpoint-close) — ' +
        'filters.when_llm=absent but an LLM provider is configured._'
    );
  });

  it('counts only non-skipped results in the process concern headline', async () => {
    const out = buildThreadDigest({
      thread: await prepareThread(async (context) => {
        await recordRun(context, {
          evaluator: 'test-pack/problem',
          phase: 'post-plan',
          severity: 'warn',
          verdict: 'violation',
          body: 'VIOLATION\n\nMissing a control',
        });
        await recordRun(context, {
          evaluator: 'test-pack/deterministic-only',
          phase: 'checkpoint-close',
          severity: 'info',
          verdict: 'skipped',
          body: 'SKIPPED',
          ts: '2026-04-25T12:40:00.000Z',
        });
      }),
    });
    expect(out.markdown).toContain('⚠ 1 of 2 process checks flagged a concern.');
    expect(out.markdown).toContain('### test-pack/problem (violation, post-plan)');
    expect(out.markdown).toContain(
      '_Skipped (did not run): test-pack/deterministic-only (checkpoint-close)._'
    );
  });

  it('uses the latest evaluator run and records prior resolutions', async () => {
    const thread = await prepareThread(async (context) => {
      const first = await recordRun(context, {
        evaluator: 'test-pack/repeated',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION first',
      });
      await recordDisposition(context, first, 'test-pack/repeated', 'dismissed');
      const second = await recordRun(context, {
        evaluator: 'test-pack/repeated',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION second',
        ts: '2026-04-25T12:40:00.000Z',
      });
      await recordDisposition(context, second, 'test-pack/repeated', 'acknowledged');
      await recordRun(context, {
        evaluator: 'test-pack/repeated',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION latest',
        ts: '2026-04-25T12:50:00.000Z',
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({
      body: 'VIOLATION latest',
      prior_resolved: {
        count: 2,
        last_disposition: 'acknowledged',
        last_reason: 'Reviewed and accepted',
      },
    });
    expect(out.markdown).toContain('previously resolved 2 time(s)');
  });

  it('reports an earlier checkpoint violation that a later checkpoint pass does not re-judge', async () => {
    const thread = await prepareThread(async (context) => {
      await recordRun(context, {
        evaluator: 'core/non-goals-violated',
        phase: 'checkpoint-close',
        severity: 'warn',
        verdict: 'violation',
        body: 'VIOLATION non-goal crossed at checkpoint 3',
        checkpointN: 3,
      });
      await recordRun(context, {
        evaluator: 'core/non-goals-violated',
        phase: 'checkpoint-close',
        severity: 'warn',
        verdict: 'pass',
        body: 'PASS checkpoint 4',
        ts: '2026-04-25T12:40:00.000Z',
        checkpointN: 4,
      });
      await recordRun(context, {
        evaluator: 'test-pack/other',
        phase: 'post-plan',
        severity: 'warn',
        verdict: 'pass',
        body: 'PASS',
      });
    });
    const out = buildThreadDigest({ thread });
    const row = out.data.process_notes.find((r) => r.evaluator_ref === 'core/non-goals-violated');
    expect(row).toMatchObject({
      status: 'violation',
      violation_checkpoints: [3],
      body: 'VIOLATION non-goal crossed at checkpoint 3',
    });
    expect(JSON.parse(JSON.stringify(out.data)).process_notes).toContainEqual(
      expect.objectContaining({
        evaluator_ref: 'core/non-goals-violated',
        status: 'violation',
        violation_checkpoints: [3],
      })
    );
    expect(out.markdown).toContain(
      '### core/non-goals-violated (violation, checkpoint-close)\n\n_Unresolved violation at checkpoint 3._'
    );
    expect(out.markdown).toContain('VIOLATION non-goal crossed at checkpoint 3');
    expect(out.markdown).toContain('_Passed: test-pack/other (post-plan, warn)._');
    expect(out.markdown).not.toMatch(/_Passed:[^\n]*core\/non-goals-violated/);
  });

  it('names every checkpoint whose latest run is an unresolved violation', async () => {
    const thread = await prepareThread(async (context) => {
      for (const [n, verdict] of [
        [3, 'violation'],
        [4, 'pass'],
        [5, 'violation'],
        [6, 'pass'],
      ] as const) {
        await recordRun(context, {
          evaluator: 'test-pack/scoped',
          phase: 'checkpoint-close',
          severity: 'block',
          verdict,
          body: `${verdict.toUpperCase()} checkpoint ${n}`,
          ts: `2026-04-25T12:3${n}:00.000Z`,
          checkpointN: n,
        });
      }
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({
      status: 'violation',
      violation_checkpoints: [3, 5],
      body: 'VIOLATION checkpoint 5',
    });
    expect(out.markdown).toContain(
      '| test-pack/scoped | checkpoint-close | block | violation at checkpoints 3, 5 |'
    );
    expect(out.markdown).toContain(
      '### test-pack/scoped (violation)\n\n_Unresolved violation at checkpoints 3, 5._'
    );
  });

  it('does not count a checkpoint violation that was resolved or re-run clean at that checkpoint', async () => {
    const thread = await prepareThread(async (context) => {
      const dismissed = await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION checkpoint 2',
        checkpointN: 2,
      });
      await recordDisposition(context, dismissed, 'test-pack/scoped', 'dismissed');
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION checkpoint 3',
        ts: '2026-04-25T12:33:00.000Z',
        checkpointN: 3,
      });
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'pass',
        body: 'PASS checkpoint 3 re-run',
        ts: '2026-04-25T12:34:00.000Z',
        checkpointN: 3,
      });
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'pass',
        body: 'PASS checkpoint 4',
        ts: '2026-04-25T12:35:00.000Z',
        checkpointN: 4,
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({
      status: 'pass',
      body: 'PASS checkpoint 4',
    });
    expect(out.data.release_checks[0]).not.toHaveProperty('violation_checkpoints');
  });

  it('keeps a later checkpoint error beside an earlier unresolved violation', async () => {
    const thread = await prepareThread(async (context) => {
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION checkpoint 1',
        checkpointN: 1,
      });
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'error',
        body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out at checkpoint 2',
        ts: '2026-04-25T12:32:00.000Z',
        checkpointN: 2,
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({
      status: 'violation',
      violation_checkpoints: [1],
      body: 'VIOLATION checkpoint 1',
      latest_error: {
        checkpoint_n: 2,
        body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out at checkpoint 2',
        ts: '2026-04-25T12:32:00.000Z',
      },
    });
    expect(JSON.parse(JSON.stringify(out.data)).release_checks[0].latest_error).toMatchObject({
      checkpoint_n: 2,
    });
    expect(out.markdown).toContain(
      '| test-pack/scoped | checkpoint-close | block | violation at checkpoint 1; error at checkpoint 2 |'
    );
    expect(out.markdown).toContain(
      'VIOLATION checkpoint 1\n\n**Latest run errored at checkpoint 2:**\n\nERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out at checkpoint 2'
    );
  });

  it('reports the latest error once the earlier violation is acknowledged', async () => {
    const thread = await prepareThread(async (context) => {
      const violation = await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'violation',
        body: 'VIOLATION checkpoint 1',
        checkpointN: 1,
      });
      await recordDisposition(context, violation, 'test-pack/scoped', 'acknowledged');
      await recordRun(context, {
        evaluator: 'test-pack/scoped',
        phase: 'checkpoint-close',
        severity: 'block',
        verdict: 'error',
        body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out at checkpoint 2',
        ts: '2026-04-25T12:32:00.000Z',
        checkpointN: 2,
      });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.release_checks[0]).toMatchObject({
      status: 'error',
      body: 'ERROR (LLM_ERROR)\n\nTIMEOUT: provider timed out at checkpoint 2',
    });
    expect(out.data.release_checks[0]).not.toHaveProperty('violation_checkpoints');
    expect(out.data.release_checks[0]).not.toHaveProperty('latest_error');
  });

  it('retains earlier criterion narrowing after a later clean revision', async () => {
    const thread = await prepareThread(async (context) => {
      const first = context.planSteps[0]!;
      const second = context.planSteps[1]!;
      await context.semantics.revisePlan(
        {
          idempotency_key: 'revision-1',
          artifact_id: context.artifactId,
          label: 'Rate limiting revision 1',
          plan_steps: [
            { ...first, acceptance_criteria: [{ text: 'Replacement criterion' }] },
            {
              ...second,
              acceptance_criteria: [
                {
                  ...second.acceptance_criteria[0]!,
                  text: 'Weaker criterion',
                },
              ],
            },
          ],
          touched_scope: ['payments'],
          non_goals: [],
          decisions: [],
          rationale: 'Exercise retained criterion lineage',
          prior_plan_event_id: null,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: 'revision-1' }
      );
      await context.semantics.revisePlan(
        {
          idempotency_key: 'revision-2',
          artifact_id: context.artifactId,
          label: 'Rate limiting revision 2',
          plan_steps: [
            {
              ...first,
              text: 'Unrelated wording update',
              // Same text as revision 1 → auto-carries its id, so revision 2 makes
              // no criterion change of its own.
              acceptance_criteria: [{ text: 'Replacement criterion' }],
            },
            {
              ...second,
              acceptance_criteria: [
                {
                  ...second.acceptance_criteria[0]!,
                  text: 'Weaker criterion',
                },
              ],
            },
          ],
          touched_scope: ['payments'],
          non_goals: [],
          decisions: [],
          rationale: 'Make a later revision with no criterion changes',
          prior_plan_event_id: null,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: 'revision-2' }
      );
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.plan_revision_count).toBe(2);
    expect(out.data.criterion_changes.removed).toEqual([
      expect.objectContaining({ revision_n: 1, text: 'Criterion 1' }),
    ]);
    expect(out.data.criterion_changes.rewritten).toEqual([
      expect.objectContaining({
        revision_n: 1,
        prior_text: 'Criterion 2',
        new_text: 'Weaker criterion',
      }),
    ]);
    expect(out.markdown).toContain('acceptance criteria changed mid-flight');
  });

  it('marks finalized overlap groups and keeps open groups provisional', async () => {
    const resolved = structuredClone(
      await prepareThread(async (context) => {
        await closeCheckpoint(context, { n: 1 });
        await closeCheckpoint(context, { n: 2 });
      })
    );
    const resolvedFirst = resolved.checkpoints[0]!;
    const resolvedSecond = resolved.checkpoints[1]!;
    if (resolvedFirst.status !== 'closed' || resolvedSecond.status !== 'closed') {
      throw new Error('expected two retained closed checkpoints');
    }
    resolvedFirst.window_overlap = {
      siblings: [2],
      cross_artifact_siblings: [],
      pending: true,
      dropped_files: [],
      rejected_claims: [],
      ambiguous_files: [],
      mixed_segment: [],
      own_claim_pending: [{ file_before: null, file_after: 'src/file-1.ts' }],
      segment_attributed: [],
      unattributed_in_window: [],
      degradations: [],
    };
    resolvedSecond.window_overlap = {
      siblings: [1],
      cross_artifact_siblings: [],
      pending: false,
      dropped_files: [],
      rejected_claims: [],
      ambiguous_files: [],
      mixed_segment: [],
      own_claim_pending: [],
      segment_attributed: [],
      unattributed_in_window: [],
      degradations: [],
    };
    expect(buildThreadDigest({ thread: resolved }).markdown).toContain('group resolved');

    const open = structuredClone(
      await prepareThread(async (context) => {
        await closeCheckpoint(context, { n: 1 });
        await context.semantics.writeCheckpointOpened(
          { artifact_id: context.artifactId, declared_step_ids: [context.stepIds[1]!] },
          { idempotencyKey: 'open-2', headSha: '2'.repeat(40) }
        );
      })
    );
    const openFirst = open.checkpoints[0]!;
    if (openFirst.status !== 'closed') throw new Error('expected a retained closed checkpoint');
    openFirst.window_overlap = resolvedFirst.window_overlap;
    expect(buildThreadDigest({ thread: open }).markdown).not.toContain('group resolved');
  });

  it('preserves accepted warning identity and omits absent optional sections', async () => {
    const reviewId = uuidv7();
    const runId = uuidv7();
    const complete = structuredClone(
      await prepareThread(async (context) => {
        await context.semantics.writeSummary({
          schema_version: 1,
          artifact_id: context.artifactId,
          outcome: 'Delivered',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: 'f'.repeat(40),
          ts: '2026-04-25T13:00:00.000Z',
        });
      })
    );
    complete.summary!.accepted_warnings = [
      {
        review_id: reviewId,
        run_id: runId,
        evaluator_ref: 'test-pack/warning',
        reason: 'Approved during implementation',
      },
    ];
    const out = buildThreadDigest({ thread: complete });
    expect(out.data.accepted_warnings).toEqual([
      {
        review_id: reviewId,
        run_id: runId,
        evaluator_ref: 'test-pack/warning',
        reason: 'Approved during implementation',
      },
    ]);
    expect(out.markdown).toContain(reviewId);
    expect(out.markdown).toContain(runId);

    const bare = buildThreadDigest({ thread: await prepareThread() });
    expect(bare.markdown).not.toContain('## policy exceptions');
    expect(bare.markdown).not.toContain('## deferred decisions');
    expect(bare.markdown).not.toContain('acceptance criteria changed mid-flight');
  });

  it('reports incomplete delivery and keeps checkpoint uncertainty distinct from open items', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, { uncertainty: ['Unknown cache invalidation behavior'] });
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.is_complete).toBe(false);
    expect(out.data.open_uncertainty).toEqual([
      { item: 'Unknown cache invalidation behavior', checkpoint: 1 },
    ]);
    expect(out.data.open_items).toEqual([]);
    expect(out.markdown).toContain('## checkpoint uncertainties');
  });

  it('renders policy exceptions from closed and abandoned checkpoints', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, {
        policyExceptions: [{ evaluator: 'test-pack/check', reason: 'Owner accepted risk' }],
      });
      await context.semantics.writeCheckpointOpened(
        {
          artifact_id: context.artifactId,
          declared_step_ids: [context.stepIds[1]!],
          policy_exceptions: [{ evaluator: 'test-pack/other', reason: 'Temporary exception' }],
        },
        {
          idempotencyKey: 'open-2',
          headSha: 'c'.repeat(40),
        }
      );
      await context.semantics.writeCheckpointAbandoned(
        { artifact_id: context.artifactId, n: 2, reason: 'No longer needed' },
        { idempotencyKey: 'abandon-2' }
      );
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.policy_exceptions).toEqual([
      { cp_n: 1, evaluator_ref: 'test-pack/check', reason: 'Owner accepted risk' },
      { cp_n: 2, evaluator_ref: 'test-pack/other', reason: 'Temporary exception' },
    ]);
  });

  it('rejects snapshots without a plan or artifact projection', async () => {
    const thread = await prepareThread();
    expect(() => buildThreadDigest({ thread: { ...thread, plan: null } })).toThrow(/no plan/);
    expect(() => buildThreadDigest({ thread: { ...thread, artifactJson: null } })).toThrow(
      /no artifact projection/
    );
  });

  it('protects the source-plan summary type from content spreads', () => {
    // @ts-expect-error content-bearing source plans cannot enter digest JSON
    const leaked: DigestSourcePlan = { ...sourcePin, pinned: true, locator: 'x' };
    void leaked;
    expect(true).toBe(true);
  });
});

describe('demoteBodyHeadings', () => {
  it('demotes headings, clamps at H6, and preserves fenced code', () => {
    const rendered = demoteBodyHeadings('# one\n##### five\n```md\n# code\n```', 3);
    expect(rendered).toBe('#### one\n###### five\n```md\n# code\n```');
  });

  it('leaves non-heading hashes and a zero-level request unchanged', () => {
    expect(demoteBodyHeadings('text # hash\n# heading', 0)).toBe('text # hash\n# heading');
  });
});

describe('buildThreadDigest — rubric presence is reported unconditionally', () => {
  const stepWith = (label: string, criteria: string[]) => ({
    step_id: uuidv7(),
    label,
    text: `Deliver ${label}`,
    acceptance_criteria: criteria.map((text) => ({ criterion_id: uuidv7(), text })),
  });

  it('reports an all-empty rubric even though no evaluator ran', async () => {
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Step 1', []), stepWith('Step 2', [])],
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.acceptance_criteria_coverage).toMatchObject({
      total: 2,
      covered: 0,
      missing: 2,
    });
    expect(out.data.step_coverage_active).toBe(false);
    expect(out.markdown).toContain('## acceptance criteria');
    expect(out.markdown).toContain('0 of 2 steps');
    expect(out.markdown).toContain('criterion-level completion is unverified');
  });

  it('reports a mixed rubric and names only the steps missing one', async () => {
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Covered', ['has a rubric']), stepWith('Bare', [])],
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.acceptance_criteria_coverage).toMatchObject({
      total: 2,
      covered: 1,
      missing: 1,
    });
    expect(out.data.plan_steps_without_criteria).toEqual(['Bare']);
    expect(out.markdown).toContain('1 of 2 steps');
    expect(out.markdown).toContain('- Bare');
    expect(out.markdown).not.toContain('- Covered');
  });

  it('reports a full rubric without implying the work was delivered', async () => {
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Step 1', ['a']), stepWith('Step 2', ['b'])],
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.acceptance_criteria_coverage).toMatchObject({ covered: 2, missing: 0 });
    expect(out.markdown).toContain('2 of 2 steps');
    expect(out.markdown).not.toContain('criterion-level completion is unverified');
    const section = out.markdown.slice(out.markdown.indexOf('## acceptance criteria'));
    expect(section.split('##')[1]).not.toMatch(/verified|delivered|graded/i);
  });

  it('never describes an omission as exempt or as graded by an evaluator', async () => {
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Covered', ['x']), stepWith('Bare', [])],
    });
    const { markdown } = buildThreadDigest({ thread });
    const section = markdown.slice(
      markdown.indexOf('## acceptance criteria'),
      markdown.indexOf('## acceptance criteria') + 400
    );
    expect(section).not.toMatch(/exempt|approved|does not grade|step-coverage/i);
  });

  it('renders the same coverage for the same retained plan on every build', async () => {
    // `finish` and a direct `digest` both go through buildThreadDigest, so a
    // stable result for one thread is what keeps the two surfaces agreeing.
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Covered', ['x']), stepWith('Bare', [])],
    });
    const first = buildThreadDigest({ thread });
    const second = buildThreadDigest({ thread });
    expect(second.data.acceptance_criteria_coverage).toEqual(
      first.data.acceptance_criteria_coverage
    );
    expect(second.data.acceptance_criteria_status).toBe(first.data.acceptance_criteria_status);
  });

  it('tags the counts with the revision they measured', async () => {
    const thread = await prepareThread(undefined, {
      planSteps: [stepWith('Step 1', [])],
    });
    const out = buildThreadDigest({ thread });
    expect(out.data.acceptance_criteria_coverage.revision_n).toBe(0);
    expect(out.markdown).toContain('(revision 0)');
  });
});

describe('buildThreadDigest — rubric counts do not depend on evaluator activity', () => {
  const stepWith = (label: string, criteria: string[]) => ({
    step_id: uuidv7(),
    label,
    text: `Deliver ${label}`,
    acceptance_criteria: criteria.map((text) => ({ criterion_id: uuidv7(), text })),
  });

  const runStepCoverage = async (context: SeedContext) => {
    await recordRun(context, {
      evaluator: 'core/step-coverage',
      phase: 'checkpoint-close',
      severity: 'warn',
      verdict: 'pass',
      body: 'graded what it could',
    });
  };

  const shapes = [
    { name: 'all-empty', steps: [[], []], covered: 0, total: 2 },
    { name: 'mixed', steps: [['x'], []], covered: 1, total: 2 },
    { name: 'full', steps: [['x'], ['y']], covered: 2, total: 2 },
  ] as const;

  for (const shape of shapes) {
    it(`reports ${shape.name} identically with and without a step-coverage run`, async () => {
      const planSteps = shape.steps.map((criteria, i) => stepWith(`Step ${i + 1}`, [...criteria]));

      const without = buildThreadDigest({ thread: await prepareThread(undefined, { planSteps }) });
      const with_ = buildThreadDigest({
        thread: await prepareThread(runStepCoverage, { planSteps }),
      });

      for (const out of [without, with_]) {
        expect(out.data.acceptance_criteria_coverage).toMatchObject({
          total: shape.total,
          covered: shape.covered,
          missing: shape.total - shape.covered,
        });
        expect(out.markdown).toContain(`${shape.covered} of ${shape.total} steps`);
      }
      expect(without.data.step_coverage_active).toBe(false);
      expect(with_.data.step_coverage_active).toBe(true);
      expect(with_.data.acceptance_criteria_status).toBe(without.data.acceptance_criteria_status);
    });
  }

  it('adds the UNVERIFIED note only when an evaluator actually graded nothing', async () => {
    const planSteps = [stepWith('Step 1', []), stepWith('Step 2', [])];
    const without = buildThreadDigest({ thread: await prepareThread(undefined, { planSteps }) });
    const with_ = buildThreadDigest({
      thread: await prepareThread(runStepCoverage, { planSteps }),
    });
    expect(without.markdown).not.toContain('delivery coverage UNVERIFIED');
    expect(with_.markdown).toContain('delivery coverage UNVERIFIED');
    expect(without.markdown).toContain('0 of 2 steps');
  });
});
