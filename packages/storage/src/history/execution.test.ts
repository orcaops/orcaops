import { describe, expect, it } from 'vitest';

import {
  assertExecutionMutation,
  bindingFromGitContext,
  type ExecutionBinding,
  type ExecutionState,
  type ExecutionTransitionInput,
  initializeCapturedExecution,
  initializeUnboundExecution,
  prepareExecutionCheckpointRecovery,
  prepareExecutionTransition,
  readExecutionState,
  recordExecutionCheckpointOpen,
} from './execution.js';
import { uuidv7 } from '../ids/uuidv7.js';

const timestamp = '2026-09-05T00:00:00.000Z';
function binding(): ExecutionBinding {
  return {
    repository_instance_id: uuidv7(),
    worktree_id: uuidv7(),
    git_context: { head_sha: '1'.repeat(40), branch: 'main' },
  };
}
function captured() {
  const context = binding();
  const state = initializeCapturedExecution({
    artifactId: uuidv7(),
    operationId: uuidv7(),
    ts: timestamp,
    context,
  });
  return { state, context };
}
function transition(
  state: ExecutionState,
  input: Partial<ExecutionTransitionInput> = {}
): ExecutionTransitionInput {
  return {
    state,
    operationId: uuidv7(),
    expectedGeneration: state.binding_generation,
    expectedBinding: state.current_binding,
    action: 'completed',
    openCheckpointIds: [],
    ts: timestamp,
    ...input,
  };
}

describe('witnessed execution state', () => {
  it('retains checkpoint recovery outcomes and releases the block only when every checkpoint resolves', () => {
    const { state, context } = captured();
    const ids = [uuidv7(), uuidv7()];
    const taken = prepareExecutionTransition(
      transition(state, {
        action: 'orphan_recovered',
        target: { ...context, worktree_id: uuidv7() },
        reason: 'Reviewed administrative removal',
        openCheckpointIds: ids,
      })
    ).executionState;
    const request = {
      state: taken,
      operationId: uuidv7(),
      checkpointEventId: ids[0],
      action: 'verified_continuation' as const,
      reason: 'Original boundary was verified',
    };
    const partial = prepareExecutionCheckpointRecovery(request);
    expect(partial.recovery?.verified_checkpoint_ids).toEqual([ids[0]]);
    expect(() => readExecutionState({ ...partial, recovery: null })).toThrow();
    expect(prepareExecutionCheckpointRecovery({ ...request, state: partial })).toEqual(partial);
    expect(() =>
      prepareExecutionCheckpointRecovery({ ...request, state: partial, reason: 'Changed reason' })
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const done = prepareExecutionCheckpointRecovery({
      state: partial,
      operationId: uuidv7(),
      checkpointEventId: ids[1],
      action: 'administrative_abandon',
      reason: 'Replay objects are unavailable',
    });
    expect(done.recovery).toBeNull();
    expect(done.binding_generation).toBe(taken.binding_generation);
    expect(done.checkpoint_recovery_history).toHaveLength(2);
    expect(done.binding_history).toEqual(taken.binding_history);
  });
  it('retains immutable checkpoint-open execution after handoff', () => {
    const { state, context } = captured();
    const checkpointEventId = uuidv7();
    const live = { ...context, git_context: { ...context.git_context, head_sha: '3'.repeat(40) } };
    const attributed = recordExecutionCheckpointOpen({
      state,
      checkpointEventId,
      expectedGeneration: 1,
      context: live,
    });
    expect(attributed.checkpoint_execution).toEqual([
      { checkpoint_event_id: checkpointEventId, binding_generation: 1, context: live },
    ]);
    expect(
      recordExecutionCheckpointOpen({
        state: attributed,
        checkpointEventId,
        expectedGeneration: 1,
        context: live,
      })
    ).toEqual(attributed);
    expect(() =>
      recordExecutionCheckpointOpen({
        state: attributed,
        checkpointEventId,
        expectedGeneration: 1,
        context,
      })
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const next = prepareExecutionTransition(
      transition(attributed, { action: 'handoff', target: { ...context, worktree_id: uuidv7() } })
    ).executionState;
    expect(next.checkpoint_execution).toEqual(attributed.checkpoint_execution);
    const corrupt = structuredClone(next);
    corrupt.checkpoint_execution[0].binding_generation = 2;
    expect(() => readExecutionState(corrupt)).toThrow();
  });
  it('initializes captured ownership and provenance at generation one', () => {
    const { state, context } = captured();
    expect(state).toMatchObject({
      binding_generation: 1,
      current_worktree_id: context.worktree_id,
      current_binding: context,
      null_reason: null,
      associations: [context.worktree_id],
      associations_unknown: false,
    });
    expect(state.association_history).toEqual([
      {
        repository_instance_id: context.repository_instance_id,
        worktree_id: context.worktree_id,
        first_bound_at: timestamp,
        operation_id: state.binding_history[0].operation_id,
        source: 'captured',
      },
    ]);
  });

  it.each(['never_bound', 'legacy_unknown', 'imported', 'completed'] as const)(
    'preserves truthful %s initialization without inferring an owner',
    (reason) => {
      const state = initializeUnboundExecution({
        artifactId: uuidv7(),
        operationId: uuidv7(),
        ts: timestamp,
        reason,
      });
      expect(state).toMatchObject({
        binding_generation: 0,
        current_binding: null,
        current_worktree_id: null,
        associations: [],
        null_reason: reason,
      });
      expect(state.associations_unknown).toBe(['legacy_unknown', 'imported'].includes(reason));
    }
  );

  it('rejects malformed ownership and discontinuous generation history', () => {
    const { state } = captured();
    expect(() => readExecutionState(null)).toThrow();
    expect(() => readExecutionState(state, uuidv7())).toThrow();
    expect(() => readExecutionState({ ...state, current_worktree_id: uuidv7() })).toThrow();
    const changed = structuredClone(state);
    changed.binding_generation = 0;
    changed.binding_history[0].generation = 0;
    expect(() => readExecutionState(changed)).toThrow();
    expect(() => readExecutionState({ ...state, associations: [] })).toThrow();
  });

  it('requires persisted repository and worktree identities for executable context', () => {
    expect(() =>
      bindingFromGitContext({
        commonDir: '/git',
        gitDir: '/git',
        worktreeRoot: '/repo',
        repositoryInstanceId: uuidv7(),
        worktreeId: null,
        headOid: null,
        branch: 'main',
      })
    ).toThrow(expect.objectContaining({ code: 'IDENTITY_RECOVERY_REQUIRED' }));
  });

  it('rejects recovery detached from its takeover or conflicting checkpoint outcomes', () => {
    const { state, context } = captured();
    const checkpointId = uuidv7();
    const recovered = prepareExecutionTransition(
      transition(state, {
        action: 'orphan_recovered',
        target: { ...context, worktree_id: uuidv7() },
        reason: 'Administrative identity was removed',
        openCheckpointIds: [checkpointId],
      })
    ).executionState;
    for (const change of [
      { operation_id: uuidv7() },
      { takeover_generation: 1 },
      { checkpoint_ids: [uuidv7()] },
      { verified_checkpoint_ids: [checkpointId, checkpointId] },
      { abandoned_checkpoint_ids: [checkpointId, checkpointId] },
      { verified_checkpoint_ids: [checkpointId], abandoned_checkpoint_ids: [checkpointId] },
    ]) {
      expect(() =>
        readExecutionState({ ...recovered, recovery: { ...recovered.recovery, ...change } })
      ).toThrow();
    }
  });

  it('first-binds only an unbound captured artifact and retains unknown associations', () => {
    const state = initializeUnboundExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      ts: timestamp,
      reason: 'legacy_unknown',
    });
    const target = binding();
    const result = prepareExecutionTransition(transition(state, { action: 'first_bind', target }));
    expect(result.executionState).toMatchObject({
      binding_generation: 1,
      current_binding: target,
      associations_unknown: true,
    });
    expect(() =>
      prepareExecutionTransition(
        transition(result.executionState, { action: 'first_bind', target })
      )
    ).toThrow(expect.objectContaining({ code: 'ALREADY_BOUND' }));
    const imported = initializeUnboundExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      ts: timestamp,
      reason: 'imported',
    });
    expect(() =>
      prepareExecutionTransition(transition(imported, { action: 'first_bind', target }))
    ).toThrow(expect.objectContaining({ code: 'IMPORTED_READ_ONLY' }));
  });

  it('fences stale generations and owners before changing execution', () => {
    const { state } = captured();
    expect(() => prepareExecutionTransition(transition(state, { expectedGeneration: 0 }))).toThrow(
      expect.objectContaining({ code: 'STALE_BINDING_GENERATION' })
    );
    expect(() => prepareExecutionTransition(transition(state, { expectedBinding: null }))).toThrow(
      expect.objectContaining({ code: 'EXECUTION_OWNER_CHANGED' })
    );
    expect(state.binding_generation).toBe(1);
  });

  it('retains handoff associations and returns stable same-operation replay', () => {
    const { state, context } = captured();
    const target = {
      ...context,
      worktree_id: uuidv7(),
      git_context: { ...context.git_context, branch: 'feature' },
    };
    const intent = transition(state, {
      action: 'handoff',
      target,
      reason: 'Continue in linked checkout',
    });
    const next = prepareExecutionTransition(intent);
    expect(next.executionState.associations).toEqual([context.worktree_id, target.worktree_id]);
    expect(next.executionState.binding_history).toHaveLength(2);
    expect(next.executionState.binding_history[1]).toMatchObject({
      prior_binding: context,
      binding: target,
      prior_generation: 1,
      generation: 2,
    });
    const replay = prepareExecutionTransition({ ...intent, state: next.executionState });
    expect(replay.replayed).toBe(true);
    expect(replay.executionState).toEqual(next.executionState);
    expect(() =>
      prepareExecutionTransition({
        ...intent,
        state: next.executionState,
        reason: 'Different intent',
      })
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('refuses ordinary handoff and branch transitions with open checkpoints', () => {
    const { state, context } = captured();
    const openCheckpointIds = [uuidv7()];
    expect(() =>
      prepareExecutionTransition(
        transition(state, {
          action: 'handoff',
          target: { ...context, worktree_id: uuidv7() },
          openCheckpointIds,
        })
      )
    ).toThrow(expect.objectContaining({ code: 'OPEN_CHECKPOINTS' }));
    expect(() =>
      prepareExecutionTransition(
        transition(state, {
          action: 'context_changed',
          target: { ...context, git_context: { ...context.git_context, branch: 'other' } },
          openCheckpointIds,
        })
      )
    ).toThrow(expect.objectContaining({ code: 'OPEN_CHECKPOINTS' }));
    expect(() => prepareExecutionTransition(transition(state, { openCheckpointIds }))).toThrow(
      expect.objectContaining({ code: 'OPEN_CHECKPOINTS' })
    );
  });

  it('rejects cross-repository handoff and records same-worktree context changes without another association', () => {
    const { state, context } = captured();
    expect(() =>
      prepareExecutionTransition(transition(state, { action: 'handoff', target: binding() }))
    ).toThrow(expect.objectContaining({ code: 'IDENTITY_CONFLICT' }));
    const result = prepareExecutionTransition(
      transition(state, {
        action: 'context_changed',
        target: { ...context, git_context: { ...context.git_context, branch: 'other' } },
      })
    );
    expect(result.executionState.binding_generation).toBe(2);
    expect(result.executionState.association_history).toEqual(state.association_history);
  });

  it('marks existing unbound checkpoints for recovery before ordinary mutation', () => {
    const state = initializeUnboundExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      ts: timestamp,
      reason: 'legacy_unknown',
    });
    const context = binding();
    const checkpointId = uuidv7();
    const result = prepareExecutionTransition(
      transition(state, {
        action: 'first_bind',
        target: context,
        openCheckpointIds: [checkpointId],
      })
    );
    expect(result.executionState.recovery).toMatchObject({
      state: 'required',
      checkpoint_ids: [checkpointId],
      takeover_generation: 1,
    });
    expect(() =>
      assertExecutionMutation({
        state: result.executionState,
        expectedGeneration: 1,
        context,
        operation: 'task',
      })
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_RECOVERY_REQUIRED' }));
  });

  it('requires an explicit orphan recovery reason and records affected original checkpoints', () => {
    const { state, context } = captured();
    const target = { ...context, worktree_id: uuidv7() };
    const intent = transition(state, {
      action: 'orphan_recovered',
      target,
      openCheckpointIds: [uuidv7()],
    });
    expect(() => prepareExecutionTransition(intent)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_REASON_REQUIRED' })
    );
    const result = prepareExecutionTransition({
      ...intent,
      reason: 'Git administrator was deliberately removed',
    });
    expect(result.executionState.recovery).toMatchObject({
      operation_id: intent.operationId,
      checkpoint_ids: intent.openCheckpointIds,
      takeover_generation: 2,
    });
    expect(result.transition.prior_binding).toEqual(context);
  });

  it('clears binding on completion without losing associations or implicitly reopening', () => {
    const { state, context } = captured();
    const completed = prepareExecutionTransition(transition(state)).executionState;
    expect(completed).toMatchObject({
      binding_generation: 2,
      lifecycle: 'completed',
      current_binding: null,
      current_worktree_id: null,
      null_reason: 'completed',
    });
    expect(completed.association_history).toEqual(state.association_history);
    expect(() =>
      prepareExecutionTransition(transition(completed, { action: 'first_bind', target: context }))
    ).toThrow(expect.objectContaining({ code: 'ARTIFACT_COMPLETED' }));
    expect(() =>
      assertExecutionMutation({
        state: completed,
        expectedGeneration: 2,
        context,
        operation: 'task',
      })
    ).toThrow(expect.objectContaining({ code: 'ARTIFACT_COMPLETED' }));
    expect(() =>
      assertExecutionMutation({
        state: completed,
        expectedGeneration: 2,
        context: null,
        operation: 'summary_amendment',
        explicitTarget: true,
      })
    ).not.toThrow();
  });

  it('allows normal commits in the bound branch and fences branch, owner and generation changes', () => {
    const { state, context } = captured();
    const input = { state, expectedGeneration: 1, context, operation: 'task' as const };
    expect(() =>
      assertExecutionMutation({
        ...input,
        context: { ...context, git_context: { ...context.git_context, head_sha: '2'.repeat(40) } },
      })
    ).not.toThrow();
    expect(() =>
      assertExecutionMutation({
        ...input,
        context: { ...context, git_context: { ...context.git_context, branch: null } },
      })
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_CONTEXT_CHANGED' }));
    expect(() =>
      assertExecutionMutation({ ...input, context: { ...context, worktree_id: uuidv7() } })
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_BOUND_ELSEWHERE' }));
    expect(() => assertExecutionMutation({ ...input, expectedGeneration: 0 })).toThrow(
      expect.objectContaining({ code: 'STALE_BINDING_GENERATION' })
    );
  });

  it('requires explicit checkout before mutation at a different detached HEAD', () => {
    const context = { ...binding(), git_context: { branch: null, head_sha: '1'.repeat(40) } };
    const state = initializeCapturedExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      context,
      ts: timestamp,
    });
    expect(() =>
      assertExecutionMutation({ state, expectedGeneration: 1, context, operation: 'task' })
    ).not.toThrow();
    expect(() =>
      assertExecutionMutation({
        state,
        expectedGeneration: 1,
        context: { ...context, git_context: { branch: null, head_sha: '2'.repeat(40) } },
        operation: 'task',
      })
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_CONTEXT_CHANGED' }));
  });
});
