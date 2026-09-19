import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactDraftSemantics,
  type ArtifactThread,
  prepareArtifactDraft,
  reconstructArtifactThread,
  uuidv7,
} from '@orcaops/storage';

import { buildResumeFromSnapshot, labelText } from './builder.js';

type SeedContext = {
  artifactId: string;
  stepIds: string[];
  criterionIds: string[];
  semantics: ArtifactDraftSemantics;
};

async function prepareThread(
  seed?: (context: SeedContext) => Promise<void>,
  options: {
    task?: string;
    secretAllow?: string[];
    agent?: 'codex' | 'other';
    /** Step indexes to leave rubric-free, as retained history may have them. */
    bareStepIndexes?: number[];
  } = {}
): Promise<ArtifactThread> {
  const artifactId = uuidv7();
  const stepIds = [uuidv7(), uuidv7(), uuidv7()];
  const criterionIds = [uuidv7(), uuidv7(), uuidv7()];
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
          branch: 'feat/resume',
          base_sha: 'a'.repeat(40),
          agent: options.agent ?? 'codex',
          agent_session_id: null,
          task: options.task ?? 'Continue retained work',
          label: 'Retained work',
          plan_steps: stepIds.map((stepId, index) => ({
            step_id: stepId,
            label: `Step ${index + 1}`,
            text: index === 0 ? 'Implement the durable reader' : `Complete work ${index + 1}`,
            acceptance_criteria: (options.bareStepIndexes ?? []).includes(index)
              ? []
              : [{ criterion_id: criterionIds[index]!, text: `Verify behavior ${index + 1}` }],
          })),
          touched_scope: ['src/history'],
          non_goals: [
            {
              text: 'No storage redesign',
              rationale: 'Use retained state',
              source_refs: ['contract §3'],
            },
          ],
          decisions: [
            {
              decision: 'Use exact retained revisions',
              reason: 'Resume must not retarget work',
              revision_n: 0,
              alternatives_considered: [
                { option: 'Read latest files', rejected_because: 'the checkout can move' },
              ],
            },
          ],
          started_at: '2026-04-25T12:00:00.000Z',
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
          prior_plan_event_id: null,
        },
        { idempotencyKey: `plan-${artifactId}` }
      );
      await seed?.({ artifactId, stepIds, criterionIds, semantics });
    }
  );
  if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
  return reconstructArtifactThread(
    artifactId,
    prepared.events.map((event) => ({
      record: event.record,
      payload: JSON.parse(event.payloadBytes.toString('utf8')),
    }))
  );
}

async function closeCheckpoint(
  context: SeedContext,
  n: number,
  completedStepIds: string[],
  options: { uncertainty?: string[]; decision?: string } = {}
) {
  await context.semantics.writeCheckpointOpened(
    { artifact_id: context.artifactId, declared_step_ids: completedStepIds },
    { idempotencyKey: `open-${n}`, headSha: String(n).repeat(40) }
  );
  await context.semantics.writeCheckpointClosed(
    {
      artifact_id: context.artifactId,
      n,
      summary: `Completed checkpoint ${n}`,
      files_changed: [`src/work-${n}.ts`],
      decisions: options.decision
        ? [{ decision: options.decision, reason: 'The retained constraint requires it' }]
        : [],
      uncertainty: options.uncertainty ?? [],
      done_criteria: completedStepIds.map((stepId) => ({
        criterion_id: context.criterionIds[context.stepIds.indexOf(stepId)]!,
        evidence: `Verified ${stepId}`,
      })),
      verification: [{ command: `pnpm test work-${n}`, exit_code: 0 }],
      completed_step_ids: completedStepIds,
      head_sha: String(n + 3).repeat(40),
    },
    { idempotencyKey: `close-${n}` }
  );
}

function render(thread: ArtifactThread, redactSecrets = true) {
  return buildResumeFromSnapshot({
    artifactId: thread.artifactId,
    plan: thread.plan,
    checkpoints: thread.checkpoints,
    summary: thread.summary,
    redactSecrets,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildResumeFromSnapshot', () => {
  it('renders stable step and criterion identities with closed-checkpoint evidence', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!]);
    });
    const out = render(thread);
    expect(out.data.steps).toEqual([
      expect.objectContaining({
        step_id: thread.plan!.plan_steps[0]!.step_id,
        done: true,
        evidence_checkpoint: 1,
        acceptance_criteria: thread.plan!.plan_steps[0]!.acceptance_criteria,
      }),
      expect.objectContaining({ step_id: thread.plan!.plan_steps[1]!.step_id, done: false }),
      expect.objectContaining({ step_id: thread.plan!.plan_steps[2]!.step_id, done: false }),
    ]);
    expect(out.data.plan_coverage_complete).toBe(false);
    expect(out.data.plan_event_id).toBe(thread.plan!.source_event_id);
    expect(out.markdown).toContain('## progress');
    expect(out.data.agent_prompt).toContain('Remaining:');
    expect(out.data.agent_prompt).toContain('No storage redesign');
  });

  it('distinguishes summary completion from incomplete plan coverage', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!]);
      await context.semantics.writeSummary({
        schema_version: 1,
        artifact_id: context.artifactId,
        outcome: 'Delivered bounded work',
        tests_written: [],
        tests_run: ['pnpm test focused'],
        open_items: ['Complete the remaining steps'],
        deferred_decisions: [],
        head_sha: 'f'.repeat(40),
        ts: '2026-04-25T13:00:00.000Z',
      });
    });
    const out = render(thread);
    expect(out.data).toMatchObject({
      is_complete: true,
      plan_coverage_complete: false,
      open_items: ['Complete the remaining steps'],
      last_checkpoint_head_sha: '4'.repeat(40),
    });
  });

  it('reports open checkpoints and excludes their declarations from uncovered work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:10:00.000Z'));
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!]);
      await context.semantics.writeCheckpointOpened(
        {
          artifact_id: context.artifactId,
          declared_step_ids: [context.stepIds[1]!],
          agent_session_id: 'session-open',
        },
        { idempotencyKey: 'open-2', headSha: 'e'.repeat(40), invokedByAgent: 'codex' }
      );
    });
    const out = render(thread);
    expect(out.data.open_checkpoints).toEqual([
      expect.objectContaining({
        n: 2,
        declared_step_ids: [thread.plan!.plan_steps[1]!.step_id],
        agent_session_id: 'session-open',
        idle_for_seconds: expect.any(Number),
      }),
    ]);
    expect(out.data.uncovered_step_ids).toEqual([thread.plan!.plan_steps[2]!.step_id]);
    expect(out.data.agent_prompt).toContain('Open checkpoints (in-flight from prior session):');
  });

  it('preserves completed steps dropped by a later plan revision', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!]);
    });
    const latest = structuredClone(thread);
    latest.plan!.revision_n = 1;
    latest.plan!.plan_steps = latest.plan!.plan_steps.slice(1);
    const out = render(latest);
    expect(out.data.historic_completions).toEqual([
      {
        step_id: thread.plan!.plan_steps[0]!.step_id,
        text_at_completion: null,
        evidence_checkpoint: 1,
      },
    ]);
    expect(out.markdown).toContain('## historic completions');
  });

  it('orders plan decisions before checkpoint decisions and retains uncertainty', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!], {
        decision: 'Keep Git work outside database transactions',
        uncertainty: ['Blame may be unavailable in shallow clones'],
      });
    });
    const out = render(thread);
    expect(out.data.decisions.map((decision) => decision.source)).toEqual(['plan', 'checkpoint']);
    expect(out.data.decisions[0]!.alternatives_considered).toEqual([
      { option: 'Read latest files', rejected_because: 'the checkout can move' },
    ]);
    expect(out.data.open_uncertainty).toEqual([
      { item: 'Blame may be unavailable in shallow clones', checkpoint: 1 },
    ]);
    expect(out.data.agent_prompt).toContain('Decisions made so far');
    expect(out.data.agent_prompt).toContain('Open questions');
  });

  it('redacts secrets in data, markdown, and the pasteable prompt', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const thread = await prepareThread(undefined, {
      task: `Resume ${secret}`,
      secretAllow: [secret],
    });
    const out = render(thread);
    expect(JSON.stringify(out.data)).not.toContain(secret);
    expect(out.markdown).not.toContain(secret);
    expect(out.data.agent_prompt).toContain('[REDACTED_SECRET]');
    expect(render(thread, false).markdown).toContain(secret);
  });

  it('uses the latest closed checkpoint head and ignores abandoned claims', async () => {
    const thread = await prepareThread(async (context) => {
      await closeCheckpoint(context, 1, [context.stepIds[0]!]);
      await context.semantics.writeCheckpointOpened(
        { artifact_id: context.artifactId, declared_step_ids: [context.stepIds[1]!] },
        { idempotencyKey: 'open-2', headSha: '8'.repeat(40) }
      );
      await context.semantics.writeCheckpointAbandoned(
        { artifact_id: context.artifactId, n: 2, reason: 'Superseded' },
        { idempotencyKey: 'abandon-2' }
      );
    });
    const out = render(thread);
    expect(out.data.checkpoint_count).toBe(1);
    expect(out.data.last_checkpoint_head_sha).toBe('4'.repeat(40));
    expect(out.data.steps[1]!.done).toBe(false);
  });

  it('rejects a missing or mismatched plan', async () => {
    const thread = await prepareThread();
    expect(() =>
      buildResumeFromSnapshot({
        artifactId: thread.artifactId,
        plan: null,
        checkpoints: [],
        summary: null,
      })
    ).toThrow(/no matching plan/);
    expect(() =>
      buildResumeFromSnapshot({
        artifactId: uuidv7(),
        plan: thread.plan,
        checkpoints: thread.checkpoints,
        summary: thread.summary,
      })
    ).toThrow(/no matching plan/);
  });

  it('shows differing author attribution without adding noise for the author', async () => {
    const thread = await prepareThread(async (context) => {
      await context.semantics.writeCheckpointOpened(
        {
          artifact_id: context.artifactId,
          declared_step_ids: [context.stepIds[0]!],
        },
        { idempotencyKey: 'open-1', headSha: 'b'.repeat(40), invokedByAgent: 'other' }
      );
    });
    const out = render(thread);
    expect(out.data.authoring_agent).toBe('codex');
    expect(out.data.open_checkpoints[0]!.agent).toBe('other');
    expect(out.markdown).toContain('other');
  });
});

describe('labelText', () => {
  it('collapses identical text and separates distinct labels', () => {
    expect(labelText('Build reader', 'Build reader')).toBe('Build reader');
    expect(labelText('Build reader', 'Use retained rows')).toBe('Build reader — Use retained rows');
  });
});

describe('buildResumeFromSnapshot — missing rubrics reach the resumed agent', () => {
  it('reports coverage over the current retained plan in structured data', async () => {
    const thread = await prepareThread(undefined, { bareStepIndexes: [1, 2] });
    const { data: resume } = render(thread);
    expect(resume.acceptance_criteria_coverage).toMatchObject({
      revision_n: 0,
      total: 3,
      covered: 1,
      missing: 2,
    });
    expect(resume.acceptance_criteria_coverage.missing_step_ids).toHaveLength(2);
  });

  it('names the rubric-free steps in the paste-ready prompt', async () => {
    const thread = await prepareThread(undefined, { bareStepIndexes: [1] });
    const { data: resume } = render(thread);
    expect(resume.agent_prompt).toContain('1 step has no recorded criteria');
    expect(resume.agent_prompt).toContain('Step 2 — Complete work 2 (no recorded criteria)');
    expect(resume.agent_prompt).not.toContain(
      'Step 1 — Implement the durable reader (no recorded criteria)'
    );
  });

  it('stays quiet in the prompt when every step carries a rubric', async () => {
    const thread = await prepareThread();
    const { data: resume } = render(thread);
    expect(resume.acceptance_criteria_coverage.missing).toBe(0);
    expect(resume.agent_prompt).not.toContain('no recorded criteria');
  });

  it('names the rubric-free steps in the rendered markdown too', async () => {
    const thread = await prepareThread(undefined, { bareStepIndexes: [1] });
    const { markdown } = render(thread);
    expect(markdown).toContain('1 step has no recorded criteria');
    expect(markdown).toContain('Step 2 — Complete work 2 (no recorded criteria)');
    expect(markdown).toContain('criterion-level completion is unverified');
  });

  it('keeps step-claim coverage and rubric presence as separate statements', async () => {
    const thread = await prepareThread(undefined, { bareStepIndexes: [0, 1, 2] });
    const { markdown } = render(thread);
    expect(markdown).toContain('Recorded acceptance criteria: 0 of 3 steps');
    expect(markdown).not.toMatch(/exempt|approved|does not grade/i);
  });

  it('never tells the resumed agent an omission was graded or approved', async () => {
    const thread = await prepareThread(undefined, { bareStepIndexes: [0, 1, 2] });
    const { data: resume } = render(thread);
    expect(resume.acceptance_criteria_status).toContain('0 of 3 steps');
    expect(resume.agent_prompt).not.toMatch(/exempt|approved|does not grade/i);
  });
});
