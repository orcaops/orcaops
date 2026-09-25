import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  databaseCheckoutIdentity,
  type DatabaseCheckoutInput,
  prepareDatabaseCheckout,
  requireDatabaseExecutionContext,
} from '@orcaops/core/history/database-checkout';
import { unavailableProjectError } from '@orcaops/project-scope/history';
import { resolveDatabaseHistoryOverview } from '@orcaops/project-scope/history/database';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';
import { resolveShellKey } from '@orcaops/storage/history/execution-focus';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { registerMissingDatabaseWorktree } from './database-worktree-registration.js';
import { closeFailedHistoryRead } from './history-reader-close.js';
import { getInvocationEnv } from './invocation-context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const optionsSchema = z.strictObject({
  artifactId: z.string().min(1).optional(),
  project: z.string().uuid({ version: 'v7' }).optional(),
  clear: z.boolean().optional(),
  handoff: z.boolean().optional(),
  recoverOrphaned: z.boolean().optional(),
  reason: z.string().min(1).optional(),
  operationId: z.string().uuid({ version: 'v7' }).optional(),
  json: z.boolean().optional(),
});
export type DatabaseCheckoutOptions = z.infer<typeof optionsSchema>;
export function validateDatabaseCheckout(received: DatabaseCheckoutOptions) {
  let input: DatabaseCheckoutOptions;
  try {
    input = optionsSchema.parse(structuredClone(received));
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide one checkout target, clear, or original operation ID with supported options',
      { cause }
    );
  }
  if (
    Number(!!input.artifactId) + Number(input.clear === true) + Number(!!input.operationId) !== 1 ||
    (!input.artifactId && (input.handoff || input.recoverOrphaned || input.reason !== undefined)) ||
    (input.recoverOrphaned && (!input.handoff || !input.reason?.trim())) ||
    (input.reason !== undefined && !input.handoff)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Choose exactly one artifact, --clear, or --operation-id; recovery requires --handoff and an explicit reason'
    );
  return input;
}
export async function prepareDatabaseCheckoutCommand(
  received: DatabaseCheckoutOptions,
  receivedOperationOptions: ProjectOperationOptions = {}
) {
  const options = validateDatabaseCheckout(received);
  const operationOptions = {
    signal: receivedOperationOptions.signal,
    onWait: receivedOperationOptions.onWait,
  };
  const env = { ...getInvocationEnv() };
  const shellKey = resolveShellKey({ env });
  if (shellKey.kind === 'none')
    throw new OrcaopsError(
      ErrorCodes.NO_SHELL_KEY,
      'Set a supported session or terminal identity before changing focus'
    );
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'exact',
    selector: { projectId: options.project },
    env,
  });
  let result: {
    prepared: Awaited<ReturnType<typeof prepareDatabaseCheckout>>;
    identity: ReturnType<typeof databaseCheckoutIdentity>;
    authority: ProjectDatabaseAuthority;
    shellKey: typeof shellKey;
  };
  try {
    const { scope } = context;
    const project = scope.projects[0];
    if (scope.projects.length !== 1 || !project?.authority || !project.database)
      throw unavailableProjectError(project?.completeness.issues ?? [], {
        code: 'HISTORY_MISSING',
        message:
          'Select the original registered project and available history before checkout; do not initialize a replacement',
      });
    if (!scope.gitContext)
      throw new ProjectDatabaseError(
        'IDENTITY_RECOVERY_REQUIRED',
        'Checkout requires its original registered worktree context'
      );
    if (scope.gitContext.worktreeId === null) {
      await registerMissingDatabaseWorktree(
        {
          cwd: scope.gitContext.worktreeRoot,
          root: scope.root.resolvedRoot,
          projectId: project.projectId,
          expectedAuthority: project.authority,
          secretAllow: context.config.redact.allow,
        },
        operationOptions
      );
    }
    const registered = await requireDatabaseExecutionContext(
      {
        cwd: scope.gitContext.worktreeRoot,
        root: scope.root.resolvedRoot,
        projectId: project.projectId,
      },
      operationOptions
    );
    if (
      !isDeepStrictEqual(registered.authority, project.authority) ||
      !isDeepStrictEqual(project.database.authority, project.authority) ||
      registered.authority.rootKey !== scope.root.rootKey ||
      registered.authority.resolvedRoot !== scope.root.resolvedRoot ||
      (scope.gitContext.worktreeId !== null &&
        registered.git.worktreeId !== scope.gitContext.worktreeId) ||
      registered.git.repositoryInstanceId !== scope.gitContext.repositoryInstanceId ||
      (
        [
          'worktreeRoot',
          'gitDir',
          'commonDir',
          'repositoryCreation',
          'administrativeIdentity',
        ] as const
      ).some((key) => !isDeepStrictEqual(registered.git[key], scope.gitContext![key]))
    )
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'The original project, store or worktree authority changed during checkout selection'
      );
    if (
      options.artifactId &&
      (registered.git.branch !== scope.gitContext.branch ||
        registered.git.headOid !== scope.gitContext.headOid)
    )
      throw new ProjectDatabaseError(
        'EXECUTION_CONTEXT_CHANGED',
        'The original Git context changed during checkout selection; explicitly prepare the intended target again'
      );
    const common = { shellKey, secretAllow: context.config.redact.allow };
    let input: DatabaseCheckoutInput;
    if (options.operationId)
      input = { ...common, action: 'replay', operationId: options.operationId };
    else if (options.clear) input = { ...common, action: 'clear' };
    else {
      const selected = resolveDatabaseHistoryOverview(scope, options.artifactId!);
      if (!selected.execution)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The selected artifact has no original execution history; preserve its history for explicit repair'
        );
      input = {
        ...common,
        action: 'set',
        artifactId: selected.artifactId,
        expectedRevision: selected.artifact.revision,
        expectedExecutionVersion: selected.execution.version,
        expectedBindingGeneration: selected.execution.state.binding_generation,
        expectedBinding: selected.execution.state.current_binding,
        ...(options.handoff !== undefined ? { handoff: options.handoff } : {}),
        ...(options.recoverOrphaned !== undefined
          ? { recoverOrphaned: options.recoverOrphaned }
          : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      };
    }
    const prepared = await prepareDatabaseCheckout(
      project.database,
      registered,
      input,
      operationOptions
    );
    result = {
      prepared,
      identity: databaseCheckoutIdentity(prepared),
      authority: { ...registered.authority },
      shellKey,
    };
  } catch (cause) {
    closeFailedHistoryRead(context.scope);
    throw cause;
  }
  context.scope.close();
  return result;
}
