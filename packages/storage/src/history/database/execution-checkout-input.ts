import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { CounterSchema, digest, DigestSchema } from '../event-integrity.js';
import { ExecutionPinSchema } from '../execution-focus.js';
import { ExecutionBindingSchema } from '../execution-schema.js';
import { type ArtifactRevision, copyArtifactRevision } from './artifacts.js';
import { ProjectDatabaseError } from './errors.js';
import { type ProjectFocusScope, projectFocusScopeJson } from './execution-focus-input.js';

const positive = CounterSchema.refine((value) => value > 0);
export const CheckoutFocusRecipeSchema = z.strictObject({
  operationId: UuidV7Schema,
  scope: z
    .custom<ProjectFocusScope>()
    .transform((value) => JSON.parse(projectFocusScopeJson(value)) as ProjectFocusScope),
  expectedSelection: z.strictObject({ operationId: UuidV7Schema, version: positive }).nullable(),
  pinnedAt: z.string().datetime(),
  pinHash: DigestSchema,
});
export const CheckoutPayloadSchema = z.strictObject({
  action: z.enum(['first_bind', 'handoff', 'context_changed', 'orphan_recovered']),
  target: ExecutionBindingSchema,
  expectedBinding: ExecutionBindingSchema.nullable(),
  reason: z.string().nullable(),
  ts: z.string().datetime(),
  focus: CheckoutFocusRecipeSchema,
});
export const CheckoutExpectedSchema = z.strictObject({
  revision: z.custom<ArtifactRevision>().transform(copyArtifactRevision),
  version: positive,
  generation: CounterSchema,
});
export const CheckoutResultSchema = z.strictObject({
  artifactId: UuidV7Schema,
  executionVersion: positive,
  bindingGeneration: positive,
  focusOperationId: UuidV7Schema,
});
export type CheckoutFocusRecipe = z.infer<typeof CheckoutFocusRecipeSchema>;
export interface ProjectExecutionCheckoutInput {
  operationId: string;
  artifactId: string;
  payload: z.infer<typeof CheckoutPayloadSchema>;
  expected: z.infer<typeof CheckoutExpectedSchema>;
  secretAllow: readonly string[];
}
export function reconstructCheckoutPin(
  artifactId: string,
  payload: z.infer<typeof CheckoutPayloadSchema>,
  generation: number
): Buffer {
  const { scope, pinnedAt } = payload.focus;
  if (
    scope.repositoryInstanceId !== payload.target.repository_instance_id ||
    scope.worktreeId !== payload.target.worktree_id
  )
    throw new ProjectDatabaseError(
      'IDENTITY_CONFLICT',
      'The original focus slot and binding target disagree'
    );
  const pin = ExecutionPinSchema.parse({
    schema_version: 1,
    artifact_id: artifactId,
    root_key: scope.rootKey,
    project_id: scope.projectId,
    store_instance_id: scope.storeInstanceId,
    repository_instance_id: scope.repositoryInstanceId,
    worktree_id: scope.worktreeId,
    shell_key: scope.shellKey,
    binding_generation: generation,
    branch: payload.target.git_context.branch,
    head_sha: payload.target.git_context.head_sha,
    pinned_at: pinnedAt,
  });
  return Buffer.from(canonicalJson(pin));
}
export function assertCheckoutPinHash(
  input: Pick<ProjectExecutionCheckoutInput, 'artifactId' | 'payload' | 'expected'>
): Buffer {
  const bytes = reconstructCheckoutPin(
    input.artifactId,
    input.payload,
    input.expected.generation + 1
  );
  if (digest(bytes) !== input.payload.focus.pinHash)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original checkout focus recipe does not reconstruct its retained pin hash; preserve history for explicit repair'
    );
  return bytes;
}
