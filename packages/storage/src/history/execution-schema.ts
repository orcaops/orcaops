import { z } from 'zod';

import { CounterSchema, DigestSchema } from './event-integrity.js';
import { UuidV7Schema } from '../ids/uuidv7.js';

export const ExecutionBindingSchema = z.strictObject({
  repository_instance_id: UuidV7Schema,
  worktree_id: UuidV7Schema,
  git_context: z.strictObject({
    head_sha: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    branch: z.string().min(1).nullable(),
  }),
});
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

export const ExecutionCheckpointAttributionSchema = z.strictObject({
  checkpoint_event_id: UuidV7Schema,
  binding_generation: CounterSchema,
  context: ExecutionBindingSchema,
});
export type ExecutionCheckpointAttribution = z.infer<typeof ExecutionCheckpointAttributionSchema>;

export const ExecutionCheckpointRecoverySchema = z.strictObject({
  operation_id: UuidV7Schema,
  checkpoint_event_id: UuidV7Schema,
  takeover_operation_id: UuidV7Schema,
  action: z.enum(['verified_continuation', 'administrative_abandon']),
  reason: z.string().trim().min(1),
});
export type ExecutionCheckpointRecovery = z.infer<typeof ExecutionCheckpointRecoverySchema>;

export const ExecutionActionSchema = z.enum([
  'captured',
  'unbound',
  'first_bind',
  'handoff',
  'context_changed',
  'completed',
  'orphan_recovered',
]);
export const ExecutionTransitionSchema = z.strictObject({
  operation_id: UuidV7Schema,
  payload_hash: DigestSchema,
  ts: z.string().datetime(),
  action: ExecutionActionSchema,
  prior_generation: CounterSchema.nullable(),
  generation: CounterSchema,
  prior_binding: ExecutionBindingSchema.nullable(),
  binding: ExecutionBindingSchema.nullable(),
  reason: z.string().min(1).nullable(),
  checkpoint_ids: z.array(UuidV7Schema),
  previous_recovery_operation_id: UuidV7Schema.nullable().default(null),
});
export type ExecutionTransition = z.infer<typeof ExecutionTransitionSchema>;

export const ExecutionStateSchema = z
  .strictObject({
    schema_version: z.literal(1),
    artifact_id: UuidV7Schema,
    origin_kind: z.enum(['captured', 'git-import']),
    lifecycle: z.enum(['active', 'completed']),
    binding_generation: CounterSchema,
    current_worktree_id: UuidV7Schema.nullable(),
    current_binding: ExecutionBindingSchema.nullable(),
    null_reason: z.enum(['never_bound', 'legacy_unknown', 'imported', 'completed']).nullable(),
    associations: z.array(UuidV7Schema),
    associations_unknown: z.boolean(),
    association_history: z.array(
      z.strictObject({
        repository_instance_id: UuidV7Schema,
        worktree_id: UuidV7Schema,
        first_bound_at: z.string().datetime(),
        operation_id: UuidV7Schema,
        source: ExecutionActionSchema,
      })
    ),
    binding_history: z.array(ExecutionTransitionSchema).min(1),
    checkpoint_execution: z.array(ExecutionCheckpointAttributionSchema).default([]),
    checkpoint_recovery_history: z.array(ExecutionCheckpointRecoverySchema).default([]),
    recovery: z
      .strictObject({
        state: z.literal('required'),
        operation_id: UuidV7Schema,
        takeover_generation: CounterSchema,
        reason: z.string().min(1),
        checkpoint_ids: z.array(UuidV7Schema).min(1),
        verified_checkpoint_ids: z.array(UuidV7Schema),
        abandoned_checkpoint_ids: z.array(UuidV7Schema),
      })
      .nullable(),
  })
  .superRefine((state, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (state.current_worktree_id !== (state.current_binding?.worktree_id ?? null))
      problem('Current worktree differs from binding');
    if ((state.current_binding === null) !== (state.null_reason !== null))
      problem('Null binding requires a truthful reason');
    if (
      state.lifecycle === 'completed' &&
      (state.current_binding !== null || state.null_reason !== 'completed')
    )
      problem('Completed execution must be unbound');
    if (state.null_reason === 'completed' && state.lifecycle !== 'completed')
      problem('Completed reason differs from execution lifecycle');
    if (state.origin_kind === 'git-import' && state.current_binding !== null)
      problem('Imported history cannot own execution');
    if (new Set(state.associations).size !== state.associations.length)
      problem('Associations are duplicated');
    if (
      new Set(state.association_history.map((entry) => entry.worktree_id)).size !==
      state.association_history.length
    )
      problem('Association history is duplicated');
    if (
      state.associations.some(
        (id) => !state.association_history.some((entry) => entry.worktree_id === id)
      ) ||
      state.association_history.some((entry) => !state.associations.includes(entry.worktree_id))
    )
      problem('Association history differs from retained identities');
    if (state.current_binding && !state.associations.includes(state.current_binding.worktree_id))
      problem('Current owner has no retained association');
    const operations = new Set<string>();
    for (let index = 0; index < state.binding_history.length; index++) {
      const entry = state.binding_history[index];
      if (operations.has(entry.operation_id)) problem('Execution operation is duplicated');
      operations.add(entry.operation_id);
      if (entry.previous_recovery_operation_id) {
        const previous = state.binding_history
          .slice(0, index)
          .find((prior) => prior.operation_id === entry.previous_recovery_operation_id);
        if (
          entry.action !== 'orphan_recovered' ||
          !previous ||
          !['first_bind', 'orphan_recovered'].includes(previous.action) ||
          entry.prior_generation !== previous.generation ||
          entry.checkpoint_ids.some((id) => !previous.checkpoint_ids.includes(id))
        )
          problem('Chained takeover differs from its prior recovery');
      }
      if (index === 0) {
        if (entry.prior_generation !== null || !['captured', 'unbound'].includes(entry.action))
          problem('Execution history has no initialization');
        if (
          entry.prior_binding !== null ||
          (entry.action === 'captured'
            ? entry.generation !== 1 || entry.binding === null
            : entry.generation !== 0 || entry.binding !== null)
        )
          problem('Initial execution generation differs from its ownership');
      } else if (
        entry.prior_generation !== state.binding_history[index - 1].generation ||
        entry.generation !== entry.prior_generation + 1 ||
        JSON.stringify(entry.prior_binding) !==
          JSON.stringify(state.binding_history[index - 1].binding)
      )
        problem('Binding generation history is discontinuous');
    }
    const latest = state.binding_history.at(-1)!;
    if (
      latest.generation !== state.binding_generation ||
      JSON.stringify(latest.binding) !== JSON.stringify(state.current_binding)
    )
      problem('Current execution differs from its history');
    if (
      new Set(state.checkpoint_execution.map((entry) => entry.checkpoint_event_id)).size !==
      state.checkpoint_execution.length
    )
      problem('Checkpoint execution attribution is duplicated');
    for (const entry of state.checkpoint_execution) {
      const binding = state.binding_history.find(
        (transition) => transition.generation === entry.binding_generation
      )?.binding;
      if (
        !binding ||
        binding.worktree_id !== entry.context.worktree_id ||
        binding.repository_instance_id !== entry.context.repository_instance_id ||
        binding.git_context.branch !== entry.context.git_context.branch ||
        (binding.git_context.branch === null &&
          binding.git_context.head_sha !== entry.context.git_context.head_sha)
      )
        problem('Checkpoint attribution differs from its recorded execution generation');
    }
    const recoveryOperations = new Set<string>();
    for (const entry of state.checkpoint_recovery_history) {
      if (operations.has(entry.operation_id) || recoveryOperations.has(entry.operation_id))
        problem('Checkpoint recovery operation is duplicated');
      recoveryOperations.add(entry.operation_id);
      const takeover = state.binding_history.find(
        (transition) => transition.operation_id === entry.takeover_operation_id
      );
      if (
        !takeover ||
        !['first_bind', 'orphan_recovered'].includes(takeover.action) ||
        !takeover.checkpoint_ids.includes(entry.checkpoint_event_id)
      )
        problem('Checkpoint recovery outcome has no matching takeover');
    }
    for (const takeover of state.binding_history.filter(
      (entry) =>
        ['first_bind', 'orphan_recovered'].includes(entry.action) && entry.checkpoint_ids.length
    )) {
      const successors = new Set([takeover.operation_id]);
      for (const entry of state.binding_history)
        if (
          entry.previous_recovery_operation_id &&
          successors.has(entry.previous_recovery_operation_id)
        )
          successors.add(entry.operation_id);
      const outcomes = state.checkpoint_recovery_history.filter((entry) =>
        successors.has(entry.takeover_operation_id)
      );
      const latestOutcomes = new Map(
        outcomes.map((entry) => [entry.checkpoint_event_id, entry.action])
      );
      const unresolved = takeover.checkpoint_ids.filter((id) => !latestOutcomes.has(id));
      if (
        unresolved.length &&
        (!state.recovery ||
          !successors.has(state.recovery.operation_id) ||
          unresolved.some((id) => !state.recovery!.checkpoint_ids.includes(id)))
      )
        problem('Unresolved checkpoint takeover has no active recovery');
      if (state.recovery?.operation_id === takeover.operation_id) {
        const verified = takeover.checkpoint_ids.filter(
          (id) => latestOutcomes.get(id) === 'verified_continuation'
        );
        const abandoned = takeover.checkpoint_ids.filter(
          (id) => latestOutcomes.get(id) === 'administrative_abandon'
        );
        if (
          canonicalSet(verified) !== canonicalSet(state.recovery.verified_checkpoint_ids) ||
          canonicalSet(abandoned) !== canonicalSet(state.recovery.abandoned_checkpoint_ids)
        )
          problem('Recovery checkpoint status differs from retained outcomes');
      }
    }
    if (state.recovery) {
      if (
        !state.current_binding ||
        state.lifecycle !== 'active' ||
        state.recovery.takeover_generation !== state.binding_generation
      )
        problem('Recovery does not belong to the active binding');
      const ids = state.recovery.checkpoint_ids;
      const verified = state.recovery.verified_checkpoint_ids;
      const abandoned = state.recovery.abandoned_checkpoint_ids;
      const takeover = state.binding_history.find(
        (entry) => entry.operation_id === state.recovery!.operation_id
      );
      if (
        !takeover ||
        !['first_bind', 'orphan_recovered'].includes(takeover.action) ||
        takeover.generation !== state.recovery.takeover_generation ||
        (takeover.action === 'orphan_recovered' && takeover.reason !== state.recovery.reason) ||
        JSON.stringify(takeover.checkpoint_ids) !== JSON.stringify(ids)
      )
        problem('Recovery differs from its retained takeover');
      if (
        new Set(ids).size !== ids.length ||
        new Set(verified).size !== verified.length ||
        new Set(abandoned).size !== abandoned.length ||
        verified.some((id) => !ids.includes(id) || abandoned.includes(id)) ||
        abandoned.some((id) => !ids.includes(id))
      )
        problem('Recovery checkpoint identities are inconsistent');
    }
  });
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

function canonicalSet(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}
