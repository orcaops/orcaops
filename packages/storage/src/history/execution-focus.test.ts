import { describe, expect, it } from 'vitest';

import {
  assessExecutionEligibility,
  assessExecutionFocus,
  createExecutionPin,
  type ExecutionCandidate,
  type ExecutionFocusContext,
  resolveShellKey,
  selectExecutionArtifact,
} from './execution-focus.js';
import {
  bindingFromGitContext,
  initializeCapturedExecution,
  initializeUnboundExecution,
  prepareExecutionTransition,
} from './execution.js';
import { historyRootKey } from './paths.js';
import { uuidv7 } from '../ids/uuidv7.js';

const timestamp = '2026-09-05T00:00:00.000Z';
function fixture() {
  const context: ExecutionFocusContext = {
    authority: {
      resolvedRoot: '/selected',
      rootKey: historyRootKey('/selected'),
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      formatVersion: 1,
    },
    gitContext: {
      commonDir: '/repo/.git',
      gitDir: '/repo/.git',
      worktreeRoot: '/repo',
      repositoryInstanceId: uuidv7(),
      worktreeId: uuidv7(),
      headOid: '1'.repeat(40),
      branch: 'main',
    },
    shellKey: { kind: 'codex_session', value: 'session-one' },
  };
  const state = initializeCapturedExecution({
    artifactId: uuidv7(),
    operationId: uuidv7(),
    context: bindingFromGitContext(context.gitContext!),
    ts: timestamp,
  });
  const candidate: ExecutionCandidate = {
    artifactId: state.artifact_id,
    label: 'Authored work',
    executionState: state,
  };
  const pin = createExecutionPin({ ...context, state, pinnedAt: timestamp });
  return { context, state, candidate, pin };
}

describe('execution focus and eligible selection', () => {
  it('keeps read-only imported focus separate from task eligibility', () => {
    const { context } = fixture();
    for (const reason of ['imported', 'completed', 'legacy_unknown'] as const) {
      const state = initializeUnboundExecution({
        artifactId: uuidv7(),
        operationId: uuidv7(),
        ts: timestamp,
        reason,
      });
      const candidate = { artifactId: state.artifact_id, label: reason, executionState: state };
      const pin = createExecutionPin({ ...context, state, pinnedAt: timestamp });
      expect(
        assessExecutionFocus({ ...context, pin: { status: 'present', pin }, candidate })
      ).toEqual({ valid: true, reason: null });
      expect(assessExecutionEligibility({ candidate, gitContext: context.gitContext }).valid).toBe(
        false
      );
      const selected = selectExecutionArtifact({
        ...context,
        pin: { status: 'present', pin },
        candidates: [candidate],
        complete: true,
      });
      expect(selected).toMatchObject({
        selected: null,
        error: 'NO_ELIGIBLE_ARTIFACT',
        focus: { valid: true },
      });
    }
  });

  it('requires explicit targets to succeed without silently selecting another artifact', () => {
    const { context, candidate, pin } = fixture();
    const selected = selectExecutionArtifact({
      ...context,
      candidates: [candidate],
      pin: { status: 'present', pin },
      explicitArtifactId: uuidv7(),
      complete: true,
    });
    expect(selected).toMatchObject({ selected: null, error: 'EXPLICIT_ARTIFACT_UNAVAILABLE' });
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'absent' },
        explicitArtifactId: candidate.artifactId,
        complete: false,
      })
    ).toMatchObject({ selected: candidate, source: 'explicit' });
  });

  it('uses a valid pin before unique fallback and discloses a stale pin', () => {
    const { context, state, candidate, pin } = fixture();
    const anotherState = initializeCapturedExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      context: state.current_binding!,
      ts: timestamp,
    });
    const another = {
      artifactId: anotherState.artifact_id,
      label: 'Second task',
      executionState: anotherState,
    };
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate, another],
        pin: { status: 'present', pin },
        complete: true,
      })
    ).toMatchObject({ selected: candidate, source: 'pin' });
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'present', pin: { ...pin, binding_generation: 0 } },
        complete: true,
      })
    ).toMatchObject({
      selected: candidate,
      source: 'unique',
      focus: { valid: false, reason: 'PIN_BINDING_CHANGED' },
    });
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'unavailable', reason: 'PIN_MALFORMED' },
        complete: true,
      })
    ).toMatchObject({ source: 'unique', focus: { valid: false, reason: 'PIN_MALFORMED' } });
  });

  it('returns labelled ambiguity and refuses an incomplete inferred selection', () => {
    const { context, candidate, state } = fixture();
    const other = initializeCapturedExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      context: state.current_binding!,
      ts: timestamp,
    });
    const candidates = [
      candidate,
      { artifactId: other.artifact_id, label: 'Other task', executionState: other },
    ];
    const result = selectExecutionArtifact({
      ...context,
      candidates,
      pin: { status: 'absent' },
      complete: true,
    });
    expect(result).toMatchObject({ selected: null, error: 'AMBIGUOUS_ARTIFACT' });
    expect(result.candidates.map((entry) => entry.label)).toEqual(['Authored work', 'Other task']);
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'absent' },
        complete: false,
      }).error
    ).toBe('HISTORY_SELECTION_INCOMPLETE');
  });

  it('invalidates branch switches while preserving ordinary same-branch commits', () => {
    const { context, candidate, pin } = fixture();
    const advanced = {
      ...context,
      gitContext: { ...context.gitContext!, headOid: '2'.repeat(40) },
    };
    expect(
      assessExecutionFocus({ ...advanced, pin: { status: 'present', pin }, candidate }).valid
    ).toBe(true);
    expect(assessExecutionEligibility({ ...advanced, candidate }).valid).toBe(true);
    const switched = { ...advanced, gitContext: { ...advanced.gitContext, branch: 'other' } };
    expect(
      assessExecutionFocus({ ...switched, pin: { status: 'present', pin }, candidate }).reason
    ).toBe('PIN_CONTEXT_CHANGED');
    expect(assessExecutionEligibility({ ...switched, candidate }).reason).toBe(
      'EXECUTION_CONTEXT_CHANGED'
    );
  });

  it('requires an explicit target or contextual pin in detached HEAD', () => {
    const { context } = fixture();
    context.gitContext!.branch = null;
    const state = initializeCapturedExecution({
      artifactId: uuidv7(),
      operationId: uuidv7(),
      context: bindingFromGitContext(context.gitContext!),
      ts: timestamp,
    });
    const candidate = {
      artifactId: state.artifact_id,
      label: 'Detached work',
      executionState: state,
    };
    const pin = createExecutionPin({ ...context, state, pinnedAt: timestamp });
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'absent' },
        complete: true,
      }).error
    ).toBe('DETACHED_HEAD_REQUIRES_SELECTION');
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'present', pin },
        complete: true,
      }).source
    ).toBe('pin');
    expect(
      selectExecutionArtifact({
        ...context,
        candidates: [candidate],
        pin: { status: 'absent' },
        complete: true,
        explicitArtifactId: state.artifact_id,
      }).source
    ).toBe('explicit');
    context.gitContext!.headOid = '2'.repeat(40);
    expect(
      assessExecutionFocus({ ...context, candidate, pin: { status: 'present', pin } }).reason
    ).toBe('PIN_CONTEXT_CHANGED');
  });

  it('rejects pins crossing authority, repository, worktree or session contexts', () => {
    const { context, candidate, pin } = fixture();
    for (const changed of [
      { ...context, authority: { ...context.authority, rootKey: historyRootKey('/other') } },
      { ...context, authority: { ...context.authority, projectId: uuidv7() } },
      { ...context, authority: { ...context.authority, storeInstanceId: uuidv7() } },
      { ...context, gitContext: { ...context.gitContext!, repositoryInstanceId: uuidv7() } },
      { ...context, gitContext: { ...context.gitContext!, worktreeId: uuidv7() } },
      { ...context, gitContext: null },
      { ...context, shellKey: { kind: 'codex_session' as const, value: 'session-two' } },
    ])
      expect(
        assessExecutionFocus({ ...changed, candidate, pin: { status: 'present', pin } }).valid
      ).toBe(false);
  });

  it('disqualifies stale sessions after handoff and completion', () => {
    const { context, state, candidate, pin } = fixture();
    for (const action of ['handoff', 'completed'] as const) {
      const next = prepareExecutionTransition({
        state,
        operationId: uuidv7(),
        expectedGeneration: 1,
        expectedBinding: state.current_binding,
        action,
        target:
          action === 'handoff' ? { ...state.current_binding!, worktree_id: uuidv7() } : undefined,
        openCheckpointIds: [],
        ts: timestamp,
      }).executionState;
      const changed = { ...candidate, executionState: next };
      expect(
        assessExecutionFocus({ ...context, candidate: changed, pin: { status: 'present', pin } })
          .reason
      ).toBe('PIN_BINDING_CHANGED');
      expect(
        assessExecutionEligibility({ candidate: changed, gitContext: context.gitContext }).valid
      ).toBe(false);
    }
  });

  it('retains existing shell key precedence and session disambiguation', () => {
    expect(
      resolveShellKey({
        env: {
          CLAUDE_SESSION_ID: 'a',
          CLAUDE_CODE_SESSION_ID: 'b',
          CODEX_SESSION_ID: 'c',
          TMUX_PANE: 'd',
        },
      })
    ).toEqual({ kind: 'claude_session', value: 'a' });
    expect(resolveShellKey({ env: { CODEX_SESSION_ID: 'c', TMUX_PANE: 'd' } })).toEqual({
      kind: 'codex_session',
      value: 'c',
    });
    expect(resolveShellKey({ env: { TTY: '/dev/tty' }, ppid: 1 })).not.toEqual(
      resolveShellKey({ env: { TTY: '/dev/tty' }, ppid: 2 })
    );
  });
});
