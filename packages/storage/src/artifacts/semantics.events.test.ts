import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactDraftSemantics } from './draft-preparation.js';
import {
  createRetainedArtifactDraft,
  type RetainedArtifactDraft,
} from './retained-draft.test-support.js';
import type { DiffFingerprintManifest } from '../schema/diff-fingerprint.js';
import type { PlanInput } from '../schema/plan.js';
import type { SummaryInput } from '../schema/summary.js';

const ARTIFACT_ID = '01999999-9999-7000-8000-000000000101';
const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
const OPENED_AT = '2026-04-26T12:00:00.000Z';
const CLOSED_AT = '2026-04-26T13:00:00.000Z';

function planInput(artifactId = ARTIFACT_ID, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'feat/retained-history',
    base_sha: 'a'.repeat(40),
    agent: 'claude-code',
    agent_session_id: null,
    task: 'retain authored history',
    label: 'Retain authored history',
    plan_steps: [
      { step_id: STEP_ID, text: 'retain events', label: 'Retain events', acceptance_criteria: [] },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: OPENED_AT,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
    ...overrides,
  };
}

function summaryInput(
  artifactId = ARTIFACT_ID,
  overrides: Partial<SummaryInput> = {}
): SummaryInput {
  return {
    schema_version: 1,
    artifact_id: artifactId,
    outcome: 'shipped',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: 'b'.repeat(40),
    ts: CLOSED_AT,
    ...overrides,
  };
}

function runPayload(artifactId = ARTIFACT_ID, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'orcaops.evaluator_run/v1' as const,
    run_id: 'run-default',
    artifact_id: artifactId,
    evaluator_ref: 'core/api-stability',
    package_id: 'core',
    evaluator_id: 'api-stability',
    phase: 'pre-pr' as const,
    severity: 'block' as const,
    run_status: 'completed' as const,
    verdict: 'violation' as 'pass' | 'violation' | 'info' | null,
    body: 'VIOLATION\n\nbreaks API',
    ts: '2026-04-26T12:30:00.000Z',
    ...overrides,
  };
}

function dispositionPayload(artifactId = ARTIFACT_ID, runId = 'run-default') {
  return {
    schema: 'orcaops.evaluator_disposition/v1' as const,
    disposition_id: `dis-${runId}`,
    artifact_id: artifactId,
    run_id: runId,
    evaluator_ref: 'core/api-stability',
    disposition: 'acknowledged' as const,
    reason: 'reviewed and accepted',
    agent_session_id: null,
    ts: '2026-04-26T12:35:00.000Z',
  };
}

function passingPrePrReview(headSha = 'b'.repeat(40)) {
  return {
    head_sha: headSha,
    outcome: 'passed' as const,
    evaluator_set_fingerprint: 'a'.repeat(64),
    review_context_fingerprint: 'b'.repeat(64),
    run_ids: [],
  };
}

async function writePlan(
  semantics: ArtifactDraftSemantics,
  artifactId = ARTIFACT_ID,
  options: Parameters<ArtifactDraftSemantics['writePlan']>[1] = { idempotencyKey: 'plan' }
) {
  return semantics.writePlan(planInput(artifactId), options);
}

async function openCheckpoint(
  semantics: ArtifactDraftSemantics,
  artifactId = ARTIFACT_ID,
  options: Partial<Parameters<ArtifactDraftSemantics['writeCheckpointOpened']>[1]> = {}
) {
  return semantics.writeCheckpointOpened(
    { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
    {
      idempotencyKey: 'open',
      headSha: 'b'.repeat(40),
      ...options,
    }
  );
}

function closeInput(artifactId = ARTIFACT_ID, summary = 'retained work') {
  return {
    artifact_id: artifactId,
    n: 1,
    summary,
    files_changed: ['src/retained.ts'],
    decisions: [],
    uncertainty: [],
    done_criteria: [],
    verification: [{ command: 'pnpm test', exit_code: 0 }],
    completed_step_ids: [STEP_ID],
    head_sha: 'b'.repeat(40),
  };
}

async function plannedDraft(artifactId = ARTIFACT_ID) {
  const draft = createRetainedArtifactDraft(artifactId);
  await writePlan(draft.semantics, artifactId);
  return draft;
}

function retainedEvent(draft: RetainedArtifactDraft, type: string) {
  const matches = draft.events.filter((event) => event.record.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('retained artifact authoring events', () => {
  let draft: RetainedArtifactDraft;
  let semantics: ArtifactDraftSemantics;

  beforeEach(() => {
    draft = createRetainedArtifactDraft(ARTIFACT_ID);
    semantics = draft.semantics;
  });

  it('retains the original plan identity and keeps a source-plan pin out of the plan projection', async () => {
    const sourcePlan = {
      source_ref: { kind: 'local' as const, locator: 'docs/plan.md' },
      content: '# approved plan\n',
      hash: 'c'.repeat(64),
      baseline: null,
    };
    const first = await semantics.writePlan(planInput(), {
      idempotencyKey: 'same-plan',
      sourcePlan,
    });
    const replay = await semantics.writePlan(planInput(), {
      idempotencyKey: 'same-plan',
      sourcePlan,
    });

    expect(replay.event_id).toBe(first.event_id);
    expect(draft.events.map((event) => event.record.type)).toEqual(['plan_captured']);
    expect(await semantics.readArtifact(ARTIFACT_ID)).toMatchObject({
      source_event_id: first.event_id,
      source_plan: sourcePlan,
      state: 'planned',
    });
    expect(await semantics.readPlan(ARTIFACT_ID)).not.toHaveProperty('source_plan');
  });

  it('replays the same checkpoint intent and conflicts before appending changed intent', async () => {
    await writePlan(semantics);
    const opened = await openCheckpoint(semantics);
    expect(opened.outcome).toBe('created');
    const first = await semantics.writeCheckpointClosed(closeInput(), {
      idempotencyKey: 'close',
    });
    const replay = await semantics.writeCheckpointClosed(closeInput(), {
      idempotencyKey: 'close',
    });
    const conflict = await semantics.writeCheckpointClosed(closeInput(ARTIFACT_ID, 'changed'), {
      idempotencyKey: 'close',
    });

    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('replay');
    expect(conflict.outcome).toBe('conflict');
    expect(draft.events.map((event) => event.record.type)).toEqual([
      'plan_captured',
      'checkpoint_opened',
      'checkpoint_closed',
    ]);
    expect((await semantics.readArtifact(ARTIFACT_ID))?.checkpoint_count).toBe(1);
  });

  it('distinguishes a skipped open snapshot, a captured boundary, and callback failure', async () => {
    const cases = [
      {
        artifactId: '01999999-9999-7000-8000-000000000102',
        callbacks: undefined,
        expected: { snapshot_ref: null, snapshot_error_reason: null },
      },
      {
        artifactId: '01999999-9999-7000-8000-000000000103',
        callbacks: {
          captureOpenSnapshot: async () => ({
            boundary: {
              snapshot_ref: 'refs/orcaops/snap/open',
              tree_sha: 'c'.repeat(40),
              snapshot_commit_sha: 'd'.repeat(40),
              snapshot_error_reason: null,
            },
          }),
        },
        expected: { snapshot_ref: 'refs/orcaops/snap/open', snapshot_error_reason: null },
      },
      {
        artifactId: '01999999-9999-7000-8000-000000000104',
        callbacks: {
          captureOpenSnapshot: async () => {
            throw new Error('snapshot unavailable');
          },
        },
        expected: { snapshot_ref: null, snapshot_error_reason: 'unknown' },
      },
    ];

    for (const entry of cases) {
      const current = await plannedDraft(entry.artifactId);
      const result = await openCheckpoint(current.semantics, entry.artifactId, {
        snapshotCallbacks: entry.callbacks,
      });
      expect(result.outcome).toBe('created');
      if (result.outcome === 'created') {
        expect(result.checkpoint.open_snapshot).toMatchObject(entry.expected);
      }
    }
  });

  it('retains a close boundary and manifest and never reruns callbacks on replay or conflict', async () => {
    await writePlan(semantics);
    await openCheckpoint(semantics);
    const callback = vi.fn(async () => {
      const manifest: DiffFingerprintManifest = {
        schema_version: 1,
        artifact_id: ARTIFACT_ID,
        checkpoint_n: 1,
        open_tree_sha: 'a'.repeat(40),
        close_tree_sha: 'b'.repeat(40),
        status: 'captured',
        hunk_count: 1,
        captured_hunk_count: 1,
        truncated: false,
        error_reason: null,
        normalization_version: 'orcaops-line-normalization-v1',
        diff_algorithm: 'git-diff-unified-v1',
        diff_options: { unified: 3, find_renames: true, no_ext_diff: true },
        limits: { max_diff_bytes: 1_000_000 },
        hash_encoding: 'base64url-nopad',
        line_hash_algorithm: 'blake3-xof-96-base64url-nopad-v2',
        patch_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        hunk_header_hash_algorithm: 'blake3-xof-128-base64url-nopad-v1',
        manifest_hash_algorithm: 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1',
        hunks: [
          {
            hunk_index: 1,
            file_before: 'src/retained.ts',
            file_after: 'src/retained.ts',
            change_type: 'modify',
            binary: false,
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            patch_hash: 'patch-hash',
            added_line_hashes: ['added-line-hash'],
            deleted_line_hashes: [],
            hunk_header_hash: null,
            added_line_count: 1,
            deleted_line_count: 0,
          },
        ],
      };
      return {
        boundary: {
          snapshot_ref: 'refs/orcaops/snap/close',
          tree_sha: 'b'.repeat(40),
          snapshot_commit_sha: 'c'.repeat(40),
          snapshot_error_reason: null,
        },
        summary: {
          status: 'captured' as const,
          hunk_count: 1,
          captured_hunk_count: 1,
          truncated: false,
          fingerprint_algorithm: 'blake3-xof-96-base64url-nopad-v2' as const,
          manifest_hash: 'manifest-hash',
          manifest_hash_algorithm: manifest.manifest_hash_algorithm,
          error_reason: null,
        },
        manifest,
      };
    });
    const options = {
      idempotencyKey: 'close-callback',
      snapshotCallbacks: { captureCloseFingerprint: callback },
    };

    const first = await semantics.writeCheckpointClosed(closeInput(), options);
    const replay = await semantics.writeCheckpointClosed(closeInput(), options);
    const conflict = await semantics.writeCheckpointClosed(
      closeInput(ARTIFACT_ID, 'different intent'),
      options
    );

    expect(first.outcome).toBe('created');
    if (first.outcome === 'created') {
      expect(first.checkpoint.close_snapshot.snapshot_ref).toBe('refs/orcaops/snap/close');
      expect(first.checkpoint.diff_fingerprint_summary.manifest_hash).toBe('manifest-hash');
    }
    expect(replay.outcome).toBe('replay');
    expect(conflict.outcome).toBe('conflict');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(retainedEvent(draft, 'checkpoint_closed').payload).toMatchObject({
      diff_fingerprint_manifest: { artifact_id: ARTIFACT_ID, hunks: [{ hunk_index: 1 }] },
    });
  });

  it('retains runtime agent provenance while excluding a retrying agent from intent', async () => {
    await writePlan(semantics);
    const first = await openCheckpoint(semantics, ARTIFACT_ID, {
      invokedByAgent: 'claude-code',
    });
    const replay = await openCheckpoint(semantics, ARTIFACT_ID, {
      invokedByAgent: 'cursor',
    });
    const closed = await semantics.writeCheckpointClosed(closeInput(), {
      idempotencyKey: 'close-agent',
      invokedByAgent: 'codex',
    });

    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('replay');
    if (replay.outcome === 'replay') expect(replay.checkpoint.agent).toBe('claude-code');
    expect(closed.outcome).toBe('created');
    if (closed.outcome === 'created') {
      expect(closed.checkpoint.agent).toBe('claude-code');
      expect(closed.checkpoint.closed_by_agent).toBe('codex');
    }
  });

  it('retains default and explicitly supplied checkpoint attribution', async () => {
    await writePlan(semantics);
    await openCheckpoint(semantics);
    const closed = await semantics.writeCheckpointClosed(closeInput(), {
      idempotencyKey: 'close',
    });
    expect(closed.outcome).toBe('created');
    if (closed.outcome === 'created') {
      expect(closed.checkpoint.agent).toBe('other');
      expect(closed.checkpoint.closed_by_agent).toBe('other');
    }

    const abandonId = '01999999-9999-7000-8000-000000000106';
    const abandonDraft = await plannedDraft(abandonId);
    await openCheckpoint(abandonDraft.semantics, abandonId, { invokedByAgent: 'codex' });
    const abandoned = await abandonDraft.semantics.writeCheckpointAbandoned(
      { artifact_id: abandonId, n: 1, reason: 'paused' },
      { idempotencyKey: 'abandon', invokedByAgent: 'opencode' }
    );

    expect(abandoned.outcome).toBe('created');
    if (abandoned.outcome === 'created') {
      expect(abandoned.checkpoint.agent).toBe('codex');
      expect(abandoned.checkpoint.abandoned_by_agent).toBe('opencode');
      expect(abandoned.checkpoint.agent_session_id).toBeUndefined();
    }
    const retained = structuredClone(abandonDraft.events);
    const replay = await abandonDraft.semantics.writeCheckpointAbandoned(
      { artifact_id: abandonId, n: 1, reason: 'paused' },
      { idempotencyKey: 'abandon', invokedByAgent: 'cursor' }
    );
    expect(replay.outcome).toBe('replay');
    if (replay.outcome === 'replay') {
      expect(replay.checkpoint.agent).toBe('codex');
      expect(replay.checkpoint.abandoned_by_agent).toBe('opencode');
    }
    expect(abandonDraft.events).toEqual(retained);
  });

  it('retains revision attribution and git-import origin through event rebuilding', async () => {
    const origin = {
      kind: 'git-import' as const,
      imported_at: '2026-04-26T11:00:00.000Z',
      tool_version: '0.0.5',
      source_range: 'main~1..main',
      authors: ['dev@example.com'],
      enriched_at: null,
    };
    await semantics.writePlan(planInput(ARTIFACT_ID, { origin }), { idempotencyKey: 'plan' });
    const revised = await semantics.revisePlan(
      {
        idempotency_key: 'revise',
        artifact_id: ARTIFACT_ID,
        label: 'Retain revised history',
        plan_steps: planInput().plan_steps,
        rationale: 'clarify retained behavior',
        prior_plan_event_id: null,
        touched_scope: [],
        non_goals: [],
        decisions: [],
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'revise', invokedByAgent: 'github-copilot' }
    );

    expect(revised.outcome).toBe('created');
    if (revised.outcome === 'created') {
      expect(revised.plan.revised_by_agent).toBe('github-copilot');
      expect(revised.plan.agent).toBe('claude-code');
      expect(revised.plan.origin).toEqual(origin);
    }
    const direct = await semantics.revisePlan(
      {
        idempotency_key: 'revise-direct',
        artifact_id: ARTIFACT_ID,
        label: 'Retain direct revision',
        plan_steps: planInput().plan_steps,
        rationale: 'verify direct provenance',
        prior_plan_event_id: null,
        touched_scope: [],
        non_goals: [],
        decisions: [],
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
      },
      { idempotencyKey: 'revise-direct' }
    );
    expect(direct.outcome).toBe('created');
    if (direct.outcome === 'created') expect(direct.plan.revised_by_agent).toBeNull();
    expect((await semantics.readArtifact(ARTIFACT_ID))?.origin).toEqual(origin);
  });

  it('retains supplied checkpoint timestamps and rejects malformed or backwards time without append', async () => {
    await writePlan(semantics);
    const beforeInvalid = draft.events.length;
    await expect(
      openCheckpoint(semantics, ARTIFACT_ID, {
        idempotencyKey: 'invalid-open',
        openedAt: 'yesterday',
      })
    ).rejects.toThrow();
    expect(draft.events).toHaveLength(beforeInvalid);

    const openedAt = '2020-01-02T03:04:05.000Z';
    const opened = await openCheckpoint(semantics, ARTIFACT_ID, { openedAt });
    expect(opened.outcome).toBe('created');
    if (opened.outcome === 'created') expect(opened.checkpoint.opened_at).toBe(openedAt);
    const beforeBackwards = draft.events.length;
    await expect(
      semantics.writeCheckpointClosed(closeInput(), {
        idempotencyKey: 'backwards-close',
        closedAt: '2020-01-02T03:04:04.000Z',
      })
    ).rejects.toThrow(/precedes its open timestamp/);
    expect(draft.events).toHaveLength(beforeBackwards);
    const closed = await semantics.writeCheckpointClosed(closeInput(), {
      idempotencyKey: 'backdated-close',
      closedAt: openedAt,
      skipWallClockOverlapScan: true,
    });
    expect(closed.outcome).toBe('created');
    if (closed.outcome === 'created') expect(closed.checkpoint.closed_at).toBe(openedAt);
  });

  async function writeWarningReview(runIds: string[]) {
    for (const [index, runId] of runIds.entries()) {
      await semantics.writeEvaluatorRunPayload(
        ARTIFACT_ID,
        runPayload(ARTIFACT_ID, {
          run_id: runId,
          evaluator_ref: `test/warning-${index}`,
          evaluator_id: `warning-${index}`,
          severity: 'warn',
          body: `warning ${index}`,
        }),
        { idempotencyKey: `run-${runId}` }
      );
    }
    const review = await semantics.writePrePrChecked(ARTIFACT_ID, {
      head_sha: 'b'.repeat(40),
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: runIds,
    });
    return { reviewId: review.event_id, runIds };
  }

  it('normalizes and replays an exact complete warning acceptance', async () => {
    await writePlan(semantics);
    const review = await writeWarningReview(['run-warning-a', 'run-warning-b']);
    const accepted = review.runIds.map((runId, index) => ({
      review_id: review.reviewId,
      run_id: runId,
      evaluator_ref: `test/warning-${index}`,
      reason: `reviewed warning ${index}`,
    }));
    const first = await semantics.writeSummary(
      summaryInput(ARTIFACT_ID, { accepted_warnings: [...accepted].reverse() }),
      { idempotencyKey: 'summary-warning' }
    );
    const replay = await semantics.writeSummary(
      summaryInput(ARTIFACT_ID, { accepted_warnings: accepted }),
      { idempotencyKey: 'summary-warning' }
    );

    expect(first.outcome).toBe('created');
    expect(first.summary.accepted_warnings).toEqual(accepted);
    expect(replay.outcome).toBe('replay');
  });

  it('rejects partial and superseded warning review acceptance', async () => {
    await writePlan(semantics);
    const first = await writeWarningReview(['run-warning-a', 'run-warning-b']);
    await expect(
      semantics.writeSummary(
        summaryInput(ARTIFACT_ID, {
          accepted_warnings: [
            {
              review_id: first.reviewId,
              run_id: first.runIds[0]!,
              evaluator_ref: 'test/warning-0',
              reason: 'only one warning reviewed',
            },
          ],
        }),
        { idempotencyKey: 'partial-warning' }
      )
    ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });

    await writeWarningReview(['run-warning-current']);
    await expect(
      semantics.writeSummary(
        summaryInput(ARTIFACT_ID, {
          accepted_warnings: first.runIds.map((runId, index) => ({
            review_id: first.reviewId,
            run_id: runId,
            evaluator_ref: `test/warning-${index}`,
            reason: 'accepted from an older review',
          })),
        }),
        { idempotencyKey: 'superseded-warning' }
      )
    ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });
  });

  it('conflicts on changed warning acceptance and rejects acceptance of evaluator errors', async () => {
    await writePlan(semantics);
    const review = await writeWarningReview(['run-warning']);
    const accepted = {
      review_id: review.reviewId,
      run_id: 'run-warning',
      evaluator_ref: 'test/warning-0',
      reason: 'reviewed warning',
    };
    const first = await semantics.writeSummary(
      summaryInput(ARTIFACT_ID, { accepted_warnings: [accepted] }),
      { idempotencyKey: 'warning-conflict' }
    );
    const conflict = await semantics.writeSummary(
      summaryInput(ARTIFACT_ID, {
        accepted_warnings: [{ ...accepted, reason: 'different reason' }],
      }),
      { idempotencyKey: 'warning-conflict' }
    );
    expect(first.outcome).toBe('created');
    expect(conflict.outcome).toBe('conflict');

    const errorDraft = await plannedDraft('01999999-9999-7000-8000-000000000105');
    const errorId = '01999999-9999-7000-8000-000000000105';
    await errorDraft.semantics.writeEvaluatorRunPayload(
      errorId,
      runPayload(errorId, {
        run_id: 'run-warning-error',
        evaluator_ref: 'test/warning-error',
        evaluator_id: 'warning-error',
        severity: 'warn',
        run_status: 'error',
        verdict: null,
        body: '',
        error: { code: 'TIMEOUT', message: 'review timed out' },
      }),
      { idempotencyKey: 'warning-error' }
    );
    const marker = await errorDraft.semantics.writePrePrChecked(errorId, {
      head_sha: 'b'.repeat(40),
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: ['run-warning-error'],
    });
    await expect(
      errorDraft.semantics.writeSummary(
        summaryInput(errorId, {
          accepted_warnings: [
            {
              review_id: marker.event_id,
              run_id: 'run-warning-error',
              evaluator_ref: 'test/warning-error',
              reason: 'accept infrastructure failure',
            },
          ],
        }),
        { idempotencyKey: 'accept-error' }
      )
    ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });
  });

  it('retains evaluator disposition and pre-PR state before allowing summary', async () => {
    await writePlan(semantics);
    await semantics.writeEvaluatorRunPayload(ARTIFACT_ID, runPayload(), {
      idempotencyKey: 'violation',
    });
    expect(await semantics.readArtifact(ARTIFACT_ID)).toMatchObject({ state: 'blocked' });
    await expect(
      semantics.writeSummary(summaryInput(), { idempotencyKey: 'blocked-summary' })
    ).rejects.toMatchObject({ code: 'BLOCKED' });

    await semantics.writeEvaluatorDisposition(ARTIFACT_ID, dispositionPayload(), {
      idempotencyKey: 'disposition',
    });
    const log = await semantics.readEvaluatorLog(ARTIFACT_ID);
    expect(log?.runs[0]).toMatchObject({ run_id: 'run-default', disposition: 'acknowledged' });
    expect(log?.dispositions).toHaveLength(1);
    const review = await semantics.writePrePrChecked(
      ARTIFACT_ID,
      passingPrePrReview('b'.repeat(40)),
      { idempotencyKey: 'pre-pr' }
    );
    expect((await semantics.readArtifact(ARTIFACT_ID))?.pre_pr_checked_source_event_id).toBe(
      review.event_id
    );
    await expect(
      semantics.writeSummary(summaryInput(), { idempotencyKey: 'accepted-summary' })
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  it('keeps a block evaluator error unresolved until a passing rerun', async () => {
    await writePlan(semantics);
    await semantics.writeEvaluatorRunPayload(
      ARTIFACT_ID,
      runPayload(ARTIFACT_ID, {
        run_id: 'run-error',
        run_status: 'error',
        verdict: null,
        body: '',
        error: { code: 'ENGINE_FAILED', message: 'runner unavailable' },
      }),
      { idempotencyKey: 'error' }
    );
    await expect(
      semantics.writeEvaluatorDisposition(
        ARTIFACT_ID,
        dispositionPayload(ARTIFACT_ID, 'run-error'),
        {
          idempotencyKey: 'error-disposition',
        }
      )
    ).rejects.toThrow(/Evaluator errors must be rerun successfully/);
    await expect(
      semantics.writeSummary(summaryInput(), { idempotencyKey: 'error-summary' })
    ).rejects.toMatchObject({ code: 'BLOCKED' });

    await semantics.writeEvaluatorRunPayload(
      ARTIFACT_ID,
      runPayload(ARTIFACT_ID, { run_id: 'run-pass', verdict: 'pass', body: 'PASS' }),
      { idempotencyKey: 'pass' }
    );
    await expect(
      semantics.writeSummary(summaryInput(), { idempotencyKey: 'cleared-summary' })
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  const autoKeyCases: Array<{
    name: string;
    eventType: string;
    run: (draft: RetainedArtifactDraft, artifactId: string) => Promise<void>;
  }> = [
    {
      name: 'writePlan',
      eventType: 'plan_captured',
      run: async ({ semantics }, artifactId) => {
        await semantics.writePlan(planInput(artifactId), {
          sourcePlan: {
            source_ref: { kind: 'local', locator: 'docs/plan.md' },
            content: '# plan\n',
            hash: 'a'.repeat(64),
            baseline: null,
          },
        });
      },
    },
    {
      name: 'writeSummary',
      eventType: 'summary_captured',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.writeSummary(summaryInput(artifactId), {
          replayPayload: { artifact_id: artifactId, outcome: 'shipped' },
        });
      },
    },
    {
      name: 'writeEvaluatorRunPayload',
      eventType: 'evaluator_run_recorded',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.writeEvaluatorRunPayload(artifactId, runPayload(artifactId), {});
      },
    },
    {
      name: 'writeEvaluatorDisposition',
      eventType: 'evaluator_disposition_recorded',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.writeEvaluatorRunPayload(artifactId, runPayload(artifactId), {
          idempotencyKey: 'seed-run',
        });
        await semantics.writeEvaluatorDisposition(artifactId, dispositionPayload(artifactId), {});
      },
    },
    {
      name: 'appendBranchLineage',
      eventType: 'branch_lineage_updated',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.appendBranchLineage(
          artifactId,
          {
            branch: 'feat/updated',
            head_sha: 'c'.repeat(40),
            ts: CLOSED_AT,
            event: 'rebased',
          },
          {}
        );
      },
    },
    {
      name: 'writePrePrChecked',
      eventType: 'pre_pr_checked',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.writePrePrChecked(artifactId, passingPrePrReview(), {});
      },
    },
    {
      name: 'writePinDisplaced',
      eventType: 'pin_displaced',
      run: async ({ semantics }, artifactId) => {
        await writePlan(semantics, artifactId);
        await semantics.writePinDisplaced(
          artifactId,
          {
            displaced_by_artifact_id: '01999999-9999-7000-8000-000000000999',
            shell_key: { kind: 'cloud' },
            reason: 'auto-on-capture-plan',
          },
          {}
        );
      },
    },
  ];

  it.each(autoKeyCases)('$name mints an idempotency key in retained history', async (entry) => {
    const artifactId = `01999999-9999-7000-8000-${String(autoKeyCases.indexOf(entry) + 200).padStart(12, '0')}`;
    const current = createRetainedArtifactDraft(artifactId);
    await entry.run(current, artifactId);
    const matching = current.events.filter((event) => event.record.type === entry.eventType);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.record.idempotency_key).toMatch(/\S/);
  });
});
