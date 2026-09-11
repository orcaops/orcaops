import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { CounterSchema, DigestSchema } from './event-integrity.js';
import {
  assertExecutionMutation,
  bindingFromGitContext,
  type ExecutionState,
  readExecutionState,
} from './execution.js';
import { historyPaths } from './paths.js';
import type { GitAdministrativeContext, HistoryAuthority } from './types.js';
import { canonicalJson } from '../events/canonical-json.js';
import { UuidV7Schema } from '../ids/uuidv7.js';
import { type ShellKey, ShellKeySchema } from '../pins/shell-key.js';

export { resolveShellKey } from '../pins/shell-key.js';
export type { ShellKey } from '../pins/shell-key.js';

export interface ExecutionFocusContext {
  authority: HistoryAuthority;
  gitContext: GitAdministrativeContext | null;
  shellKey: ShellKey;
}
export const ExecutionPinSchema = z.strictObject({
  schema_version: z.literal(1),
  artifact_id: UuidV7Schema,
  root_key: DigestSchema,
  project_id: UuidV7Schema,
  store_instance_id: UuidV7Schema,
  repository_instance_id: UuidV7Schema,
  worktree_id: UuidV7Schema,
  shell_key: ShellKeySchema,
  binding_generation: CounterSchema,
  branch: z.string().min(1).nullable(),
  head_sha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  pinned_at: z.string().datetime(),
});
export type ExecutionPin = z.infer<typeof ExecutionPinSchema>;
export type ExecutionPinRead =
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string }
  | { status: 'present'; pin: ExecutionPin };
export interface ExecutionCandidate {
  artifactId: string;
  label: string;
  executionState: unknown;
}
export interface ExecutionAssessment {
  valid: boolean;
  reason: string | null;
}
export interface AssessedExecutionCandidate {
  artifactId: string;
  label: string;
  eligibility: ExecutionAssessment;
}

function code(error: unknown): string {
  return (error as { code?: string }).code ?? 'EXECUTION_RECOVERY_REQUIRED';
}
export function executionFocusStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'orcaops');
}

export function createExecutionPin(
  input: ExecutionFocusContext & {
    state: ExecutionState;
    pinnedAt: string;
  }
): ExecutionPin {
  historyPaths(input.authority);
  const binding = bindingFromGitContext(
    input.gitContext ?? {
      commonDir: '',
      gitDir: '',
      worktreeRoot: '',
      repositoryInstanceId: null,
      worktreeId: null,
      branch: null,
      headOid: null,
    }
  );
  if (input.shellKey.kind === 'none')
    throw new Error('No session shell key is available for focus');
  const state = readExecutionState(input.state);
  return ExecutionPinSchema.parse({
    schema_version: 1,
    artifact_id: state.artifact_id,
    root_key: input.authority.rootKey,
    project_id: input.authority.projectId,
    store_instance_id: input.authority.storeInstanceId,
    repository_instance_id: binding.repository_instance_id,
    worktree_id: binding.worktree_id,
    shell_key: input.shellKey,
    binding_generation: state.binding_generation,
    branch: binding.git_context.branch,
    head_sha: binding.git_context.head_sha,
    pinned_at: input.pinnedAt,
  });
}

export function assessExecutionFocus(
  input: ExecutionFocusContext & {
    pin: ExecutionPinRead;
    candidate: ExecutionCandidate | null;
  }
): ExecutionAssessment {
  if (input.pin.status !== 'present')
    return { valid: false, reason: input.pin.status === 'absent' ? 'NO_FOCUS' : input.pin.reason };
  const parsed = ExecutionPinSchema.safeParse(input.pin.pin);
  if (!parsed.success) return { valid: false, reason: 'PIN_MALFORMED' };
  const pin = parsed.data;
  const { authority, gitContext: git, shellKey } = input;
  if (
    pin.root_key !== authority.rootKey ||
    pin.project_id !== authority.projectId ||
    pin.store_instance_id !== authority.storeInstanceId
  )
    return { valid: false, reason: 'PIN_AUTHORITY_CHANGED' };
  if (!git?.worktreeId || !git.repositoryInstanceId)
    return { valid: false, reason: 'PIN_IDENTITY_UNAVAILABLE' };
  if (pin.worktree_id !== git.worktreeId || pin.repository_instance_id !== git.repositoryInstanceId)
    return { valid: false, reason: 'PIN_WORKTREE_CHANGED' };
  if (shellKey.kind === 'none' || canonicalJson(pin.shell_key) !== canonicalJson(shellKey))
    return { valid: false, reason: 'PIN_SESSION_CHANGED' };
  if (pin.branch !== git.branch || (git.branch === null && pin.head_sha !== git.headOid))
    return { valid: false, reason: 'PIN_CONTEXT_CHANGED' };
  if (!input.candidate || input.candidate.artifactId !== pin.artifact_id)
    return { valid: false, reason: 'PIN_ARTIFACT_UNAVAILABLE' };
  try {
    const state = readExecutionState(input.candidate.executionState, input.candidate.artifactId);
    if (state.binding_generation !== pin.binding_generation)
      return { valid: false, reason: 'PIN_BINDING_CHANGED' };
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: code(error) };
  }
}

export function assessExecutionEligibility(input: {
  candidate: ExecutionCandidate;
  gitContext: GitAdministrativeContext | null;
}): ExecutionAssessment {
  try {
    const state = readExecutionState(input.candidate.executionState, input.candidate.artifactId);
    assertExecutionMutation({
      state,
      expectedGeneration: state.binding_generation,
      context: input.gitContext ? bindingFromGitContext(input.gitContext) : null,
      operation: 'task',
    });
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: code(error) };
  }
}

export interface ExecutionSelection {
  selected: ExecutionCandidate | null;
  source: 'explicit' | 'pin' | 'unique' | null;
  error: string | null;
  focus: ExecutionAssessment;
  candidates: AssessedExecutionCandidate[];
}
export function selectExecutionArtifact(
  input: ExecutionFocusContext & {
    candidates: readonly ExecutionCandidate[];
    pin: ExecutionPinRead;
    explicitArtifactId?: string;
    complete: boolean;
  }
): ExecutionSelection {
  const candidates = input.candidates.map((candidate) => ({
    artifactId: candidate.artifactId,
    label: candidate.label,
    eligibility: assessExecutionEligibility({ candidate, gitContext: input.gitContext }),
  }));
  const pinnedArtifactId = input.pin.status === 'present' ? input.pin.pin.artifact_id : null;
  const pinCandidate =
    input.candidates.find((candidate) => candidate.artifactId === pinnedArtifactId) ?? null;
  const focus = assessExecutionFocus({ ...input, candidate: pinCandidate });
  const result = (
    selected: ExecutionCandidate | null,
    source: ExecutionSelection['source'],
    error: string | null
  ): ExecutionSelection => ({ selected, source, error, focus, candidates });
  if (input.explicitArtifactId !== undefined) {
    const candidate = input.candidates.find(
      (entry) => entry.artifactId === input.explicitArtifactId
    );
    if (!candidate) return result(null, null, 'EXPLICIT_ARTIFACT_UNAVAILABLE');
    const assessment = assessExecutionEligibility({ candidate, gitContext: input.gitContext });
    return assessment.valid
      ? result(candidate, 'explicit', null)
      : result(null, null, assessment.reason);
  }
  if (
    focus.valid &&
    pinCandidate &&
    assessExecutionEligibility({ candidate: pinCandidate, gitContext: input.gitContext }).valid
  )
    return result(pinCandidate, 'pin', null);
  if (!input.complete) return result(null, null, 'HISTORY_SELECTION_INCOMPLETE');
  if (input.gitContext?.branch === null)
    return result(null, null, 'DETACHED_HEAD_REQUIRES_SELECTION');
  const eligible = candidates.filter((candidate) => candidate.eligibility.valid);
  if (eligible.length !== 1)
    return result(null, null, eligible.length ? 'AMBIGUOUS_ARTIFACT' : 'NO_ELIGIBLE_ARTIFACT');
  return result(
    input.candidates.find((candidate) => candidate.artifactId === eligible[0].artifactId)!,
    'unique',
    null
  );
}
