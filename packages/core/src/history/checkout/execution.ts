import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson, uuidv7 } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  type ProjectOperationResult,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import {
  assertCheckoutPinHash,
  type PreparedProjectExecutionCheckout,
  prepareProjectExecutionCheckout,
  prepareProjectFocus,
  prepareProjectFocusRead,
  type ProjectExecutionCheckoutInput,
  projectExecutionCheckoutRequest,
  type ProjectFocusChange,
  type ProjectFocusPublication,
  type ProjectFocusScope,
  projectFocusScopeJson,
  publishProjectExecutionCheckout,
  publishProjectExecutionFocus,
  readProjectExecutionCheckout,
  readProjectExecutionFocus,
  readProjectExecutionFocusOperation,
  reconstructCheckoutPin,
  replayProjectExecutionCheckout,
} from '@orcaops/storage/history/database/execution-checkout';
import { type ExecutionBinding, ExecutionBindingSchema } from '@orcaops/storage/history/execution';
import { createExecutionPin, type ShellKey } from '@orcaops/storage/history/execution-focus';

import { copyDatabaseAuthoredValue, refuseDatabaseAuthoredSecrets } from '../authored-input.js';
import { observeCheckoutOwnerAbsence } from './orphan.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';

export type DatabaseCheckoutInput = { shellKey: ShellKey; secretAllow: readonly string[] } & (
  | { action: 'clear' }
  | { action: 'replay'; operationId: string }
  | {
      action: 'set';
      artifactId: string;
      expectedRevision: ArtifactRevision;
      expectedExecutionVersion: number;
      expectedBindingGeneration: number;
      expectedBinding: ExecutionBinding | null;
      handoff?: boolean;
      recoverOrphaned?: boolean;
      reason?: string;
    }
);
const id = z.string().uuid({ version: 'v7' });
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = z.strictObject({
  generation: counter.min(1),
  orderedHash: z.string().regex(/^[0-9a-f]{64}$/),
  eventCount: counter.min(1),
  byteLength: counter.min(1),
  tailEventId: id,
});
const common = { shellKey: z.custom<ShellKey>(), secretAllow: z.array(z.string()) };
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('clear') }),
  z.strictObject({ ...common, action: z.literal('replay'), operationId: id }),
  z.strictObject({
    ...common,
    action: z.literal('set'),
    artifactId: id,
    expectedRevision: revision,
    expectedExecutionVersion: counter.min(1),
    expectedBindingGeneration: counter,
    expectedBinding: ExecutionBindingSchema.nullable(),
    handoff: z.boolean().optional(),
    recoverOrphaned: z.boolean().optional(),
    reason: z.string().optional(),
  }),
]);
export interface PreparedDatabaseCheckout {
  readonly kind: 'prepared-database-checkout';
}
type CheckoutReceipt = NonNullable<ReturnType<typeof readProjectExecutionCheckout>>;
type FocusReceipt = NonNullable<ReturnType<typeof readProjectExecutionFocusOperation>>;
interface Preparation {
  context: RegisteredDatabaseContext;
  secretAllow: readonly string[];
  focus: ProjectFocusChange;
  artifactId: string | null;
  checkout: PreparedProjectExecutionCheckout | null;
  originalCheckout: CheckoutReceipt | null;
  originalFocus: FocusReceipt | null;
  orphan: { ownerId: string; observation: string } | null;
  options: ProjectOperationOptions;
}
export interface DatabaseCheckoutResult {
  operationId: string;
  artifactId: string | null;
  binding: ProjectOperationResult<{
    artifactId: string;
    executionVersion: number;
    bindingGeneration: number;
    focusOperationId: string;
  }> | null;
  focus:
    | {
        state: 'updated' | 'cleared';
        operationId: string;
        publication: ProjectOperationResult<ProjectFocusPublication>;
        error: null;
      }
    | { state: 'failed'; operationId: string; publication: null; error: ProjectDatabaseError };
}
const preparedRequests = new WeakMap<PreparedDatabaseCheckout, Preparation>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Execution checkout cancelled before its next publication'
    );
}
function stale(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The exact original artifact, execution or focus selection changed; choose an explicitly new checkout request'
  );
}
function assertAuthority(
  handle: ProjectDatabase,
  context: RegisteredDatabaseContext,
  scope: ProjectFocusScope
) {
  projectFocusScopeJson(scope);
  prepareProjectFocusRead(handle, scope);
  if (!isDeepStrictEqual(handle.authority, context.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the original registered project store for execution checkout'
    );
}
function scopeFor(context: RegisteredDatabaseContext, shellKey: ShellKey): ProjectFocusScope {
  const scope = {
    rootKey: context.authority.rootKey,
    projectId: context.authority.projectId,
    storeInstanceId: context.authority.storeInstanceId,
    repositoryInstanceId: context.authority.repositoryInstanceId,
    worktreeId: context.git.worktreeId!,
    shellKey,
  };
  projectFocusScopeJson(scope as ProjectFocusScope);
  return scope as ProjectFocusScope;
}
function save(value: Preparation): PreparedDatabaseCheckout {
  const token = Object.freeze({ kind: 'prepared-database-checkout' as const });
  preparedRequests.set(token, value);
  return token;
}
function copyInput(raw: DatabaseCheckoutInput) {
  try {
    return inputSchema.parse(copyDatabaseAuthoredValue(raw, 'execution checkout'));
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide one explicit checkout, clear, or original-operation retry with exact selectors',
      { cause }
    );
  }
}
function copyContext(context: RegisteredDatabaseContext): RegisteredDatabaseContext {
  try {
    const copied = copyDatabaseAuthoredValue(
      context,
      'execution checkout'
    ) as unknown as RegisteredDatabaseContext;
    if (
      !copied ||
      typeof copied !== 'object' ||
      !copied.authority ||
      !copied.git ||
      typeof copied.authority.resolvedRoot !== 'string' ||
      !copied.authority.resolvedRoot ||
      typeof copied.git.worktreeRoot !== 'string' ||
      !copied.git.worktreeRoot ||
      typeof copied.git.gitDir !== 'string' ||
      typeof copied.git.commonDir !== 'string' ||
      !copied.git.repositoryCreation ||
      !copied.git.administrativeIdentity
    )
      throw new Error('Missing original registered context');
    return copied;
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original complete registered checkout context',
      { cause }
    );
  }
}

export async function prepareDatabaseCheckout(
  handle: ProjectDatabase,
  receivedContext: RegisteredDatabaseContext,
  raw: DatabaseCheckoutInput,
  receivedOptions: ProjectOperationOptions = {}
): Promise<PreparedDatabaseCheckout> {
  const options = { signal: receivedOptions.signal, onWait: receivedOptions.onWait };
  const input = copyInput(raw);
  const context = copyContext(receivedContext);
  refuseDatabaseAuthoredSecrets(input, input.secretAllow, 'execution checkout');
  cancelled(options.signal);
  const scope = scopeFor(context, input.shellKey);
  assertAuthority(handle, context, scope);
  if (input.action === 'replay') {
    const originalCheckout = readProjectExecutionCheckout(handle, input.operationId);
    if (originalCheckout) {
      if (!isDeepStrictEqual(originalCheckout.request.payload.focus.scope, scope))
        throw new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'Retry the original checkout in its retained worktree and session focus namespace'
        );
      const request = originalCheckout.request;
      const focus: ProjectFocusChange = {
        action: 'set',
        operationId: request.payload.focus.operationId,
        scope,
        expectedSelection: request.payload.focus.expectedSelection,
        pinBytes: assertCheckoutPinHash(request),
        expectedArtifactRevision: request.expected.revision,
        expectedExecutionVersion: originalCheckout.result.executionVersion,
        secretAllow: input.secretAllow,
      };
      prepareProjectFocus(focus);
      return save({
        context,
        secretAllow: input.secretAllow,
        focus,
        artifactId: request.artifactId,
        checkout: null,
        originalCheckout,
        originalFocus: null,
        orphan: null,
        options,
      });
    }
    const originalFocus = readProjectExecutionFocusOperation(handle, input.operationId);
    if (!originalFocus)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The original checkout or focus operation is unavailable; preserve its ID and inspect original history instead of inventing a replacement'
      );
    if (!isDeepStrictEqual(originalFocus.input.scope, scope))
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'Retry focus in its exact original worktree and session namespace'
      );
    const focus = { ...originalFocus.input, secretAllow: input.secretAllow };
    prepareProjectFocus(focus);
    return save({
      context,
      secretAllow: input.secretAllow,
      focus,
      artifactId:
        focus.action === 'set'
          ? JSON.parse(Buffer.from(focus.pinBytes).toString()).artifact_id
          : null,
      checkout: null,
      originalCheckout: null,
      originalFocus,
      orphan: null,
      options,
    });
  }
  const current =
    input.action === 'clear' ? context : await revalidateDatabaseExecutionContext(context, options);
  cancelled(options.signal);
  const selected = readProjectExecutionFocus(handle, scope);
  if (input.action === 'clear') {
    const focus: ProjectFocusChange = {
      action: 'clear',
      operationId: uuidv7(),
      scope,
      expectedSelection: selected.selection,
      secretAllow: input.secretAllow,
    };
    prepareProjectFocus(focus);
    return save({
      context: current,
      secretAllow: input.secretAllow,
      focus,
      artifactId: null,
      checkout: null,
      originalCheckout: null,
      originalFocus: null,
      orphan: null,
      options,
    });
  }
  if (!current.binding)
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Checkout requires the original registered worktree identity'
    );
  const artifact = readProjectArtifact(handle, input.artifactId, input.expectedRevision);
  const execution = readProjectExecution(handle, input.artifactId);
  if (!artifact || !execution)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The explicitly selected artifact or original execution history is unavailable; preserve retained evidence for explicit repair'
    );
  if (
    execution.version !== input.expectedExecutionVersion ||
    execution.state.binding_generation !== input.expectedBindingGeneration ||
    !isDeepStrictEqual(execution.state.current_binding, input.expectedBinding)
  )
    stale();
  const readOnly =
    execution.state.lifecycle === 'completed' || execution.state.origin_kind === 'git-import';
  if ((artifact.thread.plan?.origin?.kind ?? 'captured') !== execution.state.origin_kind)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original artifact and execution origins disagree; preserve both for explicit repair'
    );
  if (readOnly && input.handoff)
    throw new ProjectDatabaseError(
      execution.state.origin_kind === 'git-import' ? 'IMPORTED_READ_ONLY' : 'ARTIFACT_COMPLETED',
      'Historical focus is allowed, but completed or imported execution cannot acquire an owner'
    );
  if (input.recoverOrphaned && (!input.handoff || !input.reason?.trim()))
    throw new ProjectDatabaseError(
      'RECOVERY_REASON_REQUIRED',
      'Orphan recovery requires explicit handoff and a nonempty original reason'
    );
  if (
    input.recoverOrphaned &&
    (readOnly ||
      !execution.state.current_binding ||
      execution.state.current_binding.worktree_id === current.binding.worktree_id)
  )
    throw new ProjectDatabaseError(
      'EXECUTION_RECOVERY_REQUIRED',
      'Orphan recovery requires an active original owner in a different worktree'
    );
  let action: ProjectExecutionCheckoutInput['payload']['action'] | null = null;
  const owner = execution.state.current_binding;
  if (!readOnly) {
    if (owner && owner.repository_instance_id !== current.binding.repository_instance_id)
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'Original execution belongs to another repository instance'
      );
    if (!owner) action = 'first_bind';
    else if (owner.worktree_id !== current.binding.worktree_id) {
      if (!input.handoff)
        throw new ProjectDatabaseError(
          'EXECUTION_BOUND_ELSEWHERE',
          'Execution belongs to another worktree; explicitly request handoff'
        );
      action = input.recoverOrphaned ? 'orphan_recovered' : 'handoff';
    } else if (
      owner.git_context.branch !== current.binding.git_context.branch ||
      (current.binding.git_context.branch === null &&
        owner.git_context.head_sha !== current.binding.git_context.head_sha)
    )
      action = 'context_changed';
  }
  const orphan =
    action === 'orphan_recovered'
      ? {
          ownerId: owner!.worktree_id,
          observation: await observeCheckoutOwnerAbsence(
            current,
            owner!.worktree_id,
            options.signal
          ),
        }
      : null;
  cancelled(options.signal);
  const ts = new Date().toISOString();
  const focusId = uuidv7();
  let checkout: PreparedProjectExecutionCheckout | null = null;
  let pinBytes: Buffer;
  if (action) {
    const request: ProjectExecutionCheckoutInput = {
      operationId: uuidv7(),
      artifactId: input.artifactId,
      expected: {
        revision: input.expectedRevision,
        version: input.expectedExecutionVersion,
        generation: input.expectedBindingGeneration,
      },
      payload: {
        action,
        target: current.binding,
        expectedBinding: input.expectedBinding,
        reason: input.reason ?? null,
        ts,
        focus: {
          operationId: focusId,
          scope,
          expectedSelection: selected.selection,
          pinnedAt: ts,
          pinHash: '0'.repeat(64),
        },
      },
      secretAllow: input.secretAllow,
    };
    pinBytes = reconstructCheckoutPin(
      input.artifactId,
      request.payload,
      input.expectedBindingGeneration + 1
    );
    request.payload.focus.pinHash = hash(pinBytes);
    checkout = prepareProjectExecutionCheckout(handle, request);
  } else {
    pinBytes = Buffer.from(
      canonicalJson(
        createExecutionPin({
          authority: { ...context.authority, formatVersion: 1 },
          gitContext: current.git,
          shellKey: input.shellKey,
          state: execution.state,
          pinnedAt: ts,
        })
      )
    );
  }
  const focus: ProjectFocusChange = {
    action: 'set',
    operationId: focusId,
    scope,
    expectedSelection: selected.selection,
    pinBytes,
    expectedArtifactRevision: input.expectedRevision,
    expectedExecutionVersion: input.expectedExecutionVersion + (action ? 1 : 0),
    secretAllow: input.secretAllow,
  };
  prepareProjectFocus(focus);
  return save({
    context: current,
    secretAllow: input.secretAllow,
    focus,
    artifactId: input.artifactId,
    checkout,
    originalCheckout: null,
    originalFocus: null,
    orphan,
    options,
  });
}
export function databaseCheckoutIdentity(token: PreparedDatabaseCheckout): {
  operationId: string;
  focusOperationId: string;
  artifactId: string | null;
} {
  const value = preparedRequests.get(token);
  if (!value)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Use the original genuine checkout preparation'
    );
  return {
    operationId:
      value.originalCheckout?.request.operationId ??
      (value.checkout
        ? projectExecutionCheckoutRequest(value.checkout).operationId
        : value.focus.operationId),
    focusOperationId: value.focus.operationId,
    artifactId: value.artifactId,
  };
}
function focusFailure(cause: unknown): ProjectDatabaseError {
  return cause instanceof ProjectDatabaseError
    ? cause
    : new ProjectDatabaseError(
        'TRANSACTION_FAILED',
        'Binding committed but focus publication failed; retain both original operation IDs and retry the original checkout',
        { cause }
      );
}
export async function publishDatabaseCheckout(
  handle: ProjectDatabase,
  token: PreparedDatabaseCheckout
): Promise<DatabaseCheckoutResult> {
  const value = preparedRequests.get(token);
  if (!value)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Use the original genuine checkout preparation'
    );
  const { context, focus, options } = value;
  cancelled(options.signal);
  assertAuthority(handle, context, focus.scope);
  let binding: Awaited<ReturnType<typeof publishProjectExecutionCheckout>> | null = null;
  if (value.originalCheckout)
    binding = await replayProjectExecutionCheckout(
      handle,
      value.originalCheckout.request.operationId,
      options
    );
  else if (value.originalFocus) {
    const retained = readProjectExecutionFocusOperation(handle, focus.operationId);
    if (!retained || !isDeepStrictEqual(retained, value.originalFocus))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Original focus publication changed after retry preparation; preserve history for explicit repair'
      );
  } else {
    if (focus.action === 'set') {
      await revalidateDatabaseExecutionContext(context, options);
      if (
        value.orphan &&
        (await observeCheckoutOwnerAbsence(context, value.orphan.ownerId, options.signal)) !==
          value.orphan.observation
      )
        stale();
    }
    cancelled(options.signal);
    if (value.checkout)
      binding = await publishProjectExecutionCheckout(handle, value.checkout, options);
  }
  const operationId = binding
    ? (value.originalCheckout?.request.operationId ??
      (value.checkout
        ? projectExecutionCheckoutRequest(value.checkout).operationId
        : focus.operationId))
    : focus.operationId;
  const common = { operationId, artifactId: value.artifactId, binding };
  try {
    const publication = await publishProjectExecutionFocus(handle, focus, options);
    return {
      ...common,
      focus: {
        state: focus.action === 'clear' ? ('cleared' as const) : ('updated' as const),
        operationId: focus.operationId,
        publication,
        error: null,
      },
    };
  } catch (cause) {
    if (!binding) throw cause;
    return {
      ...common,
      focus: {
        state: 'failed' as const,
        operationId: focus.operationId,
        publication: null,
        error: focusFailure(cause),
      },
    };
  }
}
