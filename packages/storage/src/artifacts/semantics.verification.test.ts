import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactDraftSemantics } from './draft-preparation.js';
import {
  createRetainedArtifactDraft,
  type RetainedArtifactDraft,
} from './retained-draft.test-support.js';
import { type VerificationEntry, VerificationEntrySchema } from '../schema/checkpoint.js';

/**
 * Verified-close `verification` plumbing. Completion claims require evidence;
 * partial closes still preserve the optional-absent representation at every
 * persisted layer.
 */
describe('artifact semantics — verified-close verification', () => {
  let draft: RetainedArtifactDraft;
  let store: ArtifactDraftSemantics;

  const artifactId = '01999999-9999-7000-8000-00000000000a';
  const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
  const EVIDENCE: VerificationEntry[] = [
    { command: 'pnpm test', exit_code: 0, output_digest: 'turbo 23/23' },
  ];

  beforeEach(async () => {
    draft = createRetainedArtifactDraft(artifactId);
    store = draft.semantics;
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'verify the close',
        label: 'verify-close',
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
      },
      { idempotencyKey: 'plan-1' }
    );
  });

  async function openCp(key: string): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
      { idempotencyKey: key, headSha: 'cafef00d' }
    );
  }

  function closeCp(
    key: string,
    verification?: VerificationEntry[],
    completed = true
  ): ReturnType<ArtifactDraftSemantics['writeCheckpointClosed']> {
    return store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'work done',
        files_changed: ['src/x.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        ...(verification !== undefined ? { verification } : {}),
        completed_step_ids: completed ? [STEP_ID] : [],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: key }
    );
  }

  function readCloseEventPayload(): Record<string, unknown> {
    const close = draft.events.find((event) => event.record.type === 'checkpoint_closed');
    expect(close).toBeDefined();
    return close!.payload as Record<string, unknown>;
  }

  it('a close with verification retains it in the result and event', async () => {
    await openCp('open-1');
    const result = await closeCp('close-1', EVIDENCE);
    expect(result.outcome).toBe('created');
    if (result.outcome === 'conflict') throw new Error('unexpected conflict');
    expect(result.checkpoint.status).toBe('closed');
    if (result.checkpoint.status !== 'closed') return;
    expect(result.checkpoint.verification).toEqual(EVIDENCE);

    const payload = await readCloseEventPayload();
    expect(payload.verification).toEqual(EVIDENCE);
  });

  it('accepts non-zero verification as honest completion evidence', async () => {
    await openCp('open-1');
    const result = await closeCp('close-1', [{ command: 'pnpm test', exit_code: 1 }]);
    expect(result.outcome).toBe('created');
  });

  it('a partial close WITHOUT verification leaves the key ABSENT at every layer', async () => {
    await openCp('open-1');
    const result = await closeCp('close-1', undefined, false);
    if (result.outcome === 'conflict') throw new Error('unexpected conflict');
    expect(result.checkpoint.status).toBe('closed');
    expect('verification' in result.checkpoint).toBe(false);

    const payload = await readCloseEventPayload();
    expect('verification' in payload).toBe(false);
  });

  it('an EMPTY verification array on a partial close behaves like absence', async () => {
    await openCp('open-1');
    const result = await closeCp('close-1', [], false);
    if (result.outcome === 'conflict') throw new Error('unexpected conflict');
    expect(result.checkpoint.status).toBe('closed');
    expect('verification' in result.checkpoint).toBe(false);
    expect('verification' in (await readCloseEventPayload())).toBe(false);
  });

  it('replay: same key + same verification replays; different verification conflicts', async () => {
    await openCp('open-1');
    const first = await closeCp('close-1', EVIDENCE);
    expect(first.outcome).toBe('created');
    const replay = await closeCp('close-1', EVIDENCE);
    expect(replay.outcome).toBe('replay');

    const conflict = await closeCp('close-1', [{ command: 'pnpm lint', exit_code: 1 }]);
    expect(conflict.outcome).toBe('conflict');
  });

  it('cross-shape replay: a partial close retried with an empty array replays', async () => {
    await openCp('open-1');
    const first = await closeCp('close-1', undefined, false);
    expect(first.outcome).toBe('created');
    const retried = await closeCp('close-1', [], false);
    expect(retried.outcome).toBe('replay');

    // And the inverse asymmetry is a REAL conflict: retrying with actual
    // evidence is a different close.
    const conflict = await closeCp('close-1', EVIDENCE);
    expect(conflict.outcome).toBe('conflict');
  });

  it('rejects a completion claim without verification before append', async () => {
    await openCp('open-1');
    await expect(closeCp('close-1')).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      path: 'verification',
    });
    expect(await store.readCheckpoint(artifactId, 1)).toMatchObject({ status: 'open' });
  });

  it('allows a git-import completion claim without fabricated verification', async () => {
    const importedArtifactId = '01999999-9999-7000-8000-00000000000b';
    const importedStepId = '01HX0K8N6ZQF8M5R2V8DZ7T3KY';
    const imported = createRetainedArtifactDraft(importedArtifactId).semantics;
    const plan = await imported.writePlan(
      {
        schema_version: 4,
        artifact_id: importedArtifactId,
        branch: 'main',
        base_sha: 'abc123',
        agent: 'other',
        agent_session_id: null,
        task: 'import existing history',
        label: 'import-history',
        plan_steps: [
          {
            step_id: importedStepId,
            text: 'imported step',
            label: 'imported-step',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        origin: {
          kind: 'git-import',
          imported_at: '2026-04-26T12:00:00.000Z',
          tool_version: '0.0.5',
          source_range: 'abc123..cafef00d',
          authors: ['dev@example.com'],
          enriched_at: null,
        },
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'imported-plan' }
    );
    await imported.writeCheckpointOpened(
      {
        artifact_id: importedArtifactId,
        declared_step_ids: [importedStepId],
        plan_revision_id: plan.event_id,
      },
      { idempotencyKey: 'imported-open', headSha: 'abc123' }
    );

    const result = await imported.writeCheckpointClosed(
      {
        artifact_id: importedArtifactId,
        n: 1,
        summary: 'imported work',
        files_changed: ['src/imported.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: [importedStepId],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'imported-close' }
    );

    expect(result.outcome).toBe('created');
    const checkpoint = await imported.readCheckpoint(importedArtifactId, 1);
    expect(checkpoint).toMatchObject({ status: 'closed' });
    expect(checkpoint).not.toHaveProperty('verification');
  });

  it('VerificationEntrySchema is strict: stray keys, non-int exit codes, blank commands reject', () => {
    expect(VerificationEntrySchema.safeParse({ command: 'pnpm test', exit_code: 0 }).success).toBe(
      true
    );
    expect(
      VerificationEntrySchema.safeParse({ command: 'pnpm test', exit_code: 0, extra: 1 }).success
    ).toBe(false);
    expect(
      VerificationEntrySchema.safeParse({ command: 'pnpm test', exit_code: 0.5 }).success
    ).toBe(false);
    expect(VerificationEntrySchema.safeParse({ command: '   ', exit_code: 0 }).success).toBe(false);
    expect(VerificationEntrySchema.safeParse({ command: 'x' }).success).toBe(false);
  });
});
