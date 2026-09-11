import { digest } from './event-integrity.js';
import {
  type ExecutionBinding,
  ExecutionBindingSchema,
  type ExecutionState,
  ExecutionStateSchema,
  type ExecutionTransition,
} from './execution-schema.js';
import { HistoryPersistenceError } from './persistence-error.js';
import type { GitAdministrativeContext } from './types.js';
import { canonicalJson } from '../events/canonical-json.js';

export * from './execution-schema.js';

function reject(code: string, message: string): never {
  throw new HistoryPersistenceError(code, message);
}

export function bindingFromGitContext(context: GitAdministrativeContext): ExecutionBinding {
  if (!context.repositoryInstanceId || !context.worktreeId)
    reject(
      'IDENTITY_RECOVERY_REQUIRED',
      'Execution requires established Git administrative identity'
    );
  return ExecutionBindingSchema.parse({
    repository_instance_id: context.repositoryInstanceId,
    worktree_id: context.worktreeId,
    git_context: { head_sha: context.headOid, branch: context.branch },
  });
}

export function readExecutionState(value: unknown, artifactId?: string): ExecutionState {
  const parsed = ExecutionStateSchema.safeParse(value);
  if (!parsed.success || (artifactId !== undefined && parsed.data.artifact_id !== artifactId))
    reject(
      'EXECUTION_RECOVERY_REQUIRED',
      'Witnessed execution state is unavailable or inconsistent'
    );
  return parsed.data;
}

function initial(input: {
  artifactId: string;
  operationId: string;
  ts: string;
  binding: ExecutionBinding | null;
  reason: ExecutionState['null_reason'];
  origin: ExecutionState['origin_kind'];
}): ExecutionState {
  const binding = input.binding === null ? null : ExecutionBindingSchema.parse(input.binding);
  const generation = binding ? 1 : 0;
  const transition: ExecutionTransition = {
    operation_id: input.operationId,
    payload_hash: digest(canonicalJson(input)),
    ts: input.ts,
    action: binding ? 'captured' : 'unbound',
    prior_generation: null,
    generation,
    prior_binding: null,
    binding,
    reason: input.reason,
    checkpoint_ids: [],
    previous_recovery_operation_id: null,
  };
  return ExecutionStateSchema.parse({
    schema_version: 1,
    artifact_id: input.artifactId,
    origin_kind: input.origin,
    lifecycle: input.reason === 'completed' ? 'completed' : 'active',
    binding_generation: generation,
    current_worktree_id: binding?.worktree_id ?? null,
    current_binding: binding,
    null_reason: input.reason,
    associations: binding ? [binding.worktree_id] : [],
    associations_unknown: input.reason === 'legacy_unknown' || input.origin === 'git-import',
    association_history: binding
      ? [
          {
            repository_instance_id: binding.repository_instance_id,
            worktree_id: binding.worktree_id,
            first_bound_at: input.ts,
            operation_id: input.operationId,
            source: 'captured',
          },
        ]
      : [],
    binding_history: [transition],
    recovery: null,
  });
}

export function initializeCapturedExecution(input: {
  artifactId: string;
  operationId: string;
  context: ExecutionBinding;
  ts: string;
}): ExecutionState {
  return initial({ ...input, binding: input.context, reason: null, origin: 'captured' });
}

export function initializeUnboundExecution(input: {
  artifactId: string;
  operationId: string;
  reason: NonNullable<ExecutionState['null_reason']>;
  ts: string;
  origin?: ExecutionState['origin_kind'];
}): ExecutionState {
  return initial({
    ...input,
    binding: null,
    origin: input.origin ?? (input.reason === 'imported' ? 'git-import' : 'captured'),
  });
}

export interface ExecutionTransitionInput {
  state: ExecutionState;
  operationId: string;
  expectedGeneration: number;
  expectedBinding: ExecutionBinding | null;
  action: 'first_bind' | 'handoff' | 'context_changed' | 'completed' | 'orphan_recovered';
  target?: ExecutionBinding;
  reason?: string;
  openCheckpointIds: readonly string[];
  ts: string;
}

export interface PreparedExecutionTransition {
  executionState: ExecutionState;
  expectedBindingGeneration: number;
  transition: ExecutionTransition;
  replayed: boolean;
}

export function prepareExecutionTransition(
  input: ExecutionTransitionInput
): PreparedExecutionTransition {
  const state = readExecutionState(input.state);
  const { state: _state, ...intent } = input;
  const payloadHash = digest(canonicalJson({ artifactId: state.artifact_id, ...intent }));
  const prior = state.binding_history.find((entry) => entry.operation_id === input.operationId);
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      reject('IDEMPOTENCY_CONFLICT', 'Execution operation ID has another intent');
    return {
      executionState: state,
      expectedBindingGeneration: input.expectedGeneration,
      transition: prior,
      replayed: true,
    };
  }
  if (state.binding_generation !== input.expectedGeneration)
    reject('STALE_BINDING_GENERATION', 'Execution binding generation changed');
  if (canonicalJson(state.current_binding) !== canonicalJson(input.expectedBinding))
    reject('EXECUTION_OWNER_CHANGED', 'Execution owner changed');
  if (state.lifecycle === 'completed')
    reject('ARTIFACT_COMPLETED', 'Completed execution cannot be rebound or implicitly reopened');
  if (state.origin_kind === 'git-import' && input.action !== 'completed')
    reject('IMPORTED_READ_ONLY', 'Imported history cannot own ongoing execution');
  if (state.recovery && input.action !== 'orphan_recovered')
    reject(
      'EXECUTION_RECOVERY_REQUIRED',
      'Outstanding checkpoint recovery must finish before another binding transition'
    );
  const target = input.action === 'completed' ? null : ExecutionBindingSchema.parse(input.target);
  const old = state.current_binding;
  const checkpoints = [...new Set(input.openCheckpointIds)];
  if (checkpoints.length !== input.openCheckpointIds.length)
    reject('INVALID_INPUT', 'Checkpoint identities are duplicated');
  if (state.recovery) {
    const unresolved = state.recovery.checkpoint_ids.filter(
      (id) =>
        !state.recovery!.verified_checkpoint_ids.includes(id) &&
        !state.recovery!.abandoned_checkpoint_ids.includes(id)
    );
    if (canonicalJson([...unresolved].sort()) !== canonicalJson([...checkpoints].sort()))
      reject(
        'EXECUTION_RECOVERY_REQUIRED',
        'Chained takeover must preserve every unresolved open checkpoint'
      );
  }
  if (input.action === 'first_bind') {
    if (old !== null) reject('ALREADY_BOUND', 'First binding requires an unbound artifact');
  } else if (input.action !== 'completed') {
    if (old === null) reject('EXECUTION_UNBOUND', 'This transition requires an established owner');
    if (target!.repository_instance_id !== old.repository_instance_id)
      reject('IDENTITY_CONFLICT', 'Execution cannot move between unrelated repository instances');
    if (input.action === 'context_changed') {
      if (target!.worktree_id !== old.worktree_id)
        reject('INVALID_HANDOFF', 'A context change cannot move execution to another worktree');
      if (canonicalJson(target) === canonicalJson(old))
        reject('EXECUTION_UNCHANGED', 'Execution context is unchanged');
    } else if (target!.worktree_id === old.worktree_id)
      reject('ALREADY_BOUND_HERE', 'Execution is already bound to this worktree');
  }
  if (checkpoints.length && ['handoff', 'context_changed', 'completed'].includes(input.action))
    reject('OPEN_CHECKPOINTS', 'Open checkpoints prevent ordinary handoff or completion');
  if (input.action === 'orphan_recovered' && !input.reason?.trim())
    reject('RECOVERY_REASON_REQUIRED', 'Orphan recovery requires an explicit reason');
  const generation = state.binding_generation + 1;
  const transition: ExecutionTransition = {
    operation_id: input.operationId,
    payload_hash: payloadHash,
    ts: input.ts,
    action: input.action,
    prior_generation: state.binding_generation,
    generation,
    prior_binding: old,
    binding: target,
    reason: input.reason?.trim() || null,
    checkpoint_ids: checkpoints,
    previous_recovery_operation_id: state.recovery?.operation_id ?? null,
  };
  const next = structuredClone(state);
  next.binding_generation = generation;
  next.current_binding = target;
  next.current_worktree_id = target?.worktree_id ?? null;
  next.null_reason = target ? null : 'completed';
  if (!target) next.lifecycle = 'completed';
  next.binding_history.push(transition);
  if (target && !next.associations.includes(target.worktree_id)) {
    next.associations.push(target.worktree_id);
    next.association_history.push({
      repository_instance_id: target.repository_instance_id,
      worktree_id: target.worktree_id,
      first_bound_at: input.ts,
      operation_id: input.operationId,
      source: input.action,
    });
  }
  if (checkpoints.length)
    next.recovery = {
      state: 'required',
      operation_id: input.operationId,
      takeover_generation: generation,
      reason: transition.reason ?? 'First binding requires verification of existing checkpoints',
      checkpoint_ids: checkpoints,
      verified_checkpoint_ids: [],
      abandoned_checkpoint_ids: [],
    };
  return {
    executionState: ExecutionStateSchema.parse(next),
    expectedBindingGeneration: input.expectedGeneration,
    transition,
    replayed: false,
  };
}

export function assertExecutionMutation(input: {
  state: ExecutionState;
  expectedGeneration: number;
  context: ExecutionBinding | null;
  operation:
    | 'task'
    | 'summary_amendment'
    | 'historical_maintenance'
    | 'administrative_abandon'
    | 'recovery_continuation';
  explicitTarget?: boolean;
}): void {
  const state = readExecutionState(input.state);
  if (state.binding_generation !== input.expectedGeneration)
    reject('STALE_BINDING_GENERATION', 'Execution binding generation changed');
  if (input.operation === 'summary_amendment' || input.operation === 'historical_maintenance') {
    if (!input.explicitTarget)
      reject('EXPLICIT_ARTIFACT_REQUIRED', 'Historical mutation requires an explicit artifact');
    if (input.operation === 'summary_amendment' && state.lifecycle !== 'completed')
      reject('ARTIFACT_NOT_COMPLETED', 'Summary amendment requires completed execution');
    if (state.lifecycle !== 'completed' && state.origin_kind !== 'git-import')
      reject(
        'TASK_ELIGIBILITY_REQUIRED',
        'Active authored work requires its current execution owner'
      );
    return;
  }
  if (state.lifecycle !== 'active')
    reject('ARTIFACT_COMPLETED', 'Completed history is read-only for task execution');
  if (state.origin_kind === 'git-import')
    reject('IMPORTED_READ_ONLY', 'Imported history is read-only for task execution');
  if (!state.current_binding || !input.context)
    reject('EXECUTION_UNBOUND', 'Task mutation requires a current execution owner');
  const current = ExecutionBindingSchema.parse(input.context);
  if (
    state.current_binding.repository_instance_id !== current.repository_instance_id ||
    state.current_binding.worktree_id !== current.worktree_id
  )
    reject('EXECUTION_BOUND_ELSEWHERE', 'Task execution belongs to another worktree');
  if (
    state.current_binding.git_context.branch !== current.git_context.branch ||
    (current.git_context.branch === null &&
      state.current_binding.git_context.head_sha !== current.git_context.head_sha)
  )
    reject(
      'EXECUTION_CONTEXT_CHANGED',
      'Execution branch changed; explicit checkout validation is required'
    );
  if (state.recovery && input.operation === 'task')
    reject(
      'EXECUTION_RECOVERY_REQUIRED',
      'Original checkpoint evidence must be verified or administratively abandoned'
    );
}

export function recordExecutionCheckpointOpen(input: {
  state: ExecutionState;
  checkpointEventId: string;
  expectedGeneration: number;
  context: ExecutionBinding;
}): ExecutionState {
  const state = readExecutionState(input.state);
  assertExecutionMutation({
    state,
    expectedGeneration: input.expectedGeneration,
    context: input.context,
    operation: 'task',
  });
  const entry = {
    checkpoint_event_id: input.checkpointEventId,
    binding_generation: input.expectedGeneration,
    context: ExecutionBindingSchema.parse(input.context),
  };
  const prior = state.checkpoint_execution.find(
    (value) => value.checkpoint_event_id === input.checkpointEventId
  );
  if (prior) {
    if (canonicalJson(prior) !== canonicalJson(entry))
      reject('IDEMPOTENCY_CONFLICT', 'Checkpoint execution attribution is immutable');
    return state;
  }
  return ExecutionStateSchema.parse({
    ...state,
    checkpoint_execution: [...state.checkpoint_execution, entry],
  });
}

export function prepareExecutionCheckpointRecovery(input: {
  state: ExecutionState;
  operationId: string;
  checkpointEventId: string;
  action: 'verified_continuation' | 'administrative_abandon';
  reason: string;
}): ExecutionState {
  const state = readExecutionState(input.state);
  if (!input.reason.trim())
    reject('RECOVERY_REASON_REQUIRED', 'Checkpoint recovery requires a recorded reason');
  const prior = state.checkpoint_recovery_history.find(
    (entry) => entry.operation_id === input.operationId
  );
  if (prior) {
    if (
      prior.checkpoint_event_id !== input.checkpointEventId ||
      prior.action !== input.action ||
      prior.reason !== input.reason.trim()
    )
      reject('IDEMPOTENCY_CONFLICT', 'Checkpoint recovery operation has different intent');
    return state;
  }
  const recovery = state.recovery;
  if (!recovery || !recovery.checkpoint_ids.includes(input.checkpointEventId))
    reject('CHECKPOINT_RECOVERY_UNAVAILABLE', 'Checkpoint does not belong to the current recovery');
  if (recovery.abandoned_checkpoint_ids.includes(input.checkpointEventId))
    reject('CHECKPOINT_ABANDONED', 'Administratively abandoned checkpoints cannot continue');
  if (
    input.action === 'verified_continuation' &&
    recovery.verified_checkpoint_ids.includes(input.checkpointEventId)
  )
    return state;
  const next = structuredClone(state);
  next.checkpoint_recovery_history.push({
    operation_id: input.operationId,
    checkpoint_event_id: input.checkpointEventId,
    takeover_operation_id: recovery.operation_id,
    action: input.action,
    reason: input.reason.trim(),
  });
  if (input.action === 'verified_continuation')
    next.recovery!.verified_checkpoint_ids.push(input.checkpointEventId);
  else {
    next.recovery!.verified_checkpoint_ids = next.recovery!.verified_checkpoint_ids.filter(
      (id) => id !== input.checkpointEventId
    );
    next.recovery!.abandoned_checkpoint_ids.push(input.checkpointEventId);
  }
  if (
    next.recovery!.checkpoint_ids.every(
      (id) =>
        next.recovery!.verified_checkpoint_ids.includes(id) ||
        next.recovery!.abandoned_checkpoint_ids.includes(id)
    )
  )
    next.recovery = null;
  return ExecutionStateSchema.parse(next);
}
